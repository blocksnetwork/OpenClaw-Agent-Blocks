/**
 * Phase PA-6 offline gate — multi-turn A2A slot negotiation (end-state C).
 *
 * Asserts, with no key and no network, that `negotiateSlot()` runs the
 * request/response loop over the PA-4 A2A contract correctly:
 *   1. capstone — "find a slot that works for both of us" CONVERGES on the
 *      earliest mutually-free slot in ≤ N hops.
 *   2. threadId is shared across every turn; hop increments 1..n (the
 *      loop-safety surface threaded through multi-turn A2A).
 *   3. no overlap → terminates early ('no-common-slot'), never loops.
 *   4. a stubborn peer → terminates at the hop cap ('max-hops'); maxHops is
 *      clamped to MAX_A2A_HOPS so a runaway self-terminates.
 *   5. reuse — each turn flows through the PA-5 A2A-hop audit trail.
 *
 *   npm run check:pa-negotiation
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_A2A_HOPS } from '../a2a/a2a.ts';
import { negotiateSlot, type AskPeer } from '../a2a/negotiate.ts';
import { recordHop, readHops } from '../a2a/a2a-audit.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** A cooperative peer: confirms a slot only once the initiator commits to
 *  it (`accept`), otherwise counter-proposes its own free slots. */
function cooperativePeer(peerFree: string[]): AskPeer {
  return async (_request, proposal) => {
    if (proposal.accept && peerFree.includes(proposal.accept)) {
      return { slots: [proposal.accept], accept: proposal.accept };
    }
    return { slots: peerFree };
  };
}

/** A stubborn peer: keeps counter-proposing overlapping slots but NEVER
 *  confirms a commitment — the natural negotiation runaway. */
function stubbornPeer(peerFree: string[]): AskPeer {
  return async () => ({ slots: peerFree });
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-nego-'));

  const aliceFree = ['Thu-09:00', 'Thu-09:30', 'Thu-10:00'];
  const bobFree = ['Thu-09:30', 'Thu-10:00', 'Thu-11:00'];

  // 1 + 2 + 5. Capstone: converge on the earliest mutually-free slot, while
  // auditing every turn through the PA-5 hop trail.
  const converged = await negotiateSlot({
    self: 'pa_alice',
    peer: 'pa_bob',
    selfFree: aliceFree,
    window: '2026-06-25/2026-06-26',
    maxHops: MAX_A2A_HOPS,
    askPeer: cooperativePeer(bobFree),
    onTurn: (turn) =>
      recordHop(
        {
          direction: 'out',
          from: turn.from,
          to: turn.to,
          intent: 'negotiate-slot',
          hop: turn.hop,
          threadId: turn.threadId,
          outcome: turn.received.accept ? 'agreed' : 'proposed',
        },
        { baseDir },
      ),
  });

  assert(converged.converged === true, `negotiation must converge, got ${JSON.stringify(converged)}`);
  assert(converged.slot === 'Thu-09:30', `must agree on the earliest mutual slot, got ${converged.slot}`);
  assert(converged.reason === 'converged', `reason must be converged, got ${converged.reason}`);
  assert(converged.hops <= MAX_A2A_HOPS && converged.hops >= 1, `hops must be within bounds, got ${converged.hops}`);
  console.log(`▸ capstone: converged on ${converged.slot} in ${converged.hops} hop(s) ✓`);

  // threadId shared across turns; hop increments 1..n.
  const threadIds = new Set(converged.transcript.map((t) => t.threadId));
  assert(threadIds.size === 1 && [...threadIds][0] === converged.threadId, 'all turns must share one threadId');
  converged.transcript.forEach((t, i) => assert(t.hop === i + 1, `hop must increment 1..n, got ${t.hop} at index ${i}`));
  console.log(`▸ thread: one threadId across ${converged.transcript.length} turns; hop counter increments ✓`);

  // 5. each turn landed in the audit trail with the same thread.
  const hops = await readHops({ baseDir });
  assert(hops.length === converged.transcript.length, `audit must record every turn, got ${hops.length}`);
  assert(hops.every((h) => h.threadId === converged.threadId), 'audited hops must carry the negotiation threadId');
  console.log(`▸ reuse: ${hops.length} turns recorded in the PA-5 A2A-hop audit ✓`);

  // 3. no overlapping slot → terminate early, never loop.
  const noOverlap = await negotiateSlot({
    self: 'pa_alice',
    peer: 'pa_bob',
    selfFree: ['Thu-09:00'],
    askPeer: cooperativePeer(['Fri-15:00']),
  });
  assert(
    noOverlap.converged === false && noOverlap.reason === 'no-common-slot',
    `no overlap must terminate as no-common-slot, got ${JSON.stringify(noOverlap)}`,
  );
  assert(noOverlap.hops < MAX_A2A_HOPS, 'no-common-slot must terminate early, not run to the cap');
  console.log(`▸ no overlap: terminated early (${noOverlap.reason}, ${noOverlap.hops} hop) ✓`);

  // 4. stubborn peer → terminate at the hop cap.
  const capped = await negotiateSlot({
    self: 'pa_alice',
    peer: 'pa_bob',
    selfFree: aliceFree,
    maxHops: 4,
    askPeer: stubbornPeer(bobFree),
  });
  assert(
    capped.converged === false && capped.reason === 'max-hops' && capped.hops === 4,
    `a stubborn peer must terminate at maxHops=4, got ${JSON.stringify({ ...capped, transcript: undefined })}`,
  );

  // maxHops is clamped to MAX_A2A_HOPS even if a caller asks for more.
  const clamped = await negotiateSlot({
    self: 'pa_alice',
    peer: 'pa_bob',
    selfFree: aliceFree,
    maxHops: 100,
    askPeer: stubbornPeer(bobFree),
  });
  assert(clamped.hops === MAX_A2A_HOPS, `maxHops must clamp to ${MAX_A2A_HOPS}, got ${clamped.hops}`);
  console.log(`▸ termination: stubborn peer stops at maxHops; cap clamped to ${MAX_A2A_HOPS} ✓`);

  console.log('\naudit: converge ≤N + threadId/hop threading + early + max-hop termination — all offline');
  console.log('✅ pa-negotiation check passed');
} catch (err) {
  console.error(`❌ pa-negotiation check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
