/**
 * Working-hours enforcement offline gate.
 *
 * Proves, with no key and no network, that the owner's working hours (in the
 * owner's timezone) are a HARD constraint on booked/suggested times — enforced
 * at slot selection, at the read-window default, and at the write guard — while
 * an explicit time the owner asked for is still honored:
 *
 *   1. slot picker: never returns a slot outside working hours (picks the
 *      in-hours gap; returns none when only out-of-hours gaps exist).
 *   2. timezone correctness: a non-UTC owner gets an in-hours slot in THEIR
 *      local time (guards against the old getUTCHours clamp bug).
 *   3. resolveWindow: an unspecified "tomorrow" defaults to working hours
 *      (not the full day) and "evening" is capped at the working-hours end,
 *      while an explicit "8pm to 9pm" is honored verbatim.
 *   4. write guard: an out-of-hours booking from a bad extraction is refused,
 *      but an explicit out-of-hours time the owner asked for passes; the
 *      default applies with no profile and a per-owner override is honored.
 *   5. end-to-end: the mutual-availability suggestion lands in working hours
 *      (owner timezone) and produces no suggestion when only 9pm is free.
 *
 *   npm run check:pa-working-hours
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { invitePeer } from '../assistant/assistant-roster.ts';
import {
  pickWorkingHoursSlot,
  runAssistant,
  type OwnerProfile,
  type RunAssistantOpts,
  type RunIntegration,
  type RunSkillImpl,
} from '../assistant/assistant-runtime.ts';
import { resolveWindow } from '../integrations/calendar-mcp.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

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
  assert(isRecord(parsed), `expected an object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function ownerTask(text: string, taskId: string, ownerId = 'alice-oid'): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

/** Local wall-clock instant (naive-mode fixtures). */
function localMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const ms = (iso: string) => new Date(iso).getTime();

/** The owner-local hour of an absolute instant, per Intl. */
function localHourIn(msValue: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit' }).formatToParts(new Date(msValue));
  let hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  if (hour === 24) hour = 0;
  return hour;
}

let baseDir: string | undefined;

try {
  // ── 1. slot picker never leaves working hours (local/naive frame) ────────
  const workday = { start: '09:00', end: '17:00' };
  const fullDayStart = localMs(2026, 7, 6, 0, 0);
  const fullDayEnd = localMs(2026, 7, 7, 0, 0);
  const thirtyMin = 30 * 60_000;

  const emptyGap = pickWorkingHoursSlot({
    startMs: fullDayStart,
    endMs: fullDayEnd,
    durationMs: thirtyMin,
    busy: [],
    workingHours: workday,
    timezone: 'UTC',
    sourceIsAbsolute: false,
  });
  assert(emptyGap === localMs(2026, 7, 6, 9, 0), `an empty day must clamp to 09:00 local, not midnight, got ${emptyGap}`);

  const only9pm = pickWorkingHoursSlot({
    startMs: fullDayStart,
    endMs: fullDayEnd,
    durationMs: thirtyMin,
    // Working hours fully busy; free before 09:00 and after 17:00 (incl 9pm).
    busy: [{ start: localMs(2026, 7, 6, 9, 0), end: localMs(2026, 7, 6, 17, 0) }],
    workingHours: workday,
    timezone: 'UTC',
    sourceIsAbsolute: false,
  });
  assert(only9pm === null, `no in-hours gap must return null (never a 9pm/early-morning slot), got ${only9pm}`);

  const inHoursGap = pickWorkingHoursSlot({
    startMs: fullDayStart,
    endMs: fullDayEnd,
    durationMs: thirtyMin,
    // Free 00:00–09:00 and 14:00–14:30 and after 17:00; only 14:00 is in-hours.
    busy: [
      { start: localMs(2026, 7, 6, 9, 0), end: localMs(2026, 7, 6, 14, 0) },
      { start: localMs(2026, 7, 6, 14, 30), end: localMs(2026, 7, 6, 17, 0) },
    ],
    workingHours: workday,
    timezone: 'UTC',
    sourceIsAbsolute: false,
  });
  assert(inHoursGap === localMs(2026, 7, 6, 14, 0), `must pick the in-hours 14:00 gap, not an out-of-hours one, got ${inHoursGap}`);
  console.log('▸ slot picker: clamps to working hours, skips 9pm, returns none when no in-hours gap ✓');

  // ── 2. timezone correctness (absolute frame, non-UTC owner) ──────────────
  // Owner in America/New_York (EDT, UTC-4 in July). Working hours 09:00–17:00
  // NY == 13:00Z–21:00Z. Only NY 15:00 (19:00Z) is free inside hours.
  const nyBusy = [
    { start: ms('2026-07-06T13:00:00Z'), end: ms('2026-07-06T19:00:00Z') }, // NY 09:00–15:00
    { start: ms('2026-07-06T19:30:00Z'), end: ms('2026-07-06T21:00:00Z') }, // NY 15:30–17:00
  ];
  const nyWindow = { startMs: ms('2026-07-06T04:00:00Z'), endMs: ms('2026-07-07T04:00:00Z') }; // NY midnight→midnight
  const nySlot = pickWorkingHoursSlot({
    ...nyWindow,
    durationMs: thirtyMin,
    busy: nyBusy,
    workingHours: workday,
    timezone: 'America/New_York',
    sourceIsAbsolute: true,
  });
  assert(nySlot === ms('2026-07-06T19:00:00Z'), `NY owner must get NY 15:00 (19:00Z), got ${nySlot ? new Date(nySlot).toISOString() : nySlot}`);
  assert(nySlot !== null && localHourIn(nySlot, 'America/New_York') === 15, 'chosen slot must be 15:00 in the owner local time');

  // A naive UTC clamp (the old getUTCHours bug) would instead pick 09:00Z
  // (= NY 05:00, out of NY hours). Proving the two frames differ guards it.
  const utcFrameSlot = pickWorkingHoursSlot({
    ...nyWindow,
    durationMs: thirtyMin,
    busy: nyBusy,
    workingHours: workday,
    timezone: 'UTC',
    sourceIsAbsolute: true,
  });
  assert(utcFrameSlot === ms('2026-07-06T09:00:00Z'), `UTC frame would pick 09:00Z, got ${utcFrameSlot ? new Date(utcFrameSlot).toISOString() : utcFrameSlot}`);
  assert(nySlot !== utcFrameSlot, 'timezone-aware clamp must differ from a naive UTC clamp');
  console.log('▸ timezone: non-UTC owner gets an in-hours slot in THEIR local time (no getUTCHours bug) ✓');

  // ── 3. resolveWindow default + evening cap + explicit honored ────────────
  const now = new Date('2026-07-06T12:00:00Z');
  const bareTomorrow = resolveWindow({ query: 'find me time tomorrow' }, 7, now, { workingHours: workday, timezone: 'UTC' });
  assert(
    bareTomorrow.timeMin === '2026-07-07T09:00:00' && bareTomorrow.timeMax === '2026-07-07T17:00:00',
    `bare "tomorrow" must default to working hours, got ${JSON.stringify(bareTomorrow)}`,
  );

  const bareNoProfile = resolveWindow({ query: 'find me time tomorrow' }, 7, now);
  assert(
    bareNoProfile.timeMin === '2026-07-07T00:00:00' && bareNoProfile.timeMax === '2026-07-07T23:59:59',
    `without working hours "tomorrow" must stay full-day (back-compat), got ${JSON.stringify(bareNoProfile)}`,
  );

  const eveningCap = resolveWindow({ query: 'tomorrow evening' }, 7, now, { workingHours: { start: '09:00', end: '20:00' }, timezone: 'UTC' });
  assert(
    eveningCap.timeMin === '2026-07-07T17:00:00' && eveningCap.timeMax === '2026-07-07T20:00:00',
    `"evening" must be capped at the working-hours end (20:00), got ${JSON.stringify(eveningCap)}`,
  );

  const explicitWindow = resolveWindow({ query: 'tomorrow from 8pm to 9pm' }, 7, now, { workingHours: workday, timezone: 'UTC' });
  assert(
    explicitWindow.timeMin === '2026-07-07T20:00:00' && explicitWindow.timeMax === '2026-07-07T21:00:00',
    `an explicit "8pm to 9pm" must be honored, not clamped, got ${JSON.stringify(explicitWindow)}`,
  );
  console.log('▸ resolveWindow: bare date → working hours, evening capped, explicit time honored ✓');

  // ── 4. write guard (booking-enabled, brain-extraction path) ──────────────
  process.env.PA_READONLY = '1';
  process.env.PA_ALLOW_CALENDAR_BOOKING = '1';

  let writeCalls = 0;
  const stubWrite: RunIntegration = async (tool, args) => {
    writeCalls += 1;
    return { ok: true, tool, event: { id: `evt-${writeCalls}`, summary: args.summary ?? args.query } };
  };

  // A brain planner that plans the createEvent AND, on the extract skill,
  // returns the (possibly out-of-hours) start/end — the "bad extraction" seam.
  function bookingRun(query: string, start: string, end: string, ownerProfile?: OwnerProfile) {
    const planner: RunSkillImpl = async (skill) => {
      if (skill === 'calendar_event_extract') return { ok: true, summary: 'Meeting', start, end };
      return {
        ok: true,
        reply: 'Planned booking.',
        actions: [{ kind: 'use-integration', tool: 'calendar.createEvent', args: { query } }],
      };
    };
    return runAssistant(ownerTask(query, `wh-${Math.random().toString(36).slice(2)}`), undefined, { ownerId: 'alice-oid' }, {
      offline: false,
      runIntegration: stubWrite,
      runSkillImpl: planner,
      ...(ownerProfile ? { ownerProfile } : {}),
    } as RunAssistantOpts);
  }

  writeCalls = 0;
  const rejected = payloadOf(await bookingRun('Book a meeting with Bob tomorrow', '2026-07-07T21:00:00', '2026-07-07T21:30:00'));
  assert(rejected.needsMoreInfo === true, `out-of-hours inferred booking must ask for a legal time, got ${JSON.stringify(rejected)}`);
  assert(typeof rejected.reply === 'string' && /working hours/u.test(rejected.reply), `refusal must explain working hours, got ${JSON.stringify(rejected.reply)}`);
  assert(typeof rejected.confirmToken !== 'string', 'refused booking must not offer a confirm token');
  assert(writeCalls === 0, 'refused out-of-hours booking must not write');

  writeCalls = 0;
  const honored = payloadOf(await bookingRun('Book a meeting with Bob tomorrow at 8pm', '2026-07-07T20:00:00', '2026-07-07T20:30:00'));
  assert(typeof honored.confirmToken === 'string', `an explicit out-of-hours time the owner asked for must be honored, got ${JSON.stringify(honored)}`);
  assert(isRecord(honored.proposal), `honored explicit booking must produce a proposal, got ${JSON.stringify(honored)}`);
  const honoredArgs = (honored.proposal as Record<string, unknown>).args as Record<string, unknown>;
  assert(typeof honoredArgs.start === 'string' && honoredArgs.start.includes('T20:00:00'), `honored booking must keep the 8pm start, got ${JSON.stringify(honoredArgs)}`);
  assert(writeCalls === 0, 'confirm-policy booking must not write before confirmation');
  console.log('▸ write guard: refuses out-of-hours inference, honors an explicit out-of-hours request ✓');

  // Per-owner override: a night-owl owner (08:00–22:00) may book 9pm even
  // from an inferred window; the default (09:00–17:00) still refused it above.
  writeCalls = 0;
  const nightOwl: OwnerProfile = { ownerId: 'alice-oid', workingHours: { start: '08:00', end: '22:00' } };
  const overridden = payloadOf(await bookingRun('Book a meeting with Bob tomorrow', '2026-07-07T21:00:00', '2026-07-07T21:30:00', nightOwl));
  assert(typeof overridden.confirmToken === 'string', `per-owner late working hours must allow a 9pm booking, got ${JSON.stringify(overridden)}`);
  assert(writeCalls === 0, 'override booking must still respect the confirm gate');
  console.log('▸ per-owner: sane default applies with no profile; a per-owner override is honored ✓');

  // ── 5. end-to-end mutual availability lands in working hours ─────────────
  process.env.PA_READONLY = '1';
  delete process.env.PA_ALLOW_CALENDAR_BOOKING;
  baseDir = await mkdtemp(join(tmpdir(), 'pa-working-hours-'));
  await invitePeer({
    owner: 'alice@acme',
    agentName: 'pa_alice',
    ownerId: 'alice-oid',
    peerOwner: 'bob@acme',
    peerAgentName: 'pa_bob',
    peerOwnerId: 'bob-oid',
    sharePolicy: { freeBusy: true, meetingTitles: false },
    baseDir,
  });

  const nyProfile: OwnerProfile = { ownerId: 'alice-oid', timezone: 'America/New_York', workingHours: workday };
  const coordinatePlanner: RunSkillImpl = async () => ({
    ok: true,
    reply: 'Let me check your calendar.',
    actions: [{ kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Coordinate with Bob to find a time we are both free tomorrow for a 30 minute meeting.' } }],
  });

  function mutualRun(ownerBusy: Array<{ start: string; end: string }>) {
    let sendAttempts = 0;
    const ownerResult = {
      ok: true,
      tool: 'calendar.freeBusy',
      freeBusy: ownerBusy,
      window: { timeMin: '2026-07-06T04:00:00Z', timeMax: '2026-07-07T04:00:00Z' },
    };
    return runAssistant(
      ownerTask('Coordinate with Bob to find a time we are both free tomorrow for a 30 minute meeting.', `mutual-${sendAttempts}-${Math.random().toString(36).slice(2)}`),
      undefined,
      { ownerId: 'alice-oid' },
      {
        selfHandle: 'pa_alice',
        rosterBaseDir: baseDir,
        budgetBaseDir: baseDir,
        auditBaseDir: baseDir,
        ownerProfile: nyProfile,
        runSkillImpl: coordinatePlanner,
        runIntegration: async () => ownerResult,
        sendA2A: async (handle, request) => {
          sendAttempts += 1;
          if (sendAttempts === 1) return { ok: true, a2a: true, offline: false, to: handle, intent: request.intent, artifacts: [] };
          return {
            ok: true,
            a2a: true,
            offline: true,
            to: handle,
            intent: request.intent,
            reply: 'I checked my calendar and I look free.',
            // Peer shares an all-free window; the initiator's busy + hours decide.
            result: { ok: true, tool: 'calendar.freeBusy', freeBusy: [], window: { timeMin: '2026-07-06T04:00:00Z', timeMax: '2026-07-07T04:00:00Z' } },
          };
        },
        offline: false,
      },
    );
  }

  // NY 09:00–15:00 busy (13:00Z–19:00Z): the earliest in-hours mutual gap is
  // NY 15:00 (19:00Z), NOT the free early-morning or 9pm.
  const mutualInHours = payloadOf(await mutualRun([{ start: '2026-07-06T13:00:00Z', end: '2026-07-06T19:00:00Z' }]));
  assert(isRecord(mutualInHours.suggestedBooking), `mutual availability must produce a suggestion, got ${JSON.stringify(mutualInHours)}`);
  const suggested = mutualInHours.suggestedBooking as Record<string, unknown>;
  assert(suggested.start === '2026-07-06T19:00:00.000Z', `suggested slot must be NY 15:00 (in-hours), got ${JSON.stringify(suggested.start)}`);
  assert(localHourIn(ms(String(suggested.start)), 'America/New_York') === 15, 'suggested slot must be 15:00 in owner local time');
  console.log('▸ mutual: earliest mutual gap lands inside owner working hours (owner timezone) ✓');

  // Working hours fully busy (13:00Z–21:00Z = NY 09:00–17:00): only 9pm is
  // free — the picker must produce NO suggestion rather than a 9pm slot.
  const mutualNone = payloadOf(await mutualRun([{ start: '2026-07-06T13:00:00Z', end: '2026-07-06T21:00:00Z' }]));
  assert(mutualNone.suggestedBooking === undefined, `no in-hours mutual gap must yield no suggestion, got ${JSON.stringify(mutualNone.suggestedBooking)}`);
  assert(typeof mutualNone.reply === 'string' && !/Suggested slot:/u.test(mutualNone.reply), `reply must not suggest an out-of-hours slot, got ${JSON.stringify(mutualNone.reply)}`);
  console.log('▸ mutual: only-9pm availability yields no suggestion (never books out-of-hours) ✓');

  console.log('\naudit: working hours + timezone are a hard constraint at slot selection, the window default, and the write guard — all offline');
  console.log('✅ pa-working-hours check passed');
} catch (err) {
  console.error(`❌ pa-working-hours check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
