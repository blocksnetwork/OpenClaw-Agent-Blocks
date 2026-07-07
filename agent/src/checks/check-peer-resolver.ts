/**
 * Pillar 3.7 offline gate — the roster-backed peer NAME resolver.
 *
 * Asserts, with no key and no network, that an invited peer is an IDENTITY,
 * not a bare string:
 *   1. the pure resolver maps a name/alias/possessive/@-mention/handle → one
 *      peer; several → ambiguous; unknown → honest miss (no substring false
 *      positives, no fabricated `pa_<name>`);
 *   2. roster BACK-COMPAT — an old roster with NONE of the new identity fields
 *      still loads and resolves by handle (and the handle-derived name);
 *   3. the invite exchanges a MINIMAL identity card on BOTH sides (3.2);
 *   4. in the runtime, "ask Kayley" resolves Kayley from the roster BY NAME and
 *      sends A2A to the resolved handle (never a guessed one);
 *   5. an unknown name is reported with an Invite affordance (kept distinct
 *      from a contact match), never invented, and stays a soft-miss (ok:true);
 *   6. a self-reference is refused, not dispatched (outbound loop guard);
 *   7. two "Kayley"s → a disambiguation round-trip parked in the pending-plan
 *      store; the owner's pick resumes the parked plan and runs the peer step
 *      EXACTLY once (step idempotency).
 *
 *   npm run check:peer-resolver
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';
import {
  defaultSharePolicy,
  invitePeer,
  loadRoster,
  resolvePeerReference,
  saveRoster,
  type Peer,
} from '../assistant/assistant-roster.ts';
import { runAssistant, type RunSkillImpl, type SendA2A } from '../assistant/assistant-runtime.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
// call-peer isn't gated by read-only, but pin it so nothing in the run path
// short-circuits on policy.
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
  assert(isRecord(parsed), `expected an object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function peer(partial: Partial<Peer> & { agentName: string }): Peer {
  return {
    owner: partial.owner ?? `${partial.agentName}@example.com`,
    since: '2026-01-01T00:00:00.000Z',
    sharePolicy: partial.sharePolicy ?? defaultSharePolicy(),
    ...partial,
  };
}

/** Read a length through a function call so TS never narrows the count to a
 *  literal after an assert (the awaited runAssistant mutates it out of band). */
function count(arr: unknown[]): number {
  return arr.length;
}

function ownerTask(text: string, taskId: string): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId: 'alice-oid',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

/** A planner that returns a fixed call-peer plan (personRef, never a handle). */
function peerPlanner(personRef: string, intent = 'free-busy'): RunSkillImpl {
  return async (skill) =>
    skill === 'personal_assistant'
      ? { ok: true, reply: `I'll check with ${personRef}'s assistant.`, actions: [{ kind: 'call-peer', personRef, intent }] }
      : { ok: true };
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'peer-resolver-'));

  /* 1. Pure resolver — name/alias/possessive/@-mention/handle → one peer. */
  {
    const peers: Peer[] = [
      peer({ agentName: 'pa_kayley', ownerName: 'Kayley Chen', displayName: 'Kayley', aliases: ['kay'], capabilities: ['free-busy'] }),
      peer({ agentName: 'pa_sam', ownerName: 'Sam Okafor' }),
    ];
    const byFirstName = resolvePeerReference(peers, 'Kayley');
    assert(byFirstName.status === 'matched' && byFirstName.peer.agentName === 'pa_kayley', `first name must resolve, got ${JSON.stringify(byFirstName)}`);
    const byPossessiveAssistant = resolvePeerReference(peers, "Kayley's assistant");
    assert(byPossessiveAssistant.status === 'matched' && byPossessiveAssistant.peer.agentName === 'pa_kayley', `"Kayley's assistant" must resolve, got ${JSON.stringify(byPossessiveAssistant)}`);
    const byMention = resolvePeerReference(peers, '@kayley');
    assert(byMention.status === 'matched' && byMention.peer.agentName === 'pa_kayley', `@-mention must resolve, got ${JSON.stringify(byMention)}`);
    const byHandle = resolvePeerReference(peers, 'pa_kayley');
    assert(byHandle.status === 'matched' && byHandle.peer.agentName === 'pa_kayley', `raw handle must resolve, got ${JSON.stringify(byHandle)}`);
    const byAlias = resolvePeerReference(peers, 'Kay');
    assert(byAlias.status === 'matched' && byAlias.peer.agentName === 'pa_kayley', `alias must resolve, got ${JSON.stringify(byAlias)}`);
    const byLocalPart = resolvePeerReference(peers, 'sam');
    assert(byLocalPart.status === 'matched' && byLocalPart.peer.agentName === 'pa_sam', `handle-derived first name must resolve, got ${JSON.stringify(byLocalPart)}`);
    const unknown = resolvePeerReference(peers, 'Fred');
    assert(unknown.status === 'unknown', `unknown reference must miss, got ${JSON.stringify(unknown)}`);
    // No substring false positives: "kay"⊄"kayley" partials don't match.
    const noSubstring = resolvePeerReference([peer({ agentName: 'pa_bart', ownerName: 'Bart Simpson' })], 'art');
    assert(noSubstring.status === 'unknown', `a substring must NOT match (no "art"⊂"Bart"), got ${JSON.stringify(noSubstring)}`);
    console.log('▸ resolver: name/alias/possessive/@-mention/handle → one peer; unknown → miss; no substring false positives ✓');
  }

  /* 1b. Ambiguity — two "Kayley"s → ask, never auto-pick. */
  {
    const twins: Peer[] = [
      peer({ agentName: 'pa_kayley', ownerName: 'Kayley Chen' }),
      peer({ agentName: 'pa_kayley_s', ownerName: 'Kayley Stone' }),
    ];
    const ambiguous = resolvePeerReference(twins, 'Kayley');
    assert(ambiguous.status === 'ambiguous' && ambiguous.candidates.length === 2, `two "Kayley"s must be ambiguous, got ${JSON.stringify(ambiguous)}`);
    console.log('▸ resolver: two same-named peers → ambiguous (caller disambiguates) ✓');
  }

  /* 2. Roster back-compat — an OLD roster (no identity fields) still resolves
   *    by handle and the handle-derived name. */
  {
    const oldDir = join(baseDir, 'oldroster');
    await saveRoster(
      { owner: 'alice@x', agentName: 'pa_alice', peers: [{ owner: 'bob@x', agentName: 'pa_bob', since: '2025-01-01T00:00:00.000Z', sharePolicy: defaultSharePolicy() }] },
      oldDir,
    );
    const loaded = await loadRoster('pa_alice', { baseDir: oldDir });
    assert(loaded.peers.length === 1 && loaded.peers[0].agentName === 'pa_bob', `old roster must load, got ${JSON.stringify(loaded.peers)}`);
    assert(loaded.peers[0].displayName === undefined && loaded.peers[0].aliases === undefined, 'an old roster carries none of the new identity fields');
    const byHandle = resolvePeerReference(loaded.peers, 'pa_bob');
    const byName = resolvePeerReference(loaded.peers, 'bob');
    assert(byHandle.status === 'matched' && byName.status === 'matched', `back-compat roster must resolve by handle + handle-name, got ${JSON.stringify({ byHandle, byName })}`);
    console.log('▸ back-compat: an old roster with no identity fields loads and resolves by handle ✓');
  }

  /* 3. Identity exchange at invite — minimal card stored on BOTH sides. */
  {
    const inviteDir = join(baseDir, 'invite');
    const { self, peer: peerRoster } = await invitePeer({
      owner: 'alice@x',
      agentName: 'pa_alice',
      peerOwner: 'kayley@x',
      peerAgentName: 'pa_kayley',
      peerCard: { displayName: 'Kayley', ownerName: 'Kayley Chen', aliases: ['Kay'], capabilities: ['free-busy', 'book'] },
      selfCard: { displayName: 'Alice', ownerName: 'Alice Ng' },
      baseDir: inviteDir,
    });
    const recorded = self.peers.find((p) => p.agentName === 'pa_kayley');
    assert(recorded?.ownerName === 'Kayley Chen' && recorded.capabilities?.includes('free-busy'), `inviter side must record the peer's card, got ${JSON.stringify(recorded)}`);
    assert(recorded?.aliases?.includes('kay') && recorded.aliases.every((a) => a === a.toLowerCase()), `aliases must be lower-cased on save, got ${JSON.stringify(recorded?.aliases)}`);
    const back = peerRoster.peers.find((p) => p.agentName === 'pa_alice');
    assert(back?.ownerName === 'Alice Ng', `peer side must record the inviter's card (mutual), got ${JSON.stringify(back)}`);
    // A card-less peer keeps the policy default unchanged.
    assert(back?.sharePolicy.freeBusy === false, 'share policy is unchanged by the identity exchange');
    console.log('▸ invite: a minimal identity card is exchanged + recorded on BOTH sides (3.2) ✓');
  }

  /* Shared runtime fixture: pa_alice with ONE Kayley invited. */
  const runDir = join(baseDir, 'run');
  await invitePeer({
    owner: 'alice@x', agentName: 'pa_alice',
    peerOwner: 'kayley@x', peerAgentName: 'pa_kayley',
    peerCard: { displayName: 'Kayley', ownerName: 'Kayley Chen', capabilities: ['free-busy'] },
    baseDir: runDir,
  });

  const runtimeOpts = (sends: Array<{ handle: string }>) => {
    const sendA2A: SendA2A = async (handle) => { sends.push({ handle }); return { ok: true, reply: '(simulated peer reply)' }; };
    return {
      offline: true,
      selfHandle: 'pa_alice',
      rosterBaseDir: runDir,
      budgetBaseDir: join(baseDir!, 'budget'),
      auditBaseDir: join(baseDir!, 'audit'),
      sendA2A,
    };
  };

  /* 4. Runtime — "ask Kayley" resolves Kayley BY NAME and sends to the handle. */
  {
    const sends: Array<{ handle: string }> = [];
    const out = payloadOf(await runAssistant(
      ownerTask('ask Kayley when she is free Thursday', 'matched-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...runtimeOpts(sends), runSkillImpl: peerPlanner('Kayley') },
    ));
    assert(isRecord(out.a2a) && out.a2a.to === 'pa_kayley', `"ask Kayley" must resolve to pa_kayley BY NAME, got ${JSON.stringify(out.a2a)}`);
    assert(sends.length === 1 && sends[0].handle === 'pa_kayley', `A2A must be sent to the RESOLVED handle, got ${JSON.stringify(sends)}`);
    assert(isRecord(out.peerIdentity) && out.peerIdentity.ownerName === 'Kayley Chen', `the resolved identity must ride the envelope (3.6), got ${JSON.stringify(out.peerIdentity)}`);
    console.log('▸ runtime: "ask Kayley" resolves the roster peer by name and calls the resolved handle ✓');
  }

  /* 5. Runtime — unknown name reported with an Invite affordance, never
   *    invented, kept distinct from a contact, and a soft-miss (ok:true). */
  {
    const sends: Array<{ handle: string }> = [];
    const out = payloadOf(await runAssistant(
      ownerTask('ask Fred when he is free', 'unknown-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...runtimeOpts(sends), runSkillImpl: peerPlanner('Fred') },
    ));
    assert(out.ok === true, `an unknown peer must stay ok:true (soft-miss), got ${JSON.stringify(out.ok)}`);
    assert(out.peerResolution === 'unknown', `must report an unknown peer, got ${JSON.stringify(out.peerResolution)}`);
    assert(typeof out.note === 'string' && /not an invited peer/u.test(out.note), `must keep the "not an invited peer" signal, got ${JSON.stringify(out.note)}`);
    assert(typeof out.reply === 'string' && /Fred/u.test(out.reply) && /invite/i.test(out.reply), `reply must name the person + offer Invite, got ${JSON.stringify(out.reply)}`);
    assert(isRecord(out.invite), `must carry an Invite affordance, got ${JSON.stringify(out.invite)}`);
    assert(sends.length === 0, `an unknown peer must NOT send (never a fabricated pa_<name>), got ${JSON.stringify(sends)}`);
    assert(out.a2a === undefined, 'an unknown peer must not produce an a2a envelope (no guessed handle)');
    console.log('▸ runtime: unknown name → honest refusal + Invite affordance, no fabricated handle, soft-miss ✓');
  }

  /* 5b. Unknown peer who IS a contact → distinct, offers email instead. */
  {
    const sends: Array<{ handle: string }> = [];
    const out = payloadOf(await runAssistant(
      ownerTask('ask Dana when she is free', 'unknown-contact-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...runtimeOpts(sends), runSkillImpl: peerPlanner('Dana'), contacts: [{ name: 'Dana Lee', email: 'dana@example.com', aliases: ['dana'] }] },
    ));
    assert(out.peerResolution === 'unknown' && out.contactFallback === 'Dana Lee', `an unknown peer who is a contact must be kept DISTINCT (offer email), got ${JSON.stringify(out)}`);
    assert(typeof out.reply === 'string' && /email/i.test(out.reply), `reply must offer the email fork, got ${JSON.stringify(out.reply)}`);
    assert(sends.length === 0, 'still must not call a peer A2A');
    console.log('▸ runtime: unknown peer who is a known contact → offers email (diagram F fork), never guesses one resolver ✓');
  }

  /* 6. Runtime — a self-reference is refused, not dispatched. */
  {
    const sends: Array<{ handle: string }> = [];
    const out = payloadOf(await runAssistant(
      ownerTask('ask my own assistant', 'self-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...runtimeOpts(sends), runSkillImpl: peerPlanner('pa_alice') },
    ));
    assert(out.peerResolution === 'self', `a self-reference must be refused, got ${JSON.stringify(out.peerResolution)}`);
    assert(sends.length === 0, `a self-reference must NOT dispatch, got ${JSON.stringify(sends)}`);
    console.log('▸ runtime: a self-reference is a clear refusal, not a call (outbound loop guard) ✓');
  }

  /* 7. Runtime — ambiguous "Kayley" parks a disambiguation round-trip; the
   *    pick resumes the parked plan and runs the peer step EXACTLY once. */
  {
    const twinDir = join(baseDir, 'twins');
    await invitePeer({ owner: 'alice@x', agentName: 'pa_alice', peerOwner: 'kayley@x', peerAgentName: 'pa_kayley', peerCard: { ownerName: 'Kayley Chen' }, baseDir: twinDir });
    await invitePeer({ owner: 'alice@x', agentName: 'pa_alice', peerOwner: 'kstone@x', peerAgentName: 'pa_kayley_s', peerCard: { ownerName: 'Kayley Stone' }, baseDir: twinDir });

    const sends: Array<{ handle: string }> = [];
    const sendA2A: SendA2A = async (handle) => { sends.push({ handle }); return { ok: true, reply: '(simulated peer reply)' }; };
    const opts = {
      offline: true,
      selfHandle: 'pa_alice',
      rosterBaseDir: twinDir,
      budgetBaseDir: join(baseDir, 'budget2'),
      auditBaseDir: join(baseDir, 'audit2'),
      bookingAuditBaseDir: join(baseDir, 'pending'),
      sendA2A,
      runSkillImpl: peerPlanner('Kayley'),
    };

    // Turn 1: ambiguous → parked, no auto-pick.
    const turn1 = payloadOf(await runAssistant(ownerTask('ask Kayley when she is free', 'amb-1'), undefined, { ownerId: 'alice-oid' }, opts));
    assert(turn1.peerResolution === 'ambiguous', `two Kayleys must be ambiguous, got ${JSON.stringify(turn1.peerResolution)}`);
    assert(turn1.needsMoreInfo === true, 'an ambiguous peer must ask (needsMoreInfo)');
    const candidates = Array.isArray(turn1.candidates) ? turn1.candidates : [];
    assert(candidates.length === 2, `must offer both candidates as chips, got ${JSON.stringify(candidates)}`);
    const resume = isRecord(turn1.resume) ? turn1.resume : null;
    const resumeToken = resume && typeof resume.token === 'string' ? resume.token : '';
    assert(resumeToken !== '', `must carry a resume token for the pick, got ${JSON.stringify(turn1.resume)}`);
    assert(count(sends) === 0, `ambiguous must NOT auto-pick/send, got ${JSON.stringify(sends)}`);

    // Turn 2: the pick (resume token + chosen handle) resumes the parked plan.
    const pick = JSON.stringify({ resumeToken, peerHandle: 'pa_kayley_s' });
    const turn2 = payloadOf(await runAssistant(ownerTask(pick, 'amb-2'), undefined, { ownerId: 'alice-oid' }, opts));
    assert(count(sends) === 1 && sends[0].handle === 'pa_kayley_s', `the pick must run the peer step ONCE with the chosen handle, got ${JSON.stringify(sends)}`);
    assert(turn2.partial === false, `the resumed plan must complete, got ${JSON.stringify(turn2)}`);

    // A replayed pick must not re-run the step (parked plan resolved).
    const replay = payloadOf(await runAssistant(ownerTask(pick, 'amb-3'), undefined, { ownerId: 'alice-oid' }, opts));
    assert(count(sends) === 1, `a replayed pick must NOT re-run the peer step, got ${JSON.stringify(sends)}`);
    void replay;
    console.log('▸ runtime: ambiguous → parked round-trip; the pick resumes and runs the peer step exactly once (idempotent) ✓');
  }

  console.log('\naudit: a peer is an identity — resolved by name/alias/handle, disambiguated when several, refused honestly when none, never a guessed pa_<name>');
  console.log('✅ peer-resolver check passed');
} catch (err) {
  console.error(`❌ peer-resolver check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
