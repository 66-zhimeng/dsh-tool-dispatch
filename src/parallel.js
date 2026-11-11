/** Phase 3: fan independent work out to subagents in ONE model round trip.
 *
 * The `subagent` tool is registered with isConcurrencySafe() === true
 * (dsh-tool-subagent lib/index.js), so a multi-call batch on it is dispatched
 * through the parallel branch of the shared pipeline. That makes this module a
 * thin, honest wrapper: it never bypasses the executor, it only hands it N
 * calls at once.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : String(s ?? ''));

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((b) => (b && b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

function failureText(result) {
  if (!result) return 'ERROR: no result returned';
  if (result.error && typeof result.error.message === 'string') return result.error.message;
  return textOf(result.content) || 'ERROR: empty result';
}

/**
 * @param {{
 *   tasks: {description: string, prompt: string}[],
 *   cfg: typeof import('./plan.js').PARALLEL_DEFAULTS,
 *   ctx: any,
 *   exec: {callId: string, agent?: unknown, toolSet?: unknown, signal: AbortSignal},
 *   telemetryPath?: string | null,
 * }} input
 */
export async function executeParallel({ tasks, cfg, ctx, exec, telemetryPath }) {
  const started = Date.now();

  let visible = null;
  try {
    visible = ctx.tools.executable('subagent', exec.agent, exec.toolSet);
  } catch {
    visible = null;
  }
  if (!visible) {
    const value = {
      ok: false,
      totalMs: 0,
      tasks: [{ index: 0, description: '(none)', ok: false, ms: 0, chars: 0, summary: 'ERROR: UNKNOWN_TOOL — subagent is not visible in this step' }],
    };
    await writeTelemetry(telemetryPath, { callId: exec.callId, kind: 'parallel', ok: false, totalMs: 0, tasks: [] });
    return value;
  }

  const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(cfg.totalTimeoutMs)]);
  const calls = tasks.map((task, index) => ({
    type: 'tool-call',
    id: `par_${exec.callId}_${index}`,
    name: 'subagent',
    arguments: JSON.stringify({ description: task.description, prompt: task.prompt }),
  }));

  let batch = null;
  let thrown = null;
  try {
    batch = await ctx.tools.execute({
      calls,
      signal,
      maxParallelToolCalls: cfg.maxParallel,
      agent: exec.agent,
      toolSet: exec.toolSet,
    });
  } catch (error) {
    thrown = error && error.message ? error.message : String(error);
  }

  if (thrown) {
    const value = {
      ok: false,
      totalMs: Date.now() - started,
      tasks: tasks.map((task, index) => ({
        index,
        description: task.description,
        ok: false,
        ms: 0,
        chars: 0,
        summary: `ERROR: ${thrown}`,
      })),
    };
    await writeTelemetry(telemetryPath, { callId: exec.callId, kind: 'parallel', ok: false, totalMs: value.totalMs, tasks: [] });
    return value;
  }

  const byId = new Map((batch && Array.isArray(batch.results) ? batch.results : []).map((r) => [r.callId, r.result]));
  const records = tasks.map((task, index) => {
    const result = byId.get(calls[index].id);
    const ok = !!result && result.isError === false;
    const text = ok ? textOf(result.content) : failureText(result);
    const ms = result && typeof result.durationMs === 'number' ? result.durationMs : 0;
    return { index, description: task.description, ok, ms, chars: text.length, text };
  });

  const value = {
    ok: records.every((r) => r.ok),
    totalMs: Date.now() - started,
    tasks: records.map((r) => ({
      index: r.index,
      description: r.description,
      ok: r.ok,
      ms: r.ms,
      chars: r.chars,
      summary: clip(r.text, cfg.perTaskChars),
    })),
  };
  await writeTelemetry(telemetryPath, {
    callId: exec.callId,
    kind: 'parallel',
    ok: value.ok,
    totalMs: value.totalMs,
    maxParallel: cfg.maxParallel,
    tasks: value.tasks.map((t) => ({ ok: t.ok, ms: t.ms, chars: t.chars })),
  });
  return value;
}

export function renderParallelValue(value, maxOutputChars) {
  const tasks = Array.isArray(value && value.tasks) ? value.tasks : [];
  const okCount = tasks.filter((t) => t.ok).length;
  const head = `run_parallel: ${okCount}/${tasks.length} ok · ${value.totalMs}ms${value.ok ? '' : ' · FAILED'}`;
  const lines = tasks.map((t, i) => {
    const flag = t.ok ? 'ok' : 'FAIL';
    const body = t.summary ? `\n   ${String(t.summary).replace(/\n/g, '\n   ')}` : '';
    return `${t.index + 1}. ${t.description || `task ${t.index + 1}`} [${flag}] ${t.ms}ms${body}`;
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
