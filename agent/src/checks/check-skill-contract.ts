/**
 * Pillar 4.4/4.6 offline lint — the SKILL.md orchestration contract.
 *
 * Two ways the skills layer rots, both caught here with no key and no network:
 *
 *   1. INTENT→TAG DRIFT. The capability tag map lives canonically in
 *      `intent-tags.ts` (Pillar 4.4) and is RESTATED for humans in three docs
 *      (personal_assistant + blocks_network DELEGATE FIRST tables, AGENTS.md
 *      prose). This lint parses the doc tables' tag column and asserts the set
 *      equals `CAPABILITY_TAGS` — so a tag added/renamed in code without a doc
 *      edit (or vice-versa) fails CI. (The same spirit as Pillar 2's "one
 *      taxonomy, not a sixth tag table".)
 *
 *   2. STALE EXAMPLES. Every `Output:` example in a SKILL.md is extracted and
 *      validated against the runtime contract it claims to teach
 *      (`validatePlan` for the planner brain; the extractor shape for
 *      calendar_event_extract / recipient_extract). A doc example that no
 *      longer matches the schema the runtime enforces fails CI instead of
 *      silently teaching the live brain a shape the runtime will repair away.
 *
 *   npm run check:skill-contract
 */

import { readFile } from 'node:fs/promises';

import { loadRootEnv } from '../env.ts';
import { CAPABILITY_TAGS, GUIDANCE_INVARIANTS, type GuidanceDoc } from '../routing/intent-tags.ts';
import { validatePlan } from '../assistant/plan-schema.ts';

loadRootEnv();
process.env.FOUNDATION_OFFLINE = '1';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readSkill(rel: string): Promise<string> {
  return readFile(new URL(`../../../${rel}`, import.meta.url), 'utf8');
}

/* ── 1. intent→tag drift ─────────────────────────────────────────────────── */

/** Return the lines of the section beginning at the first heading line whose
 *  text contains `needle`, up to (but excluding) the next `## ` heading. */
function sectionLines(markdown: string, needle: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s/u.test(l) && l.toLowerCase().includes(needle.toLowerCase()));
  assert(start >= 0, `expected a heading containing "${needle}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/u.test(l));
  return end >= 0 ? rest.slice(0, end) : rest;
}

function tableCells(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1) // drop the empty edges around the leading/trailing pipes
    .map((c) => c.trim());
}

const SEPARATOR = /^[-:\s]+$/u;

/** Parse the tag column out of the first markdown table inside `section`. The
 *  tag column is located by the header cell that mentions "tag" (so it works
 *  for both the 2-column personal_assistant table and the 3-column
 *  blocks_network table where the tag is the MIDDLE column). */
function tagsFromTable(section: string[], label: string): string[] {
  const rows = section.filter((l) => l.trim().startsWith('|'));
  assert(rows.length >= 2, `expected a markdown table in ${label}`);
  const header = tableCells(rows[0]);
  const tagCol = header.findIndex((c) => /tag/iu.test(c));
  assert(tagCol >= 0, `expected a "tag" column header in ${label}, got ${JSON.stringify(header)}`);

  const tags: string[] = [];
  for (const row of rows.slice(1)) {
    const cells = tableCells(row);
    if (cells.length === 0 || cells.every((c) => SEPARATOR.test(c))) continue; // the |---| rule
    const raw = (cells[tagCol] ?? '').replace(/`/g, '').trim();
    if (raw) tags.push(raw);
  }
  return tags;
}

function assertSameSet(actual: string[], expected: readonly string[], label: string): void {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = [...e].filter((t) => !a.has(t));
  const extra = [...a].filter((t) => !e.has(t));
  assert(
    missing.length === 0 && extra.length === 0,
    `${label} tag set drifted from intent-tags.ts — missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`,
  );
}

/* ── 2. stale examples ───────────────────────────────────────────────────── */

interface Example {
  input: unknown;
  output: Record<string, unknown>;
  raw: string;
}

/** Extract every `Input:`/`Output:` example pair (the convention every
 *  SKILL.md uses). An `Output:` line must parse as a JSON object. */
function extractExamples(markdown: string): Example[] {
  const lines = markdown.split('\n');
  const examples: Example[] = [];
  let pendingInput: unknown;
  for (const line of lines) {
    const inMatch = line.match(/^Input:\s*(\{.*\})\s*$/u);
    if (inMatch) {
      pendingInput = safeParse(inMatch[1], 'Input');
      continue;
    }
    const outMatch = line.match(/^Output:\s*(\{.*\})\s*$/u);
    if (outMatch) {
      const output = safeParse(outMatch[1], 'Output');
      assert(isRecord(output), `Output example must be a JSON object, got ${outMatch[1]}`);
      examples.push({ input: pendingInput, output, raw: outMatch[1] });
      pendingInput = undefined;
    }
  }
  return examples;
}

function safeParse(json: string, label: string): unknown {
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`${label} example is not valid JSON: ${err instanceof Error ? err.message : String(err)} — ${json}`);
  }
}

/** Validate a planner `Output:` example against the runtime contract: it must
 *  already be schema-valid (validatePlan must NOT have to repair the kinds or
 *  drop steps), so a stale example fails instead of being silently degraded. */
function assertPlanExample(ex: Example): void {
  assert(ex.output.ok === true, `planner example must have ok:true, got ${ex.raw}`);
  assert(typeof ex.output.reply === 'string' && ex.output.reply.trim().length > 0, `planner example must carry a non-empty reply, got ${ex.raw}`);
  const declared = (Array.isArray(ex.output.steps) ? ex.output.steps : ex.output.actions) as Array<Record<string, unknown>> | undefined;
  assert(Array.isArray(declared) && declared.length > 0, `planner example must declare steps/actions, got ${ex.raw}`);

  const plan = validatePlan(ex.output);
  assert(
    plan.steps.length === declared.length,
    `planner example lost a step through validatePlan (stale example?) — declared ${declared.length}, validated ${plan.steps.length}: ${ex.raw}`,
  );
  declared.forEach((step, i) => {
    assert(
      plan.steps[i].kind === step.kind,
      `planner example step ${i + 1} kind "${String(step.kind)}" was repaired to "${plan.steps[i].kind}" (invalid/stale example): ${ex.raw}`,
    );
  });
  assert(plan.reply === ex.output.reply, `validatePlan changed the example reply: ${ex.raw}`);
}

/** Validate an extractor `Output:` example: either a complete result or an
 *  honest "missing" ask — never an unrecognized shape. */
function assertExtractorExample(ex: Example, fields: string[]): void {
  if (ex.output.ok === true) {
    for (const f of fields) {
      assert(typeof ex.output[f] === 'string' && (ex.output[f] as string).length > 0, `extractor success example missing "${f}": ${ex.raw}`);
    }
    return;
  }
  assert(ex.output.ok === false, `extractor example ok must be a boolean: ${ex.raw}`);
  assert(Array.isArray(ex.output.missing) && ex.output.missing.length > 0, `extractor miss example must list missing fields: ${ex.raw}`);
  assert(typeof ex.output.reply === 'string' && ex.output.reply.trim().length > 0, `extractor miss example must ask a question: ${ex.raw}`);
}

/** recipient_extract (4.8): a success names exactly one recipient (a name or
 *  address — never resolved here); a miss asks who, with no invented name. */
function assertRecipientExample(ex: Example): void {
  if (ex.output.ok === true) {
    assert(typeof ex.output.recipient === 'string' && (ex.output.recipient as string).trim().length > 0, `recipient_extract success example must carry a recipient: ${ex.raw}`);
    return;
  }
  assert(ex.output.ok === false, `recipient_extract example ok must be a boolean: ${ex.raw}`);
  assert(typeof ex.output.reply === 'string' && ex.output.reply.trim().length > 0, `recipient_extract miss example must ask who: ${ex.raw}`);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

try {
  const paSkill = await readSkill('workspace/skills/personal_assistant/SKILL.md');
  const bnSkill = await readSkill('workspace/skills/blocks_network/SKILL.md');
  const agents = await readSkill('workspace/AGENTS.md');

  // 1. intent→tag drift — both DELEGATE FIRST tables must match the module.
  assertSameSet(tagsFromTable(sectionLines(paSkill, 'DELEGATE FIRST'), 'personal_assistant'), CAPABILITY_TAGS, 'personal_assistant DELEGATE FIRST');
  assertSameSet(tagsFromTable(sectionLines(bnSkill, 'DELEGATE FIRST'), 'blocks_network'), CAPABILITY_TAGS, 'blocks_network DELEGATE FIRST');
  // AGENTS.md is prose (no table), so forward-check every canonical tag is named.
  for (const tag of CAPABILITY_TAGS) {
    assert(agents.includes(`\`${tag}\``), `workspace/AGENTS.md must name the capability tag \`${tag}\` (drifted from intent-tags.ts)`);
  }
  console.log(`▸ intent→tag: both SKILL.md tables + AGENTS.md match intent-tags.ts (${CAPABILITY_TAGS.length} tags) ✓`);

  // 1b. Guidance invariants — routing RULES the tag-set diff can't see. Each
  // brain's prompt is its own LLM context (prose can't be imported), so a rule
  // added to one brain must be mirrored into the others or this fails.
  const guidanceDoc: Record<GuidanceDoc, string> = { personal_assistant: paSkill, blocks_network: bnSkill };
  for (const inv of GUIDANCE_INVARIANTS) {
    for (const doc of inv.docs) {
      assert(
        guidanceDoc[doc].includes(inv.phrase),
        `${doc} SKILL.md must restate the routing rule "${inv.phrase}" (guidance invariant "${inv.id}") — it drifted between brains`,
      );
    }
  }
  console.log(`▸ guidance: ${GUIDANCE_INVARIANTS.length} cross-brain routing rule(s) present in every delegation skill ✓`);

  // 2. stale examples — planner plans validate; extractor shapes hold.
  const planExamples = extractExamples(paSkill);
  assert(planExamples.length >= 8, `expected the planner SKILL.md to carry worked examples, got ${planExamples.length}`);
  for (const ex of planExamples) assertPlanExample(ex);
  console.log(`▸ examples: ${planExamples.length} personal_assistant Output examples validate against the runtime schema ✓`);

  const calExtract = await readSkill('workspace/skills/calendar_event_extract/SKILL.md');
  const calExamples = extractExamples(calExtract);
  assert(calExamples.length >= 3, `expected calendar_event_extract examples, got ${calExamples.length}`);
  for (const ex of calExamples) assertExtractorExample(ex, ['summary', 'start', 'end']);
  console.log(`▸ examples: ${calExamples.length} calendar_event_extract Output examples hold their shape ✓`);

  const recipientExtract = await readSkill('workspace/skills/recipient_extract/SKILL.md');
  const recipientExamples = extractExamples(recipientExtract);
  assert(recipientExamples.length >= 3, `expected recipient_extract examples, got ${recipientExamples.length}`);
  for (const ex of recipientExamples) assertRecipientExample(ex);
  console.log(`▸ examples: ${recipientExamples.length} recipient_extract Output examples hold their shape ✓`);

  console.log('\naudit: one canonical intent→tag map, docs diffed against code, and every SKILL.md example validated against the runtime contract');
  console.log('✅ skill-contract check passed');
} catch (err) {
  console.error(`❌ skill-contract check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
