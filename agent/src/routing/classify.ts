/**
 * classify — the structured intent contract + the ONE model-assisted classifier
 * behind `POST /api/classify` (§6, "the intent architecture").
 *
 * A chat turn takes exactly one of three paths — assistant / specialist /
 * gateway. That decision used to be scattered across regex/keyword matchers
 * that disagreed, so an unfamiliar phrasing silently fell through to the
 * gateway. This module collapses classification into a single service that:
 *
 *   1. Emits a VALIDATED, structured intent — `{ route, intent, tag?, personRef?,
 *      slots?, confidence }` — chosen from the CLOSED taxonomy in `intent-tags.ts`
 *      (routes + intent ids + intent→route/tag maps). The model may only pick an
 *      intent from that enum; `validateClassification` rejects anything else.
 *   2. Prefers a STRONG model for ambiguous phrasing (cost is unconstrained), but
 *      NEVER fails closed: a deterministic mirror (`deterministicClassify`, built
 *      on the same `turn-router` / `peer-coordination` detectors the offline stub
 *      uses) is the guaranteed floor. Obvious/safety-critical cases bypass the
 *      model entirely; everything else races the model against the instant
 *      deterministic mirror under a tight budget and falls back to it on
 *      invalid / low-confidence / error / timeout — never a silent gateway drop,
 *      never a fabricated route.
 *
 * Classification is intent EXTRACTION, not name/slot resolution: the model emits
 * the natural `personRef` ("bob", never a `pa_` handle) and raw `slots`; the
 * runtime still owns roster resolution and slot-filling.
 *
 * Layering note: this module has NO dependency on the gateway client — the live
 * `runSkill` is injected (`ClassifyRequestOptions.runSkillImpl`) so `dashboard.ts`
 * wires the real one while `openclaw-client.ts` can import `deterministicClassify`
 * for its offline stub without a cycle.
 */

import {
  createsImage,
  intentRoute,
  intentTag,
  isCapabilityTag,
  isIntentId,
  isRoute,
  understandsImage,
  type CapabilityTag,
  type Route,
} from './intent-tags.ts';
import { peerCoordinationPersonRef } from './peer-coordination.ts';
import { classifyTurn } from './turn-router.ts';

/* ── the structured contract ─────────────────────────────────────────────── */

/** Raw, UN-resolved parameters the model may extract. The runtime fills gaps
 *  (defaulting duration, choosing a working-hours window) — these are hints. */
export interface ClassifySlots {
  dateTime?: string;
  duration?: string;
  window?: string;
  subject?: string;
}

/** The validated structured intent every classification resolves to. */
export interface Classification {
  route: Route;
  /** Canonical intent id from the closed taxonomy (`intent-tags.ts`). */
  intent: string;
  /** Capability tag, present only when the intent carries one. */
  tag?: CapabilityTag;
  /** The NATURAL reference the owner used ("bob", "@kayley") — never a resolved
   *  `pa_` handle; the runtime resolves it against the roster. */
  personRef?: string;
  slots?: ClassifySlots;
  /** 0..1 — drives the fallback decision (low confidence → deterministic mirror). */
  confidence: number;
}

/** Lightweight session context the classifier may condition on. It must not
 *  carry owner data beyond what is already in scope for the turn. */
export interface ClassifyContext {
  hasAttachedImage?: boolean;
  hasAttachedAudio?: boolean;
  /** The owner manually picked a Blocks agent — an exact fact, not a guess. */
  selectedBlocksAgent?: string;
  /** Names/handles the owner can coordinate with (for personRef disambiguation). */
  rosterPeers?: string[];
  /** Short window for pronoun/anaphora ("book it with him"). */
  recentTurns?: string[];
}

export type ClassifySource = 'model' | 'deterministic' | 'shortcut';

/** A classification plus WHERE it came from and WHY (observability). */
export interface ClassifyResult extends Classification {
  source: ClassifySource;
  reason: string;
}

const SLOT_KEYS: readonly (keyof ClassifySlots)[] = ['dateTime', 'duration', 'window', 'subject'];

/* ── validation (rejects out-of-taxonomy, repairs where safe) ─────────────── */

export interface ValidatedClassification {
  value: Classification;
  /** True when the raw model output had to be corrected (wrong route/tag,
   *  leaked `pa_` handle, stray slot key, out-of-range confidence) — the caller
   *  can weigh this like `planNeededRepair` does for plans. */
  repaired: boolean;
}

/**
 * Validate a raw classifier output against the closed taxonomy. Returns the
 * normalized {@link Classification} plus whether repair was needed, or `null`
 * when the output is out-of-taxonomy in a way that cannot be safely repaired
 * (unknown intent id, unknown route string, or an unknown capability tag) — the
 * caller then falls back to the deterministic mirror.
 *
 * The intent id is the ANCHOR: route and tag are derived from it (the taxonomy
 * owns those maps), so a model that picks a valid intent but a mismatched
 * route/tag is repaired to the canonical values rather than trusted.
 */
export function validateClassification(raw: unknown): ValidatedClassification | null {
  if (!isRecord(raw)) return null;
  if (!isIntentId(raw.intent)) return null; // out-of-taxonomy intent → reject
  const intent = raw.intent;
  let repaired = false;

  // route — derived from intent. A present-but-wrong route is repaired to the
  // canonical one; an unknown route STRING is a taxonomy violation → reject.
  const canonicalRoute = intentRoute(intent) as Route;
  if (raw.route !== undefined && raw.route !== null) {
    if (!isRoute(raw.route)) return null;
    if (raw.route !== canonicalRoute) repaired = true;
  }

  // tag — derived from intent. Present-but-wrong tag repaired to canonical;
  // an unknown tag string is a taxonomy violation → reject.
  const canonicalTag = intentTag(intent);
  if (raw.tag !== undefined && raw.tag !== null) {
    if (!isCapabilityTag(raw.tag)) return null;
    if (raw.tag !== canonicalTag) repaired = true; // wrong tag, or intent has none
  }

  // personRef — the NATURAL name only. A resolved `pa_` handle must never leak
  // in from the model; drop it (the runtime resolves names, not the classifier).
  let personRef: string | undefined;
  if (typeof raw.personRef === 'string' && raw.personRef.trim()) {
    const ref = raw.personRef.trim();
    if (/^pa_/iu.test(ref)) repaired = true;
    else personRef = ref;
  } else if (raw.personRef !== undefined && raw.personRef !== null) {
    repaired = true;
  }

  // slots — keep only the known raw-slot keys, all optional non-empty strings.
  const slots = normalizeSlots(raw.slots);
  if (slots.dropped) repaired = true;

  // confidence — a number in [0,1]. Anything else clamps/defaults to 0, which
  // drives the safe deterministic fallback rather than being trusted.
  let confidence = 0;
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
    confidence = Math.min(1, Math.max(0, raw.confidence));
    if (confidence !== raw.confidence) repaired = true;
  } else {
    repaired = true;
  }

  const value: Classification = { route: canonicalRoute, intent, confidence };
  if (canonicalTag !== undefined) value.tag = canonicalTag;
  if (personRef !== undefined) value.personRef = personRef;
  if (slots.value) value.slots = slots.value;
  return { value, repaired };
}

function normalizeSlots(raw: unknown): { value?: ClassifySlots; dropped: boolean } {
  if (raw === undefined || raw === null) return { dropped: false };
  if (!isRecord(raw)) return { dropped: true };
  const out: ClassifySlots = {};
  let dropped = false;
  for (const [key, val] of Object.entries(raw)) {
    if ((SLOT_KEYS as readonly string[]).includes(key) && typeof val === 'string' && val.trim()) {
      out[key as keyof ClassifySlots] = val.trim();
    } else {
      dropped = true;
    }
  }
  return { value: Object.keys(out).length ? out : undefined, dropped };
}

/* ── the deterministic mirror (offline floor + client fallback parity) ─────── */

/**
 * Classify a turn WITHOUT a model, from the same detectors the offline stub and
 * the client fallback use. The ROUTE always equals `classifyTurn(text).route`
 * (so offline parity with the existing `check-turn-router` battery is exact);
 * the intent is the finest-grained canonical id those detectors can prove. This
 * is the offline `runSkill('intent_classify')` mirror AND the safe fallback the
 * live path degrades to.
 */
export function deterministicClassify(text: string, context: ClassifyContext = {}): Classification {
  const t = (text ?? '').toString();
  const route = classifyTurn(t).route;
  const intent = deterministicIntent(t, route, context);
  const classification: Classification = { route, intent, confidence: 1 };
  const tag = intentTag(intent);
  if (tag !== undefined) classification.tag = tag;
  if (route === 'assistant') {
    const personRef = peerCoordinationPersonRef(t);
    if (personRef) classification.personRef = personRef;
  }
  const slots = extractSlots(t);
  if (slots) classification.slots = slots;
  return classification;
}

const RANDOM_AGENT =
  /\b(random|cool|interesting)\b/u;
const BLOCKS_NOUN = /\b(blocks?|blocks\.ai|catalog)\b/u;
const USE_VERB = /\b(use|try|run|pick|choose|agents?)\b/u;

function isRandomSpecialist(t: string): boolean {
  return RANDOM_AGENT.test(t) && BLOCKS_NOUN.test(t) && USE_VERB.test(t);
}

function isIdentityQuestion(t: string): boolean {
  return (
    /\b(who|what)\s+are\s+you\b/u.test(t) ||
    /\bintroduce\s+yourself\b/u.test(t) ||
    /\bwhat(?:'s|’s| is|\s+are)\s+(?:my|your)\s+(?:name|e-?mail(?:\s+address)?|time\s?zone|working\s+hours)\b/u.test(t)
  );
}

function isBooking(t: string): boolean {
  return (
    (/\b(book|schedule|create|add)\b/u.test(t) &&
      /\b(meeting|event|calendar|appointment|call|review|sync)\b/u.test(t)) ||
    /\bschedule\b[\s\S]*\bwith\b/u.test(t)
  );
}

function isDraftEmail(t: string): boolean {
  return (
    /\bdraft an email\b/u.test(t) ||
    (/\b(draft|compose|write|reply|send)\b/u.test(t) && /\b(mail|email|message)\b/u.test(t))
  );
}

/** Pick the finest-grained canonical intent within the (already-decided) route.
 *  Order mirrors the offline stub's `routeSingleAction` so intent and plan agree. */
function deterministicIntent(rawText: string, route: Route, context: ClassifyContext): string {
  const t = rawText.toLowerCase();

  if (route === 'gateway') {
    return /\b(summarize|summary|summarise)\b/u.test(t) ? 'summarize' : 'chat';
  }

  if (route === 'specialist') {
    if (isRandomSpecialist(t)) return 'use-specialist';
    if (/linkedin\.com/u.test(t) || /\b(tone|voice|style)\b/u.test(t)) return 'tone-analysis';
    return 'catalog-discovery';
  }

  // assistant
  if (peerCoordinationPersonRef(rawText) !== null) return 'coordinate-meeting';
  if (createsImage(rawText)) return 'create-image';
  if (understandsImage(rawText) || context.hasAttachedImage === true) return 'describe-image';
  if (isIdentityQuestion(t)) return 'identity';
  if (/\b(transcribe|transcription|speech.?to.?text|stt)\b/u.test(t)) return 'transcribe-audio';
  if (/\b(narrate|voiceover|read aloud|text.?to.?speech|tts)\b/u.test(t)) return 'narrate-text';
  if (isDraftEmail(t)) return 'draft-email';
  if (/\b(mail|email|inbox|gmail)\b/u.test(t)) return 'read-email';
  if (isBooking(t)) return 'book-event';
  if (/\b(free|busy|available|availability|calendar|schedule|agenda|meeting)\b/u.test(t)) return 'check-availability';
  if (/\bask\b[\s\S]*\bassistant\b/u.test(t)) return 'coordinate-meeting';
  return 'check-availability';
}

/** Best-effort raw-slot extraction (all optional; the runtime slot-fills). */
function extractSlots(rawText: string): ClassifySlots | undefined {
  const t = rawText.toLowerCase();
  const slots: ClassifySlots = {};

  const duration =
    t.match(/\b\d+\s*(?:min(?:ute)?s?|hours?|hrs?)\b/u) ??
    t.match(/\b(?:an?\s+hour|half[-\s]?hour)\b/u);
  if (duration) slots.duration = duration[0].trim();

  const dateTime =
    t.match(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/u) ?? t.match(/\b\d{1,2}:\d{2}\b/u);
  if (dateTime) slots.dateTime = dateTime[0].replace(/^at\s+/u, '').trim();

  const window = t.match(
    /\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week|weekend)|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\s+(?:morning|afternoon|evening))?)\b/u,
  );
  if (window) slots.window = window[0].trim();

  return Object.keys(slots).length ? slots : undefined;
}

/* ── the orchestration: fast-path, model race, safe fallback ──────────────── */

/** Injected live-model runner (defaults resolved by the caller). Mirrors the
 *  `runSkill` signature so `dashboard.ts` passes the real gateway client. */
export type RunSkillLike = (
  skill: string,
  inputs: Record<string, unknown>,
  opts: { offline: boolean },
) => Promise<unknown>;

/** One routing decision, logged for observability (misroutes are debuggable). */
export interface ClassifyLogEntry {
  text: string;
  route: Route;
  intent: string;
  source: ClassifySource;
  confidence: number;
  detail?: string;
}

export interface ClassifyRequestOptions {
  /** Force offline (deterministic-only). Defaults to `FOUNDATION_OFFLINE !== '0'`. */
  offline?: boolean;
  /** Enable the live model. Defaults to `!offline`. */
  live?: boolean;
  /** The live model runner; without it the model path is skipped. */
  runSkillImpl?: RunSkillLike;
  /** Hard latency budget for the model call (ms). */
  budgetMs?: number;
  /** Minimum confidence to prefer the model over the deterministic mirror. */
  minConfidence?: number;
  /** Observability sink. Called exactly once per classification. */
  log?: (entry: ClassifyLogEntry) => void;
}

/** Tight default budget — classification sits in the hot path before any real
 *  work, so a slow model must never hang the turn. Cost is unconstrained, but
 *  latency is: past this budget the deterministic mirror wins. */
export const DEFAULT_CLASSIFY_BUDGET_MS = 2_500;
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Classify one turn into a validated structured intent. Deterministic shortcuts
 * bypass the model; otherwise the model races the instant deterministic mirror
 * under a budget and the mirror is the guaranteed safe floor.
 */
export async function classifyRequest(
  text: string,
  context: ClassifyContext = {},
  opts: ClassifyRequestOptions = {},
): Promise<ClassifyResult> {
  const log = opts.log;
  const t = (text ?? '').toString();

  // 1. Deterministic fast-path — exact facts, not intent guesses. Skip the model.
  const shortcut = shortcutClassification(t, context);
  if (shortcut) {
    return finalize(t, { ...shortcut.value, source: 'shortcut', reason: shortcut.reason }, log);
  }

  const deterministic = deterministicClassify(t, context);
  const offline = opts.offline ?? process.env.FOUNDATION_OFFLINE !== '0';
  const live = opts.live ?? !offline;

  // 2. Offline / model disabled → the deterministic mirror IS the answer
  //    (identical to today's behaviour; offline parity is sacred).
  if (offline || !live || !opts.runSkillImpl) {
    return finalize(t, { ...deterministic, source: 'deterministic', reason: 'deterministic mirror' }, log);
  }

  // 3. Online → ask the strong model, but never let it hang or misfire the turn:
  //    the instant deterministic mirror is the floor if the model is slow,
  //    invalid, or unsure.
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const model = await runModelClassification(t, context, opts);
  if (model && model.confidence >= minConfidence) {
    return finalize(t, { ...model, source: 'model', reason: 'model classifier' }, log);
  }

  const reason = model ? `model low-confidence (${model.confidence}) → deterministic` : 'model invalid/timeout → deterministic';
  return finalize(t, { ...deterministic, source: 'deterministic', reason }, log);
}

async function runModelClassification(
  text: string,
  context: ClassifyContext,
  opts: ClassifyRequestOptions,
): Promise<Classification | null> {
  const runSkillImpl = opts.runSkillImpl;
  if (!runSkillImpl) return null;
  const budgetMs = opts.budgetMs ?? DEFAULT_CLASSIFY_BUDGET_MS;
  try {
    const raw = await withTimeout(runSkillImpl('intent_classify', { text, context }, { offline: false }), budgetMs);
    const validated = validateClassification(raw);
    return validated ? validated.value : null;
  } catch {
    // Any error/timeout degrades to the deterministic mirror — never a fabricated
    // route and never a silent gateway drop.
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`classify budget ${ms}ms exceeded`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface Shortcut {
  value: Classification;
  reason: string;
}

/** Only the genuinely unambiguous, deterministic cases bypass the model — a
 *  confirm/resume token, an explicit user agent pick, a raw attached image/audio
 *  — because those are exact facts, not intent guesses. */
function shortcutClassification(text: string, context: ClassifyContext): Shortcut | null {
  if (/\bconfirm_[a-f0-9]{16}\b/iu.test(text)) {
    // A confirm/resume token from a chip is an owner action; reuse the
    // deterministic mapping for its intent, but skip the model.
    return { value: deterministicClassify(text, context), reason: 'confirm/resume token' };
  }
  if (typeof context.selectedBlocksAgent === 'string' && context.selectedBlocksAgent.trim()) {
    return {
      value: { route: 'specialist', intent: 'use-specialist', confidence: 1 },
      reason: 'owner selected a Blocks agent',
    };
  }
  if (context.hasAttachedImage === true) {
    const value: Classification = { route: 'assistant', intent: 'describe-image', confidence: 1 };
    const tag = intentTag('describe-image');
    if (tag) value.tag = tag;
    return { value, reason: 'attached image handled up-front' };
  }
  if (context.hasAttachedAudio === true) {
    const value: Classification = { route: 'assistant', intent: 'transcribe-audio', confidence: 1 };
    const tag = intentTag('transcribe-audio');
    if (tag) value.tag = tag;
    return { value, reason: 'attached audio handled up-front' };
  }
  return null;
}

function finalize(
  text: string,
  result: ClassifyResult,
  log: ((entry: ClassifyLogEntry) => void) | undefined,
): ClassifyResult {
  log?.({
    text: text.slice(0, 200),
    route: result.route,
    intent: result.intent,
    source: result.source,
    confidence: result.confidence,
    detail: result.reason,
  });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
