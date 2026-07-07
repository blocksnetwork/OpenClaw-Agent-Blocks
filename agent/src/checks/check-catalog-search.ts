/**
 * Pillar 2.7 offline gate — real Blocks catalog search & categorization.
 *
 * Asserts, with no key and no network, over the mock catalog that catalog
 * search is real discovery, not substring filtering:
 *   1. Categorization into the CLOSED capability taxonomy (tags + description),
 *      multi-category agents, and an untagged agent → `other`.
 *   2. Whole-catalog scan walks every listing (scanned == totalCount), not a
 *      first page, and the categorize view covers all of them.
 *   3. Relevance RANKING: a capability query ranks the right agent first with a
 *      truthful "why it matched", and word-boundary scoring rejects the
 *      substring false positive ("art" must not match "Smart").
 *   4. Facets & honesty: a model query matches via the ONE exposed model facet;
 *      an UNexposed model returns an explicit not-exposed note — distinct from
 *      a genuine zero-match, and never an invented model.
 *   5. Caching: a TTL cache with single-flight (no duplicate concurrent fetch)
 *      plus a manual refresh.
 *   6. Pillar 1 wiring: a single search step emits `matched` + a threadable
 *      `recommend`, and a search → call-specialist plan threads the recommended
 *      handle into the follow-up step (2.6).
 *
 *   npm run check:catalog-search
 */

import type { StartTaskMessage } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';
import { runAssistant, type RunSkillImpl } from '../assistant/assistant-runtime.ts';
import { walkRegistryPages, type RegistryPage } from '../blocks/blocks-client.ts';
import {
  loadRuntimeCatalog,
  loadCatalogSnapshot,
  clearCatalogCache,
  searchCatalog,
  categorize,
  categorizeCatalog,
  detectModelFacet,
  type CatalogAgent,
  type CatalogCategory,
} from '../blocks/catalog-index.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(result: { artifacts?: Array<{ data?: unknown }> }): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected an artifact, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(parsed), `expected an object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function ownerTask(text: string, taskId: string): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId: 'alice-oid',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

function planner(plan: unknown): RunSkillImpl {
  return async (skill) => (skill === 'personal_assistant' ? plan : { ok: true });
}

function findAgent(agents: CatalogAgent[], handle: string): CatalogAgent {
  const found = agents.find((a) => a.handle === handle);
  assert(found, `mock catalog must include ${handle}`);
  return found;
}

function cats(agent: CatalogAgent): CatalogCategory[] {
  return categorize(agent);
}

try {
  clearCatalogCache();
  const snapshot = await loadRuntimeCatalog(true);
  const agents = snapshot.agents;
  assert(agents.length > 0, 'offline scan must return the mock catalog');

  // 1. Categorization into the closed taxonomy.
  {
    assert(cats(findAgent(agents, 'blk_transcribe_mock')).includes('audio-to-text'), 'transcriber → audio→text');
    assert(cats(findAgent(agents, 'blk_vision_mock')).includes('vision'), 'image describer → vision');
    assert(cats(findAgent(agents, 'blk_pixel_art')).includes('image'), 'pixel-art maker → image');
    assert(cats(findAgent(agents, 'blk_summarize_7c2')).includes('summarize'), 'summarizer → summarize');
    const echo = cats(findAgent(agents, 'blk_echo_001'));
    assert(echo.length === 1 && echo[0] === 'other', `echo (no capability tag, no matching description) → other, got ${JSON.stringify(echo)}`);
    console.log('▸ categorize: tags + description map agents into the closed capability taxonomy (echo → other) ✓');
  }

  // 2. Whole-catalog scan walks everything, and categorization covers it all.
  {
    assert(typeof snapshot.totalCount === 'number' && snapshot.totalCount === agents.length, `scan must report totalCount == catalog size, got scanned=${snapshot.scanned} total=${snapshot.totalCount} size=${agents.length}`);
    assert(snapshot.scanned === agents.length, `scanned must equal the whole catalog, got ${snapshot.scanned}`);
    assert(snapshot.truncated === false, 'the full offline scan must not be truncated');
    const buckets = categorizeCatalog(agents);
    const covered = new Set(buckets.flatMap((b) => b.handles));
    assert(covered.size === agents.length, `every agent must land in at least one category, covered ${covered.size}/${agents.length}`);
    assert(buckets.some((b) => b.category === 'audio-to-text') && buckets.some((b) => b.category === 'summarize'), 'category overview must list real categories');
    console.log(`▸ scan: walked the WHOLE catalog (${snapshot.scanned} of ${snapshot.totalCount}); categorize covers every agent ✓`);
  }

  // 2b. The cursor walker pulls EVERY page (the live "all agents on blocks.ai"
  //     path) — proven deterministically with a fake paginated registry.
  {
    const all = Array.from({ length: 23 }, (_, i) => `agent-${i}`);
    const pageSize = 5;
    let pageCalls = 0;
    const fetchPage = async (cursor: string | undefined): Promise<RegistryPage<string>> => {
      pageCalls += 1;
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + pageSize);
      const nextStart = start + pageSize;
      return { items, totalCount: all.length, next: nextStart < all.length ? String(nextStart) : undefined };
    };

    // Walk everything: all 23 across 5 pages, nothing dropped, not truncated.
    const full = await walkRegistryPages(fetchPage, { max: 1000 });
    assert(full.items.length === 23 && full.scanned === 23, `walker must pull every page (got ${full.items.length}/${full.scanned} of 23)`);
    assert(full.items[0] === 'agent-0' && full.items[22] === 'agent-22', 'walker must preserve order across pages');
    assert(full.totalCount === 23 && full.truncated === false, 'a complete walk must report totalCount and not truncated');
    assert(pageCalls === 5, `walker must request exactly the needed pages, got ${pageCalls}`);

    // Capped walk: stops at the cap and HONESTLY reports truncation.
    const capped = await walkRegistryPages(fetchPage, { max: 8 });
    assert(capped.items.length === 8, `cap must bound the result, got ${capped.items.length}`);
    assert(capped.truncated === true, 'hitting the cap with more available must report truncated');

    // Stuck/repeating cursor must terminate, not loop forever (the guard
    // breaks once the same cursor is seen again).
    const stuck = await walkRegistryPages(async () => ({ items: ['x'], next: 'same', totalCount: 99 }), { max: 1000 });
    assert(stuck.items.length === 2, `a repeating cursor must terminate quickly (got ${stuck.items.length})`);
    console.log('▸ pagination: cursor walker pulls every page, bounds + flags truncation, and survives a stuck cursor ✓');
  }

  // 3. Relevance ranking + word-boundary (no substring false positive).
  {
    const ranked = searchCatalog(agents, { query: 'transcribe audio' });
    assert(ranked.matched >= 1, 'a capability query must return matches');
    assert(ranked.results[0].agent.handle === 'blk_transcribe_mock', `transcriber must rank first, got ${ranked.results[0].agent.handle}`);
    assert(/transcribe|audio|speech/iu.test(ranked.results[0].whyMatched), `"why matched" must name the real signal, got ${JSON.stringify(ranked.results[0].whyMatched)}`);
    assert(ranked.recommendation?.agent.handle === 'blk_transcribe_mock', 'recommendation must be the top-ranked transcriber');

    // Word-boundary: "art" must NOT match a "Smart" agent (the substring bug).
    const smart: CatalogAgent = {
      handle: 'blk_smart_x', displayName: 'Smart Helper', provider: 'acme',
      description: 'a smart general assistant', tags: ['smart'],
      price: { amount: '0.000', currency: 'USD', unit: 'per_call' }, billingMode: 'free',
    };
    const falsePos = searchCatalog([smart], { query: 'art' });
    assert(falsePos.matched === 0, `"art" must not match "Smart" (substring false positive), got ${JSON.stringify(falsePos.results.map((r) => r.agent.handle))}`);
    // But a real "pixel-art" tag IS a legitimate match for "art".
    const realArt = searchCatalog(agents, { query: 'art' });
    assert(realArt.results.some((r) => r.agent.handle === 'blk_pixel_art'), 'pixel-art (real tag) must still match "art"');

    const genericList = searchCatalog(agents, { query: 'list some Blocks agents' });
    assert(genericList.matched === agents.length, `a generic list prompt must return a starter set, got ${genericList.matched}/${agents.length}`);
    console.log('▸ ranking: scored, field-weighted hits rank the right agent first with an honest reason; "art" ≠ "Smart" ✓');
  }

  // 4. Facets & honesty — the model case.
  {
    // (a) Model that IS exposed (one listing advertises gemini) → real match.
    assert(detectModelFacet('agents using gemini') === 'gemini', 'gemini must be detected as a model facet');
    const gemini = searchCatalog(agents, { query: 'agents using gemini' });
    assert(gemini.results.some((r) => r.agent.handle === 'blk_vision_mock'), 'a "using gemini" query must match the agent that advertises that model');
    assert(!gemini.facetNote, `a real model-facet match must not raise the not-exposed note, got ${JSON.stringify(gemini.facetNote)}`);

    // (b) Model that NO agent advertises → honest not-exposed note, distinct
    //     from a zero-match, never invented.
    const noModelUniverse = agents.filter((a) => !a.model);
    const gpt = searchCatalog(noModelUniverse, { query: 'agents using gpt-4' });
    assert(gpt.matched === 0, 'no agent should match an unexposed model in visible fields');
    assert(typeof gpt.facetNote === 'string' && /model/iu.test(gpt.facetNote), `unexposed model must yield an explicit not-exposed note, got ${JSON.stringify(gpt.facetNote)}`);
    assert(gpt.modelFacetUnavailable === true, 'with no model advertised anywhere, the facet is unavailable');

    // (c) A genuine zero-match is DIFFERENT: no facet note.
    const empty = searchCatalog(agents, { query: 'quantum blockchain notarizer' });
    assert(empty.matched === 0 && !empty.facetNote, `a genuine zero-match must NOT carry a facet note, got ${JSON.stringify(empty)}`);
    console.log('▸ honesty: exposed model → real match; unexposed model → explicit not-exposed note ≠ a plain zero-match ✓');
  }

  // 5. Caching: TTL + single-flight (no duplicate concurrent fetch) + refresh.
  {
    clearCatalogCache();
    const counter = { n: 0 };
    const fetched = () => counter.n;
    const fetcher = async () => {
      counter.n += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { agents: [], scanned: 1, totalCount: 1 };
    };
    // Concurrent cold loads coalesce into ONE fetch (no thundering herd).
    await Promise.all([
      loadCatalogSnapshot('k', fetcher),
      loadCatalogSnapshot('k', fetcher),
      loadCatalogSnapshot('k', fetcher),
    ]);
    assert(fetched() === 1, `single-flight must coalesce concurrent loads into one fetch, got ${fetched()}`);
    // A warm hit within the TTL does not refetch.
    await loadCatalogSnapshot('k', fetcher);
    assert(fetched() === 1, `a warm cache hit must not refetch, got ${fetched()}`);
    // Manual refresh forces exactly one new fetch.
    await loadCatalogSnapshot('k', fetcher, { refresh: true });
    assert(fetched() === 2, `manual refresh must refetch once, got ${fetched()}`);
    console.log('▸ cache: TTL hit + single-flight coalescing + manual refresh ✓');
  }

  // 6. Pillar 1 wiring — matched + threadable recommend + search → use it.
  {
    // Single search step emits matched + a threadable recommend.
    const single = payloadOf(await runAssistant(
      ownerTask('what agents transcribe audio?', 'cat-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { offline: true, runSkillImpl: planner({ ok: true, reply: 'searching', steps: [{ id: 'step1', kind: 'search-blocks-catalog', query: 'transcribe audio' }] }) },
    ));
    assert(typeof single.matched === 'number' && single.matched >= 1, `catalog step must emit matched, got ${JSON.stringify(single.matched)}`);
    assert(single.recommend === 'blk_transcribe_mock', `catalog step must expose a threadable recommend, got ${JSON.stringify(single.recommend)}`);
    assert(Array.isArray(single.agents) && single.agents.length >= 1, 'catalog step must expose ranked agents');

    // search → call-specialist: the recommended handle threads into step2.
    // step2 hires the echo agent, which echoes the threaded handle back, so we
    // can OBSERVE that step1's result fed step2 (2.6).
    const threaded = payloadOf(await runAssistant(
      ownerTask('find a transcriber then use it', 'cat-2'),
      undefined,
      { ownerId: 'alice-oid' },
      {
        offline: true,
        runSkillImpl: planner({
          ok: true,
          reply: 'find then use',
          steps: [
            { id: 'step1', kind: 'search-blocks-catalog', query: 'transcribe audio' },
            { id: 'step2', kind: 'call-specialist', tag: 'echo', prompt: 'chosen={{step1.recommend}}' },
          ],
        }),
      },
    ));
    assert(threaded.multiStep === true, `expected a multi-step result, got ${JSON.stringify(threaded)}`);
    assert(/blk_transcribe_mock/u.test(String(threaded.reply)), `step1's recommendation must thread into step2 (echoed back), got ${JSON.stringify(threaded.reply)}`);
    console.log('▸ wiring: catalog step emits matched + recommend; search → call-specialist threads the pick (2.6) ✓');
  }

  console.log('\naudit: real categorization + relevance ranking + facet honesty + caching + multi-step threading, all offline');
  console.log('✅ catalog-search check passed');
} catch (err) {
  console.error(`❌ catalog-search check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
