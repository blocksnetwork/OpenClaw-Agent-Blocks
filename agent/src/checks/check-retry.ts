/**
 * Phase 10 offline gate — retries.
 *
 * Asserts, with no key and no network:
 *   1. default fanout (tries: 2) over "summarize" reports the flaky
 *      mock (blk_flaky_500) as ok with attempts: 2
 *   2. tries: 1 makes the same mock fail after 1 try, while the other
 *      agents still succeed (failure isolation unchanged)
 *
 *   npm run check:retry
 */

import { fanout } from '../pipeline/fanout.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const FLAKY = 'blk_flaky_500';
const inputs = { text: 'retry check' };

console.log('▸ 1. default fanout — flaky mock retried to success');
const first = await fanout({ skill: 'summarize', inputs, latencyScale: 0, backoffMs: 10 });
assert(first.failures.length === 0, `expected 0 failures, got ${JSON.stringify(first.failures)}`);
assert(
  first.results.some((r) => r.meta.handle === FLAKY),
  `flaky mock missing from results: ${first.results.map((r) => r.meta.handle).join(', ')}`,
);
assert(
  first.attemptsByHandle[FLAKY] === 2,
  `expected attempts 2 for ${FLAKY}, got ${first.attemptsByHandle[FLAKY]}`,
);
console.log(`   → ${first.results.length} ok, ${FLAKY} attempts: ${first.attemptsByHandle[FLAKY]}`);

console.log('▸ 2. tries: 1 — same mock fails, others isolated');
const second = await fanout({ skill: 'summarize', inputs, tries: 1, latencyScale: 0, backoffMs: 10 });
const failure = second.failures.find((f) => f.handle === FLAKY);
assert(failure, `expected ${FLAKY} to fail with tries: 1`);
assert(failure.attempts === 1, `expected 1 attempt, got ${failure.attempts}`);
assert(second.results.length >= 2, `other agents should still succeed, got ${second.results.length}`);
console.log(`   → ${FLAKY} failed after ${failure.attempts} try; ${second.results.length} others ok`);

console.log('\n✅ retry check passed');
