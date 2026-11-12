/** Argument normalization and static validation for run_tools. */

export const NESTED_REJECTED = new Set(['run_tools']);

/** The only keys a step may carry; anything else is a typo we must not swallow. */
const STEP_FIELDS = new Set(['tool', 'arguments', 'after', 'label']);

/** Tools that own shared state (a page, a blocking question, a list): never overlap. */
export const ALWAYS_SERIAL = [/^dsh_browser_/, /^ask_user_question$/, /^todo_write$/];

export const DEFAULTS = {
  maxSteps: 32,
  stopOnError: true,
  stepTimeoutMs: 60_000,
  totalTimeoutMs: 180_000,
  maxParallel: 8,
  perStepChars: 800,
  maxOutputChars: 12_000,
  exitCodeIsError: true,
};

export const PARALLEL_DEFAULTS = {
  maxTasks: 8,
  maxParallel: 8,
  totalTimeoutMs: 900_000,
  perTaskChars: 600,
  maxOutputChars: 12_000,
};

const NUMERIC = ['maxSteps', 'stepTimeoutMs', 'totalTimeoutMs', 'maxParallel', 'perStepChars', 'maxOutputChars'];

/**
 * @param {unknown} raw model arguments
 * @returns {{steps: {tool: string, args: Record<string, unknown>, label?: string, after: number[]}[], cfg: typeof DEFAULTS, violations: string[]}}
 */
export function normalizeArgs(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const cfg = { ...DEFAULTS };
  const violations = [];

  for (const key of NUMERIC) {
    const v = a[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) cfg[key] = Math.floor(v);
  }
  if (typeof a.stopOnError === 'boolean') cfg.stopOnError = a.stopOnError;
  if (typeof a.exitCodeIsError === 'boolean') cfg.exitCodeIsError = a.exitCodeIsError;

  const rawSteps = Array.isArray(a.steps) ? a.steps : [];
  if (rawSteps.length === 0) violations.push('steps must be a non-empty array');
  if (rawSteps.length > cfg.maxSteps) violations.push(`too many steps: ${rawSteps.length} > maxSteps(${cfg.maxSteps})`);

  const steps = [];
  rawSteps.slice(0, cfg.maxSteps).forEach((s, i) => {
    // A typo here used to degrade into "every step fails INVALID_ARGS", because
    // an unknown key was dropped and `arguments` silently became {}.
    for (const key of Object.keys(s ?? {})) {
      if (STEP_FIELDS.has(key)) continue;
      violations.push(
        key === 'args'
          ? `step[${i}]: "args" is not a field — put the tool parameters under "arguments"`
          : `step[${i}]: unknown property "${key}" (allowed: tool, arguments, after, label)`,
      );
      return;
    }

    const tool = s && typeof s.tool === 'string' ? s.tool.trim() : '';
    if (!tool) {
      violations.push(`step[${i}]: tool must be a non-empty string`);
      return;
    }
    if (NESTED_REJECTED.has(tool)) {
      violations.push(`step[${i}]: ${tool} cannot be nested (depth limit 1)`);
      return;
    }
    let args = s.arguments === undefined ? {} : s.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        violations.push(`step[${i}]: arguments is a string but not valid JSON`);
        return;
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      violations.push(`step[${i}]: arguments must be a JSON object`);
      return;
    }

    // `after` names steps that must settle first; everything else runs as soon
    // as a slot is free. Only backwards references are legal, which makes
    // cycles impossible by construction. A reference is either a 0-based index
    // or the `label` of an earlier step (labels read better than indexes when a
    // chain is long, and they survive reordering of the earlier steps).
    const after = [];
    if (s.after !== undefined) {
      const list = Array.isArray(s.after) ? s.after : [s.after];
      for (const v of list) {
        let ref;
        if (typeof v === 'string') {
          ref = steps.findIndex((st) => st.label === v);
          if (ref < 0) {
            violations.push(`step[${i}]: after references unknown label "${v}" (labels must belong to earlier steps)`);
            return;
          }
        } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
          ref = v;
        } else if (typeof v === 'number') {
          violations.push(`step[${i}]: after must be a non-negative step index (got ${v})`);
          return;
        } else {
          violations.push(`step[${i}]: after must be step indexes or earlier step labels`);
          return;
        }
        if (ref >= i) {
          violations.push(`step[${i}]: after can only reference an earlier step (got ${v})`);
          return;
        }
        if (!after.includes(ref)) after.push(ref);
      }
    }

    const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim() : undefined;
    if (label && steps.some((st) => st.label === label)) {
      violations.push(`step[${i}]: label "${label}" is already used by an earlier step`);
      return;
    }

    steps.push({ tool, args, label, after });
  });

  return { steps, cfg, violations };
}

/** Failure value used when the request never reached dispatch. */
export function rejectedValue(violations, totalMs = 0) {
  return {
    ok: false,
    totalMs,
    steps: [{ index: 0, tool: '(none)', ok: false, skipped: false, ms: 0, chars: 0, summary: violations.join('; ') }],
  };
}

const MAX_PROMPT_CHARS = 8_000;
const MAX_DESCRIPTION_CHARS = 120;

/**
 * @param {unknown} raw model arguments for run_parallel
 * @returns {{tasks: {description: string, prompt: string}[], cfg: typeof PARALLEL_DEFAULTS, violations: string[]}}
 */
export function normalizeParallelArgs(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const cfg = { ...PARALLEL_DEFAULTS };
  const violations = [];

  for (const key of ['maxParallel', 'totalTimeoutMs', 'perTaskChars', 'maxOutputChars']) {
    const v = a[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) cfg[key] = Math.floor(v);
  }
  cfg.maxParallel = Math.min(cfg.maxParallel, PARALLEL_DEFAULTS.maxTasks);

  const rawTasks = Array.isArray(a.tasks) ? a.tasks : [];
  if (rawTasks.length === 0) violations.push('tasks must be a non-empty array');
  if (rawTasks.length > PARALLEL_DEFAULTS.maxTasks) {
    violations.push(`too many tasks: ${rawTasks.length} > ${PARALLEL_DEFAULTS.maxTasks}`);
  }

  const tasks = [];
  rawTasks.slice(0, PARALLEL_DEFAULTS.maxTasks).forEach((t, i) => {
    const prompt = t && typeof t.prompt === 'string' ? t.prompt.trim() : '';
    if (!prompt) {
      violations.push(`task[${i}]: prompt must be a non-empty string`);
      return;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      violations.push(`task[${i}]: prompt too long (${prompt.length} > ${MAX_PROMPT_CHARS})`);
      return;
    }
    const description = (t && typeof t.description === 'string' ? t.description.trim() : '') || `task ${i + 1}`;
    tasks.push({ description: description.slice(0, MAX_DESCRIPTION_CHARS), prompt });
  });

  return { tasks, cfg, violations };
}

/** Failure value used when a run_parallel request never reached dispatch. */
export function rejectedParallelValue(violations, totalMs = 0) {
  return {
    ok: false,
    totalMs,
    tasks: [{ index: 0, description: '(rejected)', ok: false, ms: 0, chars: 0, summary: violations.join('; ') }],
  };
}
