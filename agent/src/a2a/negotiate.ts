/**
 * negotiate — multi-turn assistant-to-assistant slot negotiation (Phase
 * PA-6, end-state C; docs/PERSONAL-ASSISTANT-PLAN.md → "C. Two assistants
 * negotiate, not just fetch" + "A2A transport").
 *
 * End-state B (PA-4) was one question / one answer. End-state C is a
 * conversation: Alice's assistant proposes candidate slots, Bob's assistant
 * counter-proposes against Bob's calendar, until they converge on a slot
 * that is free for BOTH — or terminate.
 *
 * Transport choice: the **request/response loop** (NOT the SDK `pipe` task
 * kind), because it reuses the exact PA-4 A2A contract — every turn rides on
 * a `buildA2ARequest` envelope carrying the SHARED `threadId` and an
 * incrementing `hop`. That hop counter is the loop-safety surface: the loop
 * is hard-capped at `MAX_A2A_HOPS`, so two stubborn assistants self-
 * terminate instead of negotiating forever (the natural runaway the plan's
 * "Failure modes → A2A loop" warns about).
 *
 * Pure and offline: the peer round-trip is an injectable `askPeer` seam
 * (the same shape PA-4's `sendA2A` is), so the protocol is fully
 * deterministic and testable with no key and no network. In production
 * `askPeer` issues a real A2A request to the peer's runtime.
 */

import type { HandlerResult, StartTaskMessage } from '@blocks-network/sdk';

import { buildA2ARequest, MAX_A2A_HOPS, type A2ARequest } from './a2a.ts';
import {
  runAssistant,
  type BookingPolicy,
  type RunAssistantOpts,
  type RunIntegration,
  type RunSkillImpl,
} from '../assistant/assistant-runtime.ts';

/** The negotiation payload exchanged each turn (rides alongside the A2A
 *  envelope). Slots are opaque, comparable, ordered-by-preference strings
 *  (e.g. ISO datetimes or 'Thu-09:30'); the engine never parses them. */
export interface SlotProposal {
  /** Candidate slots offered, in the sender's preference order. */
  slots: string[];
  /** A single slot the sender commits to and asks the peer to confirm. */
  accept?: string;
}

export interface NegotiationTurn {
  hop: number;
  threadId: string;
  from: string;
  to: string;
  sent: SlotProposal;
  received: SlotProposal;
}

export type NegotiationReason = 'converged' | 'no-common-slot' | 'max-hops' | 'booking-failed';

export type BookingSideKey = 'self' | 'peer';

export interface NegotiationBookingSide {
  /** Assistant whose owner-local runtime is doing the write. */
  assistant: string;
  /** The owner bound to that assistant. */
  ownerId: string;
  /** Per-owner write policy from T4.1. Defaults the same way as runAssistant. */
  bookingPolicy?: BookingPolicy;
  /** Owner-local calendar runner. It must point at this side's calendar only. */
  runIntegration: RunIntegration;
  /** Optional owner-local audit/idempotency directory. */
  bookingAuditBaseDir?: string;
  /** Optional stable task prefix for deterministic offline checks. */
  taskIdPrefix?: string;
  /** Optional details to include on each hold. */
  event?: {
    summary?: string;
    description?: string;
    durationMinutes?: number;
    attendees?: string[];
  };
  /** Owner-local tentative->busy transition for calendar adapters that support it. */
  confirmHold?: (hold: NegotiationHold) => void | Promise<void>;
  offline?: boolean;
}

export interface NegotiationBooking {
  self: NegotiationBookingSide;
  peer: NegotiationBookingSide;
}

export interface NegotiationHold {
  side: BookingSideKey;
  assistant: string;
  ownerId: string;
  slot: string;
  threadId: string;
  idempotencyId: string;
  eventId?: string;
  status: 'tentative' | 'busy' | 'released';
  result?: unknown;
}

export interface NegotiationBookingOutcome {
  outcome: 'booked' | 'released' | 'booking-failed';
  slot?: string;
  holds: NegotiationHold[];
  released: NegotiationHold[];
  error?: string;
}

export interface NegotiationResult {
  converged: boolean;
  /** The agreed slot when converged. */
  slot?: string;
  hops: number;
  threadId: string;
  transcript: NegotiationTurn[];
  reason: NegotiationReason;
  booking?: NegotiationBookingOutcome;
}

/** The peer round-trip seam: given our envelope + proposal, return the
 *  peer's counter (or confirmation). Mirrors PA-4's `sendA2A`. */
export type AskPeer = (request: A2ARequest, proposal: SlotProposal) => Promise<SlotProposal>;

export interface NegotiateArgs {
  /** This assistant (the initiator), e.g. 'pa_alice'. */
  self: string;
  /** The peer assistant, e.g. 'pa_bob'. */
  peer: string;
  /** This party's free slots in the window, in preference order. */
  selfFree: string[];
  window?: string;
  /** Continue an existing thread; a fresh id is minted when absent. */
  threadId?: string;
  /** Hard cap on turns; clamped to MAX_A2A_HOPS so a runaway self-ends. */
  maxHops?: number;
  askPeer: AskPeer;
  /** Side-effect hook per turn (e.g. PA-5 audit / PA-4 budget). */
  onTurn?: (turn: NegotiationTurn) => void | Promise<void>;
  /** Optional owner-local booking on convergence. */
  booking?: NegotiationBooking;
}

/** The earliest slots free for BOTH parties, in `prefer`'s order. */
export function intersectOrdered(prefer: string[], allow: string[]): string[] {
  const allowSet = new Set(allow);
  return prefer.filter((slot) => allowSet.has(slot));
}

/**
 * Run the negotiation to convergence or termination. Returns the agreed
 * slot (when converged), the hop count, the shared threadId, and the full
 * transcript for the dashboard's A2A-hop audit.
 */
export async function negotiateSlot(args: NegotiateArgs): Promise<NegotiationResult> {
  const maxHops = Math.max(1, Math.min(args.maxHops ?? MAX_A2A_HOPS, MAX_A2A_HOPS));
  // Mint the thread once; every turn reuses this id (the conversation key).
  const threadId = buildA2ARequest({ from: args.self, intent: 'negotiate-slot', threadId: args.threadId }).threadId;
  const transcript: NegotiationTurn[] = [];
  let holds: NegotiationHold[] = [];
  let heldSlot: string | undefined;

  // Open by offering our free slots, with no commitment yet.
  let sent: SlotProposal = { slots: [...args.selfFree] };

  try {
    for (let hop = 1; hop <= maxHops; hop += 1) {
      const request = buildA2ARequest({ from: args.self, intent: 'negotiate-slot', window: args.window, threadId, hop });
      const received = await args.askPeer(request, sent);
      const turn: NegotiationTurn = { hop, threadId, from: args.self, to: args.peer, sent, received };
      transcript.push(turn);
      await args.onTurn?.(turn);

      // The peer accepted/confirmed a slot we are also free for → done.
      if (received.accept && args.selfFree.includes(received.accept)) {
        const held = await ensureHolds(args.booking, holds, heldSlot, received.accept, threadId);
        if (held.failed) {
          return bookingFailedResult(hop, threadId, transcript, received.accept, held);
        }
        holds = held.holds;
        heldSlot = received.accept;

        const confirmed = await confirmHolds(args.booking, holds, received.accept);
        if (confirmed.failed) {
          return bookingFailedResult(hop, threadId, transcript, received.accept, confirmed);
        }
        return {
          converged: true,
          slot: received.accept,
          hops: hop,
          threadId,
          transcript,
          reason: 'converged',
          booking: args.booking ? { outcome: 'booked', slot: received.accept, holds, released: [] } : undefined,
        };
      }

      // Narrow to the earliest slot free for BOTH and commit to it; if there
      // is no overlap at all, the negotiation cannot succeed — terminate.
      const common = intersectOrdered(args.selfFree, received.slots);
      if (common.length === 0) {
        const released = await releaseHolds(args.booking, holds);
        return {
          converged: false,
          hops: hop,
          threadId,
          transcript,
          reason: 'no-common-slot',
          booking: args.booking && (holds.length > 0 || released.length > 0) ? { outcome: 'released', holds, released } : undefined,
        };
      }

      const nextSlot = common[0];
      const held = await ensureHolds(args.booking, holds, heldSlot, nextSlot, threadId);
      if (held.failed) {
        return bookingFailedResult(hop, threadId, transcript, nextSlot, held);
      }
      holds = held.holds;
      heldSlot = nextSlot;
      sent = { slots: common, accept: nextSlot };
    }

    // Hit the hop cap without convergence (e.g. a stubborn peer) → stop.
    const released = await releaseHolds(args.booking, holds);
    return {
      converged: false,
      hops: maxHops,
      threadId,
      transcript,
      reason: 'max-hops',
      booking: args.booking && (holds.length > 0 || released.length > 0) ? { outcome: 'released', holds, released } : undefined,
    };
  } catch (err) {
    if (!args.booking) throw err;
    const released = await releaseHolds(args.booking, holds);
    return {
      converged: false,
      slot: heldSlot,
      hops: transcript.length,
      threadId,
      transcript,
      reason: 'booking-failed',
      booking: { outcome: 'booking-failed', slot: heldSlot, holds, released, error: errorMessage(err) },
    };
  }
}

type HoldStep =
  | { failed: false; holds: NegotiationHold[]; released: NegotiationHold[] }
  | { failed: true; holds: NegotiationHold[]; released: NegotiationHold[]; error: string };

async function ensureHolds(
  booking: NegotiationBooking | undefined,
  current: NegotiationHold[],
  currentSlot: string | undefined,
  nextSlot: string,
  threadId: string,
): Promise<HoldStep> {
  if (!booking) return { failed: false, holds: current, released: [] };
  if (currentSlot === nextSlot && current.length === 2) return { failed: false, holds: current, released: [] };

  const released = await releaseHolds(booking, current);
  const placed: NegotiationHold[] = [];
  try {
    placed.push(await placeHold(booking.self, 'self', nextSlot, threadId));
    placed.push(await placeHold(booking.peer, 'peer', nextSlot, threadId));
    return { failed: false, holds: placed, released };
  } catch (err) {
    const compensated = await releaseHolds(booking, placed);
    return {
      failed: true,
      holds: placed,
      released: [...released, ...compensated],
      error: errorMessage(err),
    };
  }
}

async function placeHold(
  side: NegotiationBookingSide,
  key: BookingSideKey,
  slot: string,
  threadId: string,
): Promise<NegotiationHold> {
  const idempotencyId = `${threadId}:${side.assistant}:${slot}:hold`;
  const eventArgs = buildHoldEventArgs(side, slot, threadId, idempotencyId);
  const plan: RunSkillImpl = async () => ({
    ok: true,
    reply: 'Preparing a tentative calendar hold.',
    actions: [{ kind: 'use-integration', tool: 'calendar.createEvent', args: eventArgs }],
  });

  // Owner-only invariant: this side calls calendar.createEvent only through
  // its own owner-bound runtime and its own owner-local calendar runner.
  const proposed = payloadOf(
    await runAssistant(ownerTask(`Hold ${slot}`, taskId(side, key, threadId, 'hold'), side.ownerId), undefined, { ownerId: side.ownerId }, {
      ...sideRunOpts(side),
      runSkillImpl: plan,
      writeIdempotencyId: idempotencyId,
    }),
  );

  let written = proposed;
  if (typeof proposed.confirmToken === 'string') {
    written = payloadOf(
      await runAssistant(
        ownerTask(`Confirm ${proposed.confirmToken}`, taskId(side, key, threadId, 'confirm-hold'), side.ownerId),
        undefined,
        { ownerId: side.ownerId },
        sideRunOpts(side),
      ),
    );
  }

  if (written.ok !== true) {
    throw new Error(`hold failed for ${side.assistant}: ${JSON.stringify(written)}`);
  }
  return {
    side: key,
    assistant: side.assistant,
    ownerId: side.ownerId,
    slot,
    threadId,
    idempotencyId,
    eventId: eventIdOf(written.result),
    status: 'tentative',
    result: written.result,
  };
}

async function confirmHolds(
  booking: NegotiationBooking | undefined,
  holds: NegotiationHold[],
  slot: string,
): Promise<HoldStep> {
  if (!booking) return { failed: false, holds, released: [] };
  try {
    for (const hold of holds) {
      const side = sideFor(booking, hold.side);
      await side.confirmHold?.(hold);
      hold.status = 'busy';
    }
    return { failed: false, holds, released: [] };
  } catch (err) {
    const released = await releaseHolds(booking, holds);
    return { failed: true, holds, released, error: `confirm ${slot} failed: ${errorMessage(err)}` };
  }
}

async function releaseHolds(
  booking: NegotiationBooking | undefined,
  holds: NegotiationHold[],
): Promise<NegotiationHold[]> {
  if (!booking || holds.length === 0) return [];
  const released: NegotiationHold[] = [];
  for (const hold of holds) {
    if (hold.status === 'released') continue;
    const side = sideFor(booking, hold.side);
    // Owner-only invariant: release/delete is invoked only on the calendar
    // runner for the same side that created this owner's hold.
    await side.runIntegration(
      'calendar.deleteEvent',
      {
        eventId: hold.eventId,
        idempotencyId: `${hold.idempotencyId}:release`,
        ownerId: side.ownerId,
        targetOwnerId: side.ownerId,
        threadId: hold.threadId,
        slot: hold.slot,
      },
      { offline: side.offline ?? true },
    );
    hold.status = 'released';
    released.push(hold);
  }
  return released;
}

function bookingFailedResult(
  hops: number,
  threadId: string,
  transcript: NegotiationTurn[],
  slot: string,
  step: Extract<HoldStep, { failed: true }>,
): NegotiationResult {
  return {
    converged: false,
    slot,
    hops,
    threadId,
    transcript,
    reason: 'booking-failed',
    booking: { outcome: 'booking-failed', slot, holds: step.holds, released: step.released, error: step.error },
  };
}

function buildHoldEventArgs(
  side: NegotiationBookingSide,
  slot: string,
  threadId: string,
  idempotencyId: string,
): Record<string, unknown> {
  const duration = side.event?.durationMinutes ?? 30;
  return {
    query: `${side.event?.summary ?? 'A2A meeting hold'} at ${slot}`,
    summary: side.event?.summary ?? 'A2A meeting hold',
    description: side.event?.description ?? `Tentative hold for A2A negotiation ${threadId}`,
    start: slot,
    end: endForSlot(slot, duration),
    attendees: side.event?.attendees ?? [],
    status: 'tentative',
    threadId,
    idempotencyId,
    ownerId: side.ownerId,
    targetOwnerId: side.ownerId,
  };
}

function sideRunOpts(side: NegotiationBookingSide): RunAssistantOpts {
  return {
    selfHandle: side.assistant,
    runIntegration: side.runIntegration,
    bookingPolicy: side.bookingPolicy,
    bookingAuditBaseDir: side.bookingAuditBaseDir,
    offline: side.offline ?? true,
  };
}

function ownerTask(text: string, taskId: string, ownerId: string): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

function payloadOf(result: HandlerResult): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  if (!artifact) throw new Error(`assistant returned no artifact: ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  if (!isRecord(parsed)) throw new Error(`assistant returned non-object payload: ${JSON.stringify(parsed)}`);
  return parsed;
}

function eventIdOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const event = result.event;
  if (isRecord(event) && typeof event.id === 'string') return event.id;
  if (typeof result.id === 'string') return result.id;
  return undefined;
}

function endForSlot(slot: string, durationMinutes: number): string {
  const start = new Date(slot);
  if (Number.isNaN(start.getTime())) return slot;
  return new Date(start.getTime() + durationMinutes * 60_000).toISOString();
}

function sideFor(booking: NegotiationBooking, side: BookingSideKey): NegotiationBookingSide {
  return side === 'self' ? booking.self : booking.peer;
}

function taskId(side: NegotiationBookingSide, key: BookingSideKey, threadId: string, phase: string): string {
  return `${side.taskIdPrefix ?? key}-${phase}-${threadId}`.slice(0, 120);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
