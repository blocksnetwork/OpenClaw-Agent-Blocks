/**
 * U3 offline gate - bridge identity helper for ChatUI/Blocks unification.
 *
 * Asserts, with no key and no network, that GET /api/identity can be
 * backed by an injected identity source and returns only the public owner
 * identity the ChatUI needs for its ownerId default.
 *
 *   npm run check:identity
 */

import { apiIdentity } from '../assistant/identity.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

try {
  const response = await apiIdentity(async () => ({ ownerId: 'owner_123', orgId: 'org_456' }));
  assert(response.ok === true, 'identity response must be ok');
  assert(response.action === 'identity', `action must be identity, got ${response.action}`);
  assert(response.ownerId === 'owner_123', `ownerId must come from the injected source, got ${response.ownerId}`);
  assert(response.orgId === 'org_456', `orgId must come from the injected source, got ${response.orgId}`);

  const leaked = Object.keys(response).filter((key) => /key|secret|token|credential/i.test(key));
  assert(leaked.length === 0, `identity response must not expose secrets, got ${leaked.join(', ')}`);
  console.log('▸ response: ownerId/orgId only; no key, token, secret, or credential fields ✓');

  let failedClosed = false;
  try {
    await apiIdentity(async () => {
      throw new Error('identity unavailable');
    });
  } catch (err) {
    failedClosed = err instanceof Error && err.message === 'identity unavailable';
  }
  assert(failedClosed, 'identity lookup must fail closed when the source cannot identify the caller');
  console.log('▸ failure: unavailable identity propagates as an error instead of inventing an owner ✓');

  console.log('\naudit: /api/identity handler shape is injectable, offline, and secret-safe');
  console.log('✅ identity check passed');
} catch (err) {
  console.error(`❌ identity check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
