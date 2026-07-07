#!/usr/bin/env node
/**
 * Provision local published folders for standing private assistants.
 *
 * This keeps per-owner generated handlers out of git while making EC2
 * restarts deterministic: store the owner bindings in an ignored config file,
 * then this script asks the bridge to regenerate the folders with the current
 * source layout before `serve-agents.sh` serves them.
 *
 * Config file (default: data/config/personal-assistants.json):
 * [
 *   { "owner": "Markus Kohler", "ownerId": "...", "orgId": "...", "slug": "markus" },
 *   { "owner": "Bob Local", "ownerId": "...", "orgId": "...", "slug": "bob" }
 * ]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const baseUrl = (process.env.BRIDGE_URL || 'http://127.0.0.1:18888').replace(/\/+$/u, '');
const configPath = resolve(process.cwd(), process.env.PA_ASSISTANTS_CONFIG || 'data/config/personal-assistants.json');
const inlineConfig = process.env.PA_ASSISTANTS_JSON?.trim();

function loadConfig() {
  if (inlineConfig) return JSON.parse(inlineConfig);
  if (!existsSync(configPath)) return [];
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function assertAssistant(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`assistant spec #${index + 1} must be an object`);
  }
  for (const key of ['owner', 'ownerId']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`assistant spec #${index + 1} is missing "${key}"`);
    }
  }
  for (const key of ['orgId', 'slug']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`assistant spec #${index + 1} "${key}" must be a string when present`);
    }
  }
  return {
    owner: value.owner.trim(),
    ownerId: value.ownerId.trim(),
    ...(value.orgId?.trim() ? { orgId: value.orgId.trim() } : {}),
    ...(value.slug?.trim() ? { slug: value.slug.trim() } : {}),
    write: true,
    replace: true,
  };
}

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw new Error(`${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }
  return json;
}

const raw = loadConfig();
if (!Array.isArray(raw)) throw new Error(`${configPath} must contain a JSON array`);

if (raw.length === 0) {
  console.log(`[provision-pa] no assistant specs found (${configPath}); skipping`);
  process.exit(0);
}

for (let i = 0; i < raw.length; i += 1) {
  const spec = assertAssistant(raw[i], i);
  const result = await postJson('/api/assistant/create', spec);
  console.log(`[provision-pa] ${result.agentName} written for ${spec.owner}`);
}
