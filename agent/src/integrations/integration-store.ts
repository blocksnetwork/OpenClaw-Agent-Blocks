/**
 * integration-store - per-owner integration credential pointers.
 *
 * Records live under agent/data/integrations/ (gitignored). They may contain
 * token file pointers or inline token JSON, so every filename is derived from
 * a sanitized ownerId and provider pair, never from raw path input.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type IntegrationProvider = 'google';

export interface IntegrationRecord {
  provider: IntegrationProvider;
  tokenPath?: string;
  token?: Record<string, unknown>;
  scopes: string[];
  connectedAt: string;
}

export interface IntegrationStoreOptions {
  baseDir?: string;
}

interface OwnerIntegrationFile {
  ownerId: string;
  integrations: Partial<Record<IntegrationProvider, IntegrationRecord>>;
}

function integrationsDir(baseDir?: string): string {
  return baseDir ?? fileURLToPath(new URL('../../data/integrations', import.meta.url));
}

export function sanitizeOwnerId(ownerId: string): string {
  const trimmed = ownerId.trim();
  if (!trimmed) throw new Error('ownerId is required');
  return trimmed.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 120) || 'owner';
}

export function integrationStorePath(ownerId: string, opts: IntegrationStoreOptions = {}): string {
  return `${integrationsDir(opts.baseDir)}/${sanitizeOwnerId(ownerId)}.json`;
}

export async function saveIntegration(
  ownerId: string,
  record: IntegrationRecord,
  opts: IntegrationStoreOptions = {},
): Promise<void> {
  const file = await readOwnerFile(ownerId, opts);
  const normalized = normalizeRecord(record);
  file.integrations[normalized.provider] = normalized;
  await writeOwnerFile(ownerId, file, opts);
}

export async function loadIntegration(
  ownerId: string,
  provider: IntegrationProvider,
  opts: IntegrationStoreOptions = {},
): Promise<IntegrationRecord | null> {
  const file = await readOwnerFile(ownerId, opts);
  return file.integrations[provider] ?? null;
}

export async function listIntegrations(
  ownerId: string,
  opts: IntegrationStoreOptions = {},
): Promise<IntegrationRecord[]> {
  const file = await readOwnerFile(ownerId, opts);
  return Object.values(file.integrations).filter((record): record is IntegrationRecord => Boolean(record));
}

export async function removeIntegration(
  ownerId: string,
  provider: IntegrationProvider,
  opts: IntegrationStoreOptions = {},
): Promise<void> {
  const file = await readOwnerFile(ownerId, opts);
  delete file.integrations[provider];
  await writeOwnerFile(ownerId, file, opts);
  await rm(inlineTokenPath(ownerId, provider, opts), { force: true });
}

/**
 * Return a token file path for MCP servers. Existing tokenPath records win;
 * inline token records are materialized into a gitignored provider token file.
 */
export async function resolveIntegrationTokenPath(
  ownerId: string,
  provider: IntegrationProvider,
  opts: IntegrationStoreOptions = {},
): Promise<string | null> {
  const record = await loadIntegration(ownerId, provider, opts);
  if (!record) return null;
  if (record.tokenPath && record.tokenPath.trim()) return record.tokenPath;
  if (!record.token) return null;

  const path = inlineTokenPath(ownerId, provider, opts);
  await mkdir(integrationsDir(opts.baseDir), { recursive: true });
  await writeFile(path, `${JSON.stringify(record.token, null, 2)}\n`, 'utf8');
  return path;
}

export async function googleIntegrationEnvForOwner(
  ownerId: string | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
  opts: IntegrationStoreOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...envSource };
  if (!ownerId) return env;

  const tokenPath = await resolveIntegrationTokenPath(ownerId, 'google', opts);
  if (!tokenPath) return env;
  // @cocal/google-calendar-mcp reads GOOGLE_CALENDAR_MCP_TOKEN_PATH.
  env.GOOGLE_CALENDAR_MCP_TOKEN_PATH = tokenPath;
  env.GOOGLE_GMAIL_MCP_TOKEN_PATH = tokenPath;
  // @klodr/gmail-mcp consumes the SAME Connect-Google token via these env
  // vars, so no separate Gmail OAuth flow is needed: GMAIL_CREDENTIALS_PATH
  // is the per-owner token file and GMAIL_OAUTH_PATH is the shared client.
  env.GMAIL_CREDENTIALS_PATH = tokenPath;
  if (env.GOOGLE_OAUTH_CREDENTIALS && env.GOOGLE_OAUTH_CREDENTIALS.trim()) {
    env.GMAIL_OAUTH_PATH = env.GOOGLE_OAUTH_CREDENTIALS;
  }
  return env;
}

function inlineTokenPath(
  ownerId: string,
  provider: IntegrationProvider,
  opts: IntegrationStoreOptions = {},
): string {
  return `${integrationsDir(opts.baseDir)}/${sanitizeOwnerId(ownerId)}.${provider}.token.json`;
}

async function readOwnerFile(
  ownerId: string,
  opts: IntegrationStoreOptions,
): Promise<OwnerIntegrationFile> {
  try {
    const raw = await readFile(integrationStorePath(ownerId, opts), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isOwnerFile(parsed)) {
      return {
        ownerId,
        integrations: parsed.integrations,
      };
    }
  } catch {
    // Missing or malformed files behave like an empty owner store.
  }
  return { ownerId, integrations: {} };
}

async function writeOwnerFile(
  ownerId: string,
  file: OwnerIntegrationFile,
  opts: IntegrationStoreOptions,
): Promise<void> {
  await mkdir(integrationsDir(opts.baseDir), { recursive: true });
  await writeFile(
    integrationStorePath(ownerId, opts),
    `${JSON.stringify({ ownerId, integrations: file.integrations }, null, 2)}\n`,
    'utf8',
  );
}

function normalizeRecord(record: IntegrationRecord): IntegrationRecord {
  return {
    provider: 'google',
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((scope) => typeof scope === 'string') : [],
    connectedAt: record.connectedAt || new Date().toISOString(),
    ...(record.tokenPath ? { tokenPath: record.tokenPath } : {}),
    ...(isRecord(record.token) ? { token: record.token } : {}),
  };
}

function isOwnerFile(value: unknown): value is OwnerIntegrationFile {
  return isRecord(value) && isRecord(value.integrations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
