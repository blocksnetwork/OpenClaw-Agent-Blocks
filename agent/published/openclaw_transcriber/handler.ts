/**
 * Transcriber — a speech→text agent for the Blocks network.
 *
 * Input:  JSON `{ audio: <base64>, format: "webm" }` (or an uploaded artifact).
 * Output: JSON `{ ok, text }`.
 *
 * Blocks practice: the clip is size-capped BEFORE the paid provider is called.
 */

import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';

loadRootEnv();

// OpenAI's transcription limit (~25 MB) — reject bigger clips before billing.
const MAX_AUDIO_BYTES = 25_000_000;

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  const { bytes, format } = await readAudio(task, ctx);

  if (bytes.byteLength === 0) throw new Error('input "audio" is required');
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`audio too large (${bytes.byteLength} bytes) — refused before billing`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured on this instance');

  const model = process.env.TRANSCRIBER_STT_MODEL ?? 'gpt-4o-mini-transcribe';
  ctx?.reportStatus(`Transcribing ${bytes.byteLength} bytes with ${model}...`);

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('file', new Blob([new Uint8Array(bytes)]), `audio.${format}`);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`STT provider returned HTTP ${response.status}`);
  }

  const { text } = (await response.json()) as { text?: string };
  const transcript = text?.trim() ?? '';
  ctx?.reportStatus(transcript ? `Transcript ready (${transcript.length} chars).` : 'No speech detected.');

  return transcript
    ? jsonResult({ ok: true, text: transcript })
    : jsonResult({ ok: false, error: 'No speech detected. Record a few seconds of clear speech and try again.' });
}

/** Read the clip from an uploaded artifact, or from inline base64 JSON. */
async function readAudio(task: StartTaskMessage, ctx?: TaskContext) {
  const part = task.requestParts?.find((p) => p.partId === 'request') ?? task.requestParts?.[0];
  if (!part) return { bytes: Buffer.alloc(0), format: 'webm' };

  const meta = safeJson(part.text) ?? {};
  const format = typeof meta.format === 'string' ? meta.format : 'webm';

  if (part.artifactRef && ctx?.downloadInputArtifact) {
    return { bytes: await ctx.downloadInputArtifact(part), format };
  }

  const inline = typeof meta.audio === 'string' ? meta.audio.replace(/^data:[^;]+;base64,/, '') : '';
  return { bytes: inline ? Buffer.from(inline, 'base64') : Buffer.alloc(0), format };
}

function safeJson(raw?: string): Record<string, unknown> | null {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function jsonResult(value: Record<string, unknown>): HandlerResult {
  return {
    artifacts: [{ data: JSON.stringify(value), mimeType: 'application/json', outputId: 'transcript' }],
  };
}
