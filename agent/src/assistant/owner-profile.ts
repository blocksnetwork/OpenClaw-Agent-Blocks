/**
 * owner-profile — the per-owner identity record (Pillar 0.1).
 *
 * Today the assistant knows nothing about *itself*: no name, email, or
 * timezone lives anywhere, so it can't sign mail, fill an email sender, or
 * reason in the owner's timezone instead of the server's. This store is the
 * missing self: one JSON file per owner at
 *   agent/data/profiles/<owner>.json   (gitignored, like integrations)
 *
 * It mirrors integration-store.ts deliberately — same sanitized filename
 * derivation, same "missing/malformed file behaves like empty" loader — so
 * there is one obvious place per-owner identity is read and written.
 *
 * Pure filesystem: no network, no SDK calls, fully deterministic. Loading a
 * profile that was never saved returns null (back-compat: every call site
 * must tolerate "no profile yet").
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sanitizeOwnerId } from '../integrations/integration-store.ts';

/** Optional working-hours hint the brain can use when proposing times. */
export interface WorkingHours {
  /** Local start time, "HH:MM" (24h). */
  start: string;
  /** Local end time, "HH:MM" (24h). */
  end: string;
}

/** The owner's self — who the assistant is acting as. Only `ownerId` is
 *  required; everything else is filled in progressively via the profile UI
 *  so an owner with no profile still routes (just without identity-aware
 *  steps like signing mail or owner-timezone booking). */
export interface OwnerProfile {
  ownerId: string;
  displayName?: string;
  email?: string;
  timezone?: string;
  workingHours?: WorkingHours;
  orgId?: string;
}

export interface OwnerProfileStoreOptions {
  baseDir?: string;
}

function profilesDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data/profiles', import.meta.url));
}

export function ownerProfilePath(ownerId: string, opts: OwnerProfileStoreOptions = {}): string {
  return `${profilesDir(opts.baseDir)}/${sanitizeOwnerId(ownerId)}.json`;
}

/**
 * Save (replace) an owner's profile. `ownerId` is taken from the argument,
 * not the record, so the on-disk file is always keyed to the real owner.
 */
export async function saveOwnerProfile(
  ownerId: string,
  profile: Omit<OwnerProfile, 'ownerId'> & { ownerId?: string },
  opts: OwnerProfileStoreOptions = {},
): Promise<OwnerProfile> {
  const trimmed = ownerId.trim();
  if (!trimmed) throw new Error('ownerId is required');
  const normalized = normalizeProfile(trimmed, profile);
  await mkdir(profilesDir(opts.baseDir), { recursive: true });
  await writeFile(
    ownerProfilePath(trimmed, opts),
    `${JSON.stringify(normalized, null, 2)}\n`,
    'utf8',
  );
  return normalized;
}

/**
 * Load an owner's profile, or null when none has been saved yet. A missing
 * or malformed file behaves like "no profile" rather than throwing, so the
 * runtime stays back-compatible for owners who never set one.
 */
export async function loadOwnerProfile(
  ownerId: string,
  opts: OwnerProfileStoreOptions = {},
): Promise<OwnerProfile | null> {
  const trimmed = ownerId.trim();
  if (!trimmed) return null;
  try {
    const raw = await readFile(ownerProfilePath(trimmed, opts), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return normalizeProfile(trimmed, parsed);
  } catch {
    // Missing or malformed files behave like an empty profile.
  }
  return null;
}

export async function removeOwnerProfile(
  ownerId: string,
  opts: OwnerProfileStoreOptions = {},
): Promise<void> {
  const trimmed = ownerId.trim();
  if (!trimmed) return;
  await rm(ownerProfilePath(trimmed, opts), { force: true });
}

function normalizeProfile(ownerId: string, value: Record<string, unknown> | OwnerProfile): OwnerProfile {
  const record = value as Record<string, unknown>;
  const profile: OwnerProfile = { ownerId };
  const displayName = trimmedString(record.displayName);
  const email = trimmedString(record.email);
  const timezone = trimmedString(record.timezone);
  const orgId = trimmedString(record.orgId);
  const workingHours = normalizeWorkingHours(record.workingHours);
  if (displayName) profile.displayName = displayName;
  if (email) profile.email = email;
  if (timezone) profile.timezone = timezone;
  if (workingHours) profile.workingHours = workingHours;
  if (orgId) profile.orgId = orgId;
  return profile;
}

function normalizeWorkingHours(value: unknown): WorkingHours | undefined {
  if (!isRecord(value)) return undefined;
  const start = trimmedString(value.start);
  const end = trimmedString(value.end);
  if (!start || !end) return undefined;
  return { start, end };
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
