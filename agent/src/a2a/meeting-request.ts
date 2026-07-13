/**
 * meeting-request — the two-sided peer-booking state machine (the handshake).
 *
 * Peer coordination used to be one-sided: Alice's PA fetched Bob's free/busy,
 * Alice got a "book" chip, and the event committed to Alice's calendar only.
 * Bob was never in the loop. This module makes a meeting a REAL handshake:
 *
 *   proposed (pending-both)
 *      │  ├─ owner accepts ──▶ still pending-both (waiting on the other)
 *      │  └─ both owners accept ──▶ both-accepted ──▶ committed (BOTH calendars)
 *      ├─ either owner declines ──▶ declined      (holds released)
 *      └─ hold TTL elapses       ──▶ expired       (holds released)
 *
 * Design constraints honoured here:
 *  - Keyed by the SHARED A2A `threadId`, so the initiator side and the peer
 *    side converge on ONE record (creation is idempotent by threadId).
 *  - Tentative calendar holds are placed at PROPOSE time (reusing
 *    `negotiate.ts`'s promoted hold→confirm→release machinery — no second
 *    booking path) and carry a TTL, so an unaccepted request auto-releases and
 *    never leaves a dangling hold.
 *  - Commit is idempotent: a status guard plus the booking-audit idempotency
 *    ids mean a double-accept or a retry can NEVER create two events.
 *  - PAIRED accept tokens — one deterministic token per (threadId, owner) —
 *    reuse the `confirmToken` pattern so an owner can only accept their OWN
 *    side, never on the peer's behalf.
 *
 * Append-only JSONL store (mirrors booking-audit / pending-plan): each state
 * change appends a full snapshot; `readMeetingRequest` folds to the latest.
 * Pure + offline: all IO is a local file; the calendar seam is injected.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  commitAgreedSlot,
  placeAgreedHolds,
  confirmAgreedHolds,
  releaseAgreedHolds,
  type NegotiationBooking,
  type NegotiationHold,
} from './negotiate.ts';

/** Lifecycle states. `pending-both` covers 0 OR 1 acceptance (still waiting
 *  on the other owner); the terminal states are explicit so no path can hang
 *  silently. */
export type MeetingRequestStatus =
  | 'pending-both'
  | 'both-accepted'
  | 'committed'
  | 'declined'
  | 'expired'
  | 'commit-failed';

export interface MeetingSlot {
  start: string;
  end: string;
  durationMinutes: number;
  /** Optional human label ("2:00pm–2:30pm") for the notification UI. */
  label?: string;
}

/** One owner bound to the meeting. `role` disambiguates who proposed. */
export interface MeetingParty {
  ownerId: string;
  /** The owner's assistant handle (roster-driven; never a pinned `pa_*`). */
  assistant: string;
  /** Display name the recipient may see, subject to share policy. */
  displayName?: string;
}

export interface MeetingAcceptance {
  ownerId: string;
  at: number;
}

export interface MeetingRequestRecord {
  at: number;
  threadId: string;
  slot: MeetingSlot;
  initiator: MeetingParty;
  peer: MeetingParty;
  status: MeetingRequestStatus;
  acceptances: MeetingAcceptance[];
  declinedBy?: string;
  /** Hold/request TTL: after this instant an unaccepted request expires and
   *  its holds are released. */
  expiresAt: number;
  /** Tentative holds placed on both calendars while awaiting acceptance. */
  holds: NegotiationHold[];
  /** The committed booking outcome (present once committed / commit-failed). */
  commit?: {
    outcome: 'booked' | 'released' | 'booking-failed';
    slot?: string;
    error?: string;
  };
  /** Policy-shared fields the peer agreed to reveal (privacy allow-list). */
  shared?: Record<string, unknown>;
  /** Free-text summary — carries a meeting title ONLY when share policy
   *  permits titles; otherwise a generic label. */
  summary?: string;
  /** The optional idempotency reason a terminal snapshot carries. */
  note?: string;
}

/** A single owner-scoped notification pushed to a dashboard channel. Carries
 *  ONLY what the recipient is allowed to see (no cross-owner leakage). */
export interface MeetingRequestNotification {
  type: 'meeting-request';
  event: 'proposed' | 'accepted' | 'both-accepted' | 'committed' | 'declined' | 'expired' | 'commit-failed' | 'peer-offline';
  threadId: string;
  /** The owner this notification is FOR (delivery key). Never the caller. */
  toOwnerId: string;
  /** The recipient's role in this meeting. */
  role: 'initiator' | 'peer';
  status: MeetingRequestStatus;
  slot: MeetingSlot;
  /** The counterpart's display label, share-policy permitting. */
  fromLabel?: string;
  /** The recipient's PAIRED accept token (only on states that need action). */
  confirmToken?: string;
  /** Policy-shared fields (e.g. free/busy) — allow-list only. */
  shared?: Record<string, unknown>;
  summary?: string;
  message: string;
}

/** The notification seam. The dashboard injects a sink that fans the event
 *  out to the owner-scoped SSE channel; checks inject a capturing stub. */
export type OwnerNotify = (notification: MeetingRequestNotification) => void | Promise<void>;

/** Default hold/request TTL: 15 minutes. Configurable per call so a check can
 *  force an immediate expiry. */
export const DEFAULT_HOLD_TTL_MS = 15 * 60_000;

interface StoreOpts {
  baseDir?: string;
}

function storeDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data', import.meta.url));
}

function storePath(baseDir?: string): string {
  return `${storeDir(baseDir)}/meeting-requests.jsonl`;
}

async function appendSnapshot(record: MeetingRequestRecord, opts: StoreOpts): Promise<void> {
  await mkdir(storeDir(opts.baseDir), { recursive: true });
  await appendFile(storePath(opts.baseDir), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readAllMeetingRequests(opts: StoreOpts = {}): Promise<MeetingRequestRecord[]> {
  let raw: string;
  try {
    raw = await readFile(storePath(opts.baseDir), 'utf8');
  } catch {
    return [];
  }
  const entries: MeetingRequestRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as MeetingRequestRecord);
    } catch {
      // Skip corrupt lines rather than failing the whole read.
    }
  }
  return entries;
}

/** The latest snapshot for a threadId (append-only: newest line wins). */
export async function readMeetingRequest(
  threadId: string,
  opts: StoreOpts = {},
): Promise<MeetingRequestRecord | null> {
  const entries = await readAllMeetingRequests(opts);
  let latest: MeetingRequestRecord | null = null;
  for (const entry of entries) {
    if (entry.threadId === threadId) latest = entry;
  }
  return latest;
}

/** The current (latest, folded) meeting requests, one per threadId. */
export async function listMeetingRequests(opts: StoreOpts = {}): Promise<MeetingRequestRecord[]> {
  const entries = await readAllMeetingRequests(opts);
  const byThread = new Map<string, MeetingRequestRecord>();
  for (const entry of entries) byThread.set(entry.threadId, entry);
  return [...byThread.values()];
}

/** Meeting requests where `ownerId` is a party — the owner-scoped feed a
 *  dashboard replays when a channel first subscribes. */
export async function meetingRequestsForOwner(
  ownerId: string,
  opts: StoreOpts = {},
): Promise<MeetingRequestRecord[]> {
  return (await listMeetingRequests(opts)).filter(
    (r) => r.initiator.ownerId === ownerId || r.peer.ownerId === ownerId,
  );
}

/* ── paired accept tokens ────────────────────────────────────────────────
 * One deterministic token per (threadId, owner). Reuses the confirm-token
 * shape (an opaque digest) so an owner can only accept their OWN side. */
export function meetingConfirmToken(threadId: string, ownerId: string): string {
  const digest = createHash('sha256').update(`meeting:${threadId}:${ownerId}`).digest('hex').slice(0, 16);
  return `mreq_${digest}`;
}

export function partyForOwner(record: MeetingRequestRecord, ownerId: string): MeetingParty | null {
  if (record.initiator.ownerId === ownerId) return record.initiator;
  if (record.peer.ownerId === ownerId) return record.peer;
  return null;
}

function roleForOwner(record: MeetingRequestRecord, ownerId: string): 'initiator' | 'peer' | null {
  if (record.initiator.ownerId === ownerId) return 'initiator';
  if (record.peer.ownerId === ownerId) return 'peer';
  return null;
}

export function hasAccepted(record: MeetingRequestRecord, ownerId: string): boolean {
  return record.acceptances.some((a) => a.ownerId === ownerId);
}

export function bothAccepted(record: MeetingRequestRecord): boolean {
  return hasAccepted(record, record.initiator.ownerId) && hasAccepted(record, record.peer.ownerId);
}

export function isExpired(record: MeetingRequestRecord, now: number): boolean {
  return now > record.expiresAt;
}

/* ── pure transitions (no IO) ──────────────────────────────────────────── */

/** Fold an acceptance into a record. Pure + idempotent: a repeat accept by
 *  the same owner returns the record unchanged (`changed:false`). Rejects a
 *  non-party owner. Does not touch calendars. */
export function applyAcceptance(
  record: MeetingRequestRecord,
  ownerId: string,
  now: number,
): { record: MeetingRequestRecord; changed: boolean; error?: string } {
  if (!partyForOwner(record, ownerId)) {
    return { record, changed: false, error: 'owner is not a party to this meeting request' };
  }
  // Terminal states are final.
  if (record.status === 'committed' || record.status === 'declined' || record.status === 'commit-failed') {
    return { record, changed: false, error: `meeting request is already ${record.status}` };
  }
  if (record.status !== 'expired' && isExpired(record, now)) {
    return { record: { ...record, at: now, status: 'expired' }, changed: true, error: 'meeting request expired' };
  }
  if (record.status === 'expired') {
    return { record, changed: false, error: 'meeting request expired' };
  }
  if (hasAccepted(record, ownerId)) {
    return { record, changed: false }; // idempotent double-accept
  }
  const acceptances = [...record.acceptances, { ownerId, at: now }];
  const next: MeetingRequestRecord = { ...record, at: now, acceptances };
  next.status = bothAccepted(next) ? 'both-accepted' : 'pending-both';
  return { record: next, changed: true };
}

/** Fold a decline into a record (pure). Idempotent once declined. */
export function applyDecline(
  record: MeetingRequestRecord,
  ownerId: string,
  now: number,
): { record: MeetingRequestRecord; changed: boolean; error?: string } {
  if (!partyForOwner(record, ownerId)) {
    return { record, changed: false, error: 'owner is not a party to this meeting request' };
  }
  if (record.status === 'committed') {
    return { record, changed: false, error: 'meeting request is already committed' };
  }
  if (record.status === 'declined') return { record, changed: false };
  return { record: { ...record, at: now, status: 'declined', declinedBy: ownerId }, changed: true };
}

/* ── store-backed orchestration ────────────────────────────────────────── */

export interface ProposeArgs {
  threadId: string;
  slot: MeetingSlot;
  initiator: MeetingParty;
  peer: MeetingParty;
  shared?: Record<string, unknown>;
  summary?: string;
  holdTtlMs?: number;
  now?: number;
}

export interface ProposeResult {
  record: MeetingRequestRecord;
  created: boolean;
}

/**
 * Create the meeting request (status `pending-both`) and place tentative
 * holds on BOTH calendars. Idempotent by threadId: a second propose for the
 * same thread returns the existing record and never double-books a hold. When
 * `booking` is omitted (a notification-only path that has just one side's
 * calendar), the record is created WITHOUT holds — the dashboard, which can
 * reach both owners' calendars, upgrades it with holds.
 */
export async function proposeMeetingRequest(
  args: ProposeArgs,
  booking: NegotiationBooking | undefined,
  opts: StoreOpts = {},
): Promise<ProposeResult> {
  const existing = await readMeetingRequest(args.threadId, opts);
  if (existing) return { record: existing, created: false };

  const now = args.now ?? Date.now();
  const ttl = args.holdTtlMs ?? DEFAULT_HOLD_TTL_MS;

  let holds: NegotiationHold[] = [];
  if (booking) {
    const placed = await placeAgreedHolds(booking, args.slot.start, args.threadId);
    if (!placed.ok) {
      const failed: MeetingRequestRecord = {
        at: now,
        threadId: args.threadId,
        slot: args.slot,
        initiator: args.initiator,
        peer: args.peer,
        status: 'commit-failed',
        acceptances: [],
        expiresAt: now + ttl,
        holds: placed.holds,
        commit: { outcome: 'booking-failed', slot: args.slot.start, error: placed.error },
        ...(args.shared ? { shared: args.shared } : {}),
        ...(args.summary ? { summary: args.summary } : {}),
        note: 'hold placement failed at propose',
      };
      await appendSnapshot(failed, opts);
      return { record: failed, created: true };
    }
    holds = placed.holds;
  }

  const record: MeetingRequestRecord = {
    at: now,
    threadId: args.threadId,
    slot: args.slot,
    initiator: args.initiator,
    peer: args.peer,
    status: 'pending-both',
    acceptances: [],
    expiresAt: now + ttl,
    holds,
    ...(args.shared ? { shared: args.shared } : {}),
    ...(args.summary ? { summary: args.summary } : {}),
  };
  await appendSnapshot(record, opts);
  return { record, created: true };
}

export interface RespondResult {
  record: MeetingRequestRecord;
  changed: boolean;
  error?: string;
  committed?: boolean;
}

/**
 * Record one owner's acceptance (idempotent). Validates the PAIRED accept
 * token for that owner. If both owners have now accepted AND a `booking` is
 * provided, drives the bilateral commit in the SAME call so acceptance and
 * commit are atomic from the caller's view. Never commits before both accept.
 */
export async function acceptMeetingRequest(
  args: { threadId: string; ownerId: string; confirmToken?: string; now?: number },
  booking: NegotiationBooking | undefined,
  opts: StoreOpts = {},
): Promise<RespondResult> {
  const now = args.now ?? Date.now();
  const record = await readMeetingRequest(args.threadId, opts);
  if (!record) return { record: emptyRecord(args.threadId), changed: false, error: 'unknown meeting request' };

  if (args.confirmToken !== undefined && args.confirmToken !== meetingConfirmToken(args.threadId, args.ownerId)) {
    return { record, changed: false, error: 'accept token does not match this owner' };
  }

  const applied = applyAcceptance(record, args.ownerId, now);
  if (applied.error && !applied.changed) {
    return { record: applied.record, changed: false, error: applied.error };
  }
  if (applied.changed) await appendSnapshot(applied.record, opts);
  if (applied.error) return { record: applied.record, changed: applied.changed, error: applied.error };

  // Commit exactly once, only when both have accepted.
  if (applied.record.status === 'both-accepted' && booking) {
    const committed = await commitMeetingRequest(args.threadId, booking, opts, now);
    return { record: committed.record, changed: true, committed: committed.record.status === 'committed', error: committed.error };
  }
  return { record: applied.record, changed: applied.changed };
}

export async function declineMeetingRequest(
  args: { threadId: string; ownerId: string; now?: number },
  booking: NegotiationBooking | undefined,
  opts: StoreOpts = {},
): Promise<RespondResult> {
  const now = args.now ?? Date.now();
  const record = await readMeetingRequest(args.threadId, opts);
  if (!record) return { record: emptyRecord(args.threadId), changed: false, error: 'unknown meeting request' };

  const applied = applyDecline(record, args.ownerId, now);
  if (!applied.changed) return { record: applied.record, changed: false, error: applied.error };

  // Release any tentative holds so a decline never leaves a dangling hold.
  const released = booking ? await releaseAgreedHolds(booking, applied.record.holds) : [];
  const next: MeetingRequestRecord = {
    ...applied.record,
    holds: released.length ? released : applied.record.holds.map((h) => ({ ...h, status: 'released' as const })),
  };
  await appendSnapshot(next, opts);
  return { record: next, changed: true };
}

/**
 * Bilateral commit: confirm the tentative holds to busy on BOTH calendars.
 * Idempotent — a status guard short-circuits a re-commit (returns the prior
 * outcome with NO second write), and the confirm itself rides the same holds
 * so a retry cannot create a second event. Only runs when `both-accepted`.
 */
export async function commitMeetingRequest(
  threadId: string,
  booking: NegotiationBooking,
  opts: StoreOpts = {},
  now = Date.now(),
): Promise<{ record: MeetingRequestRecord; error?: string }> {
  const record = await readMeetingRequest(threadId, opts);
  if (!record) return { record: emptyRecord(threadId), error: 'unknown meeting request' };

  // Idempotency guard: never commit twice.
  if (record.status === 'committed') return { record };
  if (record.status !== 'both-accepted') {
    return { record, error: `cannot commit in status ${record.status}` };
  }

  // If holds were placed at propose, confirm them; otherwise place+confirm now
  // (the notification-only propose path defers hold placement to commit).
  let outcome;
  if (record.holds.length > 0) {
    const confirmed = await confirmAgreedHolds(booking, record.holds, record.slot.start);
    outcome = confirmed.ok
      ? { outcome: 'booked' as const, slot: record.slot.start, holds: confirmed.holds, released: [] as NegotiationHold[] }
      : { outcome: 'booking-failed' as const, slot: record.slot.start, holds: confirmed.holds, released: confirmed.released, error: confirmed.error };
  } else {
    outcome = await commitAgreedSlot(booking, record.slot.start, record.threadId);
  }

  const next: MeetingRequestRecord = {
    ...record,
    at: now,
    holds: outcome.holds.length ? outcome.holds : record.holds,
    status: outcome.outcome === 'booked' ? 'committed' : 'commit-failed',
    commit: { outcome: outcome.outcome, slot: outcome.slot, ...(outcome.error ? { error: outcome.error } : {}) },
  };
  await appendSnapshot(next, opts);
  return { record: next, ...(outcome.error ? { error: outcome.error } : {}) };
}

/**
 * Expire a still-pending request whose TTL has elapsed: release both holds and
 * mark `expired`. Idempotent and a no-op for non-pending or not-yet-expired
 * requests, so a periodic sweep can call it freely.
 */
export async function expireMeetingRequest(
  threadId: string,
  booking: NegotiationBooking | undefined,
  opts: StoreOpts = {},
  now = Date.now(),
): Promise<{ record: MeetingRequestRecord; changed: boolean }> {
  const record = await readMeetingRequest(threadId, opts);
  if (!record) return { record: emptyRecord(threadId), changed: false };
  const isPending = record.status === 'pending-both' || record.status === 'both-accepted';
  if (!isPending || !isExpired(record, now)) return { record, changed: false };

  const released = booking ? await releaseAgreedHolds(booking, record.holds) : [];
  const next: MeetingRequestRecord = {
    ...record,
    at: now,
    status: 'expired',
    holds: released.length ? released : record.holds.map((h) => ({ ...h, status: 'released' as const })),
  };
  await appendSnapshot(next, opts);
  return { record: next, changed: true };
}

/** Sweep every pending request and expire those past TTL. The booking
 *  resolver returns a per-thread booking so holds can be released owner-local. */
export async function sweepExpiredMeetingRequests(
  bookingFor: (record: MeetingRequestRecord) => NegotiationBooking | undefined | Promise<NegotiationBooking | undefined>,
  opts: StoreOpts = {},
  now = Date.now(),
): Promise<MeetingRequestRecord[]> {
  const pending = (await listMeetingRequests(opts)).filter(
    (r) => (r.status === 'pending-both' || r.status === 'both-accepted') && isExpired(r, now),
  );
  const expired: MeetingRequestRecord[] = [];
  for (const record of pending) {
    const booking = await bookingFor(record);
    const result = await expireMeetingRequest(record.threadId, booking, opts, now);
    if (result.changed) expired.push(result.record);
  }
  return expired;
}

/** Build the pair of owner-scoped notifications for a record's current state
 *  — one for each party, each carrying only what that recipient may see and
 *  their OWN paired accept token. */
export function notificationsFor(record: MeetingRequestRecord): MeetingRequestNotification[] {
  const event = eventForStatus(record);
  return [
    buildNotification(record, record.peer.ownerId, event),
    buildNotification(record, record.initiator.ownerId, event),
  ];
}

export function buildNotification(
  record: MeetingRequestRecord,
  toOwnerId: string,
  event: MeetingRequestNotification['event'],
): MeetingRequestNotification {
  const role = roleForOwner(record, toOwnerId) ?? 'peer';
  const counterpart = role === 'peer' ? record.initiator : record.peer;
  const actionable = record.status === 'pending-both' && !hasAccepted(record, toOwnerId);
  return {
    type: 'meeting-request',
    event,
    threadId: record.threadId,
    toOwnerId,
    role,
    status: record.status,
    slot: record.slot,
    ...(counterpart.displayName ? { fromLabel: counterpart.displayName } : {}),
    ...(actionable ? { confirmToken: meetingConfirmToken(record.threadId, toOwnerId) } : {}),
    ...(record.shared ? { shared: record.shared } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    message: notificationMessage(record, toOwnerId, role),
  };
}

function eventForStatus(record: MeetingRequestRecord): MeetingRequestNotification['event'] {
  switch (record.status) {
    case 'both-accepted': return 'both-accepted';
    case 'committed': return 'committed';
    case 'declined': return 'declined';
    case 'expired': return 'expired';
    case 'commit-failed': return 'commit-failed';
    default: return 'proposed';
  }
}

function notificationMessage(record: MeetingRequestRecord, toOwnerId: string, role: 'initiator' | 'peer'): string {
  const counterpart = role === 'peer' ? record.initiator : record.peer;
  const who = counterpart.displayName ?? (role === 'peer' ? 'another owner' : 'your peer');
  const when = record.slot.label ?? record.slot.start;
  switch (record.status) {
    case 'pending-both':
      return hasAccepted(record, toOwnerId)
        ? `Waiting for ${who} to accept the meeting ${when}.`
        : `Incoming meeting request from ${who} for ${when}. Accept or decline.`;
    case 'both-accepted':
      return `Both accepted the meeting ${when} — booking it now.`;
    case 'committed':
      return `Meeting confirmed with ${who} for ${when}. It's on both calendars.`;
    case 'declined':
      return record.declinedBy === toOwnerId
        ? `You declined the meeting ${when}.`
        : `${who} declined the meeting ${when}.`;
    case 'expired':
      return `The meeting request for ${when} expired before both of you accepted.`;
    case 'commit-failed':
      return `Both accepted, but booking the meeting ${when} failed. No event was created; please try again.`;
    default:
      return `Meeting update for ${when}.`;
  }
}

function emptyRecord(threadId: string): MeetingRequestRecord {
  return {
    at: 0,
    threadId,
    slot: { start: '', end: '', durationMinutes: 0 },
    initiator: { ownerId: '', assistant: '' },
    peer: { ownerId: '', assistant: '' },
    status: 'pending-both',
    acceptances: [],
    expiresAt: 0,
    holds: [],
  };
}
