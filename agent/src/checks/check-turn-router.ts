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
    // Image-CREATION phrasings beyond the literal "poster"/"image" — the
    // canonical createsImage() matcher (intent-tags) drives this now, so
    // these no longer fall through to the gateway.
    expect('Generate a logo for my coffee shop.', 'assistant');
    expect('Draw a picture of a fox in the snow.', 'assistant');
    expect('Design an illustration for the cover.', 'assistant');
    console.log('▸ assistant: calendar / mail / image create+understand / peer / confirm-token turns route to the PA ✓');
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

  // 6. Peer-coordination phrasing variety — the intent-shaped fast-path
  //    (looksPeerCoordination) must route TERSE coordination forms to the PA,
  //    not just the verbose "coordinate/both free" vocabulary, because the
  //    difference is phrasing, not intent. It must stay CONSERVATIVE: ordinary
  //    chat that merely mentions time (no named peer to coordinate with) stays
  //    on the gateway.
  {
    // Terse forms that used to fall through to the gateway / answer-direct.
    expect('Find a time for me and bob to meet', 'assistant');
    expect('set up 30 min with Sam', 'assistant');
    expect('when are Kayley and I both free Thursday?', 'assistant');
    expect('find a slot that works for both me and Kayley', 'assistant');
    expect('time to meet with Dana next week', 'assistant');
    // The verbose form still routes to the PA (regression guard).
    expect('Coordinate with Bob to find a time we are both free tomorrow afternoon for a 30 minute meeting.', 'assistant');
    // Negatives — ordinary chat that mentions time but names no peer to
    // coordinate with must stay on the gateway (don't over-match).
    expect('what time is it in Tokyo?', 'gateway');
    expect('set a 10 minute timer', 'gateway');
    expect('what a great time we had at the party', 'gateway');
    console.log('▸ phrasing: terse + verbose coordination reach the PA; bare time-mentions stay on the gateway ✓');
  }

  // 7. Phrasing-variety battery — MANY wordings per intent must land on the
  //    same route. This is the durable-fix contract of §6: routing generalizes
  //    over vocabulary instead of enumerating it, so a new way to say the same
  //    thing does not silently fall through to the gateway.
  {
    const battery: Array<{ route: TurnRoute; phrasings: string[] }> = [
      {
        route: 'assistant', // create an image (text-to-image)
        phrasings: [
          'Make me a poster for the launch.',
          'Generate a logo for my coffee shop.',
          'Draw a picture of a fox in the snow.',
          'Design an illustration for the cover.',
          'Render an icon for the app.',
          'Paint a portrait of my dog.',
          'sketch a wallpaper of mountains',
        ],
      },
      {
        route: 'assistant', // understand an existing/attached image (image-to-text)
        phrasings: [
          'What is this image?',
          'Give me a caption for this photo.',
          'Describe this picture for me.',
          'Read the text in this screenshot.',
          'Can you identify what is in this pic?',
        ],
      },
      {
        route: 'assistant', // calendar / availability / mail / identity
        phrasings: [
          "What's my availability tomorrow afternoon?",
          'Am I free Thursday?',
          "What's on my calendar today?",
          'Book a 30 minute meeting with Sam on Friday.',
          'Draft an email to the team about the launch.',
          'Check my email for anything from Dana.',
          "Who are you and what's my email and timezone?",
        ],
      },
      {
        route: 'assistant', // peer coordination — terse and verbose
        phrasings: [
          'Find a time for me and bob to meet',
          'set up 30 min with Sam',
          'when are Kayley and I both free Thursday?',
          'find a slot that works for both me and Kayley',
          'time to meet with Dana next week',
          'Coordinate with Bob so we are both free tomorrow afternoon.',
        ],
      },
      {
        route: 'specialist', // catalog discovery + LinkedIn tone + random agent
        phrasings: [
          'What agents on Blocks can summarize a document?',
          'Find a translation agent in the catalog',
          'Which Blocks tools support Gemini?',
          'Show me the models on blocks.ai',
          'Use a random Blocks agent that looks cool',
          'Analyze the tone of https://linkedin.com/in/jane-doe',
        ],
      },
      {
        route: 'gateway', // ordinary chat, incl. the "Summarize Blocks.ai" trap
        phrasings: [
          'Summarize Blocks.ai in three bullets.',
          'Give me three icebreakers for a remote team offsite',
          'Tell me a joke about debugging.',
          'Explain transformers like I am five.',
          'What time is it in Tokyo?',
          'Write me a haiku about the ocean.',
        ],
      },
    ];

    let phrasingCount = 0;
    for (const { route, phrasings } of battery) {
      for (const text of phrasings) {
        expect(text, route);
        phrasingCount += 1;
      }
    }
    console.log(`▸ phrasing-variety: ${phrasingCount} wordings across image/calendar/peer/specialist/gateway all route correctly ✓`);
  }

  console.log('\naudit: one authoritative gate; precedence assistant > specialist > gateway, fully offline');
  console.log('✅ turn-router check passed');
} catch (err) {
  console.error(`❌ turn-router check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
