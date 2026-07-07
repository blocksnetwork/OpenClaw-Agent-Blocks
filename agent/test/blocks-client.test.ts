/**
 * Offline integration tests for the Blocks client — the one door to the
 * network. Runs entirely against the in-process mock catalog (no key, no
 * network), so it is deterministic and CI-safe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connect } from '../src/blocks/blocks-client.ts';

test('discover → call round-trips through the echo agent', async () => {
  const session = await connect({ offline: true, latencyScale: 0 });
  try {
    const pool = await session.discover('echo');
    assert.ok(pool.length >= 1);
    const result = await session.call(pool[0].handle, 'echo', { text: 'hello world' });
    assert.equal((result.data as { echoed?: unknown }).echoed, 'hello world');
    assert.equal(result.meta.skill, 'echo');
    assert.equal(typeof result.meta.latencyMs, 'number');
  } finally {
    session.close();
  }
});

test('the microphone path: discover speech-to-text and get text back', async () => {
  const session = await connect({ offline: true, latencyScale: 0 });
  try {
    const pool = await session.discover('speech-to-text');
    assert.equal(pool.length, 1);
    const result = await session.call(pool[0].handle, 'speech-to-text', { audio: 'QUJD', format: 'webm' });
    assert.equal(typeof (result.data as { text?: unknown }).text, 'string');
    assert.ok((result.data as { text: string }).text.length > 0);
  } finally {
    session.close();
  }
});

test('a binary producer materializes a file artifact', async () => {
  const session = await connect({ offline: true, latencyScale: 0 });
  try {
    const pool = await session.discover('text-to-image');
    assert.ok(pool.length >= 1);
    const result = await session.call(pool[0].handle, 'text-to-image', { text: 'a cat' });
    const first = (result.artifacts ?? [])[0];
    assert.ok(first, 'expected at least one artifact');
    assert.equal(first.kind, 'file');
    if (first.kind === 'file') {
      assert.match(first.path, /^outputs\//);
      assert.equal(first.mimeType, 'image/png');
    }
  } finally {
    session.close();
  }
});

test('calling an unknown handle is rejected', async () => {
  const session = await connect({ offline: true, latencyScale: 0 });
  try {
    await assert.rejects(() => session.call('blk_does_not_exist', 'echo', { text: 'x' }));
  } finally {
    session.close();
  }
});
