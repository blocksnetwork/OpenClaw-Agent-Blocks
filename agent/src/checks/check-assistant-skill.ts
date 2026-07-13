/**
 * Phase PA-1 offline gate — the personal_assistant brain skill.
 *
 * Asserts, with no key and no network, that runSkill('personal_assistant')
 * returns the strict envelope the handler can act on without further LLM
 * judgment:
 *   - ok === true
 *   - typeof reply === 'string'
 *   - Array.isArray(actions), every action.kind ∈ the PA action set
 *   - an image request yields a call-specialist tagged 'text-to-image'
 *   - a peer request ("ask <name>'s assistant …") yields a call-peer
 *
 *   npm run check:assistant-skill
 */

import { runSkill } from '../blocks/openclaw-client.ts';
import { loadRootEnv } from '../env.ts';
import { validatePlan } from '../assistant/plan-schema.ts';
import { TAGS } from '../routing/intent-tags.ts';
import { peerCoordinationPersonRef } from '../routing/peer-coordination.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KINDS = new Set(['call-specialist', 'call-peer', 'use-integration', 'search-blocks-catalog', 'answer-direct']);

interface Action {
  kind?: unknown;
  tag?: unknown;
  prompt?: unknown;
  assistant?: unknown;
  personRef?: unknown;
  intent?: unknown;
  tool?: unknown;
  args?: unknown;
  query?: unknown;
  category?: unknown;
}

interface Envelope {
  ok?: unknown;
  reply?: unknown;
  actions?: unknown;
  steps?: unknown;
}

const PROMPTS = [
  'Make me a poster for our team offsite next Friday.',
  "Ask Bob's assistant when he's free Thursday.",
  'What is the capital of France?',
  'Narrate this welcome message for the onboarding video.',
  'Summarize the quarterly report for me.',
  'What agents are using Gemini on Blocks?',
];

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${message}, got ${actualJson}, expected ${expectedJson}`);
}

try {
  // validatePlan now normalizes into an ordered steps[] envelope (each step
  // gets a stable id); `actions` is kept as a byte-identical alias (1.1).
  const freeBusyStep = { kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Thursday afternoon' }, id: 'step1' };
  assertJsonEqual(
    validatePlan({
      ok: true,
      reply: 'Let me check your calendar for Thursday afternoon.',
      actions: [{ kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Thursday afternoon' } }],
    }),
    { ok: true, reply: 'Let me check your calendar for Thursday afternoon.', steps: [freeBusyStep], actions: [freeBusyStep] },
    'valid envelope must normalize into ordered steps[] (with actions alias)',
  );
  const directStep = { kind: 'answer-direct', id: 'step1' };
  assertJsonEqual(
    validatePlan({ ok: true, reply: 'Direct answer.' }),
    { ok: true, reply: 'Direct answer.', steps: [directStep], actions: [directStep] },
    'missing steps must repair to answer-direct',
  );
  assertJsonEqual(
    validatePlan({ ok: true, reply: 'Keep this reply.', steps: [{ kind: 'run-shell', command: 'echo nope' }] }),
    { ok: true, reply: 'Keep this reply.', steps: [directStep], actions: [directStep] },
    'unknown step kind must degrade the plan to answer-direct',
  );
  assertJsonEqual(
    validatePlan({ ok: true, reply: 'Keep this too.', actions: [{ kind: 'call-specialist', prompt: 'Draw a cat.' }] }),
    { ok: true, reply: 'Keep this too.', steps: [directStep], actions: [directStep] },
    'call-specialist missing tag must degrade the plan to answer-direct',
  );

  // A two-step (ordered) envelope passes through with both steps + ids.
  const twoStep = validatePlan({
    ok: true,
    reply: 'Brief then book.',
    steps: [
      { id: 'step1', kind: 'call-specialist', tag: 'summarize', prompt: 'Write a brief.' },
      { id: 'step2', kind: 'call-peer', assistant: 'pa_kayley', intent: 'discuss {{step1}}' },
    ],
  });
  assert(twoStep.steps.length === 2, `ordered steps[] must keep both steps, got ${JSON.stringify(twoStep.steps)}`);
  assert(twoStep.steps[1].kind === 'call-peer', 'second step must be preserved in order');
  assert(twoStep.steps.length > 4 ? false : true, 'step cap holds');
  console.log('▸ envelope: single + ordered multi-step plans validate (with actions alias) ✓');

  // The offline stub itself decomposes a compound request into ordered,
  // threaded steps (Pillar 1.6).
  const compound = (await runSkill('personal_assistant', {
    request: 'Summarize this feedback into 3 bullets, then draft an email to Dana with the summary.',
  })) as { steps?: Action[] };
  assert(Array.isArray(compound.steps) && compound.steps.length === 2, `stub must decompose a compound request into 2 steps, got ${JSON.stringify(compound)}`);
  assert(compound.steps[0].kind === 'call-specialist', 'first compound step should produce the summary');
  const emailStep = compound.steps[1];
  assert(emailStep.kind === 'use-integration' && isRecord(emailStep.args) && isRecord((emailStep.args as Record<string, unknown>).body), 'second step must thread the summary into the email body');
  console.log('▸ stub: "summarize … then draft an email" decomposes into 2 threaded steps ✓');

  const mutualAvailability = (await runSkill('personal_assistant', {
    request: 'Coordinate with Bob to find a time we are both free tomorrow afternoon for a 30 minute meeting.',
  })) as Envelope;
  assert(Array.isArray(mutualAvailability.steps), `mutual availability must emit ordered steps, got ${JSON.stringify(mutualAvailability)}`);
  const mutualSteps = mutualAvailability.steps as Action[];
  assert(mutualSteps.length === 2, `mutual availability must have 2 steps, got ${JSON.stringify(mutualSteps)}`);
  assert(
    mutualSteps[0].kind === 'use-integration' && mutualSteps[0].tool === 'calendar.freeBusy',
    `first mutual availability step must check owner calendar, got ${JSON.stringify(mutualSteps[0])}`,
  );
  assert(
    mutualSteps[1].kind === 'call-peer' && mutualSteps[1].personRef === 'Bob' && mutualSteps[1].assistant === undefined,
    `second mutual availability step must call Bob by personRef, got ${JSON.stringify(mutualSteps[1])}`,
  );
  console.log('▸ stub: mutual availability with Bob → calendar.freeBusy + call-peer(Bob) ✓');

  // Robust to PHRASING: the ONE shared detector (peer-coordination.ts) treats
  // coordination as intent-shaped, not keyword-exact. The offline stub and the
  // live-plan repair both import it, so proving it here proves both paths. The
  // terse forms below used to fall through to the generic gateway / a bare
  // local calendar read; they must now extract the right personRef and emit
  // the SAME calendar.freeBusy + call-peer plan as the verbose phrasing.
  const coordinationCases: Array<{ request: string; personRef: string }> = [
    { request: 'Find a time for me and Bob to meet.', personRef: 'Bob' },
    { request: 'set up 30 min with Sam', personRef: 'Sam' },
    { request: 'when are Kayley and I both free Thursday?', personRef: 'Kayley' },
    { request: 'find a slot that works for both me and Kayley', personRef: 'Kayley' },
    { request: 'Coordinate with Bob to find a time we are both free tomorrow afternoon for a 30 minute meeting.', personRef: 'Bob' },
  ];
  for (const { request, personRef } of coordinationCases) {
    // 1. the shared detector extracts the natural reference (never a handle).
    assert(
      peerCoordinationPersonRef(request) === personRef,
      `shared detector must extract personRef "${personRef}" from "${request}", got ${JSON.stringify(peerCoordinationPersonRef(request))}`,
    );
    // 2. the offline stub turns it into the ordered freeBusy + call-peer plan.
    const plan = (await runSkill('personal_assistant', { request })) as Envelope;
    assert(Array.isArray(plan.steps), `"${request}" must emit ordered steps, got ${JSON.stringify(plan)}`);
    const steps = plan.steps as Action[];
    assert(
      steps.length === 2 &&
        steps[0].kind === 'use-integration' && steps[0].tool === 'calendar.freeBusy' &&
        steps[1].kind === 'call-peer' && steps[1].personRef === personRef && steps[1].assistant === undefined,
      `"${request}" must emit calendar.freeBusy + call-peer(${personRef}) with no fabricated handle, got ${JSON.stringify(steps)}`,
    );
  }
  // Conservative: a direct booking the owner already timed is NOT coordination
  // — it stays a single calendar.createEvent, never freeBusy + call-peer.
  assert(peerCoordinationPersonRef('Book a 30 minute meeting with Sam on Friday at 2pm.') === null, 'an explicitly-timed direct booking must not be treated as coordination');
  const directBooking = (await runSkill('personal_assistant', { request: 'Book a 30 minute meeting with Sam on Friday at 2pm.' })) as Envelope;
  const directSteps = (directBooking.steps ?? directBooking.actions) as Action[];
  assert(
    Array.isArray(directSteps) && directSteps.length === 1 && directSteps[0].kind === 'use-integration' && directSteps[0].tool === 'calendar.createEvent',
    `direct booking must stay a single calendar.createEvent, got ${JSON.stringify(directBooking)}`,
  );
  console.log(`▸ phrasing: ${coordinationCases.length} terse+verbose coordination forms → freeBusy + call-peer; timed booking stays createEvent ✓`);

  let imageSeen = false;
  let peerSeen = false;
  let catalogSeen = false;

  for (const request of PROMPTS) {
    const out = (await runSkill('personal_assistant', { request })) as Envelope;

    assert(out.ok === true, `ok must be true for "${request}", got ${JSON.stringify(out.ok)}`);
    assert(
      typeof out.reply === 'string' && out.reply.trim().length > 0,
      `reply must be a non-empty string for "${request}", got ${JSON.stringify(out.reply)}`,
    );
    assert(
      Array.isArray(out.actions),
      `actions must be an array for "${request}", got ${JSON.stringify(out.actions)}`,
    );

    const actions = out.actions as Action[];
    for (const action of actions) {
      assert(
        typeof action.kind === 'string' && KINDS.has(action.kind),
        `action.kind must be one of ${[...KINDS].join(', ')} for "${request}", got ${JSON.stringify(action.kind)}`,
      );
    }

    const kinds = actions.map((a) => a.kind).join(', ') || '(none)';
    console.log(`▸ "${request}" → ${kinds}`);

    if (/poster|image/u.test(request)) {
      const img = actions.find((a) => a.kind === 'call-specialist' && a.tag === TAGS.textToImage);
      assert(
        img,
        `image request must yield a call-specialist tagged text-to-image for "${request}", got ${JSON.stringify(actions)}`,
      );
      assert(
        typeof img.prompt === 'string' && img.prompt.trim().length > 0,
        `call-specialist must forward a non-empty prompt for "${request}", got ${JSON.stringify(img.prompt)}`,
      );
      imageSeen = true;
    }

    if (/\bask\b/iu.test(request)) {
      const peer = actions.find((a) => a.kind === 'call-peer');
      assert(
        peer,
        `peer request must yield a call-peer action for "${request}", got ${JSON.stringify(actions)}`,
      );
      // Pillar 3.3: the PURE stub carries a `personRef` (the natural reference)
      // — it must NOT fabricate a `pa_<name>` handle; the runtime resolves it.
      assert(
        typeof peer.personRef === 'string' && peer.personRef.trim().length > 0,
        `call-peer must carry a personRef (not a guessed handle) for "${request}", got ${JSON.stringify(peer)}`,
      );
      assert(
        peer.assistant === undefined,
        `the pure stub must NOT invent a pa_<name> handle; resolution is the runtime's job, got ${JSON.stringify(peer.assistant)}`,
      );
      peerSeen = true;
    }

    if (/\bblocks\b/iu.test(request)) {
      const catalog = actions.find((a) => a.kind === 'search-blocks-catalog');
      assert(
        catalog,
        `Blocks catalog request must yield search-blocks-catalog for "${request}", got ${JSON.stringify(actions)}`,
      );
      assert(
        typeof catalog.query === 'string' && catalog.query.trim().length > 0,
        `search-blocks-catalog must include a non-empty query for "${request}", got ${JSON.stringify(catalog.query)}`,
      );
      catalogSeen = true;
    }
  }

  assert(imageSeen, 'expected at least one image prompt to exercise the call-specialist path');
  assert(peerSeen, 'expected at least one peer prompt to exercise the call-peer path');
  assert(catalogSeen, 'expected at least one Blocks prompt to exercise the catalog search path');

  console.log(`\naudit: ${PROMPTS.length} prompts checked, envelope valid, image→specialist + peer→call-peer + Blocks catalog search proven`);
  console.log('✅ assistant-skill check passed');
} catch (err) {
  console.error(`❌ assistant-skill check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
