import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';
import { runSkill } from '../../src/blocks/openclaw-client.ts';

interface EchoResult {
  ok: true;
  normalized: string;
  [key: string]: unknown;
}

loadRootEnv();

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  const text = readText(task);
  ctx?.reportStatus('Running OpenClaw echo_check...');

  const result = await runSkill('echo_check', { text });
  const echo = assertEchoResult(result);

  ctx?.reportStatus('OpenClaw echo_check completed.');
  return {
    artifacts: [
      {
        data: JSON.stringify(echo),
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

function assertEchoResult(value: unknown): EchoResult {
  if (!isRecord(value) || value.ok !== true || typeof value.normalized !== 'string') {
    throw new Error(`echo_check returned unexpected output: ${JSON.stringify(value)}`);
  }

  return value as EchoResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
