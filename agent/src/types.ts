/**
 * Shared types for the foundation agent. These mirror the shape of the
 * real Blocks.ai SDK closely enough that swapping the mock transport for
 * the real one (in `blocks-client.ts`) does not ripple into the rest of
 * the code.
 */

export interface Price {
  amount: string; // decimal string, e.g. "0.012"
  currency: 'USD';
  unit: 'per_call';
}

/** What the agent learns about a Blocks agent via discovery. Opaque:
 * the agent is discovered BY SKILL and called BY HANDLE — never named
 * or hardcoded to an endpoint.
 *
 * The fields below `price` are OPTIONAL faceted metadata used by catalog
 * search/categorization (Pillar 2). They are populated when the source
 * exposes them (the live registry carries description/billing/io; the mock
 * carries description + a sample model facet on one listing) and are simply
 * absent otherwise — never invented. Keeping them optional preserves
 * back-compat for every caller that only reads the original five fields. */
export interface DiscoveredAgent {
  handle: string;
  displayName: string;
  provider: string;
  skills: string[];
  price: Price;
  /** Human-readable description, when the catalog exposes one. */
  description?: string;
  /** The underlying model, present ONLY when an agent genuinely advertises
   *  it. The catalog does not expose this for most agents, so it is usually
   *  absent — the honesty case in Pillar 2.4. */
  model?: string;
  /** Server-derived billing tier (live registry); absent offline. */
  billingMode?: 'free' | 'paid';
  /** Listing visibility (live registry); absent offline. */
  listing?: 'public' | 'private';
  /** Declared input/output ids from the agent card, when present. */
  inputs?: string[];
  outputs?: string[];
}

/** A non-text artifact saved to disk by `call()`. */
export interface FileArtifact {
  kind: 'file';
  /** Path relative to `agent/` — e.g. "outputs/task_ab12cd34-0.png". */
  path: string;
  mimeType: string;
  bytes: number;
  fileName?: string;
  /** Publicly fetchable URL for the file, present only when
   *  `OUTPUTS_PUBLIC_BASE_URL` is set (e.g. a tunnel origin). This is the
   *  URL chat clients can embed: their server-side media fetcher rejects
   *  loopback/private hosts, so a public origin is required to render
   *  artifacts inline in chat. */
  url?: string;
}

/** One artifact after download: text/JSON artifacts are decoded in
 *  place; everything else is written under `agent/outputs/`. */
export type ArtifactOut =
  | { kind: 'data'; data: unknown; mimeType: string }
  | FileArtifact;

/** A single specialist's response. `data` is the PRIMARY artifact:
 *  skill-specific JSON for text agents, or a `FileArtifact` descriptor
 *  for binary producers. `artifacts` (when present) carries the full
 *  list — agents may return more than one. */
export interface CallResult {
  data: unknown;
  artifacts?: ArtifactOut[];
  meta: CallMeta;
}

export interface CallMeta {
  handle: string;
  displayName: string;
  skill: string;
  latencyMs: number;
  costUsd: number;
}

export type PartialListener = (event: {
  handle: string;
  skill: string;
  message: string;
}) => void;
