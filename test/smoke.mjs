/**
 * Smoke tests for run_tools with a stub ToolsService.
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/index.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

function makeCtx(tools, opts = {}) {
  const registered = new Map();
  const log = [];
  const overlaps = [];
  const PROTECTED = /^(dsh_browser_|ask_user_question$|todo_write$)/;
  let active = 0;
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      executable(n) {
        return tools[n] ? tools[n].definition : undefined;
      },
      async execute({ calls, signal }) {
        const one = async (call) => {
          log.push(call.name);
          if (PROTECTED.test(call.name) && active > 0) overlaps.push(call.name);
          active += 1;
          const entry = tools[call.name];
          if (!entry) {
            active -= 1;
            return { callId: call.id, result: { isError: true, error: { message: 'UNKNOWN_TOOL' }, content: [] } };
          }
          const args = JSON.parse(call.arguments);
          try {
            const text = await entry.run(args, signal);
            return { callId: call.id, result: { isError: false, content: [{ type: 'text', text }], value: { text } } };
          } catch (error) {
            return { callId: call.id, result: { isError: true, error: { message: error.message }, content: [] } };
          } finally {
            active -= 1;
          }
        };
        const results = opts.parallel ? await Promise.all(calls.map(one)) : [];
        if (!opts.parallel) for (const call of calls) results.push(await one(call));
        return { results, additionalContexts: [], concluded: false };
      },
    },
  };
  return { ctx, registered, log, overlaps };
}

function tool(name, kind, ms, extra = {}) {
  return {
    definition: { name, isConcurrencySafe: kind === 'safe' ? () => true : () => false },
    run: async (args, signal) => {
      await sleep(ms, signal);
      if (signal && signal.aborted) throw new Error('ABORTED');
      if (args.fail) throw new Error('boom');
      return args.text ?? `${name}:${args.n ?? ''}`;
    },
  };
}

const execBase = () => ({
  callId: 'call_x',
  agent: undefined,
  toolSet: undefined,
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {},
});

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(`PASS ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`);
  }
};

const tmp = await mkdtemp(join(tmpdir(), 'dsh-batch-'));
const telemetryPath = join(tmp, 'telemetry.jsonl');
const boot = (tools, opts) => {
  const made = makeCtx(tools, opts);
  apply(made.ctx, { telemetryPath });
  return { ...made, def: made.registered.get('run_tools') };
};

await check('registers run_tools with a valid shape', async () => {
  const { def } = boot({});
  assert.ok(def, 'run_tools must be registered');
  assert.equal(def.parameters.type, 'object');
  assert.equal(def.parameters.required[0], 'steps');
  assert.equal(def.isConcurrencySafe(), false, 'run_tools must be exclusive');
  assert.ok(typeof def.output.render === 'function');
  const item = def.parameters.properties.steps.items;
  assert.ok(item.properties.after, 'steps must accept after');
  assert.equal(def.parameters.properties.mode, undefined, 'mode must be gone');
});

await check('runs 3 steps and writes telemetry', async () => {
  const { def } = boot({ read: tool('read', 'exclusive', 5) });
  const value = await def.execute(
    { steps: [{ tool: 'read', arguments: { n: 1 } }, { tool: 'read', arguments: { n: 2 } }, { tool: 'read', arguments: { n: 3 } }] },
    execBase(),
  );
  assert.equal(value.ok, true);
  assert.equal(value.steps.length, 3);
  assert.deepEqual(value.steps.map((s) => s.ok), [true, true, true]);
  const text = def.output.render({}, value)[0].text;
  assert.match(text, /run_tools: 3\/3 ok/);
  const lines = (await readFile(telemetryPath, 'utf8')).trim().split('\n');
  assert.ok(lines.length >= 1);
  assert.equal(JSON.parse(lines.at(-1)).steps.length, 3);
});

await check('stopOnError skips the remaining steps', async () => {
  const { def, log } = boot({ read: tool('read', 'exclusive', 5) });
  const value = await def.execute(
    {
      steps: [
        { tool: 'read', arguments: { n: 1 } },
        { tool: 'read', arguments: { fail: true }, after: [0] },
        { tool: 'read', arguments: { n: 3 }, after: [1] },
      ],
    },
    execBase(),
  );
  assert.equal(value.ok, false);
  assert.equal(value.steps[1].ok, false);
  assert.equal(value.steps[2].skipped, true);
  assert.equal(log.length, 2, 'third step must not dispatch');
});

await check('stopOnError=false continues after a failure', async () => {
  const { def } = boot({ read: tool('read', 'exclusive', 5) });
  const value = await def.execute(
    {
      stopOnError: false,
      steps: [
        { tool: 'read', arguments: { fail: true } },
        { tool: 'read', arguments: { n: 2 }, after: [0] },
        { tool: 'read', arguments: { n: 3 } },
      ],
    },
    execBase(),
  );
  assert.equal(value.ok, false);
  assert.equal(value.steps[1].skipped, true); // a failed prerequisite is not run
  assert.equal(value.steps[2].ok, true); // an unrelated step still ran
});

await check('unknown tool fails as UNKNOWN_TOOL', async () => {
  const { def } = boot({});
  const value = await def.execute({ steps: [{ tool: 'nope', arguments: {} }] }, execBase());
  assert.equal(value.ok, false);
  assert.match(value.steps[0].summary, /UNKNOWN_TOOL/);
});

await check('rejects nesting and keeps the batch unexecuted', async () => {
  const { def, log } = boot({});
  const value = await def.execute({ steps: [{ tool: 'run_tools', arguments: { steps: [] } }] }, execBase());
  assert.equal(value.ok, false);
  assert.match(value.steps[0].summary, /cannot be nested/);
  assert.equal(log.length, 0);
});

await check('rejects an empty step list', async () => {
  const { def } = boot({});
  const value = await def.execute({ steps: [] }, execBase());
  assert.equal(value.ok, false);
  assert.match(value.steps[0].summary, /non-empty/);
});

await check('enforces the per-step timeout', async () => {
  const { def } = boot({ slow: tool('slow', 'exclusive', 400) });
  const value = await def.execute({ stepTimeoutMs: 60, steps: [{ tool: 'slow', arguments: {} }] }, execBase());
  assert.equal(value.ok, false);
  assert.ok(value.steps[0].ms < 300, `step should abort early, took ${value.steps[0].ms}ms`);
});

await check('runs independent steps in parallel by default', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 'exclusive', 120) });
  const value = await def.execute(
    { steps: [{ tool: 'pwsh', arguments: { n: 1 } }, { tool: 'pwsh', arguments: { n: 2 } }] },
    execBase(),
  );
  assert.equal(value.ok, true);
  assert.ok(value.totalMs < 220, `two 120ms steps should overlap, took ${value.totalMs}ms`);
});

await check('after forces a step to wait', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 'exclusive', 120) });
  const value = await def.execute(
    { steps: [{ tool: 'pwsh', arguments: { n: 1 } }, { tool: 'pwsh', arguments: { n: 2 }, after: [0] }] },
    execBase(),
  );
  assert.equal(value.ok, true);
  assert.ok(value.totalMs >= 230, `after chain must serialize, took ${value.totalMs}ms`);
});

await check('rejects a forward after reference', async () => {
  const { def, log } = boot({ pwsh: tool('pwsh', 'exclusive', 5) });
  const value = await def.execute(
    { steps: [{ tool: 'pwsh', arguments: { n: 1 }, after: [1] }, { tool: 'pwsh', arguments: { n: 2 } }] },
    execBase(),
  );
  assert.equal(value.ok, false);
  assert.match(value.steps[0].summary, /earlier step/);
  assert.equal(value.steps[1].ok, true); // only the malformed step is lost
  assert.equal(log.length, 1);
});

await check('a protected tool runs alone', async () => {
  const tools = { pwsh: tool('pwsh', 'exclusive', 100), todo_write: tool('todo_write', 'exclusive', 100) };
  const { def, overlaps } = boot(tools);
  const value = await def.execute(
    {
      steps: [
        { tool: 'pwsh', arguments: { n: 1 } },
        { tool: 'todo_write', arguments: {} },
        { tool: 'pwsh', arguments: { n: 2 } },
      ],
    },
    execBase(),
  );
  assert.equal(value.ok, true);
  assert.deepEqual(overlaps, [], 'the protected call must never overlap another call');
  assert.ok(value.totalMs < 280, `the two pwsh steps should still overlap each other, took ${value.totalMs}ms`);
});

await check('truncates long step output', async () => {
  const { def } = boot({ read: { definition: { name: 'read', isConcurrencySafe: () => false }, run: async () => 'x'.repeat(5000) } });
  const value = await def.execute({ perStepChars: 100, maxOutputChars: 400, steps: [{ tool: 'read', arguments: {} }] }, execBase());
  assert.ok(value.steps[0].summary.length < 160);
  assert.ok(def.output.render({}, value)[0].text.length <= 420);
});

await check('aborts the whole batch through the caller signal', async () => {
  const { def } = boot({ slow: tool('slow', 'exclusive', 500) });
  const controller = new AbortController();
  const exec = { ...execBase(), signal: controller.signal };
  setTimeout(() => controller.abort(), 40);
  const value = await def.execute({ steps: [{ tool: 'slow', arguments: {} }] }, exec);
  assert.equal(value.ok, false);
});

const subagent = {
  definition: { name: 'subagent', isConcurrencySafe: () => true },
  run: async (args) => {
    await sleep(150);
    if (args.prompt.includes('fail')) throw new Error('child failed');
    return `child(${args.description}): ${args.prompt.slice(0, 20)}`;
  },
};

await check('registers run_parallel with a valid shape', async () => {
  const { registered } = boot({});
  const def = registered.get('run_parallel');
  assert.ok(def, 'run_parallel must be registered');
  assert.equal(def.parameters.required[0], 'tasks');
  assert.equal(def.isConcurrencySafe(), false);
  assert.equal(def.parameters.properties.mode, undefined, 'mode must be gone from run_parallel too');
});

await check('dispatches subagent tasks concurrently in one batch', async () => {
  const { registered, log } = boot({ subagent }, { parallel: true });
  const def = registered.get('run_parallel');
  const started = Date.now();
  const value = await def.execute(
    {
      tasks: [
        { description: 'audio', prompt: 'read the audio pipeline' },
        { description: 'video', prompt: 'read the video pipeline' },
        { description: 'image', prompt: 'read the image pipeline' },
      ],
    },
    execBase(),
  );
  const elapsed = Date.now() - started;
  assert.equal(value.ok, true);
  assert.equal(value.tasks.length, 3);
  assert.equal(log.filter((n) => n === 'subagent').length, 3);
  assert.ok(elapsed < 300, `parallel fan-out took ${elapsed}ms`);
  const text = def.output.render({}, value)[0].text;
  assert.match(text, /run_parallel: 3\/3 ok/);
});

await check('run_parallel reports one failed child without hiding the rest', async () => {
  const { registered } = boot({ subagent }, { parallel: true });
  const def = registered.get('run_parallel');
  const value = await def.execute(
    { tasks: [{ description: 'ok', prompt: 'fine' }, { description: 'bad', prompt: 'please fail' }] },
    execBase(),
  );
  assert.equal(value.ok, false);
  assert.deepEqual(value.tasks.map((t) => t.ok), [true, false]);
});

await check('run_parallel rejects an empty task list', async () => {
  const { registered } = boot({ subagent }, { parallel: true });
  const def = registered.get('run_parallel');
  const value = await def.execute({ tasks: [] }, execBase());
  assert.equal(value.ok, false);
  assert.match(value.tasks[0].summary, /non-empty/);
});

await check('run_parallel fails cleanly when subagent is not visible', async () => {
  const { registered } = boot({});
  const def = registered.get('run_parallel');
  const value = await def.execute({ tasks: [{ prompt: 'x' }] }, execBase());
  assert.equal(value.ok, false);
  assert.match(value.tasks[0].summary, /UNKNOWN_TOOL/);
});

for (const line of results) console.log(line);
const failedCount = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
