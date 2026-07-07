/**
 * Foundation smoke test / CLI entrypoint.
 *
 * Proves the whole shape end-to-end:
 *   1. run a LOCAL OpenClaw skill (echo_check) via the gateway client
 *   2. open ONE outbound Blocks session
 *   3. discover an agent BY SKILL (never by name)
 *   4. call the discovered agent and collect result + audit metadata
 *
 * Runs fully offline by default (FOUNDATION_OFFLINE=1). Once Codex wires
 * the real gateway + Blocks SDK, the same flow runs against the network.
 *
 *   npm run smoke
 *   npm run smoke -- "your text here"
 */

import { runSkill } from '../blocks/openclaw-client.ts';
import { connect } from '../blocks/blocks-client.ts';
import { loadRootEnv } from '../env.ts';
import type { CallMeta } from '../types.ts';

loadRootEnv();

async function main() {
  const text = process.argv.slice(2).join(' ') || 'Hello from the OpenClaw foundation.';
  const audit: CallMeta[] = [];
  const online = process.env.FOUNDATION_OFFLINE === '0';

  console.log('▸ 1. local OpenClaw skill: echo_check');
  const local = await runSkill('echo_check', { text });
  console.log('   →', JSON.stringify(local));

  console.log('▸ 2. connect() to Blocks (single outbound)');
  const session = await connect({
    onPartial: (e) => console.log(`   · ${e.handle} [${e.skill}]: ${e.message}`),
  });
  console.log('   →', JSON.stringify(session.stats()));

  const skill = process.env.BLOCKS_SKILL ?? (online ? 'echo' : 'summarize');
  console.log(`▸ 3. discover() by skill: "${skill}"`);
  const agents = await session.discover(skill);
  if (agents.length === 0) throw new Error(`no Blocks agent found for skill "${skill}"`);
  const chosen = agents[0];
  console.log(`   → ${agents.length} match(es); choosing ${chosen.handle} ($${chosen.price.amount}/call)`);

  console.log(`▸ 4. call() ${chosen.handle}`);
  const res = await session.call(chosen.handle, skill, { text });
  audit.push(res.meta);
  console.log('   →', JSON.stringify(res.data));

  session.close();

  console.log('\n── audit trail ──');
  let cost = 0;
  for (const m of audit) {
    cost += m.costUsd;
    console.log(`  ${m.displayName} [${m.skill}]  ${m.latencyMs}ms  $${m.costUsd.toFixed(3)}`);
  }
  console.log(`  total: ${audit.length} call(s), $${cost.toFixed(3)}`);
  console.log('\n✅ foundation smoke passed');
}

main().catch((err) => {
  console.error('\n❌ smoke failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
