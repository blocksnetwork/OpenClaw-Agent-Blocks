/**
 * Narrator — text→speech agent for the Blocks network.
 *
 * Provider-backed (every task spends real money): inputs are
 * length-capped BEFORE the provider is called and the runtime cap
 * (agent-card.json maxRunningTimeSec) is kept tight.
 */

import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';

loadRootEnv();

const MAX_TEXT_CHARS = 600;
const PROVIDER_TIMEOUT_MS = 45_000;

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  const text = readText(task).trim();
  if (!text) throw new Error('input "text" is required');
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(
      `input too long: ${text.length} chars (max ${MAX_TEXT_CHARS}) — refused before billing the provider`,
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured on this instance');

  const model = process.env.NARRATOR_TTS_MODEL ?? 'gpt-4o-mini-tts';
  const voice = process.env.NARRATOR_VOICE ?? 'alloy';
  ctx?.reportStatus(`Narrating with ${model} (${voice})...`);

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`TTS provider returned HTTP ${response.status}: ${truncate(payload)}`);
  }

  const mp3 = Buffer.from(await response.arrayBuffer());
  if (mp3.byteLength === 0) throw new Error('TTS provider returned an empty audio body');
  ctx?.reportStatus(`Narration ready (${mp3.byteLength} bytes).`);

  return {
    artifacts: [
      {
        data: mp3,
        mimeType: 'audio/mpeg',
        outputId: 'narration',
        fileName: 'narration.mp3',
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
