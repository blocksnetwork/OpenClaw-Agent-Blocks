/**
 * Two-sided peer booking offline gate — the MeetingRequest handshake.
 *
 * Proves, with no key and no network, that a meeting proposed across two
 * owners is a REAL handshake, not a one-sided auto-book:
 *   1. State machine: pending-both → single accept (still pending) → both
 *      accept (both-accepted) → bilateral commit (committed). Each transition
 *      is idempotent (a replayed accept / retry never advances twice).
 *   2. NO calendar write happens before BOTH accept; on both-accepted BOTH
 *      calendars are written EXACTLY once (a double-accept / re-commit does
 *      not create a second event).
 *   3. Hold TTL expiry auto-releases both tentative holds; a decline releases
 *      both holds and surfaces a user-visible resolution.
 *   4. Paired accept tokens: an owner can only accept their OWN side.
 *   5. Inbound hook: for a COORDINATION intent, runInboundA2A PARKS + emits a
 *      meeting-request notification carrying ONLY policy-shared fields, instead
 *      of auto-answering free/busy.
 *   6. Owner attribution (dashboardLocalA2A bug regression): the peer
 *      notification is delivered to the PEER owner (the bound owner), NEVER to
 *      the caller whose id rides the inbound task.
 *
 *   npm run check:pa-meeting-request
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { buildA2ARequest } from '../a2a/a2a.ts';
import type { NegotiationBooking, NegotiationHold } from '../a2a/negotiate.ts';
import {
  proposeMeetingRequest,
  acceptMeetingRequest,
  declineMeetingRequest,
  commitMeetingRequest,
  expireMeetingRequest,
  readMeetingRequest,
  meetingConfirmToken,
  type MeetingParty,
  type MeetingSlot,
  type MeetingRequestNotification,
} from '../a2a/meeting-request.ts';
import { invitePeer } from '../assistant/assistant-roster.ts';
import { runAssistant, type RunAssistantOpts, type RunIntegration } from '../assistant/assistant-runtime.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
process.env.PA_READONLY = '0';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(result: { artifacts?: Array<{ data?: unknown }> }): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected an artifact, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(parsed), `expected object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

interface StubEvent {
  id: string;
  ownerId: string;
  start: string;
  status: string;
}

interface StubCalendar {
  ownerId: string;
  events: StubEvent[];
  createCalls: number;
  deleteCalls: number;
  run: RunIntegration;
  confirmHold: (hold: NegotiationHold) => void;
}

function makeStubCalendar(ownerId: string): StubCalendar {
  const events: StubEvent[] = [];
  let nextId = 1;
  const calendar: StubCalendar = {
    ownerId,
    events,
    createCalls: 0,
    deleteCalls: 0,
    async run(tool, args) {
      assert(args.ownerId === ownerId && args.targetOwnerId === ownerId, `${ownerId} calendar got cross-owner write ${JSON.stringify(args)}`);
      if (tool === 'calendar.createEvent') {
        calendar.createCalls += 1;
        const event: StubEvent = { id: `${ownerId}-evt-${nextId}`, ownerId, start: String(args.start), status: String(args.status ?? 'busy') };
        nextId += 1;
        events.push(event);
        return { ok: true, tool, event };
      }
      if (tool === 'calendar.deleteEvent') {
        calendar.deleteCalls += 1;
        const eventId = typeof args.eventId === 'string' ? args.eventId : undefined;
        const index = events.findIndex((e) => e.id === eventId);
        if (index >= 0) events.splice(index, 1);
        return { ok: true, tool, deleted: eventId };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    confirmHold(hold) {
      const event = events.find((e) => e.id === hold.eventId);
      assert(event, `${ownerId} must have a tentative event to confirm`);
      event.status = 'busy';
    },
  };
  return calendar;
}

function bookingFor(alice: StubCalendar, bob: StubCalendar, baseDir: string): NegotiationBooking {
  return {
    self: {
      assistant: 'pa_alice',
      ownerId: alice.ownerId,
      bookingPolicy: 'auto',
      bookingAuditBaseDir: join(baseDir, `${alice.ownerId}-audit`),
      runIntegration: alice.run,
      confirmHold: alice.confirmHold,
    },
    peer: {
      assistant: 'pa_bob',
      ownerId: bob.ownerId,
      bookingPolicy: 'auto',
      bookingAuditBaseDir: join(baseDir, `${bob.ownerId}-audit`),
      runIntegration: bob.run,
      confirmHold: bob.confirmHold,
    },
  };
}

const SLOT: MeetingSlot = { start: '2026-07-02T13:00:00.000Z', end: '2026-07-02T13:30:00.000Z', durationMinutes: 30, label: '1:00pm–1:30pm' };
const ALICE: MeetingParty = { ownerId: 'alice-oid', assistant: 'pa_alice', displayName: 'Alice' };
const BOB: MeetingParty = { ownerId: 'bob-oid', assistant: 'pa_bob', displayName: 'Bob' };

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-meeting-'));

  /* ── 1 + 2. State machine + exactly-once bilateral commit ─────────────── */
  {
    const store = { baseDir: join(baseDir, 'mr-commit') };
    const alice = makeStubCalendar('alice-oid');
    const bob = makeStubCalendar('bob-oid');
    const booking = bookingFor(alice, bob, join(baseDir, 'commit'));
    const threadId = 'thread-commit';

    // Notification-only propose: NO calendar write yet.
    const proposed = await proposeMeetingRequest({ threadId, slot: SLOT, initiator: ALICE, peer: BOB }, undefined, store);
    assert(proposed.created && proposed.record.status === 'pending-both', `propose must create pending-both, got ${JSON.stringify(proposed.record)}`);
    assert(Number(alice.createCalls) === 0 && Number(bob.createCalls) === 0, 'no calendar write may happen at propose time');

    // Idempotent propose (same threadId) — never double-books.
    const proposedAgain = await proposeMeetingRequest({ threadId, slot: SLOT, initiator: ALICE, peer: BOB }, booking, store);
    assert(!proposedAgain.created, 'a second propose for the same threadId must be a no-op');

    // First accept (initiator): still pending-both, still NO write.
    const a1 = await acceptMeetingRequest({ threadId, ownerId: 'alice-oid', confirmToken: meetingConfirmToken(threadId, 'alice-oid') }, booking, store);
    assert(a1.changed && a1.record.status === 'pending-both', `single accept must stay pending-both, got ${JSON.stringify(a1.record)}`);
    assert(Number(alice.createCalls) === 0 && Number(bob.createCalls) === 0, 'no calendar write may happen before BOTH accept');

    // Idempotent re-accept by the same owner: no change, still no write.
    const a1replay = await acceptMeetingRequest({ threadId, ownerId: 'alice-oid' }, booking, store);
    assert(!a1replay.changed && a1replay.record.status === 'pending-both', 'a replayed accept must not advance the state');
    assert(Number(alice.createCalls) === 0 && Number(bob.createCalls) === 0, 'a replayed accept must not write a calendar');

    // Second accept (peer): both-accepted → bilateral commit → EXACTLY one event each.
    const a2 = await acceptMeetingRequest({ threadId, ownerId: 'bob-oid', confirmToken: meetingConfirmToken(threadId, 'bob-oid') }, booking, store);
    assert(a2.committed && a2.record.status === 'committed', `both accept must commit, got ${JSON.stringify(a2.record)}`);
    assert(Number(alice.events.length) === 1 && Number(bob.events.length) === 1, `both calendars must hold exactly one event, got ${Number(alice.events.length)}/${Number(bob.events.length)}`);
    assert(alice.events[0].status === 'busy' && bob.events[0].status === 'busy', 'committed events must be busy');
    assert(Number(alice.createCalls) === 1 && Number(bob.createCalls) === 1, `each calendar must be written exactly once, got ${Number(alice.createCalls)}/${Number(bob.createCalls)}`);

    // Double-accept + explicit re-commit: NO second event.
    await acceptMeetingRequest({ threadId, ownerId: 'bob-oid', confirmToken: meetingConfirmToken(threadId, 'bob-oid') }, booking, store);
    await commitMeetingRequest(threadId, booking, store);
    assert(Number(alice.createCalls) === 1 && Number(bob.createCalls) === 1, `retry/double-accept must NOT create a second event, got ${Number(alice.createCalls)}/${Number(bob.createCalls)}`);
    console.log('▸ commit: pending-both → single accept → both-accepted → committed; both calendars written exactly once (idempotent) ✓');
  }

  /* ── 3a. Hold TTL expiry auto-releases both holds ─────────────────────── */
  {
    const store = { baseDir: join(baseDir, 'mr-ttl') };
    const alice = makeStubCalendar('alice-oid');
    const bob = makeStubCalendar('bob-oid');
    const booking = bookingFor(alice, bob, join(baseDir, 'ttl'));
    const threadId = 'thread-ttl';
    const now = 1_000_000;

    // Reservation-mode propose: tentative holds placed on BOTH calendars now.
    const proposed = await proposeMeetingRequest({ threadId, slot: SLOT, initiator: ALICE, peer: BOB, holdTtlMs: 60_000, now }, booking, store);
    assert(proposed.record.status === 'pending-both' && proposed.record.holds.length === 2, `propose-with-holds must place 2 holds, got ${JSON.stringify(proposed.record.holds)}`);
    assert(Number(alice.events.length) === 1 && Number(bob.events.length) === 1 && alice.events[0].status === 'tentative', 'holds must be tentative reservations on both calendars');

    // TTL elapses → both holds released, no dangling hold.
    const expired = await expireMeetingRequest(threadId, booking, store, now + 120_000);
    assert(expired.changed && expired.record.status === 'expired', `expired request must transition to expired, got ${JSON.stringify(expired.record)}`);
    assert(Number(alice.events.length) === 0 && Number(bob.events.length) === 0, 'hold TTL expiry must release BOTH holds');
    assert(Number(alice.deleteCalls) === 1 && Number(bob.deleteCalls) === 1, 'expiry must delete each tentative hold exactly once');

    // Idempotent expiry: a re-sweep does nothing.
    const expiredAgain = await expireMeetingRequest(threadId, booking, store, now + 200_000);
    assert(!expiredAgain.changed, 'expiring an already-expired request must be a no-op');
    console.log('▸ ttl: an unaccepted request expires and auto-releases both tentative holds ✓');
  }

  /* ── 3b. Decline releases holds + surfaces a user-visible resolution ──── */
  {
    const store = { baseDir: join(baseDir, 'mr-decline') };
    const alice = makeStubCalendar('alice-oid');
    const bob = makeStubCalendar('bob-oid');
    const booking = bookingFor(alice, bob, join(baseDir, 'decline'));
    const threadId = 'thread-decline';

    await proposeMeetingRequest({ threadId, slot: SLOT, initiator: ALICE, peer: BOB }, booking, store);
    assert(Number(alice.events.length) === 1 && Number(bob.events.length) === 1, 'reservation propose must place both holds');

    const declined = await declineMeetingRequest({ threadId, ownerId: 'bob-oid' }, booking, store);
    assert(declined.changed && declined.record.status === 'declined' && declined.record.declinedBy === 'bob-oid', `decline must record declinedBy, got ${JSON.stringify(declined.record)}`);
    assert(Number(alice.events.length) === 0 && Number(bob.events.length) === 0, 'decline must release BOTH holds');

    // Accepting after a decline is refused (terminal state), and the record
    // yields a user-visible resolution message.
    const afterDecline = await acceptMeetingRequest({ threadId, ownerId: 'alice-oid' }, booking, store);
    assert(!afterDecline.changed && typeof afterDecline.error === 'string', 'accept after decline must be refused');
    const record = await readMeetingRequest(threadId, store);
    assert(record && record.status === 'declined', 'declined is terminal');
    console.log('▸ decline: releases both holds, is terminal, and surfaces a resolution ✓');
  }

  /* ── 4. Paired accept tokens: only your own side ──────────────────────── */
  {
    const store = { baseDir: join(baseDir, 'mr-token') };
    const threadId = 'thread-token';
    await proposeMeetingRequest({ threadId, slot: SLOT, initiator: ALICE, peer: BOB }, undefined, store);
    const wrong = await acceptMeetingRequest({ threadId, ownerId: 'bob-oid', confirmToken: meetingConfirmToken(threadId, 'alice-oid') }, undefined, store);
    assert(!wrong.changed && /token/u.test(wrong.error ?? ''), `a mismatched paired token must be refused, got ${JSON.stringify(wrong)}`);
    const notParty = await acceptMeetingRequest({ threadId, ownerId: 'carol-oid' }, undefined, store);
    assert(!notParty.changed && /party/u.test(notParty.error ?? ''), 'a non-party owner must be refused');
    console.log('▸ tokens: paired accept token binds acceptance to the owning side; non-parties refused ✓');
  }

  /* ── 5 + 6. Inbound park + owner attribution (dashboardLocalA2A regression) */
  {
    const rosterDir = join(baseDir, 'roster');
    // Bob shares free/busy (NOT titles) with Alice; both record ownerIds.
    await invitePeer({
      owner: 'bob@acme',
      agentName: 'pa_bob',
      ownerId: 'bob-oid',
      peerOwner: 'alice@acme',
      peerAgentName: 'pa_alice',
      peerOwnerId: 'alice-oid',
      sharePolicy: { freeBusy: true, meetingTitles: false },
      baseDir: rosterDir,
    });

    const notifications: MeetingRequestNotification[] = [];
    let freeBusyCalls = 0;
    const bobOpts: RunAssistantOpts = {
      selfHandle: 'pa_bob',
      rosterBaseDir: rosterDir,
      budgetBaseDir: rosterDir,
      auditBaseDir: rosterDir,
      meetingRequestBaseDir: join(baseDir, 'mr-inbound'),
      ownerContext: { freeBusy: ['Thu 9–10 busy'], meetingTitles: ['Board: Project Zephyr'] },
      onOwnerNotify: (n) => { notifications.push(n); },
      runIntegration: async (tool) => {
        if (tool === 'calendar.freeBusy') freeBusyCalls += 1;
        return { ok: true, tool, freeBusy: [] };
      },
    };

    // The inbound task's ownerId is the CALLER (Alice) — exactly how
    // dashboardLocalA2A builds it for the invite gate. The bound owner (Bob)
    // is carried by the policy.
    const coordinationIntent = 'Find mutual availability for this request: coordinate with Bob for a 30 minute meeting. My calendar result: free';
    const inboundTask = {
      type: 'StartTask',
      taskId: 'mr-inbound-check',
      ownerId: 'alice-oid',
      requestParts: [{ partId: 'request', text: JSON.stringify(buildA2ARequest({ from: 'pa_alice', intent: coordinationIntent, threadId: 'thread-inbound' })), contentType: 'application/json' }],
    } as StartTaskMessage;

    const parked = payloadOf(await runAssistant(inboundTask, undefined, { ownerId: 'bob-oid' }, bobOpts));
    assert(parked.parked === true, `coordination intent must PARK, not auto-answer, got ${JSON.stringify(parked)}`);
    assert(freeBusyCalls === 0, `parked coordination must NOT auto-run a free/busy read, got ${freeBusyCalls}`);
    assert(notifications.length === 1, `inbound park must emit exactly one notification, got ${notifications.length}`);

    const n = notifications[0];
    // 6. Owner attribution: delivered to the PEER (bound) owner, NEVER the caller.
    // Delivered to the PEER/bound owner (bob-oid), NEVER the caller (alice-oid,
    // whose id rides task.ownerId for the invite gate) — the dashboardLocalA2A
    // mis-attribution regression.
    assert(n.toOwnerId === 'bob-oid', `notification must target the peer/bound owner (bob-oid), not the caller, got ${n.toOwnerId}`);
    assert(n.role === 'peer' && n.type === 'meeting-request', `notification shape wrong: ${JSON.stringify(n)}`);
    // 5. Only policy-shared fields; titles never leak.
    assert(isRecord(n.shared) && 'freeBusy' in n.shared, 'notification must carry the shared free/busy (opted in)');
    assert(!('meetingTitles' in (n.shared ?? {})), 'notification must NOT leak meeting titles (opted out)');
    assert(n.summary === 'Meeting request', `summary must be generic when titles are not shared, got ${JSON.stringify(n.summary)}`);
    console.log('▸ inbound: coordination intent PARKS + notifies the PEER owner (policy-shared only, no title leak, no auto free/busy) ✓');
  }

  console.log('\naudit: two-sided handshake — propose→accept×2→commit, holds+TTL+decline, paired tokens, inbound park + owner attribution — all offline');
  console.log('✅ pa-meeting-request check passed');
} catch (err) {
  console.error(`❌ pa-meeting-request check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
