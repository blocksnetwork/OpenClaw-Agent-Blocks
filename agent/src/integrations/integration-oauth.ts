/**
 * integration-oauth - server-side Google OAuth helpers for per-owner tokens.
 *
 * Pure helpers are exported so checks can exercise URL/state/token-store
 * behavior without starting the dashboard or contacting Google.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { saveIntegration, type IntegrationStoreOptions } from './integration-store.ts';

export const GOOGLE_OAUTH_READONLY_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export const GOOGLE_OAUTH_BOOKING_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export const GOOGLE_OAUTH_SCOPES = GOOGLE_OAUTH_READONLY_SCOPES;

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleOAuthState {
  ownerId: string;
  returnTo: string;
  nonce: string;
}

export type TokenExchanger = (
  args: {
    code: string;
    client: GoogleOAuthClient;
    redirectUri: string;
  },
) => Promise<Record<string, unknown>>;

export async function loadGoogleOAuthClient(path = googleOAuthKeysPath()): Promise<GoogleOAuthClient> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const source = readRecordField(parsed, 'web') ?? readRecordField(parsed, 'installed') ?? (isRecord(parsed) ? parsed : {});
  const clientId = typeof source.client_id === 'string' ? source.client_id : typeof source.clientId === 'string' ? source.clientId : '';
  const clientSecret =
    typeof source.client_secret === 'string' ? source.client_secret : typeof source.clientSecret === 'string' ? source.clientSecret : '';
  if (!clientId || !clientSecret) {
    throw new Error(`Google OAuth client file is missing client_id/client_secret: ${path}`);
  }
  return { clientId, clientSecret };
}

export function buildGoogleOAuthStart(args: {
  ownerId: string;
  client: GoogleOAuthClient;
  redirectUri: string;
  returnTo: string;
  stateSecret: string;
  nonce?: string;
  env?: NodeJS.ProcessEnv;
}): { url: string; state: string; scopes: string[] } {
  const scopes = googleOAuthScopes(args.env);
  const state = signGoogleOAuthState(
    {
      ownerId: args.ownerId,
      returnTo: args.returnTo,
      nonce: args.nonce ?? randomBytes(16).toString('hex'),
    },
    args.stateSecret,
  );
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', args.client.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return { url: url.toString(), state, scopes };
}

export function signGoogleOAuthState(state: GoogleOAuthState, secret: string): string {
  if (!state.ownerId.trim()) throw new Error('ownerId is required');
  if (!secret.trim()) throw new Error('OAuth state secret is required');
  const payload = b64url(JSON.stringify(state));
  const sig = hmac(payload, secret);
  return `${payload}.${sig}`;
}

export function verifyGoogleOAuthState(value: string, secret: string): GoogleOAuthState {
  const [payload, sig] = value.split('.');
  if (!payload || !sig) throw new Error('invalid OAuth state');
  const expected = hmac(payload, secret);
  if (!safeEqual(sig, expected)) throw new Error('invalid OAuth state signature');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.ownerId !== 'string' || typeof parsed.returnTo !== 'string' || typeof parsed.nonce !== 'string') {
    throw new Error('invalid OAuth state payload');
  }
  return { ownerId: parsed.ownerId, returnTo: parsed.returnTo, nonce: parsed.nonce };
}

export async function completeGoogleOAuth(args: {
  code: string;
  state: string;
  client: GoogleOAuthClient;
  redirectUri: string;
  stateSecret: string;
  exchangeToken?: TokenExchanger;
  store?: IntegrationStoreOptions;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ownerId: string; returnTo: string; scopes: string[] }> {
  const verified = verifyGoogleOAuthState(args.state, args.stateSecret);
  const scopes = googleOAuthScopes(args.env);
  const exchangeToken = args.exchangeToken ?? exchangeGoogleOAuthCode;
  const token = await exchangeToken({ code: args.code, client: args.client, redirectUri: args.redirectUri });
  await saveIntegration(
    verified.ownerId,
    {
      provider: 'google',
      token,
      scopes,
      connectedAt: (args.now ?? (() => new Date()))().toISOString(),
    },
    args.store,
  );
  return { ownerId: verified.ownerId, returnTo: verified.returnTo, scopes };
}

export function googleOAuthScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.PA_ALLOW_CALENDAR_BOOKING === '1'
    ? [...GOOGLE_OAUTH_BOOKING_SCOPES]
    : [...GOOGLE_OAUTH_READONLY_SCOPES];
}

export async function exchangeGoogleOAuthCode(args: {
  code: string;
  client: GoogleOAuthClient;
  redirectUri: string;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.client.clientId,
    client_secret: args.client.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }
  if (!isRecord(parsed)) throw new Error('Google token exchange returned a non-object payload');
  return parsed;
}

export function googleOAuthKeysPath(): string {
  return fileURLToPath(new URL('../../../data/secrets/gcp-oauth.keys.json', import.meta.url));
}

export function oauthStateSecret(client: GoogleOAuthClient, env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_OAUTH_STATE_SECRET || env.OPENCLAW_GATEWAY_TOKEN || client.clientSecret;
}

function hmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function readRecordField(value: unknown, field: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const candidate = value[field];
  return isRecord(candidate) ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
