/**
 * Pure presentation helpers for the bridge: shaping agent/handler results
 * into the text + artifacts the chat UI renders, humanizing calendar
 * free/busy answers, and turning arbitrary JSON output into readable
 * markdown. No server state, no I/O (other than the generic withTimeout),
 * so these stay out of the router and are trivially testable in isolation.
 */

import type { HandlerResult } from '@blocks-network/sdk';

import { previewValue } from './trace.ts';

export function assistantRunResponse(result: HandlerResult) {
  const artifacts = result.artifacts ?? [];
  const parsed = assistantPrimaryPayload(result);
  return {
    text: assistantPayloadText(parsed),
    artifact: parsed,
    artifacts: artifacts.map((artifact) => ({
      mimeType: artifact.mimeType,
      outputId: artifact.outputId,
      fileName: artifact.fileName,
      payload: artifactPayload(artifact.data),
    })),
  };
}

export function assistantPrimaryPayload(result: HandlerResult): unknown {
  const first = result.artifacts?.[0];
  return first ? artifactPayload(first.data) : null;
}

function artifactPayload(data: unknown): unknown {
  if (Buffer.isBuffer(data)) return { bytes: data.length };
  const text = typeof data === 'string' ? data : String(data ?? '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function assistantPayloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const record = payload as Record<string, unknown>;
  const lines: string[] = [];
  const friendly = friendlyAssistantResult(record);
  if (friendly) lines.push(friendly);
  else if (typeof record.reply === 'string' && record.reply.trim()) lines.push(record.reply.trim());
  if (record.proposal !== undefined && typeof record.confirmToken === 'string') {
    lines.push(`\nReply with \`${record.confirmToken}\` to confirm.`);
  }
  if (record.error !== undefined && record.error !== 'read-only-refused') {
    lines.push(`\nError: ${String(record.error)}`);
    const detail = assistantErrorDetail(record);
    if (detail) lines.push(`Detail: ${detail}`);
  }
  return lines.join('\n') || JSON.stringify(record, null, 2);
}

function assistantErrorDetail(record: Record<string, unknown>): string {
  const result = isPlainRecord(record.result) ? record.result : null;
  const candidates = [
    record.reason,
    record.message,
    result?.message,
    result?.reason,
    result?.error,
    result?.raw,
  ];
  for (const value of candidates) {
    const detail = typeof value === 'string' ? value.trim() : '';
    if (detail && detail !== String(record.error)) return previewValue(detail, 600);
  }
  return '';
}

function friendlyAssistantResult(record: Record<string, unknown>): string | null {
  const result = isPlainRecord(record.result) ? record.result : null;
  if (record.ok === false || result?.ok === false) return null;
  const integration = isPlainRecord(record.integration) ? record.integration : null;
  const tool = integration && typeof integration.tool === 'string'
    ? integration.tool
    : typeof result?.tool === 'string' ? result.tool : '';
  if (tool === 'calendar.freeBusy' && result) return calendarFreeBusyText(result);
  if (tool === 'calendar.createEvent' && result) return 'Done. I created the calendar event.';
  if (tool === 'email.draft' && result) return 'Done. I created a Gmail draft for you.';
  if (tool === 'email.send' && result) return 'Done. I sent the email.';
  if (tool === 'email.list' && result) return 'I found matching email results for you.';
  return null;
}

function calendarFreeBusyText(result: Record<string, unknown>): string {
  const window = isPlainRecord(result.window) ? result.window : {};
  const label = friendlyWindow(window);
  const busy = Array.isArray(result.freeBusy) ? result.freeBusy : [];
  if (busy.length === 0) {
    return label
      ? `You look free for ${label}.`
      : 'You look free in that window.';
  }
  const blocks = busy.slice(0, 4).map((block) => friendlyBusyBlock(block)).filter(Boolean);
  const suffix = busy.length > blocks.length ? `, plus ${busy.length - blocks.length} more` : '';
  return `You have ${busy.length} busy block${busy.length === 1 ? '' : 's'}${label ? ` for ${label}` : ''}: ${blocks.join('; ')}${suffix}.`;
}

function friendlyWindow(window: Record<string, unknown>): string {
  const min = typeof window.timeMin === 'string' ? window.timeMin : '';
  const max = typeof window.timeMax === 'string' ? window.timeMax : '';
  if (!min || !max) return '';
  const local = localCalendarWindowLabel(min, max);
  if (local) return local;
  const start = new Date(min);
  const end = new Date(max);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  return `${start.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} to ${end.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function localCalendarWindowLabel(timeMin: string, timeMax: string): string {
  const start = parseLocalCalendarIso(timeMin);
  const end = parseLocalCalendarIso(timeMax);
  if (!start || !end) return '';
  if (start.date === end.date) return `${calendarDateLabel(start)} ${clockLabel(start)} to ${clockLabel(end)}`;
  return `${calendarDateLabel(start)} ${clockLabel(start)} to ${calendarDateLabel(end)} ${clockLabel(end)}`;
}

function parseLocalCalendarIso(value: string): { date: string; hour: number; minute: number; dateForLabel: Date } | null {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}$/u);
  if (!match) return null;
  const [year, month, day] = match[1].split('-').map(Number);
  return {
    date: match[1],
    hour: Number(match[2]),
    minute: Number(match[3]),
    dateForLabel: new Date(Date.UTC(year, month - 1, day)),
  };
}

function calendarDateLabel(parts: { dateForLabel: Date }): string {
  return parts.dateForLabel.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function clockLabel(parts: { hour: number; minute: number }): string {
  const hour12 = parts.hour % 12 || 12;
  const suffix = parts.hour >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(parts.minute).padStart(2, '0')} ${suffix}`;
}

function friendlyBusyBlock(block: unknown): string {
  if (!isPlainRecord(block)) return String(block);
  const start = typeof block.start === 'string' ? block.start : '';
  const end = typeof block.end === 'string' ? block.end : '';
  if (!start || !end) return JSON.stringify(block);
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${start}-${end}`;
  return `${s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}-${e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function callOutputText(data: unknown): string {
  if (typeof data === 'string') return data.trim() || '(empty response)';
  if (isPlainRecord(data)) return recordOutputMarkdown(data);
  try {
    return fencedJson(data);
  } catch {
    return String(data);
  }
}

function recordOutputMarkdown(record: Record<string, unknown>): string {
  const lines: string[] = [];
  const used = new Set<string>();
  const summary = firstStringField(record, ['summary', 'title', 'headline']);
  if (summary) lines.push(`**Summary:** ${summary.value}`);
  if (summary) used.add(summary.key);

  const body = firstStringField(record, ['draft', 'reply', 'response', 'message', 'text', 'content', 'completion', 'output']);
  if (body && body.value !== summary?.value) {
    lines.push(`**${body.key === 'draft' ? 'Draft' : humanizeKey(body.key)}**\n\n${body.value}`);
    used.add(body.key);
  }

  for (const key of Object.keys(record)) {
    if (used.has(key)) continue;
    const value = record[key];
    if (isEmptyOutputValue(value)) continue;
    const block = outputFieldMarkdown(key, value);
    if (block) lines.push(block);
  }

  return lines.join('\n\n') || fencedJson(record);
}

function firstStringField(record: Record<string, unknown>, keys: string[]): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return { key, value: value.trim() };
  }
  return undefined;
}

function outputFieldMarkdown(key: string, value: unknown): string | undefined {
  const label = humanizeKey(key);
  if (typeof value === 'string') return `**${label}:** ${value.trim()}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `**${label}:** ${String(value)}`;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
      return `**${label}:** ${value.map((item) => String(item)).join(', ')}`;
    }
    const formatted = formatRecordArray(value);
    return formatted ? `**${label}**\n\n${formatted}` : `**${label}**\n\n${fencedJson(value)}`;
  }
  if (isPlainRecord(value)) return `**${label}**\n\n${fencedJson(value)}`;
  return undefined;
}

function formatRecordArray(value: unknown[]): string | undefined {
  const rows = value.filter(isPlainRecord);
  if (rows.length !== value.length || rows.length === 0) return undefined;
  return rows.map((row, index) => {
    const title = stringFromKeys(row, ['subject', 'title', 'name', 'label']) ?? { key: 'item', value: `Item ${index + 1}` };
    const score = stringFromKeys(row, ['expected_open_rate', 'score', 'rating']);
    const rationale = stringFromKeys(row, ['rationale', 'reason', 'summary', 'description']);
    const suffix = [score ? ` - ${humanizeKey(score.key)}: ${score.value}` : '', rationale ? `. ${rationale.value}` : ''].join('');
    return `${index + 1}. **${title.value}**${suffix}`;
  }).join('\n');
}

function stringFromKeys(record: Record<string, unknown>, keys: string[]): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      return { key, value: String(value).trim() };
    }
  }
  return undefined;
}

function isEmptyOutputValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/_/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^./u, (c) => c.toUpperCase());
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
