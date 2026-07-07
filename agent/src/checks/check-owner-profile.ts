/**
 * Pillar 0.7 offline gate — owner identity profile store + threading.
 *
 * Asserts, with no key and no network:
 *   1. Profile save/load round-trips and isolates owners; a traversal-shaped
 *      ownerId stays inside the store dir.
 *   2. The owner profile is fed into the brain's plan inputs (the assistant
 *      learns "who I am").
 *   3. The profile timezone overrides the PA_TIMEZONE/TZ env at the exact
 *      booking-extractor call site (Pillar 0.3 wiring seam).
 *   4. Back-compat: with no profile set, planning carries no owner identity
 *      and the booking extractor falls back to the env timezone.
 *
 *   npm run check:owner-profile
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { StartTaskMessage } from '@blocks-network/sdk';

import { loadRootEnv } from '../env.ts';
import {
  loadOwnerProfile,
  ownerProfilePath,
  removeOwnerProfile,
  saveOwnerProfile,
} from '../assistant/owner-profile.ts';
import { runAssistant, type RunSkillImpl } from '../assistant/assistant-runtime.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';
// Booking is allowed (confirm mode) so calendar.createEvent reaches the
// extractor seam where the profile timezone must win.
process.env.PA_ALLOW_CALENDAR_BOOKING = '1';
process.env.PA_TIMEZONE = 'America/New_York';
delete process.env.PA_BRAIN_LIVE;

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
  assert(isRecord(parsed), `expected object payload, got ${JSON.stringify(parsed)}`);
  return parsed;
}

function ownerTask(text: string, ownerId: string, taskId = `owner-profile-${ownerId}`): StartTaskMessage {
  return {
    type: 'StartTask',
    taskId,
    ownerId,
    requestParts: [{ partId: 'request', text, contentType: 'text/plain' }],
  } as StartTaskMessage;
}

/** A planner+extractor that always books, and records every skill input so
 *  the check can inspect what the runtime fed the brain. */
function recordingRunSkill(record: { planInputs?: Record<string, unknown>; extractTimezone?: string }): RunSkillImpl {
  return async (skill, inputs) => {
    if (skill === 'personal_assistant') {
      record.planInputs = inputs;
      return {
        ok: true,
        reply: "I'll prepare that booking.",
        actions: [{ kind: 'use-integration', tool: 'calendar.createEvent', args: { query: String(inputs.request ?? '') } }],
      };
    }
    if (skill === 'calendar_event_extract') {
      record.extractTimezone = typeof inputs.timezone === 'string' ? inputs.timezone : undefined;
      return { ok: true, start: '2026-07-02T13:00:00', end: '2026-07-02T14:00:00', summary: 'Booked meeting' };
    }
    return { ok: true };
  };
}

let baseDir: string | undefined;

try {
  baseDir = await mkdtemp(join(tmpdir(), 'owner-profile-'));

  // 1. Save/load round-trip + owner isolation + sanitized path.
  const saved = await saveOwnerProfile(
    'alice-oid',
    { displayName: 'Alice Rivera', email: 'alice@example.com', timezone: 'Asia/Tokyo', orgId: 'acme' },
    { baseDir },
  );
  assert(saved.ownerId === 'alice-oid', 'saved profile must key on the supplied ownerId');
  const alice = await loadOwnerProfile('alice-oid', { baseDir });
  assert(alice?.displayName === 'Alice Rivera', `displayName must round-trip, got ${JSON.stringify(alice)}`);
  assert(alice?.email === 'alice@example.com', 'email must round-trip');
  assert(alice?.timezone === 'Asia/Tokyo', 'timezone must round-trip');
  assert(alice?.orgId === 'acme', 'orgId must round-trip');
  assert((await loadOwnerProfile('bob-oid', { baseDir })) === null, 'an owner with no profile must load as null (back-compat)');
  console.log('▸ store: profile save/load round-trips and isolates owners ✓');

  const dangerous = '../../alice/../../secret';
  const storePath = resolve(ownerProfilePath(dangerous, { baseDir }));
  assert(storePath.startsWith(resolve(baseDir)), `profile path must stay inside baseDir, got ${storePath}`);
  console.log('▸ sanitizer: traversal-shaped ownerId stays inside the profile store ✓');

  // 2 + 3. With a profile, the brain learns identity AND the booking
  //        extractor reasons in the owner's timezone (Asia/Tokyo wins).
  const withProfile = recordingRunSkill({});
  const withProfileRecord: { planInputs?: Record<string, unknown>; extractTimezone?: string } = {};
  const auditDir = join(baseDir, 'booking-audit');
  await runAssistant(
    ownerTask('Book a meeting Thursday 1pm to 2pm.', 'alice-oid', 'profile-booking'),
    undefined,
    { ownerId: 'alice-oid' },
    {
      offline: false,
      ownerProfile: alice!,
      runSkillImpl: recordingRunSkill(withProfileRecord),
      runIntegration: async (tool, args) => ({ ok: true, tool, args }),
      bookingAuditBaseDir: auditDir,
      writeIdempotencyId: 'profile-tz-1',
    },
  );
  void withProfile;
  const owner = isRecord(withProfileRecord.planInputs?.owner) ? withProfileRecord.planInputs!.owner : null;
  assert(owner !== null, `brain inputs must carry an owner identity, got ${JSON.stringify(withProfileRecord.planInputs)}`);
  assert(owner.displayName === 'Alice Rivera' && owner.email === 'alice@example.com', 'brain must learn the owner name + email');
  assert(owner.timezone === 'Asia/Tokyo', 'brain must learn the owner timezone');
  assert(
    withProfileRecord.extractTimezone === 'Asia/Tokyo',
    `booking extractor must use the profile timezone, got ${withProfileRecord.extractTimezone}`,
  );
  console.log('▸ threading: profile feeds the brain identity AND overrides env timezone at the extractor seam ✓');

  // 4. Back-compat: no profile → no owner identity in inputs; extractor
  //    falls back to the PA_TIMEZONE env (America/New_York).
  const noProfileRecord: { planInputs?: Record<string, unknown>; extractTimezone?: string } = {};
  await runAssistant(
    ownerTask('Book a meeting Thursday 1pm to 2pm.', 'bob-oid', 'no-profile-booking'),
    undefined,
    { ownerId: 'bob-oid' },
    {
      offline: false,
      runSkillImpl: recordingRunSkill(noProfileRecord),
      runIntegration: async (tool, args) => ({ ok: true, tool, args }),
      bookingAuditBaseDir: auditDir,
      writeIdempotencyId: 'no-profile-tz-1',
    },
  );
  assert(
    noProfileRecord.planInputs && noProfileRecord.planInputs.owner === undefined,
    `no profile must carry no owner identity, got ${JSON.stringify(noProfileRecord.planInputs)}`,
  );
  assert(
    noProfileRecord.extractTimezone === 'America/New_York',
    `no profile must fall back to the env timezone, got ${noProfileRecord.extractTimezone}`,
  );
  console.log('▸ back-compat: no profile → no injected identity; extractor uses the env timezone ✓');

  // 5. The deterministic fallback planner can route a profile question, but
  //    its canned reply is generic. The runtime must answer from the loaded
  //    owner profile so hosted/offline fallback paths still personalize.
  const profileQuestion = await runAssistant(
    ownerTask("Who are you and what's my email and timezone?", 'alice-oid', 'profile-direct-answer'),
    undefined,
    { ownerId: 'alice-oid' },
    {
      offline: false,
      ownerProfile: alice!,
      runSkillImpl: async (skill) => {
        if (skill === 'personal_assistant') {
          return {
            ok: true,
            reply: "I'm your private assistant — here's what I have from your profile.",
            actions: [{ kind: 'answer-direct' }],
          };
        }
        return { ok: true };
      },
      bookingAuditBaseDir: auditDir,
    },
  );
  const profilePayload = payloadOf(profileQuestion);
  const directReply = String(profilePayload.reply ?? '');
  assert(directReply.includes('Alice Rivera'), `direct profile reply must include displayName, got ${directReply}`);
  assert(directReply.includes('alice@example.com'), `direct profile reply must include email, got ${directReply}`);
  assert(directReply.includes('Asia/Tokyo'), `direct profile reply must include timezone, got ${directReply}`);
  assert(!directReply.includes("here's what I have"), `direct profile reply must not leak the generic fallback text, got ${directReply}`);
  console.log('▸ direct answer: profile questions return saved name/email/timezone even through the fallback planner ✓');

  await removeOwnerProfile('alice-oid', { baseDir });
  assert((await loadOwnerProfile('alice-oid', { baseDir })) === null, 'removeOwnerProfile must delete the record');
  console.log('▸ remove: profile removal and missing-owner load are safe ✓');

  console.log('\naudit: owner identity profile is isolated, sanitized, threaded into the brain, timezone-authoritative, and used for direct profile answers');
  console.log('✅ owner-profile check passed');
} catch (err) {
  console.error(`❌ owner-profile check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
}
