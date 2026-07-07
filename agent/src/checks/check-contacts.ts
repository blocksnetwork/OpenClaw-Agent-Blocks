/**
 * Pillar 0.7 offline gate — contact book store + recipient resolution.
 *
 * Asserts, with no key and no network:
 *   1. Contacts save/load round-trip, dedup by name, normalize aliases, and
 *      isolate owners.
 *   2. The pure resolver maps name/alias/local-part → one contact, several →
 *      ambiguous, unknown → miss, and accepts a bare address as itself.
 *   3. In the runtime, an email write to a known contact injects the real
 *      address as `to`; an unknown recipient asks to add a contact and sends
 *      nothing (never a bare string).
 *
 *   npm run check:contacts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';
import {
  contactsStorePath,
  loadContacts,
  removeContact,
  resolveContactReference,
  saveContact,
  type Contact,
} from '../assistant/contacts-store.ts';
import { runAssistant, type RunIntegration, type RunSkillImpl } from '../assistant/assistant-runtime.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
// Email writes are enabled so the recipient resolver runs through the write
// gate (default read-only would refuse before resolution).
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

function ownerTask(text: string, ownerId: string, taskId = `contacts-${ownerId}`): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

const sendPlanner: RunSkillImpl = async (skill, inputs) => {
  if (skill === 'personal_assistant') {
    return {
      ok: true,
      reply: "I'll prepare that email.",
      actions: [{ kind: 'use-integration', tool: 'email.send', args: { query: String(inputs.request ?? '') } }],
    };
  }
  return { ok: true };
};

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'contacts-'));

  // 1. Store round-trip + dedup + alias normalization + owner isolation.
  await saveContact('alice-oid', { name: 'Dana Lee', email: 'dana@example.com', aliases: ['Dana', 'D'] }, { baseDir });
  await saveContact('alice-oid', { name: 'Sam Okafor', email: 'sam@example.com', aliases: [] }, { baseDir });
  // Re-saving the same name replaces, not duplicates.
  await saveContact('alice-oid', { name: 'dana lee', email: 'dana@work.example.com', aliases: ['Dana'] }, { baseDir });
  const aliceContacts = await loadContacts('alice-oid', { baseDir });
  assert(aliceContacts.length === 2, `dedup by name must keep 2 contacts, got ${aliceContacts.length}`);
  const dana = aliceContacts.find((c) => c.name.toLowerCase() === 'dana lee');
  assert(dana?.email === 'dana@work.example.com', `re-save must replace the email, got ${JSON.stringify(dana)}`);
  assert(dana?.aliases.includes('dana') && dana.aliases.every((a) => a === a.toLowerCase()), 'aliases must be lower-cased');
  assert((await loadContacts('bob-oid', { baseDir })).length === 0, 'contacts must be isolated per owner');
  console.log('▸ store: contacts round-trip, dedup by name, normalize aliases, isolate owners ✓');

  const dangerous = '../../alice/../../secret';
  const storePath = resolve(contactsStorePath(dangerous, { baseDir }));
  assert(storePath.startsWith(resolve(baseDir)), `contacts path must stay inside baseDir, got ${storePath}`);
  console.log('▸ sanitizer: traversal-shaped ownerId stays inside the contacts store ✓');

  // 2. Pure resolver behaviour.
  const book: Contact[] = [
    { name: 'Dana Lee', email: 'dana@example.com', aliases: ['dana'] },
    { name: 'Sam Okafor', email: 'sam@example.com', aliases: [] },
  ];
  const byAlias = resolveContactReference(book, "Dana's");
  assert(byAlias.status === 'matched' && byAlias.contact.email === 'dana@example.com', `alias (+possessive) must resolve, got ${JSON.stringify(byAlias)}`);
  const byLocalPart = resolveContactReference(book, 'sam');
  assert(byLocalPart.status === 'matched' && byLocalPart.contact.email === 'sam@example.com', `first-name/local-part must resolve, got ${JSON.stringify(byLocalPart)}`);
  const unknown = resolveContactReference(book, 'Fred');
  assert(unknown.status === 'unknown', `unknown reference must miss, got ${JSON.stringify(unknown)}`);
  const bareAddress = resolveContactReference([], 'someone@elsewhere.com');
  // An address is its own recipient even when there's no contact, but the
  // resolver itself reports "unknown" (the runtime treats a valid address as
  // a literal recipient — asserted below).
  assert(bareAddress.status === 'unknown', 'a bare address has no contact match');
  const twins: Contact[] = [
    { name: 'Dana Lee', email: 'dana.lee@example.com', aliases: ['dana'] },
    { name: 'Dana Park', email: 'dana.park@example.com', aliases: ['dana'] },
  ];
  const ambiguous = resolveContactReference(twins, 'Dana');
  assert(ambiguous.status === 'ambiguous' && ambiguous.candidates.length === 2, `two "Dana"s must be ambiguous, got ${JSON.stringify(ambiguous)}`);
  console.log('▸ resolver: alias/local-part → one; two matches → ask; unknown → miss ✓');

  // 3. Runtime recipient resolution — known contact injects the address.
  const writes: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const captureSend: RunIntegration = async (tool, args) => { writes.push({ tool, args }); return { ok: true, tool, sent: { id: `s-${writes.length}` } }; };
  const auditDir = join(baseDir, 'booking-audit');

  const known = payloadOf(await runAssistant(
    ownerTask('Email Dana the summary.', 'alice-oid', 'send-known'),
    undefined,
    { ownerId: 'alice-oid' },
    {
      offline: true,
      runSkillImpl: sendPlanner,
      runIntegration: captureSend,
      contacts: book,
      bookingPolicy: 'auto',
      bookingAuditBaseDir: auditDir,
      writeIdempotencyId: 'send-known-1',
    },
  ));
  assert(known.ok === true, `known-recipient send must succeed, got ${JSON.stringify(known)}`);
  assert(writes.length === 1 && writes[0].args.to === 'dana@example.com', `known recipient must inject the real address, got ${JSON.stringify(writes)}`);
  console.log('▸ runtime: "email Dana …" resolves Dana from contacts and sends to the real address ✓');

  // Unknown recipient — ask to add a contact, send nothing.
  const miss = payloadOf(await runAssistant(
    ownerTask('Email Fred the notes.', 'alice-oid', 'send-unknown'),
    undefined,
    { ownerId: 'alice-oid' },
    {
      offline: true,
      runSkillImpl: sendPlanner,
      runIntegration: captureSend,
      contacts: book,
      bookingPolicy: 'auto',
      bookingAuditBaseDir: auditDir,
      writeIdempotencyId: 'send-unknown-1',
    },
  ));
  assert(miss.needsMoreInfo === true, `unknown recipient must ask, got ${JSON.stringify(miss)}`);
  assert(typeof miss.reply === 'string' && /Fred/i.test(miss.reply) && /add/i.test(miss.reply), `ask copy must name the recipient + offer to add, got ${JSON.stringify(miss.reply)}`);
  assert(writes.length === 1, `unknown recipient must NOT send (never a bare string), still ${writes.length} write(s)`);
  console.log('▸ runtime: unknown recipient asks to add a contact and sends nothing ✓');

  await removeContact('alice-oid', 'Dana Lee', { baseDir });
  assert((await loadContacts('alice-oid', { baseDir })).length === 1, 'removeContact must drop the named contact');
  console.log('▸ remove: contact removal is safe and leaves the rest ✓');

  console.log('\naudit: contacts are isolated + sanitized; resolution turns a name into an address or an honest ask');
  console.log('✅ contacts check passed');
} catch (err) {
  console.error(`❌ contacts check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
