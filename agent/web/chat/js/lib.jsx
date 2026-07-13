/* ===========================================================================
   lib.jsx — utilities, storage, image handling, API streaming, mock engine,
   and media synthesis (WAV + abstract poster). Exposed on window.
   =========================================================================== */

/* ----------------------------- basics ---------------------------------- */
const uid = (p = "id") => p + "-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) { return ""; }
}
function fmtDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

/* ----------------------------- storage --------------------------------- */
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota */ }
  },
};

const SETTINGS_KEY = "openclaw:settings";
const CONVOS_KEY = "openclaw:conversations";
const CURRENT_KEY = "openclaw:currentId";

// Connected to the foundation by default: an empty baseUrl posts to the
// same origin (/v1/chat/completions), which the dashboard proxies to the
// OpenClaw gateway with the operator token injected server-side. Demo mode
// is off so the UI talks to the real gateway out of the box; flip it on in
// Settings to explore the interface without a running gateway.
// baseUrl defaults to same-origin (""), but a deployment can point the UI at
// a remote bridge by setting window.OPENCLAW_CONFIG.baseUrl in /config.js
// (used when the front-end is hosted separately, e.g. on Netlify).
const DEFAULT_SETTINGS = {
  baseUrl: (typeof window !== "undefined" && window.OPENCLAW_CONFIG && window.OPENCLAW_CONFIG.baseUrl) || "",
  ownerId: (typeof window !== "undefined" && window.OPENCLAW_CONFIG && window.OPENCLAW_CONFIG.ownerId) || "",
  token: "",
  theme: "light",
  // When more than one Blocks text-to-image agent can do the job:
  //   single  → hire the single best-ranked agent (default: cheapest/fastest)
  //   race    → hire all, first image to land wins
  //   compare → hire all, show every image side by side
  //   best    → hire all, a local judge picks the winner
  imageStrategy: "single",
};

function loadSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, LS.get(SETTINGS_KEY, {}));
}
function saveSettings(s) { LS.set(SETTINGS_KEY, s); }

function loadConversations() {
  const raw = LS.get(CONVOS_KEY, {});
  const normalized = normalizeStoredConversations(raw);
  try {
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) LS.set(CONVOS_KEY, normalized);
  } catch (e) {
    // If storage contains unusual values, still return the safe normalized view.
  }
  return normalized;
}
function saveConversations(c) { LS.set(CONVOS_KEY, c); }

function clearLocalSession() {
  try { localStorage.removeItem(CONVOS_KEY); } catch (e) {}
  try { localStorage.removeItem(CURRENT_KEY); } catch (e) {}
}

function normalizeStoredConversations(conversations) {
  if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) return {};
  const next = {};
  for (const [id, convo] of Object.entries(conversations)) {
    if (!convo || typeof convo !== "object") continue;
    next[id] = {
      ...convo,
      messages: Array.isArray(convo.messages) ? convo.messages.map(normalizeStoredMessage) : [],
    };
  }
  return next;
}

function normalizeStoredMessage(message) {
  if (!message || typeof message !== "object") return message;
  const next = { ...message };
  if (Array.isArray(next.toolEvents)) {
    next.toolEvents = next.toolEvents.map((e) => e && e.status === "running" ? { ...e, status: "done" } : e);
  }
  if (next.thinking && typeof next.thinking === "object") {
    next.thinking = {
      ...next.thinking,
      status: next.thinking.status === "running" ? "done" : next.thinking.status,
      steps: Array.isArray(next.thinking.steps)
        ? next.thinking.steps.map((s) => s && s.status === "running" ? { ...s, status: "done" } : s)
        : [],
    };
  }
  return next;
}

/* ----------------------- image attachment handling --------------------- */
const ACCEPTED_IMAGE = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const ACCEPTED_AUDIO = ["audio/webm", "audio/wav", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/flac"];
const MAX_EDGE = 1568;

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// Downscale to MAX_EDGE long edge, re-encode. GIFs left untouched (animation).
async function processImageFile(file) {
  const original = await readFileAsDataURL(file);
  if (file.type === "image/gif") {
    return { id: uid("att"), kind: "image", name: file.name, url: original, mime: file.type };
  }
  const img = await loadImage(original);
  let { width: w, height: h } = img;
  const longEdge = Math.max(w, h);
  let outUrl = original;
  if (longEdge > MAX_EDGE) {
    const scale = MAX_EDGE / longEdge;
    w = Math.round(w * scale); h = Math.round(h * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    const outMime = file.type === "image/png" ? "image/png" : "image/jpeg";
    outUrl = canvas.toDataURL(outMime, 0.9);
  }
  return { id: uid("att"), kind: "image", name: file.name || "image", url: outUrl, mime: file.type, w, h };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* --------------------- convert to OpenAI message format ---------------- */
// internal message: { role, text, attachments:[{kind,url,mime,name}] }
function toApiMessages(messages) {
  return messages.map((m) => {
    const atts = m.attachments || [];
    if (m.role === "assistant") {
      return { role: "assistant", content: m.text || "" };
    }
    // user: build multimodal content array if image attachments present.
    // Audio attachments are NOT sent to the gateway — they're transcribed
    // to text via Blocks (see transcribeAudio) before the turn is sent, so
    // the gateway only ever sees text + images.
    const images = atts.filter((a) => a.kind === "image");
    if (!images.length) return { role: "user", content: m.text || "" };
    const content = [];
    if (m.text) content.push({ type: "text", text: m.text });
    for (const a of images) {
      content.push({ type: "image_url", image_url: { url: a.url } });
    }
    return { role: "user", content };
  });
}

/* ---------------------- microphone → prompt (Blocks) ------------------- */
// Send a recorded clip to the foundation server's /api/transcribe, which
// hires a speech-to-text agent on Blocks and returns the words. This is how
// the mic "translates the prompt into prompt format" through the network.
async function transcribeAudio(attachment, settings, signal) {
  const { b64, format } = splitDataUrl(attachment && attachment.url);
  if (!b64) throw new Error("Couldn’t read the recording (unsupported audio format).");
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;

  const res = await fetch(`${baseUrl}/api/transcribe`, {
    method: "POST",
    headers,
    body: JSON.stringify({ audio: b64, format }),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Transcription failed (HTTP ${res.status})`);
  }
  const text = (data.text || "").trim();
  if (!text) throw new Error("Transcriber returned no text.");
  return text;
}

/* ---------------------- image → understanding (Blocks) ---------------- */
// Send an uploaded image to the foundation server's /api/describe-image,
// which hires a vision (image-to-text) agent on Blocks and returns a text
// description. This is how an uploaded picture is "processed as part of a
// task" through the network: the words come back, get folded into the
// prompt, and the gateway acts on them. Mirrors transcribeAudio.
async function describeImage(attachment, prompt, settings, signal) {
  const { b64, format } = splitImageDataUrl(attachment && attachment.url);
  if (!b64) throw new Error("Couldn’t read the image (unsupported format).");
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;

  const res = await fetch(`${baseUrl}/api/describe-image`, {
    method: "POST",
    headers,
    body: JSON.stringify({ image: b64, format, prompt: (prompt || "").trim() }),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Image understanding failed (HTTP ${res.status})`);
  }
  const text = (data.text || "").trim();
  if (!text) throw new Error("Vision agent returned no description.");
  return text;
}

/* ---------------------- text → image (Blocks) -------------------------- */
// Send an image-creation prompt to the foundation server's
// /api/generate-image, which discovers a text-to-image agent on Blocks,
// ranks it with the same chooseSpecialist logic the assistant path uses,
// hires it, and returns the rendered picture as a Markdown artifact
// (`![…](url)`) plus its media descriptor. This is how "generate a logo" /
// "draw a picture" reaches Blocks deterministically instead of the gateway's
// own model. Mirrors describeImage. Returns the full bridge payload; a
// `matched:false` (or thrown error) means the caller should fall back to the
// gateway — never fabricate an image.
async function generateImage(prompt, settings, signal) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;

  const strategy = (settings && settings.imageStrategy) || "single";
  const res = await fetch(`${baseUrl}/api/generate-image`, {
    method: "POST",
    headers,
    // Default to free so a paid image agent is never hired silently.
    // `strategy` coordinates multiple agents when more than one is discovered
    // (single | race | compare | best); the bridge collapses to single when
    // only one agent exists.
    body: JSON.stringify({ prompt: (prompt || "").trim(), billingMode: "free", strategy }),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Image generation failed (HTTP ${res.status})`);
  }
  return data;
}

// Cheap client gate: only attempt intent routing when the text plausibly
// matches a specialist. Keeps the "Finding a specialist…" step from flashing
// on every normal chat. The bridge does the authoritative match in /api/route.
// ── turn classification ───────────────────────────────────────────────────
// The bridge's POST /api/classify is the AUTHORITATIVE "which path does this
// turn take?" gate (src/routing/turn-router.ts). `classifyTurn` asks it; the two
// regexes below are a byte-identical FALLBACK used only when the endpoint is
// unreachable (network blip / older bridge), so a turn still routes sensibly
// offline. Keep them in sync with turn-router.ts.
async function classifyTurn(text, settings, signal) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  try {
    const res = await fetch(`${baseUrl}/api/classify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: text || "" }),
      signal,
    });
    const data = await res.json();
    if (res.ok && data && data.ok && data.route) return data.route;
  } catch (e) { /* fall through to the local fallback */ }
  return classifyTurnFallback(text);
}

function classifyTurnFallback(text) {
  if (looksPersonalAssistant(text)) return "assistant";
  if (looksRoutable(text)) return "specialist";
  return "gateway";
}

function looksRoutable(text) {
  const t = text || "";
  return /linkedin\.com/i.test(t)
    || (/\b(blocks?|blocks\.ai|catalog)\b/i.test(t)
      && /\b(what|which|who|find|search|list|show|available|using|use|uses|support|supports|can|agents?|tools?|models?|tags?)\b/i.test(t));
}

function looksPersonalAssistant(text) {
  const t = text || "";
  return /\bconfirm_[a-f0-9]{16}\b/i.test(t)
    || /\b(availability|available|free|busy|calendar|schedule|meeting|book|draft an email|email|gmail|ask .+ assistant)\b/i.test(t)
    || looksPeerCoordination(t)
    || createsImage(t)
    || understandsImage(t);
}

// Byte-identical port of the ONE shared peer-coordination detector in
// src/routing/peer-coordination.ts (mirrored here because the browser lib is a
// standalone script with no module imports). Coordination is intent-shaped,
// not keyword-exact: a scheduling/availability intent ("coordinate", "find a
// time", "when are we both free", "set up …", "…to meet") combined with a
// coordination-shaped person reference ("with Bob", "me and Bob", "Kayley and
// I") means coordination — so the terse "find a time for me and Bob to meet"
// routes to the PA like the verbose "coordinate with Bob". It stays
// conservative: an explicitly-timed direct booking ("book … with Sam on Friday
// at 2pm") is NOT coordination, and ordinary chat that merely mentions time
// ("what time is it in Tokyo?") carries no person reference. Keep in sync with
// peer-coordination.ts.
const PEER_REF_PATTERNS = [
  /\bwith\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
  /\b(?:ask|coordinate|check|compare|sync)\s+(?:with\s+)?(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
  /\b(@?[a-z][a-z0-9_.@'’-]*)\s+and\s+(?:i|me)\b/iu,
  /\b(?:i|me)\s+and\s+(@?[a-z][a-z0-9_.@'’-]*)\b/iu,
];

function peerCoordinationIsExplicitBooking(lower) {
  return (
    /\b(book|create|add)\b/.test(lower) ||
    /\bat\s+\d/.test(lower) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(lower) ||
    /\b\d{1,2}:\d{2}\b/.test(lower)
  );
}

function peerCoordinationIntent(lower) {
  if (/\b(coordinat\w*|compare|mutual|together)\b/.test(lower)) return true;
  if (/\bworks?\s+for\s+both\b/.test(lower)) return true;
  if (/\bboth\b[\s\S]*\b(free|available|availability|busy)\b/.test(lower)) return true;
  if (/\b(free|available|availability|busy)\b[\s\S]*\bboth\b/.test(lower)) return true;
  if (/\bfind\s+(?:me\s+|us\s+)?(?:a\s+|some\s+)?(?:time|slot)\b/.test(lower)) return true;
  if (/\bwhen\s+(?:are|can|is)\b[\s\S]*\b(free|available)\b/.test(lower)) return true;
  if (/\btime\s+to\s+(?:meet|talk|sync|chat|catch\s*up|connect)\b/.test(lower)) return true;
  if (!peerCoordinationIsExplicitBooking(lower) && /\b(meet|set\s*up|schedule)\b/.test(lower)) return true;
  return false;
}

function normalizePeerReference(value) {
  const ref = (value || "")
    .replace(/['’]s$/u, "")
    .replace(/[^\p{L}\p{N}_@.'’-]+$/gu, "")
    .trim();
  if (!ref) return null;
  if (/^(me|my|mine|i|you|your|calendar|meeting|event|call|time|slot|the|a|an)$/i.test(ref)) return null;
  return ref;
}

function peerCoordinationPersonRef(request) {
  const lower = (request || "").toLowerCase();
  if (!peerCoordinationIntent(lower)) return null;
  for (const pattern of PEER_REF_PATTERNS) {
    const match = request.match(pattern);
    const ref = normalizePeerReference(match && match[1]);
    if (ref) return ref;
  }
  return null;
}

function looksPeerCoordination(text) {
  return peerCoordinationPersonRef(text || "") !== null;
}

// Byte-identical port of the canonical create-vs-understand image matcher in
// src/routing/intent-tags.ts (mirrored here because the browser lib is a
// standalone script with no module imports). "image" is ambiguous, so each
// intent is gated on the VERB/cue, never the bare noun: CREATE makes a NEW
// picture (make/draw/generate a poster/logo/art); UNDERSTAND reads an EXISTING
// one (caption/describe/"what is this"). Keep in sync with intent-tags.ts.
const CREATE_IMAGE_VERB = /\b(make|create|generate|draw|design|render|produce|paint|sketch|illustrate)\b/;
const IMAGE_SUBJECT = /\b(images?|pictures?|photos?|posters?|logos?|art|illustrations?|drawings?|portraits?|icons?|graphics?|wallpapers?)\b/;
const UNDERSTAND_IMAGE_CUE = /\b(caption|describe|identify|recogni[sz]e|read|extract|ocr|analy[sz]e|what(?:'s|’s| is| are)?)\b/;
const EXISTING_IMAGE = /\b(images?|pictures?|photos?|screenshots?|pics?)\b/;
const IMAGE_ALREADY_READ = /image understanding from blocks/;

function createsImage(text) {
  const t = (text || "").toLowerCase();
  return CREATE_IMAGE_VERB.test(t) && IMAGE_SUBJECT.test(t);
}

function understandsImage(text) {
  const t = (text || "").toLowerCase();
  return IMAGE_ALREADY_READ.test(t)
    || (!CREATE_IMAGE_VERB.test(t) && UNDERSTAND_IMAGE_CUE.test(t) && EXISTING_IMAGE.test(t));
}

async function runAssistant(text, settings, signal, attachments) {
  const ownerId = ((settings && settings.ownerId) || "").trim();
  if (!ownerId) throw new Error("Set an owner ID in Settings first.");
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  const res = await fetch(`${baseUrl}/api/assistant/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: text || "", ownerId, ...(attachments && attachments.length ? { attachments } : {}) }),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Assistant run failed (HTTP ${res.status})`);
  }
  return data;
}

function streamAssistant(text, settings, callbacks, attachments) {
  const ownerId = ((settings && settings.ownerId) || "").trim();
  if (!ownerId) throw new Error("Set an owner ID in Settings first.");
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  const controller = new AbortController();
  const startedAt = performance.now();
  const cb = callbacks || {};

  (async () => {
    try {
      const res = await fetch(`${baseUrl}/api/assistant/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: text || "", ownerId, ...(attachments && attachments.length ? { attachments } : {}) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 300); } catch (e) {}
        throw new Error(`Assistant stream failed (HTTP ${res.status})${detail ? " — " + detail : ""}`);
      }
      if (!res.body) throw new Error("No assistant event stream from bridge.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleAssistantSSE(raw, cb);
        }
      }
      if (buffer.trim()) handleAssistantSSE(buffer, cb);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      cb.onError && cb.onError(err);
    }
  })();

  return { cancel: () => controller.abort(), startedAt };
}

function handleAssistantSSE(block, cb) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    const t = line.trimEnd();
    if (t.startsWith("event:")) event = t.slice(6).trim();
    else if (t.startsWith("data:")) data.push(t.slice(5).trim());
  }
  if (!data.length) return;
  let payload;
  try { payload = JSON.parse(data.join("\n")); } catch (e) { return; }
  if (event === "status") cb.onStatus && cb.onStatus(payload);
  else if (event === "step") cb.onStep && cb.onStep(payload);
  else if (event === "final") cb.onFinal && cb.onFinal(payload);
  else if (event === "error") cb.onError && cb.onError(new Error(payload.error || "Assistant stream failed"));
}

/* ----------------------- resume payload contract (UI.10) ---------------- */
// Every remedy chip (Confirm, Re-propose, Disambiguate, Add contact, Invite
// peer, Finish step, Retry) resumes the parked plan by POSTing back a defined
// envelope. The runtime routes the resume off the `text` field of the existing
// /api/assistant/stream endpoint:
//   - confirm      → the booking/confirm token              (parseConfirmToken)
//   - disambiguate → JSON { resumeToken, peerHandle }       (parseResumePick)
//   - finish/retry → the original request text (re-run; completed steps in the
//                    pending-plan ledger are skipped, so this is idempotent)
// `assistantResumeText` turns an envelope into that text payload; the caller
// (add-contact / invite-peer) is expected to persist its side-effect via the
// contacts / invite APIs FIRST, then resume with kind:"retry".
function assistantResumeText(envelope) {
  const e = envelope || {};
  switch (e.kind) {
    case "confirm":
      return (e.token || "").trim();
    case "disambiguate":
      return JSON.stringify({ resumeToken: e.resumeToken || e.token, peerHandle: e.peerHandle });
    case "finish":
    case "retry":
    default:
      return (e.text || "").trim();
  }
}

// Stream a resume turn from a chip envelope. Thin wrapper over streamAssistant
// so the resume contract lives in one place.
function resumeAssistant(envelope, settings, callbacks) {
  const text = assistantResumeText(envelope);
  if (!text) throw new Error("Resume envelope is missing its payload.");
  return streamAssistant(text, settings, callbacks);
}

/* ---- owner-scoped meeting-request handshake (two-sided peer booking) -----
 * A net-new, owner-KEYED SSE channel — distinct from the per-request
 * /api/assistant/stream — that pushes meeting-request state to BOTH owners:
 * the initiator sees "Waiting for … to accept", the peer sees an actionable
 * "Incoming meeting request …". It reuses the same fetch-stream + SSE framing
 * as streamAssistant (rather than EventSource) so it can carry the bearer
 * token. Returns a handle with cancel(); the server replays current state on
 * connect, so a late subscriber never misses a pending request. */
function subscribeMeetingRequests(settings, callbacks) {
  const ownerId = ((settings && settings.ownerId) || "").trim();
  if (!ownerId) throw new Error("Set an owner ID in Settings first.");
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = {};
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  const controller = new AbortController();
  const cb = callbacks || {};

  (async () => {
    try {
      const res = await fetch(`${baseUrl}/api/assistant/notifications?owner=${encodeURIComponent(ownerId)}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Notifications stream failed (HTTP ${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = "message";
          const data = [];
          for (const line of raw.split("\n")) {
            const t = line.trimEnd();
            if (t.startsWith("event:")) event = t.slice(6).trim();
            else if (t.startsWith("data:")) data.push(t.slice(5).trim());
          }
          if (event !== "meeting-request" || !data.length) continue;
          let payload;
          try { payload = JSON.parse(data.join("\n")); } catch (e) { continue; }
          cb.onMeetingRequest && cb.onMeetingRequest(payload);
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      cb.onError && cb.onError(err);
    }
  })();

  return { cancel: () => controller.abort() };
}

// Record this owner's accept/decline on a meeting request. Reuses the PAIRED
// confirm-token pattern (one token per owner per threadId): the token arrives
// on the actionable notification and is echoed back so an owner can only
// accept their OWN side. The bilateral commit runs server-side on the second
// acceptance; the resulting state change streams back over the SSE channel.
async function respondMeetingRequest(settings, args) {
  const ownerId = ((settings && settings.ownerId) || "").trim();
  if (!ownerId) throw new Error("Set an owner ID in Settings first.");
  const a = args || {};
  const decision = a.decision === "decline" ? "decline" : "accept";
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  const res = await fetch(`${baseUrl}/api/assistant/meeting-request/${decision}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ownerId, threadId: a.threadId, ...(a.confirmToken ? { confirmToken: a.confirmToken } : {}) }),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Meeting ${decision} failed (HTTP ${res.status})`);
  }
  return data;
}

async function bridgeIdentity(settings, signal) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = {};
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  const res = await fetch(`${baseUrl}/api/identity`, { headers, signal });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false || !data.ownerId) {
    throw new Error((data && data.error) || `Identity lookup failed (HTTP ${res.status})`);
  }
  return data;
}

// Ask the bridge whether this turn maps onto a Blocks specialist, and if so
// run it. Returns { matched, handle, text, mode, meta } or { matched: false }.
// Mirrors transcribeAudio/describeImage: frontend posts, bridge does the work.
async function routeIntent(text, settings, signal, options) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  const res = await fetch(`${baseUrl}/api/route`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: text || "",
      ...(options && Array.isArray(options.candidates) && options.candidates.length ? { candidates: options.candidates } : {}),
    }),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) return { matched: false };
  return data;
}

async function integrationStatus(settings, signal) {
  const owner = ((settings && settings.ownerId) || "").trim();
  if (!owner) return { ok: true, google: { connected: false } };
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/api/integrations/status?owner=${encodeURIComponent(owner)}`, { headers: apiHeaders(settings), signal });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Integration status failed (HTTP ${res.status})`);
  }
  return data;
}

async function createSkillFile(text, settings, signal) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/api/skill-file`, {
    method: "POST",
    headers: apiHeaders(settings),
    body: JSON.stringify({ text: text || "" }),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Skill file creation failed (HTTP ${res.status})`);
  }
  return data;
}

async function assistantOverview(settings, signal) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/api/assistant/overview`, { headers: apiHeaders(settings), signal });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Assistant overview failed (HTTP ${res.status})`);
  }
  return data;
}

// Browse the FULL public Blocks registry, one page at a time. Backed by the
// bridge's /api/blocks/browse route (the full cursor walk + 60s cache), NOT the
// single-page /api/blocks — so paging never silently misses agents past a
// limit. Server-side pagination + search keeps the payload to one page; pass
// { refresh: true } to force a fresh registry walk.
async function browseNetworkAgents(settings, opts, signal) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const o = opts || {};
  const params = new URLSearchParams();
  const offset = Number(o.offset);
  const limit = Number(o.limit);
  if (Number.isFinite(offset) && offset > 0) params.set("offset", String(Math.floor(offset)));
  if (Number.isFinite(limit) && limit > 0) params.set("limit", String(Math.floor(limit)));
  if (o.q && String(o.q).trim()) params.set("q", String(o.q).trim());
  if (o.tag && String(o.tag).trim()) params.set("tag", String(o.tag).trim());
  if (o.refresh) params.set("refresh", "1");
  const qs = params.toString();
  const res = await fetch(`${baseUrl}/api/blocks/browse${qs ? "?" + qs : ""}`, { headers: apiHeaders(settings), signal });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Network agents lookup failed (HTTP ${res.status})`);
  }
  return data;
}

// Probe whether an invited peer's assistant is actually serving right now.
// The bridge sends a bounded reachability task and reports a 3-state:
// "online" (an instance picked it up), "offline" (asked, nobody home), or
// "unknown" (couldn't ask — offline mode / no key / transport error). Returns
// { status, reason, latencyMs } and never throws — a probe failure is itself
// an "unknown", so the UI degrades to a neutral dot instead of an error.
async function peerStatus(handle, settings, signal) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  try {
    const res = await fetch(`${baseUrl}/api/assistant/peer-status?handle=${encodeURIComponent(handle)}`, {
      headers: apiHeaders(settings),
      signal,
    });
    const data = await res.json();
    if (res.ok && data && data.ok && data.status) {
      return { status: data.status, reason: data.reason || "", latencyMs: data.latencyMs };
    }
    return { status: "unknown", reason: (data && data.error) || `Probe failed (HTTP ${res.status})` };
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return { status: "unknown", reason: String((e && e.message) || e) };
  }
}

// Pillar 3.2/3.5: introduce a peer by exchanging a MINIMAL identity card
// (name + capabilities). Records the relationship in both rosters so a
// natural reference ("Kayley", "@kayley") resolves to this peer afterwards.
async function invitePeer(settings, args) {
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const ownerId = ((settings && settings.ownerId) || "").trim();
  const a = args || {};
  const peerCard = {};
  if (a.peerDisplayName && a.peerDisplayName.trim()) peerCard.displayName = a.peerDisplayName.trim();
  if (a.peerOwnerName && a.peerOwnerName.trim()) peerCard.ownerName = a.peerOwnerName.trim();
  // Workstream I.1: a peer email makes the card self-describing, so the invite
  // materializes a contact ("email Kayley") joined to the peer by handle.
  if (a.peerEmail && a.peerEmail.trim()) peerCard.email = a.peerEmail.trim();
  if (a.peerAgentName && a.peerAgentName.trim()) peerCard.handle = a.peerAgentName.trim();
  if (a.peerCapabilities && a.peerCapabilities.length) peerCard.capabilities = a.peerCapabilities;
  if (a.peerAliases && a.peerAliases.length) peerCard.aliases = a.peerAliases;
  const res = await fetch(`${baseUrl}/api/assistant/invite`, {
    method: "POST",
    headers: apiHeaders(settings),
    body: JSON.stringify({
      owner: a.owner || ownerId,
      ...(ownerId ? { ownerId } : {}),
      agentName: a.agentName,
      peerOwner: a.peerOwner || a.peerOwnerName || a.peerAgentName,
      peerAgentName: a.peerAgentName,
      ...(Object.keys(peerCard).length ? { peerCard } : {}),
    }),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Invite failed (HTTP ${res.status})`);
  }
  return data;
}

/* ----------------------- owner profile + contacts ---------------------- */
// Pillar 0: read/set the owner identity profile (name/email/timezone) and
// the contact book the assistant uses to resolve email recipients.

function apiBase(settings) {
  return ((settings && settings.baseUrl) || "").replace(/\/$/, "");
}
function apiHeaders(settings) {
  const headers = { "Content-Type": "application/json" };
  if (settings && settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  return headers;
}

async function loadProfile(settings, signal) {
  const owner = ((settings && settings.ownerId) || "").trim();
  if (!owner) return { ok: true, profile: null };
  const res = await fetch(`${apiBase(settings)}/api/profile?owner=${encodeURIComponent(owner)}`, { headers: apiHeaders(settings), signal });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Profile lookup failed (HTTP ${res.status})`);
  }
  return data;
}

async function saveProfile(settings, profile) {
  const owner = ((settings && settings.ownerId) || "").trim();
  if (!owner) throw new Error("Set an owner ID in Settings first.");
  const res = await fetch(`${apiBase(settings)}/api/profile`, {
    method: "POST",
    headers: apiHeaders(settings),
    body: JSON.stringify({ ownerId: owner, ...(profile || {}) }),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Profile save failed (HTTP ${res.status})`);
  }
  return data;
}

async function loadContacts(settings, signal) {
  const owner = ((settings && settings.ownerId) || "").trim();
  if (!owner) return { ok: true, contacts: [] };
  const res = await fetch(`${apiBase(settings)}/api/contacts?owner=${encodeURIComponent(owner)}`, { headers: apiHeaders(settings), signal });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Contacts lookup failed (HTTP ${res.status})`);
  }
  return data;
}

async function saveContact(settings, contact) {
  const owner = ((settings && settings.ownerId) || "").trim();
  if (!owner) throw new Error("Set an owner ID in Settings first.");
  const res = await fetch(`${apiBase(settings)}/api/contacts`, {
    method: "POST",
    headers: apiHeaders(settings),
    body: JSON.stringify({ ownerId: owner, ...(contact || {}) }),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Contact save failed (HTTP ${res.status})`);
  }
  return data;
}

async function removeContact(settings, name) {
  const owner = ((settings && settings.ownerId) || "").trim();
  if (!owner) throw new Error("Set an owner ID in Settings first.");
  const res = await fetch(`${apiBase(settings)}/api/contacts/remove`, {
    method: "POST",
    headers: apiHeaders(settings),
    body: JSON.stringify({ ownerId: owner, name }),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `Contact removal failed (HTTP ${res.status})`);
  }
  return data;
}

async function startGoogleConnect(settings) {
  const owner = ((settings && settings.ownerId) || "").trim();
  if (!owner) throw new Error("Set an owner ID in Settings first.");
  const baseUrl = ((settings && settings.baseUrl) || "").replace(/\/$/, "");
  const here = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({ owner, returnTo: here });
  const res = await fetch(`${baseUrl}/api/integrations/google/start?${params.toString()}`, { headers: apiHeaders(settings) });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok === false || !data.url) {
    throw new Error((data && data.error) || `Google connect failed (HTTP ${res.status})`);
  }
  window.location.href = data.url;
}

function splitImageDataUrl(dataUrl) {
  const s = dataUrl || "";
  const comma = s.indexOf(",");
  if (comma < 0) return { b64: "", format: "png" };
  const header = s.slice(0, comma);
  const b64 = s.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  const mime = (/^data:([^;,]+)/i.exec(header) || [])[1] || "";
  let format = "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) format = "jpg";
  else if (mime.includes("png")) format = "png";
  else if (mime.includes("webp")) format = "webp";
  else if (mime.includes("gif")) format = "gif";
  return { b64: isBase64 ? b64 : "", format };
}

function splitDataUrl(dataUrl) {
  // Robust against parameters in the header, e.g. MediaRecorder emits
  // "data:audio/webm;codecs=opus;base64,…" — split on the FIRST comma and
  // read the mime from the header rather than assuming ";base64" sits
  // immediately after the mime type.
  const s = dataUrl || "";
  const comma = s.indexOf(",");
  if (comma < 0) return { b64: "", format: "wav" };
  const header = s.slice(0, comma);          // e.g. data:audio/webm;codecs=opus;base64
  const b64 = s.slice(comma + 1);
  const isBase64 = /;base64\s*$/i.test(header) || header.includes(";base64;") || header.includes(";base64,");
  const mime = (/^data:([^;,]+)/i.exec(header) || [])[1] || "";
  let format = "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) format = "mp3";
  else if (mime.includes("webm")) format = "webm";
  else if (mime.includes("ogg")) format = "ogg";
  else if (mime.includes("mp4") || mime.includes("m4a")) format = "mp4";
  else if (mime.includes("wav")) format = "wav";
  return { b64: isBase64 ? b64 : "", format };
}

/* ============================ REAL STREAMING ===========================
   Implements the OpenClaw contract exactly. Returns { cancel }.
   Callbacks: onToken(text), onToolEvent(evt), onMeta(meta), onDone(meta), onError(err)
   ======================================================================== */
function streamChat(opts) {
  const {
    baseUrl, token, conversationId, messages,
    onToken, onToolEvent, onMeta, onDone, onError,
  } = opts;

  const controller = new AbortController();
  const startedAt = performance.now();
  let usage = null, cost = null;

  (async () => {
    try {
      const headers = {
        "Content-Type": "application/json",
        "x-openclaw-session-key": conversationId,
      };
      // Only attach a bearer when the operator filled one in; otherwise the
      // same-origin proxy injects the gateway token server-side.
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "openclaw/default",
          stream: true,
          max_completion_tokens: 1024,
          messages,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 300); } catch (e) {}
        throw new Error(`Gateway responded ${res.status} ${res.statusText}${detail ? " — " + detail : ""}`);
      }
      if (!res.body) throw new Error("No response stream from gateway.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events split on double newline
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleSSEBlock(raw);
        }
      }
      if (buffer.trim()) handleSSEBlock(buffer);

      const latency = performance.now() - startedAt;
      onDone && onDone({ latency, cost, usage });
    } catch (err) {
      if (err && err.name === "AbortError") return;
      onError && onError(err);
    }
  })();

  function handleSSEBlock(block) {
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json;
      try { json = JSON.parse(payload); } catch (e) { continue; }

      // standard OpenAI delta
      const choice = json.choices && json.choices[0];
      const delta = choice && choice.delta;
      if (delta && typeof delta.content === "string" && delta.content) {
        onToken && onToken(delta.content);
      }

      // OpenClaw tool/agent activity — accept a few plausible shapes
      const evt = json.openclaw_event || (delta && delta.openclaw_event) || json.tool_event;
      if (evt) onToolEvent && onToolEvent(evt);
      if (delta && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc.function && tc.function.name) {
            onToolEvent && onToolEvent({ type: "tool", id: tc.id || uid("tc"), skill: tc.function.name, status: "running", label: `Calling ${tc.function.name}…` });
          }
        }
      }

      if (json.usage) { usage = json.usage; onMeta && onMeta({ usage }); }
      const c = json.cost ?? json.openclaw_cost ?? (json.usage && json.usage.cost);
      if (c != null) { cost = c; onMeta && onMeta({ cost }); }
    }
  }

  return { cancel: () => controller.abort() };
}

/* (The simulated demo/mock engine was removed for the hosted build — the UI
   only drives the real gateway, transcription, and vision paths now.) */

/* ----------------------------- exports --------------------------------- */
Object.assign(window, {
  uid, fmtTime, fmtDuration, LS,
  SETTINGS_KEY, CONVOS_KEY, CURRENT_KEY, DEFAULT_SETTINGS,
  loadSettings, saveSettings, loadConversations, saveConversations, clearLocalSession,
  ACCEPTED_IMAGE, processImageFile, readFileAsDataURL, loadImage,
  ACCEPTED_AUDIO,
  toApiMessages, splitDataUrl, transcribeAudio,
  describeImage, generateImage, splitImageDataUrl,
  createsImage, understandsImage,
  routeIntent, classifyTurn, looksRoutable, looksPersonalAssistant, runAssistant, streamAssistant, resumeAssistant, assistantResumeText, bridgeIdentity, integrationStatus, assistantOverview, peerStatus, invitePeer, startGoogleConnect,
  subscribeMeetingRequests, respondMeetingRequest,
  browseNetworkAgents,
  createSkillFile,
  loadProfile, saveProfile, loadContacts, saveContact, removeContact,
  streamChat,
});
