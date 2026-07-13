/**
 * §6 offline gate — the model-assisted intent classifier (src/routing/classify.ts).
 *
 * Proves, with no key and no network, the reliability contract that makes the
 * one classifier safe to put in the hot path:
 *
 *   1. `validateClassification` rejects out-of-taxonomy route/intent/tag and
 *      repairs the safely-fixable (wrong-but-valid route/tag, a leaked `pa_`
 *      handle, stray slot keys, out-of-range confidence).
 *   2. A STUBBED model response drives `classifyRequest`, and when it is
 *      invalid / low-confidence / times out / errors, the DETERMINISTIC mirror
 *      wins — never a silent gateway drop, never a fabricated route.
 *   3. The obvious shortcuts (confirm token / selected agent / attached media)
 *      bypass the model entirely (the injected runner is never called).
 *   4. The deterministic mirror labels a phrasing-variety battery with the right
 *      canonical intent, and its route is ALWAYS identical to `classifyTurn`.
 *
 *   npm run check:classifier
 */

import { loadRootEnv } from '../env.ts';
import { classifyTurn } from '../routing/turn-router.ts';
import { INTENTS, INTENT_IDS, ROUTES, intentRoute, isIntentId } from '../routing/intent-tags.ts';
import {
  classifyRequest,
  deterministicClassify,
  validateClassification,
  type ClassifyContext,
  type RunSkillLike,
} from '../routing/classify.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** A model runner stub that records its call count and returns/throws/delays a
 *  configured response, so the check can prove the model path deterministically. */
interface StubRunner {
  run: RunSkillLike;
  calls: number;
}

function stubRunner(behavior: () => Promise<unknown>): StubRunner {
  const stub: StubRunner = {
    calls: 0,
    run: async (skill: string) => {
      stub.calls += 1;
      assert(skill === 'intent_classify', `classifier must call the intent_classify skill, got "${skill}"`);
      return behavior();
    },
  };
  return stub;
}

const LIVE: Parameters<typeof classifyRequest>[2] = { offline: false, live: true, budgetMs: 200 };

try {
  /* ── 1. validateClassification ─────────────────────────────────────────── */
  {
    // Canonical, valid: no repair.
    const ok = validateClassification({ route: 'assistant', intent: 'create-image', tag: 'text-to-image', confidence: 0.9 });
    assert(ok && !ok.repaired, 'a canonical classification must validate without repair');
    assert(ok.value.route === 'assistant' && ok.value.intent === 'create-image' && ok.value.tag === 'text-to-image', 'canonical value must pass through unchanged');

    // Out-of-taxonomy → rejected (null).
    assert(validateClassification({ route: 'assistant', intent: 'frobnicate', confidence: 1 }) === null, 'an unknown intent id must be rejected');
    assert(validateClassification({ route: 'banana', intent: 'chat', confidence: 1 }) === null, 'an unknown route string must be rejected');
    assert(validateClassification({ route: 'assistant', intent: 'create-image', tag: 'not-a-tag', confidence: 1 }) === null, 'an unknown capability tag must be rejected');
    assert(validateClassification('nope') === null, 'a non-object must be rejected');
    assert(validateClassification({ confidence: 1 }) === null, 'a missing intent must be rejected');

    // Mismatched-but-valid route → repaired to the intent's canonical route.
    const wrongRoute = validateClassification({ route: 'gateway', intent: 'create-image', confidence: 1 });
    assert(wrongRoute && wrongRoute.repaired && wrongRoute.value.route === 'assistant', 'a valid-but-wrong route must be repaired to the canonical route');

    // Mismatched-but-valid tag → repaired to the intent's canonical tag.
    const wrongTag = validateClassification({ route: 'assistant', intent: 'create-image', tag: 'summarize', confidence: 1 });
    assert(wrongTag && wrongTag.repaired && wrongTag.value.tag === 'text-to-image', 'a valid-but-wrong tag must be repaired to the canonical tag');

    // A tag on a tag-less intent → dropped (repaired).
    const strayTag = validateClassification({ route: 'gateway', intent: 'chat', tag: 'summarize', confidence: 1 });
    assert(strayTag && strayTag.repaired && strayTag.value.tag === undefined, 'a tag on a tag-less intent must be dropped');

    // A leaked resolved handle → dropped; the classifier only carries names.
    const leaked = validateClassification({ route: 'assistant', intent: 'coordinate-meeting', personRef: 'pa_bob', confidence: 1 });
    assert(leaked && leaked.repaired && leaked.value.personRef === undefined, 'a pa_ handle must never survive validation');
    const natural = validateClassification({ route: 'assistant', intent: 'coordinate-meeting', personRef: 'Bob', confidence: 1 });
    assert(natural && natural.value.personRef === 'Bob', 'a natural personRef must survive validation');

    // Stray slot keys dropped; known ones kept.
    const slots = validateClassification({ route: 'assistant', intent: 'book-event', slots: { dateTime: '2pm', bogus: 'x' }, confidence: 1 });
    assert(slots && slots.repaired && slots.value.slots?.dateTime === '2pm' && !(slots.value.slots as Record<string, unknown>).bogus, 'unknown slot keys must be dropped, known ones kept');

    // Missing/invalid confidence → treated as low (0) + flagged repaired.
    const noConf = validateClassification({ route: 'gateway', intent: 'chat' });
    assert(noConf && noConf.repaired && noConf.value.confidence === 0, 'a missing confidence must default low');
    console.log('▸ validate: out-of-taxonomy rejected; wrong route/tag, pa_ handle, stray slots, bad confidence repaired ✓');
  }

  /* ── 2. classifyRequest: model wins when valid+confident ───────────────── */
  {
    // Deterministic routes this ordinary text to the gateway; a confident model
    // says it is actually peer coordination → the validated model result wins.
    const text = 'link me up with bob sometime';
    assert(classifyTurn(text).route === 'gateway', 'precondition: this phrasing is a deterministic gateway turn');
    const runner = stubRunner(async () => ({ route: 'assistant', intent: 'coordinate-meeting', personRef: 'bob', confidence: 0.95 }));
    const res = await classifyRequest(text, {}, { ...LIVE, runSkillImpl: runner.run });
    assert(res.source === 'model', `a valid confident model result must win, got source=${res.source}`);
    assert(res.route === 'assistant' && res.intent === 'coordinate-meeting' && res.personRef === 'bob', `model routing must be applied, got ${JSON.stringify(res)}`);
    assert(runner.calls === 1, 'the model must have been consulted exactly once');
    console.log('▸ model: a valid, confident model result overrides the deterministic route ✓');
  }

  /* ── 3. classifyRequest: deterministic wins on invalid/low-conf/timeout/err ─ */
  {
    // A turn the deterministic mirror routes to the assistant — the model
    // failures below must NEVER downgrade it to the gateway or fabricate a route.
    const text = 'Book a 30 minute meeting with Sam on Friday at 2pm.';
    const deterministic = deterministicClassify(text);
    assert(deterministic.route === 'assistant', 'precondition: this booking is a deterministic assistant turn');

    // (a) invalid (out-of-taxonomy) model output → deterministic wins.
    const invalid = stubRunner(async () => ({ route: 'gateway', intent: 'totally-made-up', confidence: 0.99 }));
    const r1 = await classifyRequest(text, {}, { ...LIVE, runSkillImpl: invalid.run });
    assert(r1.source === 'deterministic' && r1.route === 'assistant', `invalid model output must fall back to the assistant, got ${JSON.stringify(r1)}`);

    // (b) low-confidence (valid) model output → deterministic wins; the model's
    //     low-confidence gateway guess must NOT silently steal the turn.
    const lowConf = stubRunner(async () => ({ route: 'gateway', intent: 'chat', confidence: 0.1 }));
    const r2 = await classifyRequest(text, {}, { ...LIVE, runSkillImpl: lowConf.run });
    assert(r2.source === 'deterministic' && r2.route === 'assistant', `low-confidence model output must fall back, never a silent gateway drop, got ${JSON.stringify(r2)}`);

    // (c) timeout (exceeds the budget) → deterministic wins.
    const slow = stubRunner(() => new Promise((resolve) => setTimeout(() => resolve({ route: 'gateway', intent: 'chat', confidence: 0.99 }), 400)));
    const r3 = await classifyRequest(text, {}, { ...LIVE, budgetMs: 20, runSkillImpl: slow.run });
    assert(r3.source === 'deterministic' && r3.route === 'assistant', `a model that exceeds the budget must fall back, got ${JSON.stringify(r3)}`);

    // (d) thrown error → deterministic wins.
    const boom = stubRunner(async () => { throw new Error('gateway exploded'); });
    const r4 = await classifyRequest(text, {}, { ...LIVE, runSkillImpl: boom.run });
    assert(r4.source === 'deterministic' && r4.route === 'assistant', `a model error must fall back, got ${JSON.stringify(r4)}`);
    console.log('▸ fallback: invalid / low-confidence / timeout / error all degrade to the safe deterministic route (never gateway-by-default) ✓');
  }

  /* ── 4. shortcuts bypass the model entirely ────────────────────────────── */
  {
    const neverCalled = stubRunner(async () => { throw new Error('the model must not be called on a shortcut'); });

    // confirm/resume token.
    const confirm = await classifyRequest('confirm_0123456789abcdef', {}, { ...LIVE, runSkillImpl: neverCalled.run });
    assert(confirm.source === 'shortcut' && confirm.route === 'assistant', `a confirm token must shortcut to the assistant, got ${JSON.stringify(confirm)}`);

    // owner-selected Blocks agent.
    const selected = await classifyRequest('do the thing', { selectedBlocksAgent: 'openclaw_translator' } as ClassifyContext, { ...LIVE, runSkillImpl: neverCalled.run });
    assert(selected.source === 'shortcut' && selected.route === 'specialist' && selected.intent === 'use-specialist', `a selected agent must shortcut to use-specialist, got ${JSON.stringify(selected)}`);

    // attached media.
    const img = await classifyRequest('what is this', { hasAttachedImage: true } as ClassifyContext, { ...LIVE, runSkillImpl: neverCalled.run });
    assert(img.source === 'shortcut' && img.intent === 'describe-image' && img.tag === 'image-to-text', `an attached image must shortcut to describe-image, got ${JSON.stringify(img)}`);
    const audio = await classifyRequest('', { hasAttachedAudio: true } as ClassifyContext, { ...LIVE, runSkillImpl: neverCalled.run });
    assert(audio.source === 'shortcut' && audio.intent === 'transcribe-audio' && audio.tag === 'speech-to-text', `attached audio must shortcut to transcribe-audio, got ${JSON.stringify(audio)}`);

    assert(neverCalled.calls === 0, 'no shortcut may consult the model');
    console.log('▸ shortcuts: confirm token / selected agent / attached image+audio skip the model (0 model calls) ✓');
  }

  /* ── 5. taxonomy integrity + deterministic intent phrasing battery ─────── */
  {
    for (const def of INTENTS) {
      assert((ROUTES as readonly string[]).includes(def.route), `intent "${def.id}" has an unknown route "${def.route}"`);
      assert(intentRoute(def.id) === def.route, `intentRoute("${def.id}") must equal its route`);
    }

    const cases: Array<{ text: string; intent: string; context?: ClassifyContext }> = [
      { text: 'Generate a logo for my coffee shop.', intent: 'create-image' },
      { text: 'Draw a picture of a fox in the snow.', intent: 'create-image' },
      { text: 'What is this image? Give me a caption.', intent: 'describe-image' },
      { text: 'Read the text in this screenshot.', intent: 'describe-image' },
      { text: 'Describe this photo for me.', intent: 'describe-image' },
      { text: 'Find a time for me and Bob to meet next week.', intent: 'coordinate-meeting' },
      { text: 'set up 30 min with Sam', intent: 'coordinate-meeting' },
      { text: 'Am I free Thursday afternoon?', intent: 'check-availability' },
      { text: 'Book a 30 minute meeting with Sam on Friday at 2pm.', intent: 'book-event' },
      { text: 'Draft an email to the team about the launch.', intent: 'draft-email' },
      { text: 'Check my email for anything from Dana.', intent: 'read-email' },
      { text: "Who are you and what's my email address?", intent: 'identity' },
      { text: 'What agents on Blocks can summarize a document?', intent: 'catalog-discovery' },
      { text: 'Use a random Blocks agent that looks cool', intent: 'use-specialist' },
      { text: 'Analyze the tone of https://linkedin.com/in/jane-doe', intent: 'tone-analysis' },
      { text: 'Summarize Blocks.ai in three bullets.', intent: 'summarize' },
      { text: 'Tell me a joke about debugging.', intent: 'chat' },
    ];
    for (const { text, intent, context } of cases) {
      const c = deterministicClassify(text, context ?? {});
      assert(isIntentId(c.intent), `deterministic intent "${c.intent}" for "${text}" must be in the taxonomy`);
      assert(c.intent === intent, `"${text}" → expected intent ${intent}, got ${c.intent}`);
      // ROUTE parity with the authoritative gate is sacred (offline contract).
      assert(c.route === classifyTurn(text).route, `deterministic route for "${text}" must equal classifyTurn's route`);
      assert(intentRoute(c.intent) === c.route, `intent "${c.intent}" route must match its classification route for "${text}"`);
    }
    // coordinate-meeting must carry the natural personRef, never a handle.
    const coord = deterministicClassify('Find a time for me and Bob to meet next week.');
    assert(coord.personRef === 'Bob', `coordinate-meeting must carry personRef "Bob", got ${JSON.stringify(coord.personRef)}`);

    // Empty / null degrade to the gateway (chat), never throw.
    assert(deterministicClassify('').route === 'gateway', 'empty text must degrade to the gateway');
    // @ts-expect-error — guard the runtime path a client can hit (null text).
    assert(deterministicClassify(null).route === 'gateway', 'null text must degrade to the gateway');
    console.log(`▸ deterministic: ${cases.length} phrasings map to the right canonical intent; route == classifyTurn; empty/null → gateway ✓`);
  }

  console.log(`\naudit: closed taxonomy (${INTENT_IDS.length} intents), validated model with a budgeted deterministic-mirror fallback, shortcuts skip the model, offline parity preserved`);
  console.log('✅ classifier check passed');
} catch (err) {
  console.error(`❌ classifier check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
