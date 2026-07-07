/**
 * Blocks demo — call your agent DIRECTLY over Blocks (no local proxy).
 *
 * This does the same thing the web frontend does (send a prompt, get the
 * answer back), except instead of POSTing to the bridge's /v1/chat/completions
 * proxy, it goes straight through the Blocks network with the SDK's TaskClient.
 *
 * Run it:
 *   node --experimental-strip-types src/demo/call-agent-via-blocks.ts "your prompt here"
 *
 * Needs BLOCKS_API_KEY in your root .env, and an instance of the target agent
 * actually running on the network (e.g. `blocks run` / `blocks serve`).
 */

import { TaskClient, textPart } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';

loadRootEnv();

// The agent handle you want to reach. This is the published agent, called by
// name over Blocks — exactly what a peer's agent would do to reach yours.
const AGENT_NAME = process.env.DEMO_AGENT_NAME ?? 'my_personal_agent';

const prompt = process.argv.slice(2).join(' ') || 'Hello from the Blocks Network!';

// Open the one outbound connection to Blocks with your API key.
const client = await TaskClient.create({
  billingMode: 'free',
  apiKey: process.env.BLOCKS_API_KEY,
});

// Send the prompt to the agent by handle — same shape the bridge uses.
const session = await client.sendMessage({
  agentName: AGENT_NAME,
  requestParts: [textPart(JSON.stringify({ text: prompt }), 'request')],
});

session.onProgress((event) => console.log('progress:', event.message ?? event));

const terminal = await session.waitForTerminal(120_000);
if (terminal.state !== 'completed') {
  console.error(`agent finished with state: ${terminal.state}`);
  session.close();
  client.destroy();
  process.exit(1);
}

// Pull the answer out of the returned artifact and print it.
for (const ref of session.listArtifacts()) {
  const artifact = await session.downloadArtifact(ref);
  console.log('\nanswer:', new TextDecoder().decode(artifact.data));
}

session.close();
client.destroy();
