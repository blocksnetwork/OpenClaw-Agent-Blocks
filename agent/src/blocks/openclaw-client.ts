/**
 * OpenClaw gateway client — runs a local skill on the gateway.
 *
 * This is how the LOCAL half of the foundation works: the agent owns a
 * skill (under ../workspace/skills/<name>/SKILL.md), and asks the
 * gateway to run it. The gateway calls the configured LLM and returns
 * the skill's JSON output.
 *
 * In offline mode this falls back to a deterministic local stub so the
 * smoke test runs without a key.
 */

import { TAGS, tagForRequest, imageAlreadyRead } from '../routing/intent-tags.ts';

export interface RunSkillOptions {
  gatewayUrl?: string;
  token?: string;
  /** Force the offline stub regardless of env. */
  offline?: boolean;
}

/**
 * Run an OpenClaw skill by name and return its parsed JSON output.
 *
 * @param skill  skill name, matching workspace/skills/<skill>/SKILL.md
 * @param inputs JSON inputs for the skill
 */
export async function runSkill(
  skill: string,
  inputs: Record<string, unknown>,
  opts: RunSkillOptions = {},
): Promise<unknown> {
  const offline = opts.offline ?? process.env.FOUNDATION_OFFLINE !== '0';
  if (offline) {
    // Deterministic local stand-in so the foundation runs with no key.
    return localStub(skill, inputs);
  }

  const gatewayUrl = trimTrailingSlashes(
    opts.gatewayUrl ?? process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789',
  );
  const token = opts.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is required when FOUNDATION_OFFLINE=0');
  }

  const output = await callGatewaySkill(gatewayUrl, token, skill, inputs);
  return parseJsonOnlyOutput(output, skill);
}

async function callGatewaySkill(
  gatewayUrl: string,
  token: string,
  skill: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  const spec = await readLocalSkillSpec(skill);
  const command = [
    `/skill ${toOpenClawSkillName(skill)}`,
    JSON.stringify(inputs),
    'Return the skill output JSON object only.',
    'Use the exact property names required by the skill; do not rename, omit, or add fields.',
    ...(spec ? ['', 'Skill specification (authoritative — follow it exactly):', spec] : []),
  ].join('\n');
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-openclaw-session-key': `foundation-${skill}-${Date.now()}`,
    },
    body: JSON.stringify({
      model: 'openclaw/default',
      messages: [{ role: 'user', content: command }],
      // Pillar 4.7: an ordered multi-step `steps[]` envelope (with threading
      // and per-step ids) does NOT fit in the old 500-token cap — it would
      // truncate to invalid JSON and silently fall back to the offline stub.
      // Default raised to fit a ~5-step plan; override with PA_BRAIN_MAX_TOKENS.
      max_completion_tokens: brainMaxCompletionTokens(),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenClaw gateway returned HTTP ${response.status}: ${body}`);
  }

  const json = JSON.parse(body) as ChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(`OpenClaw gateway response did not include assistant content: ${body}`);
  }
  return content;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

function parseJsonOnlyOutput(output: string, skill: string): unknown {
  const jsonText = stripMarkdownFence(output.trim());
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenClaw skill "${skill}" did not return valid JSON: ${reason}; output=${output}`);
  }
}

function stripMarkdownFence(output: string): string {
  return output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/u, '');
}

/**
 * Read the local SKILL.md body (sans frontmatter) so the exact output
 * contract rides along with the command. The gateway indexes the same
 * file, but restating it in the task keeps weaker models from renaming
 * output properties.
 */
async function readLocalSkillSpec(skill: string): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const path = new URL(`../../../workspace/skills/${skill}/SKILL.md`, import.meta.url);
    const markdown = await readFile(path, 'utf8');
    const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/u, '').trim();
    if (!body) return undefined;
    // Pillar 4.7: bound what we restate so a bloated skill body can't crowd
    // the command (cost/context); the trim keeps the authoritative output
    // contract and only cuts at a section boundary.
    return trimSkillSpec(body);
  } catch {
    return undefined;
  }
}

/** Default cap on the brain's completion. The old 500 truncated a multi-step
 *  envelope; this fits a ~5-step plan. Override with PA_BRAIN_MAX_TOKENS. */
const DEFAULT_BRAIN_MAX_TOKENS = 1_500;

export function brainMaxCompletionTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.PA_BRAIN_MAX_TOKENS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BRAIN_MAX_TOKENS;
}

/** Upper bound on the restated SKILL.md body (chars). Generous enough that
 *  a normal skill ships whole (examples included); only pathological bloat
 *  is trimmed, at a section boundary, preserving the output contract. */
const DEFAULT_SPEC_BUDGET = 12_000;

export function trimSkillSpec(body: string, budget: number = DEFAULT_SPEC_BUDGET): string {
  const normalized = body.replace(/\n{3,}/gu, '\n\n').trim();
  if (normalized.length <= budget) return normalized;
  const slice = normalized.slice(0, budget);
  const boundary = Math.max(
    slice.lastIndexOf('\nExamples:'),
    slice.lastIndexOf('\n## '),
    slice.lastIndexOf('\n\n'),
  );
  const kept = (boundary > 0 ? slice.slice(0, boundary) : slice).trim();
  return `${kept}\n\n(Spec trimmed for length; follow the output contract above exactly.)`;
}

function toOpenClawSkillName(skill: string): string {
  return skill.replaceAll('_', '-');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

function localStub(skill: string, inputs: Record<string, unknown>): unknown {
  switch (skill) {
    case 'echo_check':
      return {
        skill,
        ok: true,
        normalized: String(inputs.text ?? '').trim().toLowerCase(),
      };
    case 'headline_writer': {
      const raw = String(inputs.text ?? '').trim();
      if (!raw) return { ok: true, headline: 'Untitled', wordCount: 1 };
      const firstSentence = (raw.split(/[.!?]\s+/u)[0] ?? raw).trim();
      const words = firstSentence
        .split(/\s+/u)
        .filter((w) => w.length > 0)
        .slice(0, 8)
        .map((w) => w.replace(/[.,;:!?"']+$/u, ''));
      const headline = words.join(' ') || 'Untitled';
      return { ok: true, headline, wordCount: words.length || 1 };
    }
    case 'personal_assistant': {
      // Deterministic brain stand-in. Mirrors routeIntent() in
      // agent/published/pa_test_private/handler.ts so offline planning
      // matches the live keyword router: image→text-to-image,
      // audio→text-to-speech, "ask <name>"→call-peer, Blocks catalog
      // questions→search-blocks-catalog, else answer-direct.
      // Shape matches the SKILL.md envelope: { ok, reply, steps }.
      //
      // Pillar 1.6: a COMPOUND request ("do X, then do Y") decomposes into an
      // ordered steps[] plan, threading the first result into the second.
      return planPersonalAssistant(inputs);
    }
    case 'pick_best': {
      // Deterministic judge stand-in: prefer the first candidate whose
      // output reads like a finished answer (a string `summary`), else
      // fall back to the first candidate. Mirrors the real skill's
      // schema exactly: { winner, reason }.
      const candidates = Array.isArray(inputs.candidates)
        ? (inputs.candidates as Array<{ id?: unknown; output?: unknown }>)
        : [];
      if (candidates.length === 0) {
        return { winner: '', reason: 'No candidates were supplied to judge.' };
      }
      const withSummary = candidates.find(
        (c) => typeof (c.output as { summary?: unknown } | null)?.summary === 'string',
      );
      const pick = withSummary ?? candidates[0];
      return {
        winner: String(pick.id ?? ''),
        reason: withSummary
          ? 'A complete sentence summary fulfils the task better than the alternatives.'
          : 'Candidates were equivalent, so the first one wins by tie-break.',
      };
    }
    default:
      return { skill, note: 'local stub — no gateway call made', inputs };
  }
}

function catalogCategoryForRequest(text: string): string {
  if (/\b(model|models|gemini|gpt|claude|llama|mistral)\b/u.test(text)) return 'model';
  if (/\b(tag|tags)\b/u.test(text)) return 'tag';
  if (/\b(tool|tools)\b/u.test(text)) return 'tool';
  if (/\b(can|capabilit|support|supports)\b/u.test(text)) return 'capability';
  return 'agent';
}

function catalogQueryForRequest(request: string): string {
  const cleaned = request
    .replace(/\b(on|in)\s+blocks(?:\.ai)?\b/giu, ' ')
    .replace(/\b(what|which|who|find|search|list|show|are|is|the|agents?|tools?|catalog|using|use|available)\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned || request.trim();
}

/* ---- Personal-assistant planner (single + compound) -------------------- */

interface StubAction {
  kind: string;
  [key: string]: unknown;
}

interface StubPlan {
  ok: true;
  reply: string;
  steps?: StubAction[];
  actions?: StubAction[];
}

/**
 * Plan an owner request. A single request keeps the original one-action
 * envelope; a COMPOUND request ("do X, then do Y") decomposes into an
 * ordered steps[] plan with the first result threaded into the next (1.6).
 */
function planPersonalAssistant(inputs: Record<string, unknown>): StubPlan {
  const request = String(inputs.request ?? '').trim();
  if (!request) {
    return {
      ok: true,
      reply: "I didn't catch a request — what would you like me to do?",
      actions: [{ kind: 'answer-direct' }],
    };
  }

  const segments = splitCompound(request);
  if (segments.length > 1) {
    const compound = planCompound(segments);
    if (compound) return compound;
  }

  const peerCoordination = planPeerCoordination(request);
  if (peerCoordination) return peerCoordination;

  const routed = routeSingleAction(request);
  return { ok: true, reply: routed.reply, actions: [routed.action] };
}

/** Split a compound request on natural sequencing connectors ("then", "and
 *  then", "after that"). Returns one segment when there's no connector. */
function splitCompound(request: string): string[] {
  const parts = request.split(/\s*[,;.]?\s*\b(?:and\s+then|then|after\s+that)\b[\s,:]*/iu);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function planCompound(segments: string[]): StubPlan | null {
  const steps: StubAction[] = [];
  segments.forEach((segment, index) => {
    // Prefer the intent router; only treat a segment as content-generation
    // when nothing else matched (so "draft an email … with the summary"
    // stays an email step, not a summarizer).
    const routed = routeSingleAction(segment).action;
    const action = routed.kind === 'answer-direct' ? (contentSpecialistFor(segment) ?? routed) : routed;
    steps.push({ ...action, id: `step${index + 1}` });
  });
  if (steps.length < 2) return null;

  threadSteps(steps);
  return {
    ok: true,
    reply: `On it — I'll handle that as ${steps.length} steps and use each result in the next.`,
    steps,
  };
}

/** A content-generation segment (brief / summary / headline / write-up)
 *  delegates to a specialist so its OUTPUT can be threaded downstream — the
 *  first half of the S1/S3/S10 "produce something, then act on it" pattern. */
function contentSpecialistFor(segment: string): StubAction | null {
  const t = segment.toLowerCase();
  if (/\b(headline|title)\b/u.test(t)) {
    return { kind: 'call-specialist', tag: TAGS.headline, prompt: segment };
  }
  if (/\b(brief|summary|summarize|summarise|one-?pager|one[- ]page|write-?up|outline)\b/u.test(t)) {
    return { kind: 'call-specialist', tag: TAGS.summarize, prompt: segment };
  }
  if (/\b(write|compose|draft|create)\b/u.test(t) && /\b(post|blog|copy|paragraph|note|brief|summary|one-?pager)\b/u.test(t)) {
    return { kind: 'call-specialist', tag: TAGS.summarize, prompt: segment };
  }
  return null;
}

/** Thread an earlier step's output into the next: a peer's intent, an email
 *  body, or a downstream specialist's prompt carries `{{stepN}}` which the
 *  runtime substitutes from the results ledger (1.2). */
function threadSteps(steps: StubAction[]): void {
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1];
    const cur = steps[i];
    const prevId = String(prev.id ?? `step${i}`);
    const prevTool = typeof prev.tool === 'string' ? prev.tool : '';
    const prevProducesContent = prev.kind === 'call-specialist'
      || (prev.kind === 'use-integration' && /(list|read|freeBusy)/u.test(prevTool));
    if (!prevProducesContent) continue;

    const token = `{{${prevId}}}`;
    if (cur.kind === 'call-peer') {
      cur.intent = `discuss the prepared brief: ${token}`;
    } else if (cur.kind === 'use-integration' && typeof cur.tool === 'string' && cur.tool.startsWith('email.')) {
      const args = (cur.args && typeof cur.args === 'object' ? cur.args : {}) as Record<string, unknown>;
      cur.args = { ...args, body: { from: prevId, field: 'reply' } };
    } else if (cur.kind === 'call-specialist') {
      cur.prompt = `${String(cur.prompt ?? '')}\n\nUse this as input:\n${token}`;
    }
  }
}

function planPeerCoordination(request: string): StubPlan | null {
  const personRef = peerCoordinationPersonRef(request);
  if (!personRef) return null;
  const steps: StubAction[] = [
    { id: 'step1', kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: request } },
    {
      id: 'step2',
      kind: 'call-peer',
      personRef,
      intent: `Find mutual availability for this request: ${stripTerminalPunctuation(request)}. My calendar result: {{step1}}`,
    },
  ];
  return {
    ok: true,
    reply: `I'll check your calendar and coordinate with ${personRef}'s assistant.`,
    steps,
  };
}

function peerCoordinationPersonRef(request: string): string | null {
  const lower = request.toLowerCase();
  const coordinates =
    /\b(coordinat\w*|compare|mutual|together)\b/u.test(lower) ||
    /\bworks?\s+for\s+both\b/u.test(lower) ||
    /\bboth\b.*\b(free|available|availability|busy)\b/u.test(lower) ||
    /\b(free|available|availability|busy)\b.*\bboth\b/u.test(lower);
  const asksAvailability =
    /\b(free|busy|available|availability|calendar|time|slot|meeting|schedule|morning|afternoon|evening)\b/u.test(lower);
  if (!coordinates || !asksAvailability) return null;

  const patterns = [
    /\bwith\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
    /\b(?:ask|coordinate|check|compare|sync)\s+(?:with\s+)?(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
    /\b(@?[a-z][a-z0-9_.@'’-]*)\s+and\s+(?:i|me)\b/iu,
    /\b(?:i|me)\s+and\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = request.match(pattern);
    const ref = normalizePeerReference(match?.[1]);
    if (ref) return ref;
  }
  return null;
}

function normalizePeerReference(value: string | undefined): string | null {
  const ref = (value ?? '')
    .replace(/['’]s$/u, '')
    .replace(/[^\p{L}\p{N}_@.'’-]+$/gu, '')
    .trim();
  if (!ref) return null;
  if (/^(me|my|mine|i|you|your|calendar|meeting|event|call|time|slot|the|a|an)$/iu.test(ref)) return null;
  return ref;
}

function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/u, '');
}

/** Route a single request to one action (the original keyword router). */
function routeSingleAction(request: string): { action: StubAction; reply: string } {
  const t = request.toLowerCase();

  const peer = t.match(/\bask\s+([a-z][a-z0-9'’-]*?)(?:'s|s')?\b/u);
  if (peer) {
    // The stub is a PURE function with NO roster access, so it CANNOT resolve
    // a name to a handle — inventing `pa_<name>` was the core Pillar 3 bug.
    // Emit the natural reference as `personRef`; the RUNTIME resolves it
    // against the roster post-plan (3.3/3.4), disambiguating or refusing
    // honestly. NEVER a fabricated handle here.
    const name = peer[1].replace(/['’]s$/u, '').trim();
    return {
      action: { kind: 'call-peer', personRef: name, intent: 'free-busy' },
      reply: `I'll check with ${peer[1]}'s assistant for you.`,
    };
  }

  // Identity questions ("who are you", "what's my email/name/timezone") are
  // answered from the owner PROFILE, not by listing the inbox. This must beat
  // the email/calendar intents below so "what's my email" doesn't route to
  // email.list (the word "email" alone is not an inbox request).
  const identityIntent =
    /\b(who|what)\s+are\s+you\b/u.test(t) ||
    /\bintroduce\s+yourself\b/u.test(t) ||
    /\bwhat(?:'s|’s| is|\s+are)\s+(?:my|your)\s+(?:name|e-?mail(?:\s+address)?|time\s?zone)\b/u.test(t);
  if (identityIntent) {
    return {
      action: { kind: 'answer-direct' },
      reply: "I'm your private assistant — here's what I have from your profile.",
    };
  }

  if (
    /\b(book|schedule|create|add)\b.*\b(meeting|event|calendar|appointment|call|review|sync)\b/u.test(t) ||
    /\bschedule\b.*\bwith\b/u.test(t)
  ) {
    return {
      action: { kind: 'use-integration', tool: 'calendar.createEvent', args: { query: request } },
      reply: "I'll prepare that calendar booking.",
    };
  }

  if (/\b(free|busy|available|availability|calendar|schedule|agenda)\b/u.test(t)) {
    return {
      action: { kind: 'use-integration', tool: 'calendar.freeBusy', args: { query: request } },
      reply: 'Let me check your calendar.',
    };
  }

  const emailIntent =
    /\b(mail|email|inbox)\b/u.test(t) ||
    /\b(draft|compose|write|reply)\b.*\b(mail|email|message)\b/u.test(t) ||
    /\b(read|open)\b.*\b(mail|email|message)\b/u.test(t);
  if (emailIntent) {
    const isDraft = /\b(draft|compose|write|reply)\b/u.test(t);
    const isSend = /\bsend\b.*\b(mail|email|message)\b/u.test(t) || /\b(mail|email|message)\b.*\bsend\b/u.test(t);
    return {
      action: {
        kind: 'use-integration',
        tool: isSend ? 'email.send' : isDraft ? 'email.draft' : 'email.list',
        args: { query: request },
      },
      reply: isSend ? "I'll prepare that email send." : isDraft ? "I'll draft that email for you." : "Let me check your email.",
    };
  }

  // Image routing is decided by the ONE canonical matcher (intent-tags), never
  // a local regex copy: it distinguishes CREATING a new image
  // (`text-to-image`) from UNDERSTANDING an existing one (`image-to-text`), so
  // the bare word "image" no longer triggers image generation.
  const imageTag = tagForRequest(t);
  if (imageTag === TAGS.imageToText) {
    // The chat surface reads an attached image up-front and folds the result
    // into the request as an "Image understanding from Blocks:" block. When
    // that's present the picture is already understood — answer from it;
    // otherwise delegate to a vision specialist to read it.
    return imageAlreadyRead(t)
      ? { action: { kind: 'answer-direct' }, reply: "Here's what I can tell from the image." }
      : {
          action: { kind: 'call-specialist', tag: TAGS.imageToText, prompt: request },
          reply: "I'll have a vision specialist read that image for you.",
        };
  }
  if (imageTag === TAGS.textToImage) {
    return {
      action: { kind: 'call-specialist', tag: TAGS.textToImage, prompt: request },
      reply: "On it — I'll have a specialist create that image for you.",
    };
  }

  if (/\b(say|speak|narrate|voice|voiceover|audio|read aloud|text.?to.?speech|tts)\b/u.test(t)) {
    return {
      action: { kind: 'call-specialist', tag: TAGS.textToSpeech, prompt: request },
      reply: "Sure — I'll have a specialist narrate that for you.",
    };
  }

  const catalogIntent =
    /\b(blocks?|blocks\.ai|catalog|agent|agents|tools?|capabilities|models?|tags?)\b/u.test(t) &&
    /\b(what|which|who|find|search|list|show|available|using|use|support|supports|can)\b/u.test(t);
  if (catalogIntent) {
    const tag = tagForRequest(t);
    const query = catalogQueryForRequest(request);
    return {
      action: {
        kind: 'search-blocks-catalog',
        query,
        ...(tag ? { tag } : {}),
        category: catalogCategoryForRequest(t),
      },
      reply: `I'll search the Blocks catalog for "${query}".`,
    };
  }

  return {
    action: { kind: 'answer-direct' },
    reply: `Here's what I can tell you: ${request}`,
  };
}
