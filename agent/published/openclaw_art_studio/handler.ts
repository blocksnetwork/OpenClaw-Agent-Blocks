/**
 * Art Studio — a second text→image agent for the Blocks network.
 *
 * Deliberately a sibling of openclaw_poster_maker (same provider, same
 * text-to-image tag) but with a different visual style, so multi-agent image
 * strategies (race / compare / best) have more than one candidate to fan out
 * to and `compare` returns visibly distinct images side by side.
 *
 * Provider-backed: every task spends real money, so inputs are length-capped
 * BEFORE the provider is called and the runtime cap (agent-card.json
 * maxRunningTimeSec) is kept tight.
 */

import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';

loadRootEnv();

const MAX_PROMPT_CHARS = 400;
const PROVIDER_TIMEOUT_MS = 60_000;

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  const text = readText(task).trim();
  if (!text) throw new Error('input "text" is required');
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `input too long: ${text.length} chars (max ${MAX_PROMPT_CHARS}) — refused before billing the provider`,
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured on this instance');

  const model = process.env.ART_IMAGE_MODEL ?? process.env.POSTER_IMAGE_MODEL ?? 'gpt-image-1';
  const size = process.env.ART_IMAGE_SIZE ?? process.env.POSTER_IMAGE_SIZE ?? '1024x1024';
  ctx?.reportStatus(`Painting illustration with ${model}...`);

  const body: Record<string, unknown> = {
    model,
    prompt: `A vibrant, painterly digital illustration with rich color and soft light of: ${text}`,
    n: 1,
    size,
  };
  if (model.startsWith('dall-e')) {
    body.response_format = 'b64_json';
  } else {
    body.quality = process.env.ART_IMAGE_QUALITY ?? process.env.POSTER_IMAGE_QUALITY ?? 'low';
  }

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`image provider returned HTTP ${response.status}: ${truncate(payload)}`);
  }

  const b64 = (JSON.parse(payload) as { data?: Array<{ b64_json?: string }> }).data?.[0]?.b64_json;
  if (!b64) throw new Error(`image provider returned no b64_json image: ${truncate(payload)}`);

  const png = Buffer.from(b64, 'base64');
  ctx?.reportStatus(`Illustration ready (${png.byteLength} bytes).`);

  return {
    artifacts: [
      {
        data: png,
        mimeType: 'image/png',
        outputId: 'art',
        fileName: 'art.png',
      },
    ],
  };
}

function readText(task: StartTaskMessage): string {
  const part = task.requestParts?.find((candidate) => candidate.partId === 'request') ?? task.requestParts?.[0];
  if (!part) return '';

  const raw = typeof part.text === 'string' ? part.text : '';
  if (!raw.trim()) return raw;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { text?: unknown }).text === 'string') {
      return (parsed as { text: string }).text;
    }
  } catch {
    // Plain text is also accepted for quick manual testing.
  }

  return raw;
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}
