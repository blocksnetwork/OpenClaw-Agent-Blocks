/**
 * authorize — the application-layer owner gate for personal assistants
 * (docs/PERSONAL-ASSISTANT-PLAN.md → "Identity & authorization model").
 *
 * A private `pa_<owner>` agent must only act on owner-requests that come
 * from its bound owner. Per the Phase PA-0 finding, caller identity on a
 * task is `ownerId`/`orgId` (callerClaims was empty), so this gate keys on
 * those — never on callerClaims (decision D6).
 *
 * Defense-in-depth: even with network-level membership privacy, this
 * handler check runs first and **fails closed** — an assistant with no
 * bound owner refuses everything rather than serving an ambient caller.
 *
 * Pure and offline: no network, no SDK calls, fully deterministic.
 */

import type { Roster } from '../assistant/assistant-roster.ts';

/** Who is allowed to drive this assistant. At least one field must be set. */
export interface OwnerPolicy {
  ownerId?: string;
  orgId?: string;
}

/** Minimal caller identity read off the task (a StartTaskMessage subset). */
export interface CallerIdentity {
  ownerId?: string;
  orgId?: string;
}

export interface AuthorizeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Build the owner policy baked into a served assistant from the
 * environment. PA-2 sets these at serve time (literal substitution per
 * owner); here they ride in via env so nothing is generated as code.
 */
export function ownerPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OwnerPolicy {
  const ownerId = env.PA_OWNER_ID?.trim();
  const orgId = env.PA_OWNER_ORG_ID?.trim();
  return {
    ...(ownerId ? { ownerId } : {}),
    ...(orgId ? { orgId } : {}),
  };
}

/**
 * Authorize an owner-request. Returns `{ ok: true }` only when the caller
 * matches every configured field of the policy. Fails closed when the
 * policy binds no owner at all.
 */
export function authorizeOwner(caller: CallerIdentity, policy: OwnerPolicy): AuthorizeResult {
  const hasOwner = typeof policy.ownerId === 'string' && policy.ownerId.length > 0;
  const hasOrg = typeof policy.orgId === 'string' && policy.orgId.length > 0;

  if (!hasOwner && !hasOrg) {
    return {
      ok: false,
      reason: 'no owner bound: set PA_OWNER_ID (or PA_OWNER_ORG_ID) before serving a private assistant',
    };
  }
  if (hasOwner && caller.ownerId !== policy.ownerId) {
    return { ok: false, reason: 'caller ownerId does not match the bound owner' };
  }
  if (hasOrg && caller.orgId !== policy.orgId) {
    return { ok: false, reason: 'caller orgId does not match the bound org' };
  }
  return { ok: true };
}

/**
 * Authorize an A2A-request (Phase PA-4, docs/PERSONAL-ASSISTANT-PLAN.md →
 * "Identity & authorization model"). The peer roster IS the invite
 * allow-list: a caller is admitted only when `fromHandle` is a recorded
 * peer AND — when that peer carries a recorded `ownerId` — the caller's
 * ownerId matches it (defense-in-depth; a peer with no recorded ownerId is
 * tolerated for now, pre-PA-4 rosters stay valid).
 *
 * Fails closed: a stranger (not in the roster) is always refused, never
 * discovered — private peers aren't findable.
 */
export function authorizeInvited(
  caller: CallerIdentity,
  fromHandle: string,
  roster: Roster,
): AuthorizeResult {
  const peer = roster.peers.find((p) => p.agentName === fromHandle);
  if (!peer) {
    return { ok: false, reason: `"${fromHandle}" is not an invited peer in this roster` };
  }
  if (typeof peer.ownerId === 'string' && peer.ownerId.length > 0 && caller.ownerId !== peer.ownerId) {
    return { ok: false, reason: 'caller ownerId does not match the invited peer' };
  }
  return { ok: true };
}
