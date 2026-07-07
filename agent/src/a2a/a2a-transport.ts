/**
 * a2a-transport - live direct-handle A2A sender (Phase T4.3).
 *
 * Private assistants are not discoverable, so the live path calls the known
 * roster handle directly through the Blocks TaskClient. The payload is only
 * the scoped A2A contract: no owner context, no confirm tokens, no extras.
 */

import { TaskClient, fetchCdmConfig, textPart, type ArtifactRef, type DownloadedArtifact } from '@blocks-network/sdk';

import { buildA2ARequest, type A2ARequest } from './a2a.ts';
import type { SendA2A } from '../assistant/assistant-runtime.ts';

export type DirectA2ACall = (handle: string, payload: A2ARequest) => Promise<unknown>;

export interface LiveA2AOptions {
  apiKey?: string;
  directCall?: DirectA2ACall;
}

/**
 * Build the default outbound sender. Offline returns the deterministic stub
 * shape used by earlier PA-4 checks; live calls the invited peer by handle.
 */
export function makeLiveSendA2A(opts: LiveA2AOptions = {}): SendA2A {
  return async (handle, request, sendOpts) => {
    const payload = scopedA2APayload(request);
    if (sendOpts.offline) return offlineA2AResponse(handle, payload);

    const directCall = opts.directCall ?? ((target, body) => directBlocksCall(target, body, opts.apiKey));
    const response = await directCall(handle, payload);
    return {
      ok: true,
      a2a: true,
      offline: false,
      to: handle,
      intent: payload.intent,
      threadId: payload.threadId,
      hop: payload.hop,
      response,
    };
  };
}

/** Allow-list the wire payload to the A2A contract exactly. */
export function scopedA2APayload(request: A2ARequest): A2ARequest {
  return {
    a2a: true,
    intent: request.intent,
    from: request.from,
    threadId: request.threadId,
    hop: request.hop,
    ...(request.window ? { window: request.window } : {}),
  };
}

function offlineA2AResponse(handle: string, request: A2ARequest): Record<string, unknown> {
  return {
    ok: true,
    a2a: true,
    offline: true,
    to: handle,
    intent: request.intent,
    threadId: request.threadId,
    hop: request.hop,
    note: 'A2A send is offline-stubbed; the live round-trip is gated on a real BLOCKS_API_KEY + an invited peer',
  };
}

async function directBlocksCall(handle: string, payload: A2ARequest, apiKeyOverride?: string): Promise<unknown> {
  const apiKey = apiKeyOverride?.trim() || process.env.BLOCKS_API_KEY;
  if (!apiKey) throw new Error('BLOCKS_API_KEY is required for live A2A transport');

  let client: TaskClient | undefined;
  try {
    const cdm = await fetchCdmConfig(process.env.BLOCKS_CDM_URL);
    const baseUrl = process.env.BLOCKS_BACKEND_URL ?? cdm.api.baseUrl;
    client = await TaskClient.create({ billingMode: 'free', apiKey, baseUrl });
    const taskSession = await client.sendMessage({
      agentName: handle,
      requestParts: [textPart(JSON.stringify(payload), 'request')],
    });
    const capturedRefs = captureArtifactRefs(taskSession);

    try {
      const terminal = await taskSession.waitForTerminal(120_000);
      if (terminal.state !== 'completed') {
        throw new Error(`${handle} finished with state ${terminal.state}`);
      }
      const refs = await waitForArtifactRefs(taskSession, capturedRefs.refs, 5_000);
      if (refs.length === 0) return { ok: true, state: terminal.state, artifacts: [] };
      const artifacts: unknown[] = [];
      for (const ref of refs) {
        const downloaded = await taskSession.downloadArtifact(ref);
        artifacts.push(decodeArtifact(downloaded));
      }
      return artifacts.length === 1 ? artifacts[0] : { ok: true, state: terminal.state, artifacts };
    } finally {
      await taskSession.asyncClose();
      capturedRefs.stop();
    }
  } finally {
    client?.destroy();
  }
}

interface ArtifactSession {
  listArtifacts(): ArtifactRef[];
  onArtifact(cb: (event: unknown) => void): () => void;
}

function captureArtifactRefs(session: ArtifactSession): { refs: ArtifactRef[]; stop: () => void } {
  const refs: ArtifactRef[] = [];
  const seen = new Set<string>();
  const add = (ref: unknown) => {
    if (!isArtifactRef(ref)) return;
    const key = JSON.stringify(ref);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const ref of session.listArtifacts()) add(ref);
  const stop = session.onArtifact((event) => {
    if (isRecord(event)) add(event.artifactRef);
  });
  return { refs, stop };
}

async function waitForArtifactRefs(session: ArtifactSession, capturedRefs: ArtifactRef[], timeoutMs: number): Promise<ArtifactRef[]> {
  const existing = mergeArtifactRefs(capturedRefs, session.listArtifacts());
  if (existing.length > 0) return existing;

  await new Promise<void>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (unsubscribe) unsubscribe();
      resolve();
    };
    unsubscribe = session.onArtifact(() => finish());
    setTimeout(finish, timeoutMs);
  });

  return mergeArtifactRefs(capturedRefs, session.listArtifacts());
}

function mergeArtifactRefs(...groups: ArtifactRef[][]): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const ref of group) {
      const key = JSON.stringify(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return isRecord(value) && typeof value.kind === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeArtifact(raw: Pick<DownloadedArtifact, 'data'>): unknown {
  const text = new TextDecoder().decode(raw.data);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ── liveness probe ──────────────────────────────────────────────────────
// A private peer isn't discoverable, and the registry only proves it's
// *registered* — not that an instance is *serving*. The one honest liveness
// signal is to actually reach it: send a tiny reachability task and watch for
// the agent to pick it up (first progress/terminal). If nothing comes back in
// the window, no instance is serving. We cancel right after the first sign of
// life (or on timeout) so the peer never fully processes the probe.

export type PeerLiveness = 'online' | 'offline' | 'unknown';

export interface PeerProbeResult {
  /** An instance picked up the probe within the window. */
  online: boolean;
  /** The send itself succeeded (transport + auth OK), regardless of pickup. */
  reachable: boolean;
  latencyMs: number;
  reason: string;
  state?: string;
}

/** Map a probe result to the 3-state the UI renders. `unknown` is reserved for
 *  "we couldn't even ask" (no key, transport error) — never conflated with a
 *  genuine offline (asked, nobody home). Pure, so it's unit-testable offline. */
export function probeStatusLabel(result: PeerProbeResult): PeerLiveness {
  if (!result.reachable) return 'unknown';
  return result.online ? 'online' : 'offline';
}

interface ProbeOptions {
  timeoutMs?: number;
  apiKey?: string;
}

/** Resolve once the agent shows any sign of life (a progress or terminal
 *  event) or the timeout elapses (→ null). */
function firstSignOfLife(
  session: { onProgress: (cb: (e: unknown) => void) => unknown; onTerminal: (cb: (e: { state?: string }) => void) => unknown },
  timeoutMs: number,
): Promise<{ state?: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: { state?: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    session.onProgress(() => finish({}));
    session.onTerminal((event) => finish({ state: event.state }));
    setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Probe whether an invited peer's assistant is actually serving. Online means
 * an instance acknowledged a reachability task within `timeoutMs`. Returns a
 * structured result; callers map it with `probeStatusLabel`.
 */
export async function probePeerReachable(handle: string, opts: ProbeOptions = {}): Promise<PeerProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const apiKey = opts.apiKey ?? process.env.BLOCKS_API_KEY;
  const started = Date.now();
  if (!apiKey) {
    return { online: false, reachable: false, latencyMs: 0, reason: 'BLOCKS_API_KEY is required to probe a peer' };
  }

  let client: TaskClient | undefined;
  try {
    const cdm = await fetchCdmConfig(process.env.BLOCKS_CDM_URL);
    const baseUrl = process.env.BLOCKS_BACKEND_URL ?? cdm.api.baseUrl;
    client = await TaskClient.create({ billingMode: 'free', apiKey, baseUrl });
    const payload = scopedA2APayload(
      buildA2ARequest({ from: 'pa_probe', intent: 'reachability check (liveness probe)', hop: 1 }),
    );
    const session = await client.sendMessage({
      agentName: handle,
      requestParts: [textPart(JSON.stringify(payload), 'request')],
    });
    try {
      const alive = await firstSignOfLife(session, timeoutMs);
      const latencyMs = Date.now() - started;
      // Don't make the peer fully run a throwaway probe.
      try { await session.cancel(); } catch { /* best effort */ }
      return alive
        ? { online: true, reachable: true, latencyMs, reason: 'peer instance picked up the probe', state: alive.state }
        : { online: false, reachable: true, latencyMs, reason: `no instance responded within ${timeoutMs}ms` };
    } finally {
      await session.asyncClose();
    }
  } catch (err) {
    return {
      online: false,
      reachable: false,
      latencyMs: Date.now() - started,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client?.destroy();
  }
}
