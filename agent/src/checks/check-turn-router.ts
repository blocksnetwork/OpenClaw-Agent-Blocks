/**
 * Routing Phase 3 offline gate — the ONE turn classifier (src/routing/turn-router.ts).
 *
 * `classifyTurn` is the single authority the chat surface now defers to over
 * `POST /api/classify` instead of running its own `looksPersonalAssistant` /
 * `looksRoutable` regexes. This locks the contract that the client depends on:
 *   1. Each path (assistant / specialist / gateway) is selected for the right
 *      kinds of turns — a behaviour battery the demo relies on.
 *   2. Precedence is fixed: when a turn looks like BOTH an owner action and a
 *      catalog lookup, the assistant wins (it owns the owner's world).
 *   3. Empty / junk input degrades to the gateway, never throws.
 *
 *   npm run check:turn-router
 */

import { classifyTurn, type TurnRoute } from '../routing/turn-router.ts';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function expect(text: string, route: TurnRoute): void {
  const got = classifyTurn(text).route;
  assert(got === route, `"${text}" → expected ${route}, got ${got}`);
}

try {
  // 1. Assistant — owner actions on their own world + confirm/resume tokens.
  {
    expect("Who are you and what's my email and timezone?", 'assistant');
    expect('Make me a poster for our offsite called Driftwork.', 'assistant');
    expect("What's my availability tomorrow afternoon?", 'assistant');
    expect('Draft an email to the team about the launch.', 'assistant');
    expect("Book a 30 minute meeting with Sam on Friday.", 'assistant');
    expect("Ask Kayley's assistant if she's free Thursday.", 'assistant');
    expect('What is this image — give me a caption', 'assistant');
    expect('confirm_0123456789abcdef', 'assistant');
    console.log('▸ assistant: calendar / mail / poster / image / peer / confirm-token turns route to the PA ✓');
  }

  // 2. Specialist — a LinkedIn URL to analyze, or a catalog discovery question.
  {
    expect('Analyze the tone of https://linkedin.com/in/jane-doe', 'specialist');
    expect('What agents on Blocks can summarize a document?', 'specialist');
    expect('Find a translation agent in the catalog', 'specialist');
    expect('Show me the models on blocks.ai', 'specialist');
    expect('Use a random Blocks agent that looks cool', 'specialist');
    console.log('▸ specialist: LinkedIn analysis + "what agents on Blocks can…" discovery route to a specialist ✓');
  }

  // 3. Gateway — ordinary chat, including Blocks *mentions* that are not
  //    discovery questions (the "Summarize Blocks.ai" false-positive guard).
  {
    expect('Summarize Blocks.ai in three bullets.', 'gateway');
    expect('Give me three icebreakers for a remote team offsite', 'gateway');
    expect('Tell me a joke about debugging.', 'gateway');
    expect('Explain transformers like I am five.', 'gateway');
    console.log('▸ gateway: ordinary chat (incl. a bare "Blocks.ai" mention) falls through to the gateway ✓');
  }

  // 4. Precedence — an owner action that also mentions the catalog is still an
  //    assistant turn. The assistant owns the owner's world; the catalog gate
  //    must not steal it.
  {
    expect('What calendar agents are on Blocks?', 'assistant');
    const c = classifyTurn('book a meeting using a Blocks agent');
    assert(c.route === 'assistant', `assistant must win over specialist, got ${c.route}`);
    console.log('▸ precedence: assistant beats specialist when a turn matches both ✓');
  }

  // 5. Degrades, never throws.
  {
    expect('', 'gateway');
    // @ts-expect-error — guard the runtime path the client can hit (null text).
    assert(classifyTurn(null).route === 'gateway', 'null text must degrade to gateway');
    console.log('▸ robustness: empty / null input degrades to the gateway without throwing ✓');
  }

  console.log('\naudit: one authoritative gate; precedence assistant > specialist > gateway, fully offline');
  console.log('✅ turn-router check passed');
} catch (err) {
  console.error(`❌ turn-router check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
