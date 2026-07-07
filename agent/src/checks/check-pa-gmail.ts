/**
 * Phase 3.1 offline gate - Gmail read/draft/send MCP mapping.
 *
 * Asserts, with no key and no network:
 *   1. our email.* tool names map to @klodr/gmail-mcp server tools.
 *   2. normalizers tolerate both JSON and plain text MCP results.
 *   3. the offline brain plans email.draft for draft asks and email.list for
 *      inbox/check asks.
 *   4. when PA_READONLY is explicitly disabled, email.send still reuses the
 *      shared confirm/auto/idempotent write gate.
 *
 *   npm run check:pa-gmail
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { runSkill } from '../blocks/openclaw-client.ts';
import { loadRootEnv } from '../env.ts';
import { validatePlan } from '../assistant/plan-schema.ts';
import { runAssistant, type RunIntegration, type RunSkillImpl } from '../assistant/assistant-runtime.ts';
import {
  makeGmailRunIntegration,
  normalizeMessage,
  normalizeMessageList,
  type McpCaller,
  type McpToolResult,
} from '../integrations/gmail-mcp.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
process.env.PA_READONLY = '0';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownerTask(text: string, taskId = 'pa-gmail-check'): StartTaskMessage {
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

function writeCount(writes: unknown[]): number {
  return writes.length;
}

try {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fakeCaller: McpCaller = {
    async callTool(name, args): Promise<McpToolResult> {
      calls.push({ name, args });
      if (name === 'search_emails') {
        return { content: [{ type: 'text', text: JSON.stringify({ messages: [{ id: 'm1', subject: 'Hello' }] }) }] };
      }
      if (name === 'read_email') {
        return { content: [{ type: 'text', text: JSON.stringify({ id: 'm1', body: 'Hello from Dana' }) }] };
      }
      if (name === 'draft_email') {
        return { content: [{ type: 'text', text: JSON.stringify({ id: 'd1', status: 'draft' }) }] };
      }
      if (name === 'send_email') {
        return { content: [{ type: 'text', text: JSON.stringify({ id: 's1', status: 'sent' }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: `unexpected tool: ${name}` }] };
    },
  };
  const run = makeGmailRunIntegration(fakeCaller, { maxResults: 5 });

  const listed = (await run('email.list', { query: 'from:dana' }, { offline: false })) as Record<string, unknown>;
  assert(calls[0].name === 'search_emails', `email.list must call search_emails, got ${calls[0].name}`);
  assert(
    calls[0].args.query === 'from:dana' && calls[0].args.maxResults === 5,
    `email.list args must preserve query + default limit, got ${JSON.stringify(calls[0].args)}`,
  );
  assert(Array.isArray(listed.messages), `email.list must normalize messages, got ${JSON.stringify(listed)}`);

  const read = (await run('email.read', { id: 'm1' }, { offline: false })) as Record<string, unknown>;
  assert(calls[1].name === 'read_email', `email.read must call read_email, got ${calls[1].name}`);
  assert(calls[1].args.messageId === 'm1', `email.read must pass messageId, got ${JSON.stringify(calls[1].args)}`);
  assert(isRecord(read.message) && read.message.id === 'm1', `email.read must normalize message JSON, got ${JSON.stringify(read)}`);

  const drafted = (await run(
    'email.draft',
    { to: 'dana@example.com', subject: 'Review', body: 'I will join the 2pm review.' },
    { offline: false },
  )) as Record<string, unknown>;
  assert(calls[2].name === 'draft_email', `email.draft must call draft_email, got ${calls[2].name}`);
  assert(
    JSON.stringify(calls[2].args.to) === JSON.stringify(['dana@example.com']) && calls[2].args.subject === 'Review',
    `email.draft must pass draft fields, got ${JSON.stringify(calls[2].args)}`,
  );
  assert(isRecord(drafted.draft) && drafted.draft.id === 'd1', `email.draft must normalize draft JSON, got ${JSON.stringify(drafted)}`);

  const sent = (await run(
    'email.send',
    { to: 'dana@example.com', subject: 'Review', body: 'I will join the 2pm review.' },
    { offline: false },
  )) as Record<string, unknown>;
  assert(calls[3].name === 'send_email', `email.send must call send_email, got ${calls[3].name}`);
  assert(
    JSON.stringify(calls[3].args.to) === JSON.stringify(['dana@example.com'])
      && calls[3].args.body === 'I will join the 2pm review.',
    `email.send must pass send fields, got ${JSON.stringify(calls[3].args)}`,
  );
  assert(isRecord(sent.sent) && sent.sent.id === 's1', `email.send must normalize send JSON, got ${JSON.stringify(sent)}`);
  console.log('▸ mapping: email.list/read/draft/send → search_emails/read_email/draft_email/send_email ✓');

  const jsonList = normalizeMessageList({ content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'm2' }] }) }] });
  assert(Array.isArray(jsonList.messages), `JSON list must normalize to array, got ${JSON.stringify(jsonList)}`);
  const textList = normalizeMessageList({ content: [{ type: 'text', text: 'Inbox: no unread mail' }] });
  assert(textList.messages === 'Inbox: no unread mail' && textList.raw === 'Inbox: no unread mail', 'plain text list must fall back to raw');
  const textMessage = normalizeMessage({ content: [{ type: 'text', text: 'Message body as text' }] });
  assert(textMessage.message === 'Message body as text', 'plain text message must fall back to raw');
  console.log('▸ normalize: JSON and plain-text MCP results produce stable shapes ✓');

  const draftPlan = validatePlan(await runSkill('personal_assistant', { request: 'Draft an email to Dana about the 2pm review.' }));
  assert(
    draftPlan.actions[0]?.kind === 'use-integration' && draftPlan.actions[0].tool === 'email.draft',
    `draft ask must plan email.draft, got ${JSON.stringify(draftPlan)}`,
  );
  const listPlan = validatePlan(await runSkill('personal_assistant', { request: 'Check my email for anything from Dana.' }));
  assert(
    listPlan.actions[0]?.kind === 'use-integration' && listPlan.actions[0].tool === 'email.list',
    `email check ask must plan email.list, got ${JSON.stringify(listPlan)}`,
  );
  const sendPlan = validatePlan(await runSkill('personal_assistant', { request: 'Send Dana an email saying I will join the 2pm review.' }));
  assert(
    sendPlan.actions[0]?.kind === 'use-integration' && sendPlan.actions[0].tool === 'email.send',
    `send ask must plan email.send, got ${JSON.stringify(sendPlan)}`,
  );
  console.log('▸ brain: draft ask → email.draft; check inbox ask → email.list; send ask → email.send ✓');

  const auditBaseDir = await mkdtemp(join(tmpdir(), 'pa-gmail-send-'));
  const writes: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const sendRunner: RunIntegration = async (tool, args) => {
    writes.push({ tool, args });
    return { ok: true, tool, sent: { id: `sent-${writes.length}` } };
  };
  const sendPlanner: RunSkillImpl = async () => ({
    ok: true,
    reply: 'Preparing to send.',
    actions: [{ kind: 'use-integration', tool: 'email.send', args: { to: 'dana@example.com', subject: 'Review', body: 'Ship it.' } }],
  });

  const proposed = payloadOf(
    await runAssistant(ownerTask('Send it after confirmation.', 'send-confirm-1'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      bookingPolicy: 'confirm',
      runIntegration: sendRunner,
      runSkillImpl: sendPlanner,
      writeIdempotencyId: 'email-send-confirm-1',
    }),
  );
  assert(typeof proposed.confirmToken === 'string', `confirm send must return token, got ${JSON.stringify(proposed)}`);
  assert(writeCount(writes) === 0, 'confirm policy must not send straight off the plan');

  const confirmed = payloadOf(
    await runAssistant(ownerTask(`Confirm ${proposed.confirmToken}`, 'send-confirm-token'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      bookingPolicy: 'confirm',
      runIntegration: sendRunner,
    }),
  );
  assert(confirmed.confirmed === true && writes.length === 1, `confirmed send must execute once, got ${JSON.stringify(confirmed)}`);
  console.log('▸ gate: confirm policy proposes email.send, token follow-up sends once ✓');

  const auto = payloadOf(
    await runAssistant(ownerTask('Send it automatically.', 'send-auto-1'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      bookingPolicy: 'auto',
      runIntegration: sendRunner,
      runSkillImpl: sendPlanner,
      writeIdempotencyId: 'email-send-auto-1',
    }),
  );
  assert(auto.ok === true && writeCount(writes) === 2, `auto send must execute once, got ${JSON.stringify(auto)}`);

  const retry = payloadOf(
    await runAssistant(ownerTask('Retry same send.', 'send-auto-1-retry'), undefined, { ownerId: 'alice-oid' }, {
      bookingAuditBaseDir: auditBaseDir,
      bookingPolicy: 'auto',
      runIntegration: sendRunner,
      runSkillImpl: sendPlanner,
      writeIdempotencyId: 'email-send-auto-1',
    }),
  );
  assert(retry.idempotent === true && writeCount(writes) === 2, `retry must not double-send, got ${JSON.stringify(retry)}`);
  console.log('▸ gate: auto sends once; retry with same idempotency id does not re-send ✓');

  console.log('\naudit: Gmail mapping + normalization + brain routing + gated send are all offline');
  console.log('✅ pa-gmail check passed');
} catch (err) {
  console.error(`❌ pa-gmail check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
