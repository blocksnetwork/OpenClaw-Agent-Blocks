/**
 * Phase T5.1 offline gate - per-owner integration token store.
 *
 * Uses a temp directory only. Proves save/load/list/remove, owner isolation,
 * traversal-safe filenames, and owner Google token env override.
 *
 *   npm run check:integration-store
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  googleIntegrationEnvForOwner,
  integrationStorePath,
  listIntegrations,
  loadIntegration,
  removeIntegration,
  resolveIntegrationTokenPath,
  sanitizeOwnerId,
  saveIntegration,
} from '../integrations/integration-store.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'integration-store-'));

  await saveIntegration(
    'alice-oid',
    {
      provider: 'google',
      tokenPath: '/tmp/alice-google-token.json',
      scopes: ['calendar.readonly', 'gmail.readonly'],
      connectedAt: '2026-06-24T00:00:00.000Z',
    },
    { baseDir },
  );

  const alice = await loadIntegration('alice-oid', 'google', { baseDir });
  assert(alice?.tokenPath === '/tmp/alice-google-token.json', `load must return Alice's tokenPath, got ${JSON.stringify(alice)}`);
  assert(alice.scopes.includes('gmail.readonly'), `scopes must round-trip, got ${JSON.stringify(alice.scopes)}`);
  assert((await listIntegrations('bob-oid', { baseDir })).length === 0, 'listIntegrations must isolate owners');
  console.log('▸ store: save/load round-trip and owner isolation ✓');

  await saveIntegration(
    'bob-oid',
    {
      provider: 'google',
      token: { access_token: 'bob-access', refresh_token: 'bob-refresh' },
      scopes: ['calendar.readonly', 'gmail.readonly'],
      connectedAt: '2026-06-24T00:01:00.000Z',
    },
    { baseDir },
  );
  const bobTokenPath = await resolveIntegrationTokenPath('bob-oid', 'google', { baseDir });
  assert(typeof bobTokenPath === 'string', 'inline token must materialize to a token file');
  const bobToken = JSON.parse(await readFile(bobTokenPath, 'utf8')) as Record<string, unknown>;
  assert(bobToken.access_token === 'bob-access', `materialized inline token must contain token JSON, got ${JSON.stringify(bobToken)}`);
  console.log('▸ token: inline token materializes to gitignored owner token file ✓');

  const env = await googleIntegrationEnvForOwner(
    'alice-oid',
    {
      PA_CALENDAR_MCP_CMD: 'npx',
      GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/tmp/global-token.json',
      GOOGLE_OAUTH_CREDENTIALS: '/home/ubuntu/openclaw-foundation/data/secrets/gcp-oauth.keys.json',
    },
    { baseDir },
  );
  assert(env.GOOGLE_CALENDAR_MCP_TOKEN_PATH === '/tmp/alice-google-token.json', 'owner tokenPath must override global calendar token env');
  assert(env.GOOGLE_GMAIL_MCP_TOKEN_PATH === '/tmp/alice-google-token.json', 'owner tokenPath must be available to Gmail MCP env too');
  assert(env.GMAIL_CREDENTIALS_PATH === '/tmp/alice-google-token.json', 'owner tokenPath must be passed to @klodr/gmail-mcp as GMAIL_CREDENTIALS_PATH');
  assert(
    env.GMAIL_OAUTH_PATH === '/home/ubuntu/openclaw-foundation/data/secrets/gcp-oauth.keys.json',
    'GOOGLE_OAUTH_CREDENTIALS must be passed to @klodr/gmail-mcp as GMAIL_OAUTH_PATH',
  );
  console.log('▸ env: owner Google token/client paths wire both Calendar and @klodr Gmail MCP ✓');

  const dangerous = '../../alice/../../secret';
  const sanitized = sanitizeOwnerId(dangerous);
  assert(!sanitized.includes('/') && !sanitized.includes('..'), `sanitized ownerId must block traversal, got ${sanitized}`);
  const storePath = resolve(integrationStorePath(dangerous, { baseDir }));
  assert(storePath.startsWith(resolve(baseDir)), `store path must stay inside baseDir, got ${storePath}`);
  console.log('▸ sanitizer: traversal-shaped ownerId stays inside integration store ✓');

  await removeIntegration('alice-oid', 'google', { baseDir });
  assert((await loadIntegration('alice-oid', 'google', { baseDir })) === null, 'removeIntegration must remove the provider record');
  assert((await loadIntegration('missing-owner', 'google', { baseDir })) === null, 'missing integration must load as null, not throw');
  console.log('▸ remove: provider removal and missing-owner load are safe ✓');

  console.log('\naudit: per-owner Google integration store is isolated, sanitized, and env-overridable');
  console.log('✅ integration-store check passed');
} catch (err) {
  console.error(`❌ integration-store check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
