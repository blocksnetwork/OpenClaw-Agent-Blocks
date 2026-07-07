import handler from './handler.ts';

const result = await handler({
  type: 'StartTask',
  taskId: 'local-check',
  ownerId: 'local',
  requestParts: [
    {
      partId: 'request',
      text: JSON.stringify({ text: '  Hello WORLD ' }),
      contentType: 'application/json',
    },
  ],
});

const artifact = result.artifacts?.[0];
if (!artifact || artifact.mimeType !== 'application/json') {
  throw new Error(`Expected a JSON artifact, received ${JSON.stringify(result)}`);
}

const payload = JSON.parse(String(artifact.data)) as unknown;
if (!isRecord(payload) || payload.ok !== true || payload.normalized !== 'hello world') {
  throw new Error(`Unexpected local output: ${JSON.stringify(payload)}`);
}

console.log('✅ openclaw_echo_normalizer local check passed');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
