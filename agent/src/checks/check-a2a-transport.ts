/**
 * Phase T4.3 offline gate - live A2A transport wiring.
 *
 * Proves, with no key and no network, that the live sender has the same
 * offline stub behavior, the runtime still records the outbound hop, the
 * live wire payload contains only A2A contract fields, and an unrostered
 * private peer is refused before any send.
 *
 *   npm run check:a2a-transport
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { buildA2ARequest, type A2ARequest } from '../a2a/a2a.ts';
import { makeLiveSendA2A } from '../a2a/a2a-transport.ts';
import { readHops } from '../a2a/a2a-audit.ts';
import { invitePeer } from '../assistant/assistant-roster.ts';
import { runAssistant, type RunSkillImpl } from '../assistant/assistant-runtime.ts';
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
  assert(isRecord(parsed), `expected object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function ownerTask(text = "Ask Bob's assistant when he's free Thursday."): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId: 'a2a-transport-check',
    ownerId: 'alice-oid',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

const peerPlan: RunSkillImpl = async () => ({
  ok: true,
  reply: "I'll ask the peer.",
  actions: [{ kind: 'call-peer', assistant: 'pa_bob', intent: 'free-busy' }],
});

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-a2a-transport-'));
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

  const sent = payloadOf(
    await runAssistant(ownerTask(), undefined, { ownerId: 'alice-oid' }, {
      selfHandle: 'pa_alice',
      rosterBaseDir: baseDir,
      budgetBaseDir: baseDir,
      auditBaseDir: baseDir,
      sendA2A: makeLiveSendA2A(),
      runSkillImpl: peerPlan,
    }),
  );
  assert(sent.ok === true && isRecord(sent.peer), `offline sender must succeed, got ${JSON.stringify(sent)}`);
  assert(sent.peer.offline === true && sent.peer.a2a === true, `offline sender must return stub-shaped A2A response, got ${JSON.stringify(sent.peer)}`);
  const hops = await readHops({ baseDir });
  assert(hops.length === 1 && hops[0].to === 'pa_bob' && hops[0].outcome === 'sent', `runtime must record outbound hop, got ${JSON.stringify(hops)}`);
  console.log('▸ offline sender: live transport stubs cleanly and runtime records outbound hop ✓');

  let freeBusyCalls = 0;
  let repairedA2A: { handle: string; intent: string } | undefined;
  let repairedA2AAttempts = 0;
  const badMutualPlanner: RunSkillImpl = async () => ({
    ok: true,
    reply: 'Let me check your calendar.',
    actions: [{ kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Coordinate with Bob to find a time we are both free tomorrow afternoon for a 30 minute meeting.' } }],
  });
  const repaired = payloadOf(
    await runAssistant(
      ownerTask('Coordinate with Bob to find a time we are both free tomorrow afternoon for a 30 minute meeting.'),
      undefined,
      { ownerId: 'alice-oid' },
      {
        selfHandle: 'pa_alice',
        rosterBaseDir: baseDir,
        budgetBaseDir: baseDir,
        auditBaseDir: baseDir,
        runSkillImpl: badMutualPlanner,
        runIntegration: async (tool) => {
          if (tool === 'calendar.freeBusy') freeBusyCalls += 1;
          return { ok: true, tool, freeBusy: [], window: { timeMin: '2026-07-02T12:00:00', timeMax: '2026-07-02T17:00:00' } };
        },
        sendA2A: async (handle, request) => {
          repairedA2AAttempts += 1;
          repairedA2A = { handle, intent: request.intent };
          if (repairedA2AAttempts === 1) {
            return { ok: true, a2a: true, offline: false, to: handle, intent: request.intent, artifacts: [] };
          }
          return {
            ok: true,
            a2a: true,
            offline: true,
            to: handle,
            intent: request.intent,
            reply: 'I checked my calendar and I look free for tomorrow afternoon.',
            result: {
              ok: true,
              tool: 'calendar.freeBusy',
              freeBusy: [],
              window: { timeMin: '2026-07-02T12:00:00', timeMax: '2026-07-02T17:00:00' },
            },
          };
        },
        offline: false,
      },
    ),
  );
  assert(freeBusyCalls === 1, `mutual availability repair must still check owner calendar once, got ${freeBusyCalls}`);
  assert(repairedA2AAttempts === 2, `live A2A must retry once when the first response has no artifact, got ${repairedA2AAttempts}`);
  assert(repairedA2A?.handle === 'pa_bob', `mutual availability repair must call Bob's peer assistant, got ${JSON.stringify(repairedA2A)}`);
  assert(/My calendar result:/u.test(repairedA2A.intent), `peer intent must carry threaded owner availability, got ${repairedA2A.intent}`);
  assert(repaired.multiStep === true && Array.isArray(repaired.actions) && repaired.actions.length === 2, `repaired plan must execute as 2-step plan, got ${JSON.stringify(repaired)}`);
  assert(
    typeof repaired.reply === 'string' && /Suggested slot:/u.test(repaired.reply),
    `mutual availability reply must include a suggested slot, got ${JSON.stringify(repaired)}`,
  );
  assert(
    isRecord(repaired.suggestedBooking) && repaired.suggestedBooking.start === '2026-07-02T12:00:00' && repaired.suggestedBooking.end === '2026-07-02T12:30:00',
    `mutual availability must carry a booking chip payload for the first 30-minute slot, got ${JSON.stringify(repaired.suggestedBooking)}`,
  );
  console.log('▸ planner repair: "coordinate with Bob / both free" cannot stop at local freeBusy ✓');

  // Robust to PHRASING + slot-fills the under-specified case. The TERSE "find a
  // time for me and Bob to meet" (no "coordinate", no duration, no window)
  // must still trip the SAME repair — the shared detector is intent-shaped —
  // and the runtime must default the duration to 30 minutes rather than
  // dropping to a request for the raw ingredients.
  let terseFreeBusyCalls = 0;
  let terseA2A: { handle: string; intent: string } | undefined;
  let terseA2AAttempts = 0;
  const terseRepaired = payloadOf(
    await runAssistant(
      ownerTask('Find a time for me and Bob to meet.'),
      undefined,
      { ownerId: 'alice-oid' },
      {
        selfHandle: 'pa_alice',
        rosterBaseDir: baseDir,
        budgetBaseDir: baseDir,
        auditBaseDir: baseDir,
        runSkillImpl: async () => ({
          ok: true,
          reply: 'Let me check your calendar.',
          actions: [{ kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Find a time for me and Bob to meet.' } }],
        }),
        runIntegration: async (tool) => {
          if (tool === 'calendar.freeBusy') terseFreeBusyCalls += 1;
          return { ok: true, tool, freeBusy: [], window: { timeMin: '2026-07-02T12:00:00', timeMax: '2026-07-02T17:00:00' } };
        },
        sendA2A: async (handle, request) => {
          terseA2AAttempts += 1;
          terseA2A = { handle, intent: request.intent };
          if (terseA2AAttempts === 1) {
            return { ok: true, a2a: true, offline: false, to: handle, intent: request.intent, artifacts: [] };
          }
          return {
            ok: true,
            a2a: true,
            offline: true,
            to: handle,
            intent: request.intent,
            reply: 'I checked my calendar and I look free for tomorrow afternoon.',
            result: { ok: true, tool: 'calendar.freeBusy', freeBusy: [], window: { timeMin: '2026-07-02T12:00:00', timeMax: '2026-07-02T17:00:00' } },
          };
        },
        offline: false,
      },
    ),
  );
  assert(terseFreeBusyCalls === 1, `terse phrasing repair must still check owner calendar once, got ${terseFreeBusyCalls}`);
  assert(terseA2A?.handle === 'pa_bob', `terse phrasing must resolve "me and Bob" to Bob's peer assistant, got ${JSON.stringify(terseA2A)}`);
  assert(terseRepaired.multiStep === true && Array.isArray(terseRepaired.actions) && terseRepaired.actions.length === 2, `terse phrasing must execute as a repaired 2-step plan, got ${JSON.stringify(terseRepaired)}`);
  assert(
    isRecord(terseRepaired.suggestedBooking) &&
      terseRepaired.suggestedBooking.start === '2026-07-02T12:00:00' &&
      terseRepaired.suggestedBooking.end === '2026-07-02T12:30:00' &&
      terseRepaired.suggestedBooking.durationMinutes === 30,
    `under-specified terse request must slot-fill a 30-minute suggested slot, got ${JSON.stringify(terseRepaired.suggestedBooking)}`,
  );
  console.log('▸ phrasing + slot-fill: terse "find a time for me and Bob to meet" repairs and defaults to a 30-minute slot ✓');

  let fallbackFreeBusyCalls = 0;
  let fallbackSendAttempts = 0;
  let localFallbackCalls = 0;
  const localFallback = payloadOf(
    await runAssistant(
      ownerTask('Coordinate with Bob to find a time we are both free tomorrow afternoon for a 30 minute meeting.'),
      undefined,
      { ownerId: 'alice-oid' },
      {
        selfHandle: 'pa_alice',
        rosterBaseDir: baseDir,
        budgetBaseDir: baseDir,
        auditBaseDir: baseDir,
        runSkillImpl: badMutualPlanner,
        runIntegration: async (tool) => {
          if (tool === 'calendar.freeBusy') fallbackFreeBusyCalls += 1;
          return { ok: true, tool, freeBusy: [], window: { timeMin: '2026-07-02T12:00:00', timeMax: '2026-07-02T17:00:00' } };
        },
        sendA2A: async (handle, request) => {
          fallbackSendAttempts += 1;
          return { ok: true, a2a: true, offline: false, to: handle, intent: request.intent, artifacts: [] };
        },
        localA2A: async (peer, request, opts) => {
          localFallbackCalls += 1;
          assert(peer.agentName === 'pa_bob', `local fallback must target Bob, got ${peer.agentName}`);
          assert(opts.callerOwnerId === 'alice-oid', `local fallback must carry caller ownerId, got ${opts.callerOwnerId}`);
          assert(/My calendar result:/u.test(request.intent), `local fallback request must carry threaded owner availability, got ${request.intent}`);
          return {
            ok: true,
            a2a: true,
            offline: false,
            to: peer.agentName,
            intent: request.intent,
            reply: 'I checked my calendar and I look free for tomorrow afternoon.',
            result: {
              ok: true,
              tool: 'calendar.freeBusy',
              freeBusy: [],
              window: { timeMin: '2026-07-02T12:00:00', timeMax: '2026-07-02T17:00:00' },
            },
          };
        },
        offline: false,
      },
    ),
  );
  assert(fallbackFreeBusyCalls === 1, `local fallback path must still check owner calendar once, got ${fallbackFreeBusyCalls}`);
  assert(fallbackSendAttempts === 2, `local fallback path must retry live A2A once before fallback, got ${fallbackSendAttempts}`);
  assert(localFallbackCalls === 1, `local fallback must run exactly once, got ${localFallbackCalls}`);
  assert(
    typeof localFallback.reply === 'string' && /Suggested slot:/u.test(localFallback.reply),
    `local fallback path must synthesize mutual availability, got ${JSON.stringify(localFallback)}`,
  );
  assert(
    isRecord(localFallback.suggestedBooking) && localFallback.suggestedBooking.start === '2026-07-02T12:00:00' && localFallback.suggestedBooking.end === '2026-07-02T12:30:00',
    `local fallback path must carry a booking chip payload, got ${JSON.stringify(localFallback.suggestedBooking)}`,
  );
  console.log('▸ same-bridge fallback: empty live A2A artifacts still produce mutual availability ✓');

  let captured: A2ARequest | undefined;
  const sender = makeLiveSendA2A({
    directCall: async (_handle, payload) => {
      captured = payload;
      return { ok: true, peer: 'answered' };
    },
  });
  const leaky = {
    ...buildA2ARequest({ from: 'pa_alice', intent: 'free-busy', threadId: 'thread-live', hop: 2, window: '2026-07-01/2026-07-02' }),
    confirmToken: 'confirm_deadbeefdeadbeef',
    ownerContext: { meetingTitles: ['secret'] },
    targetOwnerId: 'bob-oid',
  } as A2ARequest & Record<string, unknown>;
  const liveResponse = await sender('pa_bob', leaky, { offline: false });
  assert(isRecord(liveResponse) && liveResponse.offline === false, `fake live sender must surface live response, got ${JSON.stringify(liveResponse)}`);
  assert(captured, 'fake live directCall must receive a payload');
  const keys = Object.keys(captured).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(['a2a', 'from', 'hop', 'intent', 'threadId', 'window']),
    `live A2A payload must contain only contract fields, got ${JSON.stringify(captured)}`,
  );
  assert(!('confirmToken' in captured) && !('ownerContext' in captured) && !('targetOwnerId' in captured), 'live A2A payload must not leak tokens or owner context');
  console.log('▸ live payload: strict A2A allow-list, no token/owner-context leak ✓');

  let attempted = 0;
  const missingPeerPlan: RunSkillImpl = async () => ({
    ok: true,
    reply: "I'll ask Carol.",
    actions: [{ kind: 'call-peer', assistant: 'pa_carol', intent: 'free-busy' }],
  });
  const refused = payloadOf(
    await runAssistant(ownerTask("Ask Carol's assistant."), undefined, { ownerId: 'alice-oid' }, {
      selfHandle: 'pa_alice',
      rosterBaseDir: baseDir,
      budgetBaseDir: baseDir,
      auditBaseDir: baseDir,
      runSkillImpl: missingPeerPlan,
      sendA2A: async () => {
        attempted += 1;
        return { ok: true };
      },
    }),
  );
  assert(refused.ok === true && typeof refused.note === 'string' && attempted === 0, `missing roster peer must be refused before send, got ${JSON.stringify({ refused, attempted })}`);
  console.log('▸ roster gate: missing private peer refused before any send ✓');

  console.log('\naudit: live A2A transport is gated, direct-handle, scoped, and offline-testable');
  console.log('✅ a2a-transport check passed');
} catch (err) {
  console.error(`❌ a2a-transport check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
