/**
 * dsh-dispatch — register `run_tools`, which dispatches many tool calls
 * inside a single model round trip.
 *
 * Phase 0 evidence: ToolsService.execute(input: ToolBatchInput) is public
 * (dsh-tools/lib/types/index.d.ts:130), and a tool body receives
 * `agent` / `toolSet` / `signal` on its ToolRunContext (contracts.d.ts:231).
 */
import { DEFAULTS, PARALLEL_DEFAULTS, normalizeArgs, normalizeParallelArgs, rejectedParallelValue, rejectedValue } from './plan.js';
import { executeBatch, renderValue } from './run.js';
import { executeParallel, renderParallelValue } from './parallel.js';

export const name = 'dispatch';
export const inject = ['tools'];

const DESCRIPTION = [
  '在一次模型往返里执行多个工具调用，用来压缩往返次数（每个往返有固定开销）。',
  '所有步骤默认并发派发（最多 maxParallel 个同时在跑）；只有声明了 after 的步骤才等待。',
  'after 是「必须先行完成」的步骤下标（0 基，只能指向更早的步骤），可以是一个数字或数组。',
  '没有 after 的步骤之间互不等待——只把真正互不依赖的动作放进同一批；有先后依赖就用 after 标明。',
  'dsh_browser_* / ask_user_question / todo_write 会独占整批（它们共享页面、阻塞等人、或写顺序敏感状态）。',
  'stopOnError=true（默认）时遇错即停：不再启动新步骤，把剩余步骤标记为跳过；已在跑的不打断。',
  '规则：arguments 必须是 JSON 对象；run_tools 不能嵌套（深度上限 1）。',
  '典型用法：一次读 3 个文件、一次跑 2 条独立命令、一次抓 4 个网页、编译后再读产物（用 after）。',
].join('');

const PARAMETERS = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      description: '动作列表。互不依赖的步骤并发执行；需要先后顺序的用 after 声明。',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '工具名，例如 read / grep / pwsh / web_fetch。' },
          arguments: { description: '该工具的调用参数（JSON 对象，或 JSON 字符串）。' },
          after: {
            description: '必须先完成的步骤下标（0 基，只能指向更早的步骤）；数字或数组，不填则立即派发。',
            anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }],
          },
          label: { type: 'string', description: '可选，人类可读的动作说明。' },
        },
        required: ['tool'],
        additionalProperties: true,
      },
    },
    stopOnError: { type: 'boolean', description: '遇错即停（默认 true）。' },
    exitCodeIsError: {
      type: 'boolean',
      description: 'shell 命令以非零退出码结束时算失败（默认 true）；关掉则只看工具层错误。',
    },
    stepTimeoutMs: { type: 'number', description: `单步超时，默认 ${DEFAULTS.stepTimeoutMs}。` },
    totalTimeoutMs: { type: 'number', description: `整批超时，默认 ${DEFAULTS.totalTimeoutMs}。` },
    maxParallel: { type: 'number', description: `同时最多几个步骤在跑，默认 ${DEFAULTS.maxParallel}。` },
    perStepChars: { type: 'number', description: `每步结果保留字符数，默认 ${DEFAULTS.perStepChars}。` },
    maxOutputChars: { type: 'number', description: `整体输出上限，默认 ${DEFAULTS.maxOutputChars}。` },
  },
  required: ['steps'],
  additionalProperties: false,
};

/**
 * @param {any} ctx cordis context
 * @param {{telemetryPath?: string | null}} [config]
 */
export function apply(ctx, config = {}) {
  const telemetryPath = config.telemetryPath ?? null;
  const outputCap = typeof config.maxOutputChars === 'number' ? config.maxOutputChars : DEFAULTS.maxOutputChars;

  ctx.tools.register({
    name: 'run_tools',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderValue(value, outputCap) }],
    },
    // Never overlap another call: this tool owns dispatch of everything inside it.
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs ?? DEFAULTS.totalTimeoutMs + 60_000,
    async execute(args, exec) {
      const parsed = normalizeArgs(args);
      if (parsed.violations.length) {
        return {
          ok: false,
          totalMs: 0,
          steps: [
            {
              index: 0,
              tool: '(rejected)',
              ok: false,
              skipped: false,
              ms: 0,
              chars: 0,
              summary: parsed.violations.join('; '),
            },
          ],
        };
      }
      return executeBatch({ steps: parsed.steps, cfg: parsed.cfg, ctx, exec, telemetryPath });
    },
  });

  registerParallel(ctx, config);
}

const PARALLEL_DESCRIPTION = [
  '把多个互不依赖的子任务一次派给多个子 agent 并行执行，只消耗一次模型往返。',
  '适合：互相独立的调查/检索/文件批改/多方案评审。有先后依赖的任务不要用，改用 run_tools 里的 after。',
  '每个子 agent 有独立上下文，只返回结论，不占用主对话上下文。',
  'task.prompt 要自包含（子 agent 看不到当前对话），写清目标、输入、验收标准与输出格式。',
  '全部任务在派发时一起发出（每个子 agent 都会带走一份上下文，任务越多 token 越多）。',
].join('');

const PARALLEL_PARAMETERS = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: PARALLEL_DEFAULTS.maxTasks,
      description: '互相独立的子任务。',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '3–5 个词的任务名，用于结果展示。' },
          prompt: { type: 'string', description: '自包含的完整任务说明（子 agent 看不到当前对话）。' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    maxParallel: { type: 'number', description: `同时最多运行几个子 agent，默认 ${PARALLEL_DEFAULTS.maxParallel}。` },
    totalTimeoutMs: { type: 'number', description: `整批超时，默认 ${PARALLEL_DEFAULTS.totalTimeoutMs}。` },
    perTaskChars: { type: 'number', description: `每个子任务结果保留字符数，默认 ${PARALLEL_DEFAULTS.perTaskChars}。` },
    maxOutputChars: { type: 'number', description: `整体输出上限，默认 ${PARALLEL_DEFAULTS.maxOutputChars}。` },
  },
  required: ['tasks'],
  additionalProperties: false,
};

/**
 * @param {any} ctx cordis context
 * @param {{telemetryPath?: string | null, maxOutputChars?: number}} [config]
 */
function registerParallel(ctx, config) {
  const telemetryPath = config.telemetryPath ?? null;
  const outputCap = typeof config.maxOutputChars === 'number' ? config.maxOutputChars : PARALLEL_DEFAULTS.maxOutputChars;

  ctx.tools.register({
    name: 'run_parallel',
    description: PARALLEL_DESCRIPTION,
    parameters: PARALLEL_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderParallelValue(value, outputCap) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.parallelTimeoutMs ?? PARALLEL_DEFAULTS.totalTimeoutMs + 60_000,
    async execute(args, exec) {
      const parsed = normalizeParallelArgs(args);
      if (parsed.violations.length) return rejectedParallelValue(parsed.violations);
      return executeParallel({ tasks: parsed.tasks, cfg: parsed.cfg, ctx, exec, telemetryPath });
    },
  });
}

export default { name, inject, apply };
