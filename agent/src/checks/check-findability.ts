/**
 * Phase PA-0 findability test — "how does our current agent reach an
 * invited PRIVATE agent?" (docs/PERSONAL-ASSISTANT-PLAN.md).
 *
 * Guarded: skips cleanly without BLOCKS_API_KEY. Costs ~nothing (free
 * billingMode, self-contained probe handler — no provider tokens).
 *
 * Serves a throwaway PRIVATE agent (`pa_test_private`) from this process
 * and runs:
 *   Test 1  — public discovery must NOT surface it          [HARD invariant]
 *   Test 2a — owner key can call it directly by handle       [HARD invariant]
 *   Test 2b — an UNINVITED key calling it (records outcome)  [informational]
 *   Test 3  — membership grant (needs the SDK spike)         [pending/manual]
 *   Test 4  — membership-scoped private discovery            [informational]
 *
 * 2b/4 only run when a second key is provided via BLOCKS_API_KEY_PEER.
 * 3 is a placeholder until Phase-0 confirms how a membership is created
 * (the public SDK surface exposes no membership add/remove call).
 *
 *   npm run check:findability
 */

import {
  TaskClient,
  fetchCdmConfig,
  fetchAgentsByListing,
  textPart,
  type DownloadedArtifact,
} from '@blocks-network/sdk';

import { connect, type BlocksSession } from '../blocks/blocks-client.ts';
import { serveAgent, type AgentInstanceHandle } from '../blocks/blocks-serve.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();

if (!process.env.BLOCKS_API_KEY) {
  console.log('↷ findability check skipped: BLOCKS_API_KEY is not set');
  process.exit(0);
}

process.env.FOUNDATION_OFFLINE = '0';

const HANDLE = 'pa_test_private';
const TAG = 'pa-findability-probe';
const PING = 'ping-from-findability-test';
const PEER_KEY = process.env.BLOCKS_API_KEY_PEER;

interface CallOutcome {
  ok: boolean;
  state?: string;
  pong?: string;
  caller?: unknown;
  error?: string;
}

let session: BlocksSession | undefined;
let handle: AgentInstanceHandle | undefined;
let hardFailures = 0;

function hard(cond: unknown, label: string): void {
  if (cond) {
    console.log(`   ✅ ${label}`);
  } else {
    hardFailures += 1;
    console.log(`   ❌ ${label}`);
  }
}

try {
  console.log('▸ serve the throwaway PRIVATE probe (pa_test_private)');
  handle = await serveProbe();
  console.log(`   → serving ${handle.agentName} (private)`);

  // ── Test 1 — public discovery must NOT surface a private agent ──────────
  console.log('\n▸ Test 1 — public discovery must NOT return the private probe');
  session = await connect({ latencyScale: 0 });
  const byTag = await session.discover(TAG);
  const all = await session.discoverAll({ limit: 50 });
  const inTag = byTag.some((a) => a.handle === HANDLE);
  const inAll = all.some((a) => a.handle === HANDLE);
  console.log(`   discover("${TAG}") → ${byTag.length} agents; discoverAll → ${all.length} agents`);
  hard(!inTag, `not present in discover("${TAG}")`);
  hard(!inAll, 'not present in discoverAll()');

  // ── Test 2a — owner key can call it directly by handle ──────────────────
  console.log('\n▸ Test 2a — OWNER key calls the private handle directly (bypassing discover)');
  const owner = await directCall(process.env.BLOCKS_API_KEY!, HANDLE, PING);
  if (owner.ok) {
    console.log(`   → state=${owner.state}, pong="${owner.pong}"`);
    console.log(`   → caller identity Blocks exposed: ${JSON.stringify(owner.caller)}`);
  } else {
    console.log(`   → call failed: ${owner.error}`);
  }
  hard(owner.ok && owner.pong === PING, 'owner direct-call-by-handle succeeds');

  // ── Test 2b — an UNINVITED key calling it (informational) ───────────────
  console.log('\n▸ Test 2b — UNINVITED key calls the private handle (records the rejection shape)');
  if (PEER_KEY) {
    const stranger = await directCall(PEER_KEY, HANDLE, PING);
    if (stranger.ok) {
      console.log(`   ⚠ uninvited call SUCCEEDED (state=${stranger.state}) — Blocks does NOT`);
      console.log('     gate private calls at the network layer; handler authorize() is the ONLY gate.');
    } else {
      console.log(`   → uninvited call rejected: ${stranger.error}`);
      console.log('     (record this exact shape — it tells us whether membership is enforced on call)');
    }
  } else {
    console.log('   ↷ skipped: set BLOCKS_API_KEY_PEER to a second identity to run this');
  }

  // ── Test 3 — membership grant (RESOLVED: native `blocks invite`) ────────
  console.log('\n▸ Test 3 — grant access, then re-call as the invited identity');
  console.log('   ✓ RESOLVED via the Blocks CLI: invites/grants are a first-class private-');
  console.log('     agent primitive (NOT in the public @blocks-network/sdk surface yet):');
  console.log('       blocks invite send <agentName> --email <e> | --org <slug>');
  console.log('       blocks invite accept <token>   (invitee)');
  console.log('       blocks invite list/grants/revoke <agentName>');
  console.log('   → so v1 uses native invitations, not an app-level allowlist. To AUTOMATE');
  console.log('     (dashboard /api/assistant/invite) we still need the REST endpoint the');
  console.log('     CLI calls, or to shell out to `blocks invite` (factory already shells');
  console.log('     out to the CLI for publish — same pattern).');
  console.log('   → to finish Test 3 end-to-end: send an invite to a second identity, accept');
  console.log('     it, then re-run with BLOCKS_API_KEY_PEER set (drives Test 2b green).');

  // ── Test 4 — membership-scoped private discovery (informational) ────────
  console.log('\n▸ Test 4 — does fetchAgentsByListing("private") enumerate invited agents?');
  if (PEER_KEY) {
    // NOTE: fetchAgentsByListing currently takes no apiKey option — this
    // probes whether private listings are returned at all from this seam.
    try {
      const priv = await fetchAgentsByListing('private', { limit: 50 });
      const seen = priv.agents.some((a) => a.agentName === HANDLE);
      console.log(`   → returned ${priv.agents.length} private agents; probe present: ${seen}`);
      console.log('     (if present only for members, this is a second findability path)');
    } catch (err) {
      console.log(`   → fetchAgentsByListing threw: ${asMessage(err)}`);
    }
  } else {
    console.log('   ↷ skipped: needs BLOCKS_API_KEY_PEER (an invited identity) to be meaningful');
  }

  console.log('\n── findability summary ──');
  console.log(`  hard invariants failed: ${hardFailures}`);
  console.log('  next: feed Test 2a caller identity into authorize(); decide D2 from 2b/3.');
  if (hardFailures > 0) {
    console.log('\n❌ findability check FAILED (a hard invariant did not hold)');
    process.exitCode = 1;
  } else {
    console.log('\n✅ findability check passed (core invariants hold; 2b/3/4 are advisory)');
  }
} finally {
  session?.close();
  try {
    handle?.stop();
  } catch {
    // best effort on shutdown
  }
}

async function serveProbe(): Promise<AgentInstanceHandle> {
  const cardPath = new URL('../../published/pa_test_private/agent-card.json', import.meta.url);
  const { default: probeHandler } = await import('../../published/pa_test_private/handler.ts');
  const served = await serveAgent({ cardPath, handler: probeHandler, listing: 'private' });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !served.controlChannel) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!served.controlChannel) throw new Error('pa_test_private did not register within 15s');
  await new Promise((r) => setTimeout(r, 500));
  return served;
}

/**
 * Call an agent BY HANDLE with a given API key, bypassing discovery.
 * This is the path a personal assistant uses for a known private peer —
 * BlocksSession.call() gates on prior discovery, which a private agent
 * never passes, so we go straight to the SDK TaskClient here.
 */
async function directCall(apiKey: string, agentName: string, text: string): Promise<CallOutcome> {
  let client: TaskClient | undefined;
  try {
    const cdm = await fetchCdmConfig(process.env.BLOCKS_CDM_URL);
    const baseUrl = process.env.BLOCKS_BACKEND_URL ?? cdm.api.baseUrl;
    client = await TaskClient.create({ billingMode: 'free', apiKey, baseUrl });

    const taskSession = await client.sendMessage({
      agentName,
      requestParts: [textPart(JSON.stringify({ text }), 'request')],
    });

    try {
      const terminal = await taskSession.waitForTerminal(120_000);
      if (terminal.state !== 'completed') {
        return { ok: false, state: terminal.state, error: `terminal state ${terminal.state}` };
      }
      const refs = taskSession.listArtifacts();
      if (refs.length === 0) return { ok: false, state: terminal.state, error: 'no artifacts' };
      const downloaded = await taskSession.downloadArtifact(refs[0]);
      const parsed = decode(downloaded);
      return {
        ok: true,
        state: terminal.state,
        pong: typeof parsed?.pong === 'string' ? parsed.pong : undefined,
        caller: parsed?.caller,
      };
    } finally {
      await taskSession.asyncClose();
    }
  } catch (err) {
    return { ok: false, error: asMessage(err) };
  } finally {
    client?.destroy();
  }
}

function decode(raw: DownloadedArtifact): { pong?: unknown; caller?: unknown } | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(raw.data)) as { pong?: unknown; caller?: unknown };
  } catch {
    return undefined;
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
