/**
 * assistant-factory — render a per-owner private assistant (Phase PA-2).
 *
 * Given an owner + their Blocks identity, this produces the two on-disk
 * artifacts for a `pa_<owner>` agent:
 *   - agent-card.json  (listing: private, billingMode: free by default)
 *   - handler.ts       (a FIXED template; the owner identity is the only
 *                       thing substituted in, via JSON.stringify — no eval,
 *                       no LLM-authored TypeScript. Same safety story as the
 *                       agent-factory's __SKILL_NAME__ substitution.)
 *
 * The handler is intentionally tiny: it bakes the OwnerPolicy and defers
 * all logic to the vetted shared runtime (assistant-runtime.ts).
 *
 * This module is OFFLINE and side-effect-light: render functions are pure;
 * writeAssistant only touches the local filesystem. It does NOT publish or
 * serve — that is the dashboard's create endpoint (later in PA-2), which
 * burns a permanent name and needs a real key.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface RenderAssistantOptions {
  /** Human owner label, e.g. "alice@acme". Used for display + slug. */
  owner: string;
  /** Blocks ownerId the handler authorizes against (required). */
  ownerId: string;
  /** Optional Blocks orgId to also require. */
  orgId?: string;
  /** Override the derived handle slug (defaults to a slug of `owner`). */
  slug?: string;
  /** Override the default private/free posture from env. */
  listing?: string;
  billingMode?: string;
}

export interface RenderedAssistant {
  agentName: string;
  card: Record<string, unknown>;
  handlerSource: string;
}

/** Thrown when the desired handle is already taken. Blocks names are
 *  permanent (no unpublish), so a collision is fatal — pick another slug. */
export class AssistantNameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantNameConflictError';
  }
}

export interface CreateAssistantOptions extends RenderAssistantOptions {
  /** Materialize the files to disk. Even when true, NOTHING is published
   *  or served — that is a separate, explicit live step. Defaults to false
   *  (preview only). */
  write?: boolean;
  /** Known agent handles to check the new name against (collision = fatal). */
  existing?: string[];
  /** Override where files are written (defaults to agent/published). */
  baseDir?: string;
}

export interface CreateAssistantResult {
  ok: true;
  /** Always true in this phase — create never publishes or serves. */
  dryRun: true;
  agentName: string;
  card: Record<string, unknown>;
  handlerSource: string;
  plannedPaths: { dir: string; cardPath: string; handlerPath: string };
  written?: { dir: string; cardPath: string; handlerPath: string };
}

function defaultPublishedRoot(): string {
  return fileURLToPath(new URL('../../published', import.meta.url));
}

/** Derive a Blocks-safe handle slug from an owner label. */
export function slugifyOwner(owner: string): string {
  const slug = owner
    .toLowerCase()
    .replace(/@.*$/u, '') // drop the email domain
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 24);
  if (!slug) throw new Error(`cannot derive an assistant slug from owner "${owner}"`);
  return slug;
}

/** Render the agent-card + handler source for a per-owner assistant. */
export function renderAssistant(opts: RenderAssistantOptions): RenderedAssistant {
  const ownerId = opts.ownerId?.trim();
  if (!ownerId) throw new Error('renderAssistant requires a non-empty ownerId');

  const slug = (opts.slug?.trim() || slugifyOwner(opts.owner));
  const agentName = `pa_${slug}`;
  const listing = normalizeOption(opts.listing ?? process.env.PA_DEFAULT_LISTING, ['private', 'public'], 'private');
  const billingMode = normalizeOption(opts.billingMode ?? process.env.PA_DEFAULT_BILLING, ['free', 'paid'], 'free');
  const orgId = opts.orgId?.trim();

  const card = {
    identity: {
      agentName,
      displayName: `Personal Assistant — ${opts.owner}`,
      description: `Private personal assistant for ${opts.owner}. Owner-only; decides via the personal_assistant brain and delegates to network specialists. Not publicly discoverable.`,
      version: '1.0.0',
      provider: { organization: 'openclaw-foundation' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [
        {
          id: 'request',
          description: "The owner's natural-language request.",
          contentType: 'application/json',
          required: true,
          example: { text: 'Make me a poster for our offsite.' },
          schema: {
            type: 'object',
            required: ['text'],
            properties: { text: { type: 'string' } },
          },
        },
      ],
      outputs: personalAssistantOutputs(),
    },
    tags: [
      {
        id: 'personal-assistant',
        name: 'Personal Assistant',
        description: 'Private per-owner assistant. Not intended for public discovery.',
      },
    ],
    extensions: {
      blocks: {
        billingMode,
        pricePerTask: '0.000',
        listing,
      },
    },
    runtime: {
      handler: './handler.ts',
      handlerExport: 'default',
      concurrency: 1,
      expectedInstances: 1,
      maxRunningTimeSec: 120,
    },
  };

  const handlerSource = renderHandlerSource(agentName, opts.owner, ownerId, orgId);
  return { agentName, card, handlerSource };
}

function personalAssistantOutputs(): Array<Record<string, unknown>> {
  return [
    {
      id: 'reply',
      description: 'Human-readable assistant response for the Blocks dashboard.',
      contentType: 'text/markdown',
      guaranteed: true,
      example: "I checked your calendar and you're free tomorrow afternoon.",
    },
    {
      id: 'result',
      description: 'Full structured assistant result JSON for programmatic callers.',
      contentType: 'application/json',
      guaranteed: true,
      example: { ok: true, reply: 'On it...', actions: [{ kind: 'answer-direct' }] },
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
    },
    {
      id: 'actions',
      description: 'Planned assistant actions when the request uses tools, integrations, or peer agents.',
      contentType: 'application/json',
      guaranteed: false,
      example: [{ kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'tomorrow afternoon' } }],
      schema: { type: 'array' },
    },
  ];
}

/** Node's --env-file preserves inline comments in values (`foo # comment`).
 *  Keep hosted generation resilient by reading the first token and falling
 *  back closed when it is not one of the allowed Blocks values. */
function normalizeOption<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const token = raw?.trim().split(/\s+/u)[0] as T | undefined;
  return token && allowed.includes(token) ? token : fallback;
}

/** The fixed handler template. The ONLY substituted values are the owner
 *  identity (escaped via JSON.stringify) — no logic is generated. */
function renderHandlerSource(
  agentName: string,
  owner: string,
  ownerId: string,
  orgId: string | undefined,
): string {
  const policyFields = [`ownerId: ${JSON.stringify(ownerId)}`];
  if (orgId) policyFields.push(`orgId: ${JSON.stringify(orgId)}`);
  const policyLiteral = `{ ${policyFields.join(', ')} }`;

  return `/**
 * ${agentName} — auto-generated PRIVATE personal assistant (Phase PA-2).
 * Owner: ${owner}
 *
 * Generated by agent/src/assistant/assistant-factory.ts. Do NOT edit by hand —
 * regenerate instead. The owner identity below is the only baked-in value;
 * all logic lives in the vetted shared runtime (assistant-runtime.ts).
 */

import type { HandlerResult, StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { loadRootEnv } from '../../src/env.ts';
import { runAssistant } from '../../src/assistant/assistant-runtime.ts';
import type { OwnerPolicy } from '../../src/server/authorize.ts';

loadRootEnv();

// Baked owner binding — only this caller may drive the assistant.
const OWNER_POLICY: OwnerPolicy = ${policyLiteral};

export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  return runAssistant(task, ctx, OWNER_POLICY, { selfHandle: ${JSON.stringify(agentName)} });
}
`;
}

/**
 * Write the rendered assistant to `agent/published/<agentName>/`.
 * Returns the absolute paths written. Does NOT publish or serve.
 */
export async function writeAssistant(
  opts: RenderAssistantOptions,
  baseDir?: string,
): Promise<{ agentName: string; dir: string; cardPath: string; handlerPath: string }> {
  const rendered = renderAssistant(opts);
  const publishedRoot = baseDir ?? defaultPublishedRoot();
  const dir = `${publishedRoot}/${rendered.agentName}`;
  await mkdir(dir, { recursive: true });
  const cardPath = `${dir}/agent-card.json`;
  const handlerPath = `${dir}/handler.ts`;
  await writeFile(cardPath, `${JSON.stringify(rendered.card, null, 2)}\n`, 'utf8');
  await writeFile(handlerPath, rendered.handlerSource, 'utf8');
  return { agentName: rendered.agentName, dir, cardPath, handlerPath };
}

/**
 * Dry-run create: render (and optionally write) a per-owner assistant,
 * after a name-collision check. This NEVER publishes or serves — going
 * live (which burns a permanent name and needs a real key) is a separate,
 * explicit step. Safe to run offline.
 */
export async function createAssistant(opts: CreateAssistantOptions): Promise<CreateAssistantResult> {
  const rendered = renderAssistant(opts);

  if (opts.existing?.includes(rendered.agentName)) {
    throw new AssistantNameConflictError(
      `agent "${rendered.agentName}" already exists — Blocks names are permanent (no unpublish); choose a different slug`,
    );
  }

  const publishedRoot = opts.baseDir ?? defaultPublishedRoot();
  const dir = `${publishedRoot}/${rendered.agentName}`;
  const plannedPaths = {
    dir,
    cardPath: `${dir}/agent-card.json`,
    handlerPath: `${dir}/handler.ts`,
  };

  const written = opts.write ? await writeAssistant(opts, publishedRoot) : undefined;

  return {
    ok: true,
    dryRun: true,
    agentName: rendered.agentName,
    card: rendered.card,
    handlerSource: rendered.handlerSource,
    plannedPaths,
    written,
  };
}
