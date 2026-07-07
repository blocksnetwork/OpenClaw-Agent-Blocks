/**
 * Phase T5.3 / PA-7 offline gate - per-user assistant routing.
 *
 * Asserts, with no key and no network, that one hosted PA runtime can route
 * by task.ownerId while keeping owner state isolated:
 *   1. Alice and Bob get separate owner-scoped roster dirs.
 *   2. Alice cannot list Bob's peers through Alice's roster scope.
 *   3. Integration runners and Google token env are selected per owner.
 *   4. Unknown/unbound callers fail closed, and the owner gate still
 *      refuses a mismatched task before integrations run.
 *
 *   npm run check:pa-multitenant
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { listPeers, saveRoster } from '../assistant/assistant-roster.ts';
import {
  buildMultiTenantAssistantRoute,
  runAssistant,
  runMultiTenantAssistant,
  type MultiTenantAssistantOpts,
  type RunIntegration,
} from '../assistant/assistant-runtime.ts';
import { loadRootEnv } from '../env.ts';
import { googleIntegrationEnvForOwner, saveIntegration } from '../integrations/integration-store.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(result: { artifacts?: Array<{ data?: unknown }> }): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected an artifact, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(parsed), `expected an object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function ownerTask(text: string, ownerId?: string, taskId = `pa-mt-${ownerId ?? 'unbound'}`): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ...(ownerId ? { ownerId } : {}),
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-mt-'));
  const integrationStoreBaseDir = join(baseDir, 'integrations');
  const owners = ['alice-oid', 'bob-oid'] as const;
  const selfHandleByOwnerId = { 'alice-oid': 'pa_alice', 'bob-oid': 'pa_bob' };

  await saveIntegration(
    'alice-oid',
    {
      provider: 'google',
      token: { access_token: 'alice-access', refresh_token: 'alice-refresh' },
      scopes: ['calendar'],
      connectedAt: '2026-06-24T00:00:00.000Z',
    },
    { baseDir: integrationStoreBaseDir },
  );
  await saveIntegration(
    'bob-oid',
    {
      provider: 'google',
      token: { access_token: 'bob-access', refresh_token: 'bob-refresh' },
      scopes: ['calendar'],
      connectedAt: '2026-06-24T00:00:00.000Z',
    },
    { baseDir: integrationStoreBaseDir },
  );

  const integrationCalls: Array<{ ownerId: string; tool: string; tokenPath?: string }> = [];
  const runIntegrationForOwner = (ownerId: string): RunIntegration => async (tool, args, opts) => {
    assert(opts.offline === true, 'check must keep the integration runner offline');
    const env = await googleIntegrationEnvForOwner(ownerId, {}, { baseDir: integrationStoreBaseDir });
    integrationCalls.push({ ownerId, tool, tokenPath: env.GOOGLE_CALENDAR_MCP_TOKEN_PATH });
    return { ok: true, ownerId, tool, tokenPath: env.GOOGLE_CALENDAR_MCP_TOKEN_PATH, args };
  };

  const mtOpts: MultiTenantAssistantOpts = {
    ownerIds: owners,
    stateBaseDir: baseDir,
    integrationStoreBaseDir,
    selfHandleByOwnerId,
    ownerContextByOwnerId: {
      'alice-oid': { freeBusy: ['Alice Thu 09:00 busy'], meetingTitles: ['Alice roadmap'] },
      'bob-oid': { freeBusy: ['Bob Thu 14:00 busy'], meetingTitles: ['Bob launch'] },
    },
    runIntegrationForOwner,
  };

  const aliceRoute = await buildMultiTenantAssistantRoute('alice-oid', mtOpts);
  const bobRoute = await buildMultiTenantAssistantRoute('bob-oid', mtOpts);
  assert(aliceRoute.opts.rosterBaseDir !== bobRoute.opts.rosterBaseDir, 'owner roster dirs must differ');

  await saveRoster(
    {
      owner: 'alice@acme',
      agentName: 'pa_alice',
      peers: [
        {
          owner: 'bob@acme',
          agentName: 'pa_bob',
          since: '2026-06-24T00:00:00.000Z',
          sharePolicy: { freeBusy: true, meetingTitles: false },
          ownerId: 'bob-oid',
        },
      ],
    },
    aliceRoute.opts.rosterBaseDir,
  );
  await saveRoster(
    {
      owner: 'bob@acme',
      agentName: 'pa_bob',
      peers: [
        {
          owner: 'alice@acme',
          agentName: 'pa_alice',
          since: '2026-06-24T00:00:00.000Z',
          sharePolicy: { freeBusy: false, meetingTitles: false },
          ownerId: 'alice-oid',
        },
      ],
    },
    bobRoute.opts.rosterBaseDir,
  );

  const alicePeers = await listPeers('pa_alice', aliceRoute.opts.rosterBaseDir);
  const bobPeers = await listPeers('pa_bob', bobRoute.opts.rosterBaseDir);
  assert(alicePeers.length === 1 && alicePeers[0].agentName === 'pa_bob', 'Alice roster must list Bob in Alice scope');
  assert(bobPeers.length === 1 && bobPeers[0].agentName === 'pa_alice', 'Bob roster must list Alice in Bob scope');
  assert((await listPeers('pa_bob', aliceRoute.opts.rosterBaseDir)).length === 0, "Alice scope must not list Bob's roster");
  console.log('▸ rosters: owner-scoped dirs keep Alice and Bob peer lists separate ✓');

  const aliceRead = payloadOf(await runMultiTenantAssistant(ownerTask('Am I free Thursday afternoon?', 'alice-oid'), undefined, mtOpts));
  const bobRead = payloadOf(await runMultiTenantAssistant(ownerTask('Am I free Thursday afternoon?', 'bob-oid'), undefined, mtOpts));
  assert(aliceRead.ok === true && bobRead.ok === true, 'both owners must be served by the hosted router');
  assert(integrationCalls.length === 2, `expected two owner-local integration calls, got ${integrationCalls.length}`);
  assert(integrationCalls[0].ownerId === 'alice-oid', `Alice request must use Alice runner, got ${JSON.stringify(integrationCalls[0])}`);
  assert(integrationCalls[1].ownerId === 'bob-oid', `Bob request must use Bob runner, got ${JSON.stringify(integrationCalls[1])}`);
  assert(integrationCalls[0].tokenPath && integrationCalls[1].tokenPath, 'each owner must resolve a Google token path');
  assert(integrationCalls[0].tokenPath !== integrationCalls[1].tokenPath, 'Google token paths must be owner-specific');

  const aliceToken = JSON.parse(await readFile(integrationCalls[0].tokenPath, 'utf8')) as Record<string, unknown>;
  const bobToken = JSON.parse(await readFile(integrationCalls[1].tokenPath, 'utf8')) as Record<string, unknown>;
  assert(aliceToken.access_token === 'alice-access', `Alice must get Alice's token, got ${JSON.stringify(aliceToken)}`);
  assert(bobToken.access_token === 'bob-access', `Bob must get Bob's token, got ${JSON.stringify(bobToken)}`);
  console.log('▸ integrations: owner-routed runner resolves owner-specific Google token files ✓');

  const aliceToBob = payloadOf(await runMultiTenantAssistant(
    ownerTask("Ask Bob's assistant when he's free Thursday.", 'alice-oid', 'pa-mt-a2a'),
    undefined,
    mtOpts,
  ));
  assert(isRecord(aliceToBob.a2a) && aliceToBob.a2a.to === 'pa_bob', `Alice outbound A2A must use Alice's roster, got ${JSON.stringify(aliceToBob)}`);
  console.log('▸ share policy: outbound peer resolution uses the caller owner roster only ✓');

  const beforeDenied = integrationCalls.length;
  const unknown = payloadOf(await runMultiTenantAssistant(ownerTask('Am I free Thursday afternoon?', 'mallory-oid'), undefined, mtOpts));
  const unbound = payloadOf(await runMultiTenantAssistant(ownerTask('Am I free Thursday afternoon?'), undefined, mtOpts));
  assert(unknown.ok === false && unknown.error === 'forbidden', `unknown owner must fail closed, got ${JSON.stringify(unknown)}`);
  assert(unbound.ok === false && unbound.error === 'forbidden', `unbound task must fail closed, got ${JSON.stringify(unbound)}`);
  assert(integrationCalls.length === beforeDenied, 'denied callers must not reach integration runners');

  const gate = payloadOf(await runAssistant(
    ownerTask('Am I free Thursday afternoon?', 'bob-oid', 'pa-mt-owner-gate'),
    undefined,
    aliceRoute.policy,
    aliceRoute.opts,
  ));
  assert(gate.ok === false && gate.error === 'forbidden', `owner gate must reject mismatched routed policy, got ${JSON.stringify(gate)}`);
  assert(integrationCalls.length === beforeDenied, 'owner-gate refusal must not reach integrations');
  console.log('▸ owner gate: unknown, unbound, and mismatched owners fail closed before integrations ✓');

  console.log('\naudit: hosted PA routing is per-owner; rosters, share policy, and Google tokens stay isolated');
  console.log('✅ pa-multitenant check passed');
} catch (err) {
  console.error(`❌ pa-multitenant check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
