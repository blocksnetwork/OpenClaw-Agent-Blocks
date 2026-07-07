/**
 * Workstream I offline gate — unify assistant identity, rosters, and contacts
 * so an invited Blocks peer is SELF-DESCRIBING and materializes a contact.
 *
 * Asserts, with no key and no network:
 *   1. the identity card carries email + handle, and `invitePeer` records the
 *      peer's email on the roster (I.1);
 *   2. `contactFromPeer` derives a contact joined by `peerHandle` (name, email,
 *      aliases) and refuses to fabricate one with no email (I.2);
 *   3. `upsertPeerContact` MERGES into a manual same-name contact (no clobber,
 *      union aliases, attach peerHandle) and re-derives on invite refresh (I.6);
 *   4. the SAME invite-derived identity resolves through BOTH stores:
 *      "email Kayley" → the contact email; "ask Kayley's assistant" → the same
 *      contact's peerHandle on the roster (acceptance);
 *   5. a manual contact with NO peerHandle still resolves (non-Blocks fallback,
 *      back-compat) (I.3).
 *
 *   npm run check:identity-unification
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';
import { invitePeer } from '../assistant/assistant-roster.ts';
import {
  contactFromPeer,
  loadContacts,
  resolveContactReference,
  saveContact,
  upsertPeerContact,
} from '../assistant/contacts-store.ts';
import { runAssistant, type RunIntegration, type RunSkillImpl, type SendA2A } from '../assistant/assistant-runtime.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
// Email writes run through the recipient resolver (default read-only would
// refuse before resolution); call-peer isn't gated but pin it for safety.
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

function ownerTask(text: string, taskId: string): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId: 'alice-oid',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

const sendPlanner: RunSkillImpl = async (skill, inputs) =>
  skill === 'personal_assistant'
    ? {
        ok: true,
        reply: "I'll prepare that email.",
        actions: [{ kind: 'use-integration', tool: 'email.send', args: { query: String(inputs.request ?? '') } }],
      }
    : { ok: true };

const peerPlanner: RunSkillImpl = async (skill) =>
  skill === 'personal_assistant'
    ? { ok: true, reply: "I'll check with Kayley's assistant.", actions: [{ kind: 'call-peer', personRef: 'Kayley', intent: 'free-busy' }] }
    : { ok: true };

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'identity-unify-'));
  const rosterDir = join(baseDir, 'rosters');
  const contactsDir = join(baseDir, 'contacts');

  /* 1. Self-describing card → invitePeer records the peer's email (I.1). */
  const { self } = await invitePeer({
    owner: 'alice@x',
    agentName: 'pa_alice',
    peerOwner: 'kayley@x',
    peerAgentName: 'pa_kayley',
    peerCard: {
      displayName: 'Kayley',
      ownerName: 'Kayley Chen',
      email: 'kayley@example.com',
      handle: 'pa_kayley',
      aliases: ['Kay'],
      capabilities: ['free-busy', 'book'],
    },
    baseDir: rosterDir,
  });
  const recorded = self.peers.find((p) => p.agentName === 'pa_kayley');
  assert(recorded?.email === 'kayley@example.com', `invite must record the peer's email on the roster, got ${JSON.stringify(recorded)}`);
  assert(recorded?.capabilities?.includes('free-busy'), 'invite must keep capabilities on the roster (the relationship facet)');
  console.log('▸ I.1: a self-describing card (email + handle + capabilities) is recorded on the roster ✓');

  /* 2. contactFromPeer derives a joined contact, and refuses with no email. */
  const derived = contactFromPeer(recorded!);
  assert(derived && derived.email === 'kayley@example.com' && derived.peerHandle === 'pa_kayley', `derived contact must carry email + peerHandle, got ${JSON.stringify(derived)}`);
  assert(derived!.name === 'Kayley Chen', `derived name should prefer the person (ownerName), got ${JSON.stringify(derived!.name)}`);
  assert(derived!.aliases.includes('kayley') && derived!.aliases.includes('kay'), `derived aliases should include the first name + card alias, got ${JSON.stringify(derived!.aliases)}`);
  const noEmail = contactFromPeer({ agentName: 'pa_nomail', ownerName: 'No Mail' });
  assert(noEmail === null, 'a peer with no email must NOT fabricate a contact (nothing to address)');
  console.log('▸ I.2: contactFromPeer derives a peerHandle-joined contact and refuses one with no email ✓');

  /* 3. upsertPeerContact MERGES into a manual same-name contact (no clobber). */
  await saveContact('alice-oid', { name: 'Kayley Chen', email: 'old@personal.example.com', aliases: ['kc'] }, { baseDir: contactsDir });
  await upsertPeerContact('alice-oid', recorded!, { baseDir: contactsDir });
  let book = await loadContacts('alice-oid', { baseDir: contactsDir });
  assert(book.length === 1, `merge must not duplicate the same person, got ${book.length} contacts`);
  const merged = book[0];
  assert(merged.email === 'kayley@example.com', `invite must refresh the email to the self-described address, got ${JSON.stringify(merged.email)}`);
  assert(merged.peerHandle === 'pa_kayley', 'merge must attach the peerHandle join');
  assert(merged.aliases.includes('kc') && merged.aliases.includes('kayley'), `merge must UNION aliases (keep the manual "kc"), got ${JSON.stringify(merged.aliases)}`);
  console.log('▸ I.2/I.6: upsertPeerContact merges into a manual contact — no clobber, union aliases, attach handle ✓');

  // Invite refresh: a changed email re-derives onto the SAME contact (by handle).
  await upsertPeerContact('alice-oid', { ...recorded!, email: 'kayley@newco.example.com' }, { baseDir: contactsDir });
  book = await loadContacts('alice-oid', { baseDir: contactsDir });
  assert(book.length === 1 && book[0].email === 'kayley@newco.example.com', `invite refresh must re-derive on the same contact (by peerHandle), got ${JSON.stringify(book)}`);
  console.log('▸ I.6: an invite refresh re-derives the contact in place (joined by peerHandle) ✓');

  /* 4. ONE identity, BOTH resolvers — email + ask resolve to the same peer. */
  const contacts = await loadContacts('alice-oid', { baseDir: contactsDir });

  // "email Kayley" → the contact email (the addressing facet).
  const writes: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const captureSend: RunIntegration = async (tool, args) => { writes.push({ tool, args }); return { ok: true, tool, sent: { id: `s-${writes.length}` } }; };
  const emailOut = payloadOf(await runAssistant(
    ownerTask('Email Kayley the summary.', 'unify-email'),
    undefined,
    { ownerId: 'alice-oid' },
    {
      offline: true,
      runSkillImpl: sendPlanner,
      runIntegration: captureSend,
      contacts,
      bookingPolicy: 'auto',
      bookingAuditBaseDir: join(baseDir, 'booking-audit'),
      writeIdempotencyId: 'unify-email-1',
    },
  ));
  assert(emailOut.ok === true, `email send must succeed, got ${JSON.stringify(emailOut)}`);
  assert(writes.length === 1 && writes[0].args.to === 'kayley@newco.example.com', `"email Kayley" must resolve to the invite-derived contact email, got ${JSON.stringify(writes)}`);
  console.log('▸ acceptance: "email Kayley" resolves to the invite-derived contact email ✓');

  // "ask Kayley's assistant" → the SAME contact's peerHandle on the roster.
  const sends: Array<{ handle: string }> = [];
  const sendA2A: SendA2A = async (handle) => { sends.push({ handle }); return { ok: true, reply: '(simulated peer reply)' }; };
  const askOut = payloadOf(await runAssistant(
    ownerTask("ask Kayley's assistant when she is free Thursday", 'unify-ask'),
    undefined,
    { ownerId: 'alice-oid' },
    {
      offline: true,
      selfHandle: 'pa_alice',
      rosterBaseDir: rosterDir,
      budgetBaseDir: join(baseDir, 'budget'),
      auditBaseDir: join(baseDir, 'audit'),
      sendA2A,
      runSkillImpl: peerPlanner,
    },
  ));
  assert(isRecord(askOut.a2a) && askOut.a2a.to === 'pa_kayley', `"ask Kayley's assistant" must resolve to pa_kayley, got ${JSON.stringify(askOut.a2a)}`);
  assert(sends.length === 1 && sends[0].handle === 'pa_kayley', `A2A must reach the resolved handle, got ${JSON.stringify(sends)}`);
  assert(sends[0].handle === merged.peerHandle, 'the email contact and the called peer must be the SAME identity (joined by peerHandle)');
  console.log('▸ acceptance: "ask Kayley\'s assistant" resolves to the same contact\'s peerHandle ✓');

  /* 5. A manual contact with NO peerHandle still resolves (non-Blocks). */
  await saveContact('alice-oid', { name: 'Dana Lee', email: 'dana@example.com', aliases: ['dana'] }, { baseDir: contactsDir });
  const manualBook = await loadContacts('alice-oid', { baseDir: contactsDir });
  const dana = manualBook.find((c) => c.name === 'Dana Lee');
  assert(dana && dana.peerHandle === undefined, 'a manual contact has no peerHandle (the non-Blocks fallback)');
  const danaRes = resolveContactReference(manualBook, 'Dana');
  assert(danaRes.status === 'matched' && danaRes.contact.email === 'dana@example.com', `a manual contact must still resolve, got ${JSON.stringify(danaRes)}`);
  console.log('▸ I.3: a manual (non-Blocks) contact still resolves — backward compatible ✓');

  console.log('\naudit: an invited peer is one self-describing identity — roster (relationship + capabilities) and contact (addressing) joined by peerHandle; manual contacts remain the non-Blocks fallback');
  console.log('✅ identity-unification check passed');
} catch (err) {
  console.error(`❌ identity-unification check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
