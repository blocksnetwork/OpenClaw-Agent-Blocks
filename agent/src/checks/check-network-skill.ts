/**
 * End-to-end check of the "Blocks inside OpenClaw" path:
 *
 *   OpenClaw chat → blocks-network skill → exec curl → dashboard bridge
 *   → Blocks network → our served agent → OpenClaw gateway → result
 *
 * Prereqs: gateway up, dashboard running online (FOUNDATION_OFFLINE=0
 * npm run dashboard), and openclaw_echo_normalizer served (the script
 * serves/stops it via the bridge itself).
 *
 * Skips itself when OPENCLAW_GATEWAY_TOKEN or BLOCKS_API_KEY is unset.
 */

import { loadRootEnv } from '../env.ts';

loadRootEnv();

const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789').replace(/\/+$/u, '');
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const bridge = `http://127.0.0.1:${process.env.DASHBOARD_PORT ?? 18888}`;

if (!token || !process.env.BLOCKS_API_KEY) {
  console.log('↷ network-skill check skipped: OPENCLAW_GATEWAY_TOKEN or BLOCKS_API_KEY is not set');
  process.exit(0);
}

const status = await bridgeFetch('/api/status');
if (!status.ok) throw new Error('bridge /api/status not ok — is the dashboard running?');

console.log('▸ serving openclaw_echo_normalizer via the bridge');
const serve = await bridgeFetch('/api/serve', { dir: 'openclaw_echo_normalizer' });
if (!serve.ok) throw new Error(`bridge serve failed: ${serve.error}`);

try {
  console.log('▸ asking the OpenClaw agent to hire a Blocks agent');
  // Random nonce so a canned/simulated reply can't pass by accident,
  // sent in mixed case so only the real round-trip yields the
  // normalized (trimmed + lowercased) form.
  const nonce = `Nx${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const reply = await askOpenClaw(
    [
      'Use the blocks-network skill. Discover an agent with the skill tag "openclaw-echo-normalize"',
      `and call it with the input text "  Foundation ${nonce} Run ". Report the agent's exact output`,
      'and a one-line audit with the real latencyMs and costUsd from the call meta.',
      'Run the commands yourself without asking permission. Never simulate.',
    ].join('\n'),
  );

  const flat = reply.replace(/\s+/gu, ' ');
  console.log(`   → ${flat.slice(0, 300)}`);
  if (!reply.toLowerCase().includes(`foundation ${nonce.toLowerCase()} run`)) {
    throw new Error(`agent reply did not contain the normalized nonce text "foundation ${nonce.toLowerCase()} run"`);
  }
  // A real call meta carries latencyMs — require some ms figure in the audit.
  if (!/\d{2,}\s*ms/iu.test(flat) && !/latency\w*[:=\s]+\d{2,}/iu.test(flat)) {
    throw new Error('agent reply did not report a real latency figure from the call meta');
  }
  if (/simulat/iu.test(flat)) {
    throw new Error('agent reply admits the result was simulated');
  }
  console.log('✅ network-skill passed: OpenClaw agent hired a Blocks agent end-to-end');
} finally {
  await bridgeFetch('/api/stop', { agentName: 'openclaw_echo_normalizer' });
  console.log('▸ stopped openclaw_echo_normalizer');
}

async function bridgeFetch(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${bridge}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function askOpenClaw(content: string): Promise<string> {
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-openclaw-session-key': `network-skill-check-${Date.now()}`,
    },
    body: JSON.stringify({
      model: 'openclaw/default',
      messages: [{ role: 'user', content }],
      max_completion_tokens: 1200,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`gateway HTTP ${response.status}: ${text}`);
  const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
  const reply = json.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) throw new Error(`no assistant content: ${text}`);
  return reply;
}
