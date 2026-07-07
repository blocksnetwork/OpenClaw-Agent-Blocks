/**
 * contacts-store — the per-owner contact book + recipient resolver
 * (Pillar 0.4 / 0.5).
 *
 * Today "email Dana the summary" has no address to send to: the recipient
 * is free text in the plan args. This store is the missing address book —
 * one JSON file per owner at
 *   agent/data/contacts/<owner>.json   (gitignored; may hold personal data)
 *
 * A `Contact` can also link to an invited peer (`peerHandle`), so the same
 * book backs both "who do I email" (this module) and, later, "who do I call
 * by name" (Pillar 3). `resolveContactReference` is the email half of the
 * resolver in the depth-plan diagram F: a reference like "Dana" resolves to
 * exactly one contact (→ address), several (→ ask), or none (→ honest miss
 * that the runtime turns into an "add contact" prompt — never a guessed
 * bare string).
 *
 * Pure filesystem: no network, no SDK calls, fully deterministic.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sanitizeOwnerId } from '../integrations/integration-store.ts';
import type { Peer } from './assistant-roster.ts';

export interface Contact {
  /** The contact's canonical display name (e.g. "Dana Lee"). */
  name: string;
  /** A real email address; the only thing email.* can actually send to. */
  email: string;
  /** Extra natural references that should resolve to this contact
   *  ("Dana", "dana@work", a nickname). Always lower-cased on save. */
  aliases: string[];
  /** Optional link to an invited peer's assistant handle (Pillar 3). */
  peerHandle?: string;
}

export interface ContactsStoreOptions {
  baseDir?: string;
}

interface OwnerContactsFile {
  ownerId: string;
  contacts: Contact[];
}

function contactsDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data/contacts', import.meta.url));
}

export function contactsStorePath(ownerId: string, opts: ContactsStoreOptions = {}): string {
  return `${contactsDir(opts.baseDir)}/${sanitizeOwnerId(ownerId)}.json`;
}

/** Load an owner's contacts, or [] when none exist yet. Missing/malformed
 *  files behave like an empty book (back-compat). */
export async function loadContacts(
  ownerId: string,
  opts: ContactsStoreOptions = {},
): Promise<Contact[]> {
  const trimmed = ownerId.trim();
  if (!trimmed) return [];
  try {
    const raw = await readFile(contactsStorePath(trimmed, opts), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isOwnerContactsFile(parsed)) {
      return parsed.contacts.map(normalizeContact).filter((c): c is Contact => Boolean(c));
    }
  } catch {
    // Missing or malformed files behave like an empty contact book.
  }
  return [];
}

/** Add or replace a contact (dedup by case-insensitive name). Returns the
 *  full, updated contact list. */
export async function saveContact(
  ownerId: string,
  contact: Contact,
  opts: ContactsStoreOptions = {},
): Promise<Contact[]> {
  const trimmed = ownerId.trim();
  if (!trimmed) throw new Error('ownerId is required');
  const normalized = normalizeContact(contact);
  if (!normalized) throw new Error('a contact needs both a name and an email');

  const existing = await loadContacts(trimmed, opts);
  const next = existing.filter((c) => c.name.toLowerCase() !== normalized.name.toLowerCase());
  next.push(normalized);
  await writeOwnerFile(trimmed, next, opts);
  return next;
}

export async function removeContact(
  ownerId: string,
  name: string,
  opts: ContactsStoreOptions = {},
): Promise<Contact[]> {
  const trimmed = ownerId.trim();
  if (!trimmed) return [];
  const lower = name.trim().toLowerCase();
  const existing = await loadContacts(trimmed, opts);
  const next = existing.filter((c) => c.name.toLowerCase() !== lower);
  await writeOwnerFile(trimmed, next, opts);
  return next;
}

/* ===========================================================================
 * Workstream I — invite-derived contacts (one identity, one source of truth).
 *
 * An invited Blocks peer is SELF-DESCRIBING: its identity card carries a real
 * email and an assistant handle. So accepting/recording an invite should
 * materialize a contact with no manual typing — joined to the roster peer by
 * `peerHandle`. "email Kayley" (this store) and "ask Kayley's assistant" (the
 * roster resolver) then resolve to the SAME identity instead of two
 * disconnected stores. Manual contacts remain the fallback for people who are
 * not on Blocks (they simply have no `peerHandle`).
 * ======================================================================== */

/** Build a Contact from a recorded peer's identity card (invite-derived).
 *  Returns null when the peer carries no email — there's nothing to address,
 *  so we never fabricate a bare-name contact. The contact is joined back to
 *  the roster peer by `peerHandle` (the peer's assistant handle). */
export function contactFromPeer(
  peer: Pick<Peer, 'agentName' | 'email' | 'displayName' | 'ownerName' | 'aliases'>,
): Contact | null {
  const email = typeof peer.email === 'string' ? peer.email.trim() : '';
  if (!email) return null;
  const name = (peer.ownerName?.trim() || peer.displayName?.trim() || handleLocalName(peer.agentName)).trim();
  if (!name) return null;
  const aliases = [...new Set(
    [
      peer.displayName,
      peer.ownerName ? firstNameOf(peer.ownerName) : undefined,
      handleLocalName(peer.agentName),
      ...(Array.isArray(peer.aliases) ? peer.aliases : []),
    ]
      .filter((a): a is string => typeof a === 'string')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
      .filter((a) => a !== name.toLowerCase()),
  )];
  return { name, email, aliases, peerHandle: peer.agentName };
}

/**
 * Merge an invite-derived contact into an owner's book WITHOUT clobbering a
 * manual contact's data (Workstream I.2/I.6). Matches an existing contact by
 * `peerHandle` first (the stable join), then by name; unions aliases, and
 * refreshes name/email/peerHandle from the self-described card (re-derive on
 * invite refresh). Returns the updated contact list. A no-op (returns the
 * unchanged list) when the peer has no email — so a card-less invite never
 * writes a phantom contact.
 */
export async function upsertPeerContact(
  ownerId: string,
  peer: Pick<Peer, 'agentName' | 'email' | 'displayName' | 'ownerName' | 'aliases'>,
  opts: ContactsStoreOptions = {},
): Promise<Contact[]> {
  const trimmed = ownerId.trim();
  if (!trimmed) return [];
  const derived = contactFromPeer(peer);
  if (!derived) return loadContacts(trimmed, opts);

  const existing = await loadContacts(trimmed, opts);
  const match = existing.find((c) => c.peerHandle && c.peerHandle === derived.peerHandle)
    ?? existing.find((c) => c.name.toLowerCase() === derived.name.toLowerCase());

  // A peerHandle match whose name changed leaves a stale-named entry behind
  // (saveContact dedups by name only) — drop it before re-saving.
  if (match && match.name.toLowerCase() !== derived.name.toLowerCase()) {
    await removeContact(trimmed, match.name, opts);
  }

  const aliases = [...new Set([
    ...(match?.aliases ?? []),
    ...derived.aliases,
  ].map((a) => a.toLowerCase()).filter(Boolean))];

  return saveContact(trimmed, { ...derived, aliases }, opts);
}

export type ContactResolution =
  | { status: 'matched'; contact: Contact }
  | { status: 'ambiguous'; candidates: Contact[] }
  | { status: 'unknown'; reference: string };

/**
 * Resolve a natural reference ("Dana", "Dana's", "dana@work") against the
 * contact book. Returns exactly one match, several (caller asks to
 * disambiguate), or none (caller asks to add the contact). The match keys
 * on the canonical name, any alias, the full email, and the email's
 * local-part — all compared case-insensitively.
 */
export function resolveContactReference(contacts: Contact[], reference: string): ContactResolution {
  const ref = normalizeReference(reference);
  if (!ref) return { status: 'unknown', reference: reference.trim() };

  // A reference that is already a well-formed address resolves to itself
  // even with no contact on file — it's an address, not a bare name.
  const matches = contacts.filter((contact) => contactMatches(contact, ref));
  if (matches.length === 1) return { status: 'matched', contact: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  return { status: 'unknown', reference: reference.trim() };
}

export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

function contactMatches(contact: Contact, ref: string): boolean {
  if (contact.name.toLowerCase() === ref) return true;
  if (contact.email.toLowerCase() === ref) return true;
  if (emailLocalPart(contact.email) === ref) return true;
  if (firstNameOf(contact.name) === ref) return true;
  return contact.aliases.some((alias) => alias.toLowerCase() === ref);
}

function firstNameOf(name: string): string {
  return name.trim().toLowerCase().split(/\s+/u)[0] ?? '';
}

/** Strip a leading "pa_"/"pa-" so a handle "pa_kayley" yields "kayley". */
function handleLocalName(handle: string): string {
  return handle.trim().replace(/^pa[_-]/u, '');
}

function emailLocalPart(email: string): string {
  return email.toLowerCase().split('@')[0] ?? '';
}

/** Strip surrounding punctuation and a trailing possessive ("Dana's" →
 *  "dana") so chat-style references resolve. */
function normalizeReference(reference: string): string {
  return reference
    .trim()
    .toLowerCase()
    .replace(/[’']s$/u, '')
    .replace(/^[^a-z0-9@._-]+|[^a-z0-9@._+-]+$/gu, '')
    .trim();
}

function normalizeContact(value: unknown): Contact | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const email = typeof value.email === 'string' ? value.email.trim() : '';
  if (!name || !email) return null;
  const aliases = Array.isArray(value.aliases)
    ? [...new Set(value.aliases
        .filter((alias): alias is string => typeof alias === 'string')
        .map((alias) => alias.trim().toLowerCase())
        .filter(Boolean))]
    : [];
  const peerHandle = typeof value.peerHandle === 'string' && value.peerHandle.trim() !== ''
    ? value.peerHandle.trim()
    : undefined;
  return { name, email, aliases, ...(peerHandle ? { peerHandle } : {}) };
}

async function writeOwnerFile(ownerId: string, contacts: Contact[], opts: ContactsStoreOptions): Promise<void> {
  await mkdir(contactsDir(opts.baseDir), { recursive: true });
  await writeFile(
    contactsStorePath(ownerId, opts),
    `${JSON.stringify({ ownerId, contacts } satisfies OwnerContactsFile, null, 2)}\n`,
    'utf8',
  );
}

function isOwnerContactsFile(value: unknown): value is OwnerContactsFile {
  return isRecord(value) && Array.isArray(value.contacts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
