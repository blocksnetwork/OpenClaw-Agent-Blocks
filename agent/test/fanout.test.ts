/**
 * Offline tests for fan-out coordination. These pin the *shape* of each
 * mode's result (the contract the dashboard + blocks-network skill rely
 * on) rather than exact counts, since the mock catalog includes a
 * deliberately flaky agent whose retry behaviour is order-dependent.
 *
 * Mode 'best' is intentionally not exercised here: its judge step
 * (pick_best) calls the live gateway, which isn't available in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fanout } from '../src/pipeline/fanout.ts';

test("mode 'all' calls every matching agent and audits each success", async () => {
  const r = await fanout({
    skill: 'summarize',
    inputs: { text: 'one two three four five six seven.' },
    mode: 'all',
    tries: 2,
    latencyScale: 0,
  });

  assert.equal(r.mode, 'all');
  assert.ok(r.results.length + r.failures.length >= 1, 'expected at least one agent to be called');
  // audit has exactly one entry per successful result
  assert.equal(r.audit.length, r.results.length);
  for (const res of r.results) {
    assert.equal(typeof res.meta.handle, 'string');
    assert.equal(typeof res.meta.latencyMs, 'number');
    assert.equal(typeof res.meta.costUsd, 'number');
  }
  // every settled handle has a recorded attempt count
  for (const res of r.results) {
    assert.ok((r.attemptsByHandle[res.meta.handle] ?? 0) >= 1);
  }
});

test("mode 'race' resolves to a single winner", async () => {
  const r = await fanout({
    skill: 'summarize',
    inputs: { text: 'alpha beta gamma delta.' },
    mode: 'race',
    tries: 2,
    latencyScale: 0,
  });

  assert.equal(r.mode, 'race');
  assert.equal(r.results.length, 1, 'race should surface exactly one result');
  assert.equal(r.verdict, undefined, 'race has no judge verdict');
});

test("mode 'quorum' returns at least the requested number of successes", async () => {
  const r = await fanout({
    skill: 'summarize',
    inputs: { text: 'a b c d e.' },
    mode: 'quorum',
    quorum: 2,
    tries: 2,
    latencyScale: 0,
  });

  assert.equal(r.mode, 'quorum');
  assert.ok(r.results.length >= 2, 'quorum:2 should resolve with at least two successes');
});

test('an empty discovery yields no results rather than throwing', async () => {
  const r = await fanout({
    skill: 'totally-unknown-skill',
    inputs: { text: 'x' },
    mode: 'all',
    latencyScale: 0,
  });
  assert.equal(r.results.length, 0);
  assert.equal(r.failures.length, 0);
});
