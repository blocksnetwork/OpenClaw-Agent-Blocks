/**
 * plan-schema — the envelope the personal_assistant brain returns and the
 * runtime executes (Pillars 1.1 / 1.2).
 *
 * The plan is an ORDERED sequence of steps. Each step is one
 * AssistantAction plus optional `id` (so later steps can reference its
 * output) and `runIf` (a static-linear conditional guard — option (a) in
 * the depth plan). `actions` is kept as a byte-compatible alias of `steps`
 * so older callers that read `plan.actions[0]` keep working.
 *
 * Result threading (1.2): a later step references an earlier step's output
 * with a `{ "from": "step1", "field": "reply" }` placeholder, embedded
 * either as an args value (the object form) or inside a string via a
 * `{{step1}}` / `{{step1.reply}}` token. The DEFAULT_SUBSTITUTION_FIELD map
 * pins the default field per kind so `{{step1}}` resolves without a field.
 */

export type AssistantActionKind =
  | 'call-specialist'
  | 'call-peer'
  | 'use-integration'
  | 'search-blocks-catalog'
  | 'answer-direct';

/** A reference to an earlier step's recorded output (result threading). */
export interface StepRef {
  from: string;
  field?: string;
}

/** A static-linear conditional guard: run this step only when the named
 *  earlier step's outcome satisfies `predicate`. Lets a flat `steps[]`
 *  express "if I'm free Thursday, then ask Bob" without re-planning. */
export interface RunIf {
  from: string;
  predicate: RunIfPredicate;
}

export type RunIfPredicate = 'satisfied' | 'soft-miss' | 'free' | 'busy';

/** Per-step metadata shared by every action kind. */
export interface StepMeta {
  /** Stable id (`step1`, `step2`, …) so later steps can thread its output. */
  id?: string;
  /** Optional conditional guard (static-linear branching). */
  runIf?: RunIf;
}

export type AssistantAction = (
  | { kind: 'call-specialist'; tag: string; prompt: string }
  /* call-peer (3.3): carries a `personRef` ("Kayley" / "Kayley's assistant" /
   * "@kayley") that the RUNTIME resolves against the roster post-plan — the
   * pure stub/brain cannot resolve. A pre-resolved `assistant` handle is still
   * accepted (back-compat); at least one of the two must be present. */
  | { kind: 'call-peer'; assistant?: string; personRef?: string; intent: string }
  | { kind: 'use-integration'; tool: string; args?: Record<string, unknown> }
  | { kind: 'search-blocks-catalog'; query: string; tag?: string; category?: string }
  | { kind: 'answer-direct' }
) & StepMeta;

export interface AssistantPlan {
  ok: true;
  reply: string;
  /** The ordered plan the executor runs. */
  steps: AssistantAction[];
  /** Back-compat alias of `steps` (older callers read `plan.actions[0]`). */
  actions: AssistantAction[];
}

/** The default field threaded when a `{ from }` ref omits `field` (1.2). */
export const DEFAULT_SUBSTITUTION_FIELD: Record<AssistantActionKind, string> = {
  'call-specialist': 'reply',
  'search-blocks-catalog': 'reply',
  'use-integration': 'reply',
  'call-peer': 'reply',
  'answer-direct': 'reply',
};

/** Upper bound on plan length. A compound owner request rarely needs more
 *  than a handful of steps; the cap keeps a runaway/hallucinated plan from
 *  fanning out unbounded work. */
export const MAX_STEPS = 5;

const SAFE_REPLY = "I can help with that, but I'll answer directly for now.";

export function validatePlan(plan: unknown): AssistantPlan {
  const raw = isRecord(plan) ? plan : {};
  const reply = typeof raw.reply === 'string' && raw.reply.trim().length > 0 ? raw.reply : SAFE_REPLY;
  // Prefer the new `steps` field; fall back to the legacy `actions` alias so
  // a brain (or stub) that still emits `actions` keeps validating.
  const source = Array.isArray(raw.steps) ? raw.steps : raw.actions;
  const steps = normalizeSteps(source);

  const resolved = steps.length > 0 ? steps : [{ kind: 'answer-direct' as const, id: 'step1' }];
  return {
    ok: true,
    reply,
    steps: resolved,
    actions: resolved,
  };
}

function normalizeSteps(value: unknown): AssistantAction[] {
  if (!Array.isArray(value) || value.length === 0) return [{ kind: 'answer-direct', id: 'step1' }];

  const steps: AssistantAction[] = [];
  const seenIds = new Set<string>();
  for (const item of value.slice(0, MAX_STEPS)) {
    const action = normalizeAction(item);
    // Any malformed step degrades the WHOLE plan to a safe direct answer
    // (preserves the pre-multistep "all-or-nothing repair" behaviour).
    if (!action) return [{ kind: 'answer-direct', id: 'step1' }];
    const id = uniqueStepId(action.id, steps.length, seenIds);
    seenIds.add(id);
    steps.push({ ...action, id });
  }

  return steps;
}

function uniqueStepId(rawId: string | undefined, index: number, seen: Set<string>): string {
  const candidate = isNonEmptyString(rawId) ? rawId.trim() : `step${index + 1}`;
  if (!seen.has(candidate)) return candidate;
  // Collision (or a duplicate the brain emitted) → fall back to positional.
  let fallback = `step${index + 1}`;
  let n = index + 1;
  while (seen.has(fallback)) {
    n += 1;
    fallback = `step${n}`;
  }
  return fallback;
}

function normalizeAction(value: unknown): AssistantAction | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  const meta = normalizeMeta(value);

  switch (value.kind) {
    case 'call-specialist': {
      if (!isNonEmptyString(value.tag) || !isNonEmptyString(value.prompt)) return null;
      return { kind: 'call-specialist', tag: value.tag, prompt: value.prompt, ...meta };
    }
    case 'call-peer': {
      if (!isNonEmptyString(value.intent)) return null;
      // Need at least one way to identify the peer; the runtime resolves a
      // `personRef` against the roster, never the brain (3.3).
      if (!isNonEmptyString(value.assistant) && !isNonEmptyString(value.personRef)) return null;
      const action: AssistantAction = { kind: 'call-peer', intent: value.intent, ...meta };
      if (isNonEmptyString(value.assistant)) action.assistant = value.assistant.trim();
      if (isNonEmptyString(value.personRef)) action.personRef = value.personRef.trim();
      return action;
    }
    case 'use-integration': {
      if (!isNonEmptyString(value.tool)) return null;
      const action: AssistantAction = { kind: 'use-integration', tool: value.tool, ...meta };
      if (isRecord(value.args)) action.args = value.args;
      return action;
    }
    case 'search-blocks-catalog': {
      if (!isNonEmptyString(value.query)) return null;
      const action: AssistantAction = { kind: 'search-blocks-catalog', query: value.query, ...meta };
      if (isNonEmptyString(value.tag)) action.tag = value.tag;
      if (isNonEmptyString(value.category)) action.category = value.category;
      return action;
    }
    case 'answer-direct':
      return { kind: 'answer-direct', ...meta };
    default:
      return null;
  }
}

function normalizeMeta(value: Record<string, unknown>): StepMeta {
  const meta: StepMeta = {};
  if (isNonEmptyString(value.id)) meta.id = value.id.trim();
  const runIf = normalizeRunIf(value.runIf);
  if (runIf) meta.runIf = runIf;
  return meta;
}

function normalizeRunIf(value: unknown): RunIf | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonEmptyString(value.from)) return undefined;
  if (!isRunIfPredicate(value.predicate)) return undefined;
  return { from: value.from.trim(), predicate: value.predicate };
}

function isRunIfPredicate(value: unknown): value is RunIfPredicate {
  return value === 'satisfied' || value === 'soft-miss' || value === 'free' || value === 'busy';
}

/** Parse a `{ from, field }` substitution ref, or null if the value is not
 *  one. Exported so the runtime and checks share one definition (1.2). */
export function asStepRef(value: unknown): StepRef | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.from)) return null;
  const keys = Object.keys(value);
  // A ref object carries only `from` and optionally `field` — anything else
  // is a normal args object that happens to contain a `from` key.
  const onlyRefKeys = keys.every((key) => key === 'from' || key === 'field');
  if (!onlyRefKeys) return null;
  const ref: StepRef = { from: value.from.trim() };
  if (isNonEmptyString(value.field)) ref.field = value.field.trim();
  return ref;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
