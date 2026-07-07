/**
 * booking-audit - append-only write-action audit and idempotency store.
 *
 * Calendar/event writes are owner-local runtime state. Each proposal/write is
 * recorded under `agent/data/booking-audit.jsonl` so retries can be no-ops and
 * confirmation can resume a prior proposal by token.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface BookingAuditEntry {
  at: number;
  idempotencyId: string;
  confirmToken: string;
  tool: string;
  args: Record<string, unknown>;
  ownerId: string;
  policy: 'confirm' | 'auto';
  status: 'proposed' | 'written' | 'refused' | 'failed';
  result?: unknown;
  reason?: string;
}

function auditDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data', import.meta.url));
}

function auditPath(baseDir?: string): string {
  return `${auditDir(baseDir)}/booking-audit.jsonl`;
}

export async function recordBookingWrite(
  entry: Omit<BookingAuditEntry, 'at'> & { at?: number },
  opts: { baseDir?: string } = {},
): Promise<void> {
  const full: BookingAuditEntry = { at: entry.at ?? Date.now(), ...entry };
  await mkdir(auditDir(opts.baseDir), { recursive: true });
  await appendFile(auditPath(opts.baseDir), `${JSON.stringify(full)}\n`, 'utf8');
}

export async function readBookingWrites(opts: { baseDir?: string } = {}): Promise<BookingAuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(auditPath(opts.baseDir), 'utf8');
  } catch {
    return [];
  }

  const entries: BookingAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as BookingAuditEntry);
    } catch {
      // Skip corrupt lines rather than failing the whole audit read.
    }
  }
  return entries;
}

export async function findWrittenBooking(
  idempotencyId: string,
  opts: { baseDir?: string } = {},
): Promise<BookingAuditEntry | null> {
  const entries = await readBookingWrites(opts);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.idempotencyId === idempotencyId && entry.status === 'written' && bookingResultSucceeded(entry.result)) return entry;
  }
  return null;
}

export async function findBookingProposal(
  confirmToken: string,
  opts: { baseDir?: string } = {},
): Promise<BookingAuditEntry | null> {
  const entries = await readBookingWrites(opts);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.confirmToken === confirmToken && entry.status === 'proposed') return entry;
  }
  return null;
}

export function bookingResultSucceeded(result: unknown): boolean {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (obj.ok === false || obj.isError === true) return false;
  }
  return true;
}
