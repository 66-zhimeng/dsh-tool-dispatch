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
export const inject = ['tools', 'systemPrompt'];

/**
 * One short scheduling rule in the system prompt. The point is a cheaper
 * default: the model checks "are these independent?" once per batch instead of
 * paying a round trip per action. Kept deliberately small — a long policy
 * costs more thinking than the round trips it saves.
 */
const POLICY = [
  '## 调度默认偏好',
  '',
  '发工具调用前扫一眼：这一批动作里有没有两个以上互不依赖的？有就合并成一次调用，没有就直接发。',
  '- 多个独立动作（读多个文件、多条命令、抓多个网页、改完再验）→ 一次 `run_tools`；PTC 模式下在程序里写 `await tools.run_tools({steps:[...]})`。',
  '- 多个独立的重任务（各自都要多轮工具或读很多文件，且只要结论）→ 一次 `run_parallel` 派发子 agent。',
  '- 只有一步，或后一步必须看过前一步结果才能决定 → 直接调用，不要硬包。',
  '',
  '这是偏好不是义务：判定只看一眼有没有多个独立动作，不要为此展开推理。',
].join('\n');

const POLICY_ORDER = 55;


const DESCRIPTION = [
  '在一次模型往返里执行多个工具调用，压掉多余的往返（每个往返约付 2s 首字 + 数秒思考）。',
  '何时用：同一批里有两个以上互不依赖的动作——读多个文件、跑多条独立命令、抓多个网页、批量改完再统一验证；',
  '需要先后顺序时用 after 串起来，而不是拆成多步。',
  '何时不用：只有一次调用；或后一步必须看过前一步的具体返回才能决定（那只能分步，或者写成一个 run_code 程序）。',
  'PTC 模式（顶层只有 run_code）不必二选一：在程序里写 await tools.run_tools({steps:[...]})，并发照样生效。',
  '所有步骤默认并发派发（最多 maxParallel 个同时在跑）；只有声明了 after 的步骤才等待。',
  'after 是「必须先行完成」的步骤下标（0 基，只能指向更早的步骤），可以是一个数字或数组。',
  '没有 after 的步骤之间互不等待——只把真正互不依赖的动作放进同一批。',
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

  // Global prompt section: applies to every preset mounted in this profile.
  // Guarded so a bare test harness (tools only) still works.
  const prompt = ctx.systemPrompt;
  if (prompt && typeof prompt.section === 'function') {
    const register = () =>
      prompt.section({
        name: 'dispatch-policy',
        order: POLICY_ORDER,
        text: POLICY,
      });
    if (typeof ctx.effect === 'function') ctx.effect(register);
    else register();
  }
}

const PARALLEL_DESCRIPTION = [
  '把多个互不依赖的子任务一次派给多个子 agent 并行执行，只消耗一次模型往返。',
  '何时用：任务互相独立、每个本身都要读一堆文件或走多轮工具，且只要结论（调查/检索/多方案评审/文件批改）。',
  '何时不用：轻量任务（每个子 agent 自己要两轮往返，比 run_tools 或后台更慢）；有先后依赖（用 run_tools 的 after）；',
  '必须带着主对话上下文才能判断的任务。',
  'PTC 模式里在程序中写 await tools.run_parallel({tasks:[...]})。',
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
