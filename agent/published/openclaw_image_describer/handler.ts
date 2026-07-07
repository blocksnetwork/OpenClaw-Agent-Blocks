/**
 * Image Describer — vision (image→text) agent for the Blocks network.
 *
 * Turns an uploaded image into a text description so OpenClaw can "process
 * an image as part of a task" through Blocks: the chat UI sends a picture,
 * this agent finds and runs a vision model, and the words it returns become
 * context for the prompt. Inputs arrive as JSON
 * `{ image: <base64>, format: "png", prompt?: "..." }`; output is JSON
 * `{ ok, text }`.
 *
 * Provider-backed (every task spends real money): the image is size-capped
 * BEFORE the provider is called and the runtime cap
 * (agent-card.json maxRunningTimeSec) is kept tight.
 */

import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';

loadRootEnv();

// ~20 MB decoded — comfortably above the chat UI's downscaled uploads
// (long edge capped at 1568px) while still refusing abusive payloads.
const MAX_IMAGE_BYTES = 20_000_000;
const PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT =
  'Describe this image in detail. Note the main subject, the setting, notable '
  + 'objects, colors, mood, and any visible text.';

const FORMAT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

interface ImageInput {
  bytes: Buffer;
  format: string;
  prompt: string;
}

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  const { bytes, format, prompt } = await readImage(task, ctx);
  if (bytes.byteLength === 0) throw new Error('input "image" is required (none decoded)');
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large: ${bytes.byteLength} bytes (max ${MAX_IMAGE_BYTES}) — refused before billing the provider`,
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured on this instance');

  const model = process.env.IMAGE_DESCRIBE_MODEL ?? 'gpt-4o-mini';
  const fmt = (format || 'png').toLowerCase();
  const mime = FORMAT_MIME[fmt] ?? 'image/png';
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  const instruction = prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;
  ctx?.reportStatus(`Understanding ${bytes.byteLength} bytes with ${model}...`);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: 600,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`vision provider returned HTTP ${response.status}: ${truncate(payload)}`);
  }

  const parsed = (await response.json()) as ChatCompletionResponse;
  const text = extractContent(parsed);
  if (!text) throw new Error('vision provider returned an empty description');
  ctx?.reportStatus(`Description ready (${text.length} chars).`);

  return {
    artifacts: [
      {
        data: JSON.stringify({ ok: true, text }),
        mimeType: 'application/json',
        outputId: 'description',
      },
    ],
  };
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function extractContent(parsed: ChatCompletionResponse): string {
  const content = parsed.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

async function readImage(task: StartTaskMessage, ctx?: TaskContext): Promise<ImageInput> {
  const part = task.requestParts?.find((candidate) => candidate.partId === 'request') ?? task.requestParts?.[0];
  if (!part) return { bytes: Buffer.alloc(0), format: 'png', prompt: '' };

  // Metadata (format, prompt) — and, for back-compat, a small inline image —
  // ride as JSON `text` on the part.
  let format = 'png';
  let prompt = '';
  let inlineImage = '';
  const raw = typeof part.text === 'string' ? part.text : '';
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) {
        if (typeof parsed.format === 'string' && parsed.format.trim()) format = parsed.format.trim();
        if (typeof parsed.prompt === 'string') prompt = parsed.prompt;
        if (typeof parsed.image === 'string' && parsed.image.trim()) inlineImage = stripDataUrl(parsed.image);
      }
    } catch {
      // A bare base64 string (or data: URL) is also accepted for quick testing.
      inlineImage = stripDataUrl(raw);
    }
  }

  // Preferred online path: the image was uploaded as an artifact (large files
  // can't ride inline in a control message). Download the raw bytes.
  if (part.artifactRef && typeof ctx?.downloadInputArtifact === 'function') {
    const buf = await ctx.downloadInputArtifact(part);
    return { bytes: buf, format, prompt };
  }

  return { bytes: inlineImage ? Buffer.from(inlineImage, 'base64') : Buffer.alloc(0), format, prompt };
}

/** Accept either a raw base64 string or a full `data:` URL. */
function stripDataUrl(value: string): string {
  const match = /^data:[^;]+;base64,(.*)$/u.exec(value.trim());
  return match ? match[1] : value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}
