/**
 * gmail-mcp - the LIVE half of the `use-integration` Gmail read/draft path
 * (Phase 3.1).
 *
 * The personal-assistant brain PLANS `email.*` actions; the runtime executes
 * them through this module, which maps our stable tool names to a Gmail MCP
 * server. The pinned server is `@klodr/gmail-mcp` (a maintained, scope-gated
 * fork of the GongRzhe Gmail MCP), whose tools are `search_emails`,
 * `read_email`, `draft_email`, and `send_email`. It reads the same per-owner
 * Connect-Google token via GMAIL_OAUTH_PATH / GMAIL_CREDENTIALS_PATH (wired in
 * integration-store.ts), so no separate Gmail OAuth flow is required. The
 * mapping and normalization are pure so checks can run with a fake caller; the
 * stdio transport is isolated behind env-gated helpers.
 */

import type { RunIntegration } from '../assistant/assistant-runtime.ts';
import { textOf, type McpCaller, type McpToolResult } from './calendar-mcp.ts';

export type { McpCaller, McpToolResult } from './calendar-mcp.ts';

export interface GmailRunOptions {
  maxResults?: number;
  /** Env overrides for a specific owner/integration runner. */
  env?: NodeJS.ProcessEnv;
}

export function normalizeMessageList(result: McpToolResult): Record<string, unknown> {
  const raw = textOf(result);
  let messages: unknown = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      messages = parsed;
    } else if (isRecord(parsed)) {
      if (Array.isArray(parsed.messages)) messages = parsed.messages;
      else if (Array.isArray(parsed.items)) messages = parsed.items;
      else messages = parsed;
    }
  } catch {
    // Plain-text server output is still useful to the assistant/user.
  }

  return {
    ok: result.isError !== true,
    tool: 'email.list',
    messages,
    raw,
  };
}

export function normalizeMessage(result: McpToolResult): Record<string, unknown> {
  const raw = textOf(result);
  let message: unknown = raw;
  try {
    message = JSON.parse(raw) as unknown;
  } catch {
    // Plain text is an acceptable fallback for read results.
  }

  return {
    ok: result.isError !== true,
    tool: 'email.read',
    message,
    raw,
  };
}

export function normalizeDraft(result: McpToolResult): Record<string, unknown> {
  const raw = textOf(result);
  let draft: unknown = raw;
  try {
    draft = JSON.parse(raw) as unknown;
  } catch {
    // Plain text is an acceptable fallback for draft creation results.
  }

  return {
    ok: result.isError !== true,
    tool: 'email.draft',
    draft,
    raw,
  };
}

export function normalizeSend(result: McpToolResult): Record<string, unknown> {
  const raw = textOf(result);
  let sent: unknown = raw;
  try {
    sent = JSON.parse(raw) as unknown;
  } catch {
    // Plain text is an acceptable fallback for send results.
  }

  return {
    ok: result.isError !== true,
    tool: 'email.send',
    sent,
    raw,
  };
}

export function makeGmailRunIntegration(caller: McpCaller, opts: GmailRunOptions = {}): RunIntegration {
  const maxResults = opts.maxResults && opts.maxResults > 0 ? opts.maxResults : 10;

  return async (tool, args) => {
    const a = args ?? {};
    if (tool === 'email.list') {
      const query = firstString(a.query, a.q, a.search);
      const limit = typeof a.maxResults === 'number' && a.maxResults > 0 ? a.maxResults : maxResults;
      const res = await caller.callTool('search_emails', { query, maxResults: limit });
      return normalizeMessageList(res);
    }
    if (tool === 'email.read') {
      const messageId = firstString(a.messageId, a.id, a.query);
      const res = await caller.callTool('read_email', { messageId });
      return normalizeMessage(res);
    }
    if (tool === 'email.draft') {
      const res = await caller.callTool('draft_email', {
        to: recipients(a.to),
        subject: firstString(a.subject),
        body: firstString(a.body, a.text, a.query),
        ...(firstString(a.threadId) ? { threadId: firstString(a.threadId) } : {}),
      });
      return normalizeDraft(res);
    }
    if (tool === 'email.send') {
      const res = await caller.callTool('send_email', {
        to: recipients(a.to),
        subject: firstString(a.subject),
        body: firstString(a.body, a.text, a.query),
        ...(firstString(a.threadId) ? { threadId: firstString(a.threadId) } : {}),
      });
      return normalizeSend(res);
    }
    throw new Error(
      `unsupported email tool "${tool}" - supports email.list, email.read, email.draft, and gated email.send`,
    );
  };
}

// -- live transport (gated; only loaded on the live path) -----------------

export async function connectGmailMcpFromEnv(envSource: NodeJS.ProcessEnv = process.env): Promise<{ caller: McpCaller; close: () => Promise<void> }> {
  const command = (envSource.PA_GMAIL_MCP_CMD ?? '').trim();
  if (!command) {
    throw new Error('PA_GMAIL_MCP_CMD is not set; cannot connect to a Gmail MCP server');
  }
  const rawArgs = (envSource.PA_GMAIL_MCP_ARGS ?? '').trim();
  const args = rawArgs ? rawArgs.split(/\s+/u) : [];

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envSource)) {
    if (typeof v === 'string') env[k] = v;
  }

  const transport = new StdioClientTransport({ command, args, env });
  const client = new Client({ name: 'openclaw-foundation-gmail-bridge', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  const caller: McpCaller = {
    async callTool(name, toolArgs) {
      const res = await client.callTool({ name, arguments: toolArgs });
      return res as unknown as McpToolResult;
    },
  };
  return { caller, close: () => client.close() };
}

export function makeEnvGmailRunIntegration(opts: Pick<GmailRunOptions, 'env'> = {}): RunIntegration {
  const env = opts.env ?? process.env;
  const maxResults = Number(env.PA_GMAIL_MAX_RESULTS ?? '10') || 10;
  let cached: { caller: McpCaller; close: () => Promise<void> } | null = null;
  return async (tool, args, runOpts) => {
    if (!cached) cached = await connectGmailMcpFromEnv(env);
    const run = makeGmailRunIntegration(cached.caller, { maxResults });
    try {
      return await run(tool, args, runOpts);
    } catch (err) {
      try {
        await cached?.close();
      } catch {
        // best effort
      }
      cached = null;
      throw err;
    }
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/** @klodr/gmail-mcp expects `to`/`cc`/`bcc` as string arrays; accept a single
 *  address, a comma-separated string, or an array and normalize to an array. */
function recipients(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(',').map((v) => v.trim()).filter((v) => v !== '');
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
