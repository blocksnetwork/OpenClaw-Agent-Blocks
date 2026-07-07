/**
 * Bridge-contract guard.
 *
 * The OpenClaw gateway's `blocks-network` skill reaches the network ONLY
 * through the dashboard's JSON bridge (workspace/skills/blocks_network/
 * scripts/blocks → these routes). A broad refactor of dashboard.ts that
 * drops one of them silently breaks the whole "OpenClaw hires Blocks
 * agents" spine while typecheck and the chat UI still pass — exactly the
 * kind of regression vibe coding introduces.
 *
 * This test asserts the routes still exist by inspecting the source, so
 * it needs no running server (importing dashboard.ts would bind a port).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dashboardSrc = await readFile(
  fileURLToPath(new URL('../src/server/dashboard.ts', import.meta.url)),
  'utf8',
);

// Routes the `blocks` CLI script curls (status/discover/call/fanout/
// serve/stop/served) plus the chat helpers the front-end depends on.
const BRIDGE_ROUTES = [
  'GET /api/status',
  'GET /api/blocks',
  'GET /api/served',
  'GET /api/local-published',
  'POST /api/run-skill',
  'POST /api/call-agent',
  'POST /api/fanout',
  'POST /api/serve',
  'POST /api/stop',
  'POST /api/transcribe',
  'POST /api/describe-image',
  'POST /api/route',
];

test('dashboard.ts still exposes the gateway bridge contract', () => {
  for (const route of BRIDGE_ROUTES) {
    assert.ok(
      dashboardSrc.includes(`'${route}'`),
      `dashboard.ts is missing bridge route "${route}" — the blocks-network skill curls this`,
    );
  }
});

test('dashboard.ts still serves the chat UI and streaming proxy', () => {
  assert.ok(dashboardSrc.includes('/v1/chat/completions'), 'missing chat completions proxy route');
  assert.ok(dashboardSrc.includes('serveChatAsset'), 'missing chat UI static serving');
  assert.ok(dashboardSrc.includes("startsWith('/outputs/')"), 'missing /outputs/ artifact serving');
});
