/**
 * Print the Blocks account this terminal is authenticated as, without
 * exposing the API key. Prefer the official CLI (`blocks whoami --json`) and
 * fall back to the local credential file so this still works when `blocks`
 * is not on PATH outside npm scripts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

type BlocksWhoami = {
  org_name?: string;
  orgName?: string;
  org_id?: string;
  orgId?: string;
  key_id?: string;
  keyId?: string;
  expires_at?: string;
  expiresAt?: string;
  days_remaining?: number;
  daysRemaining?: number;
  expired?: boolean;
  api_key?: string;
  apiKey?: string;
  BLOCKS_API_KEY?: string;
};

function readJson(path: string): BlocksWhoami | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as BlocksWhoami;
  } catch {
    return null;
  }
}

function whoamiFromCli(): BlocksWhoami | null {
  const run = spawnSync('blocks', ['whoami', '--json'], { encoding: 'utf8' });
  if (run.status !== 0) return null;
  try {
    return JSON.parse(run.stdout) as BlocksWhoami;
  } catch {
    return null;
  }
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/gu, '');
    out[match[1]] = value;
  }
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function accountView(source: string, value: BlocksWhoami | null) {
  const expiresAt = firstString(value?.expires_at, value?.expiresAt);
  const computedDaysRemaining = expiresAt
    ? Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000)
    : null;
  return {
    source,
    loggedIn: Boolean(value),
    orgName: firstString(value?.org_name, value?.orgName) ?? null,
    orgId: firstString(value?.org_id, value?.orgId) ?? null,
    keyId: firstString(value?.key_id, value?.keyId) ?? null,
    expiresAt: expiresAt ?? null,
    daysRemaining: value?.days_remaining ?? value?.daysRemaining ?? computedDaysRemaining,
    expired: value?.expired ?? (computedDaysRemaining === null ? null : computedDaysRemaining < 0),
  };
}

const rootEnvPath = resolve(process.cwd(), '..', '.env');
const agentEnvPath = resolve(process.cwd(), '.env');
const credentialsPath = resolve(homedir(), '.config/blocks/credentials.json');

const cli = whoamiFromCli();
const credentials = readJson(credentialsPath);
const account = cli ?? credentials;
const source = cli ? 'blocks whoami --json' : credentials ? credentialsPath : 'none';

const rootEnv = readEnv(rootEnvPath);
const agentEnv = readEnv(agentEnvPath);
const envKey = process.env.BLOCKS_API_KEY ?? agentEnv.BLOCKS_API_KEY ?? rootEnv.BLOCKS_API_KEY;
const credentialKey = firstString(credentials?.api_key, credentials?.apiKey, credentials?.BLOCKS_API_KEY);
const envMatchesCredentialFile = Boolean(envKey && credentialKey && envKey === credentialKey);

console.log(JSON.stringify({
  ok: Boolean(account),
  account: accountView(source, account),
  credentialFile: {
    path: credentialsPath,
    exists: Boolean(credentials),
  },
  projectEnv: {
    rootEnvPath,
    rootHasBlocksApiKey: Boolean(rootEnv.BLOCKS_API_KEY),
    agentEnvPath,
    agentHasBlocksApiKey: Boolean(agentEnv.BLOCKS_API_KEY),
    processHasBlocksApiKey: Boolean(process.env.BLOCKS_API_KEY),
    envKeyMatchesCredentialFile: envMatchesCredentialFile,
    note: envKey && !envMatchesCredentialFile
      ? 'The project/process BLOCKS_API_KEY differs from ~/.config/blocks/credentials.json; app scripts may use a different Blocks account than the CLI login.'
      : 'The project/process BLOCKS_API_KEY matches the CLI credential file, or no project key is set.',
  },
}, null, 2));

if (!account) {
  console.error('\nNot logged in. Run: blocks login --write-env');
  process.exitCode = 1;
}
