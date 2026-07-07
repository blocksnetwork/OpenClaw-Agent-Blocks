/**
 * In-process mock of the Blocks.ai catalog (the "remote" side).
 *
 * This exists ONLY so the foundation runs end-to-end offline while you
 * are still wiring up the real network. The real catalog is Blocks.ai:
 * a database of other people's agents, published with skill tags and
 * pricing, discoverable by skill.
 *
 * `blocks-client.ts` reads this when FOUNDATION_OFFLINE=1. The rest of
 * the codebase NEVER imports this file directly — it only sees
 * `DiscoveredAgent` views via the client. Keep that boundary.
 */

import type { Price } from '../types.ts';

export interface MockListing {
  handle: string;
  displayName: string;
  provider: string;
  skills: string[];
  price: Price;
  baseLatencyMs: number;
  /** Human-readable description. Mirrors the live registry's `description`
   *  field so categorization + relevance ranking (Pillar 2) have real text
   *  to score offline. */
  description?: string;
  /** The underlying model — present on a SINGLE listing so the "facet
   *  present" path in Pillar 2.4 is provable offline. Every other listing
   *  omits it, which is the honest "the catalog doesn't expose the model"
   *  case the same pillar must handle. Never invented for the rest. */
  model?: string;
  /** Deterministic stand-in for the real agent's response. Binary
   *  producers return a `MockArtifactResult` instead of plain JSON. */
  handler: (inputs: Record<string, unknown>) => Promise<unknown>;
}

/** Raw artifact a mock handler can emit — same shape the real SDK's
 *  `downloadArtifact()` returns, so the client pipes both through one
 *  materializer. */
export interface MockArtifact {
  data: Uint8Array;
  mimeType: string;
  fileName?: string;
}

export interface MockArtifactResult {
  artifacts: MockArtifact[];
}

export function isMockArtifactResult(value: unknown): value is MockArtifactResult {
  if (typeof value !== 'object' || value === null) return false;
  const artifacts = (value as { artifacts?: unknown }).artifacts;
  return (
    Array.isArray(artifacts)
    && artifacts.length > 0
    && artifacts.every(
      (a) =>
        typeof a === 'object'
        && a !== null
        && (a as MockArtifact).data instanceof Uint8Array
        && typeof (a as MockArtifact).mimeType === 'string',
    )
  );
}

/** 1×1 transparent PNG — enough to exercise the full binary pipeline
 *  (download → save → serve → render) with no key and no network. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Invocation counter for the flaky mock: odd invocations fail, even
 *  ones succeed. Failing every OTHER call (instead of only the first)
 *  keeps the retry path provable even in a long-lived process like the
 *  dashboard — every fanout sees fail→retry→ok deterministically. */
let flakyInvocations = 0;

export const MOCK_CATALOG: MockListing[] = [
  {
    handle: 'blk_echo_001',
    displayName: 'Echo Reference Agent',
    provider: 'foundation-mocks',
    skills: ['echo'],
    description: 'Reference agent that echoes the input back unchanged — a connectivity and protocol smoke test.',
    price: { amount: '0.000', currency: 'USD', unit: 'per_call' },
    baseLatencyMs: 300,
    handler: async (inputs) => ({
      echoed: inputs.text ?? null,
      received_at: new Date().toISOString(),
    }),
  },
  {
    handle: 'blk_summarize_7c2',
    displayName: 'Terse Summarizer',
    provider: 'foundation-mocks',
    skills: ['summarize', 'text'],
    description: 'Condenses long text into a single tight sentence. Good for quick TL;DRs of articles and notes.',
    price: { amount: '0.004', currency: 'USD', unit: 'per_call' },
    baseLatencyMs: 800,
    handler: async (inputs) => {
      const text = String(inputs.text ?? '');
      const first = text.split(/[.!?]/)[0]?.trim() ?? '';
      return { summary: first ? `${first}.` : '(empty input)' };
    },
  },
  {
    handle: 'blk_summarize_b91',
    displayName: 'Keyword Summarizer',
    provider: 'foundation-mocks',
    skills: ['summarize'],
    description: 'Extracts the top keywords from a block of text — a lightweight structured-data summary.',
    price: { amount: '0.002', currency: 'USD', unit: 'per_call' },
    baseLatencyMs: 500,
    handler: async (inputs) => {
      const text = String(inputs.text ?? '');
      const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/gu, '')
        .split(/\s+/u)
        .filter((w) => w.length > 4);
      const keywords = [...new Set(words)].slice(0, 5);
      return { keywords };
    },
  },
  {
    handle: 'blk_flaky_500',
    displayName: 'Flaky Summarizer',
    provider: 'foundation-mocks',
    skills: ['summarize'],
    description: 'Budget summarizer that occasionally returns a transient error — used to exercise retry/backoff.',
    price: { amount: '0.001', currency: 'USD', unit: 'per_call' },
    baseLatencyMs: 400,
    handler: async (inputs) => {
      flakyInvocations += 1;
      if (flakyInvocations % 2 === 1) {
        throw new Error('upstream 500: transient overload (mock)');
      }
      const text = String(inputs.text ?? '');
      const words = text.split(/\s+/u).filter(Boolean);
      return {
        summary: words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : ''),
        recovered: true,
      };
    },
  },
  {
    handle: 'blk_pixel_art',
    displayName: 'Pixel Art Maker',
    provider: 'foundation-mocks',
    skills: ['pixel-art', 'text-to-image'],
    description: 'Generates a small pixel-art image from a text prompt. A text-to-image picture generator.',
    price: { amount: '0.003', currency: 'USD', unit: 'per_call' },
    baseLatencyMs: 600,
    handler: async () => ({
      artifacts: [{ data: PIXEL_PNG, mimeType: 'image/png', fileName: 'pixel.png' }],
    }),
  },
  {
    // Offline stand-in for openclaw_transcriber: can't actually run STT
    // with no provider, so it returns a clearly-labelled canned transcript
    // — enough to exercise the mic → /api/transcribe → prompt path.
    handle: 'blk_transcribe_mock',
    displayName: 'Mock Transcriber',
    provider: 'foundation-mocks',
    skills: ['speech-to-text', 'transcribe'],
    description: 'Transcribes spoken audio into text (speech-to-text). Returns a plain-text transcript.',
    price: { amount: '0.000', currency: 'USD', unit: 'per_call' },
    baseLatencyMs: 500,
    handler: async () => ({
      text: 'This is a simulated transcription (offline mock catalog).',
    }),
  },
  {
    // Offline stand-in for openclaw_image_describer: can't run a real
    // vision model with no provider, so it returns a clearly-labelled
    // canned description — enough to exercise the image →
    // /api/describe-image → prompt path end to end with no key.
    handle: 'blk_vision_mock',
    displayName: 'Mock Image Describer',
    provider: 'foundation-mocks',
    skills: ['image-to-text', 'image-understanding', 'vision'],
    description: 'Describes and reads the contents of an image (vision / image-to-text).',
    // The ONLY listing that advertises an underlying model. Every other
    // agent omits `model`, which is the honest "facet not exposed" case in
    // Pillar 2.4 — so a "using Gemini" query matches THIS via a real facet,
    // while "using GPT-4" finds no exposed model and returns the honest note.
    model: 'gemini-1.5-flash',
    price: { amount: '0.000', currency: 'USD', unit: 'per_call' },
    baseLatencyMs: 600,
    handler: async (inputs) => {
      const prompt = typeof inputs.prompt === 'string' && inputs.prompt.trim()
        ? ` (asked: "${inputs.prompt.trim()}")`
        : '';
      return {
        text:
          `This is a simulated image description${prompt} (offline mock catalog). `
          + 'The picture appears to show a clear central subject with soft, even '
          + 'lighting, a cohesive palette, and generous negative space.',
      };
    },
  },
];

export function findBySkill(skill: string): MockListing[] {
  return MOCK_CATALOG.filter((l) => l.skills.includes(skill));
}

export function findByHandle(handle: string): MockListing | undefined {
  return MOCK_CATALOG.find((l) => l.handle === handle);
}
