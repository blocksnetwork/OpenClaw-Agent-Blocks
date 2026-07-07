/**
 * Offline-safe LIVE gate for the Google Calendar MCP wiring.
 *
 * With no live calendar configured, this is a no-op so CI and local laptops
 * stay credential-free. With FOUNDATION_OFFLINE=0 and PA_CALENDAR_MCP_CMD set,
 * it verifies that the real MCP server answers a normalized calendar.freeBusy
 * call for the next seven days.
 *
 *   npm run check:calendar-live
 */

import { connectCalendarMcpFromEnv, makeCalendarRunIntegration } from '../integrations/calendar-mcp.ts';
import { loadRootEnv } from '../env.ts';

loadRootEnv();

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runLiveCheck(): Promise<void> {
  let client: Awaited<ReturnType<typeof connectCalendarMcpFromEnv>> | null = null;
  try {
    client = await connectCalendarMcpFromEnv();
    const runIntegration = makeCalendarRunIntegration(client.caller);

    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = (await runIntegration('calendar.freeBusy', { timeMin, timeMax }, { offline: false })) as unknown;

    assert(isRecord(result), `expected object result, got ${JSON.stringify(result)}`);
    assert(result.ok === true, `expected ok=true, got ${JSON.stringify(result)}`);
    assert(Object.prototype.hasOwnProperty.call(result, 'freeBusy'), 'expected a freeBusy field');

    const busyShape = Array.isArray(result.freeBusy) ? 'busy=array' : 'busy=raw-text';
    console.log(`window ${timeMin}..${timeMax}; ${busyShape}`);
    console.log('✅ calendar-live check passed');
  } finally {
    await client?.close();
  }
}

if (!process.env.PA_CALENDAR_MCP_CMD || process.env.FOUNDATION_OFFLINE !== '0') {
  console.log('skipped (no live calendar configured)');
} else {
  try {
    await runLiveCheck();
  } catch (err) {
    console.error(`❌ calendar-live check failed: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}
