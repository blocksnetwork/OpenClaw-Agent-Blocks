import { connect } from '../blocks/blocks-client.ts';
import { loadRootEnv } from '../env.ts';

const OWN_AGENT = 'openclaw_echo_normalizer';
const OWN_SKILL = 'openclaw-echo-normalize';

loadRootEnv();

if (!process.env.BLOCKS_API_KEY) {
  console.log('↷ Own Blocks agent check skipped: BLOCKS_API_KEY is not set');
  process.exit(0);
}

process.env.FOUNDATION_OFFLINE = '0';

const session = await connect({ latencyScale: 0 });

try {
  const agents = await session.discover(OWN_SKILL);
  const ownAgent = agents.find((agent) => agent.handle === OWN_AGENT);
  if (!ownAgent) {
    throw new Error(
      `published agent "${OWN_AGENT}" was not found by discover("${OWN_SKILL}")`,
    );
  }

  const result = await session.call(ownAgent.handle, OWN_SKILL, { text: '  Hello WORLD ' });
  if (!isRecord(result.data) || result.data.ok !== true || result.data.normalized !== 'hello world') {
    throw new Error(`unexpected own-agent result: ${JSON.stringify(result.data)}`);
  }

  console.log(
    `✅ own agent passed: ${result.meta.handle} [${result.meta.skill}] ${result.meta.latencyMs}ms $${result.meta.costUsd.toFixed(3)}`,
  );
} finally {
  session.close();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
