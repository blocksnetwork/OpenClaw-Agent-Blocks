/**
 * Offline check for per-agent Blocks credential lookup.
 *
 * No real key values, network, or Blocks account are needed. This proves the
 * bridge can choose a dedicated key for pa_bob without losing the global key
 * used by the rest of the hosted bridge.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildA2ARequest } from '../a2a/a2a.ts';
import { makeLiveSendA2A } from '../a2a/a2a-transport.ts';
import {
  blocksApiKeyEnvName,
  defaultAgentApiKeysPath,
  resolveAgentBlocksCredential,
} from '../blocks/agent-keyring.ts';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function clearEnv() {
  delete process.env.BLOCKS_API_KEY_PA_BOB;
  delete process.env.BLOCKS_AGENT_API_KEYS_JSON;
  delete process.env.BLOCKS_AGENT_API_KEYS_PATH;
}

let tmp: string | undefined;
try {
  clearEnv();

  assert(blocksApiKeyEnvName('pa_bob') === 'BLOCKS_API_KEY_PA_BOB', 'pa_bob env name must be stable');
  assert(defaultAgentApiKeysPath().endsWith('/data/secrets/agent-api-keys.json'), 'default key path must live under root data/secrets');

  process.env.BLOCKS_API_KEY_PA_BOB = 'env-key';
  let credential = resolveAgentBlocksCredential('pa_bob');
  assert(credential?.apiKey === 'env-key', 'agent-specific env key must win');
  assert(credential.source === 'BLOCKS_API_KEY_PA_BOB', 'env source must name the env var');
  console.log('▸ env: BLOCKS_API_KEY_PA_BOB resolves for pa_bob ✓');

  delete process.env.BLOCKS_API_KEY_PA_BOB;
  process.env.BLOCKS_AGENT_API_KEYS_JSON = JSON.stringify({ pa_bob: { apiKey: 'json-key' } });
  credential = resolveAgentBlocksCredential('pa_bob');
  assert(credential?.apiKey === 'json-key', 'inline JSON key must resolve');
  console.log('▸ inline json: BLOCKS_AGENT_API_KEYS_JSON resolves for pa_bob ✓');

  delete process.env.BLOCKS_AGENT_API_KEYS_JSON;
  tmp = await mkdtemp(join(tmpdir(), 'agent-keyring-'));
  const keyPath = join(tmp, 'agent-api-keys.json');
  await writeFile(keyPath, JSON.stringify({ pa_bob: 'file-key' }), 'utf8');
  process.env.BLOCKS_AGENT_API_KEYS_PATH = keyPath;
  credential = resolveAgentBlocksCredential('pa_bob');
  assert(credential?.apiKey === 'file-key', 'key file must resolve');
  assert(credential.source.includes(keyPath), 'file source must name configured path');
  console.log('▸ key file: BLOCKS_AGENT_API_KEYS_PATH resolves for pa_bob ✓');

  assert(resolveAgentBlocksCredential('pa_markus') === undefined, 'unknown agent must not inherit pa_bob key');
  console.log('▸ isolation: unrelated agents do not inherit dedicated keys ✓');

  const sender = makeLiveSendA2A({ apiKey: 'dedicated-key', directCall: async (_handle, payload) => ({ payload }) });
  const response = await sender('pa_markus', buildA2ARequest({ from: 'pa_bob', intent: 'availability', hop: 1 }), { offline: false });
  assert(typeof response === 'object' && response !== null && (response as Record<string, unknown>).offline === false, 'dedicated-key live sender must return live response shape');
  console.log('▸ A2A sender: accepts a dedicated per-agent apiKey option ✓');

  console.log('\n✅ agent-keyring check passed');
} catch (err) {
  console.error(`❌ agent-keyring check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  clearEnv();
  if (tmp) await rm(tmp, { recursive: true, force: true });
}
