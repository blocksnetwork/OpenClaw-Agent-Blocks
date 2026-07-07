/**
 * a2a-audit — the assistant-to-assistant hop audit trail (Phase PA-5,
 * docs/PERSONAL-ASSISTANT-PLAN.md → "Phase 5 — dashboard surface").
 *
 * Every successful A2A hop (a peer answered, or this assistant sent a
 * request to a peer) is appended here so the dashboard can show "an audit
 * of A2A hops next to the existing served-agent panel". Append-only JSONL
 * under `agent/data/` — machine-local runtime state, gitignored like the
 * roster and the budget counter.
 *
 *   - recordHop()  → append one hop (newest hops are at the file's tail).
 *   - readHops()   → read the most recent hops, newest first.
 *
 * Offline and dependency-free: only touches the local filesystem.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface A2AHop {
  /** Epoch ms when the hop was recorded. */
  at: number;
  /** 'in' = a peer asked us and we answered; 'out' = we asked a peer. */
  direction: 'in' | 'out';
  from: string;
  to: string;
  intent: string;
  hop: number;
  threadId: string;
  /** What happened, e.g. 'answered' (inbound) or 'sent' (outbound). */
  outcome: string;
}

function auditDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data', import.meta.url));
}

function auditPath(baseDir?: string): string {
  return `${auditDir(baseDir)}/a2a-audit.jsonl`;
}

/** Append one A2A hop to the trail. Best-effort: an audit write failure
 *  must never break the A2A call itself, so errors are swallowed. */
export async function recordHop(
  hop: Omit<A2AHop, 'at'> & { at?: number },
  opts: { baseDir?: string } = {},
): Promise<void> {
  const entry: A2AHop = { at: hop.at ?? Date.now(), ...hop };
  try {
    await mkdir(auditDir(opts.baseDir), { recursive: true });
    await appendFile(auditPath(opts.baseDir), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Audit is observability, not correctness — never throw.
  }
}

/** Read the most recent hops, newest first (default: last 50). */
export async function readHops(opts: { baseDir?: string; limit?: number } = {}): Promise<A2AHop[]> {
  const limit = opts.limit ?? 50;
  let raw: string;
  try {
    raw = await readFile(auditPath(opts.baseDir), 'utf8');
  } catch {
    return [];
  }
  const hops: A2AHop[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      hops.push(JSON.parse(trimmed) as A2AHop);
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return hops.reverse().slice(0, limit);
}
