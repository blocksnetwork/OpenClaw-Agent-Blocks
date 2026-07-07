/**
 * Fan-out — "pull in any agent at once", now with a strategy.
 *
 * Opens ONE Blocks session, discovers a set of agents (by skill, by
 * explicit handles, or the whole catalog), then coordinates them:
 *
 *   mode 'all'    — call everyone, return everything (the original batch)
 *   mode 'race'   — first success wins; the rest are abandoned
 *   mode 'quorum' — resolve as soon as N successes arrive
 *   mode 'best'   — collect all successes, then a local OpenClaw judge
 *                   (the pick_best skill) names a winner + reason
 *
 * Every call is retried with capped, jittered backoff (Phase 10) and its
 * failure is isolated so the rest still return.
 *
 * Works in both modes — the offline mock catalog and the real Blocks
 * network — because it only talks to `blocks-client.ts` (the one door),
 * never the SDK directly.
 */

import { connect, type ConnectOptions } from '../blocks/blocks-client.ts';
import { runSkill } from '../blocks/openclaw-client.ts';
import type { CallMeta, CallResult } from '../types.ts';

export type FanoutMode = 'all' | 'race' | 'quorum' | 'best';

export interface FanoutOptions {
  /** Discover everyone who can do this skill, then call them all. */
  skill?: string;
  /** Restrict to (or, with no skill, target) these specific handles. */
  handles?: string[];
  /** Inputs passed to every agent. */
  inputs: Record<string, unknown>;
  /** Coordination strategy. Default 'all'. */
  mode?: FanoutMode;
  /** Required for mode 'quorum': resolve after this many successes. */
  quorum?: number;
  /** Cap on how many agents to call. Default 10. */
  limit?: number;
  /** Max attempts per agent (1 = no retries). Default 2. */
  tries?: number;
  /** Per-attempt cap in ms. Default 120_000 (matches waitForTerminal). */
  timeoutMs?: number;
  /** Base delay between attempts in ms, doubled each retry, ±25% jitter. Default 1_000. */
  backoffMs?: number;
  latencyScale?: number;
  onPartial?: ConnectOptions['onPartial'];
}

export interface FanoutFailure {
  handle: string;
  skill: string;
  reason: string;
  /** How many attempts were made before giving up. */
  attempts: number;
}

/** Mode 'best' only: the judge's pick among successful results. */
export interface FanoutVerdict {
  /** Handle of the winning agent. */
  winner: string;
  reason: string;
}

export interface FanoutResult {
  mode: FanoutMode;
  results: CallResult[];
  audit: CallMeta[];
  failures: FanoutFailure[];
  /** Attempts made per handle — 1 means first try succeeded. Handles
   *  abandoned before settling are absent. */
  attemptsByHandle: Record<string, number>;
  /** Handles abandoned because race/quorum already resolved. */
  abandoned?: string[];
  verdict?: FanoutVerdict;
}

export interface Target {
  handle: string;
  skill: string;
}

export interface RetryPolicy {
  tries: number;
  timeoutMs: number;
  backoffMs: number;
}

export type AttemptOutcome =
  | { ok: true; result: CallResult; attempts: number }
  | { ok: false; reason: string; attempts: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function retryPolicy(opts: {
  tries?: number;
  timeoutMs?: number;
  backoffMs?: number;
}): RetryPolicy {
  return {
    tries: Math.max(1, opts.tries ?? 2),
    timeoutMs: opts.timeoutMs ?? 120_000,
    backoffMs: opts.backoffMs ?? 1_000,
  };
}

export async function fanout(opts: FanoutOptions): Promise<FanoutResult> {
  const mode = opts.mode ?? 'all';
  if (mode === 'quorum' && !(typeof opts.quorum === 'number' && opts.quorum >= 1)) {
    throw new Error("mode 'quorum' requires quorum >= 1");
  }
  const policy = retryPolicy(opts);

  const session = await connect({
    latencyScale: opts.latencyScale,
    onPartial: opts.onPartial,
  });

  try {
    const targets = await resolveTargets(session, opts);

    const need =
      mode === 'race' ? 1
      : mode === 'quorum' ? Math.min(opts.quorum as number, Math.max(targets.length, 1))
      : targets.length;

    // callWithRetry never rejects, so failures stay isolated per target.
    const promises = targets.map((t) => callWithRetry(session, t, opts.inputs, policy));
    const outcomes = await collectUntil(promises, need);

    const results: CallResult[] = [];
    const audit: CallMeta[] = [];
    const failures: FanoutFailure[] = [];
    const attemptsByHandle: Record<string, number> = {};
    const abandoned: string[] = [];

    outcomes.forEach((outcome, i) => {
      const target = targets[i];
      if (!outcome) {
        abandoned.push(target.handle);
        return;
      }
      attemptsByHandle[target.handle] = outcome.attempts;
      if (outcome.ok) {
        results.push(outcome.result);
        audit.push(outcome.result.meta);
      } else {
        failures.push({
          handle: target.handle,
          skill: target.skill,
          reason: outcome.reason,
          attempts: outcome.attempts,
        });
      }
    });

    let verdict: FanoutVerdict | undefined;
    if (mode === 'best' && results.length > 0) {
      verdict = await judgeBest(opts.inputs, results);
    }

    return {
      mode,
      results,
      audit,
      failures,
      attemptsByHandle,
      abandoned: abandoned.length ? abandoned : undefined,
      verdict,
    };
  } finally {
    session.close();
  }
}

/**
 * Call one target with retries. Exported so `pipeline.ts` reuses the
 * exact same retry semantics — this is the ONE retrying caller.
 */
export async function callWithRetry(
  session: Awaited<ReturnType<typeof connect>>,
  target: Target,
  inputs: Record<string, unknown>,
  policy: RetryPolicy,
): Promise<AttemptOutcome> {
  let lastReason = 'unknown failure';

  for (let attempt = 1; attempt <= policy.tries; attempt += 1) {
    try {
      const result = await withTimeout(
        session.call(target.handle, target.skill, inputs),
        policy.timeoutMs,
        target.handle,
      );
      return { ok: true, result, attempts: attempt };
    } catch (err) {
      lastReason = reasonText(err);
      if (!isRetryable(err) || attempt === policy.tries) {
        return { ok: false, reason: lastReason, attempts: attempt };
      }
      await sleep(backoffDelay(policy.backoffMs, attempt));
    }
  }

  return { ok: false, reason: lastReason, attempts: policy.tries };
}

/**
 * Resolve as soon as `need` successes have arrived (or everything has
 * settled). Slots still in flight at resolution come back `undefined` —
 * those targets were abandoned.
 */
function collectUntil(
  promises: Array<Promise<AttemptOutcome>>,
  need: number,
): Promise<Array<AttemptOutcome | undefined>> {
  if (promises.length === 0) return Promise.resolve([]);

  return new Promise((resolve) => {
    const outcomes: Array<AttemptOutcome | undefined> = new Array(promises.length).fill(undefined);
    let successes = 0;
    let settled = 0;
    let done = false;

    promises.forEach((promise, i) => {
      void promise.then((outcome) => {
        if (done) return;
        outcomes[i] = outcome;
        settled += 1;
        if (outcome.ok) successes += 1;
        if (successes >= need || settled === promises.length) {
          done = true;
          resolve([...outcomes]);
        }
      });
    });
  });
}

/**
 * The judge is OpenClaw, not code: the local pick_best skill receives
 * the task plus every successful candidate and must answer with strict
 * JSON `{ winner, reason }`. Local model judges remote labor.
 */
async function judgeBest(
  inputs: Record<string, unknown>,
  results: CallResult[],
): Promise<FanoutVerdict> {
  const task = typeof inputs.text === 'string' ? inputs.text : JSON.stringify(inputs);
  const candidates = results.map((r) => ({ id: r.meta.handle, output: r.data }));

  const raw = await runSkill('pick_best', { task, candidates });
  const verdict = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    winner?: unknown;
    reason?: unknown;
  };

  const winner = typeof verdict.winner === 'string' ? verdict.winner : '';
  if (!candidates.some((c) => c.id === winner)) {
    throw new Error(
      `pick_best judge returned an invalid verdict (winner must be one of ${candidates
        .map((c) => c.id)
        .join(', ')}): ${JSON.stringify(raw)}`,
    );
  }

  return {
    winner,
    reason: typeof verdict.reason === 'string' && verdict.reason.trim()
      ? verdict.reason
      : '(judge gave no reason)',
  };
}

/** Doubled each retry, with ±25% jitter so a herd of retries doesn't stampede. */
function backoffDelay(baseMs: number, attempt: number): number {
  const delay = baseMs * 2 ** (attempt - 1);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(delay + jitter));
}

function withTimeout<T>(promise: Promise<T>, ms: number, handle: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${handle} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Retry only failures that could plausibly succeed on a second try:
 * timeouts, terminal failed/blocked states, transport errors. A handle
 * that was never discovered or input that failed validation will never
 * succeed, so don't burn attempts on it.
 */
function isRetryable(err: unknown): boolean {
  const message = reasonText(err).toLowerCase();
  const permanent = [
    'was not discovered',
    'no agent for handle',
    'session closed',
    'is required',
    'invalid input',
  ];
  return !permanent.some((marker) => message.includes(marker));
}

async function resolveTargets(
  session: Awaited<ReturnType<typeof connect>>,
  opts: FanoutOptions,
): Promise<Target[]> {
  const limit = opts.limit ?? 10;

  const pool = opts.skill
    ? await session.discover(opts.skill)
    : await session.discoverAll({ limit });

  const handleFilter = opts.handles?.length ? new Set(opts.handles) : undefined;

  return pool
    .filter((agent) => !handleFilter || handleFilter.has(agent.handle))
    .slice(0, limit)
    .map((agent) => ({
      handle: agent.handle,
      skill: opts.skill ?? agent.skills[0] ?? 'unknown',
    }));
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
