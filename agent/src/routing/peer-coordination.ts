/**
 * peer-coordination — the ONE shared detector for "the owner wants to meet /
 * find time with a named peer" (mutual-availability coordination).
 *
 * This decision used to live as TWO verbatim copies that drifted
 * independently:
 *   1. `openclaw-client.ts` `planPeerCoordination()` (the offline stub planner).
 *   2. `assistant-runtime.ts` `repairPeerCoordinationPlan()` (the live-plan
 *      repair), with `normalizePeerReference` / `stripTerminalPunctuation`
 *      duplicated alongside it.
 * Both now import THIS module, and the turn classifier (`turn-router.ts`)
 * consumes `looksPeerCoordination` as its deterministic fast-path (mirrored
 * byte-for-byte in `web/chat/js/lib.jsx`, the offline/client parity contract).
 *
 * The detector is INTENT-SHAPED, not keyword-exact: a scheduling/availability
 * intent ("coordinate", "find a time", "when are we both free", "set up …",
 * "…to meet") combined with a coordination-shaped person reference ("with
 * Bob", "me and Bob", "Kayley and I") means coordination. So the terse "Find a
 * time for me and Bob to meet" is treated the same as the verbose "Coordinate
 * with Bob to find a time we are both free" — the difference is vocabulary,
 * not intent.
 *
 * It stays a CONSERVATIVE stopgap. An explicit direct booking the owner has
 * already timed ("book a meeting with Sam on Friday at 2pm") is NOT
 * coordination — it is a `calendar.createEvent`. Ordinary chat that merely
 * mentions time ("what time is it in Tokyo?") carries no coordination-shaped
 * person reference and is ignored.
 *
 * Pure + synchronous so it is offline-safe and unit-testable, and so §6's
 * model-assisted `/api/classify` intent service can import it as its
 * deterministic fast-path rather than growing a third keyword copy.
 */

/** A concrete clock time ("at 2pm", "at 3", "10am", "from 10am to 11am",
 *  "14:00") or an explicit create-imperative ("book"/"create"/"add") marks a
 *  DIRECT booking — the owner already knows WHEN — rather than a request to
 *  FIND a mutually-free time. Those must not be captured as coordination; they
 *  stay `calendar.createEvent`. A bare duration ("30 min") carries no am/pm or
 *  HH:MM anchor, so it correctly stays a search. */
function isExplicitBooking(lower: string): boolean {
  return (
    /\b(book|create|add)\b/u.test(lower) ||
    /\bat\s+\d/u.test(lower) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/u.test(lower) ||
    /\b\d{1,2}:\d{2}\b/u.test(lower)
  );
}

/** True when the request carries a mutual-availability / find-a-time intent.
 *  Intent-shaped: strong coordination cues, "find a time/slot", "when are we
 *  free", or a softer scheduling verb (meet / set up / schedule) that the
 *  owner has NOT already pinned to a concrete time. */
function coordinationIntent(lower: string): boolean {
  // Strong, unambiguous mutual-availability cues (the original gate).
  if (/\b(coordinat\w*|compare|mutual|together)\b/u.test(lower)) return true;
  if (/\bworks?\s+for\s+both\b/u.test(lower)) return true;
  if (/\bboth\b[\s\S]*\b(free|available|availability|busy)\b/u.test(lower)) return true;
  if (/\b(free|available|availability|busy)\b[\s\S]*\bboth\b/u.test(lower)) return true;
  // "find a time / slot", "when are we free", "…to meet / talk / sync".
  if (/\bfind\s+(?:me\s+|us\s+)?(?:a\s+|some\s+)?(?:time|slot)\b/u.test(lower)) return true;
  if (/\bwhen\s+(?:are|can|is)\b[\s\S]*\b(free|available)\b/u.test(lower)) return true;
  if (/\btime\s+to\s+(?:meet|talk|sync|chat|catch\s*up|connect)\b/u.test(lower)) return true;
  // Softer scheduling verbs — coordination only when the owner has NOT already
  // dictated a concrete time (that would be a direct booking, not a search).
  if (!isExplicitBooking(lower) && /\b(meet|set\s*up|schedule)\b/u.test(lower)) return true;
  return false;
}

/** Ordered person-reference shapes the owner uses to name the OTHER party in a
 *  coordination request. Evaluated in order; the first that resolves to a real
 *  reference wins. `@handle` and possessive forms are tolerated. */
const PERSON_REF_PATTERNS: readonly RegExp[] = [
  /\bwith\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
  /\b(?:ask|coordinate|check|compare|sync)\s+(?:with\s+)?(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
  /\b(@?[a-z][a-z0-9_.@'’-]*)\s+and\s+(?:i|me)\b/iu,
  /\b(?:i|me)\s+and\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
];

/**
 * The natural reference to the peer the owner wants to coordinate with, or
 * `null` when this is not a coordination request. Carries the NAME the owner
 * used verbatim — never a resolved `pa_<name>` handle; the runtime resolves it
 * against the owner's roster.
 */
export function peerCoordinationPersonRef(request: string): string | null {
  const lower = request.toLowerCase();
  if (!coordinationIntent(lower)) return null;

  for (const pattern of PERSON_REF_PATTERNS) {
    const match = request.match(pattern);
    const ref = normalizePeerReference(match?.[1]);
    if (ref) return ref;
  }
  return null;
}

/** The deterministic fast-path signal the turn classifier consumes: true when
 *  the turn is a peer-coordination request. Kept as a thin wrapper over
 *  `peerCoordinationPersonRef` so the classifier and the planners can never
 *  disagree about what "coordination" means. Mirrored byte-for-byte in
 *  `web/chat/js/lib.jsx`. */
export function looksPeerCoordination(text: string): boolean {
  return peerCoordinationPersonRef(text ?? '') !== null;
}

/** Trim a captured reference to a bare name: drop a possessive `'s`, strip
 *  trailing punctuation, and reject pronouns / calendar nouns that are never a
 *  peer ("me", "you", "calendar", "time"…). */
export function normalizePeerReference(value: string | undefined): string | null {
  const ref = (value ?? '')
    .replace(/['’]s$/u, '')
    .replace(/[^\p{L}\p{N}_@.'’-]+$/gu, '')
    .trim();
  if (!ref) return null;
  if (/^(me|my|mine|i|you|your|calendar|meeting|event|call|time|slot|the|a|an)$/iu.test(ref)) return null;
  return ref;
}

/** Drop trailing sentence punctuation so a request echoed into a peer intent
 *  reads cleanly ("…for a 30 minute meeting." → "…for a 30 minute meeting"). */
export function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/u, '');
}
