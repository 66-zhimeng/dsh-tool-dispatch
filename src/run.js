/** Batch execution against ctx.tools.execute, plus render and telemetry. */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ALWAYS_SERIAL } from './plan.js';

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : String(s ?? ''));

// The shell tools report a non-zero exit inside the result text rather than as
// an error, so `stopOnError` could never see a failed command. Detect it here.
const EXIT_CODE_RE = /\[exit code:\s*(\d+)\]/;

/**
 * The executor's invocation pipeline, when this call is itself nested inside one.
 * Under the PTC executor a nested tool name is only visible with a `parent`
 * token, and `ctx.tools.execute` has no way to carry one — so a nested batch
 * has to go through the same pipeline the enclosing program uses.
 */
function nestedPipeline(ctx, exec) {
  if (exec.parent === undefined) return null;
  try {
    const executor = typeof ctx.tools.selectExecutor === 'function' ? ctx.tools.selectExecutor(exec.agent) : undefined;
    const pipeline = executor && executor.pipeline;
    return pipeline && typeof pipeline.prepare === 'function' && typeof pipeline.dispatch === 'function' && typeof pipeline.complete === 'function'
      ? pipeline
      : null;
  } catch {
    return null;
  }
}

/** Dispatch one nested call through a pipeline, bypassing any per-run scheduler. */
async function dispatchNested(pipeline, exec, call, signal) {
  const prepared = await pipeline.prepare({
    callId: call.id,
    rootCallId: exec.rootCallId,
    name: call.name,
    arguments: JSON.parse(call.arguments),
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
    parent: exec.token,
    signal,
  });
  if (prepared.kind !== 'dispatch') return prepared.result ?? null;
  const outcome = await pipeline.dispatch(prepared.exec);
  const completed = await pipeline.complete(prepared.exec, outcome);
  return completed ?? null;
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((b) => (b && b.type === 'text' ? b.text : b && typeof b.type === 'string' ? `<${b.type}>` : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

function failureText(result) {
  if (!result) return 'ERROR: no result returned';
  if (result.error && typeof result.error.message === 'string') {
    const code = result.error.info && result.error.info.code ? `${result.error.info.code}: ` : '';
    return `${code}${result.error.message}`;
  }
  return textOf(result.content) || 'ERROR: empty result';
}

/**
 * Dispatch every step as soon as (a) its `after` dependencies have settled and
 * (b) a slot is free. There is one strategy — no safe/fast switch: steps are
 * independent unless they say otherwise.
 *
 * @param {{
 *   steps: {tool: string, args: Record<string, unknown>, label?: string, after?: number[]}[],
 *   cfg: typeof import('./plan.js').DEFAULTS,
 *   ctx: any,
 *   exec: {callId: string, agent?: unknown, toolSet?: unknown, signal: AbortSignal},
 *   telemetryPath?: string | null,
 * }} input
 */
export async function executeBatch({ steps, cfg, ctx, exec, telemetryPath }) {
  const started = Date.now();
  const totalSignal = AbortSignal.timeout(cfg.totalTimeoutMs);
  const records = new Array(steps.length).fill(null);
  const state = steps.map(() => 'pending'); // pending | running | done
  const inFlight = new Map(); // index -> promise
  let stopped = false;

  const serialOnly = (tool) => ALWAYS_SERIAL.some((re) => re.test(tool));

  const runOne = async (step, index) => {
    const t0 = Date.now();
    const signal = AbortSignal.any([exec.signal, totalSignal, AbortSignal.timeout(cfg.stepTimeoutMs)]);
    const call = {
      type: 'tool-call',
      id: `batch_${exec.callId}_${index}`,
      name: step.tool,
      arguments: JSON.stringify(step.args),
    };
    try {
      const pipeline = nestedPipeline(ctx, exec);
      let result;
      if (pipeline) {
        result = await dispatchNested(pipeline, exec, call, signal);
      } else {
        const batch = await ctx.tools.execute({ calls: [call], signal, agent: exec.agent, toolSet: exec.toolSet });
        const settled = batch && Array.isArray(batch.results) ? batch.results[0] : null;
        result = settled && settled.result;
      }
      const ok0 = !!result && result.isError === false;
      const text = ok0 ? textOf(result.content) : failureText(result);
      let ok = ok0;
      if (ok && cfg.exitCodeIsError !== false) {
        const match = EXIT_CODE_RE.exec(text);
        if (match && Number(match[1]) !== 0) ok = false;
      }
      return { index, tool: step.tool, ok, skipped: false, ms: Date.now() - t0, chars: text.length, text };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { index, tool: step.tool, ok: false, skipped: false, ms: Date.now() - t0, chars: 0, text: `ERROR: ${message}` };
    }
  };

  const settle = (index, record) => {
    records[index] = record;
    state[index] = 'done';
    inFlight.delete(index);
    if (!record.ok && cfg.stopOnError) stopped = true;
  };

  const launch = (index) => {
    const step = steps[index];
    let def;
    try {
      def = ctx.tools.executable(step.tool, exec.agent, exec.toolSet);
    } catch {
      def = undefined;
    }
    if (!def) {
      settle(index, {
        index,
        tool: step.tool,
        ok: false,
        skipped: false,
        ms: 0,
        chars: 0,
        text: 'ERROR: UNKNOWN_TOOL — not visible in this step',
      });
      return;
    }
    state[index] = 'running';
    inFlight.set(
      index,
      runOne(step, index).then((record) => settle(index, record)),
    );
  };

  for (;;) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < steps.length; i += 1) {
        if (state[i] !== 'pending') continue;

        if (stopped) {
          state[i] = 'done';
          records[i] = {
            index: i,
            tool: steps[i].tool,
            ok: false,
            skipped: true,
            ms: 0,
            chars: 0,
            text: 'skipped: an earlier step failed (stopOnError)',
          };
          progressed = true;
          continue;
        }

        const deps = steps[i].after || [];
        if (deps.some((d) => state[d] !== 'done')) continue;

        // A tool that owns shared state runs alone: wait for the batch to drain.
        const waitingOnSerial = [...inFlight.keys()].some((k) => serialOnly(steps[k].tool));
        if (waitingOnSerial) continue;
        if (serialOnly(steps[i].tool)) {
          if (inFlight.size > 0) continue;
        } else if (inFlight.size >= cfg.maxParallel) {
          continue;
        }

        launch(i);
        progressed = true;
      }
    }

    if (inFlight.size === 0) {
      for (let i = 0; i < steps.length; i += 1) {
        if (state[i] !== 'pending') continue;
        state[i] = 'done';
        records[i] = {
          index: i,
          tool: steps[i].tool,
          ok: false,
          skipped: true,
          ms: 0,
          chars: 0,
          text: 'skipped: dependency never satisfied',
        };
      }
      break;
    }

    await Promise.race([...inFlight.values()]);
  }

  const totalMs = Date.now() - started;
  const list = records.filter(Boolean);
  const failed = list.filter((r) => !r.ok).length;
  const value = {
    ok: failed === 0,
    totalMs,
    steps: list.map((r) => ({
      index: r.index,
      tool: r.tool,
      ok: r.ok === true,
      skipped: r.skipped === true,
      ms: r.ms || 0,
      chars: r.chars || 0,
      summary: clip(r.text, cfg.perStepChars),
    })),
  };

  await writeTelemetry(telemetryPath, {
    callId: exec.callId,
    ok: value.ok,
    totalMs,
    steps: value.steps.map((s) => ({ tool: s.tool, ok: s.ok, skipped: s.skipped, ms: s.ms })),
  });
  return value;
}

/**
 * @param {any} value
 * @param {number} maxOutputChars
 */
export function renderValue(value, maxOutputChars) {
  const steps = Array.isArray(value && value.steps) ? value.steps : [];
  const okCount = steps.filter((s) => s.ok).length;
  const head = `run_tools: ${okCount}/${steps.length} ok · ${value.totalMs}ms${value.ok ? '' : ' · FAILED'}`;
  const lines = steps.map((s) => {
    const flag = s.skipped ? 'SKIP' : s.ok ? 'ok' : 'FAIL';
    const body = s.summary ? `\n   ${String(s.summary).replace(/\n/g, '\n   ')}` : '';
    return `${s.index + 1}. ${s.tool} [${flag}] ${s.ms}ms${body}`;
  });
  return clip([head, ...lines].join('\n'), maxOutputChars);
}

async function writeTelemetry(path, payload) {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`, 'utf8');
  } catch {
    /* telemetry must never fail a tool call */
  }
}
