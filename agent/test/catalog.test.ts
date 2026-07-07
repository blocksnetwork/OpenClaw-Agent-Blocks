/**
 * Unit tests for the mock catalog — pure, offline, no network.
 *
 * These guard the in-process Blocks stand-in the whole offline path
 * depends on (smoke, CI, demo mode), including the speech-to-text mock
 * that backs the microphone feature.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MOCK_CATALOG, findBySkill, findByHandle, isMockArtifactResult } from '../src/blocks/catalog.ts';

test('every mock listing has the shape the client expects', () => {
  assert.ok(MOCK_CATALOG.length > 0);
  for (const listing of MOCK_CATALOG) {
    assert.equal(typeof listing.handle, 'string');
    assert.ok(listing.handle.length > 0);
    assert.ok(Array.isArray(listing.skills) && listing.skills.length > 0);
    assert.equal(typeof listing.handler, 'function');
    assert.equal(listing.price.currency, 'USD');
  }
});

test('findBySkill returns only agents advertising that skill', () => {
  const summarizers = findBySkill('summarize');
  assert.ok(summarizers.length >= 2);
  for (const a of summarizers) assert.ok(a.skills.includes('summarize'));

  assert.equal(findBySkill('does-not-exist').length, 0);
});

test('a speech-to-text agent exists for the microphone path', () => {
  const stt = findBySkill('speech-to-text');
  assert.equal(stt.length, 1, 'mic transcription depends on exactly one offline STT mock');
  assert.equal(stt[0].handle, 'blk_transcribe_mock');
});

test('an image-understanding agent exists for the vision path', () => {
  const vision = findBySkill('image-to-text');
  assert.equal(vision.length, 1, 'image understanding depends on exactly one offline vision mock');
  assert.equal(vision[0].handle, 'blk_vision_mock');

  // the same mock is discoverable under its alias tags too
  assert.equal(findBySkill('vision')[0]?.handle, 'blk_vision_mock');
  assert.equal(findBySkill('image-understanding')[0]?.handle, 'blk_vision_mock');
});

test('the vision mock returns a non-empty text description', async () => {
  const vision = findByHandle('blk_vision_mock');
  assert.ok(vision);
  const out = (await vision.handler({ image: 'AAAA', format: 'png', prompt: 'caption it' })) as { text?: unknown };
  assert.equal(typeof out.text, 'string');
  assert.ok((out.text as string).length > 0);
});

test('findByHandle resolves known handles and rejects unknown ones', () => {
  assert.ok(findByHandle('blk_echo_001'));
  assert.equal(findByHandle('nope'), undefined);
});

test('isMockArtifactResult distinguishes binary producers from JSON', () => {
  assert.equal(
    isMockArtifactResult({ artifacts: [{ data: new Uint8Array([1]), mimeType: 'image/png' }] }),
    true,
  );
  assert.equal(isMockArtifactResult({ text: 'hi' }), false);
  assert.equal(isMockArtifactResult(null), false);
  assert.equal(isMockArtifactResult({ artifacts: [] }), false);
});
