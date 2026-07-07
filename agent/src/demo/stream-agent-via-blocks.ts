/**
 * Blocks demo — STREAM from your agent over Blocks with taskKind "pipe".
 *
 * Same idea as call-agent-via-blocks.ts (send a prompt, get the answer), but
 * instead of waiting for the whole result it opens a live stream and prints
 * tokens as they arrive — the "pipe" task kind on Blocks.
 *
 * Run it:
 *   node --experimental-strip-types src/demo/stream-agent-via-blocks.ts "your prompt here"
 *
 * Needs BLOCKS_API_KEY in your root .env, and a running instance of an agent
 * that (a) declares "pipe" in its agent-card capabilities.taskKinds and
 * (b) actually opens a stream in its handler. Point at one with DEMO_AGENT_NAME.
 */

import { TaskClient, textPart } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';

loadRootEnv();

// Target agent handle. Must support the "pipe" task kind (e.g. pa_demo_private
// declares ["request", "pipe"]). Override with DEMO_AGENT_NAME=<handle>.
const AGENT_NAME = process.env.DEMO_AGENT_NAME ?? 'my_personal_agent';

const prompt = process.argv.slice(2).join(' ') || 'Hello from the Blocks Network!';

const client = await TaskClient.create({
  billingMode: 'free',
  apiKey: process.env.BLOCKS_API_KEY,
});

// Ask for a streaming task: taskKind "pipe" plus how long (seconds) to keep
// the pipe open. Everything else is the same send as the one-shot version.
const session = await client.sendMessage({
  agentName: AGENT_NAME,
  taskKind: 'pipe',
  duration: 30,
  requestParts: [textPart(JSON.stringify({ text: prompt }), 'request')],
});

session.onProgress((event) => console.error('progress:', event.message ?? event));

// waitForStream() has no built-in timeout, so race it against the task's
// terminal event — if the agent finishes without ever opening a stream we
// fall back to reading its artifacts instead of hanging on camera.
const streamRef = await Promise.race([
  session.waitForStream(),
  session.waitForTerminal(120_000).then(() => null),
]);

if (streamRef) {
  console.error('--- streaming ---');
  const stream = streamRef.open();
  const decoder = new TextDecoder();
  for await (const chunk of stream.bytes()) {
    process.stdout.write(decoder.decode(chunk)); // token(s) as they land
  }
  process.stdout.write('\n');
}

// Make sure the task is done, then print any final artifact (also covers the
// no-stream fallback case).
const terminal = await session.waitForTerminal(120_000);
if (terminal.state !== 'completed') {
  console.error(`agent finished with state: ${terminal.state}`);
}
if (!streamRef) {
  for (const ref of session.listArtifacts()) {
    const artifact = await session.downloadArtifact(ref);
    console.log('answer:', new TextDecoder().decode(artifact.data));
  }
}

session.close();
client.destroy();
