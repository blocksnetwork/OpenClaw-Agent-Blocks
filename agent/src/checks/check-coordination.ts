/**
 * Phase 11 offline gate — coordination strategies.
 *
 *   npm run check:coordination               # race + quorum + best gates
 *   node --experimental-strip-types src/checks/check-coordination.ts --pipeline
 *                                            # pipeline gate only
 *
 * All gates run against the mock catalog: no key, no network.
 */

import { fanout } from '../pipeline/fanout.ts';
import { pipeline } from '../pipeline/pipeline.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const TERSE = 'blk_summarize_7c2'; // 800ms base latency, returns { summary }
const KEYWORD = 'blk_summarize_b91'; // 500ms base latency, returns { keywords }
const FLAKY = 'blk_flaky_500';

if (process.argv.includes('--pipeline')) {
  await pipelineGate();
} else {
  await raceGate();
  await quorumGate();
  await bestGate();
}

async function raceGate() {
  console.log("▸ race — first success wins, the rest abandoned");
  const started = Date.now();
  const r = await fanout({
    skill: 'summarize',
    handles: [TERSE, KEYWORD],
    inputs: { text: 'Race me. Quickly.' },
    mode: 'race',
    latencyScale: 0.25, // KEYWORD ~125ms beats TERSE ~200ms deterministically
  });
  const wallMs = Date.now() - started;

  assert(r.mode === 'race', `expected mode race, got ${r.mode}`);
  assert(r.results.length === 1, `race must return exactly 1 result, got ${r.results.length}`);
  assert(
    r.results[0].meta.handle === KEYWORD,
    `expected the faster mock (${KEYWORD}) to win, got ${r.results[0].meta.handle}`,
  );
  assert(
    r.abandoned?.includes(TERSE),
    `expected ${TERSE} in abandoned, got ${JSON.stringify(r.abandoned)}`,
  );
  console.log(`   → winner ${r.results[0].meta.handle} in ${wallMs}ms; abandoned: ${r.abandoned?.join(', ')}`);
}

async function quorumGate() {
  console.log('▸ quorum — resolve at N successes');
  const r = await fanout({
    skill: 'summarize',
    inputs: { text: 'Two of you agreeing is enough.' },
    mode: 'quorum',
    quorum: 2,
    latencyScale: 0.25,
    backoffMs: 1_500, // flaky's retry is still backing off when quorum lands
  });

  assert(r.results.length === 2, `quorum 2 must return exactly 2 results, got ${r.results.length}`);
  assert(
    r.abandoned?.includes(FLAKY),
    `expected ${FLAKY} (mid-retry) in abandoned, got ${JSON.stringify(r.abandoned)}`,
  );
  console.log(`   → ${r.results.map((x) => x.meta.handle).join(' + ')}; abandoned: ${r.abandoned?.join(', ')}`);

  // quorum: 1 behaves like race — exactly one result.
  const single = await fanout({
    skill: 'summarize',
    handles: [TERSE, KEYWORD],
    inputs: { text: 'First one home.' },
    mode: 'quorum',
    quorum: 1,
    latencyScale: 0.25,
  });
  assert(single.results.length === 1, `quorum 1 must return exactly 1 result, got ${single.results.length}`);
  console.log(`   → quorum 1 resolved with ${single.results[0].meta.handle}`);
}

async function bestGate() {
  console.log('▸ best — all answer, the local judge picks');
  const r = await fanout({
    skill: 'summarize',
    handles: [TERSE, KEYWORD],
    inputs: { text: 'The launch slipped a week because of a battery recall.' },
    mode: 'best',
    latencyScale: 0,
  });

  assert(r.results.length === 2, `expected both candidates to answer, got ${r.results.length}`);
  assert(r.verdict, 'mode best must produce a verdict');
  assert(
    r.verdict.winner === TERSE,
    `expected the judge to prefer the sentence summary (${TERSE}), got ${r.verdict.winner}`,
  );
  assert(r.verdict.reason.trim().length > 0, 'verdict must carry a reason');
  console.log(`   → winner: ${r.verdict.winner} — "${r.verdict.reason}"`);
}

async function pipelineGate() {
  console.log('▸ pipeline — step output feeds the next step, one session');
  const text = 'Chain me through. Then drop the rest.';
  const r = await pipeline(
    [
      { skill: 'summarize', mapInputs: () => ({ text }) },
      {
        skill: 'echo',
        mapInputs: (prev) => ({ text: (prev as { summary: string }).summary }),
      },
    ],
    { latencyScale: 0 },
  );

  assert(r.steps.length === 2, `expected 2 step results, got ${r.steps.length}`);
  assert(r.audit.length === 2, `expected 2 audit rows, got ${r.audit.length}`);
  const summary = (r.steps[0].data as { summary: string }).summary;
  const echoed = (r.steps[1].data as { echoed: string }).echoed;
  assert(
    echoed === summary,
    `step 2 must receive step 1's output: summary="${summary}" but echoed="${echoed}"`,
  );
  console.log(`   → "${summary}" flowed into step 2 (${r.audit.map((m) => m.handle).join(' → ')})`);
}

console.log('\n✅ coordination check passed');
