/**
 * turn-router — the ONE authoritative "which path does this turn take?" gate
 * (routing Phase 3).
 *
 * A chat turn goes down exactly one of three paths:
 *   - `assistant`  → the owner-scoped private assistant runtime (calendar,
 *                    mail, peers, posters, identity, confirm/resume tokens).
 *   - `specialist` → a deterministic Blocks specialist / catalog lookup
 *                    (LinkedIn tone guide, "what agents can X" discovery).
 *   - `gateway`    → the generic OpenClaw gateway (ordinary chat).
 *
 * This decision used to live as TWO regex gates in the browser
 * (`looksPersonalAssistant` / `looksRoutable` in `web/chat/js/lib.jsx`), so the
 * client owned classification. It now lives HERE and is exposed over
 * `POST /api/classify`; the client asks the bridge and only falls back to a
 * thin local copy when the endpoint is unreachable. Precedence is preserved
 * exactly: assistant first, then specialist, else gateway.
 */

export type TurnRoute = 'assistant' | 'specialist' | 'gateway';

export interface TurnClassification {
  route: TurnRoute;
  reason: string;
}

/** Private-assistant turn: an owner action on their own world (calendar, mail,
 *  peers, media) or a confirm/resume token from a chip. Mirrors the legacy
 *  client `looksPersonalAssistant` regex byte-for-byte. */
function looksAssistant(t: string): boolean {
  return (
    /\bconfirm_[a-f0-9]{16}\b/iu.test(t) ||
    /\b(availability|available|free|busy|calendar|schedule|meeting|book|draft an email|email|gmail|poster|image|ask .+ assistant)\b/iu.test(t)
  );
}

/** Specialist/catalog turn: a LinkedIn URL to analyze, or a "what/which agents
 *  on Blocks…" discovery question. Mirrors the legacy client `looksRoutable`. */
function looksSpecialist(t: string): boolean {
  return (
    /linkedin\.com/iu.test(t) ||
    (/\b(random|cool|interesting)\b/iu.test(t) &&
      /\b(blocks?|blocks\.ai|catalog)\b/iu.test(t) &&
      /\b(use|try|run|pick|choose|agents?)\b/iu.test(t)) ||
    (/\b(blocks?|blocks\.ai|catalog)\b/iu.test(t) &&
      /\b(what|which|who|find|search|list|show|available|using|use|uses|support|supports|can|agents?|tools?|models?|tags?)\b/iu.test(t))
  );
}

/**
 * Classify a turn into its single path. Pure + synchronous so the offline
 * checks and the `/api/classify` handler share one implementation.
 */
export function classifyTurn(text: string): TurnClassification {
  const t = text ?? '';
  if (looksAssistant(t)) return { route: 'assistant', reason: 'owner action / assistant intent' };
  if (looksSpecialist(t)) return { route: 'specialist', reason: 'Blocks specialist / catalog lookup' };
  return { route: 'gateway', reason: 'ordinary chat → gateway' };
}
