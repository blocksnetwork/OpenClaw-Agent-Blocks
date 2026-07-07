/**
 * Phase PA-4 offline gate — assistant-to-assistant (A2A) request/response.
 *
 * Asserts, with no key and no network (temp roster + temp budget dirs):
 *   1. authorizeInvited admits a roster peer, refuses a stranger (and an
 *      ownerId mismatch on a recorded peer).
 *   2. share-policy redaction — with sharePolicy { freeBusy:true,
 *      meetingTitles:false }, the slice handed to the brain contains
 *      freeBusy and DROPS meetingTitles (the brain can't leak what it
 *      never saw).
 *   3. loop guard — from == self is refused (a2a-loop-refused).
 *   4. hop cap — hop > MAX_A2A_HOPS is refused (a2a-hop-cap).
 *   5. daily cap — the (cap+1)-th OUTBOUND call is refused (a2a-daily-cap).
 *
 *   npm run check:a2a
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { authorizeInvited } from '../server/authorize.ts';
import { invitePeer, loadRoster } from '../assistant/assistant-roster.ts';
import { applySharePolicy, buildA2ARequest, MAX_A2A_HOPS } from '../a2a/a2a.ts';
import { runAssistant, type RunAssistantOpts } from '../assistant/assistant-runtime.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
// A small cap so the runaway-loop assertion is cheap and deterministic.
process.env.PA_A2A_DAILY_CALLS_CAP = '3';

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

/** An inbound A2A task carrying the typed contract on the request part. */
function a2aTask(args: { from: string; intent: string; hop?: number; ownerId: string }): StartTaskMessage {
  const request = buildA2ARequest({ from: args.from, intent: args.intent, hop: args.hop });
  return {
    type: 'StartTask',
    taskId: 'a2a-check',
    ownerId: args.ownerId,
    requestParts: [{ partId: 'request', text: JSON.stringify(request), contentType: 'application/json' }],
  } as StartTaskMessage;
}

/** An owner-request task (plain text) that drives the OUTBOUND path. */
function ownerTask(text: string): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId: 'a2a-owner-check',
    ownerId: 'alice-oid',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-a2a-'));

  // Mutual invite: Bob shares free/busy (NOT titles) with Alice; both
  // sides record the other's ownerId for the defense-in-depth gate.
  await invitePeer({
    owner: 'bob@acme',
    agentName: 'pa_bob',
    ownerId: 'bob-oid',
    peerOwner: 'alice@acme',
    peerAgentName: 'pa_alice',
    peerOwnerId: 'alice-oid',
    sharePolicy: { freeBusy: true, meetingTitles: false },
    baseDir,
  });

  const bobRoster = await loadRoster('pa_bob', { baseDir });

  // 1. authorizeInvited — roster peer admitted; stranger + mismatch refused.
  assert(authorizeInvited({ ownerId: 'alice-oid' }, 'pa_alice', bobRoster).ok, 'invited peer must be admitted');
  assert(!authorizeInvited({ ownerId: 'x' }, 'pa_stranger', bobRoster).ok, 'a stranger must be refused (fail closed)');
  assert(
    !authorizeInvited({ ownerId: 'mallory' }, 'pa_alice', bobRoster).ok,
    'a recorded peer with a mismatched ownerId must be refused',
  );
  console.log('▸ authorize: invited peer admitted; stranger + ownerId mismatch refused ✓');

  // 1b. applySharePolicy unit — redaction is allow-list, per field.
  const sliceUnit = applySharePolicy(
    { freeBusy: ['Thu 9–10 busy'], meetingTitles: ['Board: Project Zephyr'] },
    { freeBusy: true, meetingTitles: false },
  );
  assert('freeBusy' in sliceUnit, 'applySharePolicy must keep an opted-in field');
  assert(!('meetingTitles' in sliceUnit), 'applySharePolicy must drop an opted-out field');

  // Bob's assistant answers Alice; its shareable context HAS titles, but
  // the share policy must strip them before the brain ever sees them.
  const bobOpts: RunAssistantOpts = {
    selfHandle: 'pa_bob',
    rosterBaseDir: baseDir,
    budgetBaseDir: baseDir,
    auditBaseDir: baseDir,
    ownerContext: { freeBusy: ['Thu 9–10 busy'], meetingTitles: ['Board: Project Zephyr'] },
    runIntegration: async (tool, args) => {
      assert(tool === 'calendar.freeBusy', `inbound A2A availability must use calendar.freeBusy, got ${tool}`);
      assert(isRecord(args) && typeof args.query === 'string', `freeBusy must receive the peer intent as query, got ${JSON.stringify(args)}`);
      return {
        ok: true,
        tool,
        freeBusy: [],
        window: { timeMin: '2026-07-02T13:00:00', timeMax: '2026-07-02T17:00:00' },
      };
    },
  };

  // 2. share-policy redaction (integration).
  const answered = payloadOf(
    await runAssistant(a2aTask({ from: 'pa_alice', intent: 'free-busy', ownerId: 'alice-oid' }), undefined, {}, bobOpts),
  );
  assert(answered.ok === true, `inbound A2A must succeed, got ${JSON.stringify(answered)}`);
  assert(isRecord(answered.shared), `inbound A2A must surface the shared slice, got ${JSON.stringify(answered)}`);
  assert('freeBusy' in answered.shared, 'shared slice must include freeBusy (opted in)');
  assert(!('meetingTitles' in answered.shared), 'shared slice must REDACT meetingTitles (opted out)');
  assert(
    typeof answered.reply === 'string' && /I checked my calendar and I look free/u.test(answered.reply),
    `inbound A2A availability must return Bob's calendar answer, got ${JSON.stringify(answered)}`,
  );
  console.log('▸ inbound availability: freeBusy shared, titles redacted, Bob calendar read returned ✓');

  // 3. loop guard — from == self.
  const loop = payloadOf(
    await runAssistant(a2aTask({ from: 'pa_bob', intent: 'free-busy', ownerId: 'bob-oid' }), undefined, {}, bobOpts),
  );
  assert(loop.ok === false && loop.error === 'a2a-loop-refused', `from==self must be refused, got ${JSON.stringify(loop)}`);
  console.log('▸ loop guard: from == self refused (a2a-loop-refused) ✓');

  // 4. hop cap — hop > MAX_A2A_HOPS.
  const overHop = payloadOf(
    await runAssistant(
      a2aTask({ from: 'pa_alice', intent: 'free-busy', hop: MAX_A2A_HOPS + 1, ownerId: 'alice-oid' }),
      undefined,
      {},
      bobOpts,
    ),
  );
  assert(overHop.ok === false && overHop.error === 'a2a-hop-cap', `hop > cap must be refused, got ${JSON.stringify(overHop)}`);
  console.log(`▸ hop cap: hop ${MAX_A2A_HOPS + 1} > ${MAX_A2A_HOPS} refused (a2a-hop-cap) ✓`);

  // 5. daily cap — Alice's assistant makes cap+1 OUTBOUND calls; the last
  //    is refused. (Owner asks "ask Bob's assistant…" → brain → call-peer.)
  const aliceOpts: RunAssistantOpts = {
    selfHandle: 'pa_alice',
    rosterBaseDir: baseDir,
    budgetBaseDir: baseDir,
    auditBaseDir: baseDir,
  };
  const cap = Number(process.env.PA_A2A_DAILY_CALLS_CAP);
  for (let i = 1; i <= cap; i += 1) {
    const sent = payloadOf(
      await runAssistant(ownerTask("Ask Bob's assistant when he's free Thursday."), undefined, { ownerId: 'alice-oid' }, aliceOpts),
    );
    assert(
      sent.ok === true && isRecord(sent.a2a),
      `outbound call ${i}/${cap} should succeed, got ${JSON.stringify(sent)}`,
    );
  }
  const capped = payloadOf(
    await runAssistant(ownerTask("Ask Bob's assistant when he's free Thursday."), undefined, { ownerId: 'alice-oid' }, aliceOpts),
  );
  assert(
    capped.ok === false && capped.error === 'a2a-daily-cap',
    `the (cap+1)-th outbound call must be refused, got ${JSON.stringify(capped)}`,
  );
  console.log(`▸ daily cap: ${cap} calls allowed, call ${cap + 1} refused (a2a-daily-cap) ✓`);

  console.log(
    `\naudit: authorize(roster=allowlist) + redaction(freeBusy kept, titles dropped) + loop/hop/daily guards — all offline`,
  );
  console.log('✅ a2a check passed');
} catch (err) {
  console.error(`❌ a2a check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
