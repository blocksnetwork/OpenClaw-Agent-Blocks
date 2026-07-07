/**
 * Blocks demo — transcribe a file with the real Blocks SDK.
 *
 *   node --experimental-strip-types src/demo/transcribe-demo.ts ./your-file
 */

import { TaskClient, filePartFromPath } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';

loadRootEnv();

const client = await TaskClient.create({
  billingMode: 'free',
  apiKey: process.env.BLOCKS_API_KEY,
});

const session = await client.sendMessage({
  agentName: 'openclaw_transcriber',
  requestParts: [
    await filePartFromPath(process.argv[2] ?? './your-file', { partId: 'request' }),
  ],
});

session.onProgress((event) => console.log('Progress:', event));

const terminal = await session.waitForTerminal(60_000);
console.log('Done:', terminal.state);

for (const ref of session.listArtifacts()) {
  const artifact = await session.downloadArtifact(ref);
  console.log(new TextDecoder().decode(artifact.data));
}

session.close();
client.destroy();
