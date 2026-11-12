/**
 * Partial execution: one malformed step must cost one step, not the batch.
 *
 * The reported failure mode was `run_tools` returning 0/1 for a batch where
 * only the middle step forgot `tool` — the two correct steps never ran. These
 * checks pin that behaviour down, plus the batch-level rejections that are
 * still all-or-nothing.
 */
import { normalizeArgs } from '../src/plan.js';
import { executeBatch } from '../src/run.js';

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const defs = {
  pwsh: { parameters: { required: ['description', 'command'] } },
  read: {},
  boom: {},
};

function makeCtx(log) {
  return {
    tools: {
      executable: (name) => defs[name],
      execute: async ({ calls }) => {
        const call = calls[0];
        log.push({ name: call.name, args: JSON.parse(call.arguments) });
        await sleep(5);
        if (call.name === 'boom') {
          return { results: [{ callId: call.id, result: { isError: true, error: { message: 'exploded' } } }] };
        }
        return {
          results: [
            { callId: call.id, result: { isError: false, content: [{ type: 'text', text: `${call.name} ok` }] } },
          ],
        };
      },
    },
  };
}

const exec = { callId: 'c1', signal: new AbortController().signal };

async function run(raw) {
  const log = [];
  const parsed = normalizeArgs(raw);
  const value = parsed.violations.length
    ? null
    : await executeBatch({ steps: parsed.steps, cfg: parsed.cfg, ctx: makeCtx(log), exec });
  return { parsed, value, log };
}

// 1. The reported case: middle step has no `tool` at all.
{
  const { value, log } = await run({
    steps: [
      { tool: 'pwsh', arguments: { description: 'a', command: 'a' } },
      { arguments: {} },
      { tool: 'read', arguments: { file_path: 'x' } },
    ],
  });
  check(value.steps.length === 3, '1a: every step appears in the result');
  check(value.steps[0].ok && !value.steps[1].ok && value.steps[2].ok, '1b: the two valid steps still ran');
  check(/tool must be a non-empty string/.test(value.steps[1].summary), '1c: the bad step names the field');
  check(value.steps[1].index === 1, '1d: original index preserved');
  check(log.length === 2, '1e: only the valid steps were dispatched');
  check(value.ok === false, '1f: batch reports failure overall');
}

// 2. `args` instead of `arguments` poisons one step only.
{
  const { value, log } = await run({
    steps: [
      { tool: 'read', args: { file_path: 'x' } },
      { tool: 'read', arguments: { file_path: 'y' } },
    ],
  });
  check(/is not a field — put the tool parameters under "arguments"/.test(value.steps[0].summary), '2a: args typo explained');
  check(value.steps[1].ok === true && log.length === 1, '2b: the sibling still ran');
}

// 3. Empty arguments against a tool with required fields: one step, one error.
{
  const { value, log } = await run({
    steps: [
      { tool: 'pwsh', arguments: {} },
      { tool: 'read', arguments: { file_path: 'z' } },
    ],
  });
  check(/arguments is empty — "pwsh" requires: description, command/.test(value.steps[0].summary), '3a: missing required fields named');
  check(value.steps[1].ok === true && log.length === 1, '3b: sibling still ran');
}

// 4. A step depending on a malformed step is skipped, not run.
{
  const { value } = await run({
    steps: [
      { tool: 'read', arguments: { file_path: 'a' } },
      { tool: 'read', args: { file_path: 'typo' } }, // malformed on purpose
      { tool: 'read', arguments: { file_path: 'b' }, after: [1] },
    ],
  });
  check(value.steps[0].ok === true, '4a: independent step ran');
  check(value.steps[2].skipped === true && /step 2 did not succeed/.test(value.steps[2].summary), '4b: dependent skipped with reason');
}

// 5. A step depending on a runtime failure is skipped too.
{
  const { value } = await run({
    stopOnError: false,
    steps: [
      { tool: 'boom', arguments: {} },
      { tool: 'read', arguments: { file_path: 'c' }, after: [0] },
    ],
  });
  check(value.steps[0].ok === false && /exploded/.test(value.steps[0].summary), '5a: runtime failure reported');
  check(value.steps[1].skipped === true && /step 1 did not succeed/.test(value.steps[1].summary), '5b: dependent skipped');
}

// 6. stopOnError (default) still stops independent steps after a runtime failure.
{
  const { value, log } = await run({
    maxParallel: 1, // sequential, so the stop is observable
    steps: [
      { tool: 'boom', arguments: {} },
      { tool: 'read', arguments: { file_path: 'd' } },
    ],
  });
  check(value.steps[1].skipped === true && /stopOnError/.test(value.steps[1].summary), '6a: later step skipped');
  check(log.length === 1, '6b: it was never dispatched');
}

// 7. Batch-level problems are still all-or-nothing.
{
  const empty = normalizeArgs({ steps: [] });
  check(empty.violations.length === 1 && empty.violations[0].includes('non-empty'), '7a: empty steps rejected as a batch');
  const many = normalizeArgs({ steps: Array.from({ length: 3 }, () => ({ tool: 'read', arguments: {} })), maxSteps: 2 });
  check(many.violations.length === 1 && /too many steps/.test(many.violations[0]), '7b: maxSteps still batch-level');
}

// 8. An all-valid batch behaves exactly as before.
{
  const { value } = await run({
    steps: [
      { tool: 'read', arguments: { file_path: 'a' } },
      { tool: 'read', arguments: { file_path: 'b' } },
      { tool: 'read', arguments: { file_path: 'c' } },
    ],
  });
  check(value.ok === true && value.steps.every((s) => s.ok), '8a: all three ok');
  check(value.via === 'execute' && value.steps.length === 3, '8b: unchanged shape (via + steps)');
}

console.log(failed === 0 ? '\npartial: all checks passed' : `\npartial: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
