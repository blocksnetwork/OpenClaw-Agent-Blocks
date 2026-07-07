/**
 * Pillar 1.7 offline gate — the multi-step executor.
 *
 * Asserts, with no key and no network, that an ordered steps[] plan:
 *   1. runs steps IN ORDER and threads step1's result into step2 (1.2/1.3);
 *   2. on a failed later step, returns a PARTIAL result (never silence) with
 *      what succeeded plus a retry hint (1.5 / X.1 / X.2);
 *   3. gates a write step mid-sequence behind confirm, parks the plan, and
 *      RESUMES it on the confirm token — re-running the write exactly once
 *      and never re-running the already-completed earlier step (1.0 / 1.4);
 *   4. honours a runIf guard to skip a step whose condition isn't met.
 *
 *   npm run check:assistant-multistep
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';
import { passthrough, runAssistant, type RunIntegration, type RunSkillImpl } from '../assistant/assistant-runtime.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
// Writes enabled so write steps reach the gate instead of a read-only refusal.
process.env.PA_READONLY = '0';

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

function ownerTask(text: string, taskId: string): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId: 'alice-oid',
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

/** A planner that returns a fixed ordered plan regardless of the request. */
function fixedPlanner(plan: unknown): RunSkillImpl {
  return async (skill) => (skill === 'personal_assistant' ? plan : { ok: true });
}

const FREE_WINDOW = { timeMin: '2026-07-02T13:00:00', timeMax: '2026-07-02T17:00:00' };

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'multistep-'));

  // 1. Ordered execution + result threading (step1 → step2).
  {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runIntegration: RunIntegration = async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'calendar.freeBusy') return { ok: true, freeBusy: [], window: FREE_WINDOW };
      return { ok: true, tool, sent: { id: `s-${calls.length}` } };
    };
    const plan = {
      ok: true,
      reply: 'Check then email.',
      steps: [
        { id: 'step1', kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Thursday afternoon' } },
        { id: 'step2', kind: 'use-integration', tool: 'email.send', args: { to: 'dana@example.com', body: { from: 'step1', field: 'reply' } } },
      ],
    };
    const out = payloadOf(await runAssistant(
      ownerTask('check then email', 'thread-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { offline: true, runSkillImpl: fixedPlanner(plan), runIntegration, bookingPolicy: 'auto', bookingAuditBaseDir: join(baseDir, 'a1') },
    ));

    assert(out.multiStep === true, `expected a multi-step result, got ${JSON.stringify(out)}`);
    assert(out.partial === false, `a fully-completed plan must not be partial, got ${JSON.stringify(out.partial)}`);
    assert(calls.length === 2 && calls[0].tool === 'calendar.freeBusy' && calls[1].tool === 'email.send', `steps must run in order, got ${JSON.stringify(calls.map((c) => c.tool))}`);
    const body = String(calls[1].args.body ?? '');
    assert(/free/i.test(body), `step1's result must be threaded into step2's email body, got ${JSON.stringify(calls[1].args.body)}`);
    const steps = out.steps as Array<{ status?: string }>;
    assert(Array.isArray(steps) && steps.length === 2 && steps.every((s) => s.status === 'satisfied'), `ledger must show 2 satisfied steps, got ${JSON.stringify(out.steps)}`);
    console.log('▸ order + threading: step1 runs first, its result feeds step2 ✓');
  }

  // 2. A failed later step → partial result, never silence.
  {
    const runIntegration: RunIntegration = async (tool) => {
      if (tool === 'calendar.freeBusy') return { ok: true, freeBusy: [], window: FREE_WINDOW };
      throw new Error('Gmail rejected the send');
    };
    const plan = {
      ok: true,
      reply: 'Check then email.',
      steps: [
        { id: 'step1', kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Thursday afternoon' } },
        { id: 'step2', kind: 'use-integration', tool: 'email.send', args: { to: 'dana@example.com', body: 'note' } },
      ],
    };
    const out = payloadOf(await runAssistant(
      ownerTask('check then email', 'partial-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { offline: true, runSkillImpl: fixedPlanner(plan), runIntegration, bookingPolicy: 'auto', bookingAuditBaseDir: join(baseDir, 'a2') },
    ));

    assert(typeof out.reply === 'string' && out.reply.trim().length > 0, `a failed step must STILL produce a visible reply, got ${JSON.stringify(out.reply)}`);
    assert(out.partial === true, `a failed later step must mark the turn partial, got ${JSON.stringify(out.partial)}`);
    assert(/free/i.test(String(out.reply)), `partial reply must keep what succeeded (step1), got ${JSON.stringify(out.reply)}`);
    assert(/retry|finish/i.test(String(out.reply)), `partial reply must offer to retry/finish, got ${JSON.stringify(out.reply)}`);
    console.log('▸ partial: a failed step yields a visible partial summary + retry hint, never silence ✓');
  }

  // 3. Write gating mid-sequence + confirm-resume (1.0 / 1.4).
  {
    const calls: string[] = [];
    const runIntegration: RunIntegration = async (tool) => {
      calls.push(tool);
      if (tool === 'calendar.freeBusy') return { ok: true, freeBusy: [], window: FREE_WINDOW };
      return { ok: true, tool, created: { id: 'evt-1' } };
    };
    const opts = {
      offline: true,
      runIntegration,
      bookingPolicy: 'confirm' as const,
      bookingAuditBaseDir: join(baseDir, 'a3'),
    };
    const plan = {
      ok: true,
      reply: 'Check then book.',
      steps: [
        { id: 'step1', kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Thursday afternoon' } },
        { id: 'step2', kind: 'use-integration', tool: 'calendar.createEvent', args: { summary: 'Sync', start: '2026-07-02T14:00:00', end: '2026-07-02T14:30:00' } },
      ],
    };

    // Turn 1: pauses at the write step with a confirm token.
    const turn1 = payloadOf(await runAssistant(
      ownerTask('check then book', 'resume-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...opts, runSkillImpl: fixedPlanner(plan) },
    ));
    const confirmToken = typeof turn1.confirmToken === 'string' ? turn1.confirmToken : '';
    assert(confirmToken !== '', `a write step must pause with a confirm token, got ${JSON.stringify(turn1)}`);
    assert(turn1.partial === true, 'a paused plan must be partial');
    assert(calls.filter((t) => t === 'calendar.createEvent').length === 0, `the event must NOT be written before confirmation, got ${JSON.stringify(calls)}`);

    // Turn 2: the confirm token resumes the PARKED plan (not a lone write).
    const turn2 = payloadOf(await runAssistant(
      ownerTask(confirmToken, 'resume-2'),
      undefined,
      { ownerId: 'alice-oid' },
      { ...opts, runSkillImpl: fixedPlanner(plan) },
    ));
    assert(turn2.partial === false, `the resumed plan must complete, got ${JSON.stringify(turn2)}`);
    assert(typeof turn2.reply === 'string' && turn2.reply.trim().length > 0, 'resume must produce a visible reply');
    assert(calls.filter((t) => t === 'calendar.createEvent').length === 1, `the confirmed write must run exactly once, got ${JSON.stringify(calls)}`);
    assert(calls.filter((t) => t === 'calendar.freeBusy').length === 1, `the already-completed step must NOT re-run on resume, got ${JSON.stringify(calls)}`);
    console.log('▸ resume: write step parks the plan; the confirm token finishes it once (no step replay) ✓');
  }

  // 4. runIf guard skips a step whose condition isn't met.
  {
    const calls: string[] = [];
    const runIntegration: RunIntegration = async (tool) => {
      calls.push(tool);
      // Busy: a non-empty freeBusy means the `free` guard should NOT fire.
      if (tool === 'calendar.freeBusy') return { ok: true, freeBusy: [{ start: '2026-07-02T14:00:00', end: '2026-07-02T15:00:00' }], window: FREE_WINDOW };
      return { ok: true, tool };
    };
    const plan = {
      ok: true,
      reply: 'If free, book.',
      steps: [
        { id: 'step1', kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: 'Thursday afternoon' } },
        { id: 'step2', kind: 'use-integration', tool: 'calendar.createEvent', args: { summary: 'Sync', start: '2026-07-02T14:00:00', end: '2026-07-02T14:30:00' }, runIf: { from: 'step1', predicate: 'free' } },
      ],
    };
    const out = payloadOf(await runAssistant(
      ownerTask('if free book', 'guard-1'),
      undefined,
      { ownerId: 'alice-oid' },
      { offline: true, runSkillImpl: fixedPlanner(plan), runIntegration, bookingPolicy: 'auto', bookingAuditBaseDir: join(baseDir, 'a4') },
    ));
    const steps = out.steps as Array<{ id?: string; status?: string }>;
    const guarded = steps.find((s) => s.id === 'step2');
    assert(guarded?.status === 'skipped', `a runIf:free step must be skipped when busy, got ${JSON.stringify(out.steps)}`);
    assert(!calls.includes('calendar.createEvent'), `a skipped step must not write, got ${JSON.stringify(calls)}`);
    console.log('▸ runIf: a conditional step is skipped (not run) when its predicate fails ✓');
  }

  // 5. X.1 (always-final-reply) — the SINGLE-step specialist passthrough must
  //    also carry a non-empty human reply, never a raw artifact with no reply.
  {
    const meta = { handle: 'agent.specialist', displayName: 'Specialist', skill: 'summarize', latencyMs: 1, costUsd: 0 };
    const replyOf = async (result: Omit<Parameters<typeof passthrough>[0], 'meta'>): Promise<string> => {
      const handlerResult = await passthrough({ ...result, meta }, 'agent.specialist', 'summarize');
      const artifact = handlerResult.artifacts?.[0];
      assert(artifact, `passthrough must return an artifact, got ${JSON.stringify(handlerResult)}`);
      const parsed = JSON.parse(String(artifact.data)) as unknown;
      assert(isRecord(parsed), `passthrough payload must be an object, got ${JSON.stringify(parsed)}`);
      assert(
        typeof parsed.reply === 'string' && parsed.reply.trim().length > 0,
        `single-step passthrough must carry a non-empty reply, got ${JSON.stringify(parsed)}`,
      );
      return parsed.reply as string;
    };

    // A known text field is surfaced as clean prose (not a wall of JSON).
    const summary = await replyOf({ data: { summary: 'Here is the gist.' }, artifacts: [{ kind: 'data', data: { summary: 'Here is the gist.' }, mimeType: 'application/json' }] });
    assert(summary === 'Here is the gist.', `a {summary} result must surface its text, got ${JSON.stringify(summary)}`);

    // A plain-string result passes through verbatim.
    const plain = await replyOf({ data: 'just a string', artifacts: [{ kind: 'data', data: 'just a string', mimeType: 'text/plain' }] });
    assert(plain === 'just a string', `a string result must pass through, got ${JSON.stringify(plain)}`);

    // A fieldless object still yields a non-empty reply (never silence).
    await replyOf({ data: { foo: 1 }, artifacts: [{ kind: 'data', data: { foo: 1 }, mimeType: 'application/json' }] });

    // An empty result yields a non-empty reply too.
    await replyOf({ data: undefined, artifacts: [] });
    console.log('▸ X.1: single-step specialist passthrough always carries a human reply ✓');
  }

  console.log('\naudit: ordered execution + threading + partial-never-silent + confirm-resume + runIf guard + single-step always-reply, all offline');
  console.log('✅ assistant-multistep check passed');
} catch (err) {
  console.error(`❌ assistant-multistep check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
