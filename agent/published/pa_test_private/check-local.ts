/**
 * Offline gate for pa_test_private's handler — proves the PA-1 brain is
 * wired in and that the handler acts on the plan envelope WITHOUT a
 * network call for the non-delegating paths.
 *
 * Covered offline (no connect(), no network):
 *   - answer-direct → handler returns the brain's reply verbatim
 *   - call-peer     → handler surfaces the peer plan + a PA-4 note
 *
 * The call-specialist path forces an online discover/call (real network),
 * so it is NOT exercised here; check:assistant-skill already proves the
 * brain emits the correct call-specialist plan for media requests.
 *
 *   npm run check:pa-handler
 */

import handler from './handler.ts';
import { loadRootEnv } from '../../src/env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
// Bind this probe to the owner identity the checks call with, so the
// handler's owner gate (authorizeOwner) admits the request.
process.env.PA_OWNER_ID = 'local';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function run(text: string): Promise<Record<string, unknown>> {
  const result = await handler({
    type: 'StartTask',
    taskId: 'local-check',
    ownerId: 'local',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  });
  const artifact = result.artifacts?.[0];
  assert(
    artifact && artifact.mimeType === 'application/json',
    `expected a JSON artifact for "${text}", got ${JSON.stringify(result)}`,
  );
  const payload = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(payload), `expected an object payload for "${text}", got ${JSON.stringify(payload)}`);
  return payload;
}

try {
  // 1. answer-direct — no network, brain reply returned as-is.
  const direct = await run('What is the capital of France?');
  assert(direct.ok === true, `direct: ok must be true, got ${JSON.stringify(direct.ok)}`);
  assert(
    typeof direct.reply === 'string' && direct.reply.length > 0,
    `direct: reply must be a non-empty string, got ${JSON.stringify(direct.reply)}`,
  );
  console.log(`▸ answer-direct → "${direct.reply}"`);

  // 2. call-peer — no network, plan surfaced with a PA-4 note.
  const peer = await run("Ask Bob's assistant when he's free Thursday.");
  assert(peer.ok === true, `peer: ok must be true, got ${JSON.stringify(peer.ok)}`);
  const actions = peer.actions as Array<Record<string, unknown>> | undefined;
  const peerAction = actions?.find((a) => a.kind === 'call-peer');
  assert(peerAction, `peer: expected a call-peer action, got ${JSON.stringify(peer.actions)}`);
  // Pillar 3.3: the stub carries the owner's `personRef` ("Bob"), NOT a guessed
  // `pa_<name>` handle — the runtime resolves it against the roster.
  assert(
    typeof peerAction.personRef === 'string' && peerAction.personRef.trim().length > 0,
    `peer: call-peer must carry a personRef (not a fabricated handle), got ${JSON.stringify(peerAction)}`,
  );
  assert(
    peerAction.assistant === undefined,
    `peer: the brain must NOT invent a pa_<name> handle, got ${JSON.stringify(peerAction.assistant)}`,
  );
  // With no peer invited, the runtime reports an honest "not an invited peer"
  // PA-4 deferral (never a fabricated call).
  assert(
    typeof peer.note === 'string' && /PA-4/u.test(peer.note),
    `peer: expected a PA-4 deferral note, got ${JSON.stringify(peer.note)}`,
  );
  console.log(`▸ call-peer → personRef "${peerAction.personRef}" (${peer.note})`);

  console.log('\n✅ pa_test_private handler check passed');
} catch (err) {
  console.error(`❌ pa_test_private handler check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
