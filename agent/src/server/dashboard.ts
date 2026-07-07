/**
 * OpenClaw foundation server — chat front-end + headless gateway bridge.
 *
 * Two responsibilities, one loopback server:
 *
 *  1. The single chat front-end (the OpenClaw chat design), served at the
 *     base path:
 *
 *       GET  /[asset]              → static chat UI from agent/web/chat/
 *       POST /v1/chat/completions  → streaming proxy to the OpenClaw gateway
 *                                    (injects OPENCLAW_GATEWAY_TOKEN; SSE piped
 *                                    back unbuffered so the UI streams tokens)
 *       POST /api/transcribe       → hire a speech-to-text agent on Blocks and
 *                                    return the transcript (mic → prompt)
 *       POST /api/describe-image   → hire an image-to-text (vision) agent on
 *                                    Blocks and return the description (image → prompt)
 *       POST /api/skill-file       → create a downloadable SKILL.md artifact
 *       POST /api/route            → deterministic intent routing: if the user's
 *                                    text matches a specialist (e.g. LinkedIn tone
 *                                    analysis), call that Blocks agent and return it
 *       GET  /outputs/<file>       → generated images/audio rendered inline
 *       GET  /healthz              → liveness probe
 *
 *  2. The headless JSON bridge the OpenClaw gateway's `blocks-network`
 *     skill curls (via workspace/skills/blocks_network/scripts/blocks).
 *     This is infrastructure, not a UI — it is how the agent discovers,
 *     hires, fans out to, and serves Blocks agents:
 *
 *       GET  /api/status        → bridge health
 *       GET  /api/blocks        → discover the Blocks catalog (by tag)
 *       GET  /api/openclaw      → local OpenClaw skills/agents
 *       GET  /api/local-published, /api/served
 *       POST /api/run-skill, /api/call-agent, /api/fanout, /api/serve, /api/stop
 *       POST /api/assistant/create  → render (dry-run) a per-owner private
 *                                     assistant; never publishes/serves;
 *                                     gated by PERSONAL_ASSISTANTS_ENABLED
 *       POST /api/assistant/invite  → record a mutual peer invite in both
 *                                     rosters (app-level; no Blocks membership)
 *       POST /api/assistant/revoke  → remove a peer from both rosters
 *       GET  /api/assistant/peers   → list an assistant's reachable peers
 *       GET  /api/assistant/overview → per-assistant panel: owner, peers,
 *                                     today's A2A spend, A2A-hop audit
 *       GET/POST /api/profile       → read/set the owner identity profile
 *                                     (name/email/timezone) used by the brain
 *       GET/POST /api/contacts      → list/add the owner's contact book used
 *                                     to resolve email recipients
 *
 * Safety: binds 127.0.0.1 only, network actions fail with a clear error
 * when BLOCKS_API_KEY is missing, the key is never sent to a client, and
 * OPENCLAW_GATEWAY_TOKEN is injected server-side so the operator
 * credential never lives in the browser. Keep this loopback.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchAgentRegistry,
  fetchAgentsByListing,
  fetchAgentsByTag,
  fetchCdmConfig,
  type AgentEntry,
  type HandlerResult,
  type StartTaskMessage,
  type TaskContext,
} from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';
import { runSkill } from '../blocks/openclaw-client.ts';
import { tagForRequest } from '../routing/intent-tags.ts';
import { classifyTurn } from '../routing/turn-router.ts';
import { probePeerReachable, probeStatusLabel, type PeerLiveness } from '../a2a/a2a-transport.ts';
import { connect, agentEntryToDiscovered, walkRegistryPages, catalogScanMax } from '../blocks/blocks-client.ts';
import {
  toCatalogAgent,
  searchCatalog,
  categorize,
  categorizeCatalog,
  queryTerms,
  rankedAgentView,
  formatSearchReply,
  formatCategorizeReply,
  loadCatalogSnapshot,
  type CatalogAgent,
} from '../blocks/catalog-index.ts';
import { fanout } from '../pipeline/fanout.ts';
import { serveAgent, type AgentInstanceHandle, type HandlerFn } from '../blocks/blocks-serve.ts';
import { resolveAgentBlocksCredential } from '../blocks/agent-keyring.ts';
import type { DiscoveredAgent } from '../types.ts';
import { createAssistant, AssistantNameConflictError } from '../assistant/assistant-factory.ts';
import {
  addPeer,
  defaultSharePolicy,
  invitePeer,
  listPeers,
  loadRoster,
  recordPeerMembership,
  removePeer,
  revokePeer,
  saveRoster,
  withCard,
  type PeerIdentityCard,
  type PeerMembership,
  type Roster,
  type SharePolicy,
} from '../assistant/assistant-roster.ts';
import { assistantOverview, type AssistantPanel } from '../assistant/assistant-dashboard.ts';
import { apiIdentity } from '../assistant/identity.ts';
import { loadIntegration } from '../integrations/integration-store.ts';
import { loadOwnerProfile, saveOwnerProfile } from '../assistant/owner-profile.ts';
import { loadContacts, saveContact, removeContact, upsertPeerContact } from '../assistant/contacts-store.ts';
import {
  buildMultiTenantAssistantRoute,
  configuredOwnerIds,
  multiTenantStateBaseDir,
  ownerStateKey,
  runAssistant,
  runMultiTenantAssistant,
  selfHandleForOwner,
  type MultiTenantAssistantOpts,
  type RunAssistantOpts,
} from '../assistant/assistant-runtime.ts';
import {
  buildGoogleOAuthStart,
  completeGoogleOAuth,
  loadGoogleOAuthClient,
  oauthStateSecret,
} from '../integrations/integration-oauth.ts';
import {
  dim,
  red,
  startScope,
  finishScope,
  traceCtx,
  tstep,
  tnote,
  terror,
  tracingPartial,
  previewValue,
  tracingQuiet,
  tracingVerboseAll,
  type PartialEvent,
} from './trace.ts';
import {
  CORS_ORIGIN,
  HttpError,
  json,
  notFound,
  corsPreflight,
  redirect,
  readBody,
  requireString,
  optionalString,
  requireRecord,
  clampInt,
  envInt,
  requireQuery,
  optionalQuery,
  addQuery,
  headerString,
  enforceRateLimit,
  dashboardIdentity,
  ownerFromBody,
  ownerFromQuery,
  DASHBOARD_AUTH_REQUIRED,
  DASHBOARD_AUTH_OWNER_HEADER,
  DASHBOARD_AUTH_ORG_HEADER,
  type DashboardIdentity,
} from './http-io.ts';
import { serveOutputFile, serveMediaFile, serveChatAsset, OUTPUTS_DIR } from './static-assets.ts';
import { proxyChatCompletions } from './chat-proxy.ts';
import { assistantRunResponse, assistantPrimaryPayload, callOutputText, withTimeout, isPlainRecord } from './output-format.ts';
import { skillRoleFromText, slugifySkillName, buildSkillFile } from './skill-file.ts';

loadRootEnv();

const host = process.env.DASHBOARD_HOST ?? '127.0.0.1';
const port = Number(process.env.DASHBOARD_PORT ?? 18888);

/** Blocks skill tag the chat UI's microphone routes audio through. */
const TRANSCRIBE_TAG = process.env.TRANSCRIBE_SKILL_TAG ?? 'speech-to-text';

/** Tiny browser recordings often decode successfully but contain too little
 *  speech for STT to produce text. Refuse them before the Blocks call so the
 *  UI can tell the user what to do. */
const MIN_TRANSCRIBE_BASE64_CHARS = 8_000;

/** Blocks skill tag the chat UI routes uploaded images through for
 *  understanding (image → text). */
const IMAGE_DESCRIBE_TAG = process.env.IMAGE_DESCRIBE_SKILL_TAG ?? 'image-to-text';

interface ServedEntry {
  handle: AgentInstanceHandle;
  dir: string;
  startedAt: number;
}

/** Live agent instances served by this dashboard process. */
const served = new Map<string, ServedEntry>();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const method = req.method ?? 'GET';
  const scope = startScope(method, url.pathname);
  res.on('finish', () => finishScope(scope, res.statusCode));
  void traceCtx.run(scope, () => handleRequest(req, res, url, method));
});

async function handleRequest(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
  const route = `${method} ${url.pathname}`;
  try {
    // CORS preflight for any endpoint, so a separately-hosted front-end
    // (e.g. the chat UI on Netlify) can call this bridge cross-origin.
    if (method === 'OPTIONS') return corsPreflight(res);
    enforceRateLimit(req, route);

    // OpenAI-compatible streaming proxy → OpenClaw gateway. Injects
    // OPENCLAW_GATEWAY_TOKEN server-side so the operator credential never
    // lives in the browser.
    if (url.pathname === '/v1/chat/completions') {
      if (method === 'POST') return await proxyChatCompletions(req, res);
      return notFound(res);
    }

    // Generated artifacts (images/audio) the agent returns, rendered inline.
    if (method === 'GET' && url.pathname.startsWith('/outputs/')) {
      return await serveOutputFile(res, url.pathname);
    }

    // Gateway-generated media. The gateway saves artifacts under its
    // /home/node/.openclaw/media dir, which is bind-mounted to ./data/config
    // on the host (see docker-compose.yml), so we can serve those bytes here.
    if (method === 'GET' && url.pathname.startsWith('/media/')) {
      return await serveMediaFile(res, url.pathname);
    }

    // Headless JSON bridge + chat helpers.
    switch (route) {
      case 'GET /healthz': return json(res, { ok: true });
      case 'GET /api/status': return json(res, status());
      case 'GET /api/identity': return json(res, await apiDashboardIdentity(req));
      case 'GET /api/blocks': return json(res, await blocksCatalog(url));
      case 'GET /api/openclaw': return json(res, await openClawCatalog());
      case 'GET /api/local-published': return json(res, await localPublishedAgents());
      case 'GET /api/served': return json(res, servedList());
      case 'GET /api/profile': return json(res, await apiProfileGet(req, url));
      case 'POST /api/profile': return json(res, await apiProfileSave(req, await readBody(req)));
      case 'GET /api/contacts': return json(res, await apiContactsList(req, url));
      case 'POST /api/contacts': return json(res, await apiContactsSave(req, await readBody(req)));
      case 'POST /api/contacts/remove': return json(res, await apiContactsRemove(req, await readBody(req)));
      case 'GET /api/integrations/status': return json(res, await apiIntegrationsStatus(req, url));
      case 'GET /api/integrations/google/start': return json(res, await apiGoogleOAuthStart(req, url));
      case 'GET /api/integrations/google/callback': return await apiGoogleOAuthCallback(res, url);
      case 'POST /api/run-skill': return json(res, await apiRunSkill(await readBody(req)));
      case 'POST /api/call-agent': return json(res, await apiCallAgent(await readBody(req)));
      case 'POST /api/fanout': return json(res, await apiFanout(await readBody(req)));
      case 'POST /api/assistant/create': return json(res, await apiAssistantCreate(req, await readBody(req)));
      case 'POST /api/assistant/invite': return json(res, await apiAssistantInvite(req, await readBody(req)));
      case 'POST /api/assistant/membership': return json(res, await apiAssistantMembership(req, await readBody(req)));
      case 'POST /api/assistant/revoke': return json(res, await apiAssistantRevoke(req, await readBody(req)));
      case 'POST /api/assistant/run': return json(res, await apiAssistantRun(req, await readBody(req)));
      case 'POST /api/assistant/stream': return await apiAssistantStream(req, res);
      case 'GET /api/assistant/peers': return json(res, await apiAssistantPeers(req, url));
      case 'GET /api/assistant/peer-status': return json(res, await apiAssistantPeerStatus(req, url));
      case 'GET /api/assistant/overview': return json(res, await apiAssistantOverview(req));
      case 'POST /api/serve': return json(res, await apiServe(await readBody(req)));
      case 'POST /api/stop': return json(res, await apiStop(await readBody(req)));
      case 'POST /api/transcribe': return json(res, await apiTranscribe(await readBody(req, 32_000_000)));
      case 'POST /api/describe-image': return json(res, await apiDescribeImage(await readBody(req, 32_000_000)));
      case 'POST /api/skill-file': return json(res, await apiSkillFile(await readBody(req)));
      case 'POST /api/route': return json(res, await apiRoute(await readBody(req)));
      case 'POST /api/classify': return json(res, apiClassify(await readBody(req)));
      default: break;
    }

    // Everything else (GET) is the chat front-end, served from the base path.
    if (method === 'GET') {
      return await serveChatAsset(res, url.pathname);
    }

    return notFound(res);
  } catch (err) {
    if (err instanceof HttpError) {
      terror(err.message);
      return json(res, { ok: false, error: err.message }, err.status);
    }
    const message = err instanceof Error ? err.message : String(err);
    terror(message);
    json(res, { ok: false, error: message }, 500);
  }
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `${red('✗')} ${host}:${port} is already in use — another dashboard is probably running.\n`
        + `  • reuse it: open http://${host}:${port}\n`
        + `  • or free it: lsof -ti tcp:${port} | xargs kill\n`
        + `  • or pick another port: DASHBOARD_PORT=18890 npm run dashboard`,
    );
    process.exit(1);
  }
  console.error(`${red('✗')} dashboard server error:`, err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`OpenClaw multimodal chat + bridge: http://${host}:${port}`);
  const logMode = tracingQuiet() ? 'off (DASHBOARD_QUIET=1)' : tracingVerboseAll() ? 'verbose (all traffic)' : 'on (actions + chat)';
  console.log(dim(`live request tracing: ${logMode}`));
});

function shutdown() {
  for (const [agentName, entry] of served) {
    try {
      entry.handle.stop();
      console.log(`stopped served agent: ${agentName}`);
    } catch {
      // best effort on shutdown
    }
  }
  served.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── action endpoints ────────────────────────────────────────────────────

async function apiDashboardIdentity(req: IncomingMessage) {
  const standing = standingPersonalAssistants();
  if (DASHBOARD_AUTH_REQUIRED) {
    const identity = dashboardIdentity(req, { required: true });
    if (!identity) throw new HttpError(401, 'authenticated owner is missing');
    return {
      ok: true,
      action: 'identity',
      ownerId: identity.ownerId,
      ...(identity.orgId ? { orgId: identity.orgId } : {}),
      ownerIds: standing.ownerIds,
      source: identity.source,
    };
  }
  const hostAssistant = standingAssistantForRequest(req);
  if (hostAssistant) {
    return {
      ok: true,
      action: 'identity',
      ownerId: hostAssistant.ownerId,
      ...(hostAssistant.orgId ? { orgId: hostAssistant.orgId } : {}),
      agentName: hostAssistant.agentName,
      owner: hostAssistant.owner,
      ownerIds: standing.ownerIds,
      source: 'assistant-host',
    };
  }
  const configured = defaultStandingAssistantIdentity(standing);
  if (configured) return configured;

  const identity = await apiIdentity();
  return {
    ...identity,
    ownerIds: standing.ownerIds,
    source: standing.ownerIds.length > 0 && !standing.ownerIds.includes(identity.ownerId)
      ? 'blocks-key-unbound'
      : 'blocks-key',
  };
}

function defaultStandingAssistantIdentity(standing: StandingAssistantBindings) {
  const preferred = (process.env.PA_DEFAULT_OWNER_ID || process.env.PA_OWNER_ID || '').trim();
  const ownerId = preferred && standing.ownerIds.includes(preferred)
    ? preferred
    : standing.ownerIds.length === 1 ? standing.ownerIds[0] : '';
  if (!ownerId) return undefined;

  const handle = standing.selfHandleByOwnerId[ownerId];
  const assistant = handle ? standing.assistantsByHandle[handle] : undefined;
  return {
    ok: true,
    action: 'identity',
    ownerId,
    ...(standing.orgIdByOwnerId[ownerId] ? { orgId: standing.orgIdByOwnerId[ownerId] } : {}),
    ...(assistant ? { agentName: assistant.agentName, owner: assistant.owner } : {}),
    ownerIds: standing.ownerIds,
    source: preferred ? 'assistant-default' : 'assistant-single',
  };
}

async function apiRunSkill(body: Record<string, unknown>) {
  const skill = requireString(body, 'skill');
  const inputs = requireRecord(body, 'inputs');
  tstep(`run local OpenClaw skill "${skill}" · inputs=${previewValue(inputs)}`);
  const started = Date.now();
  const data = await runSkill(skill, inputs);
  const latencyMs = Date.now() - started;
  tnote(`→ ${previewValue(data)} (${latencyMs}ms)`);
  return { ok: true, action: 'run-skill', skill, data, latencyMs };
}

async function apiCallAgent(body: Record<string, unknown>) {
  const handle = requireString(body, 'handle');
  const skill = requireString(body, 'skill');
  const inputs = requireRecord(body, 'inputs');
  requireKeyWhenOnline('Calling a Blocks agent');
  tstep(`call Blocks agent "${handle}" [${skill}] · inputs=${previewValue(inputs)}`);

  const partials: PartialEvent[] = [];
  const session = await connect({ latencyScale: 0, onPartial: tracingPartial(partials) });

  try {
    const pool = await session.discover(skill);
    tnote(`discover("${skill}") → ${pool.length} candidate(s)`);
    if (!pool.some((agent) => agent.handle === handle)) {
      throw new HttpError(
        404,
        `agent "${handle}" was not found via discover("${skill}") — check the skill tag`,
      );
    }
    const result = await session.call(handle, skill, inputs);
    tnote(`→ ${previewValue(result.data)} · ${result.meta.latencyMs}ms · $${result.meta.costUsd.toFixed(3)}`);
    return { ok: true, action: 'call-agent', data: result.data, artifacts: result.artifacts, meta: result.meta, partials };
  } finally {
    session.close();
  }
}

const FANOUT_MODES = ['all', 'race', 'quorum', 'best'] as const;

async function apiFanout(body: Record<string, unknown>) {
  const skill = optionalString(body, 'skill');
  const inputs = requireRecord(body, 'inputs');
  const limit = clampInt(body.limit, 1, 25, 10);
  const tries = clampInt(body.tries, 1, 3, 2);
  const mode = (optionalString(body, 'mode') ?? 'all') as (typeof FANOUT_MODES)[number];
  if (!FANOUT_MODES.includes(mode)) {
    throw new HttpError(400, `mode must be one of ${FANOUT_MODES.join(', ')}`);
  }
  const quorum = mode === 'quorum' ? clampInt(body.quorum, 1, 25, 2) : undefined;
  requireKeyWhenOnline('Fan-out');
  tstep(
    `fan-out mode=${mode} · ${skill ? `skill="${skill}"` : 'whole catalog'} · tries=${tries}`
      + `${quorum ? ` quorum=${quorum}` : ''} · inputs=${previewValue(inputs)}`,
  );

  const partials: PartialEvent[] = [];
  const { results, audit, failures, attemptsByHandle, abandoned, verdict } = await fanout({
    skill,
    inputs,
    limit,
    tries,
    mode,
    quorum,
    latencyScale: 0,
    onPartial: tracingPartial(partials),
  });

  let totalCostUsd = 0;
  let maxLatencyMs = 0;
  for (const meta of audit) {
    totalCostUsd += meta.costUsd;
    maxLatencyMs = Math.max(maxLatencyMs, meta.latencyMs);
  }
  const retried = results.filter((r) => (attemptsByHandle[r.meta.handle] ?? 1) > 1).length;

  for (const r of results) {
    const attempts = attemptsByHandle[r.meta.handle] ?? 1;
    tnote(`✓ ${r.meta.handle}${attempts > 1 ? ` (ok after ${attempts} tries)` : ''} → ${previewValue(r.data)}`);
  }
  for (const f of failures) tnote(`✗ ${f.handle} failed after ${f.attempts}: ${f.reason}`);
  for (const h of abandoned ?? []) tnote(`○ ${h} abandoned (resolution already reached)`);
  if (verdict) tnote(`judge → winner ${verdict.winner}: ${verdict.reason}`);
  tnote(
    `summary: ${audit.length} ok${retried ? ` (${retried} retried)` : ''}, ${failures.length} failed`
      + `${abandoned?.length ? `, ${abandoned.length} abandoned` : ''} · $${totalCostUsd.toFixed(3)} · max ${maxLatencyMs}ms`,
  );

  return {
    ok: true,
    action: 'fanout',
    results,
    audit,
    failures,
    attemptsByHandle,
    abandoned,
    verdict,
    partials,
    summary: {
      mode,
      calls: audit.length + failures.length,
      okCount: audit.length,
      retried,
      failed: failures.length,
      abandoned: abandoned?.length ?? 0,
      winner: verdict?.winner,
      totalCostUsd,
      maxLatencyMs,
    },
  };
}

/** Render (and optionally write) a per-owner private assistant. DRY-RUN
 *  ONLY: this never publishes or serves — going live burns a permanent
 *  Blocks name and is a separate explicit step (PA-2 live path). Gated by
 *  PERSONAL_ASSISTANTS_ENABLED so it is off by default. */
async function apiAssistantCreate(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const owner = requireString(body, 'owner');
  const ownerId = ownerFromBody(req, body, 'ownerId');
  const orgId = optionalString(body, 'orgId');
  const slug = optionalString(body, 'slug');
  const write = body.write === true;
  const replace = body.replace === true;
  tstep(`assistant.create (dry-run) owner="${owner}" write=${write} replace=${replace}`);

  const existing = replace ? [] : await publishedDirs();
  try {
    const result = await createAssistant({ owner, ownerId, orgId, slug, write, existing });
    tnote(`→ ${result.agentName} (${write ? 'files written' : 'preview only'}; NOT published or served)`);
    return { action: 'assistant-create', ...result };
  } catch (err) {
    if (err instanceof AssistantNameConflictError) throw new HttpError(409, err.message);
    throw err;
  }
}

/** Record a MUTUAL invite in both rosters (app-level handle exchange).
 *  This does NOT grant a native Blocks membership (`blocks invite
 *  send/accept`) — that is the live tail. Peer handles come from this
 *  roster, never from discover (private peers aren't discoverable). */
async function apiAssistantInvite(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const owner = requireString(body, 'owner');
  const agentName = requireString(body, 'agentName');
  const ownerId = ownerFromBody(req, body, 'ownerId', { optionalWhenUnauthenticated: true });
  const peerOwner = requireString(body, 'peerOwner');
  const peerAgentName = requireString(body, 'peerAgentName');
  const peerOwnerId = optionalString(body, 'peerOwnerId');
  const sharePolicy = parseSharePolicy(body.sharePolicy);
  // (3.2 + Workstream I.1) SELF-DESCRIBING identity cards exchanged at invite:
  // name + email + handle + capabilities. The peer's card lands on the
  // inviter's side (so "Kayley" resolves AND materializes a contact), the
  // inviter's card on the peer's side. Share-policy unchanged.
  const peerCard = parseIdentityCard(body.peerCard);
  // The inviter's own card is sourced from its owner profile where available
  // (displayName/email + the assistant handle), so the peer receives a
  // complete self-description with no manual typing. Any explicit body card
  // overrides the profile-derived defaults.
  const selfCard = await resolveSelfCard(agentName, ownerId, parseIdentityCard(body.selfCard));
  tstep(`assistant.invite ${agentName} ↔ ${peerAgentName}`);

  const { self, peer } = ownerId && peerOwnerId
    ? await invitePeerAcrossOwners({ owner, ownerId, agentName, peerOwner, peerOwnerId, peerAgentName, sharePolicy, selfCard, peerCard })
    : await invitePeer({ owner, agentName, ownerId, peerOwner, peerAgentName, peerOwnerId, sharePolicy, selfCard, peerCard });

  // Workstream I.2: the recorded peer is self-describing, so materialize/merge
  // a contact joined by `peerHandle` — "email Kayley" and "ask Kayley's
  // assistant" then resolve to the SAME identity (no manual contact typing).
  // Mutual where we know the peer owner (their book gets the inviter's card).
  const contactsBaseDir = dashboardContactsStoreBaseDir();
  if (ownerId) {
    const recordedPeer = self.peers.find((p) => p.agentName === peerAgentName);
    if (recordedPeer) await upsertPeerContact(ownerId, recordedPeer, { baseDir: contactsBaseDir });
  }
  if (ownerId && peerOwnerId) {
    const recordedSelf = peer.peers.find((p) => p.agentName === agentName);
    if (recordedSelf) await upsertPeerContact(peerOwnerId, recordedSelf, { baseDir: contactsBaseDir });
  }

  const membership = membershipGuidance(agentName, peerAgentName, peerOwner);
  tnote(`→ rosters updated (${self.peers.length}/${peer.peers.length} peers); membership=${membership.state} (network grant is the live step)`);
  return {
    ok: true,
    action: 'assistant-invite',
    // Back-compat boolean kept for older clients; the structured `membership`
    // block is the honest, actionable state (Workstream C).
    membershipGranted: membership.state === 'granted',
    membership,
    self,
    peer,
  };
}

/**
 * Build the inviter's self-describing identity card (Workstream I.1). Sources
 * `ownerName`/`email` from the owner profile and always sets the assistant
 * `handle`, so the peer receives a complete card it can turn into a contact.
 * An explicit `bodyCard` (from the request) overrides the profile-derived
 * fields — the caller stays in control. Returns undefined only when there is
 * genuinely nothing to describe (no profile, no body card, empty owner).
 */
async function resolveSelfCard(
  agentName: string,
  ownerId: string | undefined,
  bodyCard: PeerIdentityCard | undefined,
): Promise<PeerIdentityCard | undefined> {
  const fromProfile: PeerIdentityCard = { handle: agentName };
  if (ownerId) {
    const profile = await loadOwnerProfile(ownerId, { baseDir: dashboardProfileStoreBaseDir() });
    if (profile?.displayName) fromProfile.ownerName = profile.displayName;
    if (profile?.email) fromProfile.email = profile.email;
  }
  const merged: PeerIdentityCard = { ...fromProfile, ...(bodyCard ?? {}) };
  // `handle` always defaults to this assistant unless the body overrode it.
  if (!merged.handle) merged.handle = agentName;
  return merged;
}

/**
 * The honest membership state + the exact native commands to grant it
 * (Workstream C.1). A fresh invite is `app-level`: handles are exchanged in
 * the roster, but the network membership is a separate `blocks invite
 * send/accept` step the Blocks SDK does NOT expose, so we surface the precise
 * commands instead of pretending it happened. Once the invitee accepts, the
 * operator records it via `POST /api/assistant/membership`.
 */
function membershipGuidance(
  agentName: string,
  peerAgentName: string,
  peerOwner: string,
): { state: PeerMembership; grantCommands: string[]; recordCommand: string; note: string } {
  return {
    state: 'app-level',
    grantCommands: [
      `blocks invite send ${peerAgentName} --email ${peerOwner}`,
      'blocks invite accept <token>   # run by the invitee on their account',
    ],
    recordCommand:
      `POST /api/assistant/membership {"agentName":"${agentName}","peerAgentName":"${peerAgentName}","state":"granted"}`,
    note:
      'Roster handles exchanged. The native Blocks membership is a separate CLI step (the SDK exposes no grant call); once the invitee accepts, record it with the membership endpoint so the roster + live A2A reflect the real grant.',
  };
}

/**
 * Record (and persist) a peer's native membership state after the external
 * `blocks invite send/accept` flow (Workstream C.1). This is how the roster +
 * UI.4 panel reflect the *real* grant state — code can't grant membership
 * (no SDK call), but it can track it once the human accept has happened.
 */
async function apiAssistantMembership(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const agentName = requireString(body, 'agentName');
  const peerAgentName = requireString(body, 'peerAgentName');
  const ownerId = ownerFromBody(req, body, 'ownerId', { optionalWhenUnauthenticated: true });
  const peerOwnerId = optionalString(body, 'peerOwnerId');
  const state = parseMembershipState(body.state);
  tstep(`assistant.membership ${agentName} → ${peerAgentName} = ${state}`);

  // Record on the inviter's side (whether *I* can reach the peer). When both
  // owner ids are supplied, mark it mutually so each side's roster agrees.
  const self = await recordPeerMembership(
    agentName,
    peerAgentName,
    state,
    ownerId ? ownerRosterBaseDir(ownerId) : undefined,
  );
  let peer: Roster | undefined;
  if (ownerId && peerOwnerId) {
    peer = await recordPeerMembership(peerAgentName, agentName, state, ownerRosterBaseDir(peerOwnerId));
  }
  tnote(`→ membership recorded (${state})`);
  return { ok: true, action: 'assistant-membership', state, self, ...(peer ? { peer } : {}) };
}

function parseMembershipState(value: unknown): PeerMembership {
  if (value === 'app-level' || value === 'pending' || value === 'granted') return value;
  throw new HttpError(400, '"state" must be one of "app-level" | "pending" | "granted"');
}

async function apiAssistantRevoke(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const agentName = requireString(body, 'agentName');
  const peerAgentName = requireString(body, 'peerAgentName');
  const ownerId = ownerFromBody(req, body, 'ownerId', { optionalWhenUnauthenticated: true });
  const peerOwnerId = optionalString(body, 'peerOwnerId');
  tstep(`assistant.revoke ${agentName} ⊘ ${peerAgentName}`);
  const { self, peer } = ownerId && peerOwnerId
    ? await revokePeerAcrossOwners({ agentName, ownerId, peerAgentName, peerOwnerId })
    : await revokePeer({ agentName, peerAgentName });
  tnote(`→ removed from both rosters`);
  return { ok: true, action: 'assistant-revoke', self, peer };
}

/** Structured image context (Phase 2): the chat surface reads an attached
 *  image on Blocks up-front and posts the description as `attachments`
 *  (`[{ kind: 'image', description }]`). We carry each description as its OWN
 *  request part so the runtime consumes a structured signal instead of a
 *  description smashed into the request text. */
function imageUnderstandingParts(body: Record<string, unknown>): Array<{ partId: string; text: string; contentType: string }> {
  const raw = body.attachments;
  if (!Array.isArray(raw)) return [];
  const parts: Array<{ partId: string; text: string; contentType: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const att = entry as Record<string, unknown>;
    if (att.kind !== 'image') continue;
    const description = typeof att.description === 'string' ? att.description.trim() : '';
    if (description) parts.push({ partId: 'image-understanding', text: description, contentType: 'text/plain' });
  }
  return parts;
}

async function apiAssistantRun(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const imageParts = imageUnderstandingParts(body);
  // An attached image carries the intent on its own, so a typed message is only
  // required when there's no image to talk about.
  const text = imageParts.length ? (optionalString(body, 'text') ?? '') : requireString(body, 'text');
  const ownerId = ownerFromBody(req, body, 'ownerId');
  const taskId = optionalString(body, 'taskId') || `chat-${Date.now()}`;
  const statuses: string[] = [];
  const ctx = { reportStatus: (message: string) => { statuses.push(message); } } as unknown as TaskContext;
  const task = {
    type: 'StartTask',
    taskId,
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }, ...imageParts],
  } as StartTaskMessage;

  tstep(`assistant.run owner="${ownerId}"`);
  const result = await runMultiTenantAssistant(task, ctx, dashboardMultiTenantOpts());
  return { ok: true, action: 'assistant-run', ...assistantRunResponse(result), statuses };
}

async function apiAssistantStream(req: IncomingMessage, res: ServerResponse) {
  requirePersonalAssistantsEnabled();
  const body = await readBody(req);
  const imageParts = imageUnderstandingParts(body);
  const text = imageParts.length ? (optionalString(body, 'text') ?? '') : requireString(body, 'text');
  const ownerId = ownerFromBody(req, body, 'ownerId');
  const taskId = optionalString(body, 'taskId') || `chat-${Date.now()}`;
  const startedAt = Date.now();

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': CORS_ORIGIN,
  });

  const send = (event: string, data: Record<string, unknown>) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const statuses: string[] = [];
  const ctx = {
    reportStatus: (message: string) => {
      statuses.push(message);
      send('status', { message, at: Date.now(), index: statuses.length - 1 });
    },
    // UI.9: structured per-step ledger events so the chat renders a live
    // step list instead of parsing prose `status` lines.
    reportStep: (event: Record<string, unknown>) => {
      send('step', { ...event, at: Date.now() });
    },
  } as unknown as TaskContext;
  const task = {
    type: 'StartTask',
    taskId,
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }, ...imageParts],
  } as StartTaskMessage;

  try {
    send('status', { message: 'personal agent: accepted request', at: startedAt, index: -1 });
    tstep(`assistant.stream owner="${ownerId}"`);
    const result = await runMultiTenantAssistant(task, ctx, dashboardMultiTenantOpts());
    send('final', {
      ok: true,
      action: 'assistant-stream',
      ...assistantRunResponse(result),
      statuses,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    send('error', {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      statuses,
      latencyMs: Date.now() - startedAt,
    });
  } finally {
    res.end();
  }
}

async function apiAssistantPeers(req: IncomingMessage, url: URL) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromQuery(req, url, 'owner', { optionalWhenUnauthenticated: true });
  const agentName = url.searchParams.get('agentName')?.trim()
    ?? (ownerId ? selfHandleForOwner(ownerId, dashboardMultiTenantOpts()) : undefined);
  if (!agentName) throw new HttpError(400, '"agentName" query parameter is required');
  if (!/^[a-zA-Z0-9_-]+$/u.test(agentName)) throw new HttpError(400, 'invalid agentName');
  const peers = await listPeers(agentName, ownerId ? ownerRosterBaseDir(ownerId) : undefined);
  return { ok: true, action: 'assistant-peers', agentName, peers };
}

/** Per-peer liveness. The registry only proves an agent is *registered*, so
 *  the UI must not claim it's "online". This sends a bounded reachability
 *  probe (a2a-transport) and reports a 3-state: online (an instance picked it
 *  up), offline (asked, nobody home), or unknown (couldn't ask — offline mode,
 *  no key, transport error). Never conflates "registered" with "serving". */
async function apiAssistantPeerStatus(req: IncomingMessage, url: URL) {
  requirePersonalAssistantsEnabled();
  const handle = url.searchParams.get('handle')?.trim();
  if (!handle) throw new HttpError(400, '"handle" query parameter is required');
  if (!/^[a-zA-Z0-9_-]+$/u.test(handle)) throw new HttpError(400, 'invalid handle');

  const unknown = (reason: string): { ok: true; action: 'peer-status'; handle: string; status: PeerLiveness; reason: string; checkedAt: string } => ({
    ok: true, action: 'peer-status', handle, status: 'unknown', reason, checkedAt: new Date().toISOString(),
  });

  // Peers live on the real Blocks network — there's nothing to probe offline.
  if (process.env.FOUNDATION_OFFLINE !== '0') {
    return unknown('Offline mode — peer liveness is only meaningful against the live Blocks network.');
  }
  if (!process.env.BLOCKS_API_KEY) {
    return unknown('Authenticate to Blocks (BLOCKS_API_KEY) to probe peer liveness.');
  }

  const result = await probePeerReachable(handle, { timeoutMs: 6_000 });
  return {
    ok: true,
    action: 'peer-status' as const,
    handle,
    status: probeStatusLabel(result),
    latencyMs: result.latencyMs,
    reason: result.reason,
    checkedAt: new Date().toISOString(),
  };
}

/** PA-5 dashboard surface: one panel per assistant — owner, peers, today's
 *  A2A spend, and the A2A-hop audit. Joins the invite roster, the daily
 *  budget, and the hop trail with THIS dashboard's live served-handle map
 *  (no duplicated state). */
async function apiAssistantOverview(req: IncomingMessage) {
  requirePersonalAssistantsEnabled();
  tstep('assistant.overview — owner/peers/spend/A2A-hop audit per assistant');
  const servedInfo = [...served.entries()].map(([agentName, entry]) => ({
    agentName,
    instanceId: entry.handle.instanceId,
    startedAt: entry.startedAt,
  })).filter((entry) => isPersonalAssistantName(entry.agentName));
  if (multiTenantAssistantsEnabled()) {
    const identity = dashboardIdentity(req, { required: false });
    const hostAssistant = standingAssistantForRequest(req);
    const overview = await multiTenantAssistantOverview(
      servedInfo,
      identity ? [identity.ownerId] : hostAssistant ? [hostAssistant.ownerId] : undefined,
    );
    const enriched = await attachBlocksPrivateAgents(overview);
    tnote(`→ ${overview.assistants.length} owner-scoped assistant panel(s); ${overview.a2aCallsToday}/${overview.dailyCap} A2A calls today`);
    return enriched;
  }
  const overview = await assistantOverview({ served: servedInfo });
  await attachIntegrationStatus(overview.assistants, configuredOwnerIds(process.env));
  const enriched = await attachBlocksPrivateAgents(overview);
  tnote(`→ ${overview.assistants.length} assistant(s); ${overview.a2aCallsToday}/${overview.dailyCap} A2A calls today`);
  return enriched;
}

// ── owner profile + contacts (Pillar 0.6) ───────────────────────────────
// Minimal CRUD over the same per-owner stores the runtime reads, so a
// tester can populate "my name/email/timezone" and "Dana" and have the
// assistant immediately use them for identity, timezone, and recipient
// resolution.

async function apiProfileGet(req: IncomingMessage, url: URL) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromQuery(req, url, 'owner');
  const profile = await loadOwnerProfile(ownerId, { baseDir: dashboardProfileStoreBaseDir() });
  return { ok: true, ownerId, profile };
}

async function apiProfileSave(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromBody(req, body, 'ownerId');
  const profile = await saveOwnerProfile(
    ownerId,
    {
      ...(optionalString(body, 'displayName') ? { displayName: optionalString(body, 'displayName') } : {}),
      ...(optionalString(body, 'email') ? { email: optionalString(body, 'email') } : {}),
      ...(optionalString(body, 'timezone') ? { timezone: optionalString(body, 'timezone') } : {}),
      ...(optionalString(body, 'orgId') ? { orgId: optionalString(body, 'orgId') } : {}),
      ...parseWorkingHours(body.workingHours),
    },
    { baseDir: dashboardProfileStoreBaseDir() },
  );
  tstep(`assistant.profile saved owner="${ownerId}"`);
  return { ok: true, action: 'profile-save', ownerId, profile };
}

async function apiContactsList(req: IncomingMessage, url: URL) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromQuery(req, url, 'owner');
  const contacts = await loadContacts(ownerId, { baseDir: dashboardContactsStoreBaseDir() });
  return { ok: true, ownerId, contacts };
}

async function apiContactsSave(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromBody(req, body, 'ownerId');
  const name = requireString(body, 'name');
  const email = requireString(body, 'email');
  const aliases = Array.isArray(body.aliases)
    ? body.aliases.filter((alias): alias is string => typeof alias === 'string')
    : [];
  const peerHandle = optionalString(body, 'peerHandle');
  const contacts = await saveContact(
    ownerId,
    { name, email, aliases, ...(peerHandle ? { peerHandle } : {}) },
    { baseDir: dashboardContactsStoreBaseDir() },
  );
  tstep(`assistant.contacts saved owner="${ownerId}" contact="${name}"`);
  return { ok: true, action: 'contacts-save', ownerId, contacts };
}

async function apiContactsRemove(req: IncomingMessage, body: Record<string, unknown>) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromBody(req, body, 'ownerId');
  const name = requireString(body, 'name');
  const contacts = await removeContact(ownerId, name, { baseDir: dashboardContactsStoreBaseDir() });
  return { ok: true, action: 'contacts-remove', ownerId, contacts };
}

/** Coerce a loose { start, end } object into working hours, or {} when
 *  absent/incomplete (so saveOwnerProfile just drops it). */
function parseWorkingHours(value: unknown): { workingHours?: { start: string; end: string } } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const wh = value as Record<string, unknown>;
  const start = typeof wh.start === 'string' ? wh.start.trim() : '';
  const end = typeof wh.end === 'string' ? wh.end.trim() : '';
  if (!start || !end) return {};
  return { workingHours: { start, end } };
}

async function apiIntegrationsStatus(req: IncomingMessage, url: URL) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromQuery(req, url, 'owner');
  const google = await loadIntegration(ownerId, 'google', { baseDir: dashboardIntegrationStoreBaseDir() });
  return {
    ok: true,
    ownerId,
    google: {
      connected: Boolean(google),
      scopes: google?.scopes ?? [],
      connectedAt: google?.connectedAt,
    },
  };
}

async function apiGoogleOAuthStart(req: IncomingMessage, url: URL) {
  requirePersonalAssistantsEnabled();
  const ownerId = ownerFromQuery(req, url, 'owner');
  const origin = publicBridgeOrigin(url);
  const returnTo = optionalQuery(url, 'returnTo') ?? `${origin}/?google=return`;
  const client = await loadGoogleOAuthClient();
  const redirectUri = `${origin}/api/integrations/google/callback`;
  const start = buildGoogleOAuthStart({
    ownerId,
    client,
    redirectUri,
    returnTo,
    stateSecret: oauthStateSecret(client),
  });
  tstep(`integrations.google.start owner="${ownerId}"`);
  return { ok: true, ownerId, url: start.url, scopes: start.scopes };
}

async function apiGoogleOAuthCallback(res: ServerResponse, url: URL) {
  requirePersonalAssistantsEnabled();
  const origin = publicBridgeOrigin(url);
  const code = requireQuery(url, 'code');
  const state = requireQuery(url, 'state');
  const client = await loadGoogleOAuthClient();
  const redirectUri = `${origin}/api/integrations/google/callback`;
  try {
    const done = await completeGoogleOAuth({
      code,
      state,
      client,
      redirectUri,
      stateSecret: oauthStateSecret(client),
      store: { baseDir: dashboardIntegrationStoreBaseDir() },
    });
    tstep(`integrations.google.callback owner="${done.ownerId}"`);
    redirect(res, addQuery(done.returnTo, { google: 'connected', owner: done.ownerId }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    terror(`integrations.google.callback failed: ${message}`);
    redirect(res, addQuery(`${origin}/`, { google: 'error' }));
  }
}

function publicBridgeOrigin(url: URL): string {
  const configured = process.env.BRIDGE_PUBLIC_BASE_URL?.trim();
  if (!configured) return url.origin;
  try {
    const parsed = new URL(configured);
    return parsed.origin;
  } catch {
    return url.origin;
  }
}

async function invitePeerAcrossOwners(args: {
  owner: string;
  ownerId: string;
  agentName: string;
  peerOwner: string;
  peerOwnerId: string;
  peerAgentName: string;
  sharePolicy?: SharePolicy;
  selfCard?: PeerIdentityCard;
  peerCard?: PeerIdentityCard;
}): Promise<{ self: Roster; peer: Roster }> {
  if (args.agentName === args.peerAgentName) throw new Error('an assistant cannot invite itself');
  const since = new Date().toISOString();
  const selfBaseDir = ownerRosterBaseDir(args.ownerId);
  const peerBaseDir = ownerRosterBaseDir(args.peerOwnerId);

  const self = addPeer(await loadRoster(args.agentName, { owner: args.owner, baseDir: selfBaseDir }), withCard({
    owner: args.peerOwner,
    agentName: args.peerAgentName,
    since,
    sharePolicy: args.sharePolicy ?? defaultSharePolicy(),
    ownerId: args.peerOwnerId,
  }, args.peerCard));
  const peer = addPeer(await loadRoster(args.peerAgentName, { owner: args.peerOwner, baseDir: peerBaseDir }), withCard({
    owner: args.owner,
    agentName: args.agentName,
    since,
    sharePolicy: defaultSharePolicy(),
    ownerId: args.ownerId,
  }, args.selfCard));

  await saveRoster(self, selfBaseDir);
  await saveRoster(peer, peerBaseDir);
  return { self, peer };
}

async function revokePeerAcrossOwners(args: {
  agentName: string;
  ownerId: string;
  peerAgentName: string;
  peerOwnerId: string;
}): Promise<{ self: Roster; peer: Roster }> {
  const selfBaseDir = ownerRosterBaseDir(args.ownerId);
  const peerBaseDir = ownerRosterBaseDir(args.peerOwnerId);
  const self = removePeer(await loadRoster(args.agentName, { baseDir: selfBaseDir }), args.peerAgentName);
  const peer = removePeer(await loadRoster(args.peerAgentName, { baseDir: peerBaseDir }), args.agentName);
  await saveRoster(self, selfBaseDir);
  await saveRoster(peer, peerBaseDir);
  return { self, peer };
}

async function multiTenantAssistantOverview(
  servedInfo: Array<{ agentName: string; instanceId?: string; startedAt?: number }>,
  scopedOwners?: string[],
) {
  const owners = scopedOwners ?? configuredOwnerIds(process.env);
  const generatedAt = Date.now();
  const assistants = [];
  let dailyCap = 0;
  let a2aCallsToday = 0;

  const seenAssistantNames = new Set<string>();

  for (const ownerId of owners) {
    const route = await buildMultiTenantAssistantRoute(ownerId, dashboardMultiTenantOpts());
    const selfHandle = route.opts.selfHandle ?? selfHandleForOwner(ownerId, dashboardMultiTenantOpts());
    const exactServed = servedInfo.filter((entry) => entry.agentName === selfHandle);
    const inheritedServed = exactServed.length > 0
      ? exactServed
      : servedInfo.map((entry) => ({ ...entry, agentName: selfHandle }));
    const overview = await assistantOverview({
      served: inheritedServed,
      rosterBaseDir: route.opts.rosterBaseDir,
      budgetBaseDir: route.opts.budgetBaseDir,
      auditBaseDir: route.opts.auditBaseDir,
    });
    await attachIntegrationStatus(overview.assistants, [ownerId]);
    dailyCap = overview.dailyCap;
    a2aCallsToday += overview.a2aCallsToday;
    for (const assistant of overview.assistants) {
      if (!assistant.agentName || seenAssistantNames.has(assistant.agentName)) continue;
      seenAssistantNames.add(assistant.agentName);
      assistants.push(assistant);
    }
  }

  return {
    ok: true as const,
    action: 'assistant-overview' as const,
    generatedAt,
    dailyCap,
    a2aCallsToday,
    assistants,
  };
}

interface BlocksPrivateAgentsOverview {
  ok: boolean;
  status: 'offline' | 'online' | 'unauthenticated' | 'unavailable';
  totalCount: number;
  hiddenOwnedCount: number;
  agents: ReturnType<typeof blocksView>[];
  note: string;
  error?: string;
}

async function attachBlocksPrivateAgents<T extends object>(
  overview: T,
): Promise<T & { blocksPrivateAgents: BlocksPrivateAgentsOverview }> {
  return {
    ...overview,
    blocksPrivateAgents: await blocksPrivateAgentsOverview(),
  };
}

async function blocksPrivateAgentsOverview(): Promise<BlocksPrivateAgentsOverview> {
  if (process.env.FOUNDATION_OFFLINE !== '0') {
    return {
      ok: true,
      status: 'offline',
      totalCount: 0,
      hiddenOwnedCount: 0,
      agents: [],
      note: 'Offline mode is using local assistant rosters only.',
    };
  }

  if (!process.env.BLOCKS_API_KEY) {
    return {
      ok: false,
      status: 'unauthenticated',
      totalCount: 0,
      hiddenOwnedCount: 0,
      agents: [],
      note: 'Set BLOCKS_API_KEY or run Blocks authentication to see private agents visible to this account.',
    };
  }

  try {
    const baseUrl = await blocksBaseUrl();
    const result = await fetchAgentsByListingAuthenticated('private', { limit: 50, baseUrl });
    const ownedNames = await localPublishedPrivateAgentNames();
    const visibleAgents = result.agents.map(blocksView);
    const agents = visibleAgents.filter((agent) => !ownedNames.has(agent.agentName));
    const hiddenOwnedCount = visibleAgents.length - agents.length;
    return {
      ok: true,
      status: 'online',
      totalCount: agents.length,
      hiddenOwnedCount,
      agents,
      note: agents.length
        ? privatePeerNote(hiddenOwnedCount)
        : hiddenOwnedCount > 0
          ? `Only owned private agents were returned by Blocks; ${hiddenOwnedCount} hidden.`
          : 'Blocks returned no invited private peer agents for this account.',
    };
  } catch (err) {
    return {
      ok: false,
      status: 'unavailable',
      totalCount: 0,
      hiddenOwnedCount: 0,
      agents: [],
      note: 'Could not load the Blocks private listing.',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function privatePeerNote(hiddenOwnedCount: number): string {
  if (hiddenOwnedCount > 0) {
    return `Invited/private peer agents returned by Blocks; ${hiddenOwnedCount} owned private agent${hiddenOwnedCount === 1 ? '' : 's'} hidden.`;
  }
  return 'Invited/private peer agents returned by Blocks.';
}

async function attachIntegrationStatus(
  assistants: Array<AssistantPanel & { integrations?: unknown }>,
  ownerIds: string[],
): Promise<void> {
  const ownerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
  for (const assistant of assistants) {
    const status = ownerId ? await integrationStatusForOwner(ownerId) : emptyIntegrationStatus();
    assistant.integrations = status;
  }
}

async function integrationStatusForOwner(ownerId: string) {
  const google = await loadIntegration(ownerId, 'google', { baseDir: dashboardIntegrationStoreBaseDir() });
  const scopes = google?.scopes ?? [];
  return {
    ownerId,
    google: {
      connected: Boolean(google),
      scopes,
      connectedAt: google?.connectedAt,
    },
    calendar: {
      connected: Boolean(google) && scopes.some((scope) => scope.includes('/auth/calendar')),
    },
    gmail: {
      connected: Boolean(google) && scopes.some((scope) => scope.includes('/auth/gmail')),
    },
  };
}

function emptyIntegrationStatus() {
  return {
    google: { connected: false, scopes: [] },
    calendar: { connected: false },
    gmail: { connected: false },
  };
}

function ownerRosterBaseDir(ownerId: string): string {
  return `${multiTenantStateBaseDir(undefined, process.env)}/${ownerStateKey(ownerId)}/rosters`;
}

function dashboardIntegrationStoreBaseDir(): string | undefined {
  return process.env.PA_INTEGRATION_STORE_DIR?.trim()
    || fileURLToPath(new URL('../../data/integrations', import.meta.url));
}

function dashboardProfileStoreBaseDir(): string | undefined {
  return process.env.PA_PROFILE_STORE_DIR?.trim()
    || fileURLToPath(new URL('../../data/profiles', import.meta.url));
}

function dashboardContactsStoreBaseDir(): string | undefined {
  return process.env.PA_CONTACTS_STORE_DIR?.trim()
    || fileURLToPath(new URL('../../data/contacts', import.meta.url));
}

const dashboardLocalA2A: NonNullable<RunAssistantOpts['localA2A']> = async (peer, request, opts, ctx) => {
  const callerOwnerId = opts.callerOwnerId?.trim();
  if (!callerOwnerId) throw new Error('caller ownerId is required for same-bridge A2A fallback');

  const peerOwnerId = peer.ownerId?.trim();
  if (!peerOwnerId) throw new Error(`peer ${peer.agentName} has no ownerId for same-bridge A2A fallback`);

  const multiTenantOpts = dashboardMultiTenantOpts();
  const expectedHandle = multiTenantOpts.selfHandleByOwnerId?.[peerOwnerId]?.trim();
  if (expectedHandle && expectedHandle !== peer.agentName) {
    throw new Error(`peer ${peer.agentName} is not bound to owner ${peerOwnerId}`);
  }

  const route = await buildMultiTenantAssistantRoute(peerOwnerId, multiTenantOpts);
  if ((route.opts.selfHandle ?? '') !== peer.agentName) {
    throw new Error(`owner ${peerOwnerId} resolves to ${route.opts.selfHandle ?? 'unknown'}, not ${peer.agentName}`);
  }

  const task = {
    type: 'StartTask',
    taskId: `local-a2a-${Date.now()}`,
    ownerId: callerOwnerId,
    requestParts: [{ partId: 'request', text: JSON.stringify(request), contentType: 'application/json' }],
  } as StartTaskMessage;
  const result = await runAssistant(task, ctx, route.policy, route.opts);
  return assistantPrimaryPayload(result);
};

function dashboardMultiTenantOpts(): MultiTenantAssistantOpts {
  const standing = standingPersonalAssistants();
  return {
    env: process.env,
    ownerIds: [...new Set([...configuredOwnerIds(process.env), ...standing.ownerIds])],
    orgIdByOwnerId: standing.orgIdByOwnerId,
    selfHandleByOwnerId: standing.selfHandleByOwnerId,
    allowUnlistedOwners: dashboardOpenSignupEnabled(),
    stateBaseDir: process.env.PA_MULTI_TENANT_STATE_DIR,
    integrationStoreBaseDir: dashboardIntegrationStoreBaseDir(),
    // The runtime must read the SAME profile/contacts the /api/profile and
    // /api/contacts handlers write, so point both at the shared dirs.
    profileStoreBaseDir: dashboardProfileStoreBaseDir(),
    contactsStoreBaseDir: dashboardContactsStoreBaseDir(),
    runAssistantDefaults: {
      localA2A: dashboardLocalA2A,
    },
  };
}

interface StandingAssistantBindings {
  ownerIds: string[];
  orgIdByOwnerId: Record<string, string | undefined>;
  selfHandleByOwnerId: Record<string, string | undefined>;
  assistantsByHandle: Record<string, {
    agentName: string;
    owner: string;
    ownerId: string;
    orgId?: string;
  }>;
}

let cachedStandingAssistants:
  | { raw: string; bindings: StandingAssistantBindings }
  | undefined;

function standingPersonalAssistants(): StandingAssistantBindings {
  const raw = loadStandingPersonalAssistantsRaw();
  if (cachedStandingAssistants?.raw === raw) return cachedStandingAssistants.bindings;

  const bindings = parseStandingPersonalAssistants(raw);
  cachedStandingAssistants = { raw, bindings };
  return bindings;
}

function loadStandingPersonalAssistantsRaw(): string {
  const inline = process.env.PA_ASSISTANTS_JSON?.trim();
  if (inline) return inline;

  const configured = process.env.PA_ASSISTANTS_CONFIG?.trim();
  const paths = [
    configured || '',
    fileURLToPath(new URL('../../../data/config/personal-assistants.json', import.meta.url)),
  ].filter(Boolean);

  for (const path of paths) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // Optional runtime config. Absence means env-only owner bindings.
    }
  }
  return '[]';
}

function parseStandingPersonalAssistants(raw: string): StandingAssistantBindings {
  const bindings: StandingAssistantBindings = {
    ownerIds: [],
    orgIdByOwnerId: {},
    selfHandleByOwnerId: {},
    assistantsByHandle: {},
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bindings;
  }
  if (!Array.isArray(parsed)) return bindings;

  for (const entry of parsed) {
    if (!isPlainRecord(entry)) continue;
    const ownerId = typeof entry.ownerId === 'string' ? entry.ownerId.trim() : '';
    if (!ownerId) continue;
    const owner = typeof entry.owner === 'string' ? entry.owner : ownerId;
    const slug = typeof entry.slug === 'string' && entry.slug.trim()
      ? entry.slug.trim()
      : slugFromOwnerLabel(owner);
    const handle = typeof entry.agentName === 'string' && entry.agentName.trim()
      ? entry.agentName.trim()
      : slug ? `pa_${slug}` : '';
    const orgId = typeof entry.orgId === 'string' && entry.orgId.trim() ? entry.orgId.trim() : undefined;

    bindings.ownerIds.push(ownerId);
    if (handle) bindings.selfHandleByOwnerId[ownerId] = handle;
    if (orgId) bindings.orgIdByOwnerId[ownerId] = orgId;
    if (handle) bindings.assistantsByHandle[handle] = { agentName: handle, owner, ownerId, ...(orgId ? { orgId } : {}) };
  }

  bindings.ownerIds = [...new Set(bindings.ownerIds)];
  return bindings;
}

function standingAssistantForRequest(req: IncomingMessage): {
  agentName: string;
  owner: string;
  ownerId: string;
  orgId?: string;
} | undefined {
  const host = String(req.headers.host ?? '').split(':')[0]?.trim().toLowerCase();
  if (!host) return undefined;
  const label = host.split('.')[0]?.replace(/-/gu, '_');
  if (!label) return undefined;

  const handle = label.startsWith('pa_') ? label : `pa_${label}`;
  return standingPersonalAssistants().assistantsByHandle[handle];
}

function slugFromOwnerLabel(owner: string): string {
  return owner
    .toLowerCase()
    .replace(/@.*$/u, '')
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 24);
}

function multiTenantAssistantsEnabled(): boolean {
  return process.env.PA_MULTI_TENANT_ASSISTANT === '1';
}

function dashboardOpenSignupEnabled(): boolean {
  return DASHBOARD_AUTH_REQUIRED && process.env.PA_OPEN_SIGNUP === '1';
}

function isPersonalAssistantCard(card: PublishedAgentCard): boolean {
  return card.tags.some((tag) => tag.id === 'personal-assistant');
}

function isPersonalAssistantName(agentName: string): boolean {
  return agentName.startsWith('pa_');
}

/** Coerce a loose JSON object into a SharePolicy (allow-list; missing
 *  fields default to false = share nothing). Returns undefined when no
 *  policy object is supplied. */
function parseSharePolicy(value: unknown): SharePolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '"sharePolicy" must be a JSON object');
  }
  const sp = value as Record<string, unknown>;
  return { freeBusy: sp.freeBusy === true, meetingTitles: sp.meetingTitles === true };
}

/** Parse a MINIMAL identity card from the invite body (3.2): name +
 *  capabilities only. Returns undefined when no card was supplied so a
 *  card-less invite stays byte-identical to the pre-Pillar-3 behaviour. */
function parseIdentityCard(value: unknown): PeerIdentityCard | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'an identity card must be a JSON object');
  }
  const c = value as Record<string, unknown>;
  const card: PeerIdentityCard = {};
  if (typeof c.displayName === 'string' && c.displayName.trim()) card.displayName = c.displayName.trim();
  if (typeof c.ownerName === 'string' && c.ownerName.trim()) card.ownerName = c.ownerName.trim();
  if (typeof c.email === 'string' && c.email.trim()) card.email = c.email.trim();
  if (typeof c.handle === 'string' && c.handle.trim()) card.handle = c.handle.trim();
  if (Array.isArray(c.aliases)) card.aliases = c.aliases.filter((a): a is string => typeof a === 'string');
  if (Array.isArray(c.capabilities)) card.capabilities = c.capabilities.filter((a): a is string => typeof a === 'string');
  return Object.keys(card).length > 0 ? card : undefined;
}

function requirePersonalAssistantsEnabled() {
  if (process.env.PERSONAL_ASSISTANTS_ENABLED !== '1') {
    throw new HttpError(
      403,
      'personal assistants are disabled — set PERSONAL_ASSISTANTS_ENABLED=1 in .env to enable /api/assistant/*',
    );
  }
}

async function apiServe(body: Record<string, unknown>) {
  const dir = requireString(body, 'dir');
  tstep(`serve local agent "${dir}" onto the Blocks network`);
  if (!/^[a-zA-Z0-9_-]+$/u.test(dir)) throw new HttpError(400, 'invalid agent directory name');

  const dirs = await publishedDirs();
  if (!dirs.includes(dir)) throw new HttpError(404, `no published agent folder "${dir}"`);

  const cardUrl = new URL(`../../published/${dir}/agent-card.json`, import.meta.url);
  const card = JSON.parse(await readFile(cardUrl, 'utf8')) as PublishedAgentCard;
  const agentName = card.identity.agentName;
  const credential = resolveAgentBlocksCredential(agentName) ?? resolveAgentBlocksCredential(dir);
  if (!process.env.BLOCKS_API_KEY && !credential) {
    throw new HttpError(
      400,
      'BLOCKS_API_KEY is missing — add it to .env, or configure BLOCKS_API_KEY_<AGENT> / data/secrets/agent-api-keys.json for this agent',
    );
  }

  const existing = served.get(agentName);
  if (existing) {
    tnote(`${agentName} is already being served (instance ${existing.handle.instanceId})`);
    return { ok: true, action: 'serve', agentName, instanceId: existing.handle.instanceId, alreadyServing: true };
  }

  let handler: HandlerFn | undefined;
  if (multiTenantAssistantsEnabled() && isPersonalAssistantCard(card)) {
    const binding = standingPersonalAssistants().assistantsByHandle[agentName];
    if (binding) {
      handler = async (task, ctx) => {
        const route = await buildMultiTenantAssistantRoute(binding.ownerId, dashboardMultiTenantOpts());
        return runAssistant(task, ctx, route.policy, route.opts);
      };
      tnote(`${agentName} will serve bound to owner ${binding.ownerId} (named private-assistant mode)`);
    } else {
      handler = (task, ctx) => runMultiTenantAssistant(task, ctx, dashboardMultiTenantOpts());
      tnote(`${agentName} will route each task by task.ownerId (PA-7 multi-tenant mode)`);
    }
  } else {
    const handlerModule = (await import(new URL(`../../published/${dir}/handler.ts`, import.meta.url).href)) as {
      default?: HandlerFn;
    };
    handler = handlerModule.default;
    if (typeof handler !== 'function') {
      throw new HttpError(500, `published/${dir}/handler.ts has no default export handler`);
    }
  }

  if (credential) tnote(`${agentName} will serve with Blocks credential from ${credential.source}`);
  const handle = await serveAgent({ cardPath: cardUrl, handler, apiKey: credential?.apiKey });
  served.set(handle.agentName, { handle, dir, startedAt: Date.now() });

  // startAgentInstance registers with the catalog asynchronously; wait for
  // the control channel so "live" in the UI means "actually callable".
  const ready = await waitForRegistration(handle, 15_000);
  tnote(`serving ${handle.agentName} (instance ${handle.instanceId}, ready=${ready})`);

  return { ok: true, action: 'serve', agentName: handle.agentName, instanceId: handle.instanceId, ready };
}

async function waitForRegistration(handle: AgentInstanceHandle, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.controlChannel) {
      // Small grace so the control-channel subscription settles before
      // the first task arrives.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function apiStop(body: Record<string, unknown>) {
  const agentName = requireString(body, 'agentName');
  tstep(`stop served agent "${agentName}"`);
  const entry = served.get(agentName);
  if (!entry) throw new HttpError(404, `"${agentName}" is not being served by this dashboard`);

  entry.handle.stop();
  served.delete(agentName);
  tnote(`stopped ${agentName} (served for ${Date.now() - entry.startedAt}ms)`);

  return { ok: true, action: 'stop', agentName, servedForMs: Date.now() - entry.startedAt };
}

/** Microphone → prompt: hire a speech-to-text agent on Blocks and return
 *  the transcript. The chat UI posts base64 audio here; we discover the
 *  transcriber by skill tag and call it like any other Blocks agent, so
 *  the voice clip is "translated into prompt format" through the network. */
async function apiTranscribe(body: Record<string, unknown>) {
  const audio = requireString(body, 'audio');
  const format = optionalString(body, 'format') ?? 'webm';
  if (audio.length < MIN_TRANSCRIBE_BASE64_CHARS) {
    throw new HttpError(
      400,
      `Voice clip is too short or silent (${Math.round(audio.length / 1024)}KB base64). Record at least 5-10 seconds of clear speech, then try again.`,
    );
  }
  requireKeyWhenOnline('Transcription');
  tstep(`transcribe mic audio (format=${format}, ~${Math.round(audio.length / 1024)}KB base64) via skill "${TRANSCRIBE_TAG}"`);

  const partials: PartialEvent[] = [];
  const session = await connect({ latencyScale: 0, onPartial: tracingPartial(partials) });

  try {
    const pool = await session.discover(TRANSCRIBE_TAG);
    tnote(`discover("${TRANSCRIBE_TAG}") → ${pool.length} transcriber(s)`);
    if (pool.length === 0) {
      throw new HttpError(
        404,
        `no transcription agent on the network for skill "${TRANSCRIBE_TAG}" — serve one first (e.g. blocks serve openclaw_transcriber)`,
      );
    }
    const agent = preferredDiscoveredAgent(pool, ['openclaw_transcriber']);
    const servedLocally = new Set([...served.keys()].map(looseAgentKey));
    let result;
    try {
      result = await session.call(agent.handle, TRANSCRIBE_TAG, { audio, format });
    } catch (err) {
      // A listing can exist on Blocks without any live instance running it.
      // Discovery still returns it, but the call fails ("finished with state
      // failed"). If we aren't serving it locally either, that's the honest
      // "nobody to hire" case — guide the user to bring a specialist online
      // rather than leaking the raw runtime error.
      const msg = err instanceof Error ? err.message : String(err);
      if (!servedLocally.has(looseAgentKey(agent.handle)) && /state failed|not running|no instance|unavailable/i.test(msg)) {
        throw new HttpError(
          404,
          `the speech-to-text specialist "${agent.handle}" is listed on Blocks but no instance is running it — serve one first (e.g. blocks serve openclaw_transcriber)`,
        );
      }
      throw err;
    }
    const text = extractTranscript(result.data);
    tnote(`→ "${previewValue(text, 80)}" via ${agent.handle} · ${result.meta.latencyMs}ms`);
    return { ok: true, action: 'transcribe', text, handle: agent.handle, meta: result.meta, partials };
  } finally {
    session.close();
  }
}

function extractTranscript(data: unknown): string {
  if (typeof data === 'string') return data.trim();
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (record.ok === false) {
      const error = typeof record.error === 'string' ? record.error : 'Transcriber could not produce a transcript.';
      throw new HttpError(400, error);
    }
    const value = record.text ?? record.transcript ?? record.transcription;
    if (typeof value === 'string') return value.trim();
  }
  throw new HttpError(502, `transcriber returned no text: ${JSON.stringify(data).slice(0, 200)}`);
}

/** Image → prompt: hire a vision agent on Blocks and return what it sees.
 *  The chat UI posts a base64 image (and an optional prompt) here; we
 *  discover an image-understanding agent by skill tag and call it like any
 *  other Blocks agent, so the uploaded picture is "understood" through the
 *  network and folded back into the prompt. Mirrors apiTranscribe. */
async function apiDescribeImage(body: Record<string, unknown>) {
  const image = requireString(body, 'image');
  const format = optionalString(body, 'format') ?? 'png';
  const prompt = optionalString(body, 'prompt') ?? '';
  requireKeyWhenOnline('Image understanding');
  tstep(`describe image (format=${format}, ~${Math.round(image.length / 1024)}KB base64) via skill "${IMAGE_DESCRIBE_TAG}"`);

  const partials: PartialEvent[] = [];
  const session = await connect({ latencyScale: 0, onPartial: tracingPartial(partials) });

  try {
    const pool = await session.discover(IMAGE_DESCRIBE_TAG);
    tnote(`discover("${IMAGE_DESCRIBE_TAG}") → ${pool.length} vision agent(s)`);
    if (pool.length === 0) {
      throw new HttpError(
        404,
        `no image-understanding agent on the network for skill "${IMAGE_DESCRIBE_TAG}" — serve one first (e.g. blocks serve openclaw_image_describer)`,
      );
    }
    const agent = preferredDiscoveredAgent(pool, ['openclaw_image_describer']);
    const result = await session.call(agent.handle, IMAGE_DESCRIBE_TAG, { image, format, prompt });
    const text = extractDescription(result.data);
    tnote(`→ "${previewValue(text, 80)}" via ${agent.handle} · ${result.meta.latencyMs}ms`);
    return { ok: true, action: 'describe-image', text, handle: agent.handle, meta: result.meta, partials };
  } finally {
    session.close();
  }
}

function extractDescription(data: unknown): string {
  if (typeof data === 'string') return data.trim();
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const value = record.text ?? record.description ?? record.caption;
    if (typeof value === 'string') return value.trim();
  }
  throw new HttpError(502, `image agent returned no text: ${JSON.stringify(data).slice(0, 200)}`);
}

// ── deterministic intent routing ─────────────────────────────────────────
// Some requests map cleanly onto a Blocks specialist. Rather than hope the
// gateway model chooses to delegate (it often doesn't — it prefers its own
// browser), the chat UI posts the user's text here; if it matches an intent
// we discover + call the right agent and hand the result straight back. Same
// reliability posture as /api/transcribe and /api/describe-image.

interface IntentRoute {
  /** Blocks skill tag to discover. */
  tag: string;
  /** Human label for the live trace + UI. */
  label: string;
  /** Whether the agent's output IS the answer ('answer') or just context. */
  mode: 'answer' | 'context';
  match: (text: string) => boolean;
  buildInputs: (text: string) => Record<string, unknown>;
}

const LINKEDIN_URL = /(https?:\/\/[^\s]*linkedin\.com\/[^\s]+)/iu;

const INTENT_ROUTES: IntentRoute[] = [
  {
    tag: 'tone-guide',
    label: 'LinkedIn tone & voice',
    mode: 'answer',
    match: (t) => /linkedin\.com\/(in|pub)\//iu.test(t) && /\b(tone|voice|style|writing|analy[sz])/iu.test(t),
    buildInputs: (t) => {
      const url = (LINKEDIN_URL.exec(t)?.[1] ?? t).replace(/[)>\].,]+$/u, '');
      return { text: url };
    },
  },
];

const RANDOM_AGENT_TIMEOUT_MS = 20_000;
const SELECTED_AGENT_TIMEOUT_MS = 120_000;

/** Phase 3: the single authoritative "which path does this turn take?" gate.
 *  The chat surface posts the turn text and dispatches on `route` instead of
 *  running its own `looksPersonalAssistant` / `looksRoutable` regexes. */
function apiClassify(body: Record<string, unknown>) {
  const text = optionalString(body, 'text') ?? '';
  return { ok: true as const, ...classifyTurn(text) };
}

async function apiSkillFile(body: Record<string, unknown>) {
  const text = optionalString(body, 'text') ?? '';
  const role = skillRoleFromText(text);
  const skillName = slugifySkillName(role || 'custom-assistant');
  const markdown = buildSkillFile({ role: role || 'custom assistant', skillName });
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, 'Z');
  const filename = `${skillName}-SKILL-${stamp}.md`;

  await mkdir(OUTPUTS_DIR, { recursive: true });
  await writeFile(join(OUTPUTS_DIR, filename), markdown, 'utf8');

  return {
    ok: true as const,
    action: 'skill-file',
    skillName,
    filename,
    url: `/outputs/${filename}`,
    markdown,
  };
}

async function apiRoute(body: Record<string, unknown>) {
  const text = optionalString(body, 'text');
  if (!text) return { ok: true, matched: false as const };

  const candidateHandles = routeCandidateHandles(body.candidates);
  if (candidateHandles.length > 0 && !isRandomBlocksAgentRequest(text, candidateHandles)) {
    const selectedAgent = await routeSelectedBlocksAgent(text, candidateHandles);
    if (selectedAgent) return selectedAgent;
  }

  const randomAgent = await routeRandomBlocksAgent(text, candidateHandles);
  if (randomAgent) return randomAgent;

  const catalog = await routeBlocksCatalog(text);
  if (catalog) return catalog;

  const route = INTENT_ROUTES.find((r) => r.match(text));
  if (!route) return { ok: true, matched: false as const };

  requireKeyWhenOnline('Routing to a Blocks specialist');
  tstep(`route intent → "${route.label}" via skill "${route.tag}"`);

  const partials: PartialEvent[] = [];
  const session = await connect({ latencyScale: 0, onPartial: tracingPartial(partials) });

  try {
    const pool = await session.discover(route.tag);
    tnote(`discover("${route.tag}") → ${pool.length} candidate(s)`);
    if (pool.length === 0) {
      // No specialist serving this skill — let the caller fall back to the
      // gateway rather than failing the whole turn.
      return { ok: true, matched: false as const, tag: route.tag, reason: 'no agent serving this skill' };
    }
    const agent = pool[0];
    const result = await session.call(agent.handle, route.tag, route.buildInputs(text));
    const out = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    tnote(`→ ${previewValue(out, 80)} via ${agent.handle} · ${result.meta.latencyMs}ms`);
    return {
      ok: true,
      matched: true as const,
      tag: route.tag,
      label: route.label,
      mode: route.mode,
      handle: agent.handle,
      displayName: agent.displayName,
      text: out,
      meta: result.meta,
      partials,
    };
  } finally {
    session.close();
  }
}

async function routeBlocksCatalog(text: string) {
  if (!isBlocksCatalogQuestion(text)) return null;

  const started = Date.now();
  const query = blocksCatalogQuery(text);
  const tag = blocksCatalogTag(text);
  tstep(tag
    ? `route Blocks catalog → tag "${tag}"`
    : `route Blocks catalog → query "${query}"`);

  // Pull the WHOLE registry (paginated + cached), normalize through the ONE
  // shared mapper, then categorize/rank via the shared pipeline (Pillar 2).
  const snapshot = await loadDashboardCatalog();
  const universe = tag
    ? snapshot.agents.filter((a) => a.tags.map((t) => t.toLowerCase()).includes(tag.toLowerCase()))
    : snapshot.agents;

  // "categorize the catalog" / "what kinds exist" → the category overview.
  if (/\b(categor\w+|what kinds?|what types?|overview|taxonomy)\b/iu.test(text)) {
    const buckets = categorizeCatalog(universe);
    const latencyMs = Date.now() - started;
    tnote(`catalog categorize → ${buckets.length} categories (${latencyMs}ms)`);
    return {
      ok: true,
      matched: true as const,
      tag,
      label: 'Blocks catalog',
      mode: 'answer' as const,
      handle: 'blocks-catalog',
      displayName: 'Blocks catalog',
      text: formatCategorizeReply({ buckets, scanned: snapshot.scanned, totalCount: snapshot.totalCount, truncated: snapshot.truncated }),
      meta: { latencyMs, costUsd: 0 },
      agents: universe.slice(0, 10).map((a) => rankedAgentView({ agent: a, categories: categorize(a), score: 0, whyMatched: '' })),
    };
  }

  const searchQuery = genericBlocksCatalogListQuery(text, query)
    ? 'Blocks catalog'
    : query || text;
  const search = searchCatalog(universe, { query: searchQuery });
  const shown = search.results.slice(0, 10).map(rankedAgentView);
  const latencyMs = Date.now() - started;
  tnote(`catalog search → ${search.matched} match(es) (${latencyMs}ms)`);

  return {
    ok: true,
    matched: true as const,
    tag,
    label: 'Blocks catalog',
    mode: 'answer' as const,
    handle: 'blocks-catalog',
    displayName: 'Blocks catalog',
    text: formatSearchReply({ query: searchQuery, tag, search, scanned: snapshot.scanned, totalCount: snapshot.totalCount, truncated: snapshot.truncated }),
    meta: { latencyMs, costUsd: 0 },
    agents: shown,
  };
}

async function routeRandomBlocksAgent(text: string, candidateHandles: string[] = []) {
  if (!isRandomBlocksAgentRequest(text, candidateHandles)) return null;

  requireKeyWhenOnline('Using a random Blocks agent');
  const started = Date.now();
  const partials: PartialEvent[] = [];
  const session = await connect({ latencyScale: 0, onPartial: tracingPartial(partials) });

  try {
    const scan = await session.scanCatalog({ max: catalogScanMax() });
    const candidateSet = new Set(candidateHandles.map(looseAgentKey));
    const catalog = scan.agents.map(toCatalogAgent);
    const scoped = candidateSet.size
      ? catalog.filter((agent) => candidateSet.has(looseAgentKey(agent.handle)))
      : catalog;
    const callable = scoped.filter(isTextFriendlyCatalogAgent);
    const free = callable.filter((agent) => agent.billingMode === 'free' || Number(agent.price.amount) === 0);
    const pool = shuffleCatalogAgents(free.length ? free : callable);
    const prompt = randomAgentPrompt(text, candidateSet.size > 0);

    tstep(candidateSet.size
      ? `route random Blocks agent from ${candidateSet.size} prior candidate(s)`
      : 'route random Blocks agent from catalog');

    const errors: string[] = [];
    for (const agent of pool.slice(0, 8)) {
      const skill = agent.tags[0] || 'other';
      try {
        const result = await withTimeout(
          session.call(agent.handle, skill, { text: prompt }),
          RANDOM_AGENT_TIMEOUT_MS,
          `${agent.handle} timed out after ${Math.round(RANDOM_AGENT_TIMEOUT_MS / 1000)}s`,
        );
        const latencyMs = Date.now() - started;
        const output = callOutputText(result.data);
        const label = catalogAgentLabel(agent);
        tnote(`random Blocks agent → ${label} · ${result.meta.latencyMs}ms`);
        return {
          ok: true,
          matched: true as const,
          tag: skill,
          label: 'Random Blocks agent',
          mode: 'answer' as const,
          handle: agent.handle,
          displayName: agent.displayName,
          text: `I used **${label}** on Blocks.\n\n${output}`,
          meta: { ...result.meta, latencyMs, costUsd: result.meta.costUsd },
          partials,
          chosenAgent: rankedAgentView({ agent, categories: categorize(agent), score: 0, whyMatched: 'random text-friendly public agent' }),
          agents: pool.slice(0, 10).map((a) => rankedAgentView({ agent: a, categories: categorize(a), score: 0, whyMatched: 'text-friendly public agent' })),
        };
      } catch (err) {
        errors.push(`${agent.handle}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      ok: true,
      matched: false as const,
      reason: errors.length
        ? `random candidates failed: ${errors.slice(0, 3).join('; ')}`
        : 'no text-friendly public Blocks agents were available to call',
    };
  } finally {
    session.close();
  }
}

async function routeSelectedBlocksAgent(text: string, candidateHandles: string[]) {
  requireKeyWhenOnline('Using a selected Blocks agent');
  const started = Date.now();
  const partials: PartialEvent[] = [];
  const session = await connect({ latencyScale: 0, onPartial: tracingPartial(partials) });

  try {
    const scan = await session.scanCatalog({ max: catalogScanMax() });
    const catalog = scan.agents.map(toCatalogAgent);
    const byHandle = new Map(catalog.map((agent) => [agent.handle, agent]));
    const byLooseHandle = new Map(catalog.map((agent) => [looseAgentKey(agent.handle), agent]));
    const selected = candidateHandles
      .map((handle) => byHandle.get(handle) || byLooseHandle.get(looseAgentKey(handle)))
      .filter((agent): agent is CatalogAgent => Boolean(agent))
      .filter(isPromptableCatalogAgent);
    const prompt = text.trim();

    tstep(`route selected Blocks agent from ${candidateHandles.length} candidate(s)`);

    const errors: string[] = [];
    for (const agent of selected.slice(0, 3)) {
      const skill = agent.tags[0] || 'other';
      try {
        const result = await withTimeout(
          session.call(agent.handle, skill, { text: prompt }),
          SELECTED_AGENT_TIMEOUT_MS,
          `${agent.handle} timed out after ${Math.round(SELECTED_AGENT_TIMEOUT_MS / 1000)}s`,
        );
        const latencyMs = Date.now() - started;
        const output = callOutputText(result.data);
        const label = catalogAgentLabel(agent);
        tnote(`selected Blocks agent → ${label} · ${result.meta.latencyMs}ms`);
        return {
          ok: true,
          matched: true as const,
          tag: skill,
          label: 'Selected Blocks agent',
          mode: 'answer' as const,
          handle: agent.handle,
          displayName: agent.displayName,
          text: `I used **${label}** on Blocks.\n\n${output}`,
          meta: { ...result.meta, latencyMs, costUsd: result.meta.costUsd },
          partials,
          chosenAgent: rankedAgentView({ agent, categories: categorize(agent), score: 0, whyMatched: 'selected public Blocks agent' }),
          agents: selected.slice(0, 10).map((a) => rankedAgentView({ agent: a, categories: categorize(a), score: 0, whyMatched: 'selected public Blocks agent' })),
        };
      } catch (err) {
        errors.push(`${agent.handle}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      ok: true,
      matched: false as const,
      reason: errors.length
        ? selectedAgentFailureReason(errors)
        : 'selected Blocks agent was not available for prompt-style requests',
    };
  } finally {
    session.close();
  }
}

function selectedAgentFailureReason(errors: string[]): string {
  if (errors.length === 1) {
    const match = /^([^:]+):\s*(.+)$/u.exec(errors[0]);
    const handle = match?.[1] || 'The selected Blocks agent';
    const message = match?.[2] || errors[0];
    if (/timed out after \d+s/iu.test(message)) {
      return `${handle} accepted the request but timed out before returning an output. ${message}`;
    }
    return `${handle} failed: ${message}`;
  }
  return `selected Blocks agents failed: ${errors.slice(0, 3).join('; ')}`;
}

/**
 * Cached, paginated full-registry scan for the dashboard. Uses the SAME cursor
 * walker as the runtime (`walkRegistryPages`) so the "pull every page" logic
 * is shared, includes every public agent (free + paid), reports honest
 * truncation, and lives in the same process-global TTL cache with
 * single-flight so concurrent chat turns don't stampede.
 */
async function loadDashboardCatalog(refresh = false): Promise<{ agents: CatalogAgent[]; scanned: number; totalCount?: number; truncated: boolean }> {
  const baseUrl = await blocksBaseUrl();
  return loadCatalogSnapshot(
    `dashboard:${baseUrl}`,
    async () => {
      const walked = await walkRegistryPages(
        async (cursor) => {
          const result = await fetchAgentRegistry({ limit: 50, cursor, baseUrl });
          return { items: result.agents, next: result.next, totalCount: result.totalCount };
        },
        { max: catalogScanMax() },
      );
      const agents = walked.items
        .filter((entry) => entry.listing !== 'private')
        .map((entry) => toCatalogAgent(agentEntryToDiscovered(entry)));
      return { agents, scanned: walked.scanned, totalCount: walked.totalCount ?? walked.scanned, truncated: walked.truncated };
    },
    { refresh },
  );
}

function isBlocksCatalogQuestion(text: string): boolean {
  return /\b(blocks?|blocks\.ai|catalog)\b/iu.test(text)
    && /\b(what|which|who|find|search|list|show|available|using|use|uses|support|supports|can|agents?|tools?|models?|tags?)\b/iu.test(text);
}

function isRandomBlocksAgentRequest(text: string, candidateHandles: string[]): boolean {
  const t = text.trim();
  const randomUse = /\b(use|try|run|pick|choose)\b/iu.test(t) && /\b(random|cool|interesting|one|another)\b/iu.test(t);
  const explicitBlocks = /\b(blocks?|blocks\.ai|catalog)\b/iu.test(t) && /\b(agent|agents?|tool|tools?)\b/iu.test(t);
  return randomUse && (explicitBlocks || candidateHandles.length > 0);
}

function routeCandidateHandles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const handles: string[] = [];
  for (const entry of value) {
    const raw = typeof entry === 'string'
      ? entry
      : isPlainRecord(entry) && typeof entry.handle === 'string' ? entry.handle : '';
    const handle = raw.trim();
    if (/^[a-zA-Z0-9_-]{2,80}$/u.test(handle)) handles.push(handle);
  }
  return [...new Set(handles)].slice(0, 50);
}

function isTextFriendlyCatalogAgent(agent: CatalogAgent): boolean {
  if (!isPromptableCatalogAgent(agent)) return false;

  const outputs = agent.outputs ?? [];
  if (outputs.length === 0) return true;
  return outputs.some((output) => /^(result|response|reply|text|markdown|summary|completion|json|data|uuids?)$/iu.test(output));
}

function isPromptableCatalogAgent(agent: CatalogAgent): boolean {
  const inputs = agent.inputs ?? [];
  return inputs.length === 0 || inputs.some((input) => /^(request|text|prompt|query|message|input)$/iu.test(input));
}

function shuffleCatalogAgents(agents: CatalogAgent[]): CatalogAgent[] {
  const shuffled = agents.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function randomAgentPrompt(text: string, fromPriorCandidates: boolean): string {
  if (fromPriorCandidates && /^use\s+(a\s+)?(random|one|another|that)\b/iu.test(text.trim())) {
    return 'Run a short demo of what your Blocks agent does. Keep it concise and concrete.';
  }
  return text.trim() || 'Run a short demo of what your Blocks agent does. Keep it concise and concrete.';
}

function catalogAgentLabel(agent: CatalogAgent): string {
  const handle = agent.handle.trim();
  const displayName = agent.displayName.trim();
  if (!displayName || sameLooseLabel(handle, displayName)) return handle;
  return `${displayName} (${handle})`;
}

function sameLooseLabel(a: string, b: string): boolean {
  return looseAgentKey(a) === looseAgentKey(b);
}

function looseAgentKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, '');
}

function preferredDiscoveredAgent(pool: DiscoveredAgent[], preferredHandles: string[]): DiscoveredAgent {
  const preferred = new Set(preferredHandles.map(looseAgentKey));
  const servedHandles = new Set([...served.keys()].map(looseAgentKey));

  return (
    pool.find((agent) => preferred.has(looseAgentKey(agent.handle)) && servedHandles.has(looseAgentKey(agent.handle))) ??
    pool.find((agent) => preferred.has(looseAgentKey(agent.handle))) ??
    pool.find((agent) => servedHandles.has(looseAgentKey(agent.handle))) ??
    pool[0]
  );
}

// Catalog tag detection uses the ONE canonical intent→tag matcher
// (`intent-tags.ts`) rather than a local regex copy, so "which agents make
// images" (create) vs. "which agents read images" (understand) classify the
// same way everywhere — the offline stub, the live brain table, and here.
function blocksCatalogTag(text: string): string | undefined {
  return tagForRequest(text);
}

function blocksCatalogQuery(text: string): string {
  const cleaned = text
    .replace(/\b(on|in)\s+blocks(?:\.ai)?\b/giu, ' ')
    .replace(/\b(blocks(?:\.ai)?|what|which|who|find|search|list|show|are|is|the|some|few|examples?|agents?|tools?|catalog|using|use|uses|available|support|supports|can)\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned || text.trim();
}

function genericBlocksCatalogListQuery(text: string, query: string): boolean {
  if (!/\b(list|show|find|search|what|which)\b/iu.test(text)) return false;
  return queryTerms(query).length === 0;
}

function servedList() {
  return {
    ok: true,
    serving: [...served.entries()].map(([agentName, entry]) => ({
      agentName,
      dir: entry.dir,
      instanceId: entry.handle.instanceId,
      startedAt: entry.startedAt,
      uptimeMs: Date.now() - entry.startedAt,
    })),
  };
}

function status() {
  return {
    ok: true,
    offline: process.env.FOUNDATION_OFFLINE !== '0',
    hasBlocksKey: Boolean(process.env.BLOCKS_API_KEY),
    serving: served.size,
  };
}

function requireKeyWhenOnline(action: string) {
  const offline = process.env.FOUNDATION_OFFLINE !== '0';
  if (!offline && !process.env.BLOCKS_API_KEY) {
    throw new HttpError(400, `${action} needs BLOCKS_API_KEY in .env (or set FOUNDATION_OFFLINE=1 for the mock catalog)`);
  }
}

// ── catalog endpoints (read-only) ───────────────────────────────────────

async function blocksCatalog(url: URL) {
  const tag = url.searchParams.get('tag')?.trim();
  const listing = url.searchParams.get('listing')?.trim();
  const q = url.searchParams.get('q')?.trim() ?? '';
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const baseUrl = await blocksBaseUrl();
  const result = tag
    ? await fetchAgentsByTag(tag, { limit, baseUrl })
    : listing === 'private'
      ? await fetchAgentsByListingAuthenticated('private', { limit, baseUrl })
    : listing === 'private' || listing === 'public'
      ? await fetchAgentsByListing(listing, { limit, baseUrl })
      : await fetchAgentRegistry({ limit, baseUrl });

  // ONE mapper (Pillar 2.1): SDK entry → DiscoveredAgent → CatalogAgent. A `q`
  // is scored via the shared ranking (2.3) instead of a substring filter.
  const normalized = result.agents.map((entry) => toCatalogAgent(agentEntryToDiscovered(entry)));
  const ranked = q
    ? searchCatalog(normalized, { query: q }).results
    : normalized.map((agent) => ({ agent, categories: categorize(agent), score: 0, whyMatched: '' }));
  const agents = ranked.map((r) => ({
    // `agentName` retained as a back-compat alias alongside the normalized
    // `handle` for the `blocks` CLI / older readers.
    agentName: r.agent.handle,
    ...rankedAgentView(r),
  }));

  return {
    ok: true,
    baseUrl,
    totalCount: result.totalCount ?? agents.length,
    agents,
  };
}

async function openClawCatalog() {
  const [agents, skills] = await Promise.all([openClawAgents(), workspaceSkills()]);
  return {
    ok: true,
    source: 'local-files',
    note: 'OpenClaw runtime bundled skills are visible in the native OpenClaw Skills page. This panel lists workspace skills from this repo.',
    agents,
    skills,
  };
}

async function openClawAgents() {
  const config = await readOpenClawConfig();
  return [
    {
      id: 'main',
      workspace: './workspace',
      agentDir: './data/config/agents/main/agent',
      model: config.agents?.defaults?.model?.primary ?? 'unknown',
      bindings: 0,
      isDefault: true,
    },
  ];
}

async function workspaceSkills() {
  const skillsDir = new URL('../../../workspace/skills/', import.meta.url);
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillPath = new URL(`${entry.name}/SKILL.md`, skillsDir);
    try {
      const skill = parseSkill(await readFile(skillPath, 'utf8'));
      skills.push({
        // The runnable name is the folder name (what runSkill expects).
        name: entry.name,
        displayName: skill.name ?? entry.name,
        description: skill.description ?? '',
        eligible: true,
        disabled: false,
        modelVisible: true,
        userInvocable: skill.userInvocable === 'true',
        commandVisible: skill.userInvocable === 'true',
        source: 'openclaw-workspace',
        bundled: false,
        exampleInput: { text: '  Hello WORLD ' },
      });
    } catch {
      // Ignore incomplete skill folders.
    }
  }
  return skills;
}

async function readOpenClawConfig() {
  try {
    const configPath = new URL('../../../data/config/openclaw.json', import.meta.url);
    return JSON.parse(await readFile(configPath, 'utf8')) as {
      agents?: { defaults?: { model?: { primary?: string } } };
    };
  } catch {
    return {};
  }
}

function parseSkill(markdown: string) {
  const match = /^---\n([\s\S]*?)\n---/u.exec(markdown);
  const frontmatter = match?.[1] ?? '';
  const result: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/gu, '');
    if (key) result[toCamel(key)] = value;
  }
  return result;
}

function toCamel(value: string) {
  return value.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
}

async function publishedDirs(): Promise<string[]> {
  const publishedRoot = new URL('../../published/', import.meta.url);
  try {
    const entries = await readdir(publishedRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function localPublishedAgents() {
  const agents = [];
  for (const dir of await publishedDirs()) {
    try {
      const cardPath = new URL(`../../published/${dir}/agent-card.json`, import.meta.url);
      const card = JSON.parse(await readFile(cardPath, 'utf8')) as PublishedAgentCard;
      const liveEntry = served.get(card.identity.agentName);
      agents.push({
        source: 'local',
        dir,
        status: liveEntry ? 'live' : 'draft',
        instanceId: liveEntry?.handle.instanceId,
        agentName: card.identity.agentName,
        displayName: card.identity.displayName,
        description: card.identity.description,
        billingMode: card.extensions?.blocks?.billingMode ?? 'free',
        listing: card.extensions?.blocks?.listing ?? 'public',
        tags: card.tags.map((tag) => tag.id || tag.name),
        inputs: card.io?.inputs?.map((input) => input.id) ?? [],
        outputs: card.io?.outputs?.map((output) => output.id) ?? [],
        exampleInput: card.io?.inputs?.[0]?.example ?? { text: '  Hello WORLD ' },
      });
    } catch {
      // Folders without a valid card are not publishable agents.
    }
  }
  return { ok: true, agents };
}

async function localPublishedPrivateAgentNames(): Promise<Set<string>> {
  const local = await localPublishedAgents();
  return new Set(
    local.agents
      .filter((agent) => agent.listing === 'private')
      .map((agent) => agent.agentName),
  );
}

interface PublishedAgentCard {
  identity: {
    agentName: string;
    displayName: string;
    description: string;
  };
  tags: Array<{ id: string; name: string }>;
  io?: {
    inputs?: Array<{ id: string; example?: unknown }>;
    outputs?: Array<{ id: string }>;
  };
  extensions?: {
    blocks?: {
      billingMode?: string;
      listing?: string;
    };
  };
}

async function blocksBaseUrl() {
  if (process.env.BLOCKS_BACKEND_URL) return process.env.BLOCKS_BACKEND_URL;
  const cdm = await fetchCdmConfig(process.env.BLOCKS_CDM_URL);
  return cdm.api.baseUrl;
}

async function fetchAgentsByListingAuthenticated(
  listing: 'private',
  opts: { limit: number; baseUrl: string },
): Promise<{ agents: AgentEntry[]; totalCount?: number; next?: string }> {
  const apiKey = process.env.BLOCKS_API_KEY;
  if (!apiKey) throw new Error('BLOCKS_API_KEY is required to list private Blocks agents');

  const params = new URLSearchParams({
    include: 'full',
    listing,
    limit: String(opts.limit),
  });
  const url = `${opts.baseUrl.replace(/\/+$/u, '')}/api/v1/registry/agents?${params}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Blocks-Protocol-Version': '2026-05-01',
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(`[AgentRegistry] Request failed: ${body.message ?? `HTTP ${response.status}`}`);
  }

  const data = await response.json() as {
    agents?: unknown[];
    totalCount?: number;
    next?: string;
  };
  return {
    agents: (Array.isArray(data.agents) ? data.agents : []).map(normalizeRegistryAgent),
    ...(typeof data.totalCount === 'number' ? { totalCount: data.totalCount } : {}),
    ...(typeof data.next === 'string' ? { next: data.next } : {}),
  };
}

function normalizeRegistryAgent(value: unknown): AgentEntry {
  const raw = isPlainRecord(value) ? value : {};
  const card = isPlainRecord(raw.card) ? raw.card : undefined;
  const agentName = typeof raw.agentName === 'string' ? raw.agentName : '';
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const displayName = typeof raw.displayName === 'string' ? raw.displayName : name ?? agentName;
  const listing = raw.listing === 'private' ? 'private' : 'public';
  return {
    agentName,
    displayName,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(Array.isArray(raw.tags) ? { tags: raw.tags as AgentEntry['tags'] } : {}),
    ...(isPlainRecord(raw.scaling) ? { scaling: raw.scaling as unknown as AgentEntry['scaling'] } : {}),
    ...(card ? { card: card as unknown as AgentEntry['card'] } : {}),
    ...(typeof raw.cardRef === 'string' ? { cardRef: raw.cardRef } : {}),
    ...(typeof raw.cardSummary === 'string' ? { cardSummary: raw.cardSummary } : {}),
    listing,
    ...(raw.billingMode === 'paid' || raw.billingMode === 'free' ? { billingMode: raw.billingMode } : {}),
    ...(typeof raw.registeredAt === 'string' ? { createdAt: raw.registeredAt } : {}),
    ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  };
}

function blocksView(agent: AgentEntry) {
  const tags = (agent.card?.tags ?? agent.tags ?? []).map((tag) => tag.id || tag.name).filter(Boolean);
  return {
    source: 'blocks',
    status: 'published',
    agentName: agent.agentName,
    displayName: agent.displayName,
    description: agent.description ?? agent.card?.identity.description ?? '',
    billingMode: agent.billingMode ?? 'free',
    listing: agent.listing,
    tags,
    inputs: agent.card?.io?.inputs?.map((input) => input.id) ?? [],
    outputs: agent.card?.io?.outputs?.map((output) => output.id) ?? [],
    exampleInput: agent.card?.io?.inputs?.[0]?.example ?? { text: '  Hello WORLD ' },
  };
}

