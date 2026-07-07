/**
 * Phase T4.2 offline gate - A2A negotiation books on convergence.
 *
 * Proves that PA-6 convergence now drives owner-local calendar writes:
 * each assistant writes only its own owner's calendar, mixed bookingPolicy
 * sides still create one agreed event each, and a peer confirm failure
 * compensates by deleting any successful local hold.
 *
 *   npm run check:pa-booking-a2a
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { negotiateSlot, type AskPeer, type NegotiationHold } from '../a2a/negotiate.ts';
import type { RunIntegration } from '../assistant/assistant-runtime.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
process.env.PA_READONLY = '0';

interface StubEvent {
  id: string;
  ownerId: string;
  start: string;
  end?: string;
  status: string;
  threadId?: string;
  targetOwnerId?: string;
}

interface StubCall {
  tool: string;
  args: Record<string, unknown>;
}

interface StubCalendar {
  ownerId: string;
  events: StubEvent[];
  calls: StubCall[];
  run: RunIntegration;
  confirmHold: (hold: NegotiationHold) => void;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function cooperativePeer(peerFree: string[]): AskPeer {
  return async (_request, proposal) => {
    if (proposal.accept && peerFree.includes(proposal.accept)) {
      return { slots: [proposal.accept], accept: proposal.accept };
    }
    return { slots: peerFree };
  };
}

function makeStubCalendar(ownerId: string, opts: { failConfirm?: boolean } = {}): StubCalendar {
  const events: StubEvent[] = [];
  const calls: StubCall[] = [];
  let nextId = 1;

  const calendar: StubCalendar = {
    ownerId,
    events,
    calls,
    async run(tool, args) {
      calls.push({ tool, args });
      assert(args.targetOwnerId === ownerId, `${ownerId} calendar received cross-owner target ${String(args.targetOwnerId)}`);
      assert(args.ownerId === ownerId, `${ownerId} calendar received cross-owner ownerId ${String(args.ownerId)}`);

      if (tool === 'calendar.createEvent') {
        const event: StubEvent = {
          id: `${ownerId}-evt-${nextId}`,
          ownerId,
          start: String(args.start),
          end: typeof args.end === 'string' ? args.end : undefined,
          status: String(args.status ?? 'busy'),
          threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
          targetOwnerId: typeof args.targetOwnerId === 'string' ? args.targetOwnerId : undefined,
        };
        nextId += 1;
        events.push(event);
        return { ok: true, tool, event };
      }

      if (tool === 'calendar.deleteEvent') {
        const eventId = typeof args.eventId === 'string' ? args.eventId : undefined;
        const index = events.findIndex((event) => event.id === eventId);
        if (index >= 0) events.splice(index, 1);
        return { ok: true, tool, deleted: eventId };
      }

      throw new Error(`unexpected tool ${tool}`);
    },
    confirmHold(hold) {
      if (opts.failConfirm) throw new Error(`${ownerId} confirm failed`);
      const event = events.find((candidate) => candidate.id === hold.eventId);
      assert(event, `${ownerId} must have a tentative event to confirm`);
      event.status = 'busy';
    },
  };

  return calendar;
}

function assertOwnerOnly(calendar: StubCalendar): void {
  assert(
    calendar.calls.every((call) => call.args.ownerId === calendar.ownerId && call.args.targetOwnerId === calendar.ownerId),
    `${calendar.ownerId} must only receive owner-local write calls, got ${JSON.stringify(calendar.calls)}`,
  );
  assert(
    calendar.events.every((event) => event.ownerId === calendar.ownerId && event.targetOwnerId === calendar.ownerId),
    `${calendar.ownerId} must only contain owner-local events, got ${JSON.stringify(calendar.events)}`,
  );
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-booking-a2a-'));

  const alice = makeStubCalendar('alice-oid');
  const bob = makeStubCalendar('bob-oid');
  const aliceFree = ['2026-07-02T13:00:00.000Z', '2026-07-02T13:30:00.000Z'];
  const bobFree = ['2026-07-02T13:30:00.000Z', '2026-07-02T14:00:00.000Z'];

  const booked = await negotiateSlot({
    self: 'pa_alice',
    peer: 'pa_bob',
    selfFree: aliceFree,
    threadId: 'thread-booking-ok',
    askPeer: cooperativePeer(bobFree),
    booking: {
      self: {
        assistant: 'pa_alice',
        ownerId: alice.ownerId,
        bookingPolicy: 'auto',
        bookingAuditBaseDir: join(baseDir, 'alice-audit'),
        runIntegration: alice.run,
        confirmHold: alice.confirmHold,
      },
      peer: {
        assistant: 'pa_bob',
        ownerId: bob.ownerId,
        bookingPolicy: 'confirm',
        bookingAuditBaseDir: join(baseDir, 'bob-audit'),
        runIntegration: bob.run,
        confirmHold: bob.confirmHold,
      },
    },
  });

  assert(booked.converged === true && booked.reason === 'converged', `must converge and book, got ${JSON.stringify(booked)}`);
  assert(booked.slot === '2026-07-02T13:30:00.000Z', `must book the agreed slot, got ${booked.slot}`);
  assert(alice.events.length === 1 && bob.events.length === 1, 'both owner calendars must contain exactly one event');
  assert(alice.events[0].start === booked.slot && bob.events[0].start === booked.slot, 'both events must be for the agreed slot');
  assert(alice.events[0].status === 'busy' && bob.events[0].status === 'busy', 'tentative holds must confirm to busy');
  assertOwnerOnly(alice);
  assertOwnerOnly(bob);
  console.log('▸ converge: mixed auto/confirm policies create one owner-local busy event per calendar ✓');

  const aliceFail = makeStubCalendar('alice-oid');
  const bobFail = makeStubCalendar('bob-oid', { failConfirm: true });
  const failed = await negotiateSlot({
    self: 'pa_alice',
    peer: 'pa_bob',
    selfFree: aliceFree,
    threadId: 'thread-booking-fail',
    askPeer: cooperativePeer(bobFree),
    booking: {
      self: {
        assistant: 'pa_alice',
        ownerId: aliceFail.ownerId,
        bookingPolicy: 'auto',
        bookingAuditBaseDir: join(baseDir, 'alice-fail-audit'),
        runIntegration: aliceFail.run,
        confirmHold: aliceFail.confirmHold,
      },
      peer: {
        assistant: 'pa_bob',
        ownerId: bobFail.ownerId,
        bookingPolicy: 'auto',
        bookingAuditBaseDir: join(baseDir, 'bob-fail-audit'),
        runIntegration: bobFail.run,
        confirmHold: bobFail.confirmHold,
      },
    },
  });

  assert(failed.converged === false && failed.reason === 'booking-failed', `peer confirm failure must surface booking-failed, got ${JSON.stringify(failed)}`);
  assert(aliceFail.events.length === 0, `compensation must delete Alice's successful hold, got ${JSON.stringify(aliceFail.events)}`);
  assert(bobFail.events.length === 0, `compensation must delete Bob's failed-side hold too, got ${JSON.stringify(bobFail.events)}`);
  assert(aliceFail.calls.some((call) => call.tool === 'calendar.deleteEvent'), 'Alice compensation must call deleteEvent');
  assertOwnerOnly(aliceFail);
  assertOwnerOnly(bobFail);
  console.log('▸ compensation: peer confirm failure releases/delete successful owner-local holds ✓');

  console.log('\naudit: A2A convergence books owner-only calendars with hold→confirm→release compensation — all offline');
  console.log('✅ pa-booking-a2a check passed');
} catch (err) {
  console.error(`❌ pa-booking-a2a check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
