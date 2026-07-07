/**
 * Phase T5.2 offline gate - Google OAuth onboarding.
 *
 * Exercises the URL/state helpers and callback token-store path with a fake
 * token exchanger. No Google network calls, no client secret in browser URL.
 *
 *   npm run check:integration-oauth
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GOOGLE_OAUTH_BOOKING_SCOPES,
  GOOGLE_OAUTH_SCOPES,
  buildGoogleOAuthStart,
  completeGoogleOAuth,
  googleOAuthScopes,
  verifyGoogleOAuthState,
  type GoogleOAuthClient,
} from '../integrations/integration-oauth.ts';
import { loadIntegration } from '../integrations/integration-store.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
process.env.PA_ALLOW_CALENDAR_BOOKING = '0';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'integration-oauth-'));
  const client: GoogleOAuthClient = {
    clientId: 'google-client-id.apps.googleusercontent.com',
    clientSecret: 'server-only-client-secret',
  };
  const redirectUri = 'https://bridge.example.com/api/integrations/google/callback';
  const returnTo = 'https://chat.example.com/';
  const stateSecret = 'offline-state-secret';

  const start = buildGoogleOAuthStart({
    ownerId: 'alice-oid',
    client,
    redirectUri,
    returnTo,
    stateSecret,
    nonce: 'nonce-for-check',
  });
  const consent = new URL(start.url);
  assert(consent.origin === 'https://accounts.google.com', `consent URL must target Google, got ${start.url}`);
  assert(consent.searchParams.get('client_id') === client.clientId, 'consent URL must include client_id');
  assert(consent.searchParams.get('redirect_uri') === redirectUri, 'consent URL must include callback redirect_uri');
  assert(consent.searchParams.get('response_type') === 'code', 'consent URL must request an auth code');
  assert(
    JSON.stringify(GOOGLE_OAUTH_SCOPES) === JSON.stringify([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ]),
    `Google OAuth scopes must stay read-only, got ${JSON.stringify(GOOGLE_OAUTH_SCOPES)}`,
  );
  assert(
    JSON.stringify(googleOAuthScopes()) === JSON.stringify([...GOOGLE_OAUTH_SCOPES]),
    `default Google OAuth helper must stay read-only, got ${JSON.stringify(googleOAuthScopes())}`,
  );
  const requestedScopes = consent.searchParams.get('scope')?.split(/\s+/u) ?? [];
  assert(
    JSON.stringify(requestedScopes) === JSON.stringify([...GOOGLE_OAUTH_SCOPES]),
    `consent URL must request exactly the read-only scopes, got ${JSON.stringify(requestedScopes)}`,
  );
  assert(!start.url.includes(client.clientSecret), 'client secret must never appear in browser consent URL');
  const state = consent.searchParams.get('state') ?? '';
  const verified = verifyGoogleOAuthState(state, stateSecret);
  assert(verified.ownerId === 'alice-oid' && verified.returnTo === returnTo, `state must carry signed owner/returnTo, got ${JSON.stringify(verified)}`);
  console.log('▸ start: Google consent URL has scopes/redirect/state and no client secret ✓');

  const bookingStart = buildGoogleOAuthStart({
    ownerId: 'alice-oid',
    client,
    redirectUri,
    returnTo,
    stateSecret,
    nonce: 'booking-scope-check',
    env: { PA_ALLOW_CALENDAR_BOOKING: '1' } as NodeJS.ProcessEnv,
  });
  const bookingScopes = new URL(bookingStart.url).searchParams.get('scope')?.split(/\s+/u) ?? [];
  assert(
    JSON.stringify(bookingScopes) === JSON.stringify([...GOOGLE_OAUTH_BOOKING_SCOPES]),
    `booking-enabled OAuth must request Calendar write + read-only Gmail scopes, got ${JSON.stringify(bookingScopes)}`,
  );
  assert(
    !bookingScopes.includes('https://www.googleapis.com/auth/gmail.compose')
      && !bookingScopes.includes('https://www.googleapis.com/auth/gmail.send'),
    `booking-enabled OAuth must not request Gmail write scopes, got ${JSON.stringify(bookingScopes)}`,
  );
  console.log('▸ booking mode: consent adds calendar.events without Gmail write scopes ✓');

  let exchanged = false;
  const done = await completeGoogleOAuth({
    code: 'oauth-code',
    state,
    client,
    redirectUri,
    stateSecret,
    store: { baseDir },
    now: () => new Date('2026-06-24T12:00:00.000Z'),
    exchangeToken: async (args) => {
      exchanged = true;
      assert(args.code === 'oauth-code', 'token exchanger must receive the callback code');
      assert(args.redirectUri === redirectUri, 'token exchanger must receive the same redirectUri');
      assert(args.client.clientSecret === client.clientSecret, 'server-side exchanger receives the client secret');
      return { access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer' };
    },
  });
  assert(exchanged, 'fake token exchanger must be called');
  assert(done.ownerId === 'alice-oid' && done.returnTo === returnTo, `callback result must return owner + returnTo, got ${JSON.stringify(done)}`);
  const stored = await loadIntegration('alice-oid', 'google', { baseDir });
  assert(stored?.connectedAt === '2026-06-24T12:00:00.000Z', `stored integration must carry connectedAt, got ${JSON.stringify(stored)}`);
  assert(stored?.token?.refresh_token === 'refresh-token', `stored integration must persist exchanged token, got ${JSON.stringify(stored)}`);
  assert(
    JSON.stringify(stored?.scopes) === JSON.stringify([...GOOGLE_OAUTH_SCOPES]),
    `stored integration must persist exactly the requested read-only scopes, got ${JSON.stringify(stored?.scopes)}`,
  );
  console.log('▸ callback: fake exchange stores per-owner Google token + scopes ✓');

  console.log('\naudit: Google OAuth URL/state/callback token-store path is offline and secret-safe');
  console.log('✅ integration-oauth check passed');
} catch (err) {
  console.error(`❌ integration-oauth check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
