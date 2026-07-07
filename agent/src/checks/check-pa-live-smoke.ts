/**
 * Workstream H gated live smoke — S1/S3/S6/S7 route coverage.
 *
 * Default CI-safe behavior: skips unless PA_LIVE_SMOKE=1.
 *
 * Live mode requires:
 *   PA_LIVE_SMOKE=1
 *   PA_BRAIN_LIVE=1
 *   FOUNDATION_OFFLINE=0
 *   OPENCLAW_GATEWAY_TOKEN
 *   BLOCKS_API_KEY
 *   PA_LIVE_SMOKE_OWNER_ID
 *   PA_LIVE_SMOKE_PEER_HANDLE
 *
 * The smoke uses the real gateway brain for the selected use-case prompts,
 * the live Blocks catalog for S7, and a real direct-handle A2A call to the
 * configured test peer for S1. Google write tools are exercised through an
 * injected no-op integration runner so this check never mutates calendar or
 * Gmail unless a separate operator-owned live Google check is added.
 *
 *   npm run check:pa-live-smoke
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage, TaskContext } from '@blocks-network/sdk';

import { buildA2ARequest } from '../a2a/a2a.ts';
import { makeLiveSendA2A } from '../a2a/a2a-transport.ts';
import { defaultSharePolicy, saveRoster } from '../assistant/assistant-roster.ts';
import {
  planRequest,
  runAssistant,
  type AssistantPlan,
  type RunIntegration,
  type RunSkillImpl,
} from '../assistant/assistant-runtime.ts';
import { loadRootEnv } from '../env.ts';
import { runSkill } from '../blocks/openclaw-client.ts';

loadRootEnv();

if (process.env.PA_LIVE_SMOKE !== '1') {
  console.log('↷ pa-live-smoke skipped: set PA_LIVE_SMOKE=1 to run the gated live path');
  process.exit(0);
}

process.env.FOUNDATION_OFFLINE = '0';
process.env.PA_BRAIN_LIVE = '1';
process.env.PA_READONLY = '0';
process.env.PA_BOOKING_POLICY = process.env.PA_BOOKING_POLICY || 'confirm';

const OWNER_ID = requiredEnv('PA_LIVE_SMOKE_OWNER_ID');
const PEER_HANDLE = requiredEnv('PA_LIVE_SMOKE_PEER_HANDLE');
requiredEnv('OPENCLAW_GATEWAY_TOKEN');
requiredEnv('BLOCKS_API_KEY');

const SELF_HANDLE = process.env.PA_LIVE_SMOKE_SELF_HANDLE || 'pa_live_smoke_owner';
const PEER_NAME = process.env.PA_LIVE_SMOKE_PEER_NAME || 'Kayley';

interface Scenario {
  id: 'S1' | 'S3' | 'S6' | 'S7';
  prompt: string;
  expect: (plan: AssistantPlan) => void;
}

const scenarios: Scenario[] = [
  {
    id: 'S1',
    prompt:
      'Write me a one-page brief covering our Q3 goals, the new onboarding flow, and the current support backlog, based on these notes: goals = grow activation 20%; onboarding = 3-step guided setup; backlog = 40 open tickets, mostly billing. Then book a meeting with Kayley\'s private assistant next Thursday to discuss it.',
    expect: (plan) => {
      assert(hasStep(plan, 'call-peer'), `S1 must include a call-peer step/action, got ${kinds(plan)}`);
    },
  },
  {
    id: 'S3',
    prompt:
      'Summarize this customer feedback into 3 bullets, then draft an email to Dana sending her the summary: "Customers love the new dashboard but say export is slow, mobile login fails on Android 13, and they want dark mode. Several mentioned they\'d pay for priority support."',
    expect: (plan) => {
      assert(hasIntegration(plan, /^email\./u), `S3 must include an email integration step/action, got ${JSON.stringify(plan.steps)}`);
    },
  },
  {
    id: 'S6',
    prompt:
      'Design a poster for the "Northwind Coffee" fall launch, then put 30 minutes on my calendar Friday at 10am to review it with the team.',
    expect: (plan) => {
      assert(hasSpecialistTag(plan, 'text-to-image'), `S6 must include a text-to-image specialist step/action, got ${JSON.stringify(plan.steps)}`);
      assert(hasIntegration(plan, /^calendar\./u), `S6 must include a calendar integration step/action, got ${JSON.stringify(plan.steps)}`);
    },
  },
  {
    id: 'S7',
    prompt:
      'I have a recorded interview I need transcribed and then summarized. Which agents on Blocks can handle each part, and which would you pick?',
    expect: (plan) => {
      assert(hasStep(plan, 'search-blocks-catalog'), `S7 must search the Blocks catalog, got ${kinds(plan)}`);
    },
  },
];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when PA_LIVE_SMOKE=1`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(result: { artifacts?: Array<{ data?: unknown }> }): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected a JSON artifact, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(parsed), `expected an object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function task(text: string, taskId: string): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId: OWNER_ID,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

function ctx(label: string): TaskContext {
  return {
    reportStatus: (message: string) => console.log(`   · ${label}: ${message}`),
  } as unknown as TaskContext;
}

const plannerCalls: Array<{ scenario: string; offline?: boolean }> = [];
const livePlanner: RunSkillImpl = async (skill, inputs, opts) => {
  plannerCalls.push({ scenario: String(inputs.scenario ?? inputs.request ?? skill), offline: opts?.offline });
  return runSkill(skill, inputs, opts);
};

function assertNoPlannerFallback(since: number, label: string): void {
  const calls = plannerCalls.slice(since);
  assert(calls.length > 0, `${label} did not call the personal_assistant planner`);
  assert(
    calls.every((call) => call.offline === false),
    `${label} fell back to an offline planner call: ${JSON.stringify(calls)}`,
  );
}

function assertNoOfflineTrue(value: unknown, label: string): void {
  const seen: string[] = [];
  walk(value, '$', seen);
  assert(seen.length === 0, `${label} returned offline:true at ${seen.join(', ')} in ${JSON.stringify(value)}`);
}

function walk(value: unknown, path: string, seen: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, seen));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const next = `${path}.${key}`;
    if (key === 'offline' && child === true) seen.push(next);
    walk(child, next, seen);
  }
}

function hasStep(plan: AssistantPlan, kind: string): boolean {
  return plan.steps.some((step) => step.kind === kind);
}

function hasSpecialistTag(plan: AssistantPlan, tag: string): boolean {
  return plan.steps.some((step) => step.kind === 'call-specialist' && step.tag === tag);
}

function hasIntegration(plan: AssistantPlan, tool: RegExp): boolean {
  return plan.steps.some((step) => step.kind === 'use-integration' && tool.test(step.tool));
}

function kinds(plan: AssistantPlan): string {
  return plan.steps.map((step) => step.kind).join(', ') || '(none)';
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'pa-live-smoke-'));

  console.log('▸ 1. live gateway brain plans S1/S3/S6/S7 without offline fallback');
  for (const scenario of scenarios) {
    const start = plannerCalls.length;
    const plan = await planRequest(
      { request: scenario.prompt, scenario: scenario.id },
      { offline: false, live: true, runSkillImpl: livePlanner },
    );
    assertNoPlannerFallback(start, `${scenario.id} planner`);
    scenario.expect(plan);
    console.log(`   ✓ ${scenario.id}: ${kinds(plan)}`);
  }

  console.log('▸ 2. S7 runs through the live catalog path');
  {
    const start = plannerCalls.length;
    const payload = payloadOf(await runAssistant(
      task(scenarios.find((s) => s.id === 'S7')!.prompt, 'live-s7'),
      ctx('S7'),
      { ownerId: OWNER_ID },
      { selfHandle: SELF_HANDLE, offline: false, runSkillImpl: livePlanner },
    ));
    assertNoPlannerFallback(start, 'S7 runtime');
    assert(payload.ok === true, `S7 runtime must succeed, got ${JSON.stringify(payload)}`);
    assertNoOfflineTrue(payload, 'S7 runtime');
    assert(
      payload.action === 'search-blocks-catalog' || Array.isArray(payload.steps),
      `S7 must surface catalog search output, got ${JSON.stringify(payload)}`,
    );
    console.log('   ✓ live catalog returned a visible recommendation/search payload');
  }

  console.log('▸ 3. S1 reaches the configured test peer through live direct-handle A2A');
  {
    await saveRoster({
      owner: OWNER_ID,
      agentName: SELF_HANDLE,
      peers: [{
        owner: PEER_NAME,
        agentName: PEER_HANDLE,
        since: new Date().toISOString(),
        sharePolicy: defaultSharePolicy(),
        aliases: [PEER_NAME.toLowerCase()],
        displayName: PEER_NAME,
      }],
    }, join(baseDir, 'rosters'));

    const sendA2A = makeLiveSendA2A();
    const request = buildA2ARequest({
      from: SELF_HANDLE,
      intent: 'Live smoke: please confirm you are reachable for scheduling coordination.',
      hop: 1,
    });
    const response = await sendA2A(PEER_HANDLE, request, { offline: false });
    assertNoOfflineTrue(response, 'S1 A2A');
    assert(isRecord(response) && response.offline === false, `live A2A must report offline:false, got ${JSON.stringify(response)}`);
    console.log(`   ✓ live A2A reached ${PEER_HANDLE}`);
  }

  console.log('▸ 4. S3/S6 write-shaped steps run with offline:false through no-op integration guards');
  {
    const integrationCalls: Array<{ tool: string; offline: boolean }> = [];
    const noWriteIntegration: RunIntegration = async (tool, args, opts) => {
      integrationCalls.push({ tool, offline: opts.offline });
      return {
        ok: true,
        offline: false,
        tool,
        args,
        smoke: true,
        ...(tool === 'calendar.createEvent' ? { event: { id: 'smoke-calendar-event' } } : {}),
        ...(tool === 'email.draft' ? { draft: { id: 'smoke-draft' } } : {}),
      };
    };

    const s3Payload = payloadOf(await runAssistant(
      task('Draft an email to dana@example.com with this summary: customers want faster exports.', 'live-s3'),
      ctx('S3'),
      { ownerId: OWNER_ID },
      {
        selfHandle: SELF_HANDLE,
        offline: false,
        runIntegration: noWriteIntegration,
        runSkillImpl: async () => ({
          ok: true,
          reply: 'I will draft the email.',
          steps: [{ id: 'step1', kind: 'use-integration', tool: 'email.draft', args: { to: 'dana@example.com', body: 'Customers want faster exports.' } }],
        }),
      },
    ));
    assertNoOfflineTrue(s3Payload, 'S3 runtime');

    const s6Payload = payloadOf(await runAssistant(
      task('Book a Friday 10am review for the Northwind Coffee poster.', 'live-s6'),
      ctx('S6'),
      { ownerId: OWNER_ID },
      {
        selfHandle: SELF_HANDLE,
        offline: false,
        bookingPolicy: 'auto',
        runIntegration: noWriteIntegration,
        runSkillImpl: async () => ({
          ok: true,
          reply: 'I will create the review event.',
          steps: [{ id: 'step1', kind: 'use-integration', tool: 'calendar.createEvent', args: { summary: 'Northwind Coffee poster review', start: '2026-07-03T10:00:00', end: '2026-07-03T10:30:00' } }],
        }),
      },
    ));
    assertNoOfflineTrue(s6Payload, 'S6 runtime');
    assert(
      integrationCalls.length === 2 && integrationCalls.every((call) => call.offline === false),
      `S3/S6 integrations must run with offline:false, got ${JSON.stringify(integrationCalls)}`,
    );
    console.log('   ✓ S3/S6 integration seams ran with offline:false and no account mutation');
  }

  console.log('\naudit: live gateway planning + live catalog + live test-peer A2A + no offline:true payloads proven for S1/S3/S6/S7 smoke');
  console.log('✅ pa-live-smoke check passed');
} catch (err) {
  console.error(`❌ pa-live-smoke check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
