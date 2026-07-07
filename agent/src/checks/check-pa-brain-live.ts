/**
 * Offline-safe gate for the opt-in live personal_assistant brain wrapper.
 *
 * With PA_BRAIN_LIVE unset, this is a no-op. With PA_BRAIN_LIVE=1, it
 * exercises the live-first wrapper using an injected skill runner, proving
 * gateway failures and malformed live envelopes fall back to the offline
 * deterministic brain without touching the network.
 *
 *   npm run check:pa-brain-live
 */

import { planRequest, type RunSkillImpl } from '../assistant/assistant-runtime.ts';
import { brainMaxCompletionTokens, trimSkillSpec } from '../blocks/openclaw-client.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

try {
  // Pillar 4.7 (always runs, no network): the live brain's output cap must
  // exceed the old 500 so a multi-step `steps[]` envelope can't truncate into
  // invalid JSON and silently fall back to the offline stub; and the restated
  // SKILL.md spec is bounded while keeping the output contract.
  assert(brainMaxCompletionTokens({} as NodeJS.ProcessEnv) > 500, `default brain token cap must exceed 500 so a multi-step envelope fits, got ${brainMaxCompletionTokens({} as NodeJS.ProcessEnv)}`);
  assert(brainMaxCompletionTokens({ PA_BRAIN_MAX_TOKENS: '2048' } as unknown as NodeJS.ProcessEnv) === 2048, 'brain token cap must be overridable via PA_BRAIN_MAX_TOKENS');
  assert(brainMaxCompletionTokens({ PA_BRAIN_MAX_TOKENS: 'not-a-number' } as unknown as NodeJS.ProcessEnv) > 500, 'a bad PA_BRAIN_MAX_TOKENS must fall back to the safe default');

  const bloated = `## Output contract\nReturn JSON only.\n${'x'.repeat(20_000)}\nExamples:\nfoo`;
  const trimmed = trimSkillSpec(bloated, 12_000);
  assert(trimmed.length <= 12_300, `a bloated spec must be bounded, got ${trimmed.length}`);
  assert(trimmed.includes('Output contract'), 'trimming must preserve the authoritative output contract');
  assert(trimSkillSpec('a small spec body') === 'a small spec body', 'a small spec is restated unchanged (examples kept)');
  console.log('▸ live-output guard: token cap > 500 (env-overridable) + bounded spec that keeps the contract ✓');

  // Pillar 4.6 (always runs, no network): a well-formed LIVE multi-step
  // `steps[]` envelope must be PRESERVED — not diffed as "needs repair" and
  // silently swapped for the offline stub. This guards the exact rot the 4.7
  // paired fix closed: the wrapper must accept a real multi-step live plan.
  const liveStepCalls: Array<{ offline?: boolean }> = [];
  const liveMultiStep: RunSkillImpl = async (_skill, _inputs, opts) => {
    liveStepCalls.push({ offline: opts?.offline });
    return {
      ok: true,
      reply: 'I\'ll draft the brief, then ask Kayley to discuss it.',
      steps: [
        { id: 'step1', kind: 'call-specialist', tag: 'summarize', prompt: 'Write a one-page brief.' },
        { id: 'step2', kind: 'call-peer', personRef: 'Kayley', intent: 'discuss {{step1}}' },
      ],
    };
  };
  const livePlan = await planRequest(
    { request: 'Write a brief, then book with Kayley to discuss it.' },
    { offline: false, live: true, runSkillImpl: liveMultiStep },
  );
  assert(livePlan.steps.length === 2, `a clean live steps[] plan must be preserved, got ${JSON.stringify(livePlan.steps)}`);
  assert(livePlan.steps[0].kind === 'call-specialist' && livePlan.steps[1].kind === 'call-peer', 'live plan step kinds + order must survive intact');
  assert(
    liveStepCalls.length === 1 && liveStepCalls[0].offline === false,
    `a valid live steps[] plan must NOT fall back to the offline stub, got ${JSON.stringify(liveStepCalls)}`,
  );
  console.log('▸ live steps[]: a well-formed multi-step live plan is preserved (no silent offline fallback) ✓');

  if (process.env.PA_BRAIN_LIVE !== '1') {
    console.log('skipped (PA_BRAIN_LIVE!=1)');
  } else {
    const calls: Array<{ offline?: boolean }> = [];
    const throwingGateway: RunSkillImpl = async (_skill, inputs, opts) => {
      calls.push({ offline: opts?.offline });
      if (opts?.offline === false) throw new Error('simulated gateway outage');
      return {
        ok: true,
        reply: `fallback planned: ${String(inputs.request ?? '')}`,
        actions: [{ kind: 'answer-direct' }],
      };
    };

    const fallback = await planRequest(
      { request: 'What is the capital of France?' },
      { offline: false, live: true, runSkillImpl: throwingGateway },
    );
    assert(fallback.ok === true, `fallback plan must be ok, got ${JSON.stringify(fallback)}`);
    assert(fallback.reply.includes('fallback planned'), `fallback reply must come from offline stub, got ${fallback.reply}`);
    assert(
      calls.length === 2 && calls[0].offline === false && calls[1].offline === true,
      `expected live call then offline fallback, got ${JSON.stringify(calls)}`,
    );

    const malformedCalls: Array<{ offline?: boolean }> = [];
    const malformedGateway: RunSkillImpl = async (_skill, _inputs, opts) => {
      malformedCalls.push({ offline: opts?.offline });
      if (opts?.offline === false) return { ok: true, reply: '', actions: [] };
      return { ok: true, reply: 'recovered from malformed live envelope', actions: [{ kind: 'answer-direct' }] };
    };
    const recovered = await planRequest(
      { request: 'Summarize this.' },
      { offline: false, live: true, runSkillImpl: malformedGateway },
    );
    assert(recovered.reply === 'recovered from malformed live envelope', 'malformed live envelope must fall back');
    assert(
      malformedCalls.length === 2 && malformedCalls[0].offline === false && malformedCalls[1].offline === true,
      `expected malformed live call then offline fallback, got ${JSON.stringify(malformedCalls)}`,
    );

    console.log('audit: PA_BRAIN_LIVE live-first wrapper falls back on gateway error + malformed envelope');
    console.log('✅ pa-brain-live check passed');
  }
} catch (err) {
  console.error(`❌ pa-brain-live check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
