/**
 * catalog-index — the ONE catalog model + search pipeline (Pillar 2).
 *
 * Before this module, "search the catalog" was substring `filter` over a
 * joined haystack, duplicated in TWO places (the runtime's `catalogAgentView`
 * /`filterCatalog` and the dashboard's `blocksView`/`matches`) that drifted
 * independently. This module is the single source of truth both import:
 *
 *   1. `CatalogAgent` + `toCatalogAgent` — ONE normalized faceted record and
 *      ONE mapper (2.1). Optional facets (description / model / billing / io)
 *      are present only when the source genuinely exposes them.
 *   2. `categorize` — a CLOSED capability taxonomy from tags + description
 *      (2.2). Multi-skill agents land in multiple categories; an agent with no
 *      tags and no description falls into `other`.
 *   3. `searchCatalog` — relevance RANKING (scored, field-weighted, word-
 *      boundary) that replaces substring matching, with a short, honest "why
 *      it matched" per hit (2.3) and facet handling + honesty for the model
 *      case (2.4).
 *   4. `loadCatalogSnapshot` — a process-global TTL cache with single-flight
 *      so concurrent turns don't stampede the registry (2.5).
 */

import type { DiscoveredAgent, Price } from '../types.ts';
import { connect, catalogScanMax } from './blocks-client.ts';

/* ── 2.1 normalized record + mapper ─────────────────────────────────────── */

/** One normalized, faceted catalog record. The fields below `tags` are
 *  optional facets, present only when the catalog actually exposes them. */
export interface CatalogAgent {
  handle: string;
  displayName: string;
  provider: string;
  description: string;
  tags: string[];
  price: Price;
  billingMode: 'free' | 'paid';
  listing?: 'public' | 'private';
  inputs?: string[];
  outputs?: string[];
  /** The underlying model — present ONLY when genuinely advertised (2.4). */
  model?: string;
}

/** THE mapper: a discovered agent → the normalized record. Both the runtime
 *  and the dashboard route through this (the dashboard first adapts the SDK
 *  `AgentEntry` via `agentEntryToDiscovered`), so categorization and ranking
 *  have exactly one source of truth. */
export function toCatalogAgent(agent: DiscoveredAgent): CatalogAgent {
  return {
    handle: agent.handle,
    displayName: agent.displayName,
    provider: agent.provider,
    description: agent.description ?? '',
    tags: agent.skills ?? [],
    price: agent.price,
    billingMode: agent.billingMode ?? (Number(agent.price.amount) > 0 ? 'paid' : 'free'),
    ...(agent.listing ? { listing: agent.listing } : {}),
    ...(agent.inputs && agent.inputs.length > 0 ? { inputs: agent.inputs } : {}),
    ...(agent.outputs && agent.outputs.length > 0 ? { outputs: agent.outputs } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  };
}

/* ── 2.2 categorization (CLOSED capability taxonomy) ────────────────────── */

export type CatalogCategory =
  | 'image'
  | 'audio-to-text'
  | 'text-to-audio'
  | 'vision'
  | 'summarize'
  | 'headline'
  | 'data'
  | 'other';

/** The closed set, in display order. `other` is the catch-all so every agent
 *  lands in at least one category (edge case 8). */
export const CATALOG_CATEGORIES: CatalogCategory[] = [
  'image', 'audio-to-text', 'text-to-audio', 'vision', 'summarize', 'headline', 'data', 'other',
];

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  image: 'image generation',
  'audio-to-text': 'audio→text',
  'text-to-audio': 'text→audio',
  vision: 'vision',
  summarize: 'summarize',
  headline: 'headline',
  data: 'data',
  other: 'other',
};

/** Tag → category. Tags drive categorization (reliable for both offline mock
 *  skills and the live registry's card tags). */
const CATEGORY_TAGS: Record<Exclude<CatalogCategory, 'other'>, string[]> = {
  image: ['text-to-image', 'image-generation', 'image-gen', 'pixel-art', 'poster', 'logo', 'illustration', 'render'],
  'audio-to-text': ['speech-to-text', 'transcribe', 'transcription', 'stt', 'asr'],
  'text-to-audio': ['text-to-speech', 'tts', 'narrate', 'voiceover', 'speech-synthesis', 'voice'],
  vision: ['image-to-text', 'image-understanding', 'vision', 'ocr', 'caption'],
  summarize: ['summarize', 'summary', 'summarization', 'tldr'],
  headline: ['headline', 'title', 'openclaw-headline-write', 'headline-write'],
  data: ['data', 'keyword', 'keywords', 'extract', 'extraction', 'classify', 'classification', 'analysis', 'analyze', 'parse', 'structured', 'table', 'csv', 'json', 'tone-guide'],
};

/** Description fallback — only consulted when tags assign nothing, and worded
 *  to disambiguate "make an image" (image) from "read an image" (vision). */
const CATEGORY_DESC: Record<Exclude<CatalogCategory, 'other'>, RegExp> = {
  image: /\b(generate|create|make|produce|draw|paint)s?\b[^.]*\b(image|picture|poster|logo|art|illustration)\b|\btext[- ]to[- ]image\b/u,
  'audio-to-text': /\btranscri\w+\b|\bspeech[- ]to[- ]text\b/u,
  'text-to-audio': /\b(narrat\w+|voiceover|read aloud)\b|\btext[- ]to[- ]speech\b/u,
  vision: /\b(describe|read|analy\w+|understand|caption|ocr)s?\b[^.]*\bimage\b|\bvision\b/u,
  summarize: /\bsummar\w+\b|\btl;?dr\b/u,
  headline: /\bheadline\b|\btitle\b/u,
  data: /\b(keyword|extract\w*|classif\w+|structured|parse|analy\w+|tone|style)\b/u,
};

/** Map an agent into its capability categories (1+; `other` when nothing else
 *  fits). Multi-skill agents legitimately land in several. */
export function categorize(agent: CatalogAgent): CatalogCategory[] {
  const tags = agent.tags.map((t) => t.toLowerCase());
  const found = new Set<CatalogCategory>();

  for (const category of CATALOG_CATEGORIES) {
    if (category === 'other') continue;
    const wanted = CATEGORY_TAGS[category];
    if (tags.some((tag) => wanted.includes(tag))) found.add(category);
  }

  if (found.size === 0) {
    const desc = agent.description.toLowerCase();
    if (desc) {
      for (const category of CATALOG_CATEGORIES) {
        if (category === 'other') continue;
        if (CATEGORY_DESC[category].test(desc)) found.add(category);
      }
    }
  }

  if (found.size === 0) return ['other'];
  return CATALOG_CATEGORIES.filter((c) => found.has(c));
}

export interface CategoryBucket {
  category: CatalogCategory;
  label: string;
  count: number;
  handles: string[];
}

/** Bucket a whole set of agents by category (the "what kinds exist" view). */
export function categorizeCatalog(agents: CatalogAgent[]): CategoryBucket[] {
  const buckets = new Map<CatalogCategory, string[]>();
  for (const agent of agents) {
    for (const category of categorize(agent)) {
      const list = buckets.get(category) ?? [];
      list.push(agent.handle);
      buckets.set(category, list);
    }
  }
  return CATALOG_CATEGORIES
    .filter((category) => buckets.has(category))
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      count: buckets.get(category)!.length,
      handles: buckets.get(category)!,
    }));
}

/* ── 2.3 relevance ranking ──────────────────────────────────────────────── */

const STOPWORDS = new Set([
  'agent', 'agents', 'tool', 'tools', 'blocks', 'block', 'catalog', 'using', 'use', 'uses',
  'the', 'and', 'for', 'with', 'that', 'who', 'which', 'what', 'find', 'search', 'list',
  'show', 'are', 'is', 'can', 'available', 'support', 'supports', 'me', 'a', 'an', 'on',
  'in', 'of', 'to', 'do', 'any', 'some', 'few', 'example', 'examples', 'pick', 'best', 'would', 'you', 'them', 'one',
]);

/** Match-tokenizer: lower-case, split on every non-alphanumeric run so
 *  `gemini-1.5-flash` → [gemini,1,5,flash] and `speech-to-text` → [speech,to,
 *  text]. Used for both fields and the query so matching is symmetric. */
function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

/** Significant query terms (stopwords + 1-char noise removed). */
export function queryTerms(query: string): string[] {
  return tokenize(query).filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

/** Word-boundary term match: equal, or a short stem (the shorter token is a
 *  prefix of the longer AND the suffix is small, ≤3 chars — plurals/verb
 *  endings). This matches "summar"↔"summarize" and "transcribe"↔"transcribes"
 *  while REJECTING the substring false positives of `includes`: "art" vs
 *  "smart", "tts" vs "watts", "blockchain" vs "block". */
function termHitsTokens(tokens: string[], term: string): boolean {
  return tokens.some((tok) => {
    if (tok === term) return true;
    const [short, long] = tok.length <= term.length ? [tok, term] : [term, tok];
    if (short.length < 3) return false;
    if (!long.startsWith(short)) return false;
    return long.length - short.length <= 3;
  });
}

interface FieldDef {
  name: 'name' | 'tag' | 'capability' | 'model' | 'description' | 'provider';
  weight: number;
  tokens: string[];
}

const FIELD_WEIGHT = { name: 6, tag: 5, capability: 4, model: 4, description: 2, provider: 1 } as const;

export interface RankedCatalogAgent {
  agent: CatalogAgent;
  categories: CatalogCategory[];
  score: number;
  /** Honest, human "why it matched" naming the REAL field + term. */
  whyMatched: string;
}

/** Map query terms onto categories so a capability word ("transcribe",
 *  "audio") rewards agents in the matching category even when the exact tag
 *  text differs. */
function queryCategories(terms: string[]): Set<CatalogCategory> {
  const out = new Set<CatalogCategory>();
  const joined = terms.join(' ');
  for (const category of CATALOG_CATEGORIES) {
    if (category === 'other') continue;
    const wanted = CATEGORY_TAGS[category];
    if (terms.some((term) => wanted.some((tag) => termHitsTokens(tokenize(tag), term)))) out.add(category);
    else if (CATEGORY_DESC[category].test(joined)) out.add(category);
  }
  return out;
}

function scoreAgent(
  agent: CatalogAgent,
  categories: CatalogCategory[],
  terms: string[],
  wantCategories: Set<CatalogCategory>,
): { score: number; whyMatched: string } {
  const fields: FieldDef[] = [
    { name: 'name', weight: FIELD_WEIGHT.name, tokens: tokenize(`${agent.displayName} ${agent.handle}`) },
    { name: 'tag', weight: FIELD_WEIGHT.tag, tokens: tokenize(agent.tags.join(' ')) },
    { name: 'description', weight: FIELD_WEIGHT.description, tokens: tokenize(agent.description) },
    { name: 'provider', weight: FIELD_WEIGHT.provider, tokens: tokenize(agent.provider) },
  ];
  if (agent.model) fields.push({ name: 'model', weight: FIELD_WEIGHT.model, tokens: tokenize(agent.model) });

  let score = 0;
  let best: { weight: number; field: FieldDef['name']; term: string } | null = null;

  for (const term of terms) {
    for (const field of fields) {
      if (termHitsTokens(field.tokens, term)) {
        score += field.weight;
        if (!best || field.weight > best.weight) best = { weight: field.weight, field: field.name, term };
      }
    }
  }

  // Capability alignment: the agent's category is what the query is asking for.
  const sharedCategory = categories.find((c) => wantCategories.has(c));
  if (sharedCategory) {
    score += FIELD_WEIGHT.capability;
    if (!best || FIELD_WEIGHT.capability > best.weight) {
      best = { weight: FIELD_WEIGHT.capability, field: 'capability', term: CATEGORY_LABELS[sharedCategory] };
    }
  }

  return { score, whyMatched: best ? whyText(best.field, best.term) : '' };
}

function whyText(field: FieldDef['name'], term: string): string {
  switch (field) {
    case 'name': return `name matches “${term}”`;
    case 'tag': return `tagged “${term}”`;
    case 'capability': return `does ${term}`;
    case 'model': return `advertises model “${term}”`;
    case 'description': return `description mentions “${term}”`;
    case 'provider': return `from provider “${term}”`;
    default: return `matches “${term}”`;
  }
}

/* ── 2.4 facets & honesty ───────────────────────────────────────────────── */

/** Known model brand tokens. A query token in here means the owner asked to
 *  filter by the underlying MODEL — a facet the catalog usually doesn't
 *  expose, so we answer honestly instead of guessing. */
const MODEL_BRANDS = new Set([
  'gemini', 'gpt', 'gpt4', 'gpt4o', 'chatgpt', 'claude', 'sonnet', 'opus', 'haiku',
  'llama', 'mistral', 'mixtral', 'gemma', 'phi', 'qwen', 'dalle', 'sdxl',
  'whisper', 'flux', 'grok', 'deepseek',
]);

/** Detect a model-facet term in the query, or undefined. */
export function detectModelFacet(query: string): string | undefined {
  for (const term of tokenize(query)) {
    if (MODEL_BRANDS.has(term)) return term;
  }
  return undefined;
}

export interface SearchFacets {
  /** Restrict to a capability category. */
  category?: CatalogCategory;
  /** Restrict to a provider (token match). */
  provider?: string;
  /** Restrict by billing tier. */
  billing?: 'free' | 'paid';
  /** Restrict by underlying model (usually not exposed → honest note). */
  model?: string;
}

export interface SearchResult {
  query: string;
  terms: string[];
  results: RankedCatalogAgent[];
  matched: number;
  /** Categorization of the full scanned universe (for the list/overview view). */
  buckets: CategoryBucket[];
  /** Set when a requested facet (the model case) isn't exposed in metadata —
   *  distinct from a genuine zero-match. */
  facetNote?: string;
  /** True when a model facet was requested but no agent advertises a model. */
  modelFacetUnavailable: boolean;
  recommendation?: RankedCatalogAgent;
}

/** The whole pipeline: filter by facets, rank by relevance, categorize, and
 *  answer honestly about the model facet. `agents` is the scanned universe
 *  (already tag-prefiltered by the caller if a tag was supplied). */
export function searchCatalog(agents: CatalogAgent[], opts: { query: string; facets?: SearchFacets } = { query: '' }): SearchResult {
  const facets = opts.facets ?? {};
  const terms = queryTerms(opts.query);
  const buckets = categorizeCatalog(agents);

  // Apply explicit hard facets first (capability/provider/billing).
  let universe = agents;
  if (facets.category) universe = universe.filter((a) => categorize(a).includes(facets.category!));
  if (facets.provider) {
    const ptok = tokenize(facets.provider);
    universe = universe.filter((a) => ptok.every((t) => termHitsTokens(tokenize(a.provider), t)));
  }
  if (facets.billing) universe = universe.filter((a) => a.billingMode === facets.billing);

  // Model facet honesty (2.4): the catalog rarely exposes a model.
  const modelTerm = facets.model ?? detectModelFacet(opts.query);
  let facetNote: string | undefined;
  let modelFacetUnavailable = false;
  if (modelTerm) {
    const anyExposed = universe.some((a) => a.model);
    const modelMatches = universe.filter((a) => a.model && termHitsTokens(tokenize(a.model), modelTerm));
    if (modelMatches.length === 0) {
      modelFacetUnavailable = !anyExposed;
      facetNote = anyExposed
        ? `Most agents don't advertise their underlying model, so I can't reliably filter by “${modelTerm}”. I matched on visible fields (name, description, tags, provider) instead.`
        : `The catalog doesn't expose the underlying model for these agents, so I can't filter by “${modelTerm}”. I matched on visible fields (name, description, tags, provider) instead.`;
    }
  }

  const wantCategories = queryCategories(terms);
  const ranked: RankedCatalogAgent[] = universe.map((agent) => {
    const categories = categorize(agent);
    const { score, whyMatched } = scoreAgent(agent, categories, terms, wantCategories);
    return { agent, categories, score, whyMatched: whyMatched || defaultWhy(categories) };
  });

  // Empty / stopword-only query (edge case 4): keep a sane, deterministically
  // ordered list instead of returning everything unranked or nothing.
  const hasTerms = terms.length > 0;
  const filtered = hasTerms ? ranked.filter((r) => r.score > 0) : ranked;

  filtered.sort(compareRanked);

  return {
    query: opts.query,
    terms,
    results: filtered,
    matched: filtered.length,
    buckets,
    facetNote,
    modelFacetUnavailable,
    recommendation: filtered[0],
  };
}

function defaultWhy(categories: CatalogCategory[]): string {
  const primary = categories.find((c) => c !== 'other') ?? categories[0];
  return primary && primary !== 'other' ? `does ${CATEGORY_LABELS[primary]}` : 'listed in the catalog';
}

/** Deterministic ordering: score desc, then price asc, then handle asc — so
 *  output is stable across runs and checks (edge case 12). */
function compareRanked(a: RankedCatalogAgent, b: RankedCatalogAgent): number {
  if (b.score !== a.score) return b.score - a.score;
  const pa = Number(a.agent.price.amount);
  const pb = Number(b.agent.price.amount);
  const na = Number.isFinite(pa) ? pa : Number.POSITIVE_INFINITY;
  const nb = Number.isFinite(pb) ? pb : Number.POSITIVE_INFINITY;
  if (na !== nb) return na - nb;
  return a.agent.handle.localeCompare(b.agent.handle);
}

/* ── serialization + reply formatting ───────────────────────────────────── */

/** Serialize one ranked hit for the JSON artifact / API response. */
export function rankedAgentView(ranked: RankedCatalogAgent): Record<string, unknown> {
  const a = ranked.agent;
  return {
    handle: a.handle,
    displayName: a.displayName,
    provider: a.provider,
    description: a.description,
    tags: a.tags,
    categories: ranked.categories,
    price: a.price,
    billingMode: a.billingMode,
    ...(a.listing ? { listing: a.listing } : {}),
    ...(a.inputs ? { inputs: a.inputs } : {}),
    ...(a.outputs ? { outputs: a.outputs } : {}),
    ...(a.model ? { model: a.model } : {}),
    score: ranked.score,
    whyMatched: ranked.whyMatched,
  };
}

export function formatPrice(price: Price): string {
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return 'price n/a';
  if (amount === 0) return 'free';
  return `$${price.amount}/${price.unit === 'per_call' ? 'call' : price.unit}`;
}

/* ── browse (paginated, searchable full-registry view) ───────────────────── */

/** Default page size for the always-on "browse the whole network" surface —
 *  small enough that we never ship thousands of agents to the browser at once,
 *  matching the 50/page the registry walker itself uses. */
export const BROWSE_DEFAULT_LIMIT = 50;
/** Hard upper bound on a single browse page, so a hand-crafted `limit` can't
 *  turn the paginated surface back into a "dump the whole scan" request. */
export const BROWSE_MAX_LIMIT = 100;

export interface BrowseCatalogParams {
  /** Zero-based index of the first result to return (default 0). */
  offset?: number;
  /** Page size (clamped to [1, BROWSE_MAX_LIMIT], default BROWSE_DEFAULT_LIMIT). */
  limit?: number;
  /** Optional relevance query, ranked via the shared `searchCatalog` pipeline. */
  q?: string;
  /** Optional exact tag prefilter applied before ranking. */
  tag?: string;
}

export interface BrowseCatalogResult {
  /** One page of ranked agents, serialized via `rankedAgentView`. */
  agents: Record<string, unknown>[];
  offset: number;
  limit: number;
  /** Total agents matching `q`/`tag` BEFORE the page slice (for paging math). */
  matched: number;
  /** How much of the registry the backing snapshot actually walked. */
  scanned: number;
  /** Registry size when reported (so the UI can say "showing X of N"). */
  totalCount?: number;
  /** True when the backing scan hit its cap with more agents available — the
   *  page is a window into a PREFIX, not the whole network. */
  truncated: boolean;
}

/**
 * Paginate + search the full-registry snapshot for the always-on browse panel.
 *
 * This is the ONE place browse paging lives, and it deliberately reuses the
 * single ranking path (`searchCatalog`) rather than a second filter: an empty
 * query returns the whole (optionally tag-filtered) universe in the same
 * deterministic score→price→handle order, so paging is stable across requests;
 * a real query ranks by relevance. Slicing happens server-side so the browser
 * only ever receives one page. `scanned`/`totalCount`/`truncated` are passed
 * through unchanged so the surface stays honest about how much it can see.
 */
export function browseCatalog(
  snapshot: { agents: CatalogAgent[]; scanned: number; totalCount?: number; truncated: boolean },
  params: BrowseCatalogParams = {},
): BrowseCatalogResult {
  const offset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset as number)) : 0;
  const rawLimit = Number.isFinite(params.limit) ? Math.floor(params.limit as number) : BROWSE_DEFAULT_LIMIT;
  const limit = Math.min(BROWSE_MAX_LIMIT, Math.max(1, rawLimit));
  const q = (params.q ?? '').trim();
  const tag = (params.tag ?? '').trim();

  // Optional exact-tag prefilter (same semantics as the chat catalog route).
  let universe = snapshot.agents;
  if (tag) {
    const wanted = tag.toLowerCase();
    universe = universe.filter((a) => a.tags.some((t) => t.toLowerCase() === wanted));
  }

  const ranked = searchCatalog(universe, { query: q }).results;
  const matched = ranked.length;
  const agents = ranked.slice(offset, offset + limit).map(rankedAgentView);

  return {
    agents,
    offset,
    limit,
    matched,
    scanned: snapshot.scanned,
    totalCount: snapshot.totalCount,
    truncated: snapshot.truncated,
  };
}

/** The standard visibility disclaimer — what catalog search can and can't see. */
export const VISIBILITY_NOTE =
  'Note: catalog search sees public fields (handle, display name, provider, tags, description, price) — not private agent configuration.';

export const AVAILABILITY_NOTE =
  'Availability is checked when you send a task; a catalog listing does not prove the agent is online.';

/** Compose the chat reply for a relevance search, including a recommendation
 *  ("which would you pick?") and any honest facet note. */
/** Honest scope line: how much of the catalog the answer actually covers.
 *  When the scan was truncated, say the catalog is larger than the scan so
 *  "search every agent" never silently means "search the first N". */
function scopeLine(scanned: number, totalCount: number | undefined, truncated: boolean | undefined, target: string): string {
  const base = `I scanned ${scanned}${totalCount ? ` of ${totalCount}` : ''} catalog agents for ${target}.`;
  if (truncated) {
    return `${base} (The catalog is larger than my scan limit, so this isn't the whole network — narrow the query or raise CATALOG_MAX_SCAN to cover more.)`;
  }
  return base;
}

export function formatSearchReply(opts: {
  query: string;
  tag?: string;
  search: SearchResult;
  scanned: number;
  totalCount?: number;
  truncated?: boolean;
}): string {
  const { search } = opts;
  const target = opts.tag ? `tag “${opts.tag}”` : `“${opts.query}”`;
  const scope = scopeLine(opts.scanned, opts.totalCount, opts.truncated, target);

  if (search.matched === 0) {
    const lead = search.facetNote
      ? search.facetNote
      : `I searched the Blocks catalog for ${target} and didn't find matching agents. Try broader terms.`;
    return [scope, lead, VISIBILITY_NOTE].filter(Boolean).join('\n');
  }

  const top = search.results.slice(0, 8);
  const lines = top.map((r) => {
    const cats = r.categories.map((c) => CATEGORY_LABELS[c]).join(', ');
    return `- ${r.agent.handle} (${r.agent.displayName}) — ${cats} — ${r.whyMatched} [${formatPrice(r.agent.price)}]`;
  });
  const more = search.matched > top.length ? `…and ${search.matched - top.length} more.` : '';

  const rec = search.recommendation;
  const recLine = rec
    ? `Starter pick: ${rec.agent.handle} (${rec.agent.displayName}) — ${rec.whyMatched}, ${formatPrice(rec.agent.price)}.`
    : '';

  return [
    scope,
    `Found ${search.matched} match${search.matched === 1 ? '' : 'es'}:`,
    ...lines,
    more,
    recLine,
    AVAILABILITY_NOTE,
    search.facetNote,
    VISIBILITY_NOTE,
  ].filter(Boolean).join('\n');
}

/** Compose the chat reply for a "categorize the whole catalog" request. */
export function formatCategorizeReply(opts: {
  buckets: CategoryBucket[];
  scanned: number;
  totalCount?: number;
  truncated?: boolean;
}): string {
  if (opts.buckets.length === 0) {
    return ['No agents are listed in the Blocks catalog right now.', VISIBILITY_NOTE].join('\n');
  }
  const lines = opts.buckets.map((b) => `- ${b.label}: ${b.count} (${b.handles.slice(0, 4).join(', ')}${b.handles.length > 4 ? ', …' : ''})`);
  const header = `I categorized ${opts.scanned}${opts.totalCount ? ` of ${opts.totalCount}` : ''} agents in the Blocks catalog:`;
  const truncNote = opts.truncated
    ? 'Note: the catalog is larger than my scan limit, so this covers a prefix — raise CATALOG_MAX_SCAN to categorize the entire network.'
    : '';
  return [header, ...lines, truncNote, VISIBILITY_NOTE].filter(Boolean).join('\n');
}

/* ── 2.5 caching / refresh (process-global, TTL + single-flight) ─────────── */

export interface CatalogSnapshot {
  agents: CatalogAgent[];
  scanned: number;
  totalCount?: number;
  /** True when the scan stopped at the cap with more agents available — the
   *  index is a prefix, not the whole catalog, and replies say so. */
  truncated: boolean;
  fetchedAt: number;
}

/**
 * The cache is PROCESS-GLOBAL on purpose: the public/free catalog is the same
 * for every owner and every route (it carries no per-owner data), so one
 * cache serves the single-process dashboard and the multi-tenant runtime
 * alike — there's nothing to isolate per owner. Invalidation has exactly two
 * triggers: TTL expiry and a manual refresh (`{ refresh: true }` /
 * `clearCatalogCache()`). An in-flight map gives single-flight so a burst of
 * concurrent turns coalesces into ONE registry fetch (no thundering herd).
 */
export const CATALOG_TTL_MS = 60_000;

const snapshotCache = new Map<string, CatalogSnapshot>();
const inflight = new Map<string, Promise<CatalogSnapshot>>();

export function clearCatalogCache(): void {
  snapshotCache.clear();
  inflight.clear();
}

export async function loadCatalogSnapshot(
  key: string,
  fetcher: () => Promise<{ agents: CatalogAgent[]; scanned: number; totalCount?: number; truncated?: boolean }>,
  opts: { ttlMs?: number; refresh?: boolean } = {},
): Promise<CatalogSnapshot> {
  const ttl = opts.ttlMs ?? CATALOG_TTL_MS;

  if (!opts.refresh) {
    const hit = snapshotCache.get(key);
    if (hit && Date.now() - hit.fetchedAt < ttl) return hit;
  }
  // Single-flight: join an in-flight refetch instead of launching another
  // (covers both cold start and a forced refresh under concurrency).
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const fresh = await fetcher();
    const snapshot: CatalogSnapshot = { ...fresh, truncated: Boolean(fresh.truncated), fetchedAt: Date.now() };
    snapshotCache.set(key, snapshot);
    return snapshot;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Runtime convenience: load the normalized catalog snapshot via the Blocks
 * client (offline → full mock; live → paginated scan), cached + single-flight.
 */
export async function loadRuntimeCatalog(
  offline: boolean,
  opts: { refresh?: boolean; max?: number; onStatus?: (m: string) => void } = {},
): Promise<CatalogSnapshot> {
  const key = `runtime:${offline ? 'offline' : process.env.BLOCKS_BACKEND_URL ?? 'live'}`;
  return loadCatalogSnapshot(
    key,
    async () => {
      const session = await connect({ offline, onPartial: (e) => opts.onStatus?.(`${e.handle}: ${e.message}`) });
      try {
        const scan = await session.scanCatalog({ max: catalogScanMax(opts.max) });
        return {
          agents: scan.agents.map(toCatalogAgent),
          scanned: scan.scanned,
          totalCount: scan.totalCount,
          truncated: scan.truncated,
        };
      } finally {
        session.close();
      }
    },
    { refresh: opts.refresh },
  );
}
