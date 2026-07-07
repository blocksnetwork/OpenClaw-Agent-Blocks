/**
 * a2a — the assistant-to-assistant request contract + helpers (Phase PA-4,
 * docs/PERSONAL-ASSISTANT-PLAN.md → "A2A transport", end-state B).
 *
 * The A2A "message" is a small typed JSON object that rides on the task's
 * request part (mirroring the plan in "A2A transport"):
 *
 *   { "a2a": true, "intent": "free-busy", "from": "pa_alice",
 *     "threadId": "…", "hop": 0, "window": "2026-06-25/2026-06-26" }
 *
 * - `from`/`threadId`/`hop` are the loop-safety surface: the receiver
 *   refuses `from == self`, caps `hop`, and the same `threadId` chains a
 *   conversation (negotiation is PA-6; PA-4 is one question / one answer).
 * - `applySharePolicy()` is the redaction step. It runs in the receiver
 *   BEFORE the brain (runSkill) so the LLM only ever sees the fields the
 *   owner's share policy allows — it can't leak what it never saw (D5).
 *
 * Pure and offline: no network, no SDK calls, fully deterministic.
 */

import { randomUUID } from 'node:crypto';

import type { SharePolicy } from '../assistant/assistant-roster.ts';

/** Loop termination: an A2A request whose hop count exceeds this is
 *  refused, so a runaway chain self-terminates even within the daily cap. */
export const MAX_A2A_HOPS = 8;

/** The typed contract carried on the request part of an A2A task. */
export interface A2ARequest {
  a2a: true;
  intent: string;
  from: string;
  threadId: string;
  hop: number;
  window?: string;
}

/** The owner's shareable context — the source the share policy filters.
 *  Keyed by the same fields as SharePolicy; values are opaque to A2A. */
export type OwnerContext = Partial<Record<keyof SharePolicy, unknown>>;

/** The fields the share policy gates, in a stable order. Kept in lockstep
 *  with SharePolicy so a new shareable field is a one-line change. */
const SHARE_FIELDS = ['freeBusy', 'meetingTitles'] as const satisfies readonly (keyof SharePolicy)[];

/** A minimal structural view of a StartTaskMessage (keeps this module free
 *  of an SDK dependency so it stays pure/offline). */
interface TaskLike {
  requestParts?: Array<{ partId?: string; text?: string } | undefined>;
}

/**
 * Mint an A2ARequest. A fresh `threadId` is generated when absent and `hop`
 * defaults to 0 (the originating request); chaining passes both through.
 */
export function buildA2ARequest(args: {
  from: string;
  intent: string;
  window?: string;
  threadId?: string;
  hop?: number;
}): A2ARequest {
  return {
    a2a: true,
    intent: args.intent,
    from: args.from,
    threadId: args.threadId && args.threadId.trim() ? args.threadId : newThreadId(),
    hop: typeof args.hop === 'number' && Number.isFinite(args.hop) ? args.hop : 0,
    ...(args.window ? { window: args.window } : {}),
  };
}

/**
 * Read the A2A request off a task. Returns the typed request when the part
 * carries `a2a: true` with a non-empty `intent` and `from`, otherwise null
 * — so the runtime can tell an owner-request from an A2A-request.
 */
export function parseA2ARequest(task: TaskLike): A2ARequest | null {
  const part =
    task.requestParts?.find((candidate) => candidate?.partId === 'request') ?? task.requestParts?.[0];
  const raw = typeof part?.text === 'string' ? part.text : '';
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.a2a !== true) return null;

  const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
  const from = typeof parsed.from === 'string' ? parsed.from.trim() : '';
  if (!intent || !from) return null;

  return {
    a2a: true,
    intent,
    from,
    threadId: typeof parsed.threadId === 'string' && parsed.threadId.trim() ? parsed.threadId : newThreadId(),
    hop: typeof parsed.hop === 'number' && Number.isFinite(parsed.hop) ? parsed.hop : 0,
    ...(typeof parsed.window === 'string' ? { window: parsed.window } : {}),
  };
}

/**
 * The redaction step (allow-list, per field). Emits ONLY the fields the
 * peer's share policy opts in AND that the owner context actually carries.
 * Everything else is dropped before it can reach the brain.
 */
export function applySharePolicy(context: OwnerContext, policy: SharePolicy): OwnerContext {
  const out: OwnerContext = {};
  for (const field of SHARE_FIELDS) {
    if (policy[field] === true && context[field] !== undefined) {
      out[field] = context[field];
    }
  }
  return out;
}

function newThreadId(): string {
  return `a2a-${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
