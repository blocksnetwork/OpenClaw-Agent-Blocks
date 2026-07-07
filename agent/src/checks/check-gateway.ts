import { loadRootEnv } from '../env.ts';
import { runSkill } from '../blocks/openclaw-client.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '0';

const result = await runSkill('echo_check', { text: '  Hello WORLD ' });
assertEchoCheck(result);

console.log('✅ gateway echo_check passed');

function assertEchoCheck(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(`echo_check returned non-object JSON: ${JSON.stringify(value)}`);
  }

  if (value.ok !== true || value.normalized !== 'hello world') {
    throw new Error(
      `echo_check returned ${JSON.stringify(value)}, expected {"ok":true,"normalized":"hello world"}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
