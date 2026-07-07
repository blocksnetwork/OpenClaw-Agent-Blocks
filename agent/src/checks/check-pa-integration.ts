/**
 * Phase PA-8.1 offline gate — the `use-integration` read path.
 *
 * Asserts, with no key and no network (an injected stub calendar):
 *   1. the brain plans a `use-integration` action for an availability ask,
 *      and the runtime runs the named tool and folds the result back.
 *   2. the runtime passes the tool + args through to the integration
 *      runner unchanged (so a real MCP calendar gets a faithful request).
 *   3. the owner gate still applies — a non-owner caller is refused before
 *      any integration runs (no calendar read for a stranger).
 *   4. with NO runner injected, the default offline stub answers (the live
 *      MCP path is gated, Phase 8.0) — never a crash, never a live call.
 *
 *   npm run check:pa-integration
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { runAssistant, type RunAssistantOpts, type RunIntegration } from '../assistant/assistant-runtime.ts';
import {
  makeCalendarRunIntegration,
  normalizeFreeBusy,
  resolveWindow,
  type McpCaller,
  type McpToolResult,
} from '../integrations/calendar-mcp.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(result: { artifacts?: Array<{ data?: unknown }> }): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected an artifact, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(parsed), `expected an object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

/** An owner-request task (plain text). */
function ownerTask(text: string, ownerId = 'alice-oid'): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId: 'pa-integration-check',
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

try {
  // A deterministic stub calendar standing in for the live MCP server. It
  // records the calls it received so we can prove the tool + args arrived
  // faithfully — exactly what a real `calendar.freeBusy` MCP tool would get.
  const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const stubCalendar: RunIntegration = async (tool, args, opts) => {
    seen.push({ tool, args });
    assert(opts.offline === true, 'check must drive the integration offline');
    if (tool === 'calendar.freeBusy') {
      return { tool, freeBusy: ['Thu 09:00–10:00 busy', 'Thu 14:00–15:00 busy'], window: args.query };
    }
    return { tool, note: 'unknown tool' };
  };

  const aliceOpts: RunAssistantOpts = { selfHandle: 'pa_alice', runIntegration: stubCalendar };

  // 1. owner asks about availability → brain plans use-integration → run it.
  const read = payloadOf(
    await runAssistant(ownerTask('Am I free Thursday afternoon?'), undefined, { ownerId: 'alice-oid' }, aliceOpts),
  );
  assert(read.ok === true, `integration read must succeed, got ${JSON.stringify(read)}`);
  assert(
    isRecord(read.integration) && read.integration.tool === 'calendar.freeBusy',
    `runtime must report the integration tool it ran, got ${JSON.stringify(read.integration)}`,
  );
  assert(
    isRecord(read.result) && Array.isArray((read.result as Record<string, unknown>).freeBusy),
    `the calendar result must surface free/busy, got ${JSON.stringify(read.result)}`,
  );
  console.log('▸ read path: availability ask → use-integration(calendar.freeBusy) → free/busy returned ✓');

  // 2. tool + args passed through faithfully.
  assert(seen.length === 1 && seen[0].tool === 'calendar.freeBusy', 'exactly one calendar.freeBusy call expected');
  assert(
    typeof seen[0].args.query === 'string' && seen[0].args.query.toLowerCase().includes('thursday'),
    `the owner's scope must reach the tool args, got ${JSON.stringify(seen[0].args)}`,
  );
  console.log('▸ passthrough: tool name + args.query reached the integration runner unchanged ✓');

  // 3. owner gate still guards the integration — a stranger gets nothing.
  const refused = payloadOf(
    await runAssistant(ownerTask('Am I free Thursday afternoon?'), undefined, { ownerId: 'someone-else' }, aliceOpts),
  );
  assert(refused.ok === false && refused.error === 'forbidden', `non-owner must be refused, got ${JSON.stringify(refused)}`);
  assert(seen.length === 1, 'a refused caller must NOT trigger an integration call');
  console.log('▸ owner gate: a non-owner is refused before any calendar read ✓');

  // 4. no runner injected → deterministic offline stub (live MCP is gated).
  const stubbed = payloadOf(
    await runAssistant(ownerTask('What does my calendar look like Thursday?'), undefined, { ownerId: 'alice-oid' }, {
      selfHandle: 'pa_alice',
    }),
  );
  assert(stubbed.ok === true, `default offline integration must succeed, got ${JSON.stringify(stubbed)}`);
  assert(
    isRecord(stubbed.result) && (stubbed.result as Record<string, unknown>).offline === true,
    `without a runner the default offline stub must answer, got ${JSON.stringify(stubbed.result)}`,
  );
  console.log('▸ offline default: no runner → offline stub answers (live MCP path is gated, Phase 8.0) ✓');

  // 4b. D.4 — on the LIVE integration path (offline:false, no runner injected),
  //     a disconnected owner must surface the Connect-Google remedy
  //     (machine `needsConnection`), never spawn the MCP server with no token
  //     nor return an offline stub. The brain stays on the offline stub
  //     (PA_BRAIN_LIVE unset ⇒ live=false), so no gateway/network is touched.
  const emptyIntegrations = await mkdtemp(join(tmpdir(), 'pa-noconnect-'));
  try {
    const disconnected = payloadOf(
      await runAssistant(ownerTask('Am I free Thursday afternoon?'), undefined, { ownerId: 'alice-oid' }, {
        selfHandle: 'pa_alice',
        offline: false,
        integrationStoreBaseDir: emptyIntegrations,
      }),
    );
    assert(
      isRecord(disconnected.needsConnection) && (disconnected.needsConnection as Record<string, unknown>).provider === 'google',
      `a disconnected owner must get needsConnection:{provider:google}, got ${JSON.stringify(disconnected)}`,
    );
    assert(
      disconnected.result === undefined && disconnected.integration === undefined,
      `the live runner must NOT run for a disconnected owner, got ${JSON.stringify(disconnected)}`,
    );
    console.log('▸ live disconnected: Google tool on an unconnected owner → Connect-Google remedy, no MCP call ✓');
  } finally {
    await rm(emptyIntegrations, { recursive: true, force: true });
  }

  // 5. calendar MCP mapping (the live runner's PURE core) — fake MCP caller,
  //    no spawn / OAuth / network. Proves our tool names map to the Google
  //    Calendar server's tools with a valid ISO window, and that the result
  //    normalizes into our free/busy shape.
  const fakeCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fakeCaller: McpCaller = {
    async callTool(name, args): Promise<McpToolResult> {
      fakeCalls.push({ name, args });
      if (name === 'get-freebusy') {
        return { content: [{ type: 'text', text: JSON.stringify({ busy: [{ start: 'T1', end: 'T2' }] }) }] };
      }
      if (name === 'create-event') {
        return { content: [{ type: 'text', text: JSON.stringify({ id: 'evt_1', summary: args.summary }) }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const fixedNow = new Date('2026-06-25T00:00:00.000Z');
  const calRun = makeCalendarRunIntegration(fakeCaller, { windowDays: 7, now: () => fixedNow });

  const fb = (await calRun('calendar.freeBusy', { query: 'this week' }, { offline: false })) as Record<string, unknown>;
  assert(fakeCalls.length === 1 && fakeCalls[0].name === 'get-freebusy', 'calendar.freeBusy must call the get-freebusy MCP tool');
  assert(
    fakeCalls[0].args.timeMin === '2026-06-25T00:00:00'
      && fakeCalls[0].args.timeMax === '2026-07-02T00:00:00'
      && JSON.stringify(fakeCalls[0].args.calendars) === JSON.stringify([{ id: 'primary' }]),
    `the MCP tool must receive a primary-calendar now→+7d window, got ${JSON.stringify(fakeCalls[0].args)}`,
  );
  assert(Array.isArray(fb.freeBusy) && (fb.freeBusy as unknown[]).length === 1, `free/busy must normalize to a busy array, got ${JSON.stringify(fb)}`);
  console.log('▸ calendar MCP: calendar.freeBusy → get-freebusy(ISO window) → normalized busy array ✓');

  const naturalFb = (await calRun(
    'calendar.freeBusy',
    { query: 'Check my availability next Tuesday afternoon.' },
    { offline: false },
  )) as Record<string, unknown>;
  const naturalCall = fakeCalls[1];
  assert(naturalCall && naturalCall.name === 'get-freebusy', 'natural availability query must call get-freebusy');
  assert(
    naturalCall.args.timeMin === '2026-06-30T12:00:00'
      && naturalCall.args.timeMax === '2026-06-30T17:00:00',
    `natural availability query must resolve next Tuesday afternoon, got ${JSON.stringify(naturalCall.args)}`,
  );
  assert(
    isRecord(naturalFb.window)
      && naturalFb.window.timeMin === '2026-06-30T12:00:00'
      && naturalFb.window.timeMax === '2026-06-30T17:00:00',
    `natural free/busy result must surface the resolved window, got ${JSON.stringify(naturalFb)}`,
  );
  console.log('▸ natural window: "next Tuesday afternoon" resolves before the Calendar MCP call ✓');

  // explicit window passes through; normalize is defensive on plain text.
  const win = resolveWindow({ timeMin: '2026-07-10T00:00:00Z', timeMax: '2026-07-11T00:00:00Z' }, 7, fixedNow);
  assert(win.timeMin === '2026-07-10T00:00:00Z' && win.timeMax === '2026-07-11T00:00:00Z', 'explicit window must pass through');
  const textNorm = normalizeFreeBusy({ content: [{ type: 'text', text: 'Busy 9-10' }] }, win);
  assert(textNorm.freeBusy === 'Busy 9-10' && textNorm.raw === 'Busy 9-10', 'non-JSON free/busy must fall back to raw text');

  // write tool maps to create-event; the runtime owns the confirmation gate.
  const created = (await calRun(
    'calendar.createEvent',
    { summary: 'Review', start: '2026-07-10T14:00:00Z', end: '2026-07-10T15:00:00Z' },
    { offline: false },
  )) as Record<string, unknown>;
  const createCall = fakeCalls[fakeCalls.length - 1];
  assert(createCall.name === 'create-event', `calendar.createEvent must call create-event, got ${createCall.name}`);
  assert(
    createCall.args.calendarId === 'primary'
      && createCall.args.summary === 'Review'
      && createCall.args.start === '2026-07-10T14:00:00Z',
    `calendar.createEvent args must pass through, got ${JSON.stringify(createCall.args)}`,
  );
  assert(isRecord(created.event) && created.event.id === 'evt_1', `create-event must normalize JSON, got ${JSON.stringify(created)}`);
  console.log('▸ calendar MCP: explicit window + raw-text fallback + createEvent mapping ✓');

  console.log('\naudit: brain plans use-integration → runtime runs the tool → owner gate holds → MCP mapping sound → live path gated');
  console.log('✅ pa-integration check passed');
} catch (err) {
  console.error(`❌ pa-integration check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
