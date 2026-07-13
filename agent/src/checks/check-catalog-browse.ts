/**
 * Offline gate for the always-on "Browse all network agents" surface.
 *
 * The dashboard's new `GET /api/blocks/browse` route is backed by
 * `loadDashboardCatalog()` (the full registry walk + 60s cache) and the pure
 * `browseCatalog` helper. This check proves, with NO key and NO network, that
 * `browseCatalog` is an honest paginated window into the whole catalog rather
 * than a re-implementation that could drift:
 *
 *   1. Pagination: offset/limit slicing, clamped limits, stable ordering across
 *      pages (no overlap, no gaps, deterministic), and out-of-range offsets.
 *   2. Filtering: `tag` exact prefilter and `q` relevance ranking (shared
 *      pipeline), never leaking non-matches.
 *   3. Honesty: `scanned` / `totalCount` / `truncated` are passed through
 *      UNCHANGED so the panel can say "showing N of M" and flag truncation.
 *   4. Offline parity: the mock catalog flows through the same browse helper the
 *      live route uses, so CI/offline runs exercise the real code path.
 *
 *   npm run check:catalog-browse
 */

import { loadRootEnv } from '../env.ts';
import {
  browseCatalog,
  loadRuntimeCatalog,
  clearCatalogCache,
  BROWSE_DEFAULT_LIMIT,
  BROWSE_MAX_LIMIT,
  type CatalogAgent,
} from '../blocks/catalog-index.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function makeAgent(handle: string, opts: Partial<CatalogAgent> = {}): CatalogAgent {
  return {
    handle,
    displayName: opts.displayName ?? handle,
    provider: opts.provider ?? 'acme',
    description: opts.description ?? '',
    tags: opts.tags ?? [],
    price: opts.price ?? { amount: '0.000', currency: 'USD', unit: 'per_call' },
    billingMode: opts.billingMode ?? 'free',
    ...(opts.listing ? { listing: opts.listing } : {}),
  };
}

function handlesOf(agents: Record<string, unknown>[]): string[] {
  return agents.map((a) => String(a.handle));
}

try {
  // A deterministic synthetic universe: 120 zero-padded "browse-NNN" agents
  // (so the empty-query score→price→handle ordering is a clean numeric sort)
  // plus two taggable summarizers to exercise tag/q filtering.
  const browseAgents: CatalogAgent[] = [];
  for (let i = 0; i < 120; i += 1) {
    const handle = `browse-${String(i).padStart(3, '0')}`;
    browseAgents.push(makeAgent(handle, { displayName: `Browse Agent ${i}` }));
  }
  const summarizers: CatalogAgent[] = [
    makeAgent('summ-a', { displayName: 'Summarizer A', tags: ['summarize'], description: 'summarize long articles' }),
    makeAgent('summ-b', { displayName: 'Summarizer B', tags: ['summarize'] }),
  ];
  const universe = [...browseAgents, ...summarizers];
  const snapshot = { agents: universe, scanned: universe.length, totalCount: universe.length, truncated: false };

  // 1. Pagination: slicing, coverage, no overlap, stable ordering.
  {
    const page1 = browseCatalog(snapshot, { offset: 0, limit: 50 });
    const page2 = browseCatalog(snapshot, { offset: 50, limit: 50 });
    const page3 = browseCatalog(snapshot, { offset: 100, limit: 50 });

    assert(page1.agents.length === 50, `page 1 must be one full page, got ${page1.agents.length}`);
    assert(page2.agents.length === 50, `page 2 must be one full page, got ${page2.agents.length}`);
    assert(page3.agents.length === universe.length - 100, `last page must be the remainder, got ${page3.agents.length}`);
    assert(page1.offset === 0 && page1.limit === 50, 'page echoes its offset/limit');
    assert(page1.matched === universe.length, `matched must count the whole universe, got ${page1.matched}`);

    const all = [...handlesOf(page1.agents), ...handlesOf(page2.agents), ...handlesOf(page3.agents)];
    assert(all.length === universe.length, `paging must cover every agent exactly once, got ${all.length}/${universe.length}`);
    assert(new Set(all).size === all.length, 'paging must not overlap (no duplicate across pages)');

    // Stable ordering: the same page requested twice is byte-for-byte identical,
    // and the concatenation is globally sorted (deterministic across requests).
    const page2Again = browseCatalog(snapshot, { offset: 50, limit: 50 });
    assert(JSON.stringify(handlesOf(page2.agents)) === JSON.stringify(handlesOf(page2Again.agents)), 'the same page must be stable across requests');
    const sorted = [...all].sort((a, b) => a.localeCompare(b));
    assert(JSON.stringify(all) === JSON.stringify(sorted), 'empty-query paging must be deterministically ordered (handle asc)');
    console.log('▸ pagination: offset/limit slicing covers every agent once, in a stable deterministic order ✓');
  }

  // 1b. Limit/offset clamping — a hand-crafted request can't dump the scan.
  {
    assert(browseCatalog(snapshot, {}).limit === BROWSE_DEFAULT_LIMIT, `default page size must be ${BROWSE_DEFAULT_LIMIT}`);
    assert(browseCatalog(snapshot, { limit: 9999 }).limit === BROWSE_MAX_LIMIT, `over-large limit must clamp to ${BROWSE_MAX_LIMIT}`);
    assert(browseCatalog(snapshot, { limit: 9999 }).agents.length === BROWSE_MAX_LIMIT, 'clamped limit must bound the page');
    assert(browseCatalog(snapshot, { limit: 0 }).limit === 1, 'limit below 1 must clamp to 1');
    assert(browseCatalog(snapshot, { offset: -5 }).offset === 0, 'negative offset must clamp to 0');
    const beyond = browseCatalog(snapshot, { offset: 10_000, limit: 50 });
    assert(beyond.agents.length === 0 && beyond.matched === universe.length, 'an out-of-range offset returns an empty page but honest matched');
    console.log('▸ clamping: default/max page size + non-negative offset keep the surface paginated ✓');
  }

  // 2. Filtering: tag prefilter and q relevance ranking, no leakage.
  {
    const byTag = browseCatalog(snapshot, { tag: 'summarize', limit: 50 });
    assert(byTag.matched === 2, `tag prefilter must match exactly the tagged agents, got ${byTag.matched}`);
    assert(byTag.agents.every((a) => Array.isArray(a.tags) && (a.tags as string[]).includes('summarize')), 'every tag hit must carry the tag');

    const byQuery = browseCatalog(snapshot, { q: 'summarize', limit: 50 });
    assert(byQuery.matched === 2, `a relevance query must return only scoring agents, got ${byQuery.matched}`);
    const qHandles = new Set(handlesOf(byQuery.agents));
    assert(qHandles.has('summ-a') && qHandles.has('summ-b'), 'the summarizers must rank for "summarize"');
    assert(![...qHandles].some((h) => h.startsWith('browse-')), 'non-matching agents must NOT leak into a query page');
    console.log('▸ filtering: tag prefilter + q ranking return only real matches (no leakage) ✓');
  }

  // 3. Honesty: scanned/totalCount/truncated pass through unchanged.
  {
    const truncated = { agents: universe.slice(0, 50), scanned: 50, totalCount: 480, truncated: true };
    const res = browseCatalog(truncated, { limit: 50 });
    assert(res.scanned === 50, `scanned must pass through, got ${res.scanned}`);
    assert(res.totalCount === 480, `totalCount must pass through, got ${res.totalCount}`);
    assert(res.truncated === true, 'truncated must pass through so the panel can flag a partial view');
    assert(res.matched === 50, `matched reflects the (prefix) snapshot, got ${res.matched}`);
    console.log('▸ honesty: scanned / totalCount / truncated are surfaced verbatim (no "whole network" pretense) ✓');
  }

  // 4. Offline parity: the mock catalog flows through the SAME browse helper.
  {
    clearCatalogCache();
    const mock = await loadRuntimeCatalog(true);
    assert(mock.agents.length > 0, 'offline scan must return the mock catalog');
    const browsed = browseCatalog(mock, { limit: BROWSE_DEFAULT_LIMIT });
    assert(browsed.agents.length === Math.min(mock.agents.length, BROWSE_DEFAULT_LIMIT), 'offline browse must page the mock catalog');
    assert(browsed.scanned === mock.scanned && browsed.totalCount === mock.totalCount && browsed.truncated === mock.truncated, 'offline browse must carry the snapshot scope through');
    console.log(`▸ offline parity: the mock catalog (${mock.agents.length} agents) browses through the live helper ✓`);
  }

  console.log('\naudit: server-side pagination + shared ranking + honest scope, all offline');
  console.log('✅ catalog-browse check passed');
} catch (err) {
  console.error(`❌ catalog-browse check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
