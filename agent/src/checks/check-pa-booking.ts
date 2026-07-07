/**
 * Phase 8.2 offline gate - calendar.createEvent write actions.
 *
 * Proves the shared write gate: auto writes once, confirm proposes before
 * writing, confirm-token follow-up writes once, retries are idempotent, and
 * a plan cannot write a calendar for a different owner.
 *
 *   npm run check:pa-booking
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { runAssistant, type RunAssistantOpts, type RunIntegration, type RunSkillImpl } from '../assistant/assistant-runtime.ts';
import { readBookingWrites } from '../integrations/booking-audit.ts';
import { makeCalendarRunIntegration, type McpCaller, type McpToolResult } from '../integrations/calendar-mcp.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
process.env.PA_READONLY = '0';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownerTask(text: string, taskId = 'pa-booking-check', ownerId = 'alice-oid'): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

function payloadOf(result: { artifacts?: Array<{ data?: unknown }> }): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected an artifact, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(parsed), `expected object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function writeCount(writes: unknown[]): number {
  return writes.length;
}

try {
  const auditBaseDir = await mkdtemp(join(tmpdir(), 'pa-booking-'));
  const writes: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const stubCalendar: RunIntegration = async (tool, args) => {
    writes.push({ tool, args });
    return { ok: true, tool, event: { id: `evt-${writes.length}`, summary: args.query ?? args.summary ?? 'booking' } };
  };

  const baseOpts: RunAssistantOpts = {
    selfHandle: 'pa_alice',
    runIntegration: stubCalendar,
    bookingAuditBaseDir: auditBaseDir,
  };

  const auto = payloadOf(
    await runAssistant(
      ownerTask('Schedule a meeting with Dana tomorrow at 2pm.', 'auto-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'auto', writeIdempotencyId: 'auto-booking-1' },
    ),
  );
  assert(auto.ok === true && isRecord(auto.result), `auto booking must write immediately, got ${JSON.stringify(auto)}`);
  assert(writeCount(writes) === 1 && writes[0].tool === 'calendar.createEvent', `auto must call createEvent once, got ${JSON.stringify(writes)}`);
  console.log('▸ auto: calendar.createEvent writes exactly once ✓');

  const retry = payloadOf(
    await runAssistant(
      ownerTask('Schedule a meeting with Dana tomorrow at 2pm.', 'auto-1-retry'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'auto', writeIdempotencyId: 'auto-booking-1' },
    ),
  );
  assert(retry.idempotent === true, `retry must return idempotent prior result, got ${JSON.stringify(retry)}`);
  assert(writeCount(writes) === 1, `retry must not write again, got ${writes.length} writes`);
  console.log('▸ idempotency: same id returns prior write without a second createEvent ✓');

  const proposal = payloadOf(
    await runAssistant(
      ownerTask('Schedule a review with Dana Friday at 10am.', 'confirm-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'confirm', writeIdempotencyId: 'confirm-booking-1' },
    ),
  );
  assert(typeof proposal.confirmToken === 'string', `confirm policy must return a token, got ${JSON.stringify(proposal)}`);
  assert(isRecord(proposal.proposal), `confirm policy must return a proposal, got ${JSON.stringify(proposal)}`);
  assert(writeCount(writes) === 1, 'confirm proposal must not write before approval');

  const confirmed = payloadOf(
    await runAssistant(
      ownerTask(`Please confirm ${proposal.confirmToken}`, 'confirm-1-token'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'confirm' },
    ),
  );
  assert(confirmed.confirmed === true && confirmed.idempotent === false, `confirmation must write, got ${JSON.stringify(confirmed)}`);
  assert(writeCount(writes) === 2, `confirmed token must write exactly once, got ${writes.length} writes`);
  console.log('▸ confirm: proposal first, token follow-up writes once ✓');

  const confirmedRetry = payloadOf(
    await runAssistant(
      ownerTask(`Confirm again ${proposal.confirmToken}`, 'confirm-1-token-retry'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'confirm' },
    ),
  );
  assert(confirmedRetry.idempotent === true, `confirm retry must be idempotent, got ${JSON.stringify(confirmedRetry)}`);
  assert(writeCount(writes) === 2, `confirm retry must not write again, got ${writes.length} writes`);

  let failedWriteCalls = 0;
  const failingCalendar: RunIntegration = async (tool, args) => {
    failedWriteCalls += 1;
    return { ok: false, tool, args, error: 'calendar-rejected' };
  };
  const failedProposal = payloadOf(
    await runAssistant(
      ownerTask('Schedule a rejected booking with Dana next Friday from 10am to 11am.', 'failed-confirm-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'confirm', writeIdempotencyId: 'failed-confirm-booking-1' },
    ),
  );
  assert(typeof failedProposal.confirmToken === 'string', `failed-write setup must return a token, got ${JSON.stringify(failedProposal)}`);
  const failedConfirmed = payloadOf(
    await runAssistant(
      ownerTask(`Confirm failed write ${failedProposal.confirmToken}`, 'failed-confirm-1-token'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'confirm', runIntegration: failingCalendar },
    ),
  );
  assert(
    failedConfirmed.ok === false && failedConfirmed.error === 'integration-write-failed' && failedConfirmed.confirmed === false,
    `failed confirmation must not claim success, got ${JSON.stringify(failedConfirmed)}`,
  );
  assert(failedWriteCalls === 1, `failed confirmation must try the integration once, got ${failedWriteCalls}`);
  assert(writeCount(writes) === 2, `failed confirmation must not count as a successful write, got ${writes.length} writes`);

  const recoveredConfirmed = payloadOf(
    await runAssistant(
      ownerTask(`Retry after fix ${failedProposal.confirmToken}`, 'failed-confirm-1-token-retry'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'confirm' },
    ),
  );
  assert(
    recoveredConfirmed.confirmed === true && recoveredConfirmed.idempotent === false,
    `failed writes must not poison idempotency, got ${JSON.stringify(recoveredConfirmed)}`,
  );
  assert(writeCount(writes) === 3, `retry after failed write must call createEvent once, got ${writes.length} writes`);
  console.log('▸ failed confirm: Calendar rejection is not marked written and token can retry ✓');

  const maliciousPlan: RunSkillImpl = async () => ({
    ok: true,
    reply: 'Trying to write someone else.',
    actions: [{ kind: 'use-integration', tool: 'calendar.createEvent', args: { query: 'secret', targetOwnerId: 'bob-oid' } }],
  });
  const refused = payloadOf(
    await runAssistant(
      ownerTask('Schedule a secret event.', 'mismatch-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...baseOpts, bookingPolicy: 'auto', runSkillImpl: maliciousPlan, writeIdempotencyId: 'mismatch-1' },
    ),
  );
  assert(refused.ok === false && refused.error === 'write-owner-mismatch', `owner mismatch must be refused, got ${JSON.stringify(refused)}`);
  assert(writeCount(writes) === 3, 'refused owner mismatch must not write');
  console.log('▸ owner gate: cross-owner calendar write refused before integration call ✓');

  const fakeCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fakeCaller: McpCaller = {
    async callTool(name, args): Promise<McpToolResult> {
      fakeCalls.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ id: 'evt-mcp', summary: args.summary }) }] };
    },
  };
  const calRun = makeCalendarRunIntegration(fakeCaller);
  const mapped = (await calRun(
    'calendar.createEvent',
    { query: 'Review', start: '2026-07-01T14:00:00Z', end: '2026-07-01T14:30:00Z' },
    { offline: false },
  )) as Record<string, unknown>;
  assert(fakeCalls[0].name === 'create-event', `calendar.createEvent must call create-event, got ${fakeCalls[0].name}`);
  assert(fakeCalls[0].args.calendarId === 'primary', `calendar.createEvent must default calendarId, got ${JSON.stringify(fakeCalls[0].args)}`);
  assert(isRecord(mapped.event) && mapped.event.id === 'evt-mcp', `createEvent result must normalize event JSON, got ${JSON.stringify(mapped)}`);

  const audit = await readBookingWrites({ baseDir: auditBaseDir });
  assert(
    audit.some((entry) => entry.status === 'proposed')
      && audit.some((entry) => entry.status === 'written')
      && audit.some((entry) => entry.status === 'failed'),
    `audit must contain proposal and write entries, got ${JSON.stringify(audit)}`,
  );

  console.log('\naudit: auto + confirm + idempotency + owner invariant + MCP mapping all offline');
  console.log('✅ pa-booking check passed');
} catch (err) {
  console.error(`❌ pa-booking check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
