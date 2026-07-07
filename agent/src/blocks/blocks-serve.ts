/**
 * Blocks.ai producer-side wrapper — serve OUR agents to the network.
 *
 * Mirrors `blocks-client.ts` (the consumer door) for the producing
 * direction: one typed seam over the SDK's `startAgentInstance` so the
 * rest of the codebase (serve CLI, dashboard) never touches the SDK
 * directly. The SDK handles transport (PubNub) and auth internally —
 * it reads BLOCKS_API_KEY from the environment and the agent must
 * already be registered in the catalog (`blocks publish`).
 */

import { readFile } from 'node:fs/promises';

import {
  startAgentInstance,
  type AgentCard,
  type AgentInstanceHandle,
  type HandlerFn,
} from '@blocks-network/sdk';

export type { AgentInstanceHandle, HandlerFn } from '@blocks-network/sdk';

export interface ServeAgentOptions {
  /** Path (or file URL) to the agent's agent-card.json. */
  cardPath: string | URL;
  /** The task handler that does the agent's actual work. */
  handler: HandlerFn;
  /** Optional per-agent Blocks credential; falls back to process.env.BLOCKS_API_KEY. */
  apiKey?: string;
  /** Override the card's listing; defaults to extensions.blocks.listing. */
  listing?: 'public' | 'private';
}

/**
 * Read an agent card and start a live instance on the Blocks network.
 * Returns the SDK handle; call `handle.stop()` to take it offline.
 */
export async function serveAgent(opts: ServeAgentOptions): Promise<AgentInstanceHandle> {
  const apiKey = opts.apiKey?.trim() || process.env.BLOCKS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'BLOCKS_API_KEY is required to serve an agent on Blocks (run `blocks login --write-env`)',
    );
  }

  const card = JSON.parse(await readFile(opts.cardPath, 'utf8')) as AgentCard;
  const agentName = card.identity?.agentName;
  if (!agentName) {
    throw new Error(`agent card at ${String(opts.cardPath)} has no identity.agentName`);
  }

  const blocksExt = (card.extensions?.blocks ?? {}) as { listing?: 'public' | 'private' };
  const listing = opts.listing ?? blocksExt.listing ?? 'public';

  return withBlocksApiKey(apiKey, () => startAgentInstance({
    card,
    agentName,
    handler: opts.handler,
    listing,
    concurrency: card.runtime?.concurrency,
    expectedInstances: card.runtime?.expectedInstances,
    maxRunningTimeSec: card.runtime?.maxRunningTimeSec,
    // When unset the SDK resolves the base URL from the CDM config,
    // exactly like blocks-client.ts does for the consumer side.
    baseUrl: process.env.BLOCKS_BACKEND_URL,
  }));
}

async function withBlocksApiKey<T>(apiKey: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.BLOCKS_API_KEY;
  process.env.BLOCKS_API_KEY = apiKey;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.BLOCKS_API_KEY;
    } else {
      process.env.BLOCKS_API_KEY = previous;
    }
  }
}
