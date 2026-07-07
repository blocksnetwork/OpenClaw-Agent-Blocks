import { connect } from '../blocks/blocks-client.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();

if (!process.env.BLOCKS_API_KEY) {
  console.log('↷ Blocks check skipped: BLOCKS_API_KEY is not set');
  process.exit(0);
}

process.env.FOUNDATION_OFFLINE = '0';

const skill = process.env.BLOCKS_SKILL ?? 'echo';
const session = await connect({ latencyScale: 0 });

try {
  const agents = await session.discover(skill);
  if (agents.length === 0) {
    throw new Error(`no live Blocks agent found for skill "${skill}"`);
  }

  const chosen = agents[0];
  const result = await session.call(chosen.handle, skill, { text: 'Hello from openclaw-foundation.' });
  if (result.meta.handle !== chosen.handle) {
    throw new Error(`called ${chosen.handle} but received metadata for ${result.meta.handle}`);
  }

  console.log(`✅ blocks ${skill} passed via ${chosen.handle}`);
} finally {
  session.close();
}
