/**
 * Phase PA-2 offline gate — the owner authorization gate.
 *
 * Asserts, with no key and no network:
 *   1. authorizeOwner() unit behavior — fail-closed when unbound, exact
 *      ownerId/orgId matching, AND-semantics when both are configured.
 *   2. handler integration — the bound owner is admitted (gets a reply),
 *      a mismatched caller is refused with { ok:false, error:'forbidden' },
 *      and an unbound assistant refuses everything.
 *
 * Uses an answer-direct prompt so the admitted path never touches the
 * network (the call-specialist path forces a live discover/call).
 *
 *   npm run check:authorize
 */

import handler from '../../published/pa_test_private/handler.ts';
import { authorizeOwner, ownerPolicyFromEnv } from '../server/authorize.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function call(ownerId: string): Promise<Record<string, unknown>> {
  const result = await handler({
    type: 'StartTask',
    taskId: 'authz-check',
    ownerId,
    requestParts: [{ partId: 'request', text: 'What is the capital of France?', contentType: 'text/plain' }],
  });
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected an artifact for caller "${ownerId}", got ${JSON.stringify(result)}`);
  const payload = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(payload), `expected an object payload for caller "${ownerId}"`);
  return payload;
}

try {
  // 1. unit — fail closed when nothing is bound.
  const unbound = authorizeOwner({ ownerId: 'alice' }, {});
  assert(!unbound.ok, 'unbound policy must reject (fail closed)');

  // 1. unit — exact ownerId matching.
  assert(authorizeOwner({ ownerId: 'alice' }, { ownerId: 'alice' }).ok, 'matching ownerId must pass');
  assert(!authorizeOwner({ ownerId: 'mallory' }, { ownerId: 'alice' }).ok, 'mismatched ownerId must reject');

  // 1. unit — orgId matching.
  assert(authorizeOwner({ orgId: 'acme' }, { orgId: 'acme' }).ok, 'matching orgId must pass');
  assert(!authorizeOwner({ orgId: 'evilcorp' }, { orgId: 'acme' }).ok, 'mismatched orgId must reject');

  // 1. unit — AND-semantics when both fields are configured.
  assert(
    authorizeOwner({ ownerId: 'alice', orgId: 'acme' }, { ownerId: 'alice', orgId: 'acme' }).ok,
    'both-match must pass',
  );
  assert(
    !authorizeOwner({ ownerId: 'alice', orgId: 'evilcorp' }, { ownerId: 'alice', orgId: 'acme' }).ok,
    'one-field mismatch must reject',
  );

  // 1. unit — ownerPolicyFromEnv reads PA_OWNER_ID / PA_OWNER_ORG_ID.
  const policy = ownerPolicyFromEnv({ PA_OWNER_ID: 'alice', PA_OWNER_ORG_ID: 'acme' } as NodeJS.ProcessEnv);
  assert(policy.ownerId === 'alice' && policy.orgId === 'acme', 'env policy must read both fields');
  console.log('▸ unit: fail-closed + ownerId/orgId AND-matching + env policy ✓');

  // 2. handler — bound owner admitted.
  process.env.PA_OWNER_ID = 'alice';
  delete process.env.PA_OWNER_ORG_ID;
  const ok = await call('alice');
  assert(ok.ok === true, `bound owner must be admitted, got ${JSON.stringify(ok)}`);
  assert(typeof ok.reply === 'string', `admitted call must carry a reply, got ${JSON.stringify(ok)}`);
  console.log(`▸ handler: owner "alice" admitted → "${ok.reply}"`);

  // 2. handler — mismatched caller refused.
  const denied = await call('mallory');
  assert(
    denied.ok === false && denied.error === 'forbidden',
    `mismatched caller must be refused with forbidden, got ${JSON.stringify(denied)}`,
  );
  console.log(`▸ handler: caller "mallory" refused → ${denied.error} (${denied.reason})`);

  // 2. handler — unbound assistant refuses everyone.
  delete process.env.PA_OWNER_ID;
  const unboundCall = await call('alice');
  assert(
    unboundCall.ok === false && unboundCall.error === 'forbidden',
    `unbound assistant must refuse everyone, got ${JSON.stringify(unboundCall)}`,
  );
  console.log('▸ handler: unbound assistant refuses everyone ✓');

  console.log('\n✅ authorize check passed');
} catch (err) {
  console.error(`❌ authorize check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
