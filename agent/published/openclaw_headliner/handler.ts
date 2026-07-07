import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';
import { runSkill } from '../../src/blocks/openclaw-client.ts';

interface HeadlineResult {
  ok: true;
  headline: string;
  wordCount: number;
  [key: string]: unknown;
}

const MAX_INPUT_CHARS = 4_000;

loadRootEnv();

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  const text = readText(task);
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(
      `input too long: ${text.length} chars (max ${MAX_INPUT_CHARS}) — refused before billing the provider`,
    );
  }

  ctx?.reportStatus('Running OpenClaw headline_writer...');

  const result = await runSkill('headline_writer', { text });
  const headline = assertHeadlineResult(result);

  ctx?.reportStatus(`Headline ready (${headline.wordCount} words).`);
  return {
    artifacts: [
      {
        data: JSON.stringify(headline),
        mimeType: 'application/json',
        outputId: 'result',
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
    if (isRecord(parsed) && typeof parsed.text === 'string') return parsed.text;
  } catch {
    // Plain text is also accepted for quick manual testing.
  }

  return raw;
}

function assertHeadlineResult(value: unknown): HeadlineResult {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.headline !== 'string' ||
    typeof value.wordCount !== 'number' ||
    !Number.isInteger(value.wordCount)
  ) {
    throw new Error(`headline_writer returned unexpected output: ${JSON.stringify(value)}`);
  }

  return value as HeadlineResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
