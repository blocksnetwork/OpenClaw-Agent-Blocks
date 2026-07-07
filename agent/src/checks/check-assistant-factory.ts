/**
 * Phase PA-2 offline gate — the per-owner assistant generator.
 *
 * Asserts, with no key and no network:
 *   1. renderAssistant() — derives pa_<slug>, emits a private/free card,
 *      and bakes the owner identity into a handler with NO leftover
 *      placeholders and NO LLM-authored logic.
 *   2. round-trip — the generated handler is written, imported, and run:
 *      the baked owner is admitted (answer-direct, no network) and a
 *      different caller is refused. The temp agent is cleaned up after.
 *
 *   npm run check:assistant-factory
 */

import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { renderAssistant, writeAssistant, slugifyOwner } from '../assistant/assistant-factory.ts';
import { loadRootEnv } from '../env.ts';
import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const OWNER = 'alice@acme';
const OWNER_ID = 'owner-uuid-alice';
const ORG_ID = 'org-uuid-acme';

let tmpDir: string | undefined;

try {
  // 1. render — shape + baked identity.
  const rendered = renderAssistant({ owner: OWNER, ownerId: OWNER_ID, orgId: ORG_ID });
  assert(rendered.agentName === `pa_${slugifyOwner(OWNER)}`, `unexpected agentName ${rendered.agentName}`);
  assert(rendered.agentName === 'pa_alice', `expected pa_alice, got ${rendered.agentName}`);

  const blocks = (rendered.card.extensions as { blocks?: Record<string, unknown> }).blocks ?? {};
  assert(blocks.listing === 'private', `card must be private, got ${JSON.stringify(blocks.listing)}`);
  assert(blocks.billingMode === 'free', `card must be free, got ${JSON.stringify(blocks.billingMode)}`);
  const identity = rendered.card.identity as { agentName?: unknown };
  assert(identity.agentName === rendered.agentName, 'card identity.agentName must match');
  const io = rendered.card.io as { outputs?: Array<{ id?: unknown; contentType?: unknown; guaranteed?: unknown }> };
  const outputs = io.outputs ?? [];
  const outputIds = outputs.map((output) => output.id);
  assert(
    outputIds.includes('reply') && outputIds.includes('result') && outputIds.includes('actions'),
    `card must advertise dashboard-friendly multi outputs, got ${JSON.stringify(outputIds)}`,
  );
  const replyOutput = outputs.find((output) => output.id === 'reply');
  assert(replyOutput?.contentType === 'text/markdown' && replyOutput.guaranteed === true, 'reply output must be guaranteed markdown');
  const resultOutput = outputs.find((output) => output.id === 'result');
  assert(resultOutput?.contentType === 'application/json' && resultOutput.guaranteed === true, 'result output must be guaranteed JSON');

  assert(!/__[A-Z_]+__/u.test(rendered.handlerSource), 'handler still contains an unsubstituted placeholder');
  assert(
    rendered.handlerSource.includes(JSON.stringify(OWNER_ID)),
    'handler must bake the ownerId',
  );
  assert(
    rendered.handlerSource.includes(JSON.stringify(ORG_ID)),
    'handler must bake the orgId',
  );
  assert(rendered.handlerSource.includes('runAssistant'), 'handler must defer to the shared runtime');
  assert(rendered.handlerSource.includes('selfHandle: "pa_alice"'), 'handler must pass its own assistant handle for A2A');
  console.log(`▸ render: ${rendered.agentName} → private/free card + baked owner (no placeholders) ✓`);

  // 1b. orgId omitted → no orgId in the baked policy.
  process.env.PA_DEFAULT_LISTING = 'private         # inline comments from --env-file must not leak into cards';
  process.env.PA_DEFAULT_BILLING = 'free            # inline comments from --env-file must not leak into cards';
  const noOrg = renderAssistant({ owner: 'bob@acme', ownerId: 'owner-uuid-bob' });
  assert(noOrg.agentName === 'pa_bob', `expected pa_bob, got ${noOrg.agentName}`);
  assert(!noOrg.handlerSource.includes('orgId'), 'handler must omit orgId when none is given');
  const noOrgBlocks = (noOrg.card.extensions as { blocks?: Record<string, unknown> }).blocks ?? {};
  assert(noOrgBlocks.listing === 'private', `inline-comment listing must normalize to private, got ${JSON.stringify(noOrgBlocks.listing)}`);
  assert(noOrgBlocks.billingMode === 'free', `inline-comment billing must normalize to free, got ${JSON.stringify(noOrgBlocks.billingMode)}`);
  console.log('▸ render: orgId omitted cleanly when not supplied ✓');

  // 2. round-trip — write, import, run the generated handler offline.
  const written = await writeAssistant({ owner: OWNER, ownerId: OWNER_ID, orgId: ORG_ID, slug: '_factory_check' });
  tmpDir = written.dir;
  const mod = (await import(pathToFileURL(written.handlerPath).href)) as {
    default: (task: StartTaskMessage, ctx?: TaskContext) => Promise<HandlerResult>;
  };
  const handler = mod.default;

  async function run(ownerId: string, orgId?: string): Promise<Record<string, unknown>> {
    const result = await handler({
      type: 'StartTask',
      taskId: 'factory-check',
      ownerId,
      ...(orgId ? { orgId } : {}),
      requestParts: [{ partId: 'request', text: 'What is the capital of France?', contentType: 'text/plain' }],
    });
    const artifact = result.artifacts?.[0];
    assert(artifact, `expected an artifact for caller "${ownerId}"`);
    assert(artifact.outputId === 'result', `first artifact must stay the structured result for compatibility, got ${artifact.outputId}`);
    const replyArtifact = result.artifacts?.find((candidate) => candidate.outputId === 'reply');
    assert(replyArtifact && replyArtifact.mimeType === 'text/markdown', `generated handler must also return a markdown reply artifact, got ${JSON.stringify(result.artifacts)}`);
    const payload = JSON.parse(String(artifact.data)) as unknown;
    assert(isRecord(payload), `expected an object payload for caller "${ownerId}"`);
    return payload;
  }

  const admitted = await run(OWNER_ID, ORG_ID);
  assert(admitted.ok === true, `baked owner must be admitted, got ${JSON.stringify(admitted)}`);
  assert(typeof admitted.reply === 'string', 'admitted call must carry a reply');
  console.log(`▸ run: baked owner admitted → "${admitted.reply}"`);

  const refused = await run('owner-uuid-mallory', ORG_ID);
  assert(
    refused.ok === false && refused.error === 'forbidden',
    `a different caller must be refused, got ${JSON.stringify(refused)}`,
  );
  console.log(`▸ run: foreign caller refused → ${refused.error} (${refused.reason})`);

  console.log('\n✅ assistant-factory check passed');
} catch (err) {
  console.error(`❌ assistant-factory check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
}
