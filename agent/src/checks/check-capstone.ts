/**
 * Phase 13 online gate — text→image + text→speech agents.
 *
 * Guarded: skips cleanly without BLOCKS_API_KEY / OPENAI_API_KEY.
 * Costs real provider money when it runs (one image + one short TTS).
 *
 * Serves both provider-backed agents from this process, hires them
 * back over the real Blocks network, and asserts:
 *   1. poster maker → a real PNG lands in agent/outputs/
 *   2. narrator    → a real MP3 lands in agent/outputs/
 *   3. cost guard  → a 10,000-char input fails fast WITHOUT hitting
 *                    the provider
 *
 *   npm run check:capstone
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { connect, type BlocksSession } from '../blocks/blocks-client.ts';
import { serveAgent, type AgentInstanceHandle } from '../blocks/blocks-serve.ts';
import type { FileArtifact } from '../types.ts';
import { loadRootEnv } from '../env.ts';

import posterHandler from '../../published/openclaw_poster_maker/handler.ts';
import narratorHandler from '../../published/openclaw_narrator/handler.ts';

loadRootEnv();

if (!process.env.BLOCKS_API_KEY) {
  console.log('↷ capstone check skipped: BLOCKS_API_KEY is not set');
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY) {
  console.log('↷ capstone check skipped: OPENAI_API_KEY is not set');
  process.exit(0);
}

process.env.FOUNDATION_OFFLINE = '0';

const POSTER = 'openclaw_poster_maker';
const NARRATOR = 'openclaw_narrator';
const TEXT = 'A lighthouse at dawn, calm sea, long shadows.';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const handles: AgentInstanceHandle[] = [];
let session: BlocksSession | undefined;

try {
  console.log('▸ 1. serve both provider-backed agents');
  handles.push(await serve('openclaw_poster_maker'));
  handles.push(await serve('openclaw_narrator'));
  console.log(`   → serving ${handles.map((h) => h.agentName).join(', ')}`);

  session = await connect({
    latencyScale: 0,
    onPartial: (e) => console.log(`   · ${e.handle}: ${e.message}`),
  });

  console.log('▸ 2. hire the poster maker back over the network (text-to-image)');
  const posterAgent = await discoverHandle(session, 'text-to-image', POSTER);
  const poster = await session.call(posterAgent, 'text-to-image', { text: TEXT });
  const png = await assertSavedFile(poster.data, 'image/png', [0x89, 0x50, 0x4e, 0x47]);
  console.log(`   → ${png.path} (${png.bytes} bytes, ${poster.meta.latencyMs}ms)`);

  console.log('▸ 3. hire the narrator (text-to-speech)');
  const narratorAgent = await discoverHandle(session, 'text-to-speech', NARRATOR);
  const narration = await session.call(narratorAgent, 'text-to-speech', { text: TEXT });
  const mp3 = await assertSavedFile(narration.data, 'audio/mpeg');
  console.log(`   → ${mp3.path} (${mp3.bytes} bytes, ${narration.meta.latencyMs}ms)`);

  console.log('▸ 4. cost guard — oversized input must fail without billing the provider');
  const oversized = 'x'.repeat(10_000);
  const started = Date.now();
  let rejected = false;
  try {
    await session.call(posterAgent, 'text-to-image', { text: oversized });
  } catch (err) {
    rejected = true;
    console.log(`   → rejected in ${Date.now() - started}ms: ${err instanceof Error ? err.message : err}`);
  }
  assert(rejected, 'oversized input must be rejected, not generated');

  const bill = poster.meta.costUsd + narration.meta.costUsd;
  console.log(`\n── audit ──\n  2 calls · network bill $${bill.toFixed(3)} (provider cost applies separately)`);
  console.log('\n✅ capstone check passed');
} finally {
  session?.close();
  for (const handle of handles) {
    try {
      handle.stop();
    } catch {
      // best effort on shutdown
    }
  }
}

async function serve(dir: string): Promise<AgentInstanceHandle> {
  const cardPath = new URL(`../../published/${dir}/agent-card.json`, import.meta.url);
  const handler = dir === 'openclaw_poster_maker' ? posterHandler : narratorHandler;
  const handle = await serveAgent({ cardPath, handler });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !handle.controlChannel) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(handle.controlChannel, `${dir} did not register within 15s`);
  await new Promise((r) => setTimeout(r, 500));
  return handle;
}

/** Discovery can lag a freshly served instance; retry briefly. */
async function discoverHandle(s: BlocksSession, tag: string, wanted: string): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const agents = await s.discover(tag);
    if (agents.some((a) => a.handle === wanted)) return wanted;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`"${wanted}" not found via discover("${tag}") — was it published?`);
}

async function assertSavedFile(
  data: unknown,
  mimeType: string,
  magic?: number[],
): Promise<FileArtifact> {
  const file = data as FileArtifact;
  assert(file && file.kind === 'file', `expected a saved file, got ${JSON.stringify(data)}`);
  assert(file.mimeType === mimeType, `expected ${mimeType}, got ${file.mimeType}`);

  const absolute = fileURLToPath(new URL(`../../${file.path}`, import.meta.url));
  const bytes = await readFile(absolute);
  assert(bytes.byteLength > 1_000, `${file.path} is implausibly small (${bytes.byteLength} bytes)`);
  if (magic) {
    assert(
      magic.every((b, i) => bytes[i] === b),
      `${file.path} does not start with the expected magic bytes`,
    );
  } else {
    // MP3: ID3 header or a raw MPEG frame sync.
    const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const sync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    assert(id3 || sync, `${file.path} does not look like an MP3`);
  }
  return file;
}
