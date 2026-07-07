import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AgentBlocksCredential {
  apiKey: string;
  source: string;
}

const DEFAULT_AGENT_KEYS_PATH = fileURLToPath(
  new URL('../../../data/secrets/agent-api-keys.json', import.meta.url),
);

export function defaultAgentApiKeysPath(): string {
  return DEFAULT_AGENT_KEYS_PATH;
}

export function blocksApiKeyEnvName(agentName: string): string {
  const suffix = agentName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return suffix ? `BLOCKS_API_KEY_${suffix}` : 'BLOCKS_API_KEY';
}

export function resolveAgentBlocksCredential(agentName: string): AgentBlocksCredential | undefined {
  const normalized = agentName.trim();
  if (!normalized) return undefined;

  const envName = blocksApiKeyEnvName(normalized);
  const envValue = process.env[envName]?.trim();
  if (envValue) return { apiKey: envValue, source: envName };

  const inlineJson = process.env.BLOCKS_AGENT_API_KEYS_JSON?.trim();
  if (inlineJson) {
    const value = keyFromMap(parseKeyMap(inlineJson, 'BLOCKS_AGENT_API_KEYS_JSON'), normalized);
    if (value) return { apiKey: value, source: `BLOCKS_AGENT_API_KEYS_JSON:${normalized}` };
  }

  const filePath = process.env.BLOCKS_AGENT_API_KEYS_PATH?.trim() || DEFAULT_AGENT_KEYS_PATH;
  if (!existsSync(filePath)) return undefined;

  const value = keyFromMap(parseKeyMap(readFileSync(filePath, 'utf8'), filePath), normalized);
  if (!value) return undefined;
  return { apiKey: value, source: `${filePath}:${normalized}` };
}

function parseKeyMap(raw: string, source: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object keyed by agent name`);
  }
  return parsed as Record<string, unknown>;
}

function keyFromMap(map: Record<string, unknown>, agentName: string): string | undefined {
  const envName = blocksApiKeyEnvName(agentName);
  const candidates = [
    agentName,
    agentName.toLowerCase(),
    agentName.toUpperCase(),
    envName,
  ];

  for (const candidate of candidates) {
    const value = apiKeyFromValue(map[candidate]);
    if (value) return value;
  }
  return undefined;
}

function apiKeyFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ['apiKey', 'api_key', 'BLOCKS_API_KEY']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
