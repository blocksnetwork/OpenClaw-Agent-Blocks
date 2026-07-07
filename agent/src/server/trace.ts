/**
 * Live request tracing + terminal color for the bridge.
 *
 * Every request opens a scope; meaningful work inside the handlers narrates
 * itself to the terminal so you can watch exactly what the app is doing as
 * you use it. Set DASHBOARD_QUIET=1 to silence it, DASHBOARD_VERBOSE=1 to
 * also trace static asset + status-poll traffic. Honors NO_COLOR.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { loadRootEnv } from '../env.ts';

// Loaded before dashboard.ts runs its own loadRootEnv(); idempotent.
loadRootEnv();

export interface PartialEvent {
  at: number;
  handle: string;
  skill: string;
  message: string;
}

const LOG_QUIET = process.env.DASHBOARD_QUIET === '1';
const LOG_VERBOSE_ALL = process.env.DASHBOARD_VERBOSE === '1';
const USE_COLOR = process.env.NO_COLOR == null && process.stdout.isTTY === true;
const paint = (code: string) => (s: string) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = paint('2');
export const bold = paint('1');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const blue = paint('34');
export const cyan = paint('36');
export const gray = paint('90');

export type Verbosity = 'silent' | 'access' | 'verbose';

export interface TraceScope {
  id: string;
  method: string;
  pathname: string;
  verbosity: Verbosity;
  start: number;
  partials: number;
}

export const traceCtx = new AsyncLocalStorage<TraceScope>();
let reqSeq = 0;

/** Whether tracing is globally silenced (DASHBOARD_QUIET=1). */
export function tracingQuiet(): boolean {
  return LOG_QUIET;
}

/** Whether every request should be traced verbosely (DASHBOARD_VERBOSE=1). */
export function tracingVerboseAll(): boolean {
  return LOG_VERBOSE_ALL;
}

function emit(scope: TraceScope, body: string): void {
  const clock = gray(new Date().toISOString().slice(11, 23));
  console.log(`${clock} ${gray(`[${scope.id}]`)} ${body}`);
}

function classify(method: string, pathname: string): Verbosity {
  if (pathname === '/healthz' || pathname === '/api/status') return 'silent';
  if (pathname === '/v1/chat/completions') return 'verbose';
  if (method === 'POST' && pathname.startsWith('/api/')) return 'verbose';
  if (pathname.startsWith('/api/')) return 'access';
  if (pathname.startsWith('/outputs/')) return 'access';
  if (pathname.startsWith('/media/')) return 'access';
  return 'silent'; // static chat assets
}

export function startScope(method: string, pathname: string): TraceScope {
  reqSeq += 1;
  const verbosity = LOG_VERBOSE_ALL ? 'verbose' : classify(method, pathname);
  const scope: TraceScope = { id: `r${reqSeq}`, method, pathname, verbosity, start: performance.now(), partials: 0 };
  if (!LOG_QUIET && verbosity === 'verbose') {
    emit(scope, `${bold(cyan('▸'))} ${bold(`${method} ${pathname}`)}`);
  }
  return scope;
}

export function finishScope(scope: TraceScope, statusCode: number): void {
  if (LOG_QUIET || scope.verbosity === 'silent') return;
  const ms = (performance.now() - scope.start).toFixed(0);
  const ok = statusCode < 400;
  const code = ok ? green(String(statusCode)) : red(String(statusCode));
  if (scope.verbosity === 'access') {
    emit(scope, `${dim(`${scope.method} ${scope.pathname}`)} ${code} ${dim(`${ms}ms`)}`);
  } else {
    emit(scope, `${ok ? green('←') : red('←')} ${code} ${dim(`${ms}ms`)}`);
  }
}

/** A numbered phase within the current request. */
export function tstep(msg: string): void {
  const s = traceCtx.getStore();
  if (!s || LOG_QUIET || s.verbosity !== 'verbose') return;
  emit(s, `  ${blue('·')} ${msg}`);
}

/** Indented supporting detail for the current request. */
export function tnote(msg: string): void {
  const s = traceCtx.getStore();
  if (!s || LOG_QUIET || s.verbosity !== 'verbose') return;
  emit(s, `    ${dim(msg)}`);
}

/** A streamed partial from a Blocks call, logged live as it arrives. */
export function tpartial(e: { handle: string; skill: string; message: string }): void {
  const s = traceCtx.getStore();
  if (!s) return;
  s.partials += 1;
  if (LOG_QUIET || s.verbosity !== 'verbose') return;
  emit(s, `    ${gray('↳')} ${gray(`${e.handle} [${e.skill}]`)} ${dim(e.message)}`);
}

export function terror(msg: string): void {
  const s = traceCtx.getStore();
  if (s) emit(s, `  ${red('✗')} ${msg}`);
  else console.error(`${red('✗')} ${msg}`);
}

/** A partial listener that records for the HTTP response AND logs live. */
export function tracingPartial(sink: PartialEvent[]): (e: { handle: string; skill: string; message: string }) => void {
  return (e) => {
    sink.push({ at: Date.now(), ...e });
    tpartial(e);
  };
}

export function previewValue(value: unknown, max = 140): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s == null) s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
