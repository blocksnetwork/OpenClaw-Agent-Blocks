/**
 * a2a-budget — the daily assistant-to-assistant call cap (Phase PA-4,
 * docs/PERSONAL-ASSISTANT-PLAN.md → "Payments / cost").
 *
 * Two assistants in a loop are a natural runaway, so OUTBOUND A2A calls are
 * throttled by `PA_A2A_DAILY_CALLS_CAP` (a rolling-24h counter keyed by
 * day). The counter is persisted under `agent/data/` — machine-local
 * runtime state, gitignored like the peer roster.
 *
 *   - withinDailyCap()  → may we make one more A2A call today?
 *   - recordA2ACall()   → count one OUTBOUND A2A call.
 *
 * Pure-ish and offline: only touches the local filesystem, no network.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_CAP = 200;

interface BudgetFile {
  /** UTC day key (YYYY-MM-DD); the count resets when the day rolls over. */
  day: string;
  count: number;
}

function budgetDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data', import.meta.url));
}

function budgetPath(baseDir?: string): string {
  return `${budgetDir(baseDir)}/a2a-budget.json`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The cap from env (PA_A2A_DAILY_CALLS_CAP), clamped to a positive int. */
export function dailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PA_A2A_DAILY_CALLS_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CAP;
}

async function loadBudget(baseDir?: string): Promise<BudgetFile> {
  try {
    const parsed = JSON.parse(await readFile(budgetPath(baseDir), 'utf8')) as Partial<BudgetFile>;
    if (parsed.day === today() && typeof parsed.count === 'number') {
      return { day: parsed.day, count: parsed.count };
    }
  } catch {
    // No file yet, or unreadable → start fresh for today.
  }
  return { day: today(), count: 0 };
}

/** True when at least one more A2A call fits under today's cap. */
export async function withinDailyCap(
  opts: { baseDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const { count } = await loadBudget(opts.baseDir);
  return count < dailyCap(opts.env ?? process.env);
}

/** Today's running OUTBOUND A2A call count (the dashboard's spend proxy). */
export async function a2aCallsToday(opts: { baseDir?: string } = {}): Promise<number> {
  return (await loadBudget(opts.baseDir)).count;
}

/** Count one OUTBOUND A2A call; returns the running total for today. */
export async function recordA2ACall(opts: { baseDir?: string } = {}): Promise<number> {
  const dir = budgetDir(opts.baseDir);
  await mkdir(dir, { recursive: true });
  const current = await loadBudget(opts.baseDir);
  const next: BudgetFile = { day: current.day, count: current.count + 1 };
  await writeFile(budgetPath(opts.baseDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next.count;
}
