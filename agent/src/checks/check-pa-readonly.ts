/**
 * Notify assistant offline gate - PA_READONLY safety.
 *
 * Proves, with injected planners/runners only:
 *   1. write tools are refused in default read-only mode before runIntegration.
 *   2. a confirm-token write follow-up is refused in read-only mode.
 *   3. read tools still reach runIntegration.
 *   4. PA_ALLOW_CALENDAR_BOOKING=1 allows calendar.createEvent with
 *      confirmation only, while Gmail writes stay blocked.
 *   5. live semantic booking extraction can fill start/end from flexible
 *      natural phrasing before the confirm gate.
 *
 *   npm run check:pa-readonly
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { runAssistant, type RunIntegration, type RunSkillImpl } from '../assistant/assistant-runtime.ts';
import { readBookingWrites } from '../integrations/booking-audit.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
delete process.env.PA_READONLY;
delete process.env.PA_ALLOW_CALENDAR_BOOKING;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownerTask(text: string, taskId = 'pa-readonly-check'): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId: 'alice-oid',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

function payloadOf(result: { artifacts?: Array<{ data?: unknown }> }): Record<string, unknown> {
  const artifact = result.artifacts?.[0];
  assert(artifact, `expected artifact, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(String(artifact.data)) as unknown;
  assert(isRecord(parsed), `expected object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function planner(tool: string, args: Record<string, unknown> = {}): RunSkillImpl {
  return async () => ({
    ok: true,
    reply: `Planned ${tool}.`,
    actions: [{ kind: 'use-integration', tool, args }],
  });
}

function assertReadonlyRefusal(payload: Record<string, unknown>, label: string): void {
  assert(payload.ok === false, `${label} must be refused, got ${JSON.stringify(payload)}`);
  assert(payload.error === 'read-only-refused', `${label} must use read-only-refused, got ${JSON.stringify(payload)}`);
  assert(
    typeof payload.reply === 'string' && payload.reply.includes('read-only') && payload.reply.includes('won’t send email'),
    `${label} must return a friendly read-only reply, got ${JSON.stringify(payload.reply)}`,
  );
}

let auditBaseDir: string | undefined;

try {
  auditBaseDir = await mkdtemp(join(tmpdir(), 'pa-readonly-'));
  let integrationCalls = 0;
  const runIntegration: RunIntegration = async (tool, args) => {
    integrationCalls += 1;
    return { ok: true, tool, args, call: integrationCalls };
  };

  for (const tool of ['calendar.createEvent', 'email.draft', 'email.send']) {
    integrationCalls = 0;
    const refused = payloadOf(
      await runAssistant(ownerTask(`Try ${tool}.`, `readonly-${tool}`), undefined, { ownerId: 'alice-oid' }, {
        bookingAuditBaseDir: auditBaseDir,
        bookingPolicy: 'auto',
        runIntegration,
        runSkillImpl: planner(tool, { query: `demo ${tool}` }),
        writeIdempotencyId: `readonly-${tool}`,
      }),
    );
    assertReadonlyRefusal(refused, tool);
    assert(refused.tool === tool, `${tool} refusal must identify the blocked tool, got ${JSON.stringify(refused)}`);
    assert(integrationCalls === 0, `${tool} must not call runIntegration in read-only mode`);
  }
  assert((await readBookingWrites({ baseDir: auditBaseDir })).length === 0, 'read-only write refusals must not create write audit entries');
  console.log('▸ writes: createEvent/draft/send refused before integration or write audit ✓');

  process.env.PA_READONLY = '0';
  integrationCalls = 0;
  const proposal = payloadOf(
    await runAssistant(ownerTask('Propose a calendar write.', 'readonly-confirm-propose'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      bookingPolicy: 'confirm',
      runIntegration,
      runSkillImpl: planner('calendar.createEvent', { summary: 'Demo hold' }),
      writeIdempotencyId: 'readonly-confirm-write',
    }),
  );
  assert(typeof proposal.confirmToken === 'string', `setup must create a confirm token, got ${JSON.stringify(proposal)}`);
  assert(integrationCalls === 0, 'confirm proposal setup must not call runIntegration before approval');

  process.env.PA_READONLY = '1';
  const refusedConfirm = payloadOf(
    await runAssistant(ownerTask(`Confirm ${proposal.confirmToken}`, 'readonly-confirm-refuse'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      bookingPolicy: 'confirm',
      runIntegration,
    }),
  );
  assertReadonlyRefusal(refusedConfirm, 'confirm-token follow-up');
  assert(refusedConfirm.confirmToken === proposal.confirmToken, `confirm refusal must echo the token, got ${JSON.stringify(refusedConfirm)}`);
  assert(integrationCalls === 0, 'read-only confirm-token follow-up must not call runIntegration');
  assert(
    (await readBookingWrites({ baseDir: auditBaseDir })).every((entry) => entry.status !== 'written'),
    'read-only confirm-token follow-up must not record a written audit entry',
  );
  console.log('▸ confirm token: old write token refused before integration ✓');

  integrationCalls = 0;
  const readCalls: string[] = [];
  const readRunIntegration: RunIntegration = async (tool, args) => {
    integrationCalls += 1;
    readCalls.push(tool);
    if (tool === 'calendar.freeBusy') {
      return {
        ok: true,
        tool,
        args,
        read: true,
        freeBusy: [],
        window: { timeMin: '2026-06-30T12:00:00', timeMax: '2026-06-30T17:00:00' },
      };
    }
    return { ok: true, tool, args, read: true };
  };
  for (const tool of ['calendar.freeBusy', 'calendar.list', 'email.list', 'email.read']) {
    const read = payloadOf(
      await runAssistant(ownerTask(`Read with ${tool}.`, `readonly-read-${tool}`), undefined, { ownerId: 'alice-oid' }, {
        runIntegration: readRunIntegration,
        runSkillImpl: planner(tool, { query: `demo ${tool}` }),
      }),
    );
    assert(read.ok === true, `${tool} must still succeed in read-only mode, got ${JSON.stringify(read)}`);
    assert(isRecord(read.integration) && read.integration.tool === tool, `${tool} must report integration metadata`);
    assert(isRecord(read.result) && read.result.tool === tool, `${tool} must return the integration result`);
    if (tool === 'calendar.freeBusy') {
      assert(
        typeof read.reply === 'string'
          && read.reply.includes('checked your calendar')
          && read.reply.includes('look free')
          && read.reply.includes('Tuesday, Jun 30')
          && read.reply.includes('12:00 PM to 5:00 PM'),
        `calendar.freeBusy must return a Blocks-friendly reply, got ${JSON.stringify(read.reply)}`,
      );
    }
  }
  assert(
    JSON.stringify(readCalls) === JSON.stringify(['calendar.freeBusy', 'calendar.list', 'email.list', 'email.read']),
    `read-only mode must still call read integrations, got ${JSON.stringify(readCalls)}`,
  );
  assert(integrationCalls === 4, `expected four read integration calls, got ${integrationCalls}`);
  console.log('▸ reads: calendar.freeBusy/list and email.list/read still call runIntegration ✓');

  process.env.PA_READONLY = '1';
  process.env.PA_ALLOW_CALENDAR_BOOKING = '1';
  integrationCalls = 0;
  const missingDate = payloadOf(
    await runAssistant(ownerTask('Book a meeting with Markus from 1pm to 2pm.', 'booking-enabled-missing-date'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      runIntegration,
      runSkillImpl: planner('calendar.createEvent', { query: 'Book a meeting with Markus from 1pm to 2pm.' }),
      writeIdempotencyId: 'booking-enabled-missing-date',
    }),
  );
  assert(missingDate.needsMoreInfo === true, `missing date must ask for more info, got ${JSON.stringify(missingDate)}`);
  assert(typeof missingDate.confirmToken !== 'string', 'missing date must not return a confirm token');
  assert(integrationCalls === 0, 'missing date must not write');

  const naturalProposal = payloadOf(
    await runAssistant(ownerTask('Book a meeting with Markus tomorrow from 1pm to 2pm.', 'booking-enabled-natural'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      runIntegration,
      runSkillImpl: planner('calendar.createEvent', { query: 'Book a meeting with Markus tomorrow from 1pm to 2pm.' }),
      writeIdempotencyId: 'booking-enabled-natural',
    }),
  );
  assert(typeof naturalProposal.confirmToken === 'string', `complete natural booking must return a token, got ${JSON.stringify(naturalProposal)}`);
  assert(isRecord(naturalProposal.proposal), `complete natural booking must return a proposal, got ${JSON.stringify(naturalProposal)}`);
  const naturalProposalData = naturalProposal.proposal as Record<string, unknown>;
  assert(isRecord(naturalProposalData.args), `complete natural booking must include args, got ${JSON.stringify(naturalProposalData)}`);
  assert(
    typeof naturalProposalData.args.start === 'string'
      && naturalProposalData.args.start.includes('T13:00:00')
      && typeof naturalProposalData.args.end === 'string'
      && naturalProposalData.args.end.includes('T14:00:00'),
    `complete natural booking must normalize start/end, got ${JSON.stringify(naturalProposalData.args)}`,
  );
  assert(integrationCalls === 0, 'complete natural booking must not write before confirmation');

  const calendarDateProposal = payloadOf(
    await runAssistant(ownerTask('Book a meeting for me at Thursday, Jun 25 2026 at 2pm till 3pm', 'booking-enabled-calendar-date'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      runIntegration,
      runSkillImpl: planner('calendar.createEvent', { query: 'Book a meeting for me at Thursday, Jun 25 2026 at 2pm till 3pm' }),
      writeIdempotencyId: 'booking-enabled-calendar-date',
    }),
  );
  assert(typeof calendarDateProposal.confirmToken === 'string', `month-name date booking must return a token, got ${JSON.stringify(calendarDateProposal)}`);
  assert(
    typeof calendarDateProposal.reply === 'string' && calendarDateProposal.reply.includes('not booked it yet'),
    `month-name date booking must make confirmation state clear, got ${JSON.stringify(calendarDateProposal.reply)}`,
  );
  assert(isRecord(calendarDateProposal.proposal), `month-name date booking must return a proposal, got ${JSON.stringify(calendarDateProposal)}`);
  const calendarDateProposalData = calendarDateProposal.proposal as Record<string, unknown>;
  assert(isRecord(calendarDateProposalData.args), `month-name date booking must include args, got ${JSON.stringify(calendarDateProposalData)}`);
  assert(
    calendarDateProposalData.args.start === '2026-06-25T14:00:00'
      && calendarDateProposalData.args.end === '2026-06-25T15:00:00',
    `month-name date booking must normalize start/end, got ${JSON.stringify(calendarDateProposalData.args)}`,
  );
  assert(integrationCalls === 0, 'month-name date booking must not write before confirmation');

  let extractCalls = 0;
  const semanticBookingPlanner: RunSkillImpl = async (skill, inputs, opts) => {
    if (skill === 'calendar_event_extract') {
      extractCalls += 1;
      assert(opts?.offline === false, `semantic extractor must run in live mode, got ${JSON.stringify(opts)}`);
      assert(
        inputs.query === 'Book me a meeting for 5pm today until 6pm',
        `semantic extractor must receive the owner phrasing, got ${JSON.stringify(inputs)}`,
      );
      return {
        ok: true,
        summary: 'Meeting',
        start: '2026-06-25T17:00:00',
        end: '2026-06-25T18:00:00',
      };
    }
    return {
      ok: true,
      reply: 'Planned semantic booking.',
      actions: [{ kind: 'use-integration', tool: 'calendar.createEvent', args: { query: 'Book me a meeting for 5pm today until 6pm' } }],
    };
  };
  const semanticProposal = payloadOf(
    await runAssistant(ownerTask('Book me a meeting for 5pm today until 6pm', 'booking-enabled-semantic'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      offline: false,
      runIntegration,
      runSkillImpl: semanticBookingPlanner,
      writeIdempotencyId: 'booking-enabled-semantic',
    }),
  );
  assert(extractCalls === 1, `semantic booking extraction must run once, got ${extractCalls}`);
  assert(typeof semanticProposal.confirmToken === 'string', `semantic booking must return a token, got ${JSON.stringify(semanticProposal)}`);
  assert(isRecord(semanticProposal.proposal), `semantic booking must return a proposal, got ${JSON.stringify(semanticProposal)}`);
  const semanticProposalData = semanticProposal.proposal as Record<string, unknown>;
  assert(isRecord(semanticProposalData.args), `semantic booking must include args, got ${JSON.stringify(semanticProposalData)}`);
  assert(
    semanticProposalData.args.start === '2026-06-25T17:00:00'
      && semanticProposalData.args.end === '2026-06-25T18:00:00',
    `semantic booking must normalize flexible phrasing, got ${JSON.stringify(semanticProposalData.args)}`,
  );
  assert(integrationCalls === 0, 'semantic booking must not write before confirmation');

  const bookingProposal = payloadOf(
    await runAssistant(ownerTask('Book a meeting with Markus from 1pm to 2pm.', 'booking-enabled-propose'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      bookingPolicy: 'auto',
      runIntegration,
      runSkillImpl: planner('calendar.createEvent', { summary: 'Meet Markus', start: '2026-07-01T13:00:00Z', end: '2026-07-01T14:00:00Z' }),
      writeIdempotencyId: 'booking-enabled-calendar',
    }),
  );
  assert(typeof bookingProposal.confirmToken === 'string', `booking exception must force a confirm token, got ${JSON.stringify(bookingProposal)}`);
  assert(isRecord(bookingProposal.proposal), `booking exception must return a proposal, got ${JSON.stringify(bookingProposal)}`);
  assert(integrationCalls === 0, 'booking exception must not write before confirmation');

  const bookingConfirmed = payloadOf(
    await runAssistant(ownerTask(`Confirm ${bookingProposal.confirmToken}`, 'booking-enabled-confirm'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      runIntegration,
    }),
  );
  assert(bookingConfirmed.confirmed === true, `booking confirmation must execute, got ${JSON.stringify(bookingConfirmed)}`);
  assert(
    typeof bookingConfirmed.reply === 'string' && bookingConfirmed.reply.includes('created the calendar event'),
    `booking confirmation must return a created-event reply, got ${JSON.stringify(bookingConfirmed.reply)}`,
  );
  assert(Number(integrationCalls) === 1, `booking confirmation must call runIntegration exactly once, got ${integrationCalls}`);

  for (const tool of ['email.draft', 'email.send']) {
    integrationCalls = 0;
    const refusedEmailWrite = payloadOf(
      await runAssistant(ownerTask(`Try ${tool} with booking enabled.`, `booking-enabled-${tool}`), undefined, { ownerId: 'alice-oid' }, {
        bookingAuditBaseDir: auditBaseDir,
        runIntegration,
        runSkillImpl: planner(tool, { query: `demo ${tool}` }),
        writeIdempotencyId: `booking-enabled-${tool}`,
      }),
    );
    assertReadonlyRefusal(refusedEmailWrite, `${tool} with booking enabled`);
    assert(integrationCalls === 0, `${tool} must remain blocked with booking enabled`);
  }
  console.log('▸ booking exception: calendar booking confirms before write; Gmail draft/send stay blocked ✓');

  console.log('\naudit: PA_READONLY defaults on, blocks write tools/tokens offline, and leaves read tools usable');
  console.log('✅ pa-readonly check passed');
} catch (err) {
  console.error(`❌ pa-readonly check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (auditBaseDir) await rm(auditBaseDir, { recursive: true, force: true });
}
