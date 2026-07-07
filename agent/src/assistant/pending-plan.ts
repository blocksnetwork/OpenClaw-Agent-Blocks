/**
 * pending-plan — the cross-turn plan/resume store (Pillar 1.0).
 *
 * The only persisted runtime state before this was `booking-audit.ts` (a
 * single write proposal). A compound, multi-step plan that pauses mid-way —
 * waiting on a write confirmation (1.4), a disambiguation pick (3.3), an
 * added contact (0.5), or an owner "finish it" follow-up (S11) — needs to
 * remember WHERE it was: the plan, the results ledger so far, the step
 * cursor, and the open question. This append-only JSONL store is that shared
 * backbone (mirrors booking-audit's shape) so each of those features resumes
 * the SAME parked plan instead of growing its own ad-hoc state.
 *
 *   agent/data/pending-plans.jsonl
 *
 * Keyed by a resume token. For a write-confirm pause the resume token IS the
 * booking confirm token, so a single confirm round-trip both runs the
 * gated write and resumes the rest of the plan.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { AssistantAction } from './plan-schema.ts';

/** One step's recorded outcome in the ledger. `payload` is the JSON the
 *  step handler produced; `classification` is how the executor read it. */
export interface LedgerEntry {
  stepId: string;
  kind: AssistantAction['kind'];
  classification: 'satisfied' | 'soft-miss' | 'needs-input' | 'hard-fail' | 'skipped';
  payload: Record<string, unknown>;
}

export interface PendingPlanEntry {
  at: number;
  resumeToken: string;
  ownerId: string;
  /** The plan being executed (reply + ordered steps). */
  plan: { reply: string; steps: AssistantAction[] };
  /** Per-step outcomes recorded so far, keyed by step id (in order). */
  ledger: LedgerEntry[];
  /** Index of the step to resume AT (the paused step). */
  cursor: number;
  /** Step ids already completed (skip these on resume — step idempotency). */
  completedStepIds: string[];
  /** The question the owner must answer to resume (confirm / disambiguate). */
  openQuestion?: string;
  /** Why the plan paused, for routing the resume payload. */
  reason: 'confirm' | 'needs-input' | 'disambiguation';
  status: 'pending' | 'resolved';
}

function storeDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data', import.meta.url));
}

function storePath(baseDir?: string): string {
  return `${storeDir(baseDir)}/pending-plans.jsonl`;
}

export async function recordPendingPlan(
  entry: Omit<PendingPlanEntry, 'at'> & { at?: number },
  opts: { baseDir?: string } = {},
): Promise<void> {
  const full: PendingPlanEntry = { at: entry.at ?? Date.now(), ...entry };
  await mkdir(storeDir(opts.baseDir), { recursive: true });
  await appendFile(storePath(opts.baseDir), `${JSON.stringify(full)}\n`, 'utf8');
}

export async function readPendingPlans(opts: { baseDir?: string } = {}): Promise<PendingPlanEntry[]> {
  let raw: string;
  try {
    raw = await readFile(storePath(opts.baseDir), 'utf8');
  } catch {
    return [];
  }

  const entries: PendingPlanEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as PendingPlanEntry);
    } catch {
      // Skip corrupt lines rather than failing the whole read.
    }
  }
  return entries;
}

/**
 * The newest still-pending plan for a resume token, honouring a later
 * `resolved` marker (append-only: resolution is a new line, not a mutation).
 */
export async function findPendingPlan(
  resumeToken: string,
  opts: { baseDir?: string } = {},
): Promise<PendingPlanEntry | null> {
  const entries = await readPendingPlans(opts);
  let candidate: PendingPlanEntry | null = null;
  for (const entry of entries) {
    if (entry.resumeToken !== resumeToken) continue;
    if (entry.status === 'resolved') {
      candidate = null;
      continue;
    }
    candidate = entry;
  }
  return candidate;
}

/** Mark a parked plan resolved so a replayed confirm token can't re-run it. */
export async function resolvePendingPlan(
  resumeToken: string,
  opts: { baseDir?: string } = {},
): Promise<void> {
  const existing = await findPendingPlan(resumeToken, opts);
  if (!existing) return;
  await recordPendingPlan({ ...existing, status: 'resolved' }, opts);
}
