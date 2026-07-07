/**
 * Observable end-to-end test suite — watch the whole app work.
 *
 * Unlike `npm test` (silent node:test assertions), this harness narrates
 * EVERY step of the OpenClaw → Blocks orchestration spine with a
 * timestamped trace, so you can see exactly what is happening:
 *
 *   • local OpenClaw skills (echo_check / headline_writer / pick_best)
 *   • connect() → discover() → call() round-trips (with streamed partials)
 *   • binary artifact materialization (download → save → describe)
 *   • fan-out coordination: all / race / quorum / best (the local judge)
 *   • sequential pipeline (one session, step output feeds the next)
 *   • retry/backoff against the deliberately-flaky mock agent
 *   • (optional) the live dashboard HTTP bridge, if one is running
 *
 * The in-process scenarios force FOUNDATION_OFFLINE=1 so the run is
 * deterministic, needs no key, and never touches the network.
 *
 *   npm run suite                 # full trace
 *   npm run suite -- --quiet      # checks + summary only (no partials)
 *   npm run suite -- --only fanout # run scenarios whose name matches
 *   DASHBOARD_PORT=18888 npm run suite   # also probe a running dashboard
 */

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadRootEnv } from '../env.ts';
import { runSkill } from '../blocks/openclaw-client.ts';
import { connect } from '../blocks/blocks-client.ts';
import { fanout } from './fanout.ts';
import { pipeline } from './pipeline.ts';
import type { CallMeta, PartialListener } from '../types.ts';

loadRootEnv();
// The in-process scenarios are deterministic only against the mock
// catalog. Force offline so the trace is reproducible with no key.
process.env.FOUNDATION_OFFLINE = '1';

// ── flags ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i !== -1 ? (argv[i + 1] ?? '').toLowerCase() : '';
})();

// ── tiny ANSI palette (auto-off when piped or NO_COLOR) ──────────────────
const USE_COLOR = process.env.NO_COLOR == null && process.stdout.isTTY === true;
const paint = (code: string) => (s: string) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const blue = paint('34');
const magenta = paint('35');
const cyan = paint('36');
const gray = paint('90');

const START = performance.now();
const stamp = () => {
  const s = ((performance.now() - START) / 1000).toFixed(3).padStart(7, ' ');
  return gray(`[${s}s]`);
};
const line = (msg: string) => console.log(`${stamp()} ${msg}`);

// ── per-scenario trace surface ───────────────────────────────────────────
class SkipError extends Error {}

interface ScenarioRecord {
  name: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  ms: number;
  checks: number;
  failed: string[];
  note?: string;
}

interface Trace {
  /** A numbered phase within the scenario. */
  step(msg: string): void;
  /** Indented supporting detail. */
  detail(msg: string): void;
  /** A streamed partial from a Blocks call (suppressed in --quiet). */
  partial(e: { handle: string; skill: string; message: string }): void;
  /** A named value, pretty-printed. */
  show(label: string, value: unknown): void;
  /** A pass/fail assertion. Records the result; never throws. */
  check(desc: string, cond: unknown): void;
  /** Print an audit table and fold it into the suite-wide totals. */
  audit(rows: CallMeta[]): void;
  /** Abort the scenario as "skipped" with a reason. */
  skip(reason: string): never;
  /** A partial listener wired straight into connect/fanout/pipeline. */
  onPartial: PartialListener;
}

const registry: Array<{ name: string; title: string; fn: (t: Trace) => Promise<void> }> = [];
function scenario(name: string, title: string, fn: (t: Trace) => Promise<void>) {
  registry.push({ name, title, fn });
}

const allAudit: CallMeta[] = [];

async function runScenario(
  index: number,
  total: number,
  def: { name: string; title: string; fn: (t: Trace) => Promise<void> },
): Promise<ScenarioRecord> {
  const rec: ScenarioRecord = {
    name: def.name,
    title: def.title,
    status: 'pass',
    ms: 0,
    checks: 0,
    failed: [],
  };

  console.log('');
  line(`${bold(cyan(`▸ scenario ${index}/${total}`))} ${bold(def.title)} ${dim(`(${def.name})`)}`);

  let stepNo = 0;
  const t: Trace = {
    step(msg) {
      stepNo += 1;
      line(`  ${blue(`${stepNo}.`)} ${msg}`);
    },
    detail(msg) {
      line(`     ${dim('·')} ${msg}`);
    },
    partial(e) {
      if (QUIET) return;
      line(`     ${gray('↳')} ${gray(`${e.handle} [${e.skill}]`)} ${dim(e.message)}`);
    },
    show(label, value) {
      line(`     ${dim('·')} ${label}: ${gray(preview(value))}`);
    },
    check(desc, cond) {
      rec.checks += 1;
      if (cond) {
        line(`     ${green('✓')} ${desc}`);
      } else {
        rec.failed.push(desc);
        line(`     ${red('✗')} ${desc}`);
      }
    },
    audit(rows) {
      allAudit.push(...rows);
      if (rows.length === 0) {
        t.detail(dim('(no audited calls)'));
        return;
      }
      let cost = 0;
      for (const m of rows) {
        cost += m.costUsd;
        line(
          `     ${gray('│')} ${m.displayName.padEnd(22)} ${dim(`[${m.skill}]`)} `
            + `${String(m.latencyMs).padStart(5)}ms  $${m.costUsd.toFixed(3)}`,
        );
      }
      line(`     ${gray('└')} ${rows.length} call(s), $${cost.toFixed(3)}`);
    },
    skip(reason) {
      throw new SkipError(reason);
    },
    onPartial: (e) => t.partial(e),
  };

  const started = performance.now();
  try {
    await def.fn(t);
    rec.ms = performance.now() - started;
    if (rec.failed.length > 0) {
      rec.status = 'fail';
      rec.note = `${rec.failed.length} check(s) failed`;
    }
  } catch (err) {
    rec.ms = performance.now() - started;
    if (err instanceof SkipError) {
      rec.status = 'skip';
      rec.note = err.message;
      line(`     ${yellow('⊘')} skipped: ${err.message}`);
    } else {
      rec.status = 'fail';
      rec.note = err instanceof Error ? err.message : String(err);
      line(`     ${red('✗ threw:')} ${rec.note}`);
    }
  }

  const glyph =
    rec.status === 'pass' ? green('✓ pass') : rec.status === 'skip' ? yellow('⊘ skip') : red('✗ fail');
  line(`  ${glyph} ${dim(`${rec.checks} check(s) · ${rec.ms.toFixed(0)}ms`)}`);
  return rec;
}

function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s == null) s = String(value);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

// ── scenarios ─────────────────────────────────────────────────────────────

scenario('local-skills', 'Local OpenClaw skills run on the gateway stub', async (t) => {
  t.step('runSkill("echo_check") — normalizes input text');
  const echo = (await runSkill('echo_check', { text: '  Hello WORLD  ' })) as {
    ok?: boolean;
    normalized?: string;
  };
  t.show('output', echo);
  t.check('echo_check returns ok:true', echo.ok === true);
  t.check('text is trimmed + lowercased', echo.normalized === 'hello world');

  t.step('runSkill("headline_writer") — drafts a short headline');
  const head = (await runSkill('headline_writer', {
    text: 'The product launch slipped a week because of a battery recall.',
  })) as { ok?: boolean; headline?: string; wordCount?: number };
  t.show('output', head);
  t.check('headline is a non-empty string', typeof head.headline === 'string' && head.headline.length > 0);
  t.check('wordCount is reported', typeof head.wordCount === 'number' && (head.wordCount ?? 0) >= 1);

  t.step('runSkill("pick_best") — the local judge picks a winner');
  const verdict = (await runSkill('pick_best', {
    task: 'summarize the news',
    candidates: [
      { id: 'a', output: { keywords: ['battery', 'recall'] } },
      { id: 'b', output: { summary: 'The launch slipped a week.' } },
    ],
  })) as { winner?: string; reason?: string };
  t.show('verdict', verdict);
  t.check('judge prefers the sentence summary (b)', verdict.winner === 'b');
  t.check('verdict carries a reason', typeof verdict.reason === 'string' && (verdict.reason ?? '').length > 0);
});

scenario('connect-session', 'connect() opens one outbound Blocks session', async (t) => {
  t.step('connect() to Blocks (offline mock transport)');
  const session = await connect({ latencyScale: 0, onPartial: t.onPartial });
  try {
    const stats = session.stats();
    t.show('stats', stats);
    t.check('a connectionId was issued', typeof stats.connectionId === 'string' && stats.connectionId.startsWith('conn_'));
    t.check('session is offline (mock catalog)', stats.offline === true);
    t.check('no calls made yet', stats.callCount === 0);
  } finally {
    session.close();
    t.detail('session.close() — connection released');
  }
});

scenario('discovery', 'discover() finds agents BY SKILL, never by name', async (t) => {
  const session = await connect({ latencyScale: 0, onPartial: t.onPartial });
  try {
    t.step('discover("summarize")');
    const summarizers = await session.discover('summarize');
    for (const a of summarizers) t.detail(`${a.handle} — ${a.displayName} ($${a.price.amount})`);
    t.check('at least two summarizers advertise the skill', summarizers.length >= 2);
    t.check('every match actually lists "summarize"', summarizers.every((a) => a.skills.includes('summarize')));

    t.step('discover("totally-unknown-skill") — empty, not an error');
    const none = await session.discover('totally-unknown-skill');
    t.check('unknown skill yields zero matches', none.length === 0);

    t.step('discoverAll({ limit: 3 }) — pull the whole catalog');
    const all = await session.discoverAll({ limit: 3 });
    t.show('handles', all.map((a) => a.handle));
    t.check('respects the limit', all.length === 3);
  } finally {
    session.close();
  }
});

scenario('call-text', 'call() round-trips through a text agent', async (t) => {
  const session = await connect({ latencyScale: 0, onPartial: t.onPartial });
  try {
    t.step('discover("echo") then call the first match');
    const [agent] = await session.discover('echo');
    t.check('an echo agent was discovered', Boolean(agent));
    t.detail(`calling ${agent.handle} (${agent.displayName})`);
    const result = await session.call(agent.handle, 'echo', { text: 'hello world' });
    t.show('data', result.data);
    t.check('the agent echoed our input back', (result.data as { echoed?: unknown }).echoed === 'hello world');
    t.check('meta records latency', typeof result.meta.latencyMs === 'number');
    t.audit([result.meta]);
  } finally {
    session.close();
  }
});

scenario('call-artifact', 'call() materializes a binary artifact to disk', async (t) => {
  const session = await connect({ latencyScale: 0, onPartial: t.onPartial });
  try {
    t.step('discover("text-to-image") then generate a pixel image');
    const [agent] = await session.discover('text-to-image');
    t.check('an image agent was discovered', Boolean(agent));
    const result = await session.call(agent.handle, 'text-to-image', { text: 'a cat' });
    const first = (result.artifacts ?? [])[0];
    t.show('artifact', first);
    t.check('an artifact came back', Boolean(first));
    t.check('it is a saved file (not inline data)', first?.kind === 'file');

    if (first?.kind === 'file') {
      t.check('saved under outputs/', first.path.startsWith('outputs/'));
      t.check('mime type is image/png', first.mimeType === 'image/png');
      const onDisk = fileURLToPath(new URL(`../../${first.path}`, import.meta.url));
      const exists = existsSync(onDisk);
      t.check('the file actually exists on disk', exists);
      if (exists) t.detail(`${first.path} → ${statSync(onDisk).size} bytes`);
    }
    t.audit([result.meta]);
  } finally {
    session.close();
  }
});

scenario('call-guard', 'call() rejects an undiscovered handle', async (t) => {
  const session = await connect({ latencyScale: 0, onPartial: t.onPartial });
  try {
    t.step('call("blk_does_not_exist") — should throw');
    let threw = false;
    try {
      await session.call('blk_does_not_exist', 'echo', { text: 'x' });
    } catch (err) {
      threw = true;
      t.detail(`rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
    t.check('an unknown handle is rejected', threw);
  } finally {
    session.close();
  }
});

scenario('fanout-all', "fan-out mode 'all' — call everyone, audit each", async (t) => {
  t.step('fanout({ skill: "summarize", mode: "all", tries: 2 })');
  const r = await fanout({
    skill: 'summarize',
    inputs: { text: 'The launch slipped a week because of a battery recall.' },
    mode: 'all',
    tries: 2,
    latencyScale: 0,
    onPartial: t.onPartial,
  });
  for (const res of r.results) {
    const attempts = r.attemptsByHandle[res.meta.handle] ?? 1;
    t.detail(`✓ ${res.meta.handle}${attempts > 1 ? ` (ok after ${attempts} tries)` : ''} → ${preview(res.data)}`);
  }
  for (const f of r.failures) t.detail(`✗ ${f.handle} failed after ${f.attempts}: ${f.reason}`);
  t.check('mode is "all"', r.mode === 'all');
  t.check('at least one agent answered', r.results.length >= 1);
  t.check('audit has one row per success', r.audit.length === r.results.length);
  t.check('every settled handle has an attempt count', r.results.every((res) => (r.attemptsByHandle[res.meta.handle] ?? 0) >= 1));
  t.audit(r.audit);
});

scenario('fanout-race', "fan-out mode 'race' — first success wins", async (t) => {
  t.step('fanout({ skill: "summarize", mode: "race" })');
  const r = await fanout({
    skill: 'summarize',
    inputs: { text: 'alpha beta gamma delta.' },
    mode: 'race',
    latencyScale: 0,
    onPartial: t.onPartial,
  });
  t.show('winner', r.results[0]?.meta.handle);
  t.show('abandoned', r.abandoned ?? []);
  t.check('exactly one result is surfaced', r.results.length === 1);
  t.check('race produces no judge verdict', r.verdict === undefined);
  t.audit(r.audit);
});

scenario('fanout-quorum', "fan-out mode 'quorum' — resolve at N successes", async (t) => {
  t.step('fanout({ skill: "summarize", mode: "quorum", quorum: 2 })');
  const r = await fanout({
    skill: 'summarize',
    inputs: { text: 'two of you agreeing is enough.' },
    mode: 'quorum',
    quorum: 2,
    tries: 2,
    latencyScale: 0,
    onPartial: t.onPartial,
  });
  t.show('resolved with', r.results.map((x) => x.meta.handle));
  t.check('at least the requested quorum succeeded', r.results.length >= 2);
  t.audit(r.audit);
});

scenario('fanout-best', "fan-out mode 'best' — the local judge picks", async (t) => {
  t.step('fanout({ handles: [terse, keyword], mode: "best" })');
  const r = await fanout({
    skill: 'summarize',
    handles: ['blk_summarize_7c2', 'blk_summarize_b91'],
    inputs: { text: 'The launch slipped a week because of a battery recall.' },
    mode: 'best',
    latencyScale: 0,
    onPartial: t.onPartial,
  });
  t.check('both candidates answered', r.results.length === 2);
  t.check('a verdict was produced', Boolean(r.verdict));
  if (r.verdict) {
    t.show('verdict', r.verdict);
    t.check('winner is one of the candidates', r.results.some((res) => res.meta.handle === r.verdict?.winner));
    t.check('verdict carries a reason', (r.verdict.reason ?? '').trim().length > 0);
  }
  t.audit(r.audit);
});

scenario('pipeline', 'pipeline — one session, each step feeds the next', async (t) => {
  t.step('pipeline: summarize → echo (echo must receive the summary)');
  const text = 'Chain me through. Then drop the rest.';
  const r = await pipeline(
    [
      { skill: 'summarize', mapInputs: () => ({ text }) },
      { skill: 'echo', mapInputs: (prev) => ({ text: (prev as { summary: string }).summary }) },
    ],
    { latencyScale: 0, onPartial: t.onPartial },
  );
  const summary = (r.steps[0]?.data as { summary?: string })?.summary;
  const echoed = (r.steps[1]?.data as { echoed?: string })?.echoed;
  t.show('step 1 summary', summary);
  t.show('step 2 echoed', echoed);
  t.check('two steps ran', r.steps.length === 2);
  t.check('two audit rows recorded', r.audit.length === 2);
  t.check("step 2 received step 1's output", echoed === summary && typeof summary === 'string');
  t.audit(r.audit);
});

scenario('retry-flaky', 'retry/backoff recovers a flaky agent', async (t) => {
  t.step('fanout targeting the flaky agent with tries: 3');
  const r = await fanout({
    skill: 'summarize',
    handles: ['blk_flaky_500'],
    inputs: { text: 'fail once then recover, please.' },
    mode: 'all',
    tries: 3,
    backoffMs: 1,
    latencyScale: 0,
    onPartial: t.onPartial,
  });
  const attempts = r.attemptsByHandle.blk_flaky_500;
  t.show('attempts used', attempts);
  t.show('failures', r.failures.map((f) => f.reason));
  t.check('the flaky agent eventually succeeded', r.results.length === 1);
  t.check('it took at least one attempt', (attempts ?? 0) >= 1);
  if (r.results[0]) t.check('the recovered flag is set on the result', (r.results[0].data as { recovered?: boolean }).recovered === true);
  t.audit(r.audit);
});

scenario('dashboard-bridge', 'live dashboard HTTP bridge (optional)', async (t) => {
  const host = process.env.DASHBOARD_HOST ?? '127.0.0.1';
  const port = Number(process.env.DASHBOARD_PORT ?? 18888);
  const base = `http://${host}:${port}`;
  t.step(`probe ${base}/api/status`);

  let status!: { ok?: boolean; offline?: boolean; hasBlocksKey?: boolean; serving?: number };
  try {
    const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) t.skip(`dashboard responded HTTP ${res.status}`);
    status = (await res.json()) as typeof status;
  } catch {
    t.skip(`no dashboard reachable at ${base} (start one with: npm run dashboard)`);
  }
  t.show('status', status);
  t.check('status reports ok', status.ok === true);

  t.step('POST /api/run-skill (echo_check) through the bridge');
  const skillRes = await fetch(`${base}/api/run-skill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill: 'echo_check', inputs: { text: '  Bridge TEST  ' } }),
    signal: AbortSignal.timeout(120_000),
  });
  const skillBody = (await skillRes.json()) as { ok?: boolean; data?: { normalized?: string } };
  t.show('response', skillBody);
  t.check('bridge ran the skill', skillBody.ok === true);
  t.check('skill output came back through HTTP', skillBody.data?.normalized === 'bridge test');
});

// ── run ─────────────────────────────────────────────────────────────────

async function main() {
  const selected = ONLY ? registry.filter((s) => s.name.includes(ONLY) || s.title.toLowerCase().includes(ONLY)) : registry;

  console.log('');
  line(bold(magenta('OpenClaw foundation — observable test suite')));
  line(dim(`mode: offline mock catalog · scenarios: ${selected.length}${ONLY ? ` (filter "${ONLY}")` : ''}${QUIET ? ' · quiet' : ''}`));
  if (selected.length === 0) {
    line(red(`no scenario matched "${ONLY}"`));
    process.exit(1);
  }

  const records: ScenarioRecord[] = [];
  for (let i = 0; i < selected.length; i += 1) {
    records.push(await runScenario(i + 1, selected.length, selected[i]));
  }

  // ── summary ──
  const passed = records.filter((r) => r.status === 'pass').length;
  const failed = records.filter((r) => r.status === 'fail');
  const skipped = records.filter((r) => r.status === 'skip').length;
  const totalChecks = records.reduce((n, r) => n + r.checks, 0);
  const totalCost = allAudit.reduce((c, m) => c + m.costUsd, 0);
  const wall = ((performance.now() - START) / 1000).toFixed(2);

  console.log('');
  line(bold('── summary ──'));
  for (const r of records) {
    const glyph =
      r.status === 'pass' ? green('✓') : r.status === 'skip' ? yellow('⊘') : red('✗');
    const note = r.note ? dim(` — ${r.note}`) : '';
    line(`  ${glyph} ${r.title.padEnd(52)} ${dim(`${r.checks} chk · ${r.ms.toFixed(0)}ms`)}${note}`);
  }

  console.log('');
  line(
    `${bold('result:')} ${green(`${passed} passed`)}, `
      + `${failed.length ? red(`${failed.length} failed`) : `${failed.length} failed`}, `
      + `${yellow(`${skipped} skipped`)} ${dim(`· ${totalChecks} checks · ${allAudit.length} agent calls · $${totalCost.toFixed(3)} · ${wall}s wall`)}`,
  );

  if (failed.length > 0) {
    line(red(`failing: ${failed.map((r) => r.name).join(', ')}`));
    process.exit(1);
  }
  line(green('✅ all scenarios green'));
}

main().catch((err) => {
  console.error(`\n${red('❌ test suite crashed:')}`, err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
