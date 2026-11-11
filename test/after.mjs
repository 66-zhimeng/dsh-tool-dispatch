/** Unit tests for `after` resolution: indexes, labels, and rejections. */
import assert from 'node:assert/strict';
import { normalizeArgs } from '../src/plan.js';

let pass = 0;
const ok = (name, fn) => {
  fn();
  pass += 1;
  console.log(`ok ${pass} - ${name}`);
};

ok('index dependency resolves', () => {
  const r = normalizeArgs({ steps: [{ tool: 'pwsh', arguments: {} }, { tool: 'pwsh', arguments: {}, after: 0 }] });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.steps[1].after, [0]);
});

ok('label dependency resolves to the earlier index', () => {
  const r = normalizeArgs({
    steps: [
      { tool: 'pwsh', arguments: {}, label: 'build' },
      { tool: 'read', arguments: {}, label: 'inspect', after: 'build' },
      { tool: 'pwsh', arguments: {}, after: ['build', 'inspect'] },
    ],
  });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.steps[1].after, [0]);
  assert.deepEqual(r.steps[2].after, [0, 1]);
});

ok('mixed index and label array dedupes', () => {
  const r = normalizeArgs({
    steps: [
      { tool: 'pwsh', arguments: {}, label: 'a' },
      { tool: 'pwsh', arguments: {}, after: ['a', 0] },
    ],
  });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.steps[1].after, [0]);
});

ok('unknown label is rejected', () => {
  const r = normalizeArgs({ steps: [{ tool: 'pwsh', arguments: {} }, { tool: 'pwsh', arguments: {}, after: 'nope' }] });
  assert.match(r.violations.join(), /unknown label "nope"/);
});

ok('forward label is rejected', () => {
  const r = normalizeArgs({
    steps: [
      { tool: 'pwsh', arguments: {}, after: 'later' },
      { tool: 'pwsh', arguments: {}, label: 'later' },
    ],
  });
  assert.match(r.violations.join(), /unknown label "later"/);
});

ok('duplicate label is rejected', () => {
  const r = normalizeArgs({
    steps: [
      { tool: 'pwsh', arguments: {}, label: 'same' },
      { tool: 'pwsh', arguments: {}, label: 'same' },
    ],
  });
  assert.match(r.violations.join(), /already used/);
});

ok('bad type is rejected', () => {
  const r = normalizeArgs({ steps: [{ tool: 'pwsh', arguments: {} }, { tool: 'pwsh', arguments: {}, after: true }] });
  assert.match(r.violations.join(), /indexes or earlier step labels/);
});

console.log(`\n${pass}/7 passed`);
