/**
 * Blocks.ai client — the agent's ONE door to the network.
 *
 * Models the three things the real Blocks SDK gives an agent:
 *   1. connect()       — one outbound, authenticated session. No inbound
 *                        ports, works behind a firewall.
 *   2. discover(skill) — query the catalog BY SKILL. Returns opaque
 *                        handles + price. The agent never names a
 *                        specialist or hardcodes an endpoint.
 *   3. call(handle...) — invoke a discovered agent over the session,
 *                        with streamed partials, returning the result
 *                        plus latency + cost for the audit trail.
 *
 * Offline mode still uses the in-process mock catalog so the whole
 * thing works with no key and no network. Online mode uses the real
 * Blocks SDK while preserving this file's public API.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TaskClient,
  fetchAgentsByTag,
  fetchAgentRegistry,
  fetchCdmConfig,
  textPart,
  filePart,
  type AgentEntry,
} from '@blocks-network/sdk';

import type { ArtifactOut, DiscoveredAgent, CallResult } from '../types.ts';
import type { Price } from '../types.ts';
import {
  findBySkill,
  findByHandle,
  isMockArtifactResult,
  MOCK_CATALOG,
  type MockListing,
} from './catalog.ts';

export interface ConnectOptions {
  /** When true, use the in-process mock catalog (no network). Defaults
   *  to the FOUNDATION_OFFLINE env var. */
  offline?: boolean;
  /** Multiplier on simulated latency in offline mode. 0 => instant. */
  latencyScale?: number;
  onPartial?: (e: { handle: string; skill: string; message: string }) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default upper bound on how many registry entries a single catalog scan
 *  will walk (Pillar 2.2 edge case 1). High enough to cover the whole live
 *  catalog in practice, env-overridable for very large registries, and
 *  bounded so a runaway/huge registry can't fan out unbounded pagination.
 *  When the scan stops at the cap with more pages left, callers surface an
 *  honest "scanned N of M" truncation note rather than pretending it's
 *  complete. */
export const MAX_CATALOG = 1_000;

/** Resolve the scan cap: explicit arg → `CATALOG_MAX_SCAN` env → default.
 *  Read at call time (not module load) so checks can set the env first. */
export function catalogScanMax(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.max(1, explicit);
  const fromEnv = Number(process.env.CATALOG_MAX_SCAN);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : MAX_CATALOG;
}

/** One page of a cursor-paginated registry query. */
export interface RegistryPage<T> {
  items: T[];
  next?: string;
  totalCount?: number;
}

/**
 * Generic cursor walker — the ONE place the "pull the WHOLE catalog" logic
 * lives, extracted so it is provable offline with a fake paged source (the
 * live `fetchAgentRegistry` path never runs in checks). Walks pages until it
 * runs out of cursors, hits an empty page, or reaches `max`. Guards against a
 * stuck/repeating cursor, and reports `truncated` when it stopped at the cap
 * with more results available — so "every agent on blocks.ai" is never
 * silently clipped to a prefix.
 */
export async function walkRegistryPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<RegistryPage<T>>,
  opts: { max: number },
): Promise<{ items: T[]; scanned: number; totalCount?: number; truncated: boolean }> {
  const max = Math.max(1, opts.max);
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let scanned = 0;
  let totalCount: number | undefined;
  let cursor: string | undefined;
  let truncated = false;

  for (;;) {
    const page = await fetchPage(cursor);
    if (typeof page.totalCount === 'number') totalCount = page.totalCount;
    if (page.items.length === 0) break;

    scanned += page.items.length;
    items.push(...page.items);

    if (items.length >= max) {
      truncated = Boolean(page.next) || (typeof totalCount === 'number' && scanned < totalCount);
      break;
    }
    if (!page.next || seenCursors.has(page.next)) break;
    seenCursors.add(page.next);
    cursor = page.next;
  }

  return { items: items.slice(0, max), scanned, totalCount, truncated };
}

interface OnlineSessionOptions {
  client?: TaskClient;
  baseUrl?: string;
}

function publicView(l: MockListing): DiscoveredAgent {
  return {
    handle: l.handle,
    displayName: l.displayName,
    provider: l.provider,
    skills: l.skills,
    price: l.price,
    // Faceted metadata for catalog search (Pillar 2) — present only when the
    // mock listing actually carries it (model lives on a single listing).
    ...(l.description ? { description: l.description } : {}),
    ...(l.model ? { model: l.model } : {}),
    billingMode: Number(l.price.amount) > 0 ? 'paid' : 'free',
    listing: 'public',
  };
}

/**
 * Map a live registry `AgentEntry` into the codebase's `DiscoveredAgent`
 * view. Exported as the SINGLE adapter so the dashboard's catalog endpoints
 * normalize the SDK shape through the same door as the runtime instead of a
 * second hand-rolled mapper (Pillar 2.1 — kills the `blocksView` duplicate).
 */
export function agentEntryToDiscovered(agent: AgentEntry): DiscoveredAgent {
  const description = agent.description ?? agent.card?.identity.description ?? '';
  const inputs = agent.card?.io?.inputs?.map((input) => input.id).filter(Boolean) ?? [];
  const outputs = agent.card?.io?.outputs?.map((output) => output.id).filter(Boolean) ?? [];
  const model = modelFacet(agent.card?.extensions);
  return {
    handle: agent.agentName,
    displayName: agent.displayName,
    provider: agent.card?.identity.provider.organization ?? 'blocks.ai',
    skills: tagNames(agent),
    price: priceFor(agent),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    billingMode: agent.billingMode ?? 'free',
    listing: agent.listing,
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(outputs.length > 0 ? { outputs } : {}),
  };
}

/** Back-compat internal alias (the original private name). */
const agentView = agentEntryToDiscovered;

/** Read an exposed model facet from the agent card's extensions, if the
 *  agent genuinely advertises one. Returns undefined otherwise — the catalog
 *  never invents a model (Pillar 2.4). */
function modelFacet(extensions: Record<string, unknown> | undefined): string | undefined {
  if (!extensions) return undefined;
  for (const key of ['model', 'baseModel', 'base_model', 'underlyingModel', 'llm']) {
    const value = extensions[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export class BlocksSession {
  readonly connectionId: string;
  private readonly offline: boolean;
  private readonly latencyScale: number;
  private readonly onPartial: NonNullable<ConnectOptions['onPartial']>;
  private readonly client?: TaskClient;
  private readonly baseUrl?: string;
  private readonly discovered = new Map<string, AgentEntry>();
  private callCount = 0;
  private closed = false;

  constructor(opts: ConnectOptions & OnlineSessionOptions) {
    this.connectionId = `conn_${Math.random().toString(36).slice(2, 10)}`;
    this.offline = opts.offline ?? process.env.FOUNDATION_OFFLINE !== '0';
    this.latencyScale = opts.latencyScale ?? 1;
    this.onPartial = opts.onPartial ?? (() => {});
    this.client = opts.client;
    this.baseUrl = opts.baseUrl;
  }

  /** Discover Blocks agents by skill tag. The agent never names them. */
  async discover(skill: string): Promise<DiscoveredAgent[]> {
    if (this.closed) throw new Error('session closed');
    if (this.offline) return findBySkill(skill).map(publicView);

    const result = await fetchAgentsByTag(skill, { limit: 25, baseUrl: this.baseUrl });
    const agents = result.agents
      .filter((agent) => agent.listing === 'public')
      .filter((agent) => (agent.billingMode ?? 'free') === 'free');

    for (const agent of agents) {
      this.discovered.set(agent.agentName, agent);
    }

    return agents.map(agentView);
  }

  /** Discover across the whole catalog, with no skill filter — the
   *  "pull in any agent at once" entry point. Online it lists the public
   *  free registry; offline it returns the mock listings. Either way the
   *  session is populated so the returned handles are immediately
   *  callable via `call()`. */
  async discoverAll(opts: { limit?: number } = {}): Promise<DiscoveredAgent[]> {
    if (this.closed) throw new Error('session closed');
    const limit = opts.limit ?? 10;
    if (this.offline) return MOCK_CATALOG.slice(0, limit).map(publicView);

    const result = await fetchAgentRegistry({ limit, baseUrl: this.baseUrl });
    const agents = result.agents
      .filter((agent) => agent.listing === 'public')
      .filter((agent) => (agent.billingMode ?? 'free') === 'free');

    for (const agent of agents) {
      this.discovered.set(agent.agentName, agent);
    }

    return agents.map(agentView);
  }

  /** Walk the WHOLE public registry for categorization & search (Pillar 2.2).
   *  Unlike `discoverAll` (a single capped page) and `discover` (free-only,
   *  for the call path), this paginates via the registry's `next` cursor up to
   *  `max` and includes EVERY public agent — free AND paid — because search /
   *  categorization is read-only browsing and price is a facet (2.4), not a
   *  pre-filter. Returns the visible agents plus `scanned` (raw entries
   *  walked), `totalCount` (registry size, when reported) and `truncated` (the
   *  cap was hit with more available) so callers can honestly say "scanned N
   *  of M". Offline it returns the full mock catalog. */
  async scanCatalog(opts: { max?: number } = {}): Promise<{
    agents: DiscoveredAgent[];
    scanned: number;
    totalCount?: number;
    truncated: boolean;
  }> {
    if (this.closed) throw new Error('session closed');
    const max = catalogScanMax(opts.max);

    if (this.offline) {
      const all = MOCK_CATALOG.slice(0, max).map(publicView);
      return { agents: all, scanned: all.length, totalCount: MOCK_CATALOG.length, truncated: MOCK_CATALOG.length > all.length };
    }

    const pageLimit = 50;
    const walked = await walkRegistryPages<AgentEntry>(
      async (cursor) => {
        const result = await fetchAgentRegistry({ limit: pageLimit, cursor, baseUrl: this.baseUrl });
        return { items: result.agents, next: result.next, totalCount: result.totalCount };
      },
      { max },
    );

    // Public only (private agents aren't in the public catalog); free AND paid.
    const agents: DiscoveredAgent[] = [];
    for (const entry of walked.items) {
      if (entry.listing === 'private') continue;
      this.discovered.set(entry.agentName, entry);
      agents.push(agentView(entry));
    }

    return { agents, scanned: walked.scanned, totalCount: walked.totalCount ?? walked.scanned, truncated: walked.truncated };
  }

  /** Call a discovered agent by handle. Streams a couple of partials,
   *  returns the result + latency/cost metadata. */
  async call(
    handle: string,
    skill: string,
    inputs: Record<string, unknown>,
  ): Promise<CallResult> {
    if (this.closed) throw new Error('session closed');
    this.callCount += 1;

    if (this.offline) {
      const listing = findByHandle(handle);
      if (!listing) throw new Error(`no agent for handle "${handle}"`);
      const started = Date.now();
      const latency = Math.round(listing.baseLatencyMs * this.latencyScale);
      this.onPartial({ handle, skill, message: `dispatched to ${listing.displayName}` });
      await sleep(latency * 0.5);
      this.onPartial({ handle, skill, message: 'working…' });
      await sleep(latency * 0.5);
      const raw = await listing.handler(inputs);

      // Mock binary producers return { artifacts: [...] } — route them
      // through the same materializer as real SDK downloads so the whole
      // decode → save pipeline is testable offline.
      let artifacts: ArtifactOut[];
      if (isMockArtifactResult(raw)) {
        const taskId = newTaskId();
        artifacts = await Promise.all(
          raw.artifacts.map((a, i) => materializeArtifact(a, taskId, i)),
        );
      } else {
        artifacts = [{ kind: 'data', data: raw, mimeType: 'application/json' }];
      }

      const latencyMs = Date.now() - started;
      this.onPartial({ handle, skill, message: `done (${(latencyMs / 1000).toFixed(1)}s)` });
      return {
        data: primaryData(artifacts),
        artifacts,
        meta: {
          handle,
          displayName: listing.displayName,
          skill,
          latencyMs,
          costUsd: Number(listing.price.amount),
        },
      };
    }

    if (!this.client) throw new Error('Blocks SDK client is not connected');

    const agent = this.discovered.get(handle);
    if (!agent) {
      throw new Error(`agent "${handle}" was not discovered in this session`);
    }

    const started = Date.now();
    const session = await this.client.sendMessage({
      agentName: handle,
      requestParts: buildRequestParts(inputs, inputPartId(agent)),
    });

    this.onPartial({ handle, skill, message: `dispatched to ${agent.displayName}` });
    session.onProgress((event) => {
      const message = typeof event.message === 'string' ? event.message : `progress ${event.progress ?? 0}`;
      this.onPartial({ handle, skill, message });
    });

    try {
      const terminal = await session.waitForTerminal(120_000);
      if (terminal.state !== 'completed') {
        throw new Error(`${handle} finished with state ${terminal.state}`);
      }

      const refs = session.listArtifacts();
      if (refs.length === 0) {
        throw new Error(`${handle} completed without artifacts`);
      }

      const taskId = sanitizeTaskId(session.taskId) || newTaskId();
      const artifacts: ArtifactOut[] = [];
      for (let i = 0; i < refs.length; i += 1) {
        const downloaded = await session.downloadArtifact(refs[i]);
        artifacts.push(await materializeArtifact(downloaded, taskId, i));
      }

      const latencyMs = Date.now() - started;
      this.onPartial({ handle, skill, message: `done (${(latencyMs / 1000).toFixed(1)}s)` });

      return {
        data: primaryData(artifacts),
        artifacts,
        meta: {
          handle,
          displayName: agent.displayName,
          skill,
          latencyMs,
          costUsd: Number(priceFor(agent).amount),
        },
      };
    } finally {
      await session.asyncClose();
    }
  }

  stats() {
    return { connectionId: this.connectionId, callCount: this.callCount, offline: this.offline };
  }

  getUserId(): string | null {
    return this.client?.getUserId() ?? null;
  }

  close() {
    this.closed = true;
    this.client?.destroy();
  }
}

/**
 * Open the single outbound connection to Blocks.ai. In production this
 * is an authenticated outbound HTTPS session using BLOCKS_API_KEY; in
 * offline mode it is an in-process session over the mock catalog.
 */
export async function connect(opts: ConnectOptions = {}): Promise<BlocksSession> {
  const offline = opts.offline ?? process.env.FOUNDATION_OFFLINE !== '0';
  if (!offline && !process.env.BLOCKS_API_KEY) {
    throw new Error('BLOCKS_API_KEY is required for online mode (or set FOUNDATION_OFFLINE=1)');
  }
  await sleep(Math.round(120 * (opts.latencyScale ?? 1)));

  if (offline) return new BlocksSession(opts);

  const cdm = await fetchCdmConfig(process.env.BLOCKS_CDM_URL);
  const client = await TaskClient.create({
    billingMode: 'free',
    apiKey: process.env.BLOCKS_API_KEY,
    baseUrl: process.env.BLOCKS_BACKEND_URL ?? cdm.api.baseUrl,
  });

  return new BlocksSession({
    ...opts,
    client,
    baseUrl: process.env.BLOCKS_BACKEND_URL ?? cdm.api.baseUrl,
  });
}

function tagNames(agent: AgentEntry): string[] {
  const tags = agent.card?.tags ?? agent.tags ?? [];
  return tags.map((tag) => tag.id || tag.name).filter(Boolean);
}

function priceFor(agent: AgentEntry): Price {
  if ((agent.billingMode ?? 'free') === 'free') {
    return { amount: '0.000', currency: 'USD', unit: 'per_call' };
  }

  const amount = readPrice(agent.card?.extensions);
  return { amount: amount ?? '0.000', currency: 'USD', unit: 'per_call' };
}

function readPrice(extensions: Record<string, unknown> | undefined): string | undefined {
  if (!extensions) return undefined;

  for (const key of ['pricePerTask', 'price_per_task', 'price', 'costUsd']) {
    const value = extensions[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(3);
    if (typeof value === 'string' && value.trim()) return value;
  }

  return undefined;
}

function inputPartId(agent: AgentEntry): string {
  const inputs = agent.card?.io?.inputs ?? [];
  return inputs[0]?.id ?? 'request';
}

function inputText(inputs: Record<string, unknown>): string {
  const keys = Object.keys(inputs);
  if (keys.length === 1 && typeof inputs.text === 'string') {
    return inputs.text;
  }
  return JSON.stringify(inputs);
}

/** Input fields whose value is base64 binary too large to ride inline in a
 *  PubNub control message (~32KB cap). They are sent as an uploaded file
 *  part instead; the SDK inlines small ones (≤16KB) and runs the presigned
 *  upload flow for the rest. */
const BINARY_INPUT_FIELDS = ['image', 'audio', 'file'] as const;

const INPUT_FORMAT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
};

/** Accept either a raw base64 string or a full `data:` URL. */
function stripInputDataUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('data:')) return trimmed;
  const comma = trimmed.indexOf(',');
  if (comma === -1) return trimmed;
  const header = trimmed.slice(0, comma);
  return /;base64(?:;|$)/iu.test(header) ? trimmed.slice(comma + 1) : trimmed;
}

/** Build the request parts for a call. Text agents get a single text part
 *  (unchanged). When an input carries base64 binary (image/audio/file), the
 *  bytes go up as an uploaded file part and the remaining fields ride along
 *  as JSON `text` on the same part — so the handler can read both via
 *  `part.text` and `ctx.downloadInputArtifact(part)`. */
function buildRequestParts(inputs: Record<string, unknown>, partId: string) {
  for (const field of BINARY_INPUT_FIELDS) {
    const value = inputs[field];
    if (typeof value === 'string' && value.trim()) {
      const bytes = Buffer.from(stripInputDataUrl(value), 'base64');
      const meta: Record<string, unknown> = { ...inputs };
      delete meta[field];
      const format = typeof inputs.format === 'string' ? inputs.format.toLowerCase() : '';
      const mime = INPUT_FORMAT_MIME[format] ?? 'application/octet-stream';
      const part = filePart(bytes, {
        partId,
        fileName: `${field}.${format || 'bin'}`,
        contentType: mime,
      });
      part.text = JSON.stringify(meta);
      return [part];
    }
  }
  return [textPart(inputText(inputs), partId)];
}

function decodeArtifact(data: Uint8Array): unknown {
  const text = new TextDecoder().decode(data);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ── artifact materialization (Phase 12) ─────────────────────────────────
// Text/JSON artifacts are decoded in place; everything else is written
// under agent/outputs/ (gitignored) and described as { kind: 'file' }.

const OUTPUTS_DIR = fileURLToPath(new URL('../../outputs', import.meta.url));

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

async function materializeArtifact(
  raw: { data: Uint8Array; mimeType: string; fileName?: string },
  taskId: string,
  index: number,
): Promise<ArtifactOut> {
  const mimeType = raw.mimeType || 'application/octet-stream';

  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    return { kind: 'data', data: decodeArtifact(raw.data), mimeType };
  }

  const ext = MIME_EXTENSIONS[mimeType] ?? 'bin';
  const name = `${taskId}-${index}.${ext}`;
  await mkdir(OUTPUTS_DIR, { recursive: true });
  await writeFile(join(OUTPUTS_DIR, name), raw.data);

  const path = `outputs/${name}`;
  return {
    kind: 'file',
    path,
    mimeType,
    bytes: raw.data.byteLength,
    fileName: raw.fileName,
    ...publicUrlFor(path),
  };
}

/** When `OUTPUTS_PUBLIC_BASE_URL` is set (e.g. a tunnel origin in front of
 *  the read-only outputs server), attach a publicly fetchable `url` so
 *  chat clients can embed the artifact — their media fetchers refuse
 *  loopback/private hosts, so a public origin is required. */
function publicUrlFor(path: string): { url?: string } {
  const base = process.env.OUTPUTS_PUBLIC_BASE_URL?.trim();
  if (!base) return {};
  return { url: `${base.replace(/\/+$/u, '')}/${path}` };
}

/** `CallResult.data` stays "the primary artifact": decoded value for
 *  text/JSON, the file descriptor for binary. */
function primaryData(artifacts: ArtifactOut[]): unknown {
  const first = artifacts[0];
  return first.kind === 'data' ? first.data : first;
}

function newTaskId(): string {
  return `task_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeTaskId(taskId: unknown): string {
  return typeof taskId === 'string' ? taskId.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 64) : '';
}
