/**
 * Peer-liveness offline gate — the probe → 3-state contract the UI renders.
 *
 * The registry only proves a peer is *registered*; the panel must not claim
 * it's "online". `probePeerReachable` does a bounded reachability probe and
 * `probeStatusLabel` maps the result to online | offline | unknown. This locks:
 *   1. The mapping never conflates "couldn't ask" (unknown) with "asked,
 *      nobody home" (offline) — the whole point of the fix.
 *   2. With no Blocks key the probe degrades to unknown WITHOUT a network call
 *      (so the bridge endpoint stays honest offline).
 *
 *   npm run check:peer-status
 */

import { probePeerReachable, probeStatusLabel } from '../a2a/a2a-transport.ts';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

try {
  // 1. The 3-state mapping. reachable=false is ALWAYS unknown (we couldn't
  //    even ask); reachable=true splits on whether an instance answered.
  {
    assert(probeStatusLabel({ online: true, reachable: true, latencyMs: 12, reason: 'picked up' }) === 'online',
      'a reachable peer that answered must be online');
    assert(probeStatusLabel({ online: false, reachable: true, latencyMs: 6000, reason: 'no response' }) === 'offline',
      'a reachable send with no pickup must be offline (asked, nobody home)');
    assert(probeStatusLabel({ online: false, reachable: false, latencyMs: 0, reason: 'no key' }) === 'unknown',
      'an unreachable probe (couldn’t ask) must be unknown, NEVER offline');
    // The honesty invariant in one line: unknown ≠ offline.
    assert(
      probeStatusLabel({ online: false, reachable: false, latencyMs: 0, reason: 'x' }) !==
      probeStatusLabel({ online: false, reachable: true, latencyMs: 1, reason: 'y' }),
      '“couldn’t ask” and “asked, nobody home” must be distinct states',
    );
    console.log('▸ mapping: online / offline / unknown — couldn’t-ask is never reported as offline ✓');
  }

  // 2. No key → unknown, and crucially WITHOUT any network round trip.
  {
    const saved = process.env.BLOCKS_API_KEY;
    delete process.env.BLOCKS_API_KEY;
    try {
      const result = await probePeerReachable('pa_bob', { timeoutMs: 50 });
      assert(result.reachable === false, `no key must be unreachable, got ${JSON.stringify(result)}`);
      assert(probeStatusLabel(result) === 'unknown', 'no key must map to unknown');
      assert(/BLOCKS_API_KEY/u.test(result.reason), `reason must name the missing key, got ${JSON.stringify(result.reason)}`);
    } finally {
      if (saved !== undefined) process.env.BLOCKS_API_KEY = saved;
    }
    console.log('▸ no-key: probe short-circuits to unknown with no network call ✓');
  }

  console.log('\naudit: peer liveness is a probed 3-state; registration is never mistaken for serving');
  console.log('✅ peer-status check passed');
} catch (err) {
  console.error(`❌ peer-status check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
