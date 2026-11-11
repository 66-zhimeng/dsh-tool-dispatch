/**
 * Real-runtime probe: boot the Cordis services that own tool dispatch
 * (system-prompt -> tools -> native executor), register run_tools, then
 * dispatch run_tools THROUGH the same executor and observe nested dispatch.
 *
 * This answers the one question the smoke test cannot: is ctx.tools.execute
 * re-entrant from inside a tool body?
 *
 * Run: node test/probe.mjs
 */
const DSH_BASE =
  process.env.DSH_PKG_BASE ??
  'file:///D:/Tools/PiAgent/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const load = (rel) => import(`${DSH_BASE}/${rel}`);
const here = (rel) => import(new URL(rel, import.meta.url).href);

const log = (...args) => console.log(...args);
const ok = (label) => log(`  ok   ${label}`);
const fail = (label, error) => log(`  FAIL ${label}: ${error && error.message ? error.message : error}`);

const { Context } = await load('cordis/lib/index.js');
log(`cordis loaded`);

const ctx = new Context();

const plugins = [
  ['dsh-system-prompt', await load('dsh-system-prompt/lib/index.js')],
  ['dsh-tools', await load('dsh-tools/lib/index.js')],
  ['dsh-tool-executor-native', await load('dsh-tool-executor-native/lib/index.js')],
];

for (const [label, mod] of plugins) {
  const candidate = mod.default ?? mod.apply ?? mod;
  try {
    ctx.plugin(candidate);
    ok(label);
  } catch (error) {
    fail(label, error);
  }
}

// Let cordis settle its service graph.
await new Promise((resolve) => setTimeout(resolve, 250));

if (!ctx.tools) {
  log('\nctx.tools is unavailable — the service graph needs more plugins than this probe loads.');
  process.exit(2);
}
ok('ctx.tools available');

// The executor plugin exports { name, inject, apply, NativeToolExecutor } with no
// default export; a functional plugin may need its metadata object. Install it
// explicitly if the automatic apply did not take effect.
const executorMod = plugins.find(([label]) => label === 'dsh-tool-executor-native')[1];
try {
  const probeExec = ctx.tools.executable('probe_never', undefined, undefined);
  void probeExec;
} catch {
  /* executable() may throw when no toolSet is present; irrelevant here */
}
try {
  ctx.plugin({ name: executorMod.name, inject: executorMod.inject, apply: executorMod.apply });
  ok('executor re-applied as metadata plugin');
} catch (error) {
  fail('executor re-apply', error);
}
await new Promise((resolve) => setTimeout(resolve, 100));

// A minimal leaf tool to dispatch from inside run_tools.
ctx.tools.register({
  name: 'probe_echo',
  description: 'echo text (probe)',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  isConcurrencySafe: () => false,
  execute: async (args) => ({ echoed: args.text, at: Date.now() }),
});
ok('probe_echo registered');

const batch = await here('../src/index.js');
batch.apply(ctx, { telemetryPath: null });
ok('run_tools registered');

// The plugin also contributes one system-prompt section; confirm it assembles.
if (ctx.systemPrompt && typeof ctx.systemPrompt.assemble === 'function') {
  try {
    const assembly = await ctx.systemPrompt.assemble({});
    const blob = JSON.stringify(assembly);
    log(`\nPROMPT SECTION: ${blob.includes('调度默认偏好') ? 'PRESENT' : 'MISSING'}`);
  } catch (error) {
    log(`\nPROMPT SECTION: assemble failed — ${error && error.message ? error.message : error}`);
  }
} else {
  log('\nPROMPT SECTION: systemPrompt service unavailable in this probe');
}

log('\n-- dispatching run_tools through the real executor --');
const started = Date.now();
try {
  const result = await ctx.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: 'probe_root_1',
        name: 'run_tools',
        arguments: JSON.stringify({
          steps: [
            { tool: 'probe_echo', arguments: { text: 'alpha' } },
            { tool: 'probe_echo', arguments: { text: 'beta' } },
          ],
        }),
      },
    ],
    signal: AbortSignal.timeout(15_000),
  });
  const settled = result.results[0];
  const text = (settled.result.content ?? []).map((b) => b.text).join('\n');
  log(`  elapsed ${Date.now() - started}ms, isError=${settled.result.isError}`);
  log(`  ${text.replace(/\n/g, '\n  ')}`);
  const reentrant = text.includes('alpha') && text.includes('beta') && !settled.result.isError;
  log(`\nRE-ENTRANT DISPATCH: ${reentrant ? 'WORKS' : 'FAILED'}`);
  process.exit(reentrant ? 0 : 1);
} catch (error) {
  log(`  dispatch threw: ${error && error.message ? error.message : error}`);
  process.exit(1);
}
