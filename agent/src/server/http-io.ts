/**
 * Shared HTTP plumbing for the bridge: response writers, JSON body parsing +
 * validation, CORS, per-owner identity resolution, auth-token gating, and
 * rate limiting. Everything here is generic infrastructure the route handlers
 * lean on, kept out of the router so `dashboard.ts` stays a thin wiring file.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadRootEnv } from '../env.ts';

// This module reads env-derived config at load time and is imported before
// dashboard.ts runs its own loadRootEnv(), so prime the root .env here first.
// loadRootEnv() is idempotent (it never overwrites already-set keys).
loadRootEnv();

export const HOST = process.env.DASHBOARD_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.DASHBOARD_PORT ?? 18888);

export const DASHBOARD_AUTH_REQUIRED = process.env.DASHBOARD_AUTH_REQUIRED === '1';
export const DASHBOARD_AUTH_OWNER_HEADER = normalizeHeaderName(process.env.DASHBOARD_AUTH_OWNER_HEADER ?? 'x-openclaw-owner-id');
export const DASHBOARD_AUTH_ORG_HEADER = normalizeHeaderName(process.env.DASHBOARD_AUTH_ORG_HEADER ?? 'x-openclaw-org-id');
export const DASHBOARD_AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN?.trim();
export const DASHBOARD_TRUST_PROXY_HEADERS = process.env.DASHBOARD_TRUST_PROXY_HEADERS === '1';

// Cross-origin policy. Local demos may use '*'; hosted/authenticated mode
// fails closed unless the operator pins the allowed front-end origin(s).
export const CORS_ORIGIN = resolveCorsOrigin();

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DashboardIdentity {
  ownerId: string;
  orgId?: string;
  source: 'trusted-header' | 'local-owner';
}

interface RateBucket {
  windowStart: number;
  count: number;
}

const rateBuckets = new Map<string, RateBucket>();

export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

function resolveCorsOrigin(): string {
  const configured = process.env.DASHBOARD_CORS_ORIGIN?.trim();
  if (DASHBOARD_AUTH_REQUIRED) {
    if (!configured || configured === '*') {
      throw new Error('DASHBOARD_CORS_ORIGIN must be set to a concrete hosted origin when DASHBOARD_AUTH_REQUIRED=1');
    }
    if (!DASHBOARD_AUTH_TOKEN && !DASHBOARD_TRUST_PROXY_HEADERS) {
      throw new Error('set DASHBOARD_AUTH_TOKEN or DASHBOARD_TRUST_PROXY_HEADERS=1 when DASHBOARD_AUTH_REQUIRED=1');
    }
  }
  return configured || '*';
}

// ── response helpers ────────────────────────────────────────────────────

export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': CORS_ORIGIN,
  });
  res.end(JSON.stringify(data));
}

export function notFound(res: ServerResponse) {
  json(res, { ok: false, error: 'not found' }, 404);
}

export function corsPreflight(res: ServerResponse) {
  res.writeHead(204, {
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': [
      'authorization',
      'content-type',
      'x-openclaw-session-key',
      'x-openclaw-model',
      'x-openclaw-agent-id',
      DASHBOARD_AUTH_OWNER_HEADER,
      DASHBOARD_AUTH_ORG_HEADER,
    ].join(', '),
    'access-control-max-age': '600',
  });
  res.end();
}

// ── identity + owner resolution ─────────────────────────────────────────

export function dashboardIdentity(
  req: IncomingMessage,
  opts: { required?: boolean } = {},
): DashboardIdentity | undefined {
  const required = opts.required === true || DASHBOARD_AUTH_REQUIRED;
  if (!DASHBOARD_AUTH_REQUIRED) return undefined;
  requireDashboardAuthToken(req);

  const ownerId = headerString(req, DASHBOARD_AUTH_OWNER_HEADER);
  if (!ownerId) {
    if (required) throw new HttpError(401, `authenticated owner is missing (${DASHBOARD_AUTH_OWNER_HEADER})`);
    return undefined;
  }
  const orgId = headerString(req, DASHBOARD_AUTH_ORG_HEADER);
  return { ownerId, ...(orgId ? { orgId } : {}), source: 'trusted-header' };
}

export function ownerFromBody(
  req: IncomingMessage,
  body: Record<string, unknown>,
  key: string,
): string;
export function ownerFromBody(
  req: IncomingMessage,
  body: Record<string, unknown>,
  key: string,
  opts: { optionalWhenUnauthenticated: true },
): string | undefined;
export function ownerFromBody(
  req: IncomingMessage,
  body: Record<string, unknown>,
  key: string,
  opts: { optionalWhenUnauthenticated?: boolean } = {},
): string | undefined {
  const claimed = optionalString(body, key);
  const identity = dashboardIdentity(req, { required: DASHBOARD_AUTH_REQUIRED });
  if (identity) {
    assertOwnerClaim(identity.ownerId, claimed, key);
    return identity.ownerId;
  }
  if (claimed) return claimed;
  if (opts.optionalWhenUnauthenticated) return undefined;
  throw new HttpError(400, `"${key}" (string) is required`);
}

export function ownerFromQuery(
  req: IncomingMessage,
  url: URL,
  key: string,
): string;
export function ownerFromQuery(
  req: IncomingMessage,
  url: URL,
  key: string,
  opts: { optionalWhenUnauthenticated: true },
): string | undefined;
export function ownerFromQuery(
  req: IncomingMessage,
  url: URL,
  key: string,
  opts: { optionalWhenUnauthenticated?: boolean } = {},
): string | undefined {
  const claimed = optionalQuery(url, key);
  const identity = dashboardIdentity(req, { required: DASHBOARD_AUTH_REQUIRED });
  if (identity) {
    assertOwnerClaim(identity.ownerId, claimed, key);
    return identity.ownerId;
  }
  if (claimed) return claimed;
  if (opts.optionalWhenUnauthenticated) return undefined;
  throw new HttpError(400, `"${key}" query parameter is required`);
}

function assertOwnerClaim(authenticatedOwnerId: string, claimedOwnerId: string | undefined, field: string): void {
  if (claimedOwnerId && claimedOwnerId !== authenticatedOwnerId) {
    throw new HttpError(403, `"${field}" does not match the authenticated owner`);
  }
}

export function requireDashboardAuthToken(req: IncomingMessage): void {
  if (!DASHBOARD_AUTH_TOKEN) return;
  const authorization = headerString(req, 'authorization');
  const bearer = authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  const sessionKey = headerString(req, 'x-openclaw-session-key');
  if (bearer === DASHBOARD_AUTH_TOKEN || sessionKey === DASHBOARD_AUTH_TOKEN) return;
  throw new HttpError(401, 'dashboard authentication token is missing or invalid');
}

export function headerString(req: IncomingMessage, name: string): string {
  const value = req.headers[normalizeHeaderName(name)];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : '';
}

// ── rate limiting ───────────────────────────────────────────────────────

export function enforceRateLimit(req: IncomingMessage, route: string): void {
  const limit = routeRateLimit(route);
  if (limit <= 0) return;

  const windowMs = envInt('DASHBOARD_RATE_LIMIT_WINDOW_MS', 60_000);
  const now = Date.now();
  const key = `${route}:${clientKey(req)}`;
  const current = rateBuckets.get(key);
  if (!current || now - current.windowStart >= windowMs) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    pruneRateBuckets(now, windowMs);
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new HttpError(429, `rate limit exceeded for ${route}`);
  }
}

function routeRateLimit(route: string): number {
  if (route.startsWith('POST /api/assistant/')) {
    return envInt('DASHBOARD_RATE_LIMIT_ASSISTANT_PER_WINDOW', 60);
  }
  if (route === 'POST /v1/chat/completions') {
    return envInt('DASHBOARD_RATE_LIMIT_CHAT_PER_WINDOW', 60);
  }
  if (route === 'POST /api/transcribe' || route === 'POST /api/describe-image') {
    return envInt('DASHBOARD_RATE_LIMIT_MEDIA_PER_WINDOW', 20);
  }
  return 0;
}

function clientKey(req: IncomingMessage): string {
  const owner = headerString(req, DASHBOARD_AUTH_OWNER_HEADER);
  const forwardedFor = headerString(req, 'x-forwarded-for').split(',')[0]?.trim();
  return [owner, forwardedFor || req.socket.remoteAddress || 'unknown'].filter(Boolean).join('@');
}

function pruneRateBuckets(now: number, windowMs: number): void {
  if (rateBuckets.size < 1_000) return;
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart >= windowMs) rateBuckets.delete(key);
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

// ── request body parsing + validation ───────────────────────────────────

export async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) throw new HttpError(400, 'request body required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `"${key}" (string) is required`);
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `"${key}" must be a string`);
  return value.trim() || undefined;
}

export function requireRecord(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `"${key}" (JSON object) is required`);
  }
  return value as Record<string, unknown>;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ── query helpers ───────────────────────────────────────────────────────

export function requireQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key)?.trim();
  if (!value) throw new HttpError(400, `"${key}" query parameter is required`);
  return value;
}

export function optionalQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value || undefined;
}

export function addQuery(raw: string, query: Record<string, string>): string {
  const url = new URL(raw, `http://${HOST}:${PORT}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

export function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    'access-control-allow-origin': CORS_ORIGIN,
  });
  res.end();
}
