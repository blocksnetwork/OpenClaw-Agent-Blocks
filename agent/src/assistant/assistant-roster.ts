/**
 * assistant-roster — the per-owner peer roster (Phase PA-3).
 *
 * Private assistants aren't discoverable, so the handle of a peer's
 * assistant must be exchanged explicitly via an invite and recorded in a
 * roster (docs/PERSONAL-ASSISTANT-PLAN.md → "New piece 3"). This module is
 * that store: one JSON file per assistant at
 *   agent/data/assistants/<agentName>.json
 *
 * Semantics:
 *   - An invite is MUTUAL: each side records the other's handle.
 *   - `sharePolicy` on `roster(X).peers[Y]` means "what X will share with
 *     Y" — X's assistant applies it when answering Y (PA-4). It is an
 *     ALLOW-LIST that defaults to sharing NOTHING (decision D5); the owner
 *     opts each field in.
 *
 * This module only touches the local filesystem — it does NOT grant a
 * native Blocks membership (`blocks invite send/accept`). That network
 * step is the live tail of PA-3/PA-4. Safe to run offline.
 */

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Allow-list of what an owner shares with a given peer. Defaults to all
 *  false (share nothing) until the owner opts a field in. */
export interface SharePolicy {
  freeBusy: boolean;
  meetingTitles: boolean;
}

/**
 * Native Blocks membership state for a peer (Workstream C / PA-4 live tail).
 *
 *   - `app-level`  — handles were exchanged in the roster only; the network
 *                    membership (`blocks invite send/accept`) has NOT been
 *                    granted. This is the default an invite records, because
 *                    the Blocks SDK exposes no membership grant call — the
 *                    grant is an external CLI step with a human accept.
 *   - `pending`    — a native `blocks invite send` was issued; the invitee
 *                    has not run `blocks invite accept <token>` yet.
 *   - `granted`    — the membership is live; a direct-handle A2A send is
 *                    expected to reach the peer.
 *
 * A peer with no `membership` field loads as `app-level` (back-compat), so a
 * pre-Workstream-C roster on disk keeps its exact meaning.
 */
export type PeerMembership = 'app-level' | 'pending' | 'granted';

/** Read a peer's membership, treating a missing field as `app-level`. */
export function peerMembership(peer: Pick<Peer, 'membership'>): PeerMembership {
  return peer.membership ?? 'app-level';
}

export interface Peer {
  owner: string;
  agentName: string;
  since: string;
  sharePolicy: SharePolicy;
  /** The peer's Blocks identity (ownerId), recorded at invite time so the
   *  A2A gate can match the caller (defense-in-depth, D6). Optional:
   *  undefined keeps pre-PA-4 rosters valid and the gate tolerant. */
  ownerId?: string;

  /* ---- Pillar 3.1: a peer is an IDENTITY, not a bare handle ----------- */
  /* All identity fields are OPTIONAL so a pre-Pillar-3 roster on disk (only
   * owner/agentName/since/sharePolicy) keeps loading byte-compatibly and
   * still resolves by handle. They are exchanged at invite time (3.2) and
   * power the runtime name resolver (3.3). */

  /** The peer assistant's display name (e.g. "Kayley" / "Kayley's Assistant"). */
  displayName?: string;
  /** The human the peer assistant works for (e.g. "Kayley Chen"), so a
   *  reference to the person resolves to their assistant. */
  ownerName?: string;
  /** The peer's real email address (Workstream I.1). Self-described at invite
   *  time from the peer owner's profile so an invited peer materializes a
   *  contact with no manual typing — "email Kayley" then resolves here. */
  email?: string;
  /** Extra natural references that resolve to this peer (nicknames,
   *  handles-without-prefix). Always lower-cased on save. */
  aliases?: string[];
  /** Advertised intents the peer answers (e.g. ["free-busy", "book"]). A
   *  capability hint only — NOT a grant; the share policy still gates data. */
  capabilities?: string[];

  /** Native Blocks membership state (Workstream C). Optional/absent ⇒
   *  `app-level` (roster handle exchange only, no network grant yet). */
  membership?: PeerMembership;
}

/** The identity exchanged at invite (3.2 + Workstream I.1): a self-describing
 *  card — name + email + assistant handle + capabilities. Both rosters record
 *  the other side's card; no extra owner data leaks beyond what the card
 *  carries (share policy is unchanged). `email` + `handle` make the card
 *  complete enough to materialize a contact on the receiving side. */
export interface PeerIdentityCard {
  displayName?: string;
  ownerName?: string;
  /** The card subject's real email (the addressing facet of the same peer). */
  email?: string;
  /** The card subject's assistant handle (e.g. "pa_kayley"). Informational on
   *  a peer record (the roster keys peers by `agentName`); carried so a
   *  self-card is a complete self-description. */
  handle?: string;
  aliases?: string[];
  capabilities?: string[];
}

export interface Roster {
  owner: string;
  agentName: string;
  peers: Peer[];
}

export function defaultSharePolicy(): SharePolicy {
  return { freeBusy: false, meetingTitles: false };
}

function rosterDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data/assistants', import.meta.url));
}

export function rosterPath(agentName: string, baseDir?: string): string {
  assertHandle(agentName);
  return `${rosterDir(baseDir)}/${agentName}.json`;
}

function assertHandle(agentName: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(agentName)) {
    throw new Error(`invalid assistant handle "${agentName}"`);
  }
}

/** Load a roster, or return an empty one if none exists yet. */
export async function loadRoster(
  agentName: string,
  opts: { owner?: string; baseDir?: string } = {},
): Promise<Roster> {
  try {
    const raw = await readFile(rosterPath(agentName, opts.baseDir), 'utf8');
    const parsed = JSON.parse(raw) as Roster;
    return {
      owner: parsed.owner ?? opts.owner ?? '',
      agentName: parsed.agentName ?? agentName,
      peers: Array.isArray(parsed.peers) ? parsed.peers : [],
    };
  } catch {
    return { owner: opts.owner ?? '', agentName, peers: [] };
  }
}

export async function saveRoster(roster: Roster, baseDir?: string): Promise<void> {
  const dir = rosterDir(baseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${roster.agentName}.json`, `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
}

/** Add or replace a peer (dedup by agentName). Pure — returns a new roster. */
export function addPeer(roster: Roster, peer: Peer): Roster {
  const peers = roster.peers.filter((p) => p.agentName !== peer.agentName);
  peers.push(peer);
  return { ...roster, peers };
}

/** Remove a peer by handle. Pure — returns a new roster. */
export function removePeer(roster: Roster, peerAgentName: string): Roster {
  return { ...roster, peers: roster.peers.filter((p) => p.agentName !== peerAgentName) };
}

/** Set a peer's native membership state. Pure — returns a new roster. No-op
 *  (returns the same roster) when the peer is not in this roster. */
export function setPeerMembership(roster: Roster, peerAgentName: string, state: PeerMembership): Roster {
  let changed = false;
  const peers = roster.peers.map((p) => {
    if (p.agentName !== peerAgentName) return p;
    changed = true;
    return { ...p, membership: state };
  });
  return changed ? { ...roster, peers } : roster;
}

/** Persist a peer's membership state on an assistant's roster. Returns the
 *  updated roster; throws if the peer is not on the roster (so the caller can
 *  surface "invite them first" rather than silently no-op). */
export async function recordPeerMembership(
  agentName: string,
  peerAgentName: string,
  state: PeerMembership,
  baseDir?: string,
): Promise<Roster> {
  const roster = await loadRoster(agentName, { baseDir });
  if (!roster.peers.some((p) => p.agentName === peerAgentName)) {
    throw new Error(`${peerAgentName} is not an invited peer of ${agentName}`);
  }
  const next = setPeerMembership(roster, peerAgentName, state);
  await saveRoster(next, baseDir);
  return next;
}

export interface InvitePeerArgs {
  /** This assistant (the inviter). */
  owner: string;
  agentName: string;
  /** The inviter's Blocks identity (ownerId), recorded on the peer's side. */
  ownerId?: string;
  /** The peer being invited. */
  peerOwner: string;
  peerAgentName: string;
  /** The peer's Blocks identity (ownerId), recorded on the inviter's side. */
  peerOwnerId?: string;
  /** What the inviter offers to share with the peer (default: nothing). */
  sharePolicy?: SharePolicy;
  /** The inviter's own identity card (3.2), stored on the PEER's side so the
   *  peer can resolve a reference to the inviter by name. */
  selfCard?: PeerIdentityCard;
  /** The invited peer's identity card (3.2), stored on the INVITER's side so
   *  the inviter can resolve "Kayley"/"Kayley's assistant" → this peer. */
  peerCard?: PeerIdentityCard;
  baseDir?: string;
}

/**
 * Record a mutual invite in both rosters (app-level). The inviter's side
 * gets the supplied `sharePolicy` (what it offers); the peer's side gets
 * the default (share nothing) until that owner opts in. Identity is
 * exchanged MUTUALLY (3.2): each side records the other's minimal card
 * (name + capabilities). Does NOT grant a Blocks membership.
 */
export async function invitePeer(args: InvitePeerArgs): Promise<{ self: Roster; peer: Roster }> {
  if (args.agentName === args.peerAgentName) {
    throw new Error('an assistant cannot invite itself');
  }
  const since = new Date().toISOString();

  const self = addPeer(await loadRoster(args.agentName, { owner: args.owner, baseDir: args.baseDir }), withCard({
    owner: args.peerOwner,
    agentName: args.peerAgentName,
    since,
    sharePolicy: args.sharePolicy ?? defaultSharePolicy(),
    ...(args.peerOwnerId ? { ownerId: args.peerOwnerId } : {}),
  }, args.peerCard));
  const peer = addPeer(await loadRoster(args.peerAgentName, { owner: args.peerOwner, baseDir: args.baseDir }), withCard({
    owner: args.owner,
    agentName: args.agentName,
    since,
    sharePolicy: defaultSharePolicy(),
    ...(args.ownerId ? { ownerId: args.ownerId } : {}),
  }, args.selfCard));

  await saveRoster(self, args.baseDir);
  await saveRoster(peer, args.baseDir);
  return { self, peer };
}

/** Fold an identity card onto a peer record, normalizing aliases (lower-cased,
 *  deduped) and dropping empty fields so a card-less invite stays minimal. */
export function withCard(peer: Peer, card?: PeerIdentityCard): Peer {
  if (!card) return peer;
  const next: Peer = { ...peer };
  if (isNonEmptyString(card.displayName)) next.displayName = card.displayName.trim();
  if (isNonEmptyString(card.ownerName)) next.ownerName = card.ownerName.trim();
  if (isNonEmptyString(card.email)) next.email = card.email.trim();
  const aliases = normalizeStringList(card.aliases);
  if (aliases.length > 0) next.aliases = aliases;
  const capabilities = normalizeStringList(card.capabilities, { lowerCase: false });
  if (capabilities.length > 0) next.capabilities = capabilities;
  return next;
}

function normalizeStringList(value: unknown, opts: { lowerCase?: boolean } = {}): string[] {
  if (!Array.isArray(value)) return [];
  const lower = opts.lowerCase ?? true;
  return [...new Set(
    value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => (lower ? v.trim().toLowerCase() : v.trim()))
      .filter(Boolean),
  )];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Remove a peer relationship from BOTH rosters. */
export async function revokePeer(args: {
  agentName: string;
  peerAgentName: string;
  baseDir?: string;
}): Promise<{ self: Roster; peer: Roster }> {
  const self = removePeer(await loadRoster(args.agentName, { baseDir: args.baseDir }), args.peerAgentName);
  const peer = removePeer(await loadRoster(args.peerAgentName, { baseDir: args.baseDir }), args.agentName);
  await saveRoster(self, args.baseDir);
  await saveRoster(peer, args.baseDir);
  return { self, peer };
}

export async function listPeers(agentName: string, baseDir?: string): Promise<Peer[]> {
  return (await loadRoster(agentName, { baseDir })).peers;
}

/** Every roster on disk (one per assistant). Powers the PA-5 dashboard
 *  overview; returns an empty list when no rosters exist yet. */
export async function listRosters(baseDir?: string): Promise<Roster[]> {
  let entries;
  try {
    entries = await readdir(rosterDir(baseDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const rosters: Roster[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const agentName = entry.name.slice(0, -'.json'.length);
    if (!/^[a-zA-Z0-9_-]+$/u.test(agentName)) continue;
    rosters.push(await loadRoster(agentName, { baseDir }));
  }
  return rosters;
}

/** Delete a roster file (used by tests for cleanup). */
export async function deleteRoster(agentName: string, baseDir?: string): Promise<void> {
  await rm(rosterPath(agentName, baseDir), { force: true });
}

/* ===========================================================================
 * Pillar 3.3 — the roster-backed NAME RESOLVER.
 *
 * A natural reference ("Kayley", "Kayley's assistant", "@kayley", or the raw
 * handle "pa_kayley") resolves to exactly one invited peer, several (the
 * caller disambiguates), or none (an honest "not an invited peer"). It is
 * DATA-DRIVEN off the roster's handles/displayName/ownerName/aliases — there
 * is NO hardcoded name→handle table. The result mirrors `ContactResolution`
 * in contacts-store.ts (the email half of diagram F) so the runtime forks a
 * call-peer vs an email.* recipient through the SAME status shape.
 * ======================================================================== */

export type PeerResolution =
  | { status: 'matched'; peer: Peer }
  | { status: 'ambiguous'; candidates: Peer[] }
  | { status: 'unknown'; reference: string };

/**
 * Resolve a natural reference against a roster's peers. Case-insensitive,
 * word-boundary/whole-token (no substring false positives — "art" never
 * matches "smart"), and alias/possessive/@-mention/handle aware. Never
 * fabricates a `pa_<name>`: an unmatched reference is reported as unknown.
 */
export function resolvePeerReference(peers: Peer[], reference: string): PeerResolution {
  const ref = normalizePeerReference(reference);
  if (!ref) return { status: 'unknown', reference: reference.trim() };
  const matches = peers.filter((peer) => peerMatches(peer, ref));
  if (matches.length === 1) return { status: 'matched', peer: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  return { status: 'unknown', reference: reference.trim() };
}

/** Whole-token match against every identity surface of a peer. */
function peerMatches(peer: Peer, ref: string): boolean {
  const handle = peer.agentName.toLowerCase();
  if (handle === ref) return true;
  if (handleLocalName(handle) === ref) return true;
  if (peer.displayName) {
    const dn = peer.displayName.toLowerCase();
    if (dn === ref || firstNameOf(dn) === ref) return true;
  }
  if (peer.ownerName) {
    const on = peer.ownerName.toLowerCase();
    if (on === ref || firstNameOf(on) === ref) return true;
  }
  if (Array.isArray(peer.aliases) && peer.aliases.some((alias) => alias.toLowerCase() === ref)) return true;
  return false;
}

/** Strip a leading "pa_" so a handle "pa_kayley" matches the bare "kayley". */
function handleLocalName(handle: string): string {
  return handle.replace(/^pa[_-]/u, '');
}

function firstNameOf(name: string): string {
  return name.trim().toLowerCase().split(/\s+/u)[0] ?? '';
}

/**
 * Reduce a chat-style reference to a comparable token:
 *   "@kayley"            → "kayley"
 *   "Kayley's assistant" → "kayley"
 *   "Kayley's"           → "kayley"
 *   "pa_kayley"          → "pa_kayley"  (handle compared directly)
 */
function normalizePeerReference(reference: string): string {
  let ref = reference.trim().toLowerCase();
  ref = ref.replace(/^@+/u, '');
  ref = ref.replace(/[’']?s?\s+assistant\b/u, '');
  ref = ref.replace(/[’']s$/u, '');
  ref = ref.replace(/^[^a-z0-9@._-]+|[^a-z0-9._-]+$/gu, '').trim();
  return ref;
}
