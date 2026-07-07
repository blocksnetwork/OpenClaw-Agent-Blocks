/**
 * calendar-mcp — the LIVE half of the `use-integration` calendar read path
 * (Phase 8.1; docs/PERSONAL-ASSISTANT-PLAN.md → "Phase 8", decision D9 =
 * Google Calendar).
 *
 * The personal-assistant brain PLANS a `calendar.freeBusy` action; the
 * runtime executes it through this module, which speaks MCP to a Google
 * Calendar server (`@cocal/google-calendar-mcp` by default) — the same kind
 * of OpenClaw integration the gateway registers, just driven directly so
 * the result is deterministic.
 *
 * The mapping (our tool name → the server's tool + arg shape, and the
 * normalize step) is PURE, so it tests offline with a fake caller — no
 * spawn, no OAuth, no network. The stdio transport that launches the real
 * server is isolated behind `connectCalendarMcpFromEnv()` and only loaded
 * on the live path. Reads use `get-freebusy` / `list-events`; writes use
 * `create-event` and are only reachable through the runtime write gate.
 */

import type { RunIntegration } from '../assistant/assistant-runtime.ts';

/** The minimal MCP tool-call surface this module needs. Keeping it tiny lets
 *  the pure mapping be tested with a fake caller. */
export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface CalendarRunOptions {
  /** Look-ahead window (days) used when the action carries no explicit
   *  `timeMin`/`timeMax`. */
  windowDays?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Env overrides for a specific owner/integration runner. */
  env?: NodeJS.ProcessEnv;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type Weekday = (typeof WEEKDAYS)[number];

/**
 * Resolve the `{ timeMin, timeMax }` ISO window for a free/busy query. An
 * explicit `timeMin`/`timeMax` in the action args wins. Common demo prompts
 * such as "tomorrow morning" and "next Tuesday afternoon" resolve to a
 * concrete window; otherwise it spans `now → now + windowDays`.
 */
export function resolveWindow(
  args: Record<string, unknown>,
  windowDays: number,
  now: Date,
): { timeMin: string; timeMax: string } {
  const hasMin = typeof args.timeMin === 'string' && args.timeMin.trim() !== '';
  const start = hasMin ? new Date(args.timeMin as string) : now;
  const timeMin = hasMin ? (args.timeMin as string) : now.toISOString();
  if (hasMin) {
    const timeMax =
      typeof args.timeMax === 'string' && args.timeMax.trim() !== ''
        ? args.timeMax
        : new Date(start.getTime() + windowDays * DAY_MS).toISOString();
    return { timeMin, timeMax };
  }

  const natural = resolveNaturalWindow(args.query, now);
  if (natural) return natural;

  const timeMax =
    typeof args.timeMax === 'string' && args.timeMax.trim() !== ''
      ? args.timeMax
      : new Date(start.getTime() + windowDays * DAY_MS).toISOString();
  return { timeMin, timeMax };
}

function resolveNaturalWindow(query: unknown, now: Date): { timeMin: string; timeMax: string } | null {
  if (typeof query !== 'string' || query.trim() === '') return null;
  const lower = query.toLowerCase();
  const explicitDate = resolveNaturalDate(lower, now);
  const range = resolveNaturalTimeRange(lower);
  // Nothing to anchor on: let the caller fall back to its look-ahead window.
  if (!explicitDate && !range) return null;
  // A bare time with no date defaults to today, or tomorrow if that time has
  // already passed, so "at 3pm" schedules against 3pm — not `now`.
  const ymd = explicitDate ?? defaultDateForTime(range, now);
  const effectiveRange = range ?? { start: '00:00:00', end: '23:59:59' };
  return {
    timeMin: `${ymd}T${effectiveRange.start}`,
    timeMax: `${ymd}T${effectiveRange.end}`,
  };
}

/** Pick the day for a dateless time query: today when the time is still
 *  ahead, otherwise tomorrow. Uses the same UTC day basis as the rest of the
 *  resolver. */
function defaultDateForTime(range: { start: string; end: string } | null, now: Date): string {
  const today = utcDateOnly(now);
  if (!range) return today;
  const nowClock = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:00`;
  return range.start > nowClock ? today : addDaysYmd(today, 1);
}

function resolveNaturalDate(lower: string, now: Date): string | null {
  const today = utcDateOnly(now);
  const explicit = lower.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1];
  if (explicit) return explicit;
  if (/\btoday\b/u.test(lower)) return today;
  if (/\btomorrow\b/u.test(lower)) return addDaysYmd(today, 1);

  const prefixedWeekday = lower.match(/\b(?:next|this|coming)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u)?.[1] as Weekday | undefined;
  if (prefixedWeekday) return nextWeekdayYmd(today, prefixedWeekday, lower.includes(`this ${prefixedWeekday}`));

  const bareWeekday = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u)?.[1] as Weekday | undefined;
  if (bareWeekday) return nextWeekdayYmd(today, bareWeekday, true);
  return null;
}

function resolveNaturalTimeRange(lower: string): { start: string; end: string } | null {
  const explicit = lower.match(/\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|until|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/u);
  if (explicit) {
    const startSuffix = explicit[3] ?? explicit[6] ?? '';
    const endSuffix = explicit[6] ?? explicit[3] ?? '';
    const start = toClock(explicit[1], explicit[2], startSuffix);
    const end = toClock(explicit[4], explicit[5], endSuffix);
    if (start && end) return { start, end };
  }
  // A bare single time ("at 3pm", "3 pm", "15:00") anchors a default
  // one-hour window so the caller isn't silently widened to the whole day.
  const single = lower.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/u)
    ?? lower.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})()\b/u);
  if (single) {
    const start = toClock(single[1], single[2], single[3] ?? '');
    if (start) return { start, end: addHourClock(start) };
  }
  if (/\bmorning\b/u.test(lower)) return { start: '09:00:00', end: '12:00:00' };
  if (/\bafternoon\b/u.test(lower)) return { start: '12:00:00', end: '17:00:00' };
  if (/\bevening\b/u.test(lower)) return { start: '17:00:00', end: '21:00:00' };
  return null;
}

/** Add one hour to an `HH:MM:SS` clock, clamped to the end of the day so a
 *  late start ("11pm") still yields a valid window. */
function addHourClock(clock: string): string {
  const [hour, minute] = clock.split(':').map(Number);
  const end = hour + 1;
  if (end > 23) return '23:59:59';
  return `${String(end).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function toClock(hourText: string, minuteText: string | undefined, suffix: string): string | null {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function nextWeekdayYmd(today: string, weekday: Weekday, allowToday: boolean): string {
  const current = weekdayIndex(today);
  const target = WEEKDAYS.indexOf(weekday);
  let delta = target - current;
  if (delta < 0 || (delta === 0 && !allowToday)) delta += 7;
  return addDaysYmd(today, delta);
}

function weekdayIndex(ymd: string): number {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addDaysYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  return utcDateOnly(new Date(Date.UTC(year, month - 1, day + days)));
}

function utcDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Concatenate the text content blocks of an MCP tool result. */
export function textOf(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((c) => (c.type ?? 'text') === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
}

/**
 * Normalize a `get-freebusy` result into our shape. Defensive: the server
 * may return JSON or human-readable text, so we surface a best-effort
 * `busy` array when we can parse it, and always keep the raw text — under
 * the `freeBusy` key so the A2A share policy + the brain pass it through
 * unchanged (they never need to parse it).
 */
export function normalizeFreeBusy(
  result: McpToolResult,
  window: { timeMin: string; timeMax: string },
): Record<string, unknown> {
  const raw = textOf(result);
  let busy: unknown;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.busy)) {
        busy = obj.busy;
      } else if (obj.calendars && typeof obj.calendars === 'object') {
        // Google free/busy shape: { calendars: { <id>: { busy: [...] } } }.
        const merged: unknown[] = [];
        for (const cal of Object.values(obj.calendars as Record<string, unknown>)) {
          const b = (cal as Record<string, unknown> | null)?.busy;
          if (Array.isArray(b)) merged.push(...b);
        }
        busy = merged;
      }
    }
  } catch {
    // Not JSON — keep the raw text as the free/busy summary.
  }
  return {
    ok: result.isError !== true,
    tool: 'calendar.freeBusy',
    window,
    freeBusy: busy ?? raw,
    raw,
  };
}

export function normalizeCreateEvent(result: McpToolResult): Record<string, unknown> {
  const raw = textOf(result);
  let event: unknown = raw;
  try {
    event = JSON.parse(raw) as unknown;
  } catch {
    // Plain-text server output is still useful to surface.
  }
  return {
    ok: result.isError !== true,
    tool: 'calendar.createEvent',
    event,
    raw,
  };
}

/**
 * Build a `RunIntegration` backed by an MCP caller. PURE — no transport, no
 * env. Maps our integration tool names to the Google Calendar MCP server's
 * tools and normalizes the result. Inject a real caller in production or a
 * fake one in checks.
 */
export function makeCalendarRunIntegration(caller: McpCaller, opts: CalendarRunOptions = {}): RunIntegration {
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : 7;
  const clock = opts.now ?? (() => new Date());

  return async (tool, args) => {
    const a = args ?? {};
    if (tool === 'calendar.freeBusy') {
      const window = resolveWindow(a, windowDays, clock());
      const res = await caller.callTool('get-freebusy', {
        calendars: mcpCalendarRefs(a),
        timeMin: mcpDateTime(window.timeMin),
        timeMax: mcpDateTime(window.timeMax),
      });
      return normalizeFreeBusy(res, window);
    }
    if (tool === 'calendar.list') {
      const window = resolveWindow(a, windowDays, clock());
      const res = await caller.callTool('list-events', { timeMin: window.timeMin, timeMax: window.timeMax });
      return { ok: res.isError !== true, tool, window, events: textOf(res) };
    }
    if (tool === 'calendar.createEvent') {
      const res = await caller.callTool('create-event', {
        calendarId: firstString(a.calendarId, a.calendar, a.calendar_id) || 'primary',
        summary: firstString(a.summary, a.title, a.query),
        description: firstString(a.description),
        start: firstString(a.start, a.timeMin),
        end: firstString(a.end, a.timeMax),
        attendees: Array.isArray(a.attendees) ? a.attendees : [],
      });
      return normalizeCreateEvent(res);
    }
    throw new Error(`unsupported calendar tool "${tool}" - supports calendar.freeBusy, calendar.list, and calendar.createEvent`);
  };
}

function calendarIds(args: Record<string, unknown>): string[] {
  const calendars = args.calendars;
  if (Array.isArray(calendars)) {
    const ids = calendars.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    if (ids.length > 0) return ids;
  }
  const calendarId = firstString(args.calendarId, args.calendar, args.calendar_id);
  return calendarId ? [calendarId] : ['primary'];
}

function mcpCalendarRefs(args: Record<string, unknown>): Array<{ id: string }> {
  return calendarIds(args).map((id) => ({ id }));
}

function mcpDateTime(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace(/\.\d{3}Z$/u, '').replace(/Z$/u, '');
  return date.toISOString().replace(/\.\d{3}Z$/u, '');
}

// ── live transport (gated; only loaded on the live path) ─────────────────

/**
 * Connect to the calendar MCP server configured by env and adapt the MCP
 * SDK client to our `McpCaller`. Isolated here so the pure mapping above
 * never pulls in the transport (offline checks stay dependency-free).
 *
 * Env:
 *   PA_CALENDAR_MCP_CMD   the executable (e.g. `npx`)
 *   PA_CALENDAR_MCP_ARGS  space-separated args (e.g. `-y @cocal/google-calendar-mcp`)
 * The spawned server reads its own GOOGLE_OAUTH_CREDENTIALS /
 * GOOGLE_CALENDAR_MCP_TOKEN_PATH from the inherited environment.
 */
export async function connectCalendarMcpFromEnv(envSource: NodeJS.ProcessEnv = process.env): Promise<{ caller: McpCaller; close: () => Promise<void> }> {
  const command = (envSource.PA_CALENDAR_MCP_CMD ?? '').trim();
  if (!command) {
    throw new Error('PA_CALENDAR_MCP_CMD is not set; cannot connect to a calendar MCP server');
  }
  const rawArgs = (envSource.PA_CALENDAR_MCP_ARGS ?? '').trim();
  const args = rawArgs ? rawArgs.split(/\s+/u) : [];

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  // Inherit the ambient environment so the server picks up its OAuth config.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envSource)) {
    if (typeof v === 'string') env[k] = v;
  }

  const transport = new StdioClientTransport({ command, args, env });
  const client = new Client({ name: 'openclaw-foundation-bridge', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  const caller: McpCaller = {
    async callTool(name, toolArgs) {
      const res = await client.callTool({ name, arguments: toolArgs });
      return res as unknown as McpToolResult;
    },
  };
  return { caller, close: () => client.close() };
}

/**
 * Env-driven `RunIntegration` with a lazily-connected, cached MCP client.
 * The runtime calls this only when live AND `PA_CALENDAR_MCP_CMD` is set; a
 * failed call drops the cached client so the next call reconnects.
 */
export function makeEnvCalendarRunIntegration(opts: Pick<CalendarRunOptions, 'env'> = {}): RunIntegration {
  const env = opts.env ?? process.env;
  const windowDays = Number(env.PA_CALENDAR_WINDOW_DAYS ?? '7') || 7;
  let cached: { caller: McpCaller; close: () => Promise<void> } | null = null;
  return async (tool, args, runOpts) => {
    if (!cached) cached = await connectCalendarMcpFromEnv(env);
    const run = makeCalendarRunIntegration(cached.caller, { windowDays });
    try {
      return await run(tool, args, runOpts);
    } catch (err) {
      try {
        await cached?.close();
      } catch {
        // best effort
      }
      cached = null;
      throw err;
    }
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}
