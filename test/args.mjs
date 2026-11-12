/**
 * Regression tests for step argument validation (0.2.13).
 *
 * A real session sent `args:` instead of `arguments:`; the unknown key was
 * dropped, `arguments` defaulted to {}, and every step failed with the target
 * tool's INVALID_ARGS — which looked like the plugin "not working".
 */
import assert from 'node:assert/strict';

import { apply } from '../src/index.js';

function makeCtx(tools) {
  const registered = new Map();
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      executable(name) {
        return tools[name] ? tools[name].definition : undefined;
      },
      async execute({ calls }) {
        const results = [];
        for (const call of calls) {
          const entry = tools[call.name];
          const args = JSON.parse(call.arguments);
          const text = await entry.run(args);
          results.push({
            callId: call.id,
            result: { isError: false, content: [{ type: 'text', text }], value: { text } },
          });
        }
        return { results, additionalContexts: [], concluded: false };
      },
    },
  };
  return { ctx, registered };
}

const pwsh = {
  definition: {
    name: 'pwsh',
    parameters: { type: 'object', required: ['description', 'command'], properties: {} },
    isConcurrencySafe: () => false,
  },
  run: async (args) => `ran:${args.command}`,
};

const { ctx, registered } = makeCtx({ pwsh });
apply(ctx);
const runTools = registered.get('run_tools');
assert.ok(runTools, 'run_tools must be registered');

const exec = { callId: 'call_t', signal: new AbortController().signal, agent: {}, toolSet: {} };

// 1) `args` is rejected with a message that names the fix.
const r1 = await runTools.execute({ steps: [{ tool: 'pwsh', args: { command: 'x' } }] }, exec);
assert.equal(r1.ok, false);
assert.match(r1.steps[0].summary, /"args" is not a field/);
assert.match(r1.steps[0].summary, /"arguments"/);
console.log('PASS rejects "args" with a pointer to "arguments"');

// 2) Empty arguments against a tool with required fields fails before dispatch.
const r2 = await runTools.execute({ steps: [{ tool: 'pwsh', arguments: {} }] }, exec);
assert.equal(r2.ok, false);
assert.match(r2.steps[0].summary, /requires: description, command/);
console.log('PASS reports empty arguments with the required field names');

// 3) A valid step keeps its label in the result.
const r3 = await runTools.execute(
  { steps: [{ label: 'probe', tool: 'pwsh', arguments: { description: 'd', command: 'c' } }] },
  exec,
);
assert.equal(r3.ok, true);
assert.equal(r3.steps[0].label, 'probe');
console.log('PASS echoes the step label in the result');

// 4) Other unknown properties are rejected rather than dropped.
const r4 = await runTools.execute(
  { steps: [{ tool: 'pwsh', arguments: { description: 'd', command: 'c' }, timeout: 5 }] },
  exec,
);
assert.equal(r4.ok, false);
assert.match(r4.steps[0].summary, /unknown property "timeout"/);
console.log('PASS rejects unknown step properties');

// 5) Results stay lossless JSON: no `label: undefined` for steps without a label.
for (const r of [r1, r2, r3, r4]) {
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
}
console.log('PASS results are lossless JSON');

console.log('args: 5/5 passed');
