/**
 * Kernel-executor probe: the smoke test uses a stub, so it cannot answer the
 * two questions that only the real executor can:
 *
 *   1. when run_tools issues several ctx.tools.execute() calls at once for
 *      tools that did NOT declare concurrency safety, does the kernel
 *      serialize them anyway?
 *   2. does `after` still hold when the dispatch goes through the real kernel?
 *
 * Run: node test/probe-fast.mjs   (exit code 1 if either expectation breaks)
 */
const DSH_BASE =
  process.env.DSH_PKG_BASE ??
  'file:///D:/Tools/PiAgent/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const load = (rel) => import(`${DSH_BASE}/${rel}`);
const here = (rel) => import(new URL(rel, import.meta.url).href);

const ctx = new (await load('cordis/lib/index.js')).Context();

const mods = {
  'dsh-system-prompt': await load('dsh-system-prompt/lib/index.js'),
  'dsh-tools': await load('dsh-tools/lib/index.js'),
  'dsh-tool-executor-native': await load('dsh-tool-executor-native/lib/index.js'),
};
for (const mod of Object.values(mods)) ctx.plugin(mod.default ?? mod.apply ?? mod);
await new Promise((r) => setTimeout(r, 250));

const executor = mods['dsh-tool-executor-native'];
ctx.plugin({ name: executor.name, inject: executor.inject, apply: executor.apply });
await new Promise((r) => setTimeout(r, 100));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ctx.tools.register({
  name: 'probe_slow',
  description: 'sleep then return (probe)',
  parameters: { type: 'object', properties: { ms: { type: 'number' } }, additionalProperties: false },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  // Deliberately NOT concurrency-safe: run_tools must overlap it by default.
  execute: async (args) => {
    const started = Date.now();
    await sleep(args.ms ?? 3000);
    return { started, ended: Date.now() };
  },
});

const batch = await here('../src/index.js');
batch.apply(ctx, { telemetryPath: null });

const STEP_MS = 3000;

async function run(label, steps) {
  const started = Date.now();
  const result = await ctx.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: `probe_${label}`,
        name: 'run_tools',
        arguments: JSON.stringify({ steps }),
      },
    ],
    signal: AbortSignal.timeout(90_000),
  });
  const text = (result.results[0].result.content ?? []).map((b) => b.text).join('\n');
  return { wall: Date.now() - started, head: text.split('\n')[0] };
}

let failures = 0;
const report = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} — ${detail}`);
};

// 1) three exclusive calls, no dependencies: must overlap (~3s, not 9s).
{
  const steps = [1, 2, 3].map(() => ({ tool: 'probe_slow', arguments: { ms: STEP_MS } }));
  const { wall, head } = await run('parallel', steps);
  report(
    'concurrent exclusive dispatch',
    wall < STEP_MS * 2,
    `wall=${wall}ms (serial would be ~${STEP_MS * 3}ms) · ${head}`,
  );
}

// 2) the same three calls with an after chain: two waves (~6s, not 3s).
{
  const steps = [
    { tool: 'probe_slow', arguments: { ms: STEP_MS } },
    { tool: 'probe_slow', arguments: { ms: STEP_MS }, after: [0] },
    { tool: 'probe_slow', arguments: { ms: STEP_MS } },
  ];
  const { wall, head } = await run('after-chain', steps);
  report(
    'after chain is honoured',
    wall >= STEP_MS * 1.8 && wall < STEP_MS * 2.4,
    `wall=${wall}ms (expected ~${STEP_MS * 2}ms) · ${head}`,
  );
}

console.log(failures === 0 ? '\nprobe-fast: 2/2 OK' : `\nprobe-fast: ${failures} expectation(s) broken`);
process.exit(failures === 0 ? 0 : 1);
