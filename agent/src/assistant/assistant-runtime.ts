/**
 * Personal-assistant runtime — the shared body of every pa_<owner>
 * handler (and the pa_test_private probe).
 *
 * Flow (docs/PERSONAL-ASSISTANT-PLAN.md, end-state A):
 *   authorize(owner) → runSkill('personal_assistant') → act on the plan.
 *
 * - Owner gate first (defense-in-depth). Only the bound owner may drive
 *   the assistant; an unbound policy fails closed. Keyed on ownerId/orgId
 *   per the PA-0 finding (D6).
 * - The brain (Phase PA-1) decides intent and returns a structured plan
 *   { ok, reply, actions[] }. It stays deterministic by default. Set
 *   PA_BRAIN_LIVE=1 while running live to try the gateway brain first;
 *   any gateway error or malformed envelope falls back to the offline stub.
 * - Delegation is forced ONLINE (offline: false) so call-specialist hits
 *   the real network, reusing the exact connect()/discover()/call() seam
 *   the chat already uses. answer-direct returns the brain's reply.
 * - A2A (call-peer) is Phase PA-4 (end-state B), wired in BOTH directions:
 *     INBOUND  — a peer asks this assistant: gate on the invite roster,
 *                apply the owner's share policy BEFORE the brain, answer.
 *     OUTBOUND — the brain returns call-peer: resolve the handle from the
 *                roster (never discover), cap the daily call count, then
 *                send the scoped A2A request to the peer.
 *   The owner threads this assistant's own handle + roster/budget dirs +
 *   shareable owner context in via `opts` — nothing is hardcoded.
 *
 * This module carries NO per-owner identity — the caller passes the
 * OwnerPolicy, so the same vetted code serves every assistant.
 */

import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  HandlerResult,
  StartTaskMessage,
  TaskContext,
} from '@blocks-network/sdk';

import { resolveAgentBlocksCredential } from '../blocks/agent-keyring.ts';
import { connect } from '../blocks/blocks-client.ts';
import { runSkill } from '../blocks/openclaw-client.ts';
import { understandsImage } from '../routing/intent-tags.ts';
import { authorizeOwner, authorizeInvited, type OwnerPolicy } from '../server/authorize.ts';
import { loadRoster, resolvePeerReference, type Peer } from './assistant-roster.ts';
import {
  applySharePolicy,
  buildA2ARequest,
  parseA2ARequest,
  MAX_A2A_HOPS,
  type A2ARequest,
  type OwnerContext,
} from '../a2a/a2a.ts';
import { recordA2ACall, withinDailyCap } from '../a2a/a2a-budget.ts';
import { recordHop } from '../a2a/a2a-audit.ts';
import {
  bookingResultSucceeded,
  findBookingProposal,
  findWrittenBooking,
  recordBookingWrite,
  type BookingAuditEntry,
} from '../integrations/booking-audit.ts';
import { googleIntegrationEnvForOwner, loadIntegration } from '../integrations/integration-store.ts';
import { loadOwnerProfile, type OwnerProfile } from './owner-profile.ts';
import {
  loadContacts,
  resolveContactReference,
  isEmailAddress,
  type Contact,
} from './contacts-store.ts';
import {
  findPendingPlan,
  recordPendingPlan,
  resolvePendingPlan,
  type LedgerEntry,
  type PendingPlanEntry,
} from './pending-plan.ts';
import type { ArtifactOut, CallResult, FileArtifact, DiscoveredAgent } from '../types.ts';
import {
  loadRuntimeCatalog,
  searchCatalog,
  toCatalogAgent,
  categorize,
  categorizeCatalog,
  rankedAgentView,
  formatSearchReply,
  formatCategorizeReply,
  detectModelFacet,
  VISIBILITY_NOTE,
  type CatalogAgent,
  type CatalogCategory,
  type SearchFacets,
} from '../blocks/catalog-index.ts';
import {
  asStepRef,
  DEFAULT_SUBSTITUTION_FIELD,
  validatePlan,
  type AssistantAction,
  type AssistantPlan,
  type RunIf,
} from './plan-schema.ts';

const MAX_INPUT_CHARS = 2_000;
/** Size guard (Pillar 1.2): a value threaded from an earlier step into a
 *  later one is clamped to this many chars so a long brief can't push the
 *  next step's prompt over MAX_INPUT_CHARS. */
const THREAD_MAX_CHARS = 1_400;
const WRITE_TOOLS = new Set(['calendar.createEvent', 'email.send']);
const READONLY_REPLY = 'I’m read-only: I can look this up and notify you, but I won’t send email, create drafts, or book events.';
const BOOKING_ENABLED_REPLY = 'I’m read-only for email: I can help book calendar events after you confirm, but I won’t send email or create drafts.';

/** Tools that act on the owner's world on their behalf. A read-only assistant
 *  refuses these BEFORE any MCP call, regardless of what the brain planned, so
 *  a shared/owned instance can look things up and notify — never send mail or
 *  book as you. `email.draft` is included because a draft still writes content
 *  into the owner's mailbox. */
const READONLY_BLOCKED_TOOLS = new Set(['calendar.createEvent', 'email.draft', 'email.send']);

let cachedBrainLive: boolean | undefined;
let loggedBrainFallback = false;

/**
 * Choose which discovered agent to hire for a capability tag.
 *
 * Pillar 2 relevance ranking — NOT a hardcoded preferred-handle bias. The
 * runtime used to prefer a fixed set of agents we serve ourselves; that made
 * delegation depend on *us* serving those tags, so a third-party developer's
 * catalog (or a deploy that doesn't self-serve) would route worse. Instead we
 * rank the agents that already advertise the tag and hire the best match by
 * capability, returning the "why" so the route is honest. Falls back to
 * discovery order when ranking can't separate sparse-metadata agents, so a
 * usable agent is never dropped.
 */
function chooseSpecialist(
  agents: DiscoveredAgent[],
  tag: string,
  prompt?: string,
): { handle: string; whyMatched: string } | null {
  if (agents.length === 0) return null;
  const ranked = searchCatalog(agents.map(toCatalogAgent), {
    query: [tag, prompt].filter((s): s is string => Boolean(s && s.trim())).join(' ').trim() || tag,
  });
  const top = ranked.recommendation;
  if (top) return { handle: top.agent.handle, whyMatched: top.whyMatched };
  return { handle: agents[0].handle, whyMatched: `first available "${tag}" agent` };
}

export type { AssistantAction, AssistantPlan } from './plan-schema.ts';
export type { OwnerProfile } from './owner-profile.ts';
export type { Contact } from './contacts-store.ts';

export type RunSkillImpl = (
  skill: string,
  inputs: Record<string, unknown>,
  opts?: { offline?: boolean },
) => Promise<unknown>;

export interface PlanRequestOpts {
  /** Runtime offline switch. When true, the live brain is never called. */
  offline: boolean;
  /** Override PA_BRAIN_LIVE for tests; defaults to the env switch. */
  live?: boolean;
  /** Injectable skill runner for checks. */
  runSkillImpl?: RunSkillImpl;
}

/** The transport seam for OUTBOUND A2A: send a scoped request to a peer by
 *  handle. Kept behind the same offline switch the brain uses so the check
 *  runs with no key; production injects a live sender. */
export type SendA2A = (
  handle: string,
  request: A2ARequest,
  opts: { offline: boolean },
) => Promise<unknown>;

/** Optional same-process A2A fallback for hosted demo peers that share one
 *  bridge. Live Blocks transport still runs first; this is only used when the
 *  live response has no readable artifact/reply. */
export type LocalA2A = (
  peer: Peer,
  request: A2ARequest,
  opts: { callerOwnerId?: string; offline: boolean },
  ctx?: TaskContext,
) => Promise<unknown>;

/** The seam for `use-integration` actions (Phase 8): run a named OpenClaw
 *  integration tool (e.g. `calendar.freeBusy`) and return its result. Kept
 *  behind the same offline switch as the brain/A2A so the check runs with
 *  no key; production injects a sender that calls the gateway's MCP tools. */
export type RunIntegration = (
  tool: string,
  args: Record<string, unknown>,
  opts: { offline: boolean },
) => Promise<unknown>;

export type BookingPolicy = 'confirm' | 'auto';

/** Everything the runtime needs to talk A2A, threaded in by the owner so
 *  nothing is hardcoded per-assistant. */
export interface RunAssistantOpts {
  /** This assistant's own handle (e.g. 'pa_alice'). Enables the inbound
   *  loop guard + roster gate and the outbound 'from'. Defaults to env
   *  PA_AGENT_NAME; without it, A2A is inert (owner-only behaviour). */
  selfHandle?: string;
  /** Base dir for the peer roster store (tests pass a temp dir). */
  rosterBaseDir?: string;
  /** Base dir for the daily A2A budget counter (tests pass a temp dir). */
  budgetBaseDir?: string;
  /** Base dir for the A2A hop audit trail (tests pass a temp dir). */
  auditBaseDir?: string;
  /** The owner's shareable context — the source the share policy filters
   *  before the brain sees it (mock values in the offline check). */
  ownerContext?: OwnerContext;
  /** The owner's identity profile (Pillar 0): name/email/timezone the brain
   *  uses to sign mail, fill a sender, and reason in the owner's timezone.
   *  Absent = back-compat (no profile set yet). */
  ownerProfile?: OwnerProfile;
  /** Base dir for the per-owner profile store (tests pass a temp dir). */
  profileStoreBaseDir?: string;
  /** Base dir for the per-owner contacts store (tests pass a temp dir). */
  contactsStoreBaseDir?: string;
  /** Pre-loaded contacts (tests can inject directly instead of a baseDir).
   *  When absent, recipient resolution loads them from contactsStoreBaseDir. */
  contacts?: Contact[];
  /** Override the OUTBOUND transport (defaults to the offline stub). */
  sendA2A?: SendA2A;
  /** Same-bridge fallback for live peer calls whose Blocks response is empty. */
  localA2A?: LocalA2A;
  /** Override the integration runner (defaults to the offline stub). The
   *  live runner calls the gateway's MCP tools (Phase 8.0). */
  runIntegration?: RunIntegration;
  /** Write-action policy: `auto` writes immediately; `confirm` proposes a
   *  deterministic token first. Defaults to PA_BOOKING_POLICY or auto. */
  bookingPolicy?: BookingPolicy;
  /** Base dir for the write audit/idempotency store (tests pass a temp dir). */
  bookingAuditBaseDir?: string;
  /** Base dir for the pending-plan/resume store (Pillar 1.0). Defaults to
   *  bookingAuditBaseDir so one per-owner state dir holds both. */
  pendingPlanBaseDir?: string;
  /** Base dir for per-owner integration credentials (tests pass a temp dir). */
  integrationStoreBaseDir?: string;
  /** Optional deterministic idempotency id for write checks/retries. */
  writeIdempotencyId?: string;
  /** Injectable skill runner for checks that need a precise plan. */
  runSkillImpl?: RunSkillImpl;
  /** Force the offline switch (defaults to FOUNDATION_OFFLINE !== '0'). */
  offline?: boolean;
}

export interface MultiTenantAssistantOpts {
  /** Owners this hosted assistant may serve. Defaults to PA_OWNER_IDS plus PA_OWNER_ID. */
  ownerIds?: readonly string[];
  /** When true, authenticated HTTP callers may create/use owner-scoped state
   *  without pre-registering the owner in PA_OWNER_IDS. Use only behind the
   *  dashboard auth layer; unauthenticated Blocks tasks still need a bound
   *  owner list unless their caller has already been authenticated upstream. */
  allowUnlistedOwners?: boolean;
  /** Base dir for all owner-scoped runtime state. */
  stateBaseDir?: string;
  /** Shared per-owner integration token store. Defaults under stateBaseDir. */
  integrationStoreBaseDir?: string;
  /** Shared per-owner identity profile store. Defaults under stateBaseDir. */
  profileStoreBaseDir?: string;
  /** Shared per-owner contacts store. Defaults under stateBaseDir. */
  contactsStoreBaseDir?: string;
  /** Optional org binding per owner. */
  orgIdByOwnerId?: Record<string, string | undefined>;
  /** Exact assistant handle per owner. */
  selfHandleByOwnerId?: Record<string, string | undefined>;
  /** Prefix used when deriving selfHandle from ownerId. Defaults to "pa_". */
  selfHandlePrefix?: string;
  /** Shareable owner context per owner, filtered by that owner's roster policies. */
  ownerContextByOwnerId?: Record<string, OwnerContext | undefined>;
  /** Lazy owner context resolver for callers that keep context outside env/config. */
  ownerContextForOwner?: (ownerId: string) => OwnerContext | undefined | Promise<OwnerContext | undefined>;
  /** Integration runner per owner; useful for tests and owner-specific live bridges. */
  runIntegrationByOwnerId?: Record<string, RunIntegration | undefined>;
  runIntegrationForOwner?: (ownerId: string) => RunIntegration | undefined | Promise<RunIntegration | undefined>;
  /** Shared defaults copied into the per-owner RunAssistantOpts before scoped fields. */
  runAssistantDefaults?: RunAssistantOpts;
  /** Env source for PA_OWNER_IDS/PA_OWNER_ID. */
  env?: NodeJS.ProcessEnv;
}

export interface MultiTenantAssistantRoute {
  ownerId: string;
  ownerKey: string;
  policy: OwnerPolicy;
  opts: RunAssistantOpts;
}

/**
 * Route one hosted PA instance by Blocks ownerId. This is the PA-7 bridge:
 * every request is bound to its own owner policy and owner-scoped state
 * before the shared runtime runs. Unknown or unbound owners fail closed.
 */
export async function runMultiTenantAssistant(
  task: StartTaskMessage,
  ctx?: TaskContext,
  opts: MultiTenantAssistantOpts = {},
): Promise<HandlerResult> {
  const ownerId = task.ownerId?.trim();
  const allowed = allowedOwnerIds(opts);
  if (!ownerId) {
    ctx?.reportStatus('personal agent: refused (no ownerId on task)');
    return jsonArtifact({ ok: false, error: 'forbidden', reason: 'no ownerId on task' });
  }
  if (!opts.allowUnlistedOwners && !allowed.has(ownerId)) {
    ctx?.reportStatus('personal agent: refused (owner is not bound to this hosted assistant)');
    return jsonArtifact({
      ok: false,
      error: 'forbidden',
      reason: allowed.size === 0
        ? 'no owners bound: set PA_OWNER_IDS before serving a multi-tenant private assistant'
        : 'caller ownerId is not bound to this hosted assistant',
    });
  }

  const route = await buildMultiTenantAssistantRoute(ownerId, opts);
  return runAssistant(task, ctx, route.policy, route.opts);
}

export async function buildMultiTenantAssistantRoute(
  ownerId: string,
  opts: MultiTenantAssistantOpts = {},
): Promise<MultiTenantAssistantRoute> {
  const trimmedOwnerId = ownerId.trim();
  if (!trimmedOwnerId) throw new Error('ownerId is required');

  const env = opts.env ?? process.env;
  const ownerKey = ownerStateKey(trimmedOwnerId);
  const stateBaseDir = multiTenantStateBaseDir(opts.stateBaseDir, env);
  const defaults = opts.runAssistantDefaults ?? {};
  const ownerContext =
    opts.ownerContextByOwnerId?.[trimmedOwnerId]
    ?? (opts.ownerContextForOwner ? await opts.ownerContextForOwner(trimmedOwnerId) : undefined);
  const runIntegration =
    opts.runIntegrationByOwnerId?.[trimmedOwnerId]
    ?? (opts.runIntegrationForOwner ? await opts.runIntegrationForOwner(trimmedOwnerId) : undefined);

  const orgId = opts.orgIdByOwnerId?.[trimmedOwnerId]?.trim();
  const profileStoreBaseDir = opts.profileStoreBaseDir
    ?? defaults.profileStoreBaseDir
    ?? join(stateBaseDir, 'profiles');
  const contactsStoreBaseDir = opts.contactsStoreBaseDir
    ?? defaults.contactsStoreBaseDir
    ?? join(stateBaseDir, 'contacts');
  // Load the owner's identity once per route so the runtime and the brain
  // both see "who I am" without re-reading it per step. Missing profile =>
  // null (back-compat).
  const ownerProfile = await loadOwnerProfile(trimmedOwnerId, { baseDir: profileStoreBaseDir });

  const policy: OwnerPolicy = { ownerId: trimmedOwnerId, ...(orgId ? { orgId } : {}) };
  const perOwnerOpts: RunAssistantOpts = {
    ...defaults,
    selfHandle: selfHandleForOwner(trimmedOwnerId, opts),
    rosterBaseDir: join(stateBaseDir, ownerKey, 'rosters'),
    budgetBaseDir: join(stateBaseDir, ownerKey, 'budget'),
    auditBaseDir: join(stateBaseDir, ownerKey, 'audit'),
    bookingAuditBaseDir: join(stateBaseDir, ownerKey, 'booking-audit'),
    integrationStoreBaseDir: opts.integrationStoreBaseDir
      ?? defaults.integrationStoreBaseDir
      ?? join(stateBaseDir, 'integrations'),
    profileStoreBaseDir,
    contactsStoreBaseDir,
    ...(ownerContext ? { ownerContext } : {}),
    ...(ownerProfile ? { ownerProfile } : {}),
    ...(runIntegration ? { runIntegration } : {}),
  };

  return { ownerId: trimmedOwnerId, ownerKey, policy, opts: perOwnerOpts };
}

export function multiTenantStateBaseDir(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return override?.trim()
    || env.PA_MULTI_TENANT_STATE_DIR?.trim()
    || fileURLToPath(new URL('../../data/pa-tenants', import.meta.url));
}

export function configuredOwnerIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const multi = (env.PA_OWNER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const legacy = env.PA_OWNER_ID?.trim();
  return [...new Set([...multi, ...(legacy ? [legacy] : [])])];
}

export function ownerStateKey(ownerId: string): string {
  const trimmed = ownerId.trim();
  if (!trimmed) throw new Error('ownerId is required');
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 48);
  const digest = createHash('sha256').update(trimmed).digest('hex').slice(0, 8);
  return `${safe || 'owner'}_${digest}`;
}

export function selfHandleForOwner(ownerId: string, opts: Pick<MultiTenantAssistantOpts, 'selfHandleByOwnerId' | 'selfHandlePrefix'> = {}): string {
  const exact = opts.selfHandleByOwnerId?.[ownerId]?.trim();
  if (exact) return exact;
  return `${opts.selfHandlePrefix ?? 'pa_'}${ownerStateKey(ownerId)}`;
}

function allowedOwnerIds(opts: MultiTenantAssistantOpts): Set<string> {
  return new Set(opts.ownerIds?.map((value) => value.trim()).filter(Boolean) ?? configuredOwnerIds(opts.env));
}

/**
 * Run one request end-to-end for a personal assistant bound to `policy`.
 * Detects an A2A-request first (a peer asking); otherwise serves the owner.
 * Returns a Blocks HandlerResult.
 */
export async function runAssistant(
  task: StartTaskMessage,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  opts: RunAssistantOpts = {},
): Promise<HandlerResult> {
  const selfHandle = (opts.selfHandle ?? process.env.PA_AGENT_NAME ?? '').trim();
  const offline = opts.offline ?? process.env.FOUNDATION_OFFLINE !== '0';

  // (a) INBOUND A2A — a peer's assistant is asking. Detected before the
  //     owner gate, because the caller here is a peer, not the owner.
  const inbound = parseA2ARequest(task);
  if (inbound) {
    return runInboundA2A(inbound, task, ctx, selfHandle, policy, opts);
  }

  // Owner gate first.
  const auth = authorizeOwner(task, policy);
  if (!auth.ok) {
    ctx?.reportStatus('personal agent: refused (caller is not the owner)');
    return jsonArtifact({ ok: false, error: 'forbidden', reason: auth.reason });
  }

  const text = readText(task);
  const imageContext = readImageContext(task);
  // An image-only turn (a picture with no typed words) is a valid request now
  // that the description rides as structured context — only a turn with NO text
  // AND no image is genuinely empty.
  if (!text.trim() && imageContext.length === 0) return jsonArtifact({ ok: false, error: 'empty request' });
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`input too long: ${text.length} chars (max ${MAX_INPUT_CHARS})`);
  }

  const confirmToken = parseConfirmToken(text);
  if (confirmToken) {
    if (readOnlyEnabled() && !calendarBookingAllowed()) return readOnlyRefusal({ confirmToken });
    // Pillar 1.4: a confirm token can resume a parked MULTI-step plan, not
    // just a lone write. If one is parked under this token, run the gated
    // write and continue the remaining steps; otherwise fall back to the
    // single-write confirm path.
    const pending = await findPendingPlan(confirmToken, pendingPlanOpts(opts));
    if (pending) {
      return resumeConfirmedPlan(pending, confirmToken, ctx, policy, selfHandle, offline, opts);
    }
    return runConfirmedWrite(confirmToken, ctx, policy, offline, opts);
  }

  // (3.3/UI.10) A disambiguation pick resumes a parked plan: the pick carries
  // the resume token + the chosen peer handle. Route it to the parked plan so
  // resume re-runs ONLY the peer step (idempotency), with the chosen handle.
  const pick = parseResumePick(text);
  if (pick) {
    const parked = await findPendingPlan(pick.resumeToken, pendingPlanOpts(opts));
    if (parked && parked.reason === 'disambiguation') {
      return resumeDisambiguatedPlan(parked, pick, ctx, policy, selfHandle, offline, opts);
    }
  }

  // (Phase 2) An attached image that's only being asked ABOUT — "what is this",
  // "give me a caption", or no words at all — is answered DETERMINISTICALLY
  // from the already-extracted description. The picture was read up-front, so
  // there is nothing left to plan or delegate; this beats the brain so the word
  // "image" can never be re-classified into image *generation*. A turn that
  // asks for MORE (summarize it, then email it…) falls through to the planner,
  // which receives the description as structured `attachments`.
  if (imageContext.length > 0 && (!text.trim() || understandsImage(text))) {
    ctx?.reportStatus('personal agent: answering from the image we read');
    return jsonArtifact({ ok: true, reply: imageContextReply(imageContext), actions: [] });
  }

  // The brain decides intent and returns a structured plan. The live brain
  // is opt-in and falls back to the deterministic stub on any failure. The
  // owner profile rides in the inputs (Pillar 0.3) so the brain can sign
  // mail, fill a sender, and reason in the owner's timezone.
  ctx?.reportStatus('personal agent: planning…');
  const plan = await planRequest(
    {
      request: text,
      ...ownerProfilePlanInputs(opts.ownerProfile),
      // Structured image context for compound asks ("summarize this image,
      // then …"): the brain threads the description into its steps instead of
      // re-reading a string smashed into the prompt.
      ...(imageContext.length > 0
        ? { attachments: imageContext.map((description) => ({ kind: 'image', description })) }
        : {}),
    },
    { offline, runSkillImpl: opts.runSkillImpl },
  );
  const executablePlan = repairPeerCoordinationPlan(text, plan);

  // (Pillar 1.3) A compound plan runs through the ordered step executor,
  // which threads each result into the next and synthesizes ONE reply. A
  // single-step plan keeps the original byte-for-byte dispatch below so
  // every existing behaviour/check is unchanged.
  const steps = executablePlan.steps ?? executablePlan.actions ?? [];
  if (steps.length > 1) {
    return runStepPlan(executablePlan, ctx, policy, selfHandle, offline, opts);
  }

  const action = steps[0];

  // No action, or an explicit direct answer → return the brain's reply.
  // Profile/identity questions are sourced from the owner profile in the
  // runtime too, so the deterministic fallback planner can still answer them
  // honestly instead of returning a generic placeholder.
  if (!action || action.kind === 'answer-direct') {
    return jsonArtifact({
      ok: true,
      reply: directProfileReply(text, opts.ownerProfile) ?? executablePlan.reply,
      actions: executablePlan.actions ?? [],
    });
  }

  // (b) OUTBOUND A2A — the brain wants to ask a peer's assistant.
  if (action.kind === 'call-peer') {
    const result = await runOutboundA2A(action, executablePlan, ctx, policy, selfHandle, offline, opts);
    const payload = parseHandlerPayload(result);
    // Ambiguous single-step reference → park a one-step plan for the
    // disambiguation round-trip (mirrors the multi-step path) so the owner's
    // pick resumes it and runs the peer step exactly once. Never auto-pick.
    if (payload.needsMoreInfo === true && payload.peerResolution === 'ambiguous') {
      return parkSinglePeerDisambiguation(executablePlan, action, payload, policy, opts);
    }
    return result;
  }

  // (c) Integration — the brain wants to act in the owner's own world
  //     (read the calendar, etc.) through an OpenClaw MCP tool (Phase 8).
  if (action.kind === 'use-integration') {
    return runUseIntegration(action, executablePlan, ctx, policy, offline, opts);
  }

  // Catalog search — inspect Blocks discovery results without hardcoding
  // handles or calling an agent.
  if (action.kind === 'search-blocks-catalog') {
    return runSearchBlocksCatalog(action, ctx, offline);
  }

  // call-specialist → delegate to a network agent by skill tag.
  const tag = action.tag ?? 'summarize';
  const prompt = action.prompt ?? text;
  ctx?.reportStatus(`personal agent: delegating to a "${tag}" specialist…`);

  const session = await connect({
    offline: false,
    onPartial: (e) => ctx?.reportStatus(`${e.handle}: ${e.message}`),
  });

  try {
    const agents = await session.discover(tag);
    if (agents.length === 0) {
      return jsonArtifact({
        ok: true,
        reply: `I couldn't find any "${tag}" agent on the network right now.`,
        delegatedTo: null,
      });
    }

    const chosen = chooseSpecialist(agents, tag, prompt);
    if (!chosen) {
      return jsonArtifact({
        ok: true,
        reply: `I couldn't find any "${tag}" agent on the network right now.`,
        delegatedTo: null,
      });
    }
    ctx?.reportStatus(`hiring ${chosen.handle} (${tag} — ${chosen.whyMatched})…`);

    const result = await session.call(chosen.handle, tag, { text: prompt });
    return await passthrough(result, chosen.handle, tag);
  } finally {
    session.close();
  }
}

/**
 * INBOUND A2A — answer a peer's scoped question. Loop guard + hop cap +
 * invite-roster gate, then redact the owner's context to the peer's share
 * policy BEFORE the brain runs (so the LLM can't leak what it never saw).
 */
async function runInboundA2A(
  request: A2ARequest,
  task: StartTaskMessage,
  ctx: TaskContext | undefined,
  selfHandle: string,
  policy: OwnerPolicy,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  // Loop guard: never answer a request that claims to come from us.
  if (selfHandle && request.from === selfHandle) {
    ctx?.reportStatus('personal agent: refused A2A (loop — from == self)');
    return jsonArtifact({ ok: false, error: 'a2a-loop-refused' });
  }
  // Hop cap: a runaway chain self-terminates.
  if (request.hop > MAX_A2A_HOPS) {
    ctx?.reportStatus(`personal agent: refused A2A (hop ${request.hop} > ${MAX_A2A_HOPS})`);
    return jsonArtifact({ ok: false, error: 'a2a-hop-cap' });
  }
  if (!selfHandle) {
    return jsonArtifact({ ok: false, error: 'forbidden', reason: 'assistant handle not configured for A2A' });
  }

  // Invite-roster gate (the allow-list); fails closed for strangers.
  const roster = await loadRoster(selfHandle, { baseDir: opts.rosterBaseDir });
  const auth = authorizeInvited(task, request.from, roster);
  if (!auth.ok) {
    ctx?.reportStatus('personal agent: refused A2A (caller is not an invited peer)');
    return jsonArtifact({ ok: false, error: 'forbidden', reason: auth.reason });
  }

  // Redact BEFORE the brain: only what this owner shares with this peer.
  const peer = roster.peers.find((p) => p.agentName === request.from);
  const shared = applySharePolicy(opts.ownerContext ?? {}, peer?.sharePolicy ?? { freeBusy: false, meetingTitles: false });

  ctx?.reportStatus(`personal agent: answering A2A "${request.intent}" (share-policy filtered)`);
  const offline = opts.offline ?? process.env.FOUNDATION_OFFLINE !== '0';

  if (isFreeBusyA2AIntent(request.intent)) {
    if (peer?.sharePolicy?.freeBusy !== true) {
      await recordInboundHop(request, selfHandle, opts, 'refused');
      return jsonArtifact({
        ok: true,
        a2a: true,
        intent: request.intent,
        from: request.from,
        threadId: request.threadId,
        shared,
        reply: "I'm not allowed to share free/busy details with that assistant.",
      });
    }

    const action: AssistantAction = {
      kind: 'use-integration',
      tool: 'calendar.freeBusy',
      args: { query: request.intent },
      id: 'step1',
    };
    const plan: AssistantPlan = {
      ok: true,
      reply: "I'll check my calendar for that window.",
      steps: [action],
      actions: [action],
    };
    const result = await runUseIntegration(action, plan, ctx, policy, offline, opts);
    const payload = parseHandlerPayload(result);
    const reply = a2aCalendarReply(payload);

    await recordInboundHop(request, selfHandle, opts, 'answered');

    return jsonArtifact({
      ok: payload.ok !== false,
      a2a: true,
      intent: request.intent,
      from: request.from,
      threadId: request.threadId,
      shared,
      reply,
      ...(isRecord(payload.integration) ? { integration: payload.integration } : {}),
      ...(isRecord(payload.result) ? { result: payload.result } : {}),
      ...(isRecord(payload.needsConnection) ? { needsConnection: payload.needsConnection } : {}),
    });
  }

  const plan = await planRequest({ request: request.intent, ...shared }, { offline });

  // Audit the answered hop for the PA-5 dashboard overview.
  await recordInboundHop(request, selfHandle, opts, 'answered');

  return jsonArtifact({
    ok: true,
    a2a: true,
    intent: request.intent,
    from: request.from,
    threadId: request.threadId,
    shared,
    reply: plan.reply,
  });
}

function isFreeBusyA2AIntent(intent: string): boolean {
  const normalized = intent.toLowerCase();
  return /\b(free[-\s]?busy|availability|available|both free|mutual availability|find a time|calendar)\b/u.test(normalized);
}

async function recordInboundHop(
  request: A2ARequest,
  selfHandle: string,
  opts: RunAssistantOpts,
  outcome: 'answered' | 'refused',
): Promise<void> {
  await recordHop(
    {
      direction: 'in',
      from: request.from,
      to: selfHandle,
      intent: request.intent,
      hop: request.hop,
      threadId: request.threadId,
      outcome,
    },
    { baseDir: opts.auditBaseDir },
  );
}

function a2aCalendarReply(payload: Record<string, unknown>): string {
  if (isRecord(payload.needsConnection)) {
    return 'I need my Google account connected before I can share live availability.';
  }
  const reply = stringField(payload.reply);
  if (!reply) return 'I checked my calendar for that window.';
  return reply
    .replace(/^I checked your calendar and you look/u, 'I checked my calendar and I look')
    .replace(/^I checked your calendar/u, 'I checked my calendar');
}

/** Capability category the brain may pass via `action.category`, or undefined. */
function asCatalogCategory(value: string | undefined): CatalogCategory | undefined {
  const map: Record<string, CatalogCategory> = {
    image: 'image', 'text-to-image': 'image',
    'audio-to-text': 'audio-to-text', transcribe: 'audio-to-text', 'speech-to-text': 'audio-to-text',
    'text-to-audio': 'text-to-audio', 'text-to-speech': 'text-to-audio', narrate: 'text-to-audio',
    vision: 'vision', 'image-to-text': 'vision',
    summarize: 'summarize', headline: 'headline', data: 'data', other: 'other',
  };
  return value ? map[value.toLowerCase()] : undefined;
}

/** A "categorize / what kinds of agents exist" request, as opposed to a
 *  targeted relevance search. */
function isCategorizeRequest(query: string, category: string | undefined): boolean {
  if (category && /categor|overview|kinds?|types?/u.test(category)) return true;
  return /\b(categor\w+|what kinds?|what types?|overview|taxonomy|break ?down)\b/iu.test(query);
}

/**
 * Catalog search (Pillar 2): pull the WHOLE registry (paginated + cached),
 * normalize into faceted records, categorize, and either list categories or
 * rank by relevance — answering honestly when a facet (model) isn't exposed.
 */
async function runSearchBlocksCatalog(
  action: Extract<AssistantAction, { kind: 'search-blocks-catalog' }>,
  ctx: TaskContext | undefined,
  offline: boolean,
): Promise<HandlerResult> {
  const query = action.query.trim();
  const tag = action.tag?.trim();
  const facetCategory = asCatalogCategory(action.category?.trim());
  ctx?.reportStatus(tag
    ? `personal agent: scanning Blocks catalog (tag "${tag}")…`
    : `personal agent: scanning Blocks catalog for "${query}"…`);

  let snapshot;
  try {
    snapshot = await loadRuntimeCatalog(offline, { onStatus: (m) => ctx?.reportStatus(m) });
  } catch (err) {
    // Registry unreachable → an HONEST visible reply, never a silent finish
    // or a wall of JSON (edge case 10).
    return jsonArtifact({
      ok: true,
      reply: "I couldn't reach the Blocks catalog right now, so I can't list agents. Please try again in a moment.",
      action: 'search-blocks-catalog',
      query,
      ...(tag ? { tag } : {}),
      scanned: 0,
      matched: 0,
      agents: [],
      error: 'catalog-unreachable',
      message: err instanceof Error ? err.message : String(err),
      note: VISIBILITY_NOTE,
    });
  }

  // Empty registry → honest reply (edge case 10).
  if (snapshot.agents.length === 0) {
    return jsonArtifact({
      ok: true,
      reply: 'No agents are listed in the Blocks catalog right now.',
      action: 'search-blocks-catalog',
      query,
      ...(tag ? { tag } : {}),
      scanned: snapshot.scanned,
      totalCount: snapshot.totalCount,
      matched: 0,
      agents: [],
      note: VISIBILITY_NOTE,
    });
  }

  // A tag prefilters the universe but ranking still applies (edge case 6).
  const universe: CatalogAgent[] = tag
    ? snapshot.agents.filter((a) => a.tags.map((t) => t.toLowerCase()).includes(tag.toLowerCase()))
    : snapshot.agents;

  // "Categorize the whole catalog" / "what kinds exist".
  if (isCategorizeRequest(query, action.category)) {
    const buckets = categorizeCatalog(universe);
    return jsonArtifact({
      ok: true,
      reply: formatCategorizeReply({ buckets, scanned: snapshot.scanned, totalCount: snapshot.totalCount, truncated: snapshot.truncated }),
      action: 'search-blocks-catalog',
      query,
      ...(tag ? { tag } : {}),
      scanned: snapshot.scanned,
      totalCount: snapshot.totalCount,
      truncated: snapshot.truncated,
      matched: universe.length,
      categories: buckets,
      agents: universe.map((a) => rankedAgentView({ agent: a, categories: categorize(a), score: 0, whyMatched: '' })),
      note: VISIBILITY_NOTE,
    });
  }

  const facets: SearchFacets = {};
  if (facetCategory) facets.category = facetCategory;
  const search = searchCatalog(universe, { query, facets });
  const top = search.results.slice(0, 10);
  const rec = search.recommendation;

  return jsonArtifact({
    ok: true,
    reply: formatSearchReply({ query, tag, search, scanned: snapshot.scanned, totalCount: snapshot.totalCount, truncated: snapshot.truncated }),
    action: 'search-blocks-catalog',
    query,
    ...(tag ? { tag } : {}),
    scanned: snapshot.scanned,
    totalCount: snapshot.totalCount,
    truncated: snapshot.truncated,
    matched: search.matched,
    agents: top.map(rankedAgentView),
    categories: search.buckets,
    // Threadable fields (Pillar 2.6): a later call-specialist step can
    // reference `{{stepN.recommend}}` (the picked handle) or
    // `{{stepN.recommendTag}}` (its capability tag) to "use" the found agent.
    ...(rec ? {
      recommend: rec.agent.handle,
      recommendTag: rec.agent.tags[0] ?? '',
      recommendation: { handle: rec.agent.handle, displayName: rec.agent.displayName, tag: rec.agent.tags[0] ?? '', why: rec.whyMatched },
    } : {}),
    ...(search.facetNote ? { facetNote: search.facetNote } : {}),
    modelFacet: detectModelFacet(query) ?? undefined,
    modelFacetUnavailable: search.modelFacetUnavailable,
    note: VISIBILITY_NOTE,
  });
}

/**
 * Plan a personal-assistant request. In live mode this tries the gateway
 * brain first, but always falls back to the deterministic offline stub if
 * the gateway errors or its envelope needs schema repair.
 */
export async function planRequest(
  inputs: Record<string, unknown>,
  opts: PlanRequestOpts,
): Promise<AssistantPlan> {
  const runSkillImpl = opts.runSkillImpl ?? runSkill;
  const live = opts.live ?? brainLiveEnabled();

  if (live && !opts.offline) {
    try {
      const liveValue = await runSkillImpl('personal_assistant', inputs, { offline: false });
      const livePlan = validatePlan(liveValue);
      if (planNeededRepair(liveValue, livePlan)) {
        throw new Error('personal_assistant live plan needed schema repair');
      }
      return livePlan;
    } catch (err) {
      logBrainFallback(err);
    }
  }

  return validatePlan(await runSkillImpl('personal_assistant', inputs, { offline: true }));
}

/**
 * Shape the owner profile into brain inputs (Pillar 0.3). Returns an empty
 * object when no profile is set so back-compat planning is byte-identical to
 * before — the brain only learns "who I am" once a profile exists. The
 * offline stub ignores these fields; the live brain restates them in the
 * SKILL spec to sign mail and reason in the owner's timezone.
 */
function ownerProfilePlanInputs(profile: OwnerProfile | undefined): Record<string, unknown> {
  if (!profile) return {};
  const owner: Record<string, unknown> = { ownerId: profile.ownerId };
  if (profile.displayName) owner.displayName = profile.displayName;
  if (profile.email) owner.email = profile.email;
  if (profile.timezone) owner.timezone = profile.timezone;
  if (profile.workingHours) owner.workingHours = profile.workingHours;
  return Object.keys(owner).length > 1 ? { owner } : {};
}

/** Live planners sometimes collapse "coordinate with Bob so we are both free"
 * into a local calendar read. Repair only that narrow mutual-availability
 * shape into the intended sequence: check my calendar, then ask the named
 * peer. The runtime still resolves `personRef` against the roster. */
function repairPeerCoordinationPlan(request: string, plan: AssistantPlan): AssistantPlan {
  if (plan.steps.some((step) => step.kind === 'call-peer')) return plan;
  const personRef = peerCoordinationPersonRef(request);
  if (!personRef) return plan;

  const first = plan.steps[0];
  const alreadyLocalAvailability =
    first?.kind === 'use-integration' && first.tool === 'calendar.freeBusy';
  const safeToRepair =
    alreadyLocalAvailability ||
    first?.kind === 'answer-direct' ||
    plan.steps.length === 0;
  if (!safeToRepair) return plan;

  const steps: AssistantAction[] = [
    { id: 'step1', kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: request } },
    {
      id: 'step2',
      kind: 'call-peer',
      personRef,
      intent: `Find mutual availability for this request: ${stripTerminalPunctuation(request)}. My calendar result: {{step1}}`,
    },
  ];
  return {
    ok: true,
    reply: `I'll check your calendar and coordinate with ${personRef}'s assistant.`,
    steps,
    actions: steps,
  };
}

function peerCoordinationPersonRef(request: string): string | null {
  const lower = request.toLowerCase();
  const coordinates =
    /\b(coordinat\w*|compare|mutual|together)\b/u.test(lower) ||
    /\bworks?\s+for\s+both\b/u.test(lower) ||
    /\bboth\b.*\b(free|available|availability|busy)\b/u.test(lower) ||
    /\b(free|available|availability|busy)\b.*\bboth\b/u.test(lower);
  const asksAvailability =
    /\b(free|busy|available|availability|calendar|time|slot|meeting|schedule|morning|afternoon|evening)\b/u.test(lower);
  if (!coordinates || !asksAvailability) return null;

  const patterns = [
    /\bwith\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
    /\b(?:ask|coordinate|check|compare|sync)\s+(?:with\s+)?(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
    /\b(@?[a-z][a-z0-9_.@'’-]*)\s+and\s+(?:i|me)\b/iu,
    /\b(?:i|me)\s+and\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = request.match(pattern);
    const ref = normalizePeerReference(match?.[1]);
    if (ref) return ref;
  }
  return null;
}

function normalizePeerReference(value: string | undefined): string | null {
  const ref = (value ?? '')
    .replace(/['’]s$/u, '')
    .replace(/[^\p{L}\p{N}_@.'’-]+$/gu, '')
    .trim();
  if (!ref) return null;
  if (/^(me|my|mine|i|you|your|calendar|meeting|event|call|time|slot|the|a|an)$/iu.test(ref)) return null;
  return ref;
}

function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/u, '');
}

function directProfileReply(request: string, profile: OwnerProfile | undefined): string | undefined {
  const t = request.toLowerCase();
  const asksWho = /\b(who|what)\s+are\s+you\b/u.test(t) || /\bintroduce\s+yourself\b/u.test(t);
  const asksName = /\bwhat(?:'s|’s| is|\s+are)\s+(?:my|your)\s+name\b/u.test(t);
  const asksEmail = /\bwhat(?:'s|’s| is|\s+are)\s+(?:my|your)\s+e-?mail(?:\s+address)?\b/u.test(t);
  const asksTimezone =
    /\bwhat(?:'s|’s| is|\s+are)\s+(?:my|your)\s+time\s?zone\b/u.test(t) ||
    /\btime\s?zone\b/u.test(t);
  const asksWorkingHours =
    /\bwhat(?:'s|’s| is|\s+are)\s+(?:my|your)\s+working\s+hours\b/u.test(t) ||
    /\bworking\s+hours\b/u.test(t);
  if (!asksWho && !asksName && !asksEmail && !asksTimezone && !asksWorkingHours) return undefined;

  if (!profile) {
    return 'I do not have an owner profile saved yet. Add your name, email, and timezone in Settings > Your profile.';
  }

  const lines: string[] = [];
  if (asksWho) {
    lines.push(`I'm your private assistant${profile.displayName ? ` for ${profile.displayName}` : ''}.`);
  }
  if (asksName || (asksWho && !asksEmail && !asksTimezone && !asksWorkingHours)) {
    lines.push(`Name: ${profile.displayName || 'not set'}.`);
  }
  if (asksEmail) {
    lines.push(`Email: ${profile.email || 'not set'}.`);
  }
  if (asksTimezone) {
    lines.push(`Timezone: ${profile.timezone || 'not set'}.`);
  }
  if (asksWorkingHours) {
    lines.push(`Working hours: ${profile.workingHours || 'not set'}.`);
  }
  return lines.join(' ');
}

function brainLiveEnabled(): boolean {
  if (cachedBrainLive === undefined) {
    cachedBrainLive = process.env.PA_BRAIN_LIVE === '1';
  }
  return cachedBrainLive;
}

function logBrainFallback(err: unknown): void {
  if (loggedBrainFallback) return;
  loggedBrainFallback = true;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`personal agent: live brain failed; falling back to offline stub (${message})`);
}

function planNeededRepair(raw: unknown, normalized: AssistantPlan): boolean {
  if (!isRecord(raw)) return true;
  if (raw.ok !== true || raw.reply !== normalized.reply) return true;
  // The live brain may emit `steps` (new) or `actions` (legacy alias); compare
  // against whichever it used. Auto-assigned `id`/`runIf` normalization is
  // benign and does NOT count as repair (so a live plan that omits ids still
  // runs live instead of silently falling back to the offline stub).
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw.actions) ? raw.actions : null;
  if (!rawSteps || rawSteps.length !== normalized.steps.length) return true;

  for (let i = 0; i < normalized.steps.length; i += 1) {
    const rawStep = rawSteps[i];
    const step = normalized.steps[i];
    if (!isRecord(rawStep) || rawStep.kind !== step.kind) return true;

    if (step.kind === 'call-specialist') {
      if (rawStep.tag !== step.tag || rawStep.prompt !== step.prompt) return true;
    } else if (step.kind === 'call-peer') {
      // personRef is FIRST-CLASS (3.3): a live `personRef` plan must NOT diff
      // as "needs repair" and silently fall back to the offline stub.
      const rawAssistant = typeof rawStep.assistant === 'string' && rawStep.assistant.trim() ? rawStep.assistant.trim() : undefined;
      const rawPersonRef = typeof rawStep.personRef === 'string' && rawStep.personRef.trim() ? rawStep.personRef.trim() : undefined;
      if (rawAssistant !== step.assistant || rawPersonRef !== step.personRef || rawStep.intent !== step.intent) return true;
    } else if (step.kind === 'use-integration') {
      if (rawStep.tool !== step.tool) return true;
      if ('args' in rawStep && rawStep.args !== step.args) return true;
    } else if (step.kind === 'search-blocks-catalog') {
      if (rawStep.query !== step.query) return true;
      if ('tag' in rawStep && rawStep.tag !== step.tag) return true;
      if ('category' in rawStep && rawStep.category !== step.category) return true;
    }
  }

  return false;
}

/**
 * OUTBOUND A2A — ask a peer's assistant. The handle comes from the invite
 * roster (NEVER discover — private peers aren't findable); the daily cap
 * throttles runaway chains; the request chains hop+1 on the same thread.
 */
async function runOutboundA2A(
  action: Extract<AssistantAction, { kind: 'call-peer' }>,
  plan: AssistantPlan,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  selfHandle: string,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  const roster = selfHandle ? await loadRoster(selfHandle, { baseDir: opts.rosterBaseDir }) : null;
  const peers = roster?.peers ?? [];

  // (3.3/3.4) Resolve the target peer from the roster — by a pre-resolved
  // `assistant` handle (back-compat) OR by a natural `personRef` ("Kayley").
  // The runtime NEVER fabricates a handle: unknown/ambiguous/self all return
  // an honest, visible reply rather than a guessed call.
  const resolved = resolvePeerTarget(action, peers, selfHandle, opts.ownerProfile);

  if (resolved.kind === 'self') {
    // Loop/self guard (3.9, outbound twin of the inbound from==self guard):
    // a self-reference is a clear refusal, not a call to ourselves.
    ctx?.reportStatus('personal agent: refused call-peer (resolves to my own assistant)');
    return jsonArtifact({
      ok: true,
      reply: `That refers to me — I can't call my own assistant. Tell me which peer to reach instead.`,
      actions: plan.actions,
      note: `call-peer reference "${resolved.reference}" resolves to this assistant itself, so A2A delegation can't proceed`,
      peerResolution: 'self',
      personRef: resolved.reference,
    });
  }

  if (resolved.kind === 'ambiguous') {
    // Several invited peers match — ask the owner to pick (never auto-pick).
    // The caller (single- or multi-step) parks the plan and resumes on a pick.
    const candidates = resolved.candidates.map(peerIdentityView);
    const names = candidates.map((c) => peerLabel(c)).join(', ');
    ctx?.reportStatus(`personal agent: call-peer "${resolved.reference}" is ambiguous (${candidates.length} peers)`);
    return jsonArtifact({
      ok: true,
      reply: `I know more than one "${resolved.reference}" — which one? ${names}`,
      actions: plan.actions,
      needsMoreInfo: true,
      peerResolution: 'ambiguous',
      personRef: resolved.reference,
      candidates,
    });
  }

  if (resolved.kind === 'unknown') {
    // Honest miss, kept DISTINCT from a contact (email) match: name the person
    // and offer the Invite affordance. If they ARE a known contact, say so
    // (the email half of diagram F) rather than silently guessing one resolver.
    const contactHint = await unknownPeerContactHint(resolved.reference, opts);
    const base = `I don't have access to that personal assistant — you haven't been introduced to ${resolved.reference}'s assistant yet.`;
    const reply = contactHint
      ? `${base} I do have an email for ${resolved.reference}, so I can email them instead, or you can invite their assistant.`
      : `${base} Invite their assistant and I'll be able to reach them.`;
    return jsonArtifact({
      ok: true,
      reply,
      actions: plan.actions,
      note: `peer "${resolved.reference}" is not an invited peer in this assistant's roster, so A2A delegation (Phase PA-4) can't proceed`,
      peerResolution: 'unknown',
      personRef: resolved.reference,
      invite: { personRef: resolved.reference },
      ...(contactHint ? { contactFallback: contactHint } : {}),
    });
  }

  const peer = resolved.peer;
  const peerHandle = peer.agentName;

  // Daily cap: refuse the call that would exceed PA_A2A_DAILY_CALLS_CAP.
  if (!(await withinDailyCap({ baseDir: opts.budgetBaseDir }))) {
    ctx?.reportStatus('personal agent: refused A2A (daily call cap reached)');
    return jsonArtifact({ ok: false, error: 'a2a-daily-cap' });
  }
  await recordA2ACall({ baseDir: opts.budgetBaseDir });

  const request = buildA2ARequest({
    from: selfHandle,
    intent: action.intent,
    hop: 1,
  });

  ctx?.reportStatus(`personal agent: asking ${peerHandle} → "${request.intent}"…`);
  const send = opts.sendA2A ?? (await resolveDefaultSendA2A(offline, selfHandle));
  let peerResponse = await send(peerHandle, request, { offline });
  if (!offline && !peerResponseReply(peerResponse)) {
    ctx?.reportStatus(`personal agent: retrying ${peerHandle} because the first A2A response had no artifact…`);
    peerResponse = await send(peerHandle, request, { offline });
  }
  if (!peerResponseReply(peerResponse) && opts.localA2A) {
    ctx?.reportStatus(`personal agent: using same-bridge fallback for ${peerHandle}…`);
    try {
      peerResponse = await opts.localA2A(peer, request, { callerOwnerId: policy.ownerId, offline }, ctx);
    } catch (err) {
      ctx?.reportStatus(`personal agent: same-bridge fallback for ${peerHandle} failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Audit the sent hop for the PA-5 dashboard overview.
  await recordHop(
    {
      direction: 'out',
      from: selfHandle,
      to: peerHandle,
      intent: request.intent,
      hop: request.hop,
      threadId: request.threadId,
      outcome: 'sent',
    },
    { baseDir: opts.auditBaseDir },
  );

  return jsonArtifact({
    ok: true,
    reply: peerCallReply(peer, peerResponse),
    // (3.6) Carry the resolved identity through the A2A envelope so the UI and
    // audit show WHO was reached, not just a bare handle. Share-policy gating
    // is unchanged (the peer's side still redacts before its brain).
    a2a: { to: peerHandle, intent: request.intent, threadId: request.threadId, hop: request.hop },
    peerIdentity: peerIdentityView(peer),
    peer: peerResponse,
    actions: plan.actions,
  });
}

function peerCallReply(peer: Peer, peerResponse: unknown): string {
  const label = peer.ownerName || peer.displayName || peer.agentName;
  const reply = peerResponseReply(peerResponse);
  return reply
    ? `${label}'s assistant replied: ${reply}`
    : `I asked ${label}'s assistant.`;
}

function peerResponseReply(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return clampThreaded(value.trim());
  if (!isRecord(value)) return undefined;

  for (const key of ['reply', 'text', 'message']) {
    const field = value[key];
    if (typeof field === 'string' && field.trim()) return clampThreaded(field.trim());
  }
  for (const key of ['response', 'artifact', 'payload', 'data']) {
    const nested = peerResponseReply(value[key]);
    if (nested) return nested;
  }
  const artifacts = value.artifacts;
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      const nested = peerResponseReply(artifact);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** The outcome of resolving a call-peer action's target against the roster. */
type PeerTarget =
  | { kind: 'matched'; peer: Peer }
  | { kind: 'ambiguous'; candidates: Peer[]; reference: string }
  | { kind: 'unknown'; reference: string }
  | { kind: 'self'; reference: string };

/** Resolve a call-peer action to a roster peer. A pre-resolved `assistant`
 *  handle wins (back-compat: old plans that already carry a handle); otherwise
 *  the natural `personRef` is resolved data-driven off the roster (3.3). */
function resolvePeerTarget(
  action: Extract<AssistantAction, { kind: 'call-peer' }>,
  peers: Peer[],
  selfHandle: string,
  ownerProfile: OwnerProfile | undefined,
): PeerTarget {
  const reference = (action.assistant ?? action.personRef ?? '').trim();

  // A pre-resolved handle: match it directly against the roster.
  if (action.assistant && action.assistant.trim()) {
    const handle = action.assistant.trim();
    if (selfHandle && handle === selfHandle) return { kind: 'self', reference: handle };
    const peer = peers.find((p) => p.agentName === handle);
    return peer ? { kind: 'matched', peer } : { kind: 'unknown', reference: handle };
  }

  // A natural reference: resolve against roster identities (3.3).
  if (action.personRef && action.personRef.trim()) {
    const ref = action.personRef.trim();
    if (isOwnSelfReference(ref, selfHandle, ownerProfile)) return { kind: 'self', reference: ref };
    const resolution = resolvePeerReference(peers, ref);
    if (resolution.status === 'matched') {
      if (selfHandle && resolution.peer.agentName === selfHandle) return { kind: 'self', reference: ref };
      return { kind: 'matched', peer: resolution.peer };
    }
    if (resolution.status === 'ambiguous') return { kind: 'ambiguous', candidates: resolution.candidates, reference: ref };
    return { kind: 'unknown', reference: ref };
  }

  return { kind: 'unknown', reference };
}

/** True when the reference names the OWNER's own assistant (so a self-call is
 *  refused rather than dispatched). Matches the own handle's local name or the
 *  owner's own first/display name from the profile. */
function isOwnSelfReference(ref: string, selfHandle: string, ownerProfile: OwnerProfile | undefined): boolean {
  const norm = ref.trim().toLowerCase();
  if (!norm) return false;
  if (selfHandle) {
    const local = selfHandle.toLowerCase().replace(/^pa[_-]/u, '');
    if (norm === selfHandle.toLowerCase() || norm === local) return true;
  }
  const name = ownerProfile?.displayName?.trim().toLowerCase();
  if (name && (norm === name || norm === name.split(/\s+/u)[0])) return true;
  return false;
}

/** A minimal identity view of a peer for the reply/envelope/UI (3.6). */
function peerIdentityView(peer: Peer): {
  handle: string;
  displayName?: string;
  ownerName?: string;
  capabilities?: string[];
} {
  return {
    handle: peer.agentName,
    ...(peer.displayName ? { displayName: peer.displayName } : {}),
    ...(peer.ownerName ? { ownerName: peer.ownerName } : {}),
    ...(Array.isArray(peer.capabilities) && peer.capabilities.length ? { capabilities: peer.capabilities } : {}),
  };
}

function peerLabel(view: { handle: string; displayName?: string; ownerName?: string }): string {
  const name = view.ownerName ?? view.displayName;
  return name ? `${name} (${view.handle})` : view.handle;
}

/** When an unknown peer reference IS a known contact, return their name so the
 *  reply can offer email as the alternative (diagram F fork), keeping the two
 *  resolvers distinct rather than guessing one. */
async function unknownPeerContactHint(reference: string, opts: RunAssistantOpts): Promise<string | undefined> {
  try {
    const ownerId = opts.ownerProfile?.ownerId ?? '';
    const contacts = opts.contacts ?? (ownerId ? await loadContacts(ownerId, { baseDir: opts.contactsStoreBaseDir }) : []);
    if (contacts.length === 0) return undefined;
    const res = resolveContactReference(contacts, reference);
    return res.status === 'matched' ? res.contact.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Integration dispatch (Phase 8.1, read path) — run a named integration
 * tool the brain planned and fold the result into the reply. Reads
 * (calendar.freeBusy / calendar.list) are safe; the write path
 * (booking) and its confirmation gate are Phase 8.2.
 */
async function runUseIntegration(
  action: Extract<AssistantAction, { kind: 'use-integration' }>,
  plan: AssistantPlan,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  const tool = action.tool.trim();
  if (!tool) {
    return jsonArtifact({
      ok: true,
      reply: plan.reply,
      actions: plan.actions,
      note: 'the plan asked for an integration but named no tool',
    });
  }

  // D.4: on the live hosted path, a disconnected owner must surface the
  // Connect-Google remedy — never hit the MCP server with no credentials nor
  // fall back to an offline stub. Only the real runner path is guarded
  // (skipped when offline or when a test injects opts.runIntegration).
  if (!offline && !opts.runIntegration && toolNeedsGoogle(tool)) {
    if (!(await ownerIntegrationConnected(policy.ownerId, 'google', opts))) {
      return jsonArtifact({
        ok: true,
        reply: 'Connect your Google account and I\'ll finish that for you.',
        needsConnection: { provider: 'google', tool },
        actions: plan.actions,
      });
    }
  }

  if (writeBlockedByMode(tool)) {
    return readOnlyRefusal({ tool, actions: plan.actions });
  }

  if (WRITE_TOOLS.has(tool)) {
    return runWriteIntegration(action, plan, ctx, policy, offline, opts);
  }

  // email.draft is a write that, when allowed, dispatches here rather than
  // through the confirm gate — it still needs recipient resolution so a
  // draft is never addressed to a bare name (Pillar 0.5).
  let toolArgs = action.args ?? {};
  if (tool === 'email.draft') {
    const prepared = await prepareWriteArgs(tool, toolArgs, offline, policy.ownerId ?? '', opts);
    if (!prepared.ok) {
      return jsonArtifact({
        ok: true,
        reply: prepared.reply,
        needsMoreInfo: true,
        integration: { tool, args: toolArgs },
        ...(prepared.needsContact ? { needsContact: prepared.needsContact } : {}),
        actions: plan.actions,
      });
    }
    toolArgs = prepared.args;
  }

  ctx?.reportStatus(`personal agent: using integration "${tool}"…`);
  const run = opts.runIntegration ?? (await resolveDefaultIntegration(offline, tool, policy.ownerId, opts));
  const result = await run(tool, toolArgs, { offline });
  const reply = friendlyIntegrationReply(plan.reply, tool, result);

  return jsonArtifact({
    ok: true,
    reply,
    integration: { tool, args: toolArgs },
    result,
    actions: plan.actions,
  });
}

async function runWriteIntegration(
  action: Extract<AssistantAction, { kind: 'use-integration' }>,
  plan: AssistantPlan,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  const tool = action.tool.trim();
  let args = action.args ?? {};
  if (writeBlockedByMode(tool)) {
    return readOnlyRefusal({ tool, actions: plan.actions });
  }
  const ownerId = policy.ownerId ?? '';
  const prepared = await prepareWriteArgs(tool, args, offline, ownerId, opts);
  if (!prepared.ok) {
    return jsonArtifact({
      ok: true,
      reply: prepared.reply,
      needsMoreInfo: true,
      integration: { tool, args },
      ...(prepared.needsContact ? { needsContact: prepared.needsContact } : {}),
      actions: plan.actions,
    });
  }
  args = prepared.args;
  const targetOwner = typeof args.targetOwnerId === 'string' ? args.targetOwnerId : typeof args.ownerId === 'string' ? args.ownerId : ownerId;
  const idempotencyId = opts.writeIdempotencyId ?? stringArg(args.idempotencyId) ?? makeIdempotencyId(tool, args, ownerId);
  const confirmToken = confirmTokenFor(idempotencyId);
  const auditOpts = { baseDir: opts.bookingAuditBaseDir };

  if (ownerId && targetOwner && targetOwner !== ownerId) {
    await recordBookingWrite(
      {
        idempotencyId,
        confirmToken,
        tool,
        args,
        ownerId,
        policy: bookingPolicy(opts),
        status: 'refused',
        reason: 'target owner does not match the bound owner',
      },
      auditOpts,
    );
    return jsonArtifact({ ok: false, error: 'write-owner-mismatch', reason: 'target owner does not match the bound owner' });
  }

  const prior = await findWrittenBooking(idempotencyId, auditOpts);
  if (prior) {
    return jsonArtifact({
      ok: true,
      reply: plan.reply,
      idempotent: true,
      integration: { tool, args },
      result: prior.result,
      actions: plan.actions,
    });
  }

  const policyMode = bookingPolicy(opts);
  if (policyMode === 'confirm') {
    const existing = await findBookingProposal(confirmToken, auditOpts);
    if (!existing) {
      await recordBookingWrite(
        { idempotencyId, confirmToken, tool, args, ownerId, policy: policyMode, status: 'proposed' },
        auditOpts,
      );
    }
    return jsonArtifact({
      ok: true,
      reply: writeProposalReply(tool),
      proposal: { tool, args, idempotencyId },
      confirmToken,
      actions: plan.actions,
    });
  }

  ctx?.reportStatus(`personal agent: writing via integration "${tool}"…`);
  const run = opts.runIntegration ?? (await resolveDefaultIntegration(offline, tool, ownerId, opts));
  const result = await runWriteTool(run, tool, args, offline);
  if (!bookingResultSucceeded(result)) {
    await recordBookingWrite(
      {
        idempotencyId,
        confirmToken,
        tool,
        args,
        ownerId,
        policy: policyMode,
        status: 'failed',
        result,
        reason: integrationFailureReason(result),
      },
      auditOpts,
    );
    return writeFailedArtifact(tool, args, result, plan.actions);
  }
  await recordBookingWrite(
    { idempotencyId, confirmToken, tool, args, ownerId, policy: policyMode, status: 'written', result },
    auditOpts,
  );
  return jsonArtifact({
    ok: true,
    reply: plan.reply,
    integration: { tool, args },
    result,
    actions: plan.actions,
  });
}

async function runConfirmedWrite(
  confirmToken: string,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  const auditOpts = { baseDir: opts.bookingAuditBaseDir };
  const proposal = await findBookingProposal(confirmToken, auditOpts);
  if (!proposal) {
    return jsonArtifact({ ok: false, error: 'unknown-confirm-token', confirmToken });
  }
  if (writeBlockedByMode(proposal.tool)) {
    return readOnlyRefusal({ confirmToken, tool: proposal.tool });
  }
  if (policy.ownerId && proposal.ownerId && proposal.ownerId !== policy.ownerId) {
    return jsonArtifact({ ok: false, error: 'write-owner-mismatch', reason: 'confirm token belongs to a different owner' });
  }

  const prior = await findWrittenBooking(proposal.idempotencyId, auditOpts);
  if (prior) return confirmedWriteArtifact(proposal, prior.result, true);

  ctx?.reportStatus(`personal agent: confirmed write via integration "${proposal.tool}"…`);
  const run = opts.runIntegration ?? (await resolveDefaultIntegration(offline, proposal.tool, proposal.ownerId, opts));
  const result = await runWriteTool(run, proposal.tool, proposal.args, offline);
  if (!bookingResultSucceeded(result)) {
    await recordBookingWrite({
      ...proposal,
      status: 'failed',
      result,
      reason: integrationFailureReason(result),
      policy: proposal.policy,
    }, auditOpts);
    return writeFailedArtifact(proposal.tool, proposal.args, result, undefined, true);
  }
  await recordBookingWrite({ ...proposal, status: 'written', result, policy: proposal.policy }, auditOpts);
  return confirmedWriteArtifact(proposal, result, false);
}

/* ===========================================================================
 * Multi-step execution (Pillar 1) — the backbone.
 *
 * The brain returns an ordered `steps[]`; this executor runs them in order,
 * threads each result into the next, gates writes per step, parks the plan on
 * a confirm/needs-input pause, and synthesizes ONE coherent reply (including
 * partial results when a later step fails).
 * ======================================================================== */

/** How a step's result reads to the loop. Most handlers return `ok:true`
 *  even on a logical miss, so the loop branches on this — NOT on `ok`. */
type StepClassification = 'satisfied' | 'soft-miss' | 'needs-input' | 'hard-fail';

interface StepOutcome {
  payload: Record<string, unknown>;
  classification: StepClassification;
  /** Set when the step paused the plan (confirm / add-contact / disambiguate). */
  pause?: {
    reason: PendingPlanEntry['reason'];
    question: string;
    resumeToken?: string;
    /** Disambiguation candidates (peer picks) so the UI can render chips. */
    candidates?: unknown[];
  };
}

/** A structured, machine-readable per-step event (UI.9). The dashboard SSE
 *  path surfaces these as `step` events so the chat renders a live ledger
 *  (UI.7) instead of parsing prose `status` lines. The optional `reportStep`
 *  is layered on top of the SDK's `TaskContext` (which only knows
 *  `reportStatus`), so we read it defensively. */
export interface StepEvent {
  id: string;
  kind: AssistantAction['kind'];
  index: number;
  total: number;
  status: 'running' | StepClassification | 'skipped';
  reply?: string;
}

function reportStepEvent(ctx: TaskContext | undefined, event: StepEvent): void {
  const sink = ctx as (TaskContext & { reportStep?: (event: StepEvent) => void }) | undefined;
  sink?.reportStep?.(event);
}

/** Pending-plan state shares the booking-audit dir by default so a single
 *  per-owner state dir holds both write proposals and parked plans. */
function pendingPlanOpts(opts: RunAssistantOpts): { baseDir?: string } {
  return { baseDir: opts.pendingPlanBaseDir ?? opts.bookingAuditBaseDir };
}

async function runStepPlan(
  plan: AssistantPlan,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  selfHandle: string,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  return executePlanFrom(plan, ctx, policy, selfHandle, offline, opts, [], 0);
}

/**
 * Resume a plan parked on a write confirmation (Pillar 1.4). Run the gated
 * write the owner just confirmed, fold it into the restored ledger, mark the
 * parked plan resolved (so a replayed token can't double-run), then continue
 * the remaining steps. Completed steps are carried in the ledger and skipped,
 * so "finish it" never re-sends mail that already went out.
 */
async function resumeConfirmedPlan(
  pending: PendingPlanEntry,
  confirmToken: string,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  selfHandle: string,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  const plan: AssistantPlan = { ok: true, reply: pending.plan.reply, steps: pending.plan.steps, actions: pending.plan.steps };
  const writeStep = plan.steps[pending.cursor];

  ctx?.reportStatus('personal agent: resuming the plan you confirmed…');
  const writeResult = await runConfirmedWrite(confirmToken, ctx, policy, offline, opts);
  const writePayload = parseHandlerPayload(writeResult);
  const classification: StepClassification = writePayload.ok === false ? 'hard-fail' : 'satisfied';

  const ledger: LedgerEntry[] = [
    ...pending.ledger,
    { stepId: writeStep?.id ?? `step${pending.cursor + 1}`, kind: writeStep?.kind ?? 'use-integration', classification, payload: writePayload },
  ];
  await resolvePendingPlan(confirmToken, pendingPlanOpts(opts));

  if (classification === 'hard-fail') {
    return synthesizeStepPlan(plan, ledger, { complete: false, stoppedAt: pending.cursor }, opts);
  }
  return executePlanFrom(plan, ctx, policy, selfHandle, offline, opts, ledger, pending.cursor + 1);
}

/**
 * Park a SINGLE-step call-peer plan that resolved to several peers (3.3). The
 * owner's pick (resume token + chosen handle) resumes it via
 * `resumeDisambiguatedPlan`, running the peer step exactly once. Never
 * auto-picks. Returns a visible disambiguation reply with the chips' payload.
 */
async function parkSinglePeerDisambiguation(
  plan: AssistantPlan,
  action: Extract<AssistantAction, { kind: 'call-peer' }>,
  payload: Record<string, unknown>,
  policy: OwnerPolicy,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  const steps = (plan.steps && plan.steps.length > 0 ? plan.steps : [action]).map((s, i) =>
    i === 0 ? { ...s, id: s.id ?? 'step1' } : s,
  );
  const resumeToken = makeResumeToken(plan, 0);
  const question = stringField(payload.reply) ?? 'Which peer did you mean?';
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  await recordPendingPlan(
    {
      resumeToken,
      ownerId: policy.ownerId ?? '',
      plan: { reply: plan.reply, steps },
      ledger: [],
      cursor: 0,
      completedStepIds: [],
      openQuestion: question,
      reason: 'disambiguation',
      status: 'pending',
    },
    pendingPlanOpts(opts),
  );
  return jsonArtifact({
    ok: true,
    reply: question,
    needsMoreInfo: true,
    peerResolution: 'ambiguous',
    ...(payload.personRef ? { personRef: payload.personRef } : {}),
    candidates,
    resume: { token: resumeToken, reason: 'disambiguation', question, candidates },
    actions: plan.actions,
  });
}

/**
 * Resume a plan parked on a peer disambiguation (3.3). Inject the owner's
 * chosen handle into the paused call-peer step (dropping its `personRef` so
 * it resolves uniquely), mark the parked plan resolved, then continue from the
 * paused cursor — earlier steps are carried in the ledger and skipped, so the
 * peer step runs exactly once (step idempotency, edge case 3/7).
 */
async function resumeDisambiguatedPlan(
  parked: PendingPlanEntry,
  pick: { resumeToken: string; peerHandle: string },
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  selfHandle: string,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<HandlerResult> {
  const steps: AssistantAction[] = parked.plan.steps.map((step, i) => {
    if (i !== parked.cursor || step.kind !== 'call-peer') return step;
    const next: Extract<AssistantAction, { kind: 'call-peer' }> = { ...step, assistant: pick.peerHandle };
    delete next.personRef;
    return next;
  });
  const plan: AssistantPlan = { ok: true, reply: parked.plan.reply, steps, actions: steps };
  await resolvePendingPlan(pick.resumeToken, pendingPlanOpts(opts));
  ctx?.reportStatus('personal agent: resuming the plan with your pick…');
  return executePlanFrom(plan, ctx, policy, selfHandle, offline, opts, parked.ledger, parked.cursor);
}

/** Parse a disambiguation resume pick: `{ resumeToken, peerHandle }` (or
 *  `choice` as the handle). Distinct from a confirm token so the two resume
 *  paths don't collide. */
function parseResumePick(text: string): { resumeToken: string; peerHandle: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    const token = typeof parsed.resumeToken === 'string' ? parsed.resumeToken.trim() : '';
    const handle = typeof parsed.peerHandle === 'string' && parsed.peerHandle.trim()
      ? parsed.peerHandle.trim()
      : typeof parsed.choice === 'string' ? parsed.choice.trim() : '';
    if (token && handle) return { resumeToken: token, peerHandle: handle };
  } catch {
    // Not a JSON resume pick.
  }
  return null;
}

/**
 * The core step loop. Runs steps from `startCursor`, carrying a results
 * ledger; substitutes prior outputs into each step; honours `runIf` guards;
 * stops cleanly on a hard failure or a pause; and always ends in a single
 * synthesized reply.
 */
async function executePlanFrom(
  plan: AssistantPlan,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  selfHandle: string,
  offline: boolean,
  opts: RunAssistantOpts,
  startLedger: LedgerEntry[],
  startCursor: number,
): Promise<HandlerResult> {
  const ledger: LedgerEntry[] = [...startLedger];
  const steps = plan.steps;

  for (let i = startCursor; i < steps.length; i += 1) {
    const step = steps[i];
    const stepId = step.id ?? `step${i + 1}`;

    // Step-level idempotency: a step already recorded on a prior turn (e.g.
    // before a confirm pause) is never re-run on resume.
    if (ledger.some((entry) => entry.stepId === stepId)) continue;

    // Conditional guard (static-linear branching).
    if (step.runIf && !runIfSatisfied(step.runIf, ledger)) {
      const skipReply = skippedReply(step.runIf);
      ledger.push({ stepId, kind: step.kind, classification: 'skipped', payload: { reply: skipReply } });
      ctx?.reportStatus(`personal agent: step ${i + 1}/${steps.length} skipped (${step.runIf.predicate} not met)`);
      reportStepEvent(ctx, { id: stepId, kind: step.kind, index: i, total: steps.length, status: 'skipped', reply: skipReply });
      continue;
    }

    const substituted = substituteStep(step, ledger);
    ctx?.reportStatus(`personal agent: step ${i + 1}/${steps.length} — ${step.kind}…`);
    reportStepEvent(ctx, { id: stepId, kind: step.kind, index: i, total: steps.length, status: 'running' });
    const outcome = await dispatchStepOutcome(substituted, plan, ctx, policy, selfHandle, offline, opts);
    ledger.push({ stepId, kind: step.kind, classification: outcome.classification, payload: outcome.payload });
    reportStepEvent(ctx, {
      id: stepId,
      kind: step.kind,
      index: i,
      total: steps.length,
      status: outcome.classification,
      reply: stringField(outcome.payload.reply),
    });

    if (outcome.classification === 'hard-fail') {
      return synthesizeStepPlan(plan, ledger, { complete: false, stoppedAt: i }, opts);
    }

    if (outcome.classification === 'needs-input' && outcome.pause) {
      const resumeToken = outcome.pause.resumeToken ?? makeResumeToken(plan, i);
      // The parked ledger holds only the COMPLETED steps (exclude the paused
      // step we just pushed) so resume re-runs the paused step exactly once
      // and never double-counts it in the synthesized reply.
      const completedLedger = ledger.slice(0, -1);
      await recordPendingPlan(
        {
          resumeToken,
          ownerId: policy.ownerId ?? '',
          plan: { reply: plan.reply, steps },
          ledger: completedLedger,
          cursor: i,
          completedStepIds: completedLedger.map((entry) => entry.stepId),
          openQuestion: outcome.pause.question,
          reason: outcome.pause.reason,
          status: 'pending',
        },
        pendingPlanOpts(opts),
      );
      return synthesizeStepPlan(plan, ledger, {
        complete: false,
        stoppedAt: i,
        resume: {
          token: resumeToken,
          question: outcome.pause.question,
          reason: outcome.pause.reason,
          ...(outcome.pause.candidates ? { candidates: outcome.pause.candidates } : {}),
        },
      }, opts);
    }
  }

  return synthesizeStepPlan(plan, ledger, { complete: true }, opts);
}

/** Dispatch one step and classify its result for the loop. Single-step
 *  handlers are reused (call-peer / use-integration / catalog); only
 *  call-specialist gets a step-shaped variant so its produced text/media is
 *  available to thread downstream. */
async function dispatchStepOutcome(
  step: AssistantAction,
  plan: AssistantPlan,
  ctx: TaskContext | undefined,
  policy: OwnerPolicy,
  selfHandle: string,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<StepOutcome> {
  switch (step.kind) {
    case 'answer-direct':
      return { payload: { ok: true, reply: plan.reply }, classification: 'satisfied' };

    case 'call-specialist':
      return runSpecialistStep(step, ctx);

    case 'search-blocks-catalog': {
      const result = await runSearchBlocksCatalog(step, ctx, offline);
      const payload = parseHandlerPayload(result);
      const matched = typeof payload.matched === 'number' ? payload.matched : undefined;
      return { payload, classification: matched === 0 ? 'soft-miss' : 'satisfied' };
    }

    case 'call-peer': {
      const result = await runOutboundA2A(step, syntheticPlan(plan, step), ctx, policy, selfHandle, offline, opts);
      const payload = parseHandlerPayload(result);
      // Ambiguous peer → pause the plan for a disambiguation round-trip (3.3):
      // the executor parks it (reason 'disambiguation') and the owner's pick
      // resumes the parked plan, running THIS step exactly once (idempotency).
      if (payload.needsMoreInfo === true && payload.peerResolution === 'ambiguous') {
        return {
          payload,
          classification: 'needs-input',
          pause: {
            reason: 'disambiguation',
            question: stringField(payload.reply) ?? 'Which peer did you mean?',
            candidates: Array.isArray(payload.candidates) ? payload.candidates : undefined,
          },
        };
      }
      return { payload, classification: classifyPeer(payload) };
    }

    case 'use-integration': {
      const result = await runUseIntegration(step, syntheticPlan(plan, step), ctx, policy, offline, opts);
      const payload = parseHandlerPayload(result);
      return classifyIntegration(payload);
    }

    default:
      return { payload: { ok: true, reply: plan.reply }, classification: 'satisfied' };
  }
}

/** call-specialist as a step: same discover/call seam as the single-step
 *  path, but returns the produced text (or media) in the payload so a later
 *  step can thread it (e.g. brief → book, summary → email). */
async function runSpecialistStep(
  step: Extract<AssistantAction, { kind: 'call-specialist' }>,
  ctx: TaskContext | undefined,
): Promise<StepOutcome> {
  const tag = step.tag ?? 'summarize';
  const prompt = step.prompt ?? '';
  ctx?.reportStatus(`personal agent: delegating to a "${tag}" specialist…`);

  const session = await connect({
    offline: false,
    onPartial: (e) => ctx?.reportStatus(`${e.handle}: ${e.message}`),
  });

  try {
    const agents = await session.discover(tag);
    if (agents.length === 0) {
      return {
        payload: { ok: true, reply: `I couldn't find any "${tag}" agent on the network right now.`, delegatedTo: null, tag },
        classification: 'soft-miss',
      };
    }
    const chosen = chooseSpecialist(agents, tag, prompt);
    if (!chosen) {
      return {
        payload: { ok: true, reply: `I couldn't find any "${tag}" agent on the network right now.`, delegatedTo: null, tag },
        classification: 'soft-miss',
      };
    }
    ctx?.reportStatus(`hiring ${chosen.handle} (${tag} — ${chosen.whyMatched})…`);
    const result = await session.call(chosen.handle, tag, { text: prompt });
    return specialistOutcome(result, chosen.handle, tag);
  } catch (err) {
    return {
      payload: {
        ok: false,
        error: 'specialist-failed',
        reply: `The "${tag}" specialist didn't respond.`,
        message: err instanceof Error ? err.message : String(err),
        tag,
      },
      classification: 'hard-fail',
    };
  } finally {
    session.close();
  }
}

function specialistOutcome(result: CallResult, handle: string, tag: string): StepOutcome {
  const arts: ArtifactOut[] = result.artifacts ?? [{ kind: 'data', data: result.data, mimeType: 'application/json' }];
  const files = arts.filter((a): a is FileArtifact => a.kind === 'file');
  if (files.length > 0) {
    const media = files.map((file) => delegatedFileMedia(file));
    const primary = media[0];
    return {
      payload: { ok: true, reply: delegatedMediaReply(primary), delegatedTo: handle, tag, media: primary, artifacts: media },
      classification: 'satisfied',
    };
  }

  const text = specialistText(arts.filter((a): a is Extract<ArtifactOut, { kind: 'data' }> => a.kind === 'data'));

  if (!text) {
    return { payload: { ok: true, reply: `${handle} returned nothing.`, delegatedTo: handle, tag }, classification: 'soft-miss' };
  }
  return { payload: { ok: true, reply: text, delegatedTo: handle, tag }, classification: 'satisfied' };
}

function classifyPeer(payload: Record<string, unknown>): StepClassification {
  if (payload.ok === false) return 'hard-fail';
  // Ambiguous peer is needs-input (handled with a pause by the caller).
  if (payload.needsMoreInfo === true && payload.peerResolution === 'ambiguous') return 'needs-input';
  // An un-invited peer (or a self-reference refusal) surfaces with ok:true +
  // a note — an *expected* miss, not a failure (depth-plan 1.3 / Pillar 1
  // contract). Keeps the call-peer soft-miss path green.
  if (typeof payload.note === 'string' && /not an invited peer|resolves to this assistant/u.test(payload.note)) return 'soft-miss';
  return 'satisfied';
}

function classifyIntegration(payload: Record<string, unknown>): StepOutcome {
  // A write awaiting confirmation: pause the plan and resume on the token.
  if (payload.proposal !== undefined && typeof payload.confirmToken === 'string') {
    return {
      payload,
      classification: 'needs-input',
      pause: { reason: 'confirm', question: stringField(payload.reply) ?? 'I prepared that write but have not run it yet.', resumeToken: payload.confirmToken },
    };
  }
  // Missing info (recipient not in contacts, missing booking time, ambiguous).
  if (payload.needsMoreInfo === true) {
    const reply = stringField(payload.reply) ?? 'I need a bit more information to finish that step.';
    const reason: PendingPlanEntry['reason'] = /more than one/u.test(reply) ? 'disambiguation' : 'needs-input';
    return { payload, classification: 'needs-input', pause: { reason, question: reply } };
  }
  if (payload.ok === false) {
    // A read-only refusal is an expected policy outcome, not a hard failure.
    if (payload.error === 'read-only-refused') return { payload, classification: 'soft-miss' };
    return { payload, classification: 'hard-fail' };
  }
  return { payload, classification: 'satisfied' };
}

function runIfSatisfied(runIf: RunIf, ledger: LedgerEntry[]): boolean {
  const entry = ledger.find((e) => e.stepId === runIf.from);
  if (!entry) return false;
  switch (runIf.predicate) {
    case 'satisfied':
      return entry.classification === 'satisfied';
    case 'soft-miss':
      return entry.classification === 'soft-miss';
    case 'free':
      return calendarFreeBusyCount(entry.payload) === 0;
    case 'busy':
      return calendarFreeBusyCount(entry.payload) > 0;
    default:
      return false;
  }
}

/** Busy-block count from a calendar.freeBusy step result, or -1 when the
 *  step didn't expose one (so `free`/`busy` guards both fail closed). */
function calendarFreeBusyCount(payload: Record<string, unknown>): number {
  const result = isRecord(payload.result) ? payload.result : null;
  if (result && Array.isArray(result.freeBusy)) return result.freeBusy.length;
  return -1;
}

function skippedReply(runIf: RunIf): string {
  if (runIf.predicate === 'free') return `Skipped — you weren't free, so I didn't proceed.`;
  if (runIf.predicate === 'busy') return `Skipped — you were free, so this wasn't needed.`;
  return `Skipped — the condition (${runIf.predicate}) on ${runIf.from} wasn't met.`;
}

/* ---- Result threading / substitution (Pillar 1.2) ---------------------- */

function substituteStep(step: AssistantAction, ledger: LedgerEntry[]): AssistantAction {
  const next: AssistantAction = { ...step };
  if (next.kind === 'call-specialist') next.prompt = substituteString(next.prompt, ledger);
  else if (next.kind === 'call-peer') next.intent = substituteString(next.intent, ledger);
  else if (next.kind === 'search-blocks-catalog') next.query = substituteString(next.query, ledger);
  else if (next.kind === 'use-integration' && next.args) next.args = substituteValue(next.args, ledger) as Record<string, unknown>;
  return next;
}

function substituteValue(value: unknown, ledger: LedgerEntry[]): unknown {
  const ref = asStepRef(value);
  if (ref) return resolveRef(ref.from, ref.field, ledger);
  if (typeof value === 'string') return substituteString(value, ledger);
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, ledger));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = substituteValue(val, ledger);
    return out;
  }
  return value;
}

const SUBSTITUTION_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)(?:[.:]([a-zA-Z0-9_.]+))?\s*\}\}/gu;

function substituteString(value: string, ledger: LedgerEntry[]): string {
  if (!value.includes('{{')) return value;
  return value.replace(SUBSTITUTION_TOKEN, (_match, from: string, field?: string) => resolveRef(from, field, ledger));
}

/** Resolve a `{ from, field }` reference to a clamped string from the ledger. */
function resolveRef(from: string, field: string | undefined, ledger: LedgerEntry[]): string {
  const entry = ledger.find((e) => e.stepId === from);
  if (!entry) return '';
  const path = field ?? DEFAULT_SUBSTITUTION_FIELD[entry.kind] ?? 'reply';
  const raw = readPath(entry.payload, path);
  return clampThreaded(stringifyThreaded(raw));
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stringifyThreaded(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clampThreaded(value: string): string {
  if (value.length <= THREAD_MAX_CHARS) return value;
  return `${value.slice(0, THREAD_MAX_CHARS)}… (truncated)`;
}

/* ---- Final-reply synthesis (Pillar 1.5) -------------------------------- */

interface SynthMeta {
  complete: boolean;
  stoppedAt?: number;
  resume?: { token: string; question: string; reason: PendingPlanEntry['reason']; candidates?: unknown[] };
}

/**
 * Compose ONE coherent reply from every step result — successes, honest
 * misses, the outstanding step, and a "want me to finish it?" when the plan
 * paused or failed. Always returns a non-empty human reply (the
 * always-final-reply guarantee for sequences) and carries any produced media
 * so an image step still renders.
 */
function synthesizeStepPlan(
  plan: AssistantPlan,
  ledger: LedgerEntry[],
  meta: SynthMeta,
  opts: RunAssistantOpts,
): HandlerResult {
  void opts;
  const lines: string[] = [];
  const suggestedBooking = meta.complete ? mutualAvailabilitySuggestion(plan, ledger) : null;
  if (suggestedBooking) {
    lines.push(`You and ${suggestedBooking.peerName} are both free ${suggestedBooking.mutualWindowLabel}.`);
    lines.push(`Suggested slot: ${suggestedBooking.slotLabel}.`);
  } else {
    for (const entry of ledger) {
      const contribution = stepContribution(entry);
      if (contribution) lines.push(contribution);
    }
  }

  if (meta.resume) {
    lines.push('');
    if (meta.resume.reason === 'confirm') {
      lines.push(`Reply with \`${meta.resume.token}\` to confirm and finish the rest.`);
    } else {
      lines.push(meta.resume.question);
      lines.push('Once that\u2019s sorted, tell me to finish and I\u2019ll pick up where I left off.');
    }
  } else if (!meta.complete) {
    lines.push('');
    lines.push('Want me to retry the part that didn\u2019t go through?');
  }

  const anyProgress = ledger.some((e) => e.classification === 'satisfied' || e.classification === 'soft-miss');
  const hasHardFail = ledger.some((e) => e.classification === 'hard-fail');
  const partial = !meta.complete;
  const reply = lines.join('\n').trim() || plan.reply || 'I worked through that request.';

  const mediaEntry = ledger.find((e) => isRecord(e.payload.media));
  const media = mediaEntry && isRecord(mediaEntry.payload.media) ? mediaEntry.payload.media : undefined;
  const artifacts = mediaEntry && Array.isArray(mediaEntry.payload.artifacts) ? mediaEntry.payload.artifacts : undefined;

  return jsonArtifact({
    ok: anyProgress || !hasHardFail,
    reply,
    multiStep: true,
    partial,
    steps: ledger.map((entry) => ({
      id: entry.stepId,
      kind: entry.kind,
      status: entry.classification,
      reply: stringField(entry.payload.reply),
    })),
    ...(meta.resume ? { resume: meta.resume, confirmToken: meta.resume.reason === 'confirm' ? meta.resume.token : undefined } : {}),
    ...(media ? { media } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(suggestedBooking ? { suggestedBooking } : {}),
    actions: plan.steps,
  });
}

interface SuggestedBooking {
  peerName: string;
  peerHandle?: string;
  start: string;
  end: string;
  slotLabel: string;
  mutualWindowLabel: string;
  durationMinutes: number;
  prompt: string;
}

interface CalendarAvailability {
  startMs: number;
  endMs: number;
  timeMin: string;
  timeMax: string;
  freeBusy: unknown[];
}

function mutualAvailabilitySuggestion(plan: AssistantPlan, ledger: LedgerEntry[]): SuggestedBooking | null {
  const local = ledger.find((entry) => entry.kind === 'use-integration' && entry.classification === 'satisfied');
  const peer = ledger.find((entry) => entry.kind === 'call-peer' && entry.classification === 'satisfied');
  if (!local || !peer) return null;

  const localAvailability = calendarAvailabilityFromPayload(local.payload);
  const peerAvailability = calendarAvailabilityFromPayload(peer.payload);
  if (!localAvailability || !peerAvailability) return null;

  const startMs = Math.max(localAvailability.startMs, peerAvailability.startMs);
  const endMs = Math.min(localAvailability.endMs, peerAvailability.endMs);
  if (endMs <= startMs) return null;

  const durationMinutes = suggestedMeetingDurationMinutes(plan);
  const durationMs = durationMinutes * 60_000;
  const slotStartMs = firstFreeSlot(startMs, endMs, durationMs, [
    ...busyIntervals(localAvailability.freeBusy),
    ...busyIntervals(peerAvailability.freeBusy),
  ]);
  if (slotStartMs === null) return null;

  const slotEndMs = slotStartMs + durationMs;
  const sourceTime = localAvailability.timeMin || peerAvailability.timeMin;
  const start = formatLikeIntegrationTime(new Date(slotStartMs), sourceTime);
  const end = formatLikeIntegrationTime(new Date(slotEndMs), sourceTime);
  const slotLabel = compactWindowLabel(start, end);
  const mutualWindowLabel = compactWindowLabel(
    formatLikeIntegrationTime(new Date(startMs), sourceTime),
    formatLikeIntegrationTime(new Date(endMs), sourceTime),
  );
  const peerName = peerDisplayName(peer.payload) ?? 'Bob';
  const peerHandle = peerHandleFromPayload(peer.payload);
  const prompt = `Book a meeting with ${peerName} on ${start.slice(0, 10)} from ${clockPrompt(start)} to ${clockPrompt(end)}.`;

  return {
    peerName,
    ...(peerHandle ? { peerHandle } : {}),
    start,
    end,
    slotLabel,
    mutualWindowLabel,
    durationMinutes,
    prompt,
  };
}

function calendarAvailabilityFromPayload(payload: Record<string, unknown>): CalendarAvailability | null {
  const candidate = findCalendarResult(payload);
  if (!candidate) return null;
  const window = isRecord(candidate.window) ? candidate.window : null;
  const timeMin = typeof window?.timeMin === 'string' ? window.timeMin : '';
  const timeMax = typeof window?.timeMax === 'string' ? window.timeMax : '';
  if (!timeMin || !timeMax) return null;
  const start = new Date(timeMin);
  const end = new Date(timeMax);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    timeMin,
    timeMax,
    freeBusy: Array.isArray(candidate.freeBusy) ? candidate.freeBusy : [],
  };
}

function findCalendarResult(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !isRecord(value)) return null;
  const window = isRecord(value.window) ? value.window : null;
  if (window && typeof window.timeMin === 'string' && typeof window.timeMax === 'string' && 'freeBusy' in value) return value;
  for (const key of ['result', 'response', 'artifact', 'payload', 'data', 'peer']) {
    const found = findCalendarResult(value[key], depth + 1);
    if (found) return found;
  }
  const artifacts = value.artifacts;
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      const found = findCalendarResult(artifact, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function busyIntervals(freeBusy: unknown[]): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const item of freeBusy) {
    if (!isRecord(item)) continue;
    const rawStart = typeof item.start === 'string' ? item.start : typeof item.timeMin === 'string' ? item.timeMin : '';
    const rawEnd = typeof item.end === 'string' ? item.end : typeof item.timeMax === 'string' ? item.timeMax : '';
    if (!rawStart || !rawEnd) continue;
    const start = new Date(rawStart).getTime();
    const end = new Date(rawEnd).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ start, end });
  }
  return intervals;
}

function firstFreeSlot(
  startMs: number,
  endMs: number,
  durationMs: number,
  intervals: Array<{ start: number; end: number }>,
): number | null {
  let cursor = startMs;
  const sorted = intervals
    .filter((interval) => interval.end > startMs && interval.start < endMs)
    .sort((a, b) => a.start - b.start);
  for (const interval of sorted) {
    if (interval.start > cursor && cursor + durationMs <= interval.start) return cursor;
    if (interval.end > cursor) cursor = interval.end;
    if (cursor >= endMs) return null;
  }
  return cursor + durationMs <= endMs ? cursor : null;
}

function suggestedMeetingDurationMinutes(plan: AssistantPlan): number {
  const text = plan.steps
    .map((step) => {
      if (step.kind === 'call-peer') return step.intent;
      if (step.kind === 'use-integration') return typeof step.args?.query === 'string' ? step.args.query : '';
      return '';
    })
    .join(' ')
    .toLowerCase();
  const hour = text.match(/\b(\d+(?:\.\d+)?)\s*(?:hour|hr|hrs)\b/u);
  if (hour) return Math.max(15, Math.round(Number(hour[1]) * 60));
  const minute = text.match(/\b(\d+)\s*(?:minute|min|mins)\b/u);
  if (minute) return Math.max(15, Number(minute[1]));
  return 30;
}

function peerDisplayName(payload: Record<string, unknown>): string | null {
  const identity = isRecord(payload.peerIdentity) ? payload.peerIdentity : {};
  const name = stringField(identity.ownerName) ?? stringField(identity.displayName) ?? stringField(identity.handle);
  return name ?? null;
}

function peerHandleFromPayload(payload: Record<string, unknown>): string | undefined {
  const identity = isRecord(payload.peerIdentity) ? payload.peerIdentity : {};
  return stringField(identity.handle);
}

function formatLikeIntegrationTime(date: Date, source: string): string {
  if (/Z$|[+-]\d{2}:\d{2}$/u.test(source)) return date.toISOString();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:00`;
}

function clockPrompt(value: string): string {
  const parts = parseLocalIsoParts(value);
  if (parts) return clockLabel(parts).replace(/\s+/gu, '').toLowerCase();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const hour = date.getHours();
  const minute = date.getMinutes();
  const suffix = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')}${suffix}`;
}

/** One step's line in the synthesized reply. */
function stepContribution(entry: LedgerEntry): string {
  const reply = stringField(entry.payload.reply);
  switch (entry.classification) {
    case 'satisfied':
      return reply ?? '';
    case 'soft-miss':
      return reply ?? 'No match for that step.';
    case 'needs-input':
      return reply ?? '';
    case 'hard-fail':
      return reply ?? `I couldn\u2019t complete the ${entry.kind} step.`;
    case 'skipped':
      return reply ?? '';
    default:
      return reply ?? '';
  }
}

function syntheticPlan(plan: AssistantPlan, step: AssistantAction): AssistantPlan {
  return { ok: true, reply: plan.reply, steps: [step], actions: [step] };
}

/** Parse a handler's JSON artifact back into its payload for the ledger. */
function parseHandlerPayload(result: HandlerResult): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  if (!artifact) return { ok: true };
  try {
    const parsed = JSON.parse(String(artifact.data)) as unknown;
    return isRecord(parsed) ? parsed : { ok: true, reply: String(parsed) };
  } catch {
    return { ok: true, reply: String(artifact.data) };
  }
}

function makeResumeToken(plan: AssistantPlan, cursor: number): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ reply: plan.reply, steps: plan.steps, cursor, at: Date.now() }))
    .digest('hex')
    .slice(0, 16);
  return `resume_${digest}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function runWriteTool(
  run: RunIntegration,
  tool: string,
  args: Record<string, unknown>,
  offline: boolean,
): Promise<unknown> {
  try {
    return await run(tool, args, { offline });
  } catch (err) {
    return {
      ok: false,
      tool,
      error: 'integration-write-failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function confirmedWriteArtifact(proposal: BookingAuditEntry, result: unknown, idempotent: boolean): HandlerResult {
  return jsonArtifact({
    ok: true,
    reply: confirmedWriteReply(proposal.tool, idempotent),
    confirmed: true,
    idempotent,
    integration: { tool: proposal.tool, args: proposal.args },
    result,
  });
}

function writeFailedArtifact(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  actions?: AssistantPlan['actions'],
  confirmed?: boolean,
): HandlerResult {
  const reason = integrationFailureReason(result);
  return jsonArtifact({
    ok: false,
    error: 'integration-write-failed',
    reply: writeFailedReply(tool),
    confirmed: confirmed === true ? false : undefined,
    integration: { tool, args },
    reason,
    ...(toolNeedsGoogle(tool) && googleIntegrationNeedsReconnect(reason) ? { needsConnection: { provider: 'google', tool, reason } } : {}),
    result,
    actions,
  });
}

function writeFailedReply(tool: string): string {
  if (tool === 'calendar.createEvent') return 'I tried to book it, but Calendar rejected the write. No event was created.';
  if (tool === 'email.draft') return 'I tried to create the Gmail draft, but Gmail rejected the write. No draft was created.';
  if (tool === 'email.send') return 'I tried to send the email, but Gmail rejected the write. No email was sent.';
  return 'I tried to complete that write action, but the integration rejected it.';
}

function integrationFailureReason(result: unknown): string {
  if (isRecord(result)) {
    const error = stringField(result.error);
    const message = stringField(result.message);
    const reason = stringField(result.reason);
    const raw = stringField(result.raw);
    const event = stringField(result.event);
    const nested = isRecord(result.result) ? integrationFailureReason(result.result) : '';
    if (error && error !== 'integration-write-failed') return error;
    if (message) return message;
    if (reason) return reason;
    if (raw) return raw;
    if (event) return event;
    if (nested && nested !== 'integration returned ok:false') return nested;
    if (error) return error;
  }
  return 'integration returned ok:false';
}

function googleIntegrationNeedsReconnect(reason: string): boolean {
  return /\b(auth|oauth|token|credential|permission|scope|forbidden|unauthori[sz]ed|expired|invalid_grant)\b/iu.test(reason);
}

function writeProposalReply(tool: string): string {
  if (tool === 'calendar.createEvent') return 'I prepared the calendar booking, but I have not booked it yet.';
  if (tool === 'email.draft') return 'I prepared a Gmail draft action, but I have not created the draft yet.';
  if (tool === 'email.send') return 'I prepared an email send action, but I have not sent it yet.';
  return 'I prepared that write action, but I have not run it yet.';
}

function confirmedWriteReply(tool: string, idempotent: boolean): string {
  if (tool === 'calendar.createEvent') return idempotent ? 'That calendar event was already created.' : 'Done. I created the calendar event.';
  if (tool === 'email.draft') return idempotent ? 'That Gmail draft was already created.' : 'Done. I created the Gmail draft.';
  if (tool === 'email.send') return idempotent ? 'That email was already sent.' : 'Done. I sent the email.';
  return idempotent ? 'That write action was already completed.' : 'Done. I completed the write action.';
}

function bookingPolicy(opts: RunAssistantOpts): BookingPolicy {
  if (readOnlyEnabled() && calendarBookingAllowed()) return 'confirm';
  const raw = opts.bookingPolicy ?? process.env.PA_BOOKING_POLICY;
  return raw === 'confirm' ? 'confirm' : 'auto';
}

function readOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PA_READONLY?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

function calendarBookingAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_ALLOW_CALENDAR_BOOKING === '1';
}

function writeBlockedByMode(tool: string): boolean {
  if (!readOnlyEnabled()) return false;
  if (tool === 'calendar.createEvent' && calendarBookingAllowed()) return false;
  return READONLY_BLOCKED_TOOLS.has(tool);
}

function readOnlyRefusal(extra: Record<string, unknown> = {}): HandlerResult {
  const reply = calendarBookingAllowed() ? BOOKING_ENABLED_REPLY : READONLY_REPLY;
  return jsonArtifact({
    ok: false,
    error: 'read-only-refused',
    readOnly: true,
    reply,
    ...extra,
  });
}

function makeIdempotencyId(tool: string, args: Record<string, unknown>, ownerId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ tool, args, ownerId }))
    .digest('hex')
    .slice(0, 24);
}

function confirmTokenFor(idempotencyId: string): string {
  const digest = createHash('sha256').update(`confirm:${idempotencyId}`).digest('hex').slice(0, 16);
  return `confirm_${digest}`;
}

function parseConfirmToken(text: string): string | null {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && typeof parsed.confirmToken === 'string' && parsed.confirmToken.trim() !== '') {
      return parsed.confirmToken.trim();
    }
  } catch {
    // Plain text confirmations are accepted too.
  }

  const match = trimmed.match(/\bconfirm_[a-f0-9]{16}\b/u);
  return match?.[0] ?? null;
}

function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function friendlyIntegrationReply(fallback: string, tool: string, result: unknown): string {
  if (tool === 'calendar.freeBusy' && isRecord(result)) {
    const busy = Array.isArray(result.freeBusy) ? result.freeBusy : [];
    const label = integrationWindowLabel(result);
    if (busy.length === 0) return `I checked your calendar and you look free${label ? ` for ${label}` : ' for that requested window'}.`;
    const count = busy.length;
    return `I checked your calendar and found ${count} busy block${count === 1 ? '' : 's'}${label ? ` for ${label}` : ' in that requested window'}.`;
  }
  if (tool === 'calendar.list' && isRecord(result)) {
    return 'I checked your calendar and found matching events.';
  }
  if (tool === 'email.list' && isRecord(result)) {
    const messages = result.messages;
    if (Array.isArray(messages)) {
      return messages.length === 0
        ? 'I checked your inbox and did not find matching emails.'
        : `I checked your inbox and found ${messages.length} matching email${messages.length === 1 ? '' : 's'}.`;
    }
    return 'I checked your inbox and found matching email results.';
  }
  if (tool === 'email.read' && isRecord(result)) {
    return 'I opened that email and pulled the message details.';
  }
  return fallback;
}

function integrationWindowLabel(result: Record<string, unknown>): string {
  const window = isRecord(result.window) ? result.window : {};
  const min = typeof window.timeMin === 'string' ? window.timeMin : '';
  const max = typeof window.timeMax === 'string' ? window.timeMax : '';
  if (!min || !max) return '';
  return compactWindowLabel(min, max);
}

function compactWindowLabel(timeMin: string, timeMax: string): string {
  const start = parseLocalIsoParts(timeMin);
  const end = parseLocalIsoParts(timeMax);
  if (start && end) {
    if (start.date === end.date) return `${calendarDateLabel(start)} ${clockLabel(start)} to ${clockLabel(end)}`;
    return `${calendarDateLabel(start)} ${clockLabel(start)} to ${calendarDateLabel(end)} ${clockLabel(end)}`;
  }
  const startDate = new Date(timeMin);
  const endDate = new Date(timeMax);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return '';
  return `${startDate.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} to ${endDate.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function parseLocalIsoParts(value: string): { date: string; hour: number; minute: number; dateForLabel: Date } | null {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}$/u);
  if (!match) return null;
  const [year, month, day] = match[1].split('-').map(Number);
  return {
    date: match[1],
    hour: Number(match[2]),
    minute: Number(match[3]),
    dateForLabel: new Date(Date.UTC(year, month - 1, day)),
  };
}

function calendarDateLabel(parts: { dateForLabel: Date }): string {
  return parts.dateForLabel.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function clockLabel(parts: { hour: number; minute: number }): string {
  const hour12 = parts.hour % 12 || 12;
  const suffix = parts.hour >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(parts.minute).padStart(2, '0')} ${suffix}`;
}

type PrepareWriteResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reply: string; needsContact?: { name: string } };

async function prepareWriteArgs(
  tool: string,
  args: Record<string, unknown>,
  offline: boolean,
  ownerId: string,
  opts: RunAssistantOpts,
): Promise<PrepareWriteResult> {
  // Pillar 0.5: resolve a named recipient ("Dana") to a real address before
  // any email write, or ask — never send to a bare string.
  if (tool === 'email.send' || tool === 'email.draft') {
    return resolveEmailRecipientArgs(args, offline, ownerId, opts);
  }
  if (tool !== 'calendar.createEvent') return { ok: true, args };
  if (!(readOnlyEnabled() && calendarBookingAllowed())) return { ok: true, args };
  const normalized = { ...args };
  const hasStart = typeof normalized.start === 'string' && normalized.start.trim() !== '';
  const hasEnd = typeof normalized.end === 'string' && normalized.end.trim() !== '';
  if (hasStart && hasEnd) return { ok: true, args: normalized };

  const query = stringArg(normalized.query) ?? stringArg(normalized.summary) ?? stringArg(normalized.title) ?? '';
  const extracted = await extractCalendarBookingWithBrain(query, offline, opts);
  if (extracted) {
    if (!extracted.ok) return { ok: false, reply: extracted.reply };
    normalized.summary = stringArg(normalized.summary) ?? extracted.summary;
    normalized.start = extracted.start;
    normalized.end = extracted.end;
    return { ok: true, args: normalized };
  }

  const parsed = parseCalendarBookingQuery(query, new Date());
  if (!parsed.ok) return { ok: false, reply: parsed.reply };

  normalized.summary = stringArg(normalized.summary) ?? parsed.summary;
  normalized.start = parsed.start;
  normalized.end = parsed.end;
  return { ok: true, args: normalized };
}

/**
 * Resolve the email recipient against the owner's contacts (Pillar 0.5 /
 * diagram F, email half). A reference becomes exactly one address (injected
 * as `to`), an "add contact" ask (unknown), or a disambiguation ask
 * (several) — but never a guessed bare string. An address supplied directly
 * passes through unchanged so existing flows that already carry a real `to`
 * keep working.
 */
async function resolveEmailRecipientArgs(
  args: Record<string, unknown>,
  offline: boolean,
  ownerId: string,
  opts: RunAssistantOpts,
): Promise<PrepareWriteResult> {
  const normalized = { ...args };

  // A real address already supplied (string or array) needs no resolution.
  if (hasResolvedAddress(normalized.to)) return { ok: true, args: normalized };

  const reference = await extractRecipientReference(normalized, offline, opts);
  if (!reference) {
    return {
      ok: false,
      reply: 'Who should I send that to? Tell me a name from your contacts (or an email address).',
    };
  }

  // A bare email address is itself the recipient — accept it as-is.
  if (isEmailAddress(reference)) {
    normalized.to = reference;
    return { ok: true, args: normalized };
  }

  const contacts = opts.contacts
    ?? (await loadContacts(ownerId, { baseDir: opts.contactsStoreBaseDir }));
  const resolution = resolveContactReference(contacts, reference);
  if (resolution.status === 'matched') {
    normalized.to = resolution.contact.email;
    normalized.toName = resolution.contact.name;
    return { ok: true, args: normalized };
  }
  if (resolution.status === 'ambiguous') {
    const names = resolution.candidates.map((c) => `${c.name} <${c.email}>`).join(', ');
    return {
      ok: false,
      reply: `I know more than one "${reference}" — which one? ${names}`,
    };
  }
  return {
    ok: false,
    reply: `I don't have an email for ${reference}. Add them to your contacts and I'll send it.`,
    needsContact: { name: reference },
  };
}

/** True when `to` is already a deliverable address (or list of them), so no
 *  contact lookup is needed. */
function hasResolvedAddress(value: unknown): boolean {
  if (typeof value === 'string') return isEmailAddress(value);
  if (Array.isArray(value)) return value.length > 0 && value.every((v) => typeof v === 'string' && isEmailAddress(v));
  return false;
}

/** Pull the recipient reference out of the plan args: an explicit field
 *  first, otherwise the named recipient lifted from the request text. The
 *  text path mirrors the calendar extractor (4.8): a live brain extractor
 *  (`recipient_extract`) when enabled, with the deterministic regex as the
 *  offline-first fallback so resolution is fully provable with no key. */
async function extractRecipientReference(
  args: Record<string, unknown>,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<string | null> {
  for (const key of ['to', 'recipient', 'name'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim() !== '') return value[0].trim();
  }
  const text = stringArg(args.query) ?? stringArg(args.body) ?? stringArg(args.summary) ?? '';
  if (!text.trim()) return null;
  const fromBrain = await extractRecipientWithBrain(text, offline, opts);
  if (fromBrain) return fromBrain;
  return extractRecipientFromText(text);
}

type RecipientExtract = { ok: true; recipient: string } | { ok: false };

/** Run the live `recipient_extract` skill to pull the named recipient out of
 *  free text (S3/S10). Returns null offline / when disabled / on any failure,
 *  so the caller falls back to the deterministic regex (4.8 parity with
 *  `extractCalendarBookingWithBrain`). */
async function extractRecipientWithBrain(
  query: string,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<string | null> {
  if (offline || !liveRecipientExtractEnabled() || query.trim() === '') return null;
  const runSkillImpl = opts.runSkillImpl ?? runSkill;
  try {
    const raw = await runSkillImpl('recipient_extract', { query }, { offline: false });
    const normalized = normalizeRecipientExtract(raw);
    return normalized?.ok ? normalized.recipient : null;
  } catch (err) {
    console.warn(`personal agent: recipient extractor failed; falling back to the deterministic parser (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

function liveRecipientExtractEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PA_RECIPIENT_EXTRACT_LIVE?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

function normalizeRecipientExtract(value: unknown): RecipientExtract | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const recipient = stringArg(value.recipient);
    if (!recipient) return null;
    return { ok: true, recipient: recipient.replace(/[’']s$/u, '').trim() };
  }
  if (value.ok === false) return { ok: false };
  return null;
}

const RECIPIENT_STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'me', 'them', 'him', 'her', 'it', 'this', 'that',
  'email', 'mail', 'message', 'everyone', 'someone', 'people', 'team', 'to',
  'for', 'about', 'saying', 'and', 'with',
]);

function extractRecipientFromText(text: string): string | null {
  if (!text.trim()) return null;
  const patterns = [
    /\b(?:to|for)\s+([a-z][a-z'’.-]*)/iu,
    /\b(?:e-?mail|mail|message|send|tell|notify|remind)\s+([a-z][a-z'’.-]*)/iu,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (!match) continue;
    const name = match[1].replace(/[’']s$/u, '').trim();
    if (name && !RECIPIENT_STOPWORDS.has(name.toLowerCase())) return name;
  }
  return null;
}

type CalendarBookingExtract =
  | { ok: true; start: string; end: string; summary: string }
  | { ok: false; reply: string };

async function extractCalendarBookingWithBrain(
  query: string,
  offline: boolean,
  opts: RunAssistantOpts,
): Promise<CalendarBookingExtract | null> {
  if (offline || !liveBookingExtractEnabled() || query.trim() === '') return null;
  const runSkillImpl = opts.runSkillImpl ?? runSkill;
  try {
    const now = new Date();
    // Pillar 0.3 wiring seam: the owner's profile timezone overrides the
    // PA_TIMEZONE/TZ env default at the exact call site that reaches the
    // extractor, so "reason in the owner's timezone" actually lands.
    const timezone = effectiveTimezone(opts);
    const raw = await runSkillImpl('calendar_event_extract', {
      query,
      now: now.toISOString(),
      currentDate: localDateInTimeZone(now, timezone),
      timezone,
    }, { offline: false });
    return normalizeCalendarBookingExtract(raw);
  } catch (err) {
    console.warn(`personal agent: calendar booking extractor failed; falling back to deterministic parser (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

function liveBookingExtractEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PA_BOOKING_EXTRACT_LIVE?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

function normalizeCalendarBookingExtract(value: unknown): CalendarBookingExtract | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const start = stringArg(value.start);
    const end = stringArg(value.end);
    if (!start || !end) return null;
    return {
      ok: true,
      start,
      end,
      summary: stringArg(value.summary) ?? 'Calendar event',
    };
  }
  if (value.ok === false) {
    return {
      ok: false,
      reply: stringArg(value.reply) ?? missingBookingReply(value.missing),
    };
  }
  return null;
}

function missingBookingReply(missing: unknown): string {
  const fields = Array.isArray(missing) ? missing.map((v) => String(v).toLowerCase()) : [];
  if (fields.includes('date')) return 'I can book that, but I need a date first. Try: "Book a meeting with Markus tomorrow from 1pm to 2pm."';
  return 'I can book that, but I need a start and end time first. Try: "Book a meeting with Markus tomorrow from 1pm to 2pm."';
}

function bookingTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return env.PA_TIMEZONE?.trim() || env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The timezone to reason in for a turn: the owner's profile wins, falling
 *  back to the PA_TIMEZONE/TZ/server default (Pillar 0.3). */
function effectiveTimezone(opts: RunAssistantOpts): string {
  return opts.ownerProfile?.timezone?.trim() || bookingTimezone();
}

function localDateInTimeZone(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Fall back to UTC below.
  }
  return date.toISOString().slice(0, 10);
}

function parseCalendarBookingQuery(
  query: string,
  now: Date,
): { ok: true; start: string; end: string; summary: string } | { ok: false; reply: string } {
  const day = parseBookingDay(query, now);
  if (!day) {
    return {
      ok: false,
      reply: 'I can book that, but I need a date first. Try: "Book a meeting with Markus tomorrow from 1pm to 2pm."',
    };
  }
  const range = parseBookingTimeRange(query);
  if (!range) {
    return {
      ok: false,
      reply: 'I can book that, but I need a start and end time first. Try: "Book a meeting with Markus tomorrow from 1pm to 2pm."',
    };
  }
  return {
    ok: true,
    start: `${day}T${range.start}:00`,
    end: `${day}T${range.end}:00`,
    summary: summarizeBookingQuery(query),
  };
}

function parseBookingDay(query: string, now: Date): string | null {
  const explicit = query.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1];
  if (explicit) return explicit;
  const lower = query.toLowerCase();
  const today = new Date(now.getTime());
  const calendarDate = parseCalendarDateText(lower, today);
  if (calendarDate) return calendarDate;
  if (/\btoday\b/u.test(lower)) return dateOnly(today);
  if (/\btomorrow\b/u.test(lower)) return dateOnly(addDays(today, 1));

  const next = lower.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u)?.[1];
  if (next) return dateOnly(nextWeekday(today, next));
  const thisOrComing = lower.match(/\b(?:this|coming)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u)?.[1];
  if (thisOrComing) return dateOnly(nextWeekday(today, thisOrComing, true));
  const bare = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u)?.[1];
  if (bare) return dateOnly(nextWeekday(today, bare, true));
  return null;
}

function parseBookingTimeRange(query: string): { start: string; end: string } | null {
  const match = query.match(
    /\b(?:from\s+|at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|until|til|till|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/iu,
  );
  if (!match) return null;
  const endMeridiem = match[6]?.toLowerCase() as 'am' | 'pm' | undefined;
  const startMeridiem = (match[3]?.toLowerCase() as 'am' | 'pm' | undefined) ?? endMeridiem;
  if (!startMeridiem || !endMeridiem) return null;
  const start = clock24(Number(match[1]), Number(match[2] ?? '0'), startMeridiem);
  const end = clock24(Number(match[4]), Number(match[5] ?? '0'), endMeridiem);
  if (!start || !end) return null;
  return { start, end };
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function parseCalendarDateText(lower: string, now: Date): string | null {
  const monthName = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const weekdayName = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
  const monthDay = lower.match(new RegExp(`\\b(?:${weekdayName}\\s*,?\\s*)?${monthName}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?\\b`, 'u'));
  if (monthDay) {
    const month = MONTHS[monthDay[1].replace(/\.$/u, '')];
    const day = Number(monthDay[2]);
    const year = monthDay[3] ? Number(monthDay[3]) : inferredYear(now, month, day);
    return validDateOnly(year, month, day);
  }

  const numeric = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/u);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    const year = numeric[3] ? Number(numeric[3]) : inferredYear(now, month, day);
    return validDateOnly(year, month, day);
  }
  return null;
}

function inferredYear(now: Date, month: number, day: number): number {
  const currentYear = now.getFullYear();
  const candidate = validDateOnly(currentYear, month, day);
  if (!candidate) return currentYear;
  return candidate < dateOnly(now) ? currentYear + 1 : currentYear;
}

function validDateOnly(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return dateOnly(date);
}

function clock24(hour12: number, minute: number, meridiem: 'am' | 'pm'): string | null {
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  let hour = hour12 % 12;
  if (meridiem === 'pm') hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function nextWeekday(now: Date, weekday: string, allowToday = false): Date {
  const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekday);
  const current = now.getDay();
  let delta = (target - current + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return addDays(now, delta);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function dateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function summarizeBookingQuery(query: string): string {
  const cleaned = query.replace(/\s+/gu, ' ').trim();
  return cleaned || 'Meeting';
}

/**
 * Resolve the integration runner when the caller didn't inject one. On the
 * LIVE path, route integration tools to their env-configured MCP bridge by
 * prefix — loaded via dynamic import so offline checks stay free of the MCP
 * transport. Otherwise fall back to the deterministic offline stub.
 */
/** Google-backed tool families. A tool outside these prefixes never needs a
 *  Google connection (e.g. a future non-Google integration). */
function toolNeedsGoogle(tool: string): boolean {
  return tool.startsWith('calendar.') || tool.startsWith('email.');
}

/**
 * Has this owner connected the provider a tool depends on? Presence of an
 * integration record (written on OAuth success) is the connection signal; an
 * expired token surfaces later as a runtime error with a Retry remedy. Used to
 * fail *gracefully* (Connect-Google remedy) instead of hitting the live MCP
 * server with no credentials (Workstream D.4).
 */
async function ownerIntegrationConnected(
  ownerId: string | undefined,
  provider: 'google',
  opts: RunAssistantOpts,
): Promise<boolean> {
  if (!ownerId) return false;
  const record = await loadIntegration(ownerId, provider, { baseDir: opts.integrationStoreBaseDir });
  return Boolean(record);
}

async function resolveDefaultIntegration(
  offline: boolean,
  tool: string,
  ownerId: string | undefined,
  opts: RunAssistantOpts,
): Promise<RunIntegration> {
  if (!offline) {
    const env = await googleIntegrationEnvForOwner(ownerId, process.env, { baseDir: opts.integrationStoreBaseDir });
    // Live mode (FOUNDATION_OFFLINE=0) must never silently fall through to the
    // offline stub: a missing MCP command is a bridge misconfig, so fail fast
    // with the exact env var to set rather than faking an `offline:true` success.
    if (tool.startsWith('calendar.')) {
      if ((process.env.PA_CALENDAR_MCP_CMD ?? '').trim() === '') {
        throw new Error(
          `live calendar integration "${tool}" requires PA_CALENDAR_MCP_CMD on the bridge env (FOUNDATION_OFFLINE=0); refusing to fall back to the offline stub`,
        );
      }
      const mod = await import('../integrations/calendar-mcp.ts');
      console.log('personal agent: using live calendar integration runner');
      return mod.makeEnvCalendarRunIntegration({ env });
    }
    if (tool.startsWith('email.')) {
      if ((process.env.PA_GMAIL_MCP_CMD ?? '').trim() === '') {
        throw new Error(
          `live Gmail integration "${tool}" requires PA_GMAIL_MCP_CMD on the bridge env (FOUNDATION_OFFLINE=0); refusing to fall back to the offline stub`,
        );
      }
      const mod = await import('../integrations/gmail-mcp.ts');
      console.log('personal agent: using live Gmail integration runner');
      return mod.makeEnvGmailRunIntegration({ env });
    }
  }
  return defaultRunIntegration;
}

async function resolveDefaultSendA2A(offline: boolean, selfHandle?: string): Promise<SendA2A> {
  if (!offline) {
    const credential = selfHandle ? resolveAgentBlocksCredential(selfHandle) : undefined;
    // Live mode must reach a real peer or fail loudly — never the offline
    // stub. A missing key is a bridge misconfig, so surface it at resolve
    // time rather than returning a sender that fakes an `offline:true` reply.
    if ((process.env.BLOCKS_API_KEY ?? '').trim() === '' && !credential) {
      throw new Error(
        'live A2A is enabled (FOUNDATION_OFFLINE=0) but BLOCKS_API_KEY is not set on the bridge env; refusing to fall back to the offline stub',
      );
    }
    const mod = await import('../a2a/a2a-transport.ts');
    console.log(`personal agent: using live A2A direct-handle transport${credential ? ` (${credential.source})` : ''}`);
    return mod.makeLiveSendA2A({ apiKey: credential?.apiKey });
  }
  return defaultSendA2A;
}

/**
 * Default integration runner. Offline (the only path the checks exercise)
 * returns a deterministic stub. The live path reads the owner's real
 * accounts via an OpenClaw MCP server (Phase 8.0) — gated, out of scope
 * here; production injects opts.runIntegration for it.
 */
async function defaultRunIntegration(
  tool: string,
  args: Record<string, unknown>,
  opts: { offline: boolean },
): Promise<unknown> {
  if (opts.offline) {
    return {
      ok: true,
      offline: true,
      tool,
      args,
      note: 'integration is offline-stubbed; the live tool runs through an OpenClaw MCP server — inject opts.runIntegration or configure the matching MCP env to wire a real account',
    };
  }
  throw new Error(
    `live integration "${tool}" is not wired; configure the matching MCP server env or inject opts.runIntegration`,
  );
}

/**
 * Default OUTBOUND transport. Offline (the only path the checks exercise)
 * returns a deterministic stub. The live round-trip — calling a private
 * peer by handle with a real key + an invited membership — is the PA-4
 * live tail (out of scope here); production injects opts.sendA2A for it.
 */
async function defaultSendA2A(
  handle: string,
  request: A2ARequest,
  opts: { offline: boolean },
): Promise<unknown> {
  if (opts.offline) {
    return {
      ok: true,
      a2a: true,
      offline: true,
      to: handle,
      intent: request.intent,
      threadId: request.threadId,
      hop: request.hop,
      note: 'A2A send is offline-stubbed; the live round-trip is gated on a real BLOCKS_API_KEY + an invited peer (PA-4 live tail)',
    };
  }
  throw new Error(
    `live A2A send to "${handle}" is not wired in this offline-first build; inject opts.sendA2A to reach an invited private peer by handle`,
  );
}

/** Convert the consumer-side CallResult into handler artifacts. File artifacts
 *  saved by blocks-client (under agent/outputs/, i.e.
 *  `a.path = "outputs/<file>"`) are returned as JSON media references instead
 *  of raw bytes, so the hosted chat can render them from /outputs without
 *  shoving megabytes through SSE or a JSON artifact. Text/JSON artifacts pass
 *  through as strings. */
export async function passthrough(
  result: CallResult,
  handle: string,
  tag: string,
): Promise<HandlerResult> {
  const arts: ArtifactOut[] = result.artifacts ?? [
    { kind: 'data', data: result.data, mimeType: 'application/json' },
  ];

  const files = arts.filter((a): a is FileArtifact => a.kind === 'file');
  if (files.length > 0) {
    const media = files.map((file) => delegatedFileMedia(file));
    const primary = media[0];
    return jsonArtifact({
      ok: true,
      reply: delegatedMediaReply(primary),
      delegatedTo: handle,
      tag,
      media: primary,
      artifacts: media,
    });
  }

  const dataItems = arts.filter((a): a is Extract<ArtifactOut, { kind: 'data' }> => a.kind === 'data');
  if (dataItems.length === 0) {
    return jsonArtifact({ ok: true, reply: `${handle} returned nothing.`, delegatedTo: handle, tag });
  }

  // X.1 (always-final-reply): a text/JSON specialist result must carry a
  // non-empty human reply — the produced text IS the reply — instead of
  // returning a raw artifact with no `reply` (which left the dashboard
  // dumping JSON). The structured payload rides along in `data`.
  const text = specialistText(dataItems);
  return jsonArtifact({
    ok: true,
    reply: text || `\`${handle}\` finished and returned a result.`,
    delegatedTo: handle,
    tag,
    data: dataItems[0].data,
  });
}

/** Best human-readable text from a specialist's data artifacts: a string
 *  result as-is, or a known text field (summary/headline/transcript/…), else
 *  the compact JSON. Shared by the single-step passthrough (X.1 reply) and
 *  the multi-step specialist step (threadable output). */
function specialistText(items: Array<Extract<ArtifactOut, { kind: 'data' }>>): string {
  const parts: string[] = [];
  for (const item of items) {
    const text = textFromData(item.data);
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

function textFromData(data: unknown): string {
  if (typeof data === 'string') return data.trim();
  if (isRecord(data)) {
    for (const key of ['reply', 'summary', 'text', 'headline', 'caption', 'transcript', 'description', 'message', 'content']) {
      const value = data[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    try {
      return JSON.stringify(data);
    } catch {
      return '';
    }
  }
  if (data === null || data === undefined) return '';
  return String(data);
}

export function delegatedFileMedia(file: FileArtifact): Record<string, unknown> {
  const path = file.path.replace(/^\/+/u, '');
  return {
    kind: 'file',
    path,
    url: file.url ?? publicArtifactUrl(path),
    mimeType: file.mimeType,
    bytes: file.bytes,
    fileName: basename(path),
  };
}

function delegatedMediaReply(media: Record<string, unknown>): string {
  const url = typeof media.url === 'string' ? media.url : '';
  const mimeType = typeof media.mimeType === 'string' ? media.mimeType : '';
  if (!url) return 'The specialist created a file, but I could not build a display URL for it.';
  if (mimeType.startsWith('image/')) return `![Generated image](${url})`;
  if (mimeType.startsWith('audio/')) return `[Audio](${url})`;
  return `[Generated file](${url})`;
}

function publicArtifactUrl(path: string): string {
  const base = (process.env.OUTPUTS_PUBLIC_BASE_URL || process.env.BRIDGE_PUBLIC_BASE_URL || '').trim();
  if (!base) return `/${path}`;
  try {
    return `${new URL(base).origin}/${path}`;
  } catch {
    return `/${path}`;
  }
}

function jsonArtifact(value: unknown): HandlerResult {
  const artifacts: NonNullable<HandlerResult['artifacts']> = [
    { data: JSON.stringify(value), mimeType: 'application/json', outputId: 'result' },
  ];

  const reply = replyArtifactText(value);
  artifacts.push({ data: reply, mimeType: 'text/markdown', outputId: 'reply', fileName: 'reply.md' });

  const actions = actionsArtifactValue(value);
  if (actions) {
    artifacts.push({
      data: JSON.stringify(actions, null, 2),
      mimeType: 'application/json',
      outputId: 'actions',
      fileName: 'actions.json',
    });
  }

  return {
    artifacts,
  };
}

function replyArtifactText(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return JSON.stringify(value, null, 2);

  const reply = stringField(value.reply);
  if (reply) return reply;

  const error = stringField(value.error);
  const reason = stringField(value.reason);
  if (error || reason) {
    return [`Error: ${error ?? 'assistant-error'}`, reason ? `Detail: ${reason}` : ''].filter(Boolean).join('\n');
  }

  return JSON.stringify(value, null, 2);
}

function actionsArtifactValue(value: unknown): unknown[] | null {
  if (!isRecord(value)) return null;
  return Array.isArray(value.actions) ? value.actions : null;
}

function readText(task: StartTaskMessage): string {
  const part =
    task.requestParts?.find((candidate) => candidate.partId === 'request') ??
    task.requestParts?.[0];
  if (!part) return '';

  const raw = typeof part.text === 'string' ? part.text : '';
  if (!raw.trim()) return raw;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && typeof parsed.text === 'string') return parsed.text;
  } catch {
    // Plain text is also accepted.
  }
  return raw;
}

/**
 * Structured image context (Pillar I, Phase 2): when the chat surface reads an
 * attached image up-front (image-to-text on Blocks), it ships the description
 * as its OWN task part instead of concatenating it into the request string.
 * The runtime consumes that structured signal directly — so "is there an image
 * and has it been read?" is a fact, not something the planner re-derives from
 * keywords in a smashed-together prompt.
 */
function readImageContext(task: StartTaskMessage): string[] {
  return (task.requestParts ?? [])
    .filter((part) => part.partId === 'image-understanding')
    .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
    .filter((text) => text.length > 0);
}

/** Compose the direct reply for an "understand this image" turn from the
 *  already-extracted description(s) — the description IS the answer. */
function imageContextReply(descriptions: string[]): string {
  return descriptions.length === 1
    ? descriptions[0]
    : descriptions.map((d, i) => `Image ${i + 1}: ${d}`).join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
