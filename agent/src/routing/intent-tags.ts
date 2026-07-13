/**
 * intent-tags — the ONE canonical owner-intent → capability-tag map (Pillar 4.4).
 *
 * The intent→tag mapping used to live in FIVE places that drifted
 * independently:
 *   1. `workspace/skills/personal_assistant/SKILL.md` (DELEGATE FIRST table)
 *   2. `workspace/skills/blocks_network/SKILL.md`     (DELEGATE FIRST table)
 *   3. `workspace/AGENTS.md`                          (prose list)
 *   4. `openclaw-client.ts` `catalogTagForRequest()`  (regex copy)
 *   5. `check-assistant-skill.ts`                     (the tag assertions)
 *
 * This module is the single source of truth that the CODE (#4, #5) imports
 * directly, and that the doc-drift lint (`check:skill-contract`) diffs the doc
 * tables (#1–#3) against. Add or rename a capability tag HERE and the lint
 * fails until the docs match — docs and code can't silently drift (the same
 * spirit as Pillar 2's "one categorization taxonomy, not a sixth tag table").
 *
 * Decision for Pillar 4.3: the offline stub does NOT keep a parallel regex
 * brain. `tagForRequest()` below is the ONE matcher, imported by the stub
 * (`openclaw-client.ts`) and by the checks, so the stub and the assertions
 * exercise the SAME table. When the stub grows, it grows this table, not a
 * second copy.
 */

/** The canonical capability tag identifiers, referenced by name so the stub
 *  never hardcodes a tag string literal. */
export const TAGS = {
  speechToText: 'speech-to-text',
  textToSpeech: 'text-to-speech',
  imageToText: 'image-to-text',
  textToImage: 'text-to-image',
  summarize: 'summarize',
  headline: 'openclaw-headline-write',
  toneGuide: 'tone-guide',
} as const;

export type CapabilityTag = (typeof TAGS)[keyof typeof TAGS];

export interface IntentTag {
  /** The capability skill tag emitted in a `call-specialist` /
   *  `search-blocks-catalog` action. */
  tag: CapabilityTag;
  /** The owner-intent phrase — the human LEFT column of the SKILL.md /
   *  AGENTS.md tables. Kept here only as documentation of intent; the drift
   *  lint matches on the `tag` column, not this prose. */
  intent: string;
  /** Matcher over the LOWER-CASED request text. Evaluated in array order so a
   *  more specific tag wins where ranges overlap (this is the EXACT order and
   *  set of regexes the legacy `catalogTagForRequest` used, so routing stays
   *  byte-identical — do not reorder without updating the checks). */
  match: (text: string) => boolean;
}

// The word "image" is ambiguous between CREATING a new picture
// (`text-to-image`) and UNDERSTANDING an existing one (`image-to-text`), so
// each image intent is gated on the VERB/cue, never the bare noun — otherwise
// "what is this image" (understand) and "make an image" (create) collide.
// These predicates assume LOWER-CASED input (the INTENT_TAGS matchers receive
// already-lcased text); the exported wrappers below lower-case for callers.
const CREATE_IMAGE_VERB = /\b(make|create|generate|draw|design|render|produce|paint|sketch|illustrate)\b/u;
const IMAGE_SUBJECT = /\b(images?|pictures?|photos?|posters?|logos?|art|illustrations?|drawings?|portraits?|icons?|graphics?|wallpapers?)\b/u;
const UNDERSTAND_IMAGE_CUE = /\b(caption|describe|identify|recogni[sz]e|read|extract|ocr|analy[sz]e|what(?:'s|’s| is| are)?)\b/u;
const EXISTING_IMAGE = /\b(images?|pictures?|photos?|screenshots?|pics?)\b/u;
// The chat surface reads an attached image up-front and folds the result into
// the request as this block; its presence means the picture is ALREADY
// understood, so the planner should answer from it rather than re-delegating.
const IMAGE_ALREADY_READ = /image understanding from blocks/u;

function createsImageLc(t: string): boolean {
  return CREATE_IMAGE_VERB.test(t) && IMAGE_SUBJECT.test(t);
}

function understandsImageLc(t: string): boolean {
  return (
    IMAGE_ALREADY_READ.test(t) ||
    (!CREATE_IMAGE_VERB.test(t) && UNDERSTAND_IMAGE_CUE.test(t) && EXISTING_IMAGE.test(t))
  );
}

export const INTENT_TAGS: IntentTag[] = [
  {
    tag: TAGS.speechToText,
    intent: 'transcribe a voice clip / audio → text',
    match: (t) => /\b(transcribe|transcription|speech.?to.?text|stt)\b/u.test(t),
  },
  {
    tag: TAGS.textToSpeech,
    intent: 'narrate / read aloud / voiceover / say / audio',
    match: (t) => /\b(text.?to.?speech|tts|narrate|voiceover|read aloud)\b/u.test(t),
  },
  {
    // Understanding an EXISTING image (caption / "what is this" / read it).
    // Ordered before `text-to-image` and matched on the understand cue (not
    // the bare noun) so creation requests fall through to the next entry.
    tag: TAGS.imageToText,
    intent: 'describe / read / understand an image',
    match: understandsImageLc,
  },
  {
    // Creating a NEW image (make / draw / generate a poster, logo, art).
    tag: TAGS.textToImage,
    intent: 'generate / make / draw an image, poster, logo, art',
    match: createsImageLc,
  },
  {
    tag: TAGS.summarize,
    intent: 'summarize text',
    match: (t) => /\b(summarize|summary)\b/u.test(t),
  },
  {
    tag: TAGS.headline,
    intent: 'write a headline for some text',
    match: (t) => /\b(headline|title)\b/u.test(t),
  },
  {
    tag: TAGS.toneGuide,
    intent: "analyze a LinkedIn profile's tone / voice / style",
    match: (t) => /\b(linkedin|tone|voice|style)\b/u.test(t),
  },
];

/** The closed capability-tag set, in canonical (table) order. The drift lint
 *  asserts each doc table's tag column equals this set. */
export const CAPABILITY_TAGS: readonly CapabilityTag[] = INTENT_TAGS.map((e) => e.tag);

const CAPABILITY_TAG_SET = new Set<string>(CAPABILITY_TAGS);

/** True when `tag` is one of the canonical capability tags. */
export function isCapabilityTag(tag: unknown): tag is CapabilityTag {
  return typeof tag === 'string' && CAPABILITY_TAG_SET.has(tag);
}

/* ── the closed routing taxonomy (§6) ─────────────────────────────────────
 *
 * The turn classifier (`turn-router.ts` deterministically, `/api/classify`
 * model-assisted) sends every chat turn down exactly one of three PATHS and
 * labels it with exactly one canonical INTENT id. Both the routes and the
 * intent ids are a CLOSED set defined here — the single source of truth the
 * classifier, the offline mirror, and the checks all import. The model may
 * ONLY choose an intent from `INTENTS`; it never invents a route, an intent, or
 * a tag. `check:skill-contract` diffs the `intent_classify` SKILL.md taxonomy
 * table against this list, so the live prompt can never drift from the code.
 */

/** The three paths a chat turn can take. */
export const ROUTES = ['assistant', 'specialist', 'gateway'] as const;
export type Route = (typeof ROUTES)[number];

const ROUTE_SET = new Set<string>(ROUTES);

/** True when `value` is one of the canonical routes. */
export function isRoute(value: unknown): value is Route {
  return typeof value === 'string' && ROUTE_SET.has(value);
}

/** One canonical intent in the closed taxonomy. */
export interface IntentDef {
  /** Canonical intent id — the ONLY value the classifier may emit for `intent`. */
  id: string;
  /** The single path this intent takes. Route is DERIVED from intent, so the
   *  taxonomy stays the one source of truth: the classifier never chooses a
   *  route independently of the intent it picked. */
  route: Route;
  /** The capability skill tag this intent implies when it delegates to a Blocks
   *  specialist (create-image → text-to-image, tone-analysis → tone-guide, …).
   *  Omitted for intents the runtime or gateway handle without a tagged
   *  specialist (plain chat, calendar/mail actions, catalog discovery). */
  tag?: CapabilityTag;
  /** One-line description — the human column that seeds the classifier system
   *  prompt. Kept here so the prompt is generated FROM the taxonomy and the
   *  SKILL.md is diffed against it (`check:skill-contract`); it can never drift. */
  description: string;
}

export const INTENTS: readonly IntentDef[] = [
  // ── assistant: the owner acting on their OWN world ──
  { id: 'coordinate-meeting', route: 'assistant', description: 'Find a mutually-free time / coordinate a meeting with a named peer.' },
  { id: 'check-availability', route: 'assistant', description: "Answer from the owner's OWN calendar (am I free, what is my availability)." },
  { id: 'book-event', route: 'assistant', description: 'Create a calendar event the owner has already timed.' },
  { id: 'draft-email', route: 'assistant', description: "Draft, reply to, or send an email on the owner's behalf." },
  { id: 'read-email', route: 'assistant', description: "Read or check the owner's inbox." },
  { id: 'create-image', route: 'assistant', tag: TAGS.textToImage, description: 'Create / generate / draw a NEW image, poster, logo, or art.' },
  { id: 'describe-image', route: 'assistant', tag: TAGS.imageToText, description: 'Describe / read / caption an EXISTING or attached image.' },
  { id: 'narrate-text', route: 'assistant', tag: TAGS.textToSpeech, description: 'Narrate / read text aloud / voiceover.' },
  { id: 'transcribe-audio', route: 'assistant', tag: TAGS.speechToText, description: 'Transcribe a voice clip / audio to text.' },
  { id: 'identity', route: 'assistant', description: "Answer who-are-you, or the owner's own name, email, or timezone from the profile." },
  // ── specialist: a deterministic Blocks specialist / catalog lookup ──
  { id: 'tone-analysis', route: 'specialist', tag: TAGS.toneGuide, description: "Analyze a LinkedIn profile's tone / voice / style." },
  { id: 'catalog-discovery', route: 'specialist', description: 'Discover WHICH Blocks agents / tools / models can do something.' },
  { id: 'use-specialist', route: 'specialist', description: 'Use a specific or random Blocks agent the owner picked.' },
  // ── gateway: ordinary chat OpenClaw answers itself ──
  { id: 'summarize', route: 'gateway', description: 'Summarize arbitrary text with no Blocks or owner context.' },
  { id: 'chat', route: 'gateway', description: 'Ordinary conversation, general knowledge, explanations, jokes.' },
];

const INTENT_BY_ID = new Map<string, IntentDef>(INTENTS.map((i) => [i.id, i]));

/** The closed intent-id set, in canonical (table) order. */
export const INTENT_IDS: readonly string[] = INTENTS.map((i) => i.id);

/** True when `value` is a canonical intent id. */
export function isIntentId(value: unknown): value is string {
  return typeof value === 'string' && INTENT_BY_ID.has(value);
}

/** The full definition for an intent id, or `undefined`. */
export function intentDef(id: string): IntentDef | undefined {
  return INTENT_BY_ID.get(id);
}

/** The canonical route an intent takes (the taxonomy owns the intent→route map). */
export function intentRoute(id: string): Route | undefined {
  return INTENT_BY_ID.get(id)?.route;
}

/** The canonical capability tag an intent implies, or `undefined`. */
export function intentTag(id: string): CapabilityTag | undefined {
  return INTENT_BY_ID.get(id)?.tag;
}

/**
 * The first capability tag whose matcher fires, or `undefined` when nothing
 * matches. This is the single matcher the offline stub and the checks share
 * (replacing the old per-file regex copies). Input is lower-cased here so
 * callers can pass raw request text.
 */
export function tagForRequest(text: string): CapabilityTag | undefined {
  const t = text.toLowerCase();
  for (const entry of INTENT_TAGS) {
    if (entry.match(t)) return entry.tag;
  }
  return undefined;
}

/** True when the owner wants a NEW image *created* (text-to-image). */
export function createsImage(text: string): boolean {
  return createsImageLc(text.toLowerCase());
}

/** True when the owner is asking about an EXISTING/attached image
 *  (image-to-text) — "what is this", "caption it", or a request that already
 *  carries the chat surface's folded-in image description. */
export function understandsImage(text: string): boolean {
  return understandsImageLc(text.toLowerCase());
}

/** True when the request already carries an image description the chat surface
 *  folded in (an attached image was read up-front), so the picture is already
 *  understood and the planner should answer from it rather than re-delegating. */
export function imageAlreadyRead(text: string): boolean {
  return IMAGE_ALREADY_READ.test(text.toLowerCase());
}

/** A delegation brain whose prompt the gateway feeds an LLM. */
export type GuidanceDoc = 'personal_assistant' | 'blocks_network' | 'intent_classify';

/**
 * Routing-GUIDANCE invariants — the decision RULES that the tag-set diff
 * (`CAPABILITY_TAGS`) can't see. The capability VOCABULARY is single-sourced
 * here, but the routing RULES (e.g. "text-to-image creates, image-to-text
 * reads") live as prose inside each brain's own prompt and therefore CANNOT be
 * imported — every brain only ever sees its own context. So a rule can sit in
 * one brain and be missing from another with the tag-set lint still green
 * (exactly how the create-vs-understand image rule drifted).
 *
 * `check:skill-contract` asserts each listed brain's SKILL.md still restates
 * `phrase`, so a rule added to one brain must be mirrored into the others or CI
 * fails. Add an invariant HERE whenever a routing rule must hold across brains.
 */
export const GUIDANCE_INVARIANTS: ReadonlyArray<{
  id: string;
  phrase: string;
  docs: readonly GuidanceDoc[];
}> = [
  {
    id: 'image-create-vs-understand',
    phrase: 'Create vs. understand an image',
    docs: ['personal_assistant', 'blocks_network', 'intent_classify'],
  },
];
