/* ===========================================================================
   app.jsx — application root: sessions, persistence, send/stream
   orchestration (real gateway + mock fallback), theme, layout.
   =========================================================================== */
(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const { Sidebar, Message, EmptyState, AssistantOverviewPanel, MeetingRequestsPanel, NetworkAgentsPanel, SettingsModal, Lightbox, Toast, Icons } = window;

  function deriveTitle(text, atts) {
    const t = (text || "").trim().replace(/\s+/g, " ");
    if (t) return t.length > 42 ? t.slice(0, 42) + "…" : t;
    if (atts && atts.some((a) => a.kind === "image")) return "Image conversation";
    if (atts && atts.some((a) => a.kind === "audio")) return "Voice message";
    return "New chat";
  }
  function mergeEvent(events, e) {
    const arr = events ? events.slice() : [];
    const idx = arr.findIndex((x) => x.id === e.id);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...e };
    else arr.push(e);
    return arr;
  }
  function startThinking(label) {
    return { status: "running", label: label || "Thinking…", steps: [], errors: [] };
  }
  function upsertThinkingStep(thinking, step) {
    const t = thinking || startThinking();
    let steps = t.steps ? t.steps.slice() : [];
    const id = step.id || window.uid("think");
    const nextStep = { ...step, id };
    const idx = steps.findIndex((s) => s.id === id);
    if (idx >= 0) {
      steps[idx] = { ...steps[idx], ...nextStep };
    } else {
      // Steps stream in sequentially (plan → hire → dispatch → generate), so a
      // NEW step means the previous in-flight one just finished. Demote prior
      // running steps to "done" so only the newest step shows a spinner —
      // otherwise every line spins at once.
      steps = steps.map((s) => (s.status === "running" ? { ...s, status: "done" } : s));
      steps.push(nextStep);
    }
    return { ...t, status: "running", label: nextStep.label || t.label, steps };
  }
  function finishThinking(thinking, label) {
    const t = thinking || startThinking();
    return {
      ...t,
      status: "done",
      label: label || t.label || "Done",
      steps: (t.steps || []).map((s) => s.status === "running" ? { ...s, status: "done" } : s),
    };
  }
  function failThinking(thinking, title, message) {
    const t = thinking || startThinking("Something went wrong");
    const error = { id: window.uid("err"), title: title || "Error", message: message || "Unknown error" };
    return {
      ...finishThinking(t, title || "Finished with an error"),
      status: "error",
      errors: [...(t.errors || []), error],
    };
  }
  function audioTranscriptPrompt(userText, transcript) {
    const ask = (userText || "").trim();
    const spoken = (transcript || "").trim();
    const block = [
      "The attached voice message has already been transcribed by Blocks.",
      "Use this transcript as the audio content; do not ask for the audio attachment again.",
      "",
      "Audio transcript from Blocks:",
      spoken,
    ].join("\n");
    return ask ? ask + "\n\n" + block : block;
  }
  function audioTranscriptDisplay(userText, transcript) {
    const ask = (userText || "").trim();
    const spoken = (transcript || "").trim();
    const block = "Audio transcript from Blocks:\n" + spoken;
    return ask ? ask + "\n\n" + block : block;
  }
  function audioTranscriptRoutingText(userText, transcript) {
    const ask = (userText || "").trim();
    const spoken = (transcript || "").trim();
    return [ask, spoken].filter((t) => t && t.trim()).join("\n\n");
  }
  function wantsSkillFile(text) {
    const t = text || "";
    const namesSkillFile = /\bskills?\s+files?\b/i.test(t) || /\bSKILL\.md\b/i.test(t);
    const asksForOne = /\b(create|make|write|generate|build|need|want)\b/i.test(t)
      || /\b(looking for|give me|get me|can i get|could i get)\b/i.test(t);
    return namesSkillFile && asksForOne;
  }
  function skillFileDisplay(result) {
    const filename = result && result.filename || "SKILL.md";
    const skillName = result && result.skillName || "custom-skill";
    const url = result && result.url || "";
    const markdown = result && result.markdown || "";
    const link = url ? `[${filename}](${url})` : filename;
    return [
      `Created \`${skillName}/SKILL.md\`.`,
      "",
      `File: ${link}`,
      "",
      "```markdown",
      escapeFence(markdown),
      "```",
    ].join("\n");
  }
  function escapeFence(text) {
    return String(text || "").replace(/```/g, "'''");
  }
  function stepFromStatus(status, fallbackId) {
    const message = (status && status.message || "").trim();
    return {
      id: fallbackId || "status-" + (status && status.index != null ? status.index : window.uid("s")),
      label: message || "Working…",
      detail: status && status.at ? window.fmtTime(status.at) : "",
      status: "running",
    };
  }
  // UI.7: merge a structured `step` event (or a final artifact step) into the
  // message's plan ledger, keyed by step id.
  function upsertLedgerStep(ledger, step) {
    const arr = ledger ? ledger.slice() : [];
    const id = step.id || ("step-" + (step.index != null ? step.index : arr.length));
    const next = { id, kind: step.kind, index: step.index, status: step.status, reply: step.reply };
    const idx = arr.findIndex((s) => s.id === id);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...next };
    else arr.push(next);
    return arr;
  }
  function ledgerFromArtifact(existing, artifact) {
    if (!artifact || !Array.isArray(artifact.steps) || !artifact.steps.length) return existing || [];
    let ledger = existing ? existing.slice() : [];
    artifact.steps.forEach((s, i) => {
      ledger = upsertLedgerStep(ledger, { id: s.id || ("step" + (i + 1)), kind: s.kind, index: i, status: s.status, reply: s.reply });
    });
    return ledger;
  }

  function assistantDisplayText(result) {
    const artifact = result && result.artifact;
    if (artifact && artifact.confirmToken && typeof artifact.reply === "string" && artifact.reply.trim()) {
      return artifact.reply.trim();
    }
    return (result && result.text) || "Done.";
  }
  function wantsRandomBlocksFollowup(text) {
    const t = (text || "").trim();
    return /\b(use|try|run|pick|choose)\b/i.test(t) && /\b(random|one|another|that)\b/i.test(t);
  }
  function lastBlocksCandidates(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      const routed = m.meta && (m.meta.routed || m.meta.route);
      const agents = routed && Array.isArray(routed.agents) ? routed.agents : null;
      if (agents && agents.length) {
        return agents.map((a) => ({ handle: a.handle || a.agentName, displayName: a.displayName, tags: a.tags }))
          .filter((a) => a.handle);
      }
      const parsed = parseCatalogHandles(m.text || "");
      if (parsed.length) return parsed;
    }
    return [];
  }
  function parseCatalogHandles(text) {
    if (!/\b(blocks catalog|catalog agents|Found \d+ matches|Recommendation:|Starter pick:)/i.test(text || "")) return [];
    const seen = new Set();
    const out = [];
    const add = (handle, displayName) => {
      const h = (handle || "").trim();
      if (!/^[a-zA-Z0-9_-]{2,80}$/.test(h) || seen.has(h)) return;
      seen.add(h);
      out.push({ handle: h, displayName: displayName || h });
    };
    let match;
    const rec = /(?:Recommendation:\s+I'd pick|Starter pick:)\s+([a-zA-Z0-9_-]+)\s+\(([^)]+)\)/i.exec(text || "");
    if (rec) add(rec[1], rec[2]);
    const row = /^([a-zA-Z0-9_-]+)\s+\(([^)]+)\)\s+—/gm;
    while ((match = row.exec(text || "")) && out.length < 20) add(match[1], match[2]);
    return out;
  }
  function blocksAgentHandle(agent) {
    return String(agent && (agent.handle || agent.agentName) || "").trim();
  }
  function blocksAgentLabel(agent) {
    return String(agent && (agent.displayName || agent.name || agent.handle || agent.agentName) || "Blocks agent").trim();
  }
  function routedDisplayText(routed) {
    const text = (routed && routed.text) || "";
    if (!routed || routed.handle !== "blocks-catalog") return text;
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const scanned = lines.find((line) => /^I scanned\b/i.test(line));
    const found = lines.find((line) => /^Found\b/i.test(line));
    const pick = lines.find((line) => /^(Recommendation:|Starter pick:)/i.test(line));
    const resultLine = found || (Array.isArray(routed.agents) ? `Found ${routed.agents.length} matching agents.` : "");
    return [
      scanned,
      resultLine,
      "Pick an agent below, then send a prompt for it. Availability is checked when the task runs.",
      pick,
    ].filter(Boolean).join("\n\n");
  }
  function selectedAgentInactiveReason(message) {
    return /accepted the request but timed out|timed out before returning an output|timed out after \d+s/iu.test(message || "");
  }
  function isStaleDemoOwnerId(value) {
    const ownerId = (value || "").trim().toLowerCase();
    return ownerId === "alice-oid" || ownerId === "owner-uuid-alice";
  }
  function shouldAdoptBridgeOwner(prevOwnerId, identity) {
    const nextOwnerId = (identity && identity.ownerId || "").trim();
    if (!nextOwnerId || prevOwnerId === nextOwnerId) return false;
    if (!prevOwnerId || isStaleDemoOwnerId(prevOwnerId)) return true;

    // A per-owner subdomain (source "assistant-host") binds THIS page to exactly
    // one owner. That binding is authoritative: adopt it even when the saved id
    // is another KNOWN owner. Otherwise a stale localStorage owner — e.g. from
    // testing the other assistant in the same browser — hijacks every
    // owner-scoped call (notifications, accept), so the peer sees the initiator's
    // "Waiting for … to accept" card and can never accept a meeting as
    // themselves. The host binding must win over any previously saved owner.
    if (String(identity && identity.source || "") === "assistant-host") return true;

    const knownOwners = identity && Array.isArray(identity.ownerIds)
      ? identity.ownerIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    if (knownOwners.includes(prevOwnerId)) return false;
    if (knownOwners.length === 1 && knownOwners[0] === nextOwnerId) return true;

    return /assistant-(host|config|default|single)/i.test(String(identity && identity.source || ""));
  }
  function isImageDescribeOnlyRequest(text) {
    const t = (text || "").trim().toLowerCase();
    if (!t) return true;
    return /^(describe|caption|summari[sz]e|explain|read|analy[sz]e|what('?s| is)|what do you see|tell me about)\b/.test(t)
      && /\b(this|the|my)?\s*(image|photo|picture|screenshot|attachment|attached|it)\b/.test(t)
      && !/\b(calendar|gmail|email|meeting|book|schedule|availability|free|busy|poster|make|create|generate|send|draft|ask .+ assistant)\b/.test(t);
  }

  function App() {
    const [settings, setSettings] = useState(window.loadSettings);
    const [conversations, setConversations] = useState(window.loadConversations);
    const [currentId, setCurrentId] = useState(() => window.LS.get(window.CURRENT_KEY, null) || window.uid("conv"));
    const [streamingId, setStreamingId] = useState(null);
    const [sidebarCollapsed, setCollapsed] = useState(false);
    const [sidebarOpenMobile, setOpenMobile] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [toast, setToast] = useState(null);
    const [inject, setInject] = useState(null);
    const [googleStatus, setGoogleStatus] = useState({ loading: true, connected: false, error: "" });
    const [selfAssistant, setSelfAssistant] = useState(null);
    const [selectedBlocksAgent, setSelectedBlocksAgent] = useState(null);

    const convosRef = useRef(conversations);
    const currentIdRef = useRef(currentId);
    const settingsRef = useRef(settings);
    const streamRef = useRef(null);
    const busyRef = useRef(false);          // guards send during async transcription
    const threadRef = useRef(null);
    const autoScroll = useRef(true);
    const toastTimer = useRef(null);
    const bridgeBase = (settings.baseUrl || "").trim();
    const bridgeLabel = (() => {
      if (!bridgeBase) return "same-origin bridge";
      try { return new URL(bridgeBase, window.location.href).host; }
      catch (e) { return bridgeBase; }
    })();

    const showToast = useCallback((text, ms = 2600) => {
      setToast(text);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => {
        setToast(null);
        toastTimer.current = null;
      }, ms);
    }, []);

    useEffect(() => { convosRef.current = conversations; }, [conversations]);
    useEffect(() => { currentIdRef.current = currentId; window.LS.set(window.CURRENT_KEY, currentId); }, [currentId]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    // Keep the effective bridge base URL on a global so the (non-React)
    // Markdown renderer can resolve root-relative media paths (/media/…,
    // /outputs/…) against the bridge instead of the page origin — required
    // when the UI is hosted separately (e.g. Netlify) from the bridge.
    useEffect(() => { window.__OPENCLAW_BASE_URL = settings.baseUrl || ""; }, [settings.baseUrl]);

    useEffect(() => {
      const controller = new AbortController();
      window.bridgeIdentity(settings, controller.signal)
        .then((identity) => {
          const ownerId = (identity && identity.ownerId || "").trim();
          if (!ownerId) return;
          setSettings((prev) => {
            const prevOwnerId = (prev.ownerId || "").trim();
            if (!shouldAdoptBridgeOwner(prevOwnerId, identity)) return prev;
            const next = { ...prev, ownerId };
            window.saveSettings(next);
            return next;
          });
        })
        .catch(() => {});
      return () => controller.abort();
    }, [settings.baseUrl, settings.token, settings.ownerId]);

    useEffect(() => {
      const controller = new AbortController();
      setGoogleStatus((prev) => ({ ...prev, loading: true, error: "" }));
      window.integrationStatus(settings, controller.signal)
        .then((data) => setGoogleStatus({
          loading: false,
          connected: !!(data && data.google && data.google.connected),
          error: "",
        }))
        .catch((err) => setGoogleStatus({ loading: false, connected: false, error: String(err.message || err) }));
      return () => controller.abort();
    }, [settings.baseUrl, settings.ownerId]);

    // Pillar 3.5 / UI.4: load THIS owner's assistant handle so the in-chat
    // "Invite peer" remedy can exchange an identity card without leaving the
    // thread. Best-effort; the roster panel remains the full surface.
    useEffect(() => {
      const owner = (settings.ownerId || "").trim();
      if (!owner) { setSelfAssistant(null); return undefined; }
      const controller = new AbortController();
      window.assistantOverview(settings, controller.signal)
        .then((data) => {
          const list = data && Array.isArray(data.assistants) ? data.assistants : [];
          const mine = list.find((a) => String(a.integrations && a.integrations.ownerId || "") === owner)
            || list.find((a) => String(a.agentName || "").startsWith("pa_"));
          setSelfAssistant(mine || null);
        })
        .catch(() => {});
      return () => controller.abort();
    }, [settings.baseUrl, settings.ownerId]);

    useEffect(() => {
      const params = new URLSearchParams(window.location.search || "");
      const google = params.get("google");
      if (!google) return;
      showToast(google === "connected" ? "Google connected" : "Google connection failed");
      params.delete("google"); params.delete("owner");
      const next = window.location.pathname + (params.toString() ? "?" + params.toString() : "") + window.location.hash;
      window.history.replaceState({}, "", next);
    }, [showToast]);

    /* theme */
    useEffect(() => {
      document.documentElement.setAttribute("data-theme", settings.theme || "light");
    }, [settings.theme]);

    /* toast listener */
    useEffect(() => {
      const fn = (e) => showToast(e.detail.text);
      window.addEventListener("openclaw:toast", fn);
      return () => window.removeEventListener("openclaw:toast", fn);
    }, [showToast]);

    useEffect(() => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    }, []);

    const conv = conversations[currentId];
    const messages = conv ? conv.messages : [];

    /* auto-scroll */
    useEffect(() => {
      const el = threadRef.current; if (!el) return;
      if (autoScroll.current) el.scrollTop = el.scrollHeight;
    });
    const onThreadScroll = () => {
      const el = threadRef.current; if (!el) return;
      autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };

    const persist = (next) => window.saveConversations(next);

    /* ----------------------------- stream ----------------------------- */
    const finishStream = useCallback(() => {
      setStreamingId(null);
      streamRef.current = null;
      persist(convosRef.current);
    }, []);

    const updateMsg = useCallback((convId, msgId, fn) => {
      setConversations((prev) => {
        const c = prev[convId]; if (!c) return prev;
        const messages = c.messages.map((m) => (m.id === msgId ? fn(m) : m));
        const next = { ...prev, [convId]: { ...c, messages, updatedAt: Date.now() } };
        convosRef.current = next;
        return next;
      });
    }, []);
    const updateAsst = updateMsg;

    const startStream = useCallback((convId, asstId, apiMessages) => {
      const s = settingsRef.current;
      autoScroll.current = true;
      const common = {
        baseUrl: s.baseUrl, token: s.token, conversationId: convId, messages: apiMessages,
        onToken: (t) => updateAsst(convId, asstId, (m) => ({ ...m, text: m.text + t })),
        onToolEvent: (e) => updateAsst(convId, asstId, (m) => ({
          ...m,
          toolEvents: mergeEvent(m.toolEvents, e),
          thinking: upsertThinkingStep(m.thinking || startThinking("Running on OpenClaw…"), {
            id: e.id || window.uid("tool"),
            label: e.label || (e.skill ? `Calling ${e.skill}…` : "Running a Blocks tool…"),
            detail: e.skill || "",
            status: e.status === "done" ? "done" : "running",
          }),
        })),
        onMeta: (meta) => updateAsst(convId, asstId, (m) => ({ ...m, meta: { ...(m.meta || {}), ...meta } })),
        onDone: (meta) => {
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: m.thinking ? finishThinking(m.thinking, "OpenClaw finished") : m.thinking,
            meta: { ...(m.meta || {}), ...meta },
          }));
          finishStream();
        },
        onError: (err) => {
          updateAsst(convId, asstId, (m) => ({
            ...m,
            toolEvents: (m.toolEvents || []).map((e) => (e.status === "running" ? { ...e, status: "done" } : e)),
            thinking: failThinking(m.thinking, "Gateway unavailable", String(err.message || err).replace(/\n/g, " ")),
            text: (m.text || "") + (m.text ? "\n\n" : "") +
              "> ⚠️ **Couldn’t reach the OpenClaw gateway.**\n> " + String(err.message || err).replace(/\n/g, " ") +
              "\n>\n> Check the base URL and token in **Settings**, and make sure the gateway is running.",
          }));
          finishStream();
        },
      };
      streamRef.current = window.streamChat(common);
    }, [updateAsst, finishStream]);

    const handleAssistantConfirm = useCallback((msg, action) => {
      const convId = currentIdRef.current;
      if (!msg || !action || !convId) return;
      const token = action.token;
      if (action.type === "dismiss") {
        updateAsst(convId, msg.id, (m) => ({
          ...m,
          meta: { ...(m.meta || {}), confirmAction: { status: "dismissed", token } },
        }));
        setTimeout(() => persist(convosRef.current), 0);
        return;
      }
      if (!token) return;
      if (busyRef.current) {
        showToast("Let the current assistant run finish first.");
        return;
      }

      busyRef.current = true;
      autoScroll.current = true;
      setStreamingId(msg.id);
      const paId = "pa-confirm-" + msg.id;
      updateAsst(convId, msg.id, (m) => ({
        ...m,
        meta: { ...(m.meta || {}), confirmAction: { status: "pending", token } },
        thinking: upsertThinkingStep(m.thinking || startThinking("Confirming booking…"), {
          id: paId,
          label: "Confirming calendar booking…",
          detail: "Blocks private assistant",
          status: "running",
        }),
        toolEvents: mergeEvent(m.toolEvents, {
          type: "tool", id: paId, skill: "personal-assistant", status: "running",
          label: "Confirming calendar booking…",
        }),
      }));

      let timedOut = false;
      let finished = false;
      let paStream = null;
      const failConfirm = (why) => {
        if (finished) return;
        if (paStream && paStream.cancel) paStream.cancel();
        updateAsst(convId, msg.id, (m) => ({
          ...m,
          toolEvents: (m.toolEvents || []).map((e) => e.id === paId
            ? { ...e, status: "done", label: "Calendar booking failed" } : e),
          thinking: failThinking(m.thinking, "Calendar booking failed", why),
          meta: {
            ...(m.meta || {}),
            confirmAction: { status: "error", token, error: why },
          },
        }));
        showToast(why);
        finishConfirm();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        failConfirm("Private assistant timed out after 150s.");
      }, 150000);
      streamRef.current = {
        cancel: () => {
          if (paStream && paStream.cancel) paStream.cancel();
          failConfirm("Private assistant cancelled.");
        },
      };

      const finishConfirm = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        streamRef.current = null;
        busyRef.current = false;
        setStreamingId(null);
        persist(convosRef.current);
      };

      try {
        paStream = window.streamAssistant(token, settingsRef.current, {
          onStatus: (status) => {
            updateAsst(convId, msg.id, (m) => ({
              ...m,
              thinking: upsertThinkingStep(m.thinking || startThinking("Confirming booking…"), stepFromStatus(status, paId)),
            }));
          },
          onStep: (step) => {
            updateAsst(convId, msg.id, (m) => ({ ...m, ledger: upsertLedgerStep(m.ledger, step) }));
          },
          onFinal: (result) => {
            const failed = result && result.artifact && result.artifact.ok === false;
            updateAsst(convId, msg.id, (m) => ({
              ...m,
              text: result.text || (failed ? "I couldn’t book that calendar event." : "Done. I created the calendar event."),
              ledger: ledgerFromArtifact(m.ledger, result.artifact),
              toolEvents: (m.toolEvents || []).map((e) => e.id === paId
                ? { ...e, status: "done", label: failed ? "Calendar booking failed" : "Calendar booking confirmed" } : e),
              thinking: failed
                ? failThinking(m.thinking, "Calendar booking failed", result.text || "Calendar rejected the write.")
                : finishThinking(m.thinking, "Calendar booking confirmed"),
              meta: {
                ...(m.meta || {}),
                assistantResult: result.artifact,
                statuses: result.statuses,
                latency: result.latencyMs,
                confirmAction: {
                  status: failed ? "error" : "confirmed",
                  token,
                  error: failed ? (result.text || "Calendar rejected the write.") : "",
                },
              },
            }));
            finishConfirm();
          },
          onError: (err) => {
            const why = timedOut
              ? "Private assistant timed out after 150s."
              : String(err.message || err).replace(/\n/g, " ");
            failConfirm(why);
          },
        });
      } catch (err) {
        const why = String(err.message || err);
        failConfirm(why);
      }
    }, [showToast, updateAsst]);

    // UI.6 / UI.10: route a remedy chip back to the parked plan. Confirm and
    // disambiguate carry a resume token; retry/finish re-run the original
    // request (completed steps are skipped via the pending-plan ledger, so
    // it's idempotent). Add-contact / invite-peer persist their side effect in
    // the chip form first, then dispatch a {type:"retry"} here.
    const handleAssistantAction = useCallback((msg, action) => {
      const convId = currentIdRef.current;
      if (!msg || !action || !convId) return;

      if (action.type === "connectGoogle") {
        window.startGoogleConnect(settingsRef.current).catch((err) => showToast(String(err.message || err)));
        return;
      }
      if (busyRef.current) { showToast("Let the current assistant run finish first."); return; }

      let envelope = null;
      if (action.type === "confirm") envelope = { kind: "confirm", token: action.token };
      else if (action.type === "disambiguate") envelope = { kind: "disambiguate", resumeToken: action.resumeToken, peerHandle: action.peerHandle };
      else if (action.type === "prompt") {
        const text = (action.text || "").trim();
        if (!text) { showToast("That action is missing a prompt."); return; }
        envelope = { kind: "retry", text };
      }
      else {
        // retry | finish | repropose → re-run the original request.
        const conv = convosRef.current[convId];
        const idx = conv ? conv.messages.findIndex((m) => m.id === msg.id) : -1;
        const userMsg = conv && idx >= 0 ? [...conv.messages.slice(0, idx)].reverse().find((m) => m.role === "user") : null;
        const text = userMsg ? (userMsg.text || "") : "";
        if (!text.trim()) { showToast("Couldn’t find the original request to retry."); return; }
        envelope = { kind: "retry", text };
      }

      busyRef.current = true;
      autoScroll.current = true;
      setStreamingId(msg.id);
      const actId = "pa-action-" + msg.id;
      updateAsst(convId, msg.id, (m) => ({
        ...m,
        meta: { ...(m.meta || {}), actionState: { status: "pending" } },
        thinking: upsertThinkingStep(m.thinking || startThinking("Resuming your request…"), {
          id: actId, label: "Resuming your request…", detail: "Blocks private assistant", status: "running",
        }),
      }));

      let timedOut = false;
      let finished = false;
      let paStream = null;
      const finishAction = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        streamRef.current = null;
        busyRef.current = false;
        setStreamingId(null);
        persist(convosRef.current);
      };
      const failAction = (why) => {
        if (finished) return;
        if (paStream && paStream.cancel) paStream.cancel();
        updateAsst(convId, msg.id, (m) => ({
          ...m,
          thinking: failThinking(m.thinking, "Couldn’t finish that", why),
          meta: { ...(m.meta || {}), actionState: { status: "error", error: why } },
        }));
        showToast(why);
        finishAction();
      };
      const timeout = setTimeout(() => { timedOut = true; failAction("Private assistant timed out after 150s."); }, 150000);
      streamRef.current = { cancel: () => { if (paStream && paStream.cancel) paStream.cancel(); failAction("Private assistant cancelled."); } };

      try {
        paStream = window.resumeAssistant(envelope, settingsRef.current, {
          onStatus: (status) => updateAsst(convId, msg.id, (m) => ({
            ...m,
            thinking: upsertThinkingStep(m.thinking || startThinking("Resuming your request…"), stepFromStatus(status, actId)),
          })),
          onStep: (step) => updateAsst(convId, msg.id, (m) => ({ ...m, ledger: upsertLedgerStep(m.ledger, step) })),
          onFinal: (result) => {
            const art = result && result.artifact;
            const failed = art && art.ok === false;
            updateAsst(convId, msg.id, (m) => ({
              ...m,
              text: assistantDisplayText(result),
              thinking: failed
                ? failThinking(m.thinking, "Couldn’t finish that", result.text || "")
                : finishThinking(m.thinking, "Done"),
              ledger: ledgerFromArtifact(m.ledger, art),
              meta: {
                ...(m.meta || {}),
                // The resumed turn's artifact drives any further remedies.
                assistantResult: art,
                statuses: result.statuses,
                latency: result.latencyMs,
                // Clear the pending state; new chips (if any) come from the
                // fresh artifact, or none if the plan is now complete.
                actionState: failed ? { status: "error", error: result.text || "That didn’t go through." } : undefined,
              },
            }));
            finishAction();
          },
          onError: (err) => failAction(timedOut ? "Private assistant timed out after 150s." : String(err.message || err).replace(/\n/g, " ")),
        });
      } catch (err) {
        failAction(String(err.message || err));
      }
    }, [showToast, updateAsst]);

    const handleBlocksAgentAction = useCallback((msg, action) => {
      const agent = action && action.agent;
      const handle = blocksAgentHandle(agent);
      if (!msg || !handle) return;
      if (busyRef.current) { showToast("Let the current run finish first."); return; }
      setSelectedBlocksAgent(agent);
      setInject({ focusOnly: true, n: Date.now() });
      showToast(`${blocksAgentLabel(agent)} attached. Type a prompt and send.`);
    }, [showToast]);

    // Same "attach to prompt" flow as the chat catalog cards, reused by the
    // always-on Network agents browse panel (no source message to gate on).
    const handleBrowseAgentUse = useCallback((agent) => {
      const handle = blocksAgentHandle(agent);
      if (!handle) return;
      if (busyRef.current) { showToast("Let the current run finish first."); return; }
      setSelectedBlocksAgent(agent);
      setInject({ focusOnly: true, n: Date.now() });
      showToast(`${blocksAgentLabel(agent)} attached. Type a prompt and send.`);
    }, [showToast]);

    /* ----------------------------- send ------------------------------- */
    const send = useCallback(async ({ text, attachments, targetBlocksAgent }) => {
      if (streamRef.current || busyRef.current) return;
      busyRef.current = true;
      const convId = currentIdRef.current;
      const prev = convosRef.current;
      const existing = prev[convId];
      const base = existing
        ? { ...existing, messages: existing.messages.slice() }
        : { id: convId, title: "", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      if (!base.title) base.title = deriveTitle(text, attachments);

      const atts = attachments || [];
      const forcedBlocksAgent = targetBlocksAgent || null;
      const forcedBlocksHandle = blocksAgentHandle(forcedBlocksAgent);
      if (forcedBlocksHandle) setSelectedBlocksAgent(null);
      const history = base.messages.slice();
      const userMsg = {
        id: window.uid("m"),
        role: "user",
        text,
        attachments: atts,
        ts: Date.now(),
        ...(forcedBlocksHandle ? { meta: { targetBlocksAgent: { handle: forcedBlocksHandle, displayName: blocksAgentLabel(forcedBlocksAgent) } } } : {}),
      };
      const asstId = window.uid("m");
      const asstMsg = { id: asstId, role: "assistant", text: "", toolEvents: [], ts: Date.now() };

      base.messages = [...base.messages, userMsg, asstMsg];
      base.updatedAt = Date.now();
      const next = { ...prev, [convId]: base };
      convosRef.current = next;
      setConversations(next);
      persist(next);
      setStreamingId(asstId);
      autoScroll.current = true;

      // Microphone → prompt: a recorded clip is transcribed through Blocks
      // FIRST, then folded into the user's text so the gateway sees a prompt.
      // Hard-bounded + cancelable so a slow/missing transcriber can NEVER
      // freeze the app: it times out, Stop aborts it, and either way the UI
      // recovers with a visible message.
      const voice = atts.find((a) => a.kind === "audio");
      let finalText = text;
      let routeDecisionText = text;
      if (voice) {
        const s = settingsRef.current;
        const sttId = "stt-" + asstId;
        updateAsst(convId, asstId, (m) => ({
          ...m,
          thinking: upsertThinkingStep(m.thinking || startThinking("Processing your input…"), {
            id: sttId,
            label: "Transcribing your voice clip on Blocks…",
            detail: "speech-to-text",
            status: "running",
          }),
          toolEvents: mergeEvent(m.toolEvents, {
            type: "tool", id: sttId, skill: "speech-to-text", status: "running",
            label: "Transcribing your voice clip on Blocks…",
          }),
        }));

        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
        // Let the composer's Stop button cancel an in-flight transcription.
        streamRef.current = { cancel: () => controller.abort() };

        try {
          const transcript = await window.transcribeAudio(voice, s, controller.signal);
          finalText = audioTranscriptPrompt(text, transcript);
          routeDecisionText = audioTranscriptRoutingText(text, transcript);
          const displayText = audioTranscriptDisplay(text, transcript);
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: upsertThinkingStep(m.thinking, {
              id: sttId,
              label: "Transcribed via Blocks",
              detail: "speech-to-text",
              status: "done",
            }),
            toolEvents: (m.toolEvents || []).map((e) => e.id === sttId
              ? { ...e, status: "done", label: "Transcribed via Blocks" } : e),
          }));
          // reflect the transcript in the user's bubble
          updateMsg(convId, userMsg.id, (m) => ({ ...m, text: displayText }));
        } catch (err) {
          const aborted = err && err.name === "AbortError";
          const why = timedOut
            ? "Transcription timed out after 45s."
            : aborted ? "Transcription cancelled." : String(err.message || err).replace(/\n/g, " ");
          const micInputIssue = /\b(short|silent|no speech|too little|record at least|clear speech)\b/i.test(why);
          const help = micInputIssue
            ? "\n>\n> Check your browser microphone permission/input, then record 5-10 seconds of clear speech before sending."
            : "\n>\n> Make sure a `speech-to-text` agent is serving on Blocks (e.g. `blocks serve openclaw_transcriber`), or type your message instead.";
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: failThinking(m.thinking, timedOut ? "Transcription timed out" : "Transcription failed", why),
            toolEvents: (m.toolEvents || []).map((e) => e.id === sttId
              ? { ...e, status: "done", label: timedOut ? "Transcription timed out" : "Transcription failed" } : e),
            text: (m.text || "") +
              "> ⚠️ **Couldn’t transcribe your voice clip.**\n> " + why +
              help,
          }));
          persist(convosRef.current);
          streamRef.current = null;
          setStreamingId(null);
          busyRef.current = false;
          return;
        } finally {
          clearTimeout(timeout);
          streamRef.current = null;
        }
      }

      // Image → understanding: an uploaded image is sent to the Blocks
      // network FIRST to find a vision model that understands it, then the
      // description is folded into the prompt so the gateway can act on it
      // (the image itself still rides along to the gateway for vision-capable
      // models). Hard-bounded + cancelable like transcription.
      const images = atts.filter((a) => a.kind === "image");
      const si = settingsRef.current;
      if (forcedBlocksHandle) {
        const routeId = "route-selected-" + asstId;
        updateAsst(convId, asstId, (m) => ({
          ...m,
          thinking: upsertThinkingStep(m.thinking || startThinking("Using Blocks agent…"), {
            id: routeId,
            label: `Sending to ${forcedBlocksHandle} on Blocks…`,
            detail: forcedBlocksHandle,
            status: "running",
          }),
          toolEvents: mergeEvent(m.toolEvents, {
            type: "tool", id: routeId, skill: forcedBlocksHandle, status: "running",
            label: `Sending to ${forcedBlocksHandle} on Blocks…`,
          }),
        }));

        const controller = new AbortController();
        let timedOut = false;
        const waitStateTimers = [];
        const setSelectedRouteState = (label, detail) => {
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: upsertThinkingStep(m.thinking || startThinking("Using Blocks agent…"), {
              id: routeId,
              label,
              detail,
              status: "running",
            }),
            toolEvents: (m.toolEvents || []).map((e) => e.id === routeId
              ? { ...e, label, skill: forcedBlocksHandle, status: "running" } : e),
          }));
        };
        waitStateTimers.push(setTimeout(() => {
          setSelectedRouteState(`Still waiting for ${forcedBlocksHandle}…`, "The task was sent to Blocks; this public agent has not returned output yet.");
        }, 8000));
        waitStateTimers.push(setTimeout(() => {
          setSelectedRouteState(`${forcedBlocksHandle} may be inactive…`, "Still no output. I’ll keep waiting, but this usually means the selected Blocks agent is offline or slow.");
        }, 20000));
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 150000);
        streamRef.current = { cancel: () => controller.abort() };

        try {
          const routed = await window.routeIntent(finalText, si, controller.signal, { candidates: [forcedBlocksAgent] });
          if (!routed || !routed.matched || !routed.text) {
            throw new Error((routed && routed.reason) || "That Blocks agent did not return a usable result.");
          }
          const responseHandle = routed.handle || forcedBlocksHandle;
          const cost = routed.meta && routed.meta.costUsd;
          const latency = routed.meta && routed.meta.latencyMs;
          const selectedRoute = {
            handle: responseHandle,
            displayName: routed.displayName || blocksAgentLabel(forcedBlocksAgent),
            tag: routed.tag,
            label: routed.label,
            chosenAgent: routed.chosenAgent || forcedBlocksAgent,
            agents: Array.isArray(routed.agents) ? routed.agents : [],
          };
          updateAsst(convId, asstId, (m) => ({
            ...m,
            text: routedDisplayText(routed),
            thinking: finishThinking(m.thinking, `Answered by ${responseHandle} on Blocks`),
            toolEvents: (m.toolEvents || []).map((e) => e.id === routeId
              ? { ...e, status: "done", skill: responseHandle, label: `Answered by ${responseHandle} on Blocks` } : e),
            meta: {
              ...(m.meta || {}),
              handle: responseHandle,
              routed: selectedRoute,
              lastBlocksRun: selectedRoute,
              ...(cost != null ? { cost } : {}),
              ...(latency != null ? { latency } : {}),
            },
          }));
          clearTimeout(timeout);
          busyRef.current = false;
          finishStream();
          return;
        } catch (err) {
          const why = timedOut
            ? "Blocks agent timed out after 150s."
            : String(err.message || err).replace(/\n/g, " ");
          const inactive = timedOut || selectedAgentInactiveReason(why);
          const failureTitle = inactive ? "Blocks agent inactive" : "Blocks agent failed";
          const failureCopy = inactive
            ? `> ⚠️ **${forcedBlocksHandle} looks inactive or too slow.**\n> The selected Blocks agent accepted the task, but it did not return an output in time.\n>\n> ${why}`
            : `> ⚠️ **Couldn’t use ${forcedBlocksHandle} on Blocks.**\n> ${why}`;
          updateAsst(convId, asstId, (m) => ({
            ...m,
            toolEvents: (m.toolEvents || []).map((e) => e.id === routeId
              ? { ...e, status: "done", label: failureTitle } : e),
            thinking: failThinking(m.thinking, failureTitle, why),
            text: (m.text || "") + failureCopy,
          }));
          persist(convosRef.current);
          streamRef.current = null;
          setStreamingId(null);
          busyRef.current = false;
          return;
        } finally {
          waitStateTimers.forEach((timer) => clearTimeout(timer));
          clearTimeout(timeout);
          streamRef.current = null;
        }
      }
      // Phase 2: the private assistant reasons over the user's actual words
      // (post-transcription). An attached image's description rides to the
      // assistant as STRUCTURED context (imageDescriptions) instead of being
      // concatenated into this text, so the planner never re-classifies a
      // smashed-together prompt. finalText keeps the folded copy for the
      // non-assistant gateway path below.
      const assistantText = finalText;
      let imageDescriptions = [];
      let imageDescriptionBlock = "";
      if (images.length) {
        const visId = "vis-" + asstId;
        updateAsst(convId, asstId, (m) => ({
          ...m,
          thinking: upsertThinkingStep(m.thinking || startThinking("Processing your input…"), {
            id: visId,
            label: images.length > 1 ? `Understanding ${images.length} images on Blocks…` : "Understanding your image on Blocks…",
            detail: "image-to-text",
            status: "running",
          }),
          toolEvents: mergeEvent(m.toolEvents, {
            type: "tool", id: visId, skill: "image-to-text", status: "running",
            label: images.length > 1
              ? `Understanding ${images.length} images on Blocks…`
              : "Understanding your image on Blocks…",
          }),
        }));

        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
        streamRef.current = { cancel: () => controller.abort() };

        try {
          const descriptions = [];
          for (const img of images) {
            descriptions.push(await window.describeImage(img, finalText, si, controller.signal));
          }
          imageDescriptionBlock = descriptions
            .map((d, i) => (images.length > 1 ? `Image ${i + 1}: ${d}` : d))
            .join("\n\n");
          imageDescriptions = descriptions.slice();
          finalText = [finalText, "Image understanding from Blocks:\n" + imageDescriptionBlock]
            .filter((t) => t && t.trim()).join("\n\n");
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: upsertThinkingStep(m.thinking, {
              id: visId,
              label: images.length > 1 ? "Images understood via Blocks" : "Image understood via Blocks",
              detail: "image-to-text",
              status: "done",
            }),
            toolEvents: (m.toolEvents || []).map((e) => e.id === visId
              ? { ...e, status: "done", label: images.length > 1 ? "Images understood via Blocks" : "Image understood via Blocks" } : e),
          }));
        } catch (err) {
          const aborted = err && err.name === "AbortError";
          const why = timedOut
            ? "Image understanding timed out after 60s."
            : aborted ? "Image understanding cancelled." : String(err.message || err).replace(/\n/g, " ");
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: failThinking(m.thinking, timedOut ? "Image understanding timed out" : "Image understanding failed", why),
            toolEvents: (m.toolEvents || []).map((e) => e.id === visId
              ? { ...e, status: "done", label: timedOut ? "Image understanding timed out" : "Image understanding failed" } : e),
            text: (m.text || "") +
              "> ⚠️ **Couldn’t understand your image on Blocks.**\n> " + why +
              "\n>\n> Make sure an `image-to-text` agent is serving on Blocks (e.g. `blocks serve openclaw_image_describer`), or remove the image.",
          }));
          persist(convosRef.current);
          streamRef.current = null;
          setStreamingId(null);
          busyRef.current = false;
          return;
        } finally {
          clearTimeout(timeout);
          streamRef.current = null;
        }

        if (isImageDescribeOnlyRequest(routeDecisionText)) {
          updateAsst(convId, asstId, (m) => ({
            ...m,
            text: imageDescriptionBlock,
            thinking: finishThinking(m.thinking, images.length > 1 ? "Images understood via Blocks" : "Image understood via Blocks"),
            meta: { ...(m.meta || {}), imageDescriptions },
          }));
          persist(convosRef.current);
          busyRef.current = false;
          finishStream();
          return;
        }
      }

      if (wantsSkillFile(routeDecisionText)) {
        const skillId = "skill-file-" + asstId;
        updateAsst(convId, asstId, (m) => ({
          ...m,
          thinking: upsertThinkingStep(m.thinking || startThinking("Creating skill file…"), {
            id: skillId,
            label: "Creating SKILL.md file…",
            detail: "skill-file",
            status: "running",
          }),
          toolEvents: mergeEvent(m.toolEvents, {
            type: "tool", id: skillId, skill: "skill-file", status: "running",
            label: "Creating SKILL.md file…",
          }),
        }));

        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
        streamRef.current = { cancel: () => controller.abort() };

        try {
          const result = await window.createSkillFile(routeDecisionText, si, controller.signal);
          updateAsst(convId, asstId, (m) => ({
            ...m,
            text: skillFileDisplay(result),
            thinking: finishThinking(m.thinking, "Created SKILL.md file"),
            toolEvents: (m.toolEvents || []).map((e) => e.id === skillId
              ? { ...e, status: "done", label: "Created SKILL.md file" } : e),
            meta: { ...(m.meta || {}), skillFile: result },
          }));
          clearTimeout(timeout);
          busyRef.current = false;
          finishStream();
          return;
        } catch (err) {
          const why = timedOut
            ? "Skill file creation timed out after 30s."
            : String(err.message || err).replace(/\n/g, " ");
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: failThinking(m.thinking, timedOut ? "Skill file timed out" : "Skill file failed", why),
            toolEvents: (m.toolEvents || []).map((e) => e.id === skillId
              ? { ...e, status: "done", label: timedOut ? "Skill file timed out" : "Skill file failed" } : e),
            text: (m.text || "") + "> ⚠️ **Couldn’t create the skill file.**\n> " + why,
          }));
          persist(convosRef.current);
          streamRef.current = null;
          setStreamingId(null);
          busyRef.current = false;
          return;
        } finally {
          clearTimeout(timeout);
          streamRef.current = null;
        }
      }

      // Text → image: an image-CREATION turn (no attached image) is hired
      // straight from a Blocks text-to-image agent FIRST — the deterministic
      // sibling of the image-understanding step above — so "generate a logo" /
      // "draw a picture" reliably reaches Blocks instead of the gateway's own
      // model. On success the rendered picture IS the answer, so we
      // short-circuit. On no-agent/failure we degrade gracefully to the
      // gateway (never fabricate an image). Hard-bounded + cancelable.
      let imageGenFellBack = false;
      if (!images.length && window.createsImage(routeDecisionText)) {
        const genId = "gen-" + asstId;
        const genStrategy = (si && si.imageStrategy) || "single";
        const genLabel = genStrategy === "race" ? "Racing image agents on Blocks…"
          : genStrategy === "compare" ? "Comparing image agents on Blocks…"
          : genStrategy === "best" ? "Picking the best image on Blocks…"
          : "Creating your image on Blocks…";
        updateAsst(convId, asstId, (m) => ({
          ...m,
          thinking: upsertThinkingStep(m.thinking || startThinking("Creating your image…"), {
            id: genId,
            label: genLabel,
            detail: "text-to-image",
            status: "running",
          }),
          toolEvents: mergeEvent(m.toolEvents, {
            type: "tool", id: genId, skill: "text-to-image", status: "running",
            label: genLabel,
          }),
        }));

        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 150000);
        streamRef.current = { cancel: () => controller.abort() };

        try {
          const gen = await window.generateImage(routeDecisionText, si, controller.signal);
          if (gen && gen.matched !== false && gen.text) {
            const cost = gen.meta && gen.meta.costUsd;
            const latency = gen.meta && gen.meta.latencyMs;
            const nAgents = (gen.results && gen.results.length) || 1;
            const madeBy = nAgents > 1
              ? `${gen.strategy === "compare" ? "Compared" : gen.strategy === "best" ? "Best of" : "Fastest of"} ${nAgents} agents on Blocks`
              : `Created by ${gen.handle} on Blocks`;
            updateAsst(convId, asstId, (m) => ({
              ...m,
              text: gen.text,
              thinking: finishThinking(m.thinking, madeBy),
              toolEvents: (m.toolEvents || []).map((e) => e.id === genId
                ? { ...e, status: "done", skill: gen.handle, label: madeBy } : e),
              meta: {
                ...(m.meta || {}),
                handle: gen.handle,
                generatedImage: gen.media,
                billingMode: gen.billingMode,
                ...(cost != null ? { cost } : {}),
                ...(latency != null ? { latency } : {}),
              },
            }));
            clearTimeout(timeout);
            busyRef.current = false;
            finishStream();
            return;
          }
          // No text-to-image agent available (or a paid-only, consent-gated
          // catalog) — drop the tentative step and let the gateway try.
          imageGenFellBack = true;
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: m.thinking ? {
              ...m.thinking,
              steps: (m.thinking.steps || []).filter((s) => s.id !== genId),
            } : m.thinking,
            toolEvents: (m.toolEvents || []).filter((e) => e.id !== genId),
          }));
        } catch (err) {
          // Honest failure → fall back to the gateway rather than fabricating.
          imageGenFellBack = true;
          const why = timedOut
            ? "Image generation timed out after 150s."
            : String(err.message || err).replace(/\n/g, " ");
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: upsertThinkingStep(m.thinking, {
              id: genId,
              label: "No Blocks image agent — using the gateway",
              detail: why,
              status: "done",
            }),
            toolEvents: (m.toolEvents || []).map((e) => e.id === genId
              ? { ...e, status: "done", label: "No Blocks image agent — using the gateway" } : e),
          }));
        } finally {
          clearTimeout(timeout);
          streamRef.current = null;
        }
      }

      // Phase 3: ONE authoritative gate decides the path for this turn. An
      // attached image is always an assistant turn (Phase 2 made the PA own
      // image understanding); for everything else we ask the bridge
      // (/api/classify, the single source of truth in src/routing/turn-router.ts),
      // which transparently falls back to a local heuristic if unreachable.
      // The client no longer owns this classification. When the deterministic
      // image-generation hook above already handled (and fell back from) an
      // image-creation turn, go straight to the gateway — don't re-route it to
      // the assistant path where it would try a second time.
      const routeCandidates = wantsRandomBlocksFollowup(routeDecisionText) ? lastBlocksCandidates(history) : [];
      const routeText = routeCandidates.length
        ? `Use a random Blocks agent from the previous catalog results. ${routeDecisionText}`
        : routeDecisionText;
      const turnRoute = imageDescriptions.length
        ? "assistant"
        : imageGenFellBack
          ? "gateway"
          : await window.classifyTurn(routeText, si);

      // Personal-assistant demo path: calendar/Gmail/poster/A2A prompts
      // should hit the owner-scoped PA runtime directly. The generic gateway
      // may choose browser tooling for calendar asks, which is not the
      // per-owner OAuth route we need to demonstrate here.
      if (turnRoute === "assistant") {
        const paId = "pa-" + asstId;
        updateAsst(convId, asstId, (m) => ({
          ...m,
          thinking: upsertThinkingStep(m.thinking || startThinking("Running your private assistant…"), {
            id: paId,
            label: "Running your private assistant…",
            detail: "Blocks private assistant",
            status: "running",
          }),
          toolEvents: mergeEvent(m.toolEvents, {
            type: "tool", id: paId, skill: "personal-assistant", status: "running",
            label: "Running your private assistant…",
          }),
        }));

        let timedOut = false;
        let paStream = null;
        let cancelPa = null;
        const timeout = setTimeout(() => {
          timedOut = true;
          if (cancelPa) cancelPa();
        }, 150000);

        try {
          const result = await new Promise((resolve, reject) => {
            try {
              cancelPa = () => {
                if (paStream && paStream.cancel) paStream.cancel();
                reject(new Error(timedOut ? "Private assistant timed out after 150s." : "Private assistant cancelled."));
              };
              paStream = window.streamAssistant(assistantText, si, {
                onStatus: (status) => {
                  updateAsst(convId, asstId, (m) => ({
                    ...m,
                    thinking: upsertThinkingStep(m.thinking || startThinking("Running your private assistant…"), stepFromStatus(status)),
                  }));
                },
                onStep: (step) => {
                  updateAsst(convId, asstId, (m) => ({ ...m, ledger: upsertLedgerStep(m.ledger, step) }));
                },
                onFinal: resolve,
                onError: reject,
              }, imageDescriptions.map((d) => ({ kind: "image", description: d })));
              streamRef.current = { cancel: cancelPa };
            } catch (err) {
              reject(err);
            }
          });
          updateAsst(convId, asstId, (m) => ({
            ...m,
            text: assistantDisplayText(result),
            toolEvents: (m.toolEvents || []).map((e) => e.id === paId
              ? { ...e, status: "done", label: "Answered by your private assistant" } : e),
            thinking: finishThinking(m.thinking, "Answered by your private assistant"),
            ledger: ledgerFromArtifact(m.ledger, result.artifact),
            meta: { ...(m.meta || {}), assistant: result.artifact, statuses: result.statuses, latency: result.latencyMs },
          }));
          clearTimeout(timeout);
          busyRef.current = false;
          finishStream();
          return;
        } catch (err) {
          const why = timedOut
            ? "Private assistant timed out after 150s."
            : String(err.message || err).replace(/\n/g, " ");
          updateAsst(convId, asstId, (m) => ({
            ...m,
            toolEvents: (m.toolEvents || []).map((e) => e.id === paId
              ? { ...e, status: "done", label: timedOut ? "Private assistant timed out" : "Private assistant failed" } : e),
            thinking: failThinking(m.thinking, timedOut ? "Private assistant timed out" : "Private assistant failed", why),
            text: (m.text || "") +
              "> ⚠️ **Couldn’t run your private assistant.**\n> " + why,
          }));
          persist(convosRef.current);
          streamRef.current = null;
          setStreamingId(null);
          busyRef.current = false;
          return;
        } finally {
          clearTimeout(timeout);
          streamRef.current = null;
        }
      }

      // Intent routing → Blocks specialist. Some asks map cleanly onto a
      // network agent (e.g. a LinkedIn tone/voice analyzer). Rather than hope
      // the gateway chooses to delegate, we deterministically discover + call
      // the specialist via the bridge. For "answer" intents the agent's output
      // IS the reply, so we short-circuit the gateway entirely; otherwise we
      // fold the result in as context. Gated client-side so the step never
      // flashes on ordinary chats.
      if (turnRoute === "specialist") {
        const routeId = "route-" + asstId;
        updateAsst(convId, asstId, (m) => ({
          ...m,
          thinking: upsertThinkingStep(m.thinking || startThinking("Finding a specialist…"), {
            id: routeId,
            label: "Finding a specialist on Blocks…",
            detail: "blocks.route",
            status: "running",
          }),
          toolEvents: mergeEvent(m.toolEvents, {
            type: "tool", id: routeId, skill: "blocks.route", status: "running",
            label: "Finding a specialist on Blocks…",
          }),
        }));

        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 150000);
        streamRef.current = { cancel: () => controller.abort() };

        try {
          const routed = await window.routeIntent(routeText, si, controller.signal, { candidates: routeCandidates });
          if (routed && routed.matched && routed.text) {
            updateAsst(convId, asstId, (m) => ({
              ...m,
              thinking: upsertThinkingStep(m.thinking, {
                id: routeId,
                label: `Answered by ${routed.handle} on Blocks`,
                detail: routed.handle,
                status: "done",
              }),
              toolEvents: (m.toolEvents || []).map((e) => e.id === routeId
                ? { ...e, status: "done", skill: routed.handle, label: `Answered by ${routed.handle} on Blocks` } : e),
            }));
            if (routed.mode === "answer") {
              const cost = routed.meta && routed.meta.costUsd;
              const latency = routed.meta && routed.meta.latencyMs;
              const displayText = routedDisplayText(routed);
              updateAsst(convId, asstId, (m) => ({
                ...m,
                text: (m.text || "") + displayText,
                thinking: finishThinking(m.thinking, `Answered by ${routed.handle} on Blocks`),
                meta: {
                  ...(m.meta || {}),
                  handle: routed.handle,
                  routed: {
                    handle: routed.handle,
                    displayName: routed.displayName,
                    tag: routed.tag,
                    label: routed.label,
                    chosenAgent: routed.chosenAgent,
                    agents: Array.isArray(routed.agents) ? routed.agents : [],
                  },
                  ...(cost != null ? { cost } : {}),
                  ...(latency != null ? { latency } : {}),
                },
              }));
              clearTimeout(timeout);
              busyRef.current = false;
              finishStream();
              return;
            }
            finalText = [finalText, `Specialist (${routed.handle}) on Blocks returned:\n` + routed.text]
              .filter((t) => t && t.trim()).join("\n\n");
          } else {
            // No specialist matched/served — drop the tentative step and let
            // the gateway handle the turn as usual.
            updateAsst(convId, asstId, (m) => ({
              ...m,
              thinking: m.thinking ? {
                ...m.thinking,
                steps: (m.thinking.steps || []).filter((s) => s.id !== routeId),
              } : m.thinking,
              toolEvents: (m.toolEvents || []).filter((e) => e.id !== routeId),
            }));
          }
        } catch (err) {
          // Routing failed — degrade gracefully to the gateway rather than
          // failing the whole turn.
          updateAsst(convId, asstId, (m) => ({
            ...m,
            thinking: failThinking(m.thinking, timedOut ? "Specialist timed out" : "Specialist unavailable", String(err.message || err).replace(/\n/g, " ")),
            toolEvents: (m.toolEvents || []).map((e) => e.id === routeId
              ? { ...e, status: "done", label: timedOut ? "Specialist timed out" : "Specialist unavailable" } : e),
          }));
        } finally {
          clearTimeout(timeout);
          streamRef.current = null;
        }
      }

      const finalUserMsg = { ...userMsg, text: finalText };
      busyRef.current = false;
      updateAsst(convId, asstId, (m) => ({
        ...m,
        thinking: upsertThinkingStep(m.thinking || startThinking("Sending to OpenClaw…"), {
          id: "gateway-" + asstId,
          label: "Sending prompt to OpenClaw gateway…",
          detail: "gateway stream",
          status: "running",
        }),
      }));
      startStream(convId, asstId, window.toApiMessages([...history, finalUserMsg]));
    }, [startStream, updateAsst, updateMsg]);

    /* --------------------------- session ops -------------------------- */
    const closeActiveRun = useCallback((label = "Cancelled") => {
      if (streamRef.current && streamRef.current.cancel) streamRef.current.cancel();
      const cid = currentIdRef.current, sid = streamingId;
      if (sid) updateAsst(cid, sid, (m) => ({
        ...m,
        toolEvents: (m.toolEvents || []).map((e) => e.status === "running" ? { ...e, status: "done", label } : e),
        thinking: m.thinking ? finishThinking(m.thinking, label) : m.thinking,
      }));
      finishStream();
    }, [streamingId, updateAsst, finishStream]);

    const stop = useCallback(() => {
      closeActiveRun("Cancelled");
    }, [closeActiveRun]);

    const newChat = useCallback(() => {
      closeActiveRun("Cancelled");
      // reuse current empty conversation if it has no messages
      const cur = convosRef.current[currentIdRef.current];
      if (!cur || !cur.messages || cur.messages.length === 0) { setOpenMobile(false); return; }
      setCurrentId(window.uid("conv"));
      setOpenMobile(false);
      autoScroll.current = true;
    }, [closeActiveRun]);

    const selectChat = useCallback((id) => {
      if (id === currentIdRef.current) { setOpenMobile(false); return; }
      closeActiveRun("Cancelled");
      setCurrentId(id); setOpenMobile(false); autoScroll.current = true;
    }, [closeActiveRun]);

    const deleteChat = useCallback((id) => {
      if (id === currentIdRef.current) closeActiveRun("Cancelled");
      setConversations((prev) => {
        const next = { ...prev }; delete next[id];
        convosRef.current = next; persist(next);
        return next;
      });
      if (id === currentIdRef.current) { setCurrentId(window.uid("conv")); setStreamingId(null); streamRef.current = null; }
    }, [closeActiveRun]);

    const resetLocalSession = useCallback(() => {
      if (!window.confirm("Start a fresh local UI session? This clears saved chats in this browser, but keeps your bridge URL, owner ID, profile, Google connection, and server-side assistant state.")) return;
      closeActiveRun("Cancelled");
      window.clearLocalSession();
      const nextId = window.uid("conv");
      convosRef.current = {};
      setConversations({});
      setCurrentId(nextId);
      currentIdRef.current = nextId;
      setStreamingId(null);
      streamRef.current = null;
      autoScroll.current = true;
      showToast("Fresh local session ready.");
    }, [closeActiveRun, showToast]);

    const saveSettingsFn = useCallback((s) => {
      setSettings(s); settingsRef.current = s; window.saveSettings(s); setShowSettings(false);
    }, []);

    const toggleTheme = useCallback(() => {
      setSettings((prev) => { const s = { ...prev, theme: prev.theme === "dark" ? "light" : "dark" }; window.saveSettings(s); return s; });
    }, []);

    const connectGoogle = useCallback(async () => {
      try {
        await window.startGoogleConnect(settingsRef.current);
      } catch (err) {
        showToast(String(err.message || err));
      }
    }, [showToast]);

    const pickSuggestion = (p) => setInject({ text: p, n: Date.now() });

    const appClass = "app" + (sidebarCollapsed ? " sidebar-collapsed" : "") + (sidebarOpenMobile ? " sidebar-open" : "");

    return (
      <div className={appClass}>
        <Sidebar
          conversations={conversations} currentId={currentId}
          onSelect={selectChat} onNew={newChat} onDelete={deleteChat}
          onOpenSettings={() => setShowSettings(true)}
          theme={settings.theme} onToggleTheme={toggleTheme}
        />
        <div className="scrim" onClick={() => setOpenMobile(false)}></div>

        <div className="main">
          <div className="topbar">
            <button className="icon-btn" title="Toggle sidebar"
              onClick={() => { if (window.matchMedia("(max-width: 820px)").matches) setOpenMobile((o) => !o); else setCollapsed((c) => !c); }}>
              <Icons.Sidebar s={18} />
            </button>
            <div className="topbar-title">{conv && conv.title ? conv.title : "New chat"}</div>
            <div className="topbar-spacer"></div>
            <div className="conn-bar">
              {(settings.ownerId || "").trim() ? (
                <button className="assistant-chip" title={"Owner ID: " + settings.ownerId} onClick={() => setShowSettings(true)}>
                  <span className={"health-dot " + (googleStatus.loading ? "checking" : googleStatus.error ? "down" : "ok")}
                    title={googleStatus.loading ? "Checking bridge…" : googleStatus.error ? ("Bridge issue: " + googleStatus.error) : "Bridge reachable"} />
                  <span className="assistant-chip-copy">
                    <b>{(selfAssistant && selfAssistant.agentName) || "Assistant"}</b>
                    <small>{(selfAssistant && selfAssistant.owner) || "Private assistant"}</small>
                  </span>
                </button>
              ) : (
                <button className="assistant-chip warn" title="Set your Owner ID in Settings" onClick={() => setShowSettings(true)}>
                  <span className="health-dot down" /> Set Owner ID
                </button>
              )}
              <button
                className={"google-connect-btn" + (googleStatus.connected ? " connected" : "")}
                onClick={connectGoogle}
                title={googleStatus.error || (googleStatus.connected ? "Google Calendar and Gmail are connected" : "Connect Google Calendar and Gmail")}
              >
                {googleStatus.connected ? <Icons.Check s={14} /> : <Icons.Plus s={14} />}
                {googleStatus.loading ? "Google…" : googleStatus.connected ? "Google connected" : "Connect Google"}
              </button>
              <span className="conn-status live" title={bridgeBase || "Foundation bridge on this page origin"}>
                <span className="conn-dot"></span>{bridgeLabel}
              </span>
            </div>
          </div>

          <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
            <div className="thread-inner">
              <AssistantOverviewPanel settings={settings} />
              <MeetingRequestsPanel settings={settings} />
              <NetworkAgentsPanel
                settings={settings}
                selectedAgent={selectedBlocksAgent}
                onUseAgent={handleBrowseAgentUse}
                disabled={!!streamingId}
              />
              {messages.length === 0 ? (
                <EmptyState onPick={pickSuggestion} />
              ) : (
                messages.map((m) => (
                  <Message
                    key={m.id}
                    msg={m}
                    streaming={m.id === streamingId}
                    onAssistantConfirm={handleAssistantConfirm}
                    onAssistantAction={handleAssistantAction}
                    onBlocksAgentAction={handleBlocksAgentAction}
                    selectedBlocksAgent={selectedBlocksAgent}
                    googleConnected={googleStatus.connected}
                    settings={settings}
                    selfAssistant={selfAssistant}
                  />
                ))
              )}
            </div>
          </div>

          <window.Composer
            onSend={send}
            streaming={!!streamingId}
            onStop={stop}
            inject={inject}
            selectedAgent={selectedBlocksAgent}
            onClearSelectedAgent={() => setSelectedBlocksAgent(null)}
          />
        </div>

        {showSettings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSave={saveSettingsFn} onResetLocalSession={resetLocalSession} />}
        <Lightbox />
        <Toast text={toast} />
      </div>
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
})();
