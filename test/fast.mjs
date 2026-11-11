/**
 * Scheduler edge cases: exit codes, after arrays, the maxParallel cap.
 * Run: node test/fast.mjs
 */
import assert from 'node:assert/strict';

import { apply } from '../src/index.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

function boot(tools) {
  const registered = new Map();
  const log = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      executable: (n) => (tools[n] ? tools[n].definition : undefined),
      async execute({ calls, signal }) {
        const results = [];
        for (const call of calls) {
          log.push(call.name);
          const entry = tools[call.name];
          if (!entry) {
            results.push({ callId: call.id, result: { isError: true, error: { message: 'UNKNOWN_TOOL' }, content: [] } });
            continue;
          }
          try {
            const text = await entry.run(JSON.parse(call.arguments), signal);
            results.push({ callId: call.id, result: { isError: false, content: [{ type: 'text', text }], value: { text } } });
          } catch (error) {
            results.push({ callId: call.id, result: { isError: true, error: { message: error.message }, content: [] } });
          }
        }
        return { results, additionalContexts: [], concluded: false };
      },
    },
  };
  apply(ctx, { telemetryPath: null });
  return { def: registered.get('run_tools'), log };
}

function tool(name, ms, text) {
  return {
    definition: { name, isConcurrencySafe: () => false },
    run: async (args, signal) => {
      await sleep(typeof args.ms === 'number' ? args.ms : ms, signal);
      if (args.text !== undefined) return args.text;
      return text ?? `${name} ok`;
    },
  };
}

const execBase = () => ({
  callId: 'c1',
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

const SHELL_FAIL = 'boom\n[exit code: 1]';

await check('a non-zero exit code marks the step failed', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 5, SHELL_FAIL) });
  const value = await def.execute({ steps: [{ tool: 'pwsh', arguments: {} }] }, execBase());
  assert.equal(value.steps[0].ok, false);
  assert.equal(value.ok, false);
});

await check('exitCodeIsError=false keeps a non-zero exit ok', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 5, SHELL_FAIL) });
  const value = await def.execute({ exitCodeIsError: false, steps: [{ tool: 'pwsh', arguments: {} }] }, execBase());
  assert.equal(value.steps[0].ok, true);
});

await check('an exit-code failure stops dependent steps', async () => {
  const { def, log } = boot({ pwsh: tool('pwsh', 5, SHELL_FAIL) });
  const value = await def.execute(
    { steps: [{ tool: 'pwsh', arguments: {} }, { tool: 'pwsh', arguments: {}, after: [0] }] },
    execBase(),
  );
  assert.equal(value.steps[0].ok, false);
  assert.equal(value.steps[1].skipped, true);
  assert.equal(log.length, 1);
});

await check('after accepts an array and waits for both', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 100) });
  const value = await def.execute(
    {
      steps: [
        { tool: 'pwsh', arguments: {} },
        { tool: 'pwsh', arguments: {} },
        { tool: 'pwsh', arguments: {}, after: [0, 1] },
      ],
    },
    execBase(),
  );
  assert.equal(value.ok, true);
  assert.ok(value.totalMs >= 190, `third step must start after both, took ${value.totalMs}ms`);
  assert.ok(value.totalMs < 280, `first two must overlap, took ${value.totalMs}ms`);
});

await check('rejects a self reference in after', async () => {
  const { def, log } = boot({ pwsh: tool('pwsh', 5) });
  const value = await def.execute({ steps: [{ tool: 'pwsh', arguments: {}, after: [0] }] }, execBase());
  assert.equal(value.ok, false);
  assert.match(value.steps[0].summary, /earlier step/);
  assert.equal(log.length, 0);
});

await check('rejects a negative after entry', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 5) });
  const value = await def.execute(
    { steps: [{ tool: 'pwsh', arguments: {} }, { tool: 'pwsh', arguments: {}, after: [-1] }] },
    execBase(),
  );
  assert.equal(value.ok, false);
  assert.match(value.steps[0].summary, /non-negative/);
});

await check('maxParallel caps how many run at once', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 80) });
  const value = await def.execute(
    { maxParallel: 2, steps: Array.from({ length: 5 }, () => ({ tool: 'pwsh', arguments: {} })) },
    execBase(),
  );
  assert.equal(value.ok, true);
  assert.ok(value.totalMs >= 200, `5 x 80ms at 2-wide must take >= 200ms, took ${value.totalMs}ms`);
});

await check('stopOnError=false keeps launching after a failure', async () => {
  const { def } = boot({ bad: tool('bad', 5), pwsh: tool('pwsh', 5) });
  const value = await def.execute(
    {
      stopOnError: false,
      steps: [
        { tool: 'bad', arguments: { text: 'nope' } },
        { tool: 'pwsh', arguments: {}, after: [0] },
      ],
    },
    execBase(),
  );
  assert.equal(value.ok, true, 'no step is marked failed here: both reported ok');
  assert.equal(value.steps[1].skipped, false);
});

await check('render marks the batch FAILED', async () => {
  const { def } = boot({ pwsh: tool('pwsh', 5, SHELL_FAIL) });
  const value = await def.execute({ steps: [{ tool: 'pwsh', arguments: {} }] }, execBase());
  const text = def.output.render({}, value)[0].text;
  assert.match(text, /FAILED/);
  assert.match(text, /pwsh \[FAIL\]/);
});

for (const line of results) console.log(line);
const failedCount = results.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
