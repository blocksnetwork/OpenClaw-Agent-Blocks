/**
 * Phase PA-5 offline gate — the per-assistant dashboard overview.
 *
 * Asserts, with no key and no network (temp roster + budget + audit dirs),
 * that `assistantOverview()` JOINS the existing sources into one panel per
 * assistant — owner, peers, today's A2A spend, and the A2A-hop audit —
 * reusing the dashboard's served-handle map (no duplicated state):
 *   1. one panel per assistant on disk; a served assistant is marked live
 *      with an instanceId + uptime, an unserved one is not.
 *   2. owner + peers come straight from the invite roster.
 *   3. driving a real OUTBOUND + INBOUND A2A hop shows up in spendToday
 *      and the hop audit (newest first), and the daily count reflects it.
 *
 *   npm run check:pa-dashboard
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { invitePeer } from '../assistant/assistant-roster.ts';
import { buildA2ARequest } from '../a2a/a2a.ts';
import { runAssistant, type RunAssistantOpts } from '../assistant/assistant-runtime.ts';
import { assistantOverview } from '../assistant/assistant-dashboard.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
process.env.PA_A2A_DAILY_CALLS_CAP = '5';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-dash-'));
  // Mirror the production layout: rosters live under their own dir,
  // budget + audit live one level up (agent/data/ in production).
  const rosterDir = join(baseDir, 'assistants');

  // Two assistants, mutually invited; Bob shares free/busy with Alice.
  await invitePeer({
    owner: 'alice@acme',
    agentName: 'pa_alice',
    ownerId: 'alice-oid',
    peerOwner: 'bob@acme',
    peerAgentName: 'pa_bob',
    peerOwnerId: 'bob-oid',
    sharePolicy: { freeBusy: true, meetingTitles: false },
    baseDir: rosterDir,
  });

  const dirs = { rosterBaseDir: rosterDir, budgetBaseDir: baseDir, auditBaseDir: baseDir };

  // Drive one OUTBOUND hop (Alice asks Bob) → budget + 'out' audit hop.
  const aliceOpts: RunAssistantOpts = { selfHandle: 'pa_alice', ...dirs };
  await runAssistant(
    {
      type: 'StartTask',
      taskId: 'dash-out',
      ownerId: 'alice-oid',
      requestParts: [{ partId: 'request', text: "Ask Bob's assistant when he's free Thursday.", contentType: 'text/plain' }],
    } as StartTaskMessage,
    undefined,
    { ownerId: 'alice-oid' },
    aliceOpts,
  );

  // Drive one INBOUND hop (Bob answers Alice) → 'in' audit hop.
  const bobOpts: RunAssistantOpts = {
    selfHandle: 'pa_bob',
    ...dirs,
    ownerContext: { freeBusy: ['Thu 9–10 busy'], meetingTitles: ['Board: Project Zephyr'] },
  };
  await runAssistant(
    {
      type: 'StartTask',
      taskId: 'dash-in',
      ownerId: 'alice-oid',
      requestParts: [
        {
          partId: 'request',
          text: JSON.stringify(buildA2ARequest({ from: 'pa_alice', intent: 'free-busy' })),
          contentType: 'application/json',
        },
      ],
    } as StartTaskMessage,
    undefined,
    {},
    bobOpts,
  );

  // Build the overview, feeding a served-handle map (Alice is live).
  const startedAt = Date.now() - 1234;
  const overview = await assistantOverview({
    served: [{ agentName: 'pa_alice', instanceId: 'inst-alice-1', startedAt }],
    ...dirs,
  });

  // 1. one panel per assistant; live/instance/uptime from the served map.
  assert(overview.assistants.length === 2, `expected 2 panels, got ${overview.assistants.length}`);
  const alice = overview.assistants.find((a) => a.agentName === 'pa_alice');
  const bob = overview.assistants.find((a) => a.agentName === 'pa_bob');
  assert(alice && bob, 'both pa_alice and pa_bob must have a panel');
  assert(alice.live === true && alice.instanceId === 'inst-alice-1', 'pa_alice must be marked live with its instanceId');
  assert(typeof alice.uptimeMs === 'number' && alice.uptimeMs >= 1234, 'pa_alice must report uptime from the served map');
  assert(bob.live === false && bob.instanceId === undefined, 'pa_bob (not served) must be marked not live');
  console.log('▸ panels: one per assistant; served-map join → live/instance/uptime ✓');

  // 2. owner + peers from the roster.
  assert(alice.owner === 'alice@acme', `pa_alice owner must come from the roster, got ${alice.owner}`);
  assert(alice.peerCount === 1 && alice.peers[0]?.agentName === 'pa_bob', 'pa_alice must list pa_bob as a peer');
  assert(alice.peers[0]?.sharePolicy.freeBusy === true, "pa_alice's roster carries the offered share policy (freeBusy)");
  assert(bob.peers[0]?.sharePolicy.freeBusy === false, "pa_bob's side defaults to sharing nothing until opted in");
  console.log('▸ roster join: owner + peers + share policy surfaced ✓');

  // 3. spend + A2A-hop audit reflect the driven hops.
  assert(overview.dailyCap === 5, `dailyCap must read PA_A2A_DAILY_CALLS_CAP, got ${overview.dailyCap}`);
  assert(overview.a2aCallsToday === 1, `expected 1 outbound A2A call today, got ${overview.a2aCallsToday}`);
  assert(alice.spendToday.a2aCalls === 1, `pa_alice spendToday must be 1, got ${alice.spendToday.a2aCalls}`);
  assert(alice.spendToday.dailyCap === 5, 'spendToday must carry the daily cap');

  const out = alice.hops.find((h) => h.direction === 'out' && h.from === 'pa_alice' && h.to === 'pa_bob');
  const inbound = bob.hops.find((h) => h.direction === 'in' && h.from === 'pa_alice' && h.to === 'pa_bob');
  assert(out, `pa_alice audit must contain the OUTBOUND hop, got ${JSON.stringify(alice.hops)}`);
  assert(out.outcome === 'sent', 'outbound hop outcome must be "sent"');
  assert(inbound, `pa_bob audit must contain the INBOUND hop, got ${JSON.stringify(bob.hops)}`);
  assert(inbound.outcome === 'answered', 'inbound hop outcome must be "answered"');
  // Newest-first ordering.
  assert(bob.hops[0]?.at >= bob.hops[bob.hops.length - 1]?.at, 'hops must be newest-first');
  console.log(`▸ audit: spendToday=${alice.spendToday.a2aCalls}/${overview.dailyCap}; out→sent + in→answered hops recorded ✓`);

  console.log('\naudit: roster + budget + audit joined with the served map into per-assistant panels — all offline');
  console.log('✅ pa-dashboard check passed');
} catch (err) {
  console.error(`❌ pa-dashboard check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
