/**
 * Phase PA-3 offline gate — the peer roster store.
 *
 * Asserts, with no key and no network:
 *   1. invite is MUTUAL — both rosters gain the other's handle, and the
 *      inviter's side records the offered sharePolicy while the peer's
 *      side defaults to sharing NOTHING (allow-list default, D5).
 *   2. peers list reflects the roster; an assistant cannot invite itself.
 *   3. revoke is MUTUAL — the relationship is removed from both rosters.
 *
 * All file I/O is confined to a temp dir, cleaned up after.
 *
 *   npm run check:assistant-roster
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  invitePeer,
  revokePeer,
  listPeers,
  defaultSharePolicy,
  peerMembership,
  recordPeerMembership,
} from '../assistant/assistant-roster.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-roster-'));

  // 1. mutual invite with an offered policy.
  const offered = { freeBusy: true, meetingTitles: false };
  const { self, peer } = await invitePeer({
    owner: 'alice@acme',
    agentName: 'pa_alice',
    peerOwner: 'bob@acme',
    peerAgentName: 'pa_bob',
    sharePolicy: offered,
    baseDir,
  });

  const alicePeer = self.peers.find((p) => p.agentName === 'pa_bob');
  const bobPeer = peer.peers.find((p) => p.agentName === 'pa_alice');
  assert(alicePeer, 'alice roster must list pa_bob');
  assert(bobPeer, 'bob roster must list pa_alice (invite is mutual)');
  assert(alicePeer.sharePolicy.freeBusy === true, "inviter's offered policy must be recorded on its side");
  assert(
    bobPeer.sharePolicy.freeBusy === defaultSharePolicy().freeBusy && bobPeer.sharePolicy.freeBusy === false,
    "peer's side must default to sharing nothing until they opt in",
  );
  console.log('▸ invite: mutual rosters + allow-list default (peer shares nothing) ✓');

  // 2. peers list + self-invite guard.
  const alicePeers = await listPeers('pa_alice', baseDir);
  assert(alicePeers.length === 1 && alicePeers[0].agentName === 'pa_bob', 'listPeers must reflect the roster');

  let selfInviteThrew = false;
  try {
    await invitePeer({ owner: 'a', agentName: 'pa_alice', peerOwner: 'a', peerAgentName: 'pa_alice', baseDir });
  } catch {
    selfInviteThrew = true;
  }
  assert(selfInviteThrew, 'an assistant must not be able to invite itself');
  console.log('▸ peers: listed correctly; self-invite refused ✓');

  // 2b. membership state (Workstream C): a fresh invite is app-level by
  //     default (back-compat: absent field ⇒ app-level), and the grant state
  //     can be recorded after the external `blocks invite accept`.
  assert(peerMembership(alicePeer) === 'app-level', 'a fresh invite must default to app-level membership');
  const granted = await recordPeerMembership('pa_alice', 'pa_bob', 'granted', baseDir);
  const grantedPeer = granted.peers.find((p) => p.agentName === 'pa_bob');
  assert(grantedPeer && peerMembership(grantedPeer) === 'granted', 'recordPeerMembership must persist granted state');
  let missingThrew = false;
  try {
    await recordPeerMembership('pa_alice', 'pa_nobody', 'granted', baseDir);
  } catch {
    missingThrew = true;
  }
  assert(missingThrew, 'recording membership for a non-peer must throw (invite them first)');
  console.log('▸ membership: defaults app-level, records granted, refuses unknown peer ✓');

  // 3. mutual revoke.
  const revoked = await revokePeer({ agentName: 'pa_alice', peerAgentName: 'pa_bob', baseDir });
  assert(revoked.self.peers.length === 0, 'revoke must clear the inviter side');
  assert(revoked.peer.peers.length === 0, 'revoke must clear the peer side too');
  assert((await listPeers('pa_bob', baseDir)).length === 0, 'pa_bob must no longer list pa_alice');
  console.log('▸ revoke: relationship removed from both rosters ✓');

  console.log('\n✅ assistant-roster check passed');
} catch (err) {
  console.error(`❌ assistant-roster check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
