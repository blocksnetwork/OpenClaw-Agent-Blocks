/**
 * Phase PA-2 offline gate — the dry-run assistant create flow.
 *
 * Asserts, with no key and no network, that createAssistant():
 *   1. preview (write: false) — returns dryRun:true + the rendered card +
 *      handler, plans the paths, and writes NOTHING to disk.
 *   2. write: true — materializes the two files to a temp dir (still no
 *      publish/serve), then we clean up.
 *   3. name collision — a taken handle throws AssistantNameConflictError
 *      (Blocks names are permanent).
 *
 * This exercises the same code the dashboard's POST /api/assistant/create
 * wraps (the dashboard adds only the PERSONAL_ASSISTANTS_ENABLED gate and
 * HTTP framing).
 *
 *   npm run check:assistant-create
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAssistant, AssistantNameConflictError } from '../assistant/assistant-factory.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const OWNER = { owner: 'alice@acme', ownerId: 'owner-uuid-alice', orgId: 'org-uuid-acme' };

let tmp: string | undefined;

try {
  tmp = await mkdtemp(join(tmpdir(), 'pa-create-'));

  // 1. preview — no disk writes.
  const preview = await createAssistant({ ...OWNER, baseDir: tmp });
  assert(preview.dryRun === true, 'create must be dry-run (never publishes/serves)');
  assert(preview.agentName === 'pa_alice', `expected pa_alice, got ${preview.agentName}`);
  assert(preview.written === undefined, 'preview must not write files');
  assert(typeof preview.handlerSource === 'string' && preview.handlerSource.length > 0, 'preview must include handler source');
  assert(!!preview.card && typeof preview.card === 'object', 'preview must include the card');
  assert(!(await exists(preview.plannedPaths.dir)), 'preview must NOT create the agent dir on disk');
  console.log(`▸ preview: ${preview.agentName} planned at ${preview.plannedPaths.dir} (nothing written) ✓`);

  // 2. write — files materialize, still no publish/serve.
  const written = await createAssistant({ ...OWNER, write: true, baseDir: tmp });
  assert(written.written, 'write:true must report written paths');
  assert(await exists(written.written.cardPath), 'card file must exist after write');
  assert(await exists(written.written.handlerPath), 'handler file must exist after write');
  console.log(`▸ write: materialized ${written.agentName} card + handler under temp dir ✓`);

  // 3. collision — taken handle is fatal.
  let threw = false;
  try {
    await createAssistant({ ...OWNER, baseDir: tmp, existing: ['pa_alice'] });
  } catch (err) {
    threw = err instanceof AssistantNameConflictError;
  }
  assert(threw, 'a name collision must throw AssistantNameConflictError');
  console.log('▸ collision: taken handle rejected (names are permanent) ✓');

  console.log('\n✅ assistant-create check passed');
} catch (err) {
  console.error(`❌ assistant-create check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (tmp) await rm(tmp, { recursive: true, force: true });
}
