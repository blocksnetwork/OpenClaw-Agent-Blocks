/**
 * Phase 12 offline gate — multimodal artifact plumbing.
 *
 * Asserts, with no key and no network:
 *   1. calling the mock image agent (blk_pixel_art) yields
 *      data: { kind: 'file', path: 'outputs/<taskId>-0.png', mimeType: 'image/png' }
 *   2. the file exists on disk and starts with the PNG magic bytes
 *   3. a text/JSON agent (blk_echo_001) still returns parsed JSON
 *      exactly as before — no regression from the artifact rework
 *
 *   npm run check:multimodal
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { connect } from '../blocks/blocks-client.ts';
import { delegatedFileMedia } from '../assistant/assistant-runtime.ts';
import type { FileArtifact } from '../types.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const session = await connect({ latencyScale: 0 });

try {
  console.log('▸ 1. call mock image agent (blk_pixel_art)');
  const image = await session.call('blk_pixel_art', 'pixel-art', { text: 'demo' });
  const file = image.data as FileArtifact;
  assert(file && file.kind === 'file', `expected data.kind 'file', got ${JSON.stringify(image.data)}`);
  assert(/^outputs\/[\w-]+-0\.png$/u.test(file.path), `unexpected path: ${file.path}`);
  assert(file.mimeType === 'image/png', `expected image/png, got ${file.mimeType}`);
  assert(image.artifacts?.length === 1, 'expected exactly one artifact in the full list');
  console.log(`   → ${file.path} (${file.bytes} bytes)`);

  const media = delegatedFileMedia(file);
  assert(media.url === `/${file.path}`, `assistant media fallback URL must point at /outputs, got ${JSON.stringify(media)}`);
  process.env.BRIDGE_PUBLIC_BASE_URL = 'https://bridge.example.com/chat';
  const publicMedia = delegatedFileMedia(file);
  assert(
    publicMedia.url === `https://bridge.example.com/${file.path}`,
    `assistant media public URL must use the bridge origin, got ${JSON.stringify(publicMedia)}`,
  );
  delete process.env.BRIDGE_PUBLIC_BASE_URL;
  console.log('   → personal-assistant media reply can render from /outputs ✓');

  console.log('▸ 2. file on disk has PNG magic bytes');
  const absolute = fileURLToPath(new URL(`../../${file.path}`, import.meta.url));
  const bytes = await readFile(absolute);
  const magic = [0x89, 0x50, 0x4e, 0x47];
  assert(
    magic.every((b, i) => bytes[i] === b),
    `not a PNG: first bytes ${Array.from(bytes.subarray(0, 4)).map((b) => b.toString(16)).join(' ')}`,
  );
  assert(bytes.byteLength === file.bytes, `size mismatch: disk ${bytes.byteLength}, reported ${file.bytes}`);
  console.log(`   → 89 50 4e 47 ✓`);

  console.log('▸ 3. text/JSON agent unaffected (blk_echo_001)');
  const echo = await session.call('blk_echo_001', 'echo', { text: 'still json' });
  const echoed = (echo.data as { echoed?: unknown })?.echoed;
  assert(echoed === 'still json', `expected parsed JSON with echoed text, got ${JSON.stringify(echo.data)}`);
  console.log(`   → ${JSON.stringify(echo.data)}`);

  console.log('\n✅ multimodal plumbing check passed');
} finally {
  session.close();
}
