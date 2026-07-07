/**
 * CLI front door for fan-out — "pull in any agent at once".
 *
 *   npm run fanout -- <skill> [input text...] [--tries N] [--mode all|race|quorum|best] [--quorum N]
 *   npm run fanout                      # whole catalog (online), or mock (offline)
 *
 * Offline (FOUNDATION_OFFLINE=1) fans out across the mock catalog; online
 * (FOUNDATION_OFFLINE=0 + BLOCKS_API_KEY) fans out across the real Blocks
 * network. Failures are reported per agent without aborting the batch;
 * retryable failures get up to --tries attempts (default 2) with backoff.
 */

import { fanout, type FanoutMode } from './fanout.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();

const MODES: FanoutMode[] = ['all', 'race', 'quorum', 'best'];

interface Args {
  skill?: string;
  text: string;
  tries?: number;
  mode?: FanoutMode;
  quorum?: number;
}

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  const args: Args = { text: '' };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--tries' || flag === '--quorum') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${flag} expects a positive integer, got "${argv[i + 1]}"`);
      }
      if (flag === '--tries') args.tries = value;
      else args.quorum = value;
      i += 1;
    } else if (flag === '--mode') {
      const value = argv[i + 1] as FanoutMode;
      if (!MODES.includes(value)) {
        throw new Error(`--mode expects one of ${MODES.join('|')}, got "${argv[i + 1]}"`);
      }
      args.mode = value;
      i += 1;
    } else if (flag !== '--') {
      rest.push(flag);
    }
  }

  args.skill = rest[0]?.trim() || undefined;
  args.text = rest.slice(1).join(' ') || 'Hello from the OpenClaw foundation.';
  return args;
}

async function main() {
  const { skill, text, tries, mode, quorum } = parseArgs(process.argv.slice(2));

  const knobs = [
    mode ? `mode: ${mode}` : '',
    quorum ? `quorum: ${quorum}` : '',
    tries ? `tries: ${tries}` : '',
  ].filter(Boolean).join(', ');
  console.log(
    `▸ fan-out over ${skill ? `skill "${skill}"` : 'the whole catalog'}${knobs ? ` (${knobs})` : ''}`,
  );

  const startedAt = Date.now();
  const { results, audit, failures, attemptsByHandle, abandoned, verdict } = await fanout({
    skill,
    inputs: { text },
    tries,
    mode,
    quorum,
    onPartial: (e) => console.log(`   · ${e.handle} [${e.skill}]: ${e.message}`),
  });
  const wallMs = Date.now() - startedAt;

  console.log('\n── results ──');
  for (const r of results) {
    const attempts = attemptsByHandle[r.meta.handle] ?? 1;
    const note = attempts > 1 ? ` (ok after ${attempts} attempts)` : '';
    console.log(`  ✓ ${r.meta.displayName} [${r.meta.skill}]${note} → ${JSON.stringify(r.data)}`);
  }
  for (const f of failures) {
    console.log(`  ✗ ${f.handle} [${f.skill}] failed after ${f.attempts} ${f.attempts === 1 ? 'try' : 'tries'}: ${f.reason}`);
  }
  for (const handle of abandoned ?? []) {
    console.log(`  ○ ${handle} abandoned (resolution already reached)`);
  }
  if (results.length === 0 && failures.length === 0) {
    console.log('  (no agents matched)');
  }

  if (verdict) {
    console.log(`\n── judge ──\n  winner: ${verdict.winner} — "${verdict.reason}"`);
  }

  let cost = 0;
  let maxLatency = 0;
  for (const m of audit) {
    cost += m.costUsd;
    maxLatency = Math.max(maxLatency, m.latencyMs);
  }
  const retried = results.filter((r) => (attemptsByHandle[r.meta.handle] ?? 1) > 1).length;

  console.log('\n── audit ──');
  console.log(
    `  ${audit.length} ok${retried ? ` (${retried} retried)` : ''}, ${failures.length} failed`
      + `${abandoned?.length ? `, ${abandoned.length} abandoned` : ''}`
      + ` · total $${cost.toFixed(3)} · max ${maxLatency}ms · wall ${wallMs}ms`,
  );

  console.log('\n✅ fan-out complete');
}

main().catch((err) => {
  console.error('\n❌ fan-out failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
