/* ===========================================================================
   components.jsx — presentational pieces: icons, sidebar, message list,
   tool-activity line, settings modal, lightbox, toast. Exposed on window.
   =========================================================================== */
(function () {
  const { useState, useEffect, useRef, useCallback } = React;

  /* ----------------------------- icons ------------------------------ */
  const I = (p) => <svg width={p.s || 18} height={p.s || 18} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={p.w || 2} strokeLinecap="round" strokeLinejoin="round">{p.children}</svg>;
  const Icons = {
    Plus: (p) => <I {...p}><path d="M12 5v14M5 12h14" /></I>,
    Menu: (p) => <I {...p}><path d="M3 6h18M3 12h18M3 18h18" /></I>,
    Send: (p) => <I {...p}><path d="M12 19V5M5 12l7-7 7 7" /></I>,
    Stop: (p) => <I {...p}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></I>,
    Image: (p) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.6" /><path d="M21 15l-5-5L5 21" /></I>,
    Mic: (p) => <I {...p}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></I>,
    Sliders: (p) => <I {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M2 14h4M10 8h4M18 16h4" /></I>,
    Settings: (p) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></I>,
    Sun: (p) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>,
    Moon: (p) => <I {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></I>,
    Trash: (p) => <I {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></I>,
    Copy: (p) => <I {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></I>,
    Check: (p) => <I {...p}><path d="M20 6L9 17l-5-5" /></I>,
    Close: (p) => <I {...p}><path d="M18 6L6 18M6 6l12 12" /></I>,
    Chevron: (p) => <I {...p}><path d="M9 18l6-6-6-6" /></I>,
    ChevronLeft: (p) => <I {...p}><path d="M15 18l-6-6 6-6" /></I>,
    ChevronRight: (p) => <I {...p}><path d="M9 18l6-6-6-6" /></I>,
    Search: (p) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></I>,
    Refresh: (p) => <I {...p}><path d="M21 12a9 9 0 0 1-15.5 6.2M3 12A9 9 0 0 1 18.5 5.8" /><path d="M21 4v5h-5M3 20v-5h5" /></I>,
    Sidebar: (p) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></I>,
  };

  /* ----------------------------- Sidebar ---------------------------- */
  function Sidebar({ conversations, currentId, onSelect, onNew, onDelete, onOpenSettings, theme, onToggleTheme }) {
    const list = Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true"></div>
            <div className="brand-name">OpenClaw<small>multimodal gateway</small></div>
          </div>
          <button className="new-chat-btn" onClick={onNew}>
            <Icons.Plus s={17} /> New chat
          </button>
        </div>
        <div className="conv-list">
          {list.length === 0 ? (
            <div className="conv-section-label">No conversations yet</div>
          ) : (
            <React.Fragment>
              <div className="conv-section-label">Recent</div>
              {list.map((c) => (
                <div key={c.id} className={"conv-item" + (c.id === currentId ? " active" : "")} onClick={() => onSelect(c.id)}>
                  <span className="conv-title">{c.title || "New chat"}</span>
                  <button className="conv-del" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}>
                    <Icons.Trash s={14} />
                  </button>
                </div>
              ))}
            </React.Fragment>
          )}
        </div>
        <div className="sidebar-footer">
          <button className="ghost-btn ghost-btn-label" onClick={onOpenSettings}><Icons.Settings s={16} /> Settings</button>
          <button className="ghost-btn ghost-btn-icon" title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={onToggleTheme}>
            {theme === "dark" ? <Icons.Sun s={16} /> : <Icons.Moon s={16} />}
          </button>
        </div>
      </aside>
    );
  }

  /* ------------------------- Tool activity -------------------------- */
  function ToolActivity({ events, active }) {
    const [open, setOpen] = useState(false);
    if (!events || !events.length) return null;
    const visibleEvents = dedupe(events).map((e) => (!active && e.status === "running" ? { ...e, status: "done" } : e));
    const running = !!active && visibleEvents.some((e) => e.status === "running");
    const lastRunning = [...visibleEvents].reverse().find((e) => e.status === "running");
    const headline = running
      ? (lastRunning ? lastRunning.label : "Working…")
      : `Used ${countSkills(events)}`;
    return (
      <div className={"tool-activity" + (open ? " open" : "")}>
        <div className="tool-head" onClick={() => setOpen((o) => !o)}>
          {running ? <span className="spinner" /> : <span className="done-check"><Icons.Check s={14} /></span>}
          <span>{headline}</span>
          <span className="tool-caret"><Icons.Chevron s={15} /></span>
        </div>
        <div className="tool-body">
          {visibleEvents.map((e) => (
            <div key={e.id + e.status} className={"tool-step" + (e.status === "running" ? " running" : "")}>
              <div style={{ flex: 1 }}>
                <div>{e.label}</div>
                {e.skill ? <div className="step-skill">{e.skill}</div> : null}
              </div>
              {e.status === "running" ? <span className="spinner" /> : <span style={{ color: "var(--good)" }}><Icons.Check s={13} /></span>}
            </div>
          ))}
        </div>
      </div>
    );
  }
  function dedupe(events) {
    // collapse running→done on same id, keep latest state, preserve order
    const map = new Map();
    for (const e of events) map.set(e.id, e);
    return Array.from(map.values());
  }
  function countSkills(events) {
    const skills = new Set(dedupe(events).map((e) => e.skill).filter(Boolean));
    const n = skills.size;
    if (n === 0) return "1 agent";
    if (n === 1) return [...skills][0].split(".")[0] + " agent";
    return n + " agents on Blocks.ai";
  }

  // UI.7: a structured per-step plan ledger. Each entry is a runtime step
  // (id / kind / status / reply) streamed via the `step` SSE event or read
  // off the final multi-step artifact — not parsed from prose.
  const STEP_KIND_LABEL = {
    "call-specialist": "Hire a specialist",
    "search-blocks-catalog": "Search the Blocks catalog",
    "use-integration": "Use an integration",
    "call-peer": "Ask a peer assistant",
    "answer-direct": "Answer directly",
  };
  const STEP_STATUS = {
    running: { cls: "running", text: "running" },
    satisfied: { cls: "done", text: "done" },
    "soft-miss": { cls: "miss", text: "no match" },
    "needs-input": { cls: "paused", text: "needs you" },
    "hard-fail": { cls: "failed", text: "failed" },
    skipped: { cls: "skipped", text: "skipped" },
  };
  function stepKindLabel(kind) { return STEP_KIND_LABEL[kind] || kind || "Step"; }
  function stepStatusInfo(status) { return STEP_STATUS[status] || { cls: "done", text: status || "done" }; }

  function StepLedger({ ledger, streaming }) {
    if (!ledger || !ledger.length) return null;
    const rows = ledger.map((s) => (!streaming && s.status === "running" ? { ...s, status: "satisfied" } : s));
    return (
      <div className="step-ledger">
        {rows.map((s, i) => {
          const info = stepStatusInfo(s.status);
          return (
            <div key={s.id || i} className={"ledger-step " + info.cls}>
              <span className="ledger-mark">
                {s.status === "running" ? <span className="spinner" /> : info.cls === "failed" ? <Icons.Close s={12} /> : <Icons.Check s={12} />}
              </span>
              <div className="ledger-copy">
                <div className="ledger-kind">{(i + 1) + ". " + stepKindLabel(s.kind)}<span className={"ledger-badge " + info.cls}>{info.text}</span></div>
                {s.reply ? <small>{s.reply}</small> : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function ThinkingTabs({ thinking, ledger, streaming }) {
    const hasLedger = !!(ledger && ledger.length);
    const [tab, setTab] = useState(hasLedger ? "plan" : "steps");
    if (!thinking && !hasLedger) return null;
    const t = thinking || { status: "done", steps: [], errors: [] };
    const steps = (t.steps || []).map((s) => (!streaming && s.status === "running" ? { ...s, status: "done" } : s));
    const errors = t.errors || [];
    const running = !!streaming && t.status === "running";
    const activeStep = [...steps].reverse().find((s) => s.status === "running") || steps[steps.length - 1];
    const visibleStatus = !streaming && t.status === "running" ? "done" : (t.status || "done");
    const headline = t.label || (running
      ? (activeStep ? activeStep.label : "Thinking…")
      : errors.length ? "Finished with issues" : "Finished");

    return (
      <div className={"thinking-tabs " + (running ? "running" : visibleStatus)}>
        <div className="thinking-head">
          <div className="thinking-title">
            {running ? <span className="spinner" /> : errors.length ? <span className="error-dot" /> : <span className="done-check"><Icons.Check s={13} /></span>}
            <span>{headline}</span>
          </div>
          <div className="thinking-tabbar">
            {hasLedger ? <button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>Plan</button> : null}
            <button className={tab === "steps" ? "active" : ""} onClick={() => setTab("steps")}>Thinking</button>
            <button className={tab === "errors" ? "active" : ""} onClick={() => setTab("errors")} disabled={!errors.length}>
              Errors{errors.length ? ` ${errors.length}` : ""}
            </button>
          </div>
        </div>
        {tab === "plan" ? (
          <div className="thinking-body">
            <StepLedger ledger={ledger} streaming={streaming} />
          </div>
        ) : tab === "steps" ? (
          <div className="thinking-body">
            {steps.length ? steps.map((s) => (
              <div key={s.id} className={"thinking-step " + (s.status || "done")}>
                <span className="thinking-step-mark">{s.status === "running" ? <span className="spinner" /> : <Icons.Check s={12} />}</span>
                <div>
                  <div>{s.label}</div>
                  {s.detail ? <small>{s.detail}</small> : null}
                </div>
              </div>
            )) : (
              <div className="thinking-empty">{running ? "Waiting for the first Blocks status…" : "No processing steps recorded."}</div>
            )}
          </div>
        ) : (
          <div className="thinking-body">
            {errors.length ? errors.map((e) => (
              <div key={e.id} className="thinking-error">
                <b>{e.title || "Error"}</b>
                <span>{e.message}</span>
                {e.remedy ? <span className="thinking-error-remedy">{e.remedy}</span> : null}
              </div>
            )) : <div className="thinking-empty">No errors for this run.</div>}
          </div>
        )}
      </div>
    );
  }

  /* ----------------------------- Message ---------------------------- */
  function Message({ msg, streaming, onCopy, onAssistantConfirm, onAssistantAction, onBlocksAgentAction, selectedBlocksAgent, googleConnected, settings, selfAssistant }) {
    const isUser = msg.role === "user";
    const [copied, setCopied] = useState(false);
    const imgs = (msg.attachments || []).filter((a) => a.kind === "image");
    const auds = (msg.attachments || []).filter((a) => a.kind === "audio");
    const latestArtifact = !isUser && msg.meta && (msg.meta.assistantResult || msg.meta.assistant);
    const routed = !isUser && msg.meta && msg.meta.routed;
    const catalogAgents = routed && routed.handle === "blocks-catalog" && Array.isArray(routed.agents)
      ? routed.agents
      : [];
    const selectedBlocksHandle = selectedBlocksAgent && (selectedBlocksAgent.handle || selectedBlocksAgent.agentName);
    const confirmState = !isUser && msg.meta && msg.meta.confirmAction;
    // The artifact that drives remedy chips: the PA turn result, or the
    // result of a confirm/resume round-trip when one has run.
    const chipArtifact = latestArtifact;
    const actionState = !isUser && msg.meta && msg.meta.actionState;
    const copy = () => {
      navigator.clipboard && navigator.clipboard.writeText(msg.text || "");
      setCopied(true); setTimeout(() => setCopied(false), 1400);
      onCopy && onCopy();
    };
    return (
      <div className={"msg-row " + (isUser ? "user" : "assistant") + (streaming ? " streaming" : "")}>
        <div className={"avatar " + (isUser ? "user" : "assistant")} aria-hidden="true">{isUser ? "You" : ""}</div>
        <div className="msg-col">
          {imgs.length > 0 && (
            <div className="msg-images">
              {imgs.map((a) => <img key={a.id} className="msg-thumb" src={a.url} alt={a.name}
                onClick={() => window.dispatchEvent(new CustomEvent("openclaw:lightbox", { detail: { src: a.url } }))} />)}
            </div>
          )}
          {auds.map((a) => (
            <div key={a.id} className="msg-audio-chip">
              <Icons.Mic s={15} /> Voice message
              <audio controls src={a.url} style={{ height: 30, maxWidth: 220 }}></audio>
            </div>
          ))}

          {!isUser && msg.toolEvents && msg.toolEvents.length > 0 && (
            <ToolActivity events={msg.toolEvents} active={streaming} />
          )}
          {!isUser && (msg.thinking || (msg.ledger && msg.ledger.length)) && (
            <ThinkingTabs thinking={msg.thinking} ledger={msg.ledger} streaming={streaming} />
          )}

          {isUser ? (
            msg.text ? <div className="bubble">{msg.text}</div> : null
          ) : (
            <div className="assistant-content">
              {msg.text
                ? <window.MarkdownRenderer text={msg.text} streaming={streaming} />
                : (streaming && (!msg.toolEvents || !msg.toolEvents.length)
                    ? <span className="typing"><span></span><span></span><span></span></span>
                    : null)}
              {/* Trailing dots mean "more text is streaming in token-by-token"
                  — true ONLY for the gateway's raw token stream. PA / confirm /
                  route flows set their text in one shot and already show a
                  spinner in the Thinking panel and the confirm chip, so the
                  dots there are just a third redundant "loading" indicator. */}
              {streaming && msg.text && (!msg.toolEvents || !msg.toolEvents.length)
                ? <span className="typing" style={{ marginLeft: 4 }}><span></span><span></span><span></span></span>
                : null}
            </div>
          )}

          {!isUser && catalogAgents.length > 0 ? (
            <CatalogAgentCards
              agents={catalogAgents}
              disabled={streaming}
              selectedHandle={selectedBlocksHandle}
              onUse={(agent) => onBlocksAgentAction && onBlocksAgentAction(msg, { type: "useBlocksAgent", agent })}
            />
          ) : null}

          {!isUser && latestArtifact && latestArtifact.confirmToken && latestArtifact.proposal ? (
            <AssistantConfirmCard
              artifact={latestArtifact}
              state={confirmState}
              disabled={streaming}
              onAction={(action) => onAssistantConfirm && onAssistantConfirm(msg, action)}
            />
          ) : null}

          {!isUser && chipArtifact && !(chipArtifact.confirmToken && chipArtifact.proposal) ? (
            <ActionChips
              artifact={chipArtifact}
              googleConnected={googleConnected}
              disabled={streaming}
              state={actionState}
              settings={settings}
              selfAssistant={selfAssistant}
              onAction={(action) => onAssistantAction && onAssistantAction(msg, action)}
            />
          ) : null}

          <div className="msg-footer">
            <span className="timestamp">{window.fmtTime(msg.ts)}</span>
            {!isUser && msg.meta && msg.meta.latency != null && (
              <span className="chip" title="Round-trip latency">{window.fmtDuration(msg.meta.latency)}</span>
            )}
            {!isUser && msg.meta && msg.meta.cost != null && (
              <span className="chip" title="Estimated cost">${Number(msg.meta.cost).toFixed(4)}</span>
            )}
            {!isUser && msg.meta && msg.meta.usage && msg.meta.usage.total_tokens != null && (
              <span className="chip" title="Tokens">{msg.meta.usage.total_tokens} tok</span>
            )}
            {!isUser && msg.text && !streaming && (
              <button className="mini-btn" onClick={copy}>
                {copied ? <Icons.Check s={13} /> : <Icons.Copy s={13} />} {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  function CatalogAgentCards({ agents, disabled, selectedHandle, onUse }) {
    const visible = agents.slice(0, 8);
    if (!visible.length) return null;
    return (
      <div className="catalog-agent-panel">
        <div className="catalog-agent-head">
          <b>Blocks agents</b>
          <span>{agents.length} result{agents.length === 1 ? "" : "s"} · status checked on send</span>
        </div>
        <CatalogAgentGrid agents={visible} disabled={disabled} selectedHandle={selectedHandle} onUse={onUse} />
        {agents.length > visible.length ? <div className="catalog-agent-more">Showing {visible.length} of {agents.length}. Narrow the prompt to filter more.</div> : null}
      </div>
    );
  }

  // The reusable grid of "Use this agent" cards, shared by the chat-triggered
  // CatalogAgentCards (≤8) and the always-on NetworkAgentsPanel (paged). One
  // card renderer = one place the price/billing, tags, reason, and select flow
  // live.
  function CatalogAgentGrid({ agents, disabled, selectedHandle, onUse }) {
    return (
      <div className="catalog-agent-grid">
        {agents.map((agent) => {
          const handle = agent.handle || agent.agentName;
          const selected = selectedHandle && handle === selectedHandle;
          const paid = isPaidAgent(agent);
          return (
            <div className={"catalog-agent-card" + (selected ? " selected" : "")} key={handle || agent.displayName || agent.name}>
              <div className="catalog-agent-top">
                <div className="catalog-agent-name">
                  <b>{agent.displayName || agent.handle || "Blocks agent"}</b>
                  {agent.handle && agent.displayName !== agent.handle ? <small>{agent.handle}</small> : null}
                </div>
                <span className={"catalog-price" + (paid ? " paid" : "")} title={paid ? "Paid agent — you are billed per call" : "Free agent"}>{formatAgentPrice(agent)}</span>
              </div>
              <div className="catalog-agent-tags">
                {(Array.isArray(agent.tags) ? agent.tags : []).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
              {agent.description ? <p>{shortDescription(agent.description)}</p> : null}
              {agent.whyMatched ? <small className="catalog-agent-reason">{agent.whyMatched}</small> : null}
              <small className="catalog-agent-availability">Public listing · availability checked when used</small>
              <button className={"catalog-use-btn" + (selected ? " selected" : "")} disabled={disabled} onClick={() => onUse && onUse(agent)}>
                {selected ? <Icons.Check s={14} /> : <Icons.Send s={14} />} {selected ? "Attached to prompt" : "Use this agent"}
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  function isPaidAgent(agent) {
    if (!agent) return false;
    if (agent.billingMode) return agent.billingMode === "paid";
    return Number(agent.price && agent.price.amount) > 0;
  }

  function formatAgentPrice(agent) {
    const price = agent && agent.price && agent.price.amount;
    const n = Number(price);
    if (!Number.isFinite(n) || n === 0) return "Free";
    return "$" + n.toFixed(3);
  }

  function shortDescription(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > 150 ? text.slice(0, 147) + "..." : text;
  }

  // Always-on, lazy-loaded panel that browses the FULL public Blocks registry
  // (not just the ≤8 chat-triggered cards). It is deliberately collapsed until
  // opened so the dashboard doesn't walk the registry on every load; opening it
  // pulls page 1 via the browse route (full walk + 60s cache). Search is
  // debounced and server-side, paging is server-side (50/page), and the scope
  // line is honest about truncation, scan size, and that a listing ≠ liveness.
  function NetworkAgentsPanel({ settings, selectedAgent, onUseAgent, disabled }) {
    const PAGE = 50;
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [offset, setOffset] = useState(0);
    const [refreshTick, setRefreshTick] = useState(0);
    const [state, setState] = useState({ loading: false, data: null, error: "" });
    // One-shot: only the explicit "re-scan" button forces refresh=1; ordinary
    // paging/searching rides the 60s cache so we don't re-walk the registry.
    const refreshOnceRef = useRef(false);

    // Debounce the search box → q, snapping back to the first page on a new query.
    useEffect(() => {
      const id = setTimeout(() => {
        setDebounced((prev) => {
          const next = query.trim();
          if (next !== prev) setOffset(0);
          return next;
        });
      }, 300);
      return () => clearTimeout(id);
    }, [query]);

    // Lazy: no registry walk happens until the panel is opened.
    useEffect(() => {
      if (!open) return;
      const controller = new AbortController();
      const forceRefresh = refreshOnceRef.current;
      refreshOnceRef.current = false;
      setState((prev) => ({ ...prev, loading: true, error: "" }));
      window.browseNetworkAgents(
        settings,
        { offset, limit: PAGE, q: debounced, refresh: forceRefresh },
        controller.signal,
      )
        .then((data) => setState({ loading: false, data, error: "" }))
        .catch((err) => {
          if (err && err.name === "AbortError") return;
          setState({ loading: false, data: null, error: String(err.message || err) });
        });
      return () => controller.abort();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, offset, debounced, refreshTick, settings.baseUrl]);

    const data = state.data;
    const agents = data && Array.isArray(data.agents) ? data.agents : [];
    const matched = data ? Number(data.matched) || 0 : 0;
    const selectedHandle = selectedAgent && (selectedAgent.handle || selectedAgent.agentName);
    const from = matched === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE, matched);
    const hasPrev = offset > 0;
    const hasNext = offset + PAGE < matched;

    return (
      <section className="overview-panel network-panel" aria-label="Network agents">
        <div className="overview-head">
          <div>
            <div className="overview-title">Network agents</div>
            <div className="overview-sub">{networkScopeLine(open, state, data)}</div>
          </div>
          <div className="network-head-actions">
            {open ? (
              <button className="icon-btn" title="Re-scan the registry" onClick={() => { refreshOnceRef.current = true; setRefreshTick((t) => t + 1); }} disabled={state.loading}>
                <Icons.Refresh s={16} />
              </button>
            ) : null}
            <button className="network-toggle-btn" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Browse all"}
            </button>
          </div>
        </div>

        {open ? (
          <div className="network-body">
            <div className="network-search">
              <Icons.Search s={15} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the whole network — name, tag, capability…"
                aria-label="Search network agents"
              />
              {query ? (
                <button className="network-search-clear" title="Clear search" onClick={() => setQuery("")}>
                  <Icons.Close s={13} />
                </button>
              ) : null}
            </div>

            {state.error ? (
              <div className="overview-empty">{state.error}</div>
            ) : agents.length ? (
              <React.Fragment>
                <div className="network-result-line">
                  Showing {from}–{to} of {matched}{matched === 1 ? " agent" : " agents"}
                  {debounced ? ` for “${debounced}”` : ""} · availability checked when used
                </div>
                <CatalogAgentGrid
                  agents={agents}
                  disabled={disabled}
                  selectedHandle={selectedHandle}
                  onUse={(agent) => onUseAgent && onUseAgent(agent)}
                />
                {data && data.truncated ? (
                  <div className="network-truncated">
                    Showing the first {data.scanned}{data.totalCount ? ` of ${data.totalCount}` : ""} agents — the registry is larger than the scan limit, so refine your search to reach the rest.
                  </div>
                ) : null}
                <div className="network-pager">
                  <button className="network-page-btn" disabled={!hasPrev || state.loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    <Icons.ChevronLeft s={15} /> Prev
                  </button>
                  <span className="network-page-info">Page {Math.floor(offset / PAGE) + 1}</span>
                  <button className="network-page-btn" disabled={!hasNext || state.loading} onClick={() => setOffset(offset + PAGE)}>
                    Next <Icons.ChevronRight s={15} />
                  </button>
                </div>
              </React.Fragment>
            ) : (
              <div className="overview-empty">
                {state.loading ? "Scanning the network…" : debounced ? `No agents match “${debounced}”.` : "No agents are listed right now."}
              </div>
            )}
          </div>
        ) : null}
      </section>
    );
  }

  function networkScopeLine(open, state, data) {
    if (!open) return "Browse every public agent on the Blocks network";
    if (state.loading && !data) return "Scanning the registry…";
    if (state.error) return "Network unavailable";
    if (!data) return "Browse every public agent on the Blocks network";
    const total = data.totalCount != null ? data.totalCount : data.scanned;
    if (data.truncated) {
      return `Scanned ${data.scanned}${data.totalCount ? " of " + data.totalCount : ""} agents (registry is larger — refine to see more)`;
    }
    return `${total} public agent${total === 1 ? "" : "s"} · free & paid · listing ≠ liveness`;
  }

  function AssistantConfirmCard({ artifact, state, disabled, onAction }) {
    const status = state && state.status;
    const proposal = artifact.proposal || {};
    const args = proposal.args || {};
    const detail = bookingDetail(args);
    const pending = status === "pending";
    const confirmed = status === "confirmed";
    const dismissed = status === "dismissed";
    const error = status === "error";
    if (dismissed) {
      return (
        <div className="confirm-pop dismissed">
          <div className="confirm-pop-icon"><Icons.Close s={15} /></div>
          <div className="confirm-pop-copy">
            <b>Confirmation dismissed</b>
            <span>No calendar event was booked.</span>
          </div>
        </div>
      );
    }
    return (
      <div className={"confirm-pop " + (pending ? "pending" : confirmed ? "confirmed" : error ? "error" : "ready")}>
        <div className="confirm-pop-main">
          <div className="confirm-pop-icon">
            {pending ? <span className="spinner" /> : confirmed ? <Icons.Check s={16} /> : error ? <Icons.Close s={16} /> : <Icons.Check s={16} />}
          </div>
          <div className="confirm-pop-copy">
            <b>{confirmed ? "Calendar event booked" : error ? "Calendar did not book it" : "Confirm calendar booking"}</b>
            <span>{error ? (state.error || "The Calendar integration rejected the write.") : detail}</span>
          </div>
        </div>
        {!confirmed ? (
          <div className="confirm-pop-actions">
            <button
              className="confirm-action confirm"
              title={error ? "Try confirming again" : "Confirm booking"}
              disabled={disabled || pending}
              onClick={() => onAction && onAction({ type: "confirm", token: artifact.confirmToken })}
            >
              {pending ? <span className="spinner" /> : <Icons.Check s={20} />}
            </button>
            <button
              className="confirm-action dismiss"
              title="Dismiss"
              disabled={disabled || pending}
              onClick={() => onAction && onAction({ type: "dismiss", token: artifact.confirmToken })}
            >
              <Icons.Close s={20} />
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  function bookingDetail(args) {
    const summary = typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "Meeting";
    const start = formatBookingDateTime(args.start);
    const end = formatBookingEnd(args.start, args.end);
    if (start && end) return `${summary} · ${start} to ${end}`;
    if (start) return `${summary} · ${start}`;
    return summary;
  }

  function formatBookingDateTime(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function formatBookingEnd(startValue, endValue) {
    if (typeof endValue !== "string" || !endValue.trim()) return "";
    const end = new Date(endValue);
    if (Number.isNaN(end.getTime())) return endValue;
    const start = typeof startValue === "string" ? new Date(startValue) : null;
    const sameDay = start && !Number.isNaN(start.getTime()) && start.toDateString() === end.toDateString();
    return end.toLocaleString([], sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  /* --------------------------- Action chips ------------------------- */
  // UI.6 / UI.8: read the assistant artifact's MACHINE signals (never prose)
  // and turn each dead-end into a clickable remedy that resumes the exact
  // parked step (UI.10 resume contract). Returns [{ id, label, kind, action }].
  function assistantRemedies(artifact, ctx) {
    if (!artifact || typeof artifact !== "object") return [];
    const c = ctx || {};
    const chips = [];
    const error = typeof artifact.error === "string" ? artifact.error : "";
    const resume = artifact.resume && typeof artifact.resume === "object" ? artifact.resume : null;
    const note = typeof artifact.note === "string" ? artifact.note : "";
    const reply = typeof artifact.reply === "string" ? artifact.reply : "";

    // Disambiguation (peer pick) is exclusive — one chip per candidate.
    if (resume && resume.reason === "disambiguation" && Array.isArray(resume.candidates) && resume.candidates.length) {
      for (const cand of resume.candidates) {
        const handle = cand.agentName || cand.handle;
        if (!handle) continue;
        const label = cand.ownerName || cand.displayName || handle;
        chips.push({
          id: "disambig-" + handle,
          label,
          kind: "disambiguate",
          action: { type: "disambiguate", resumeToken: resume.token, peerHandle: handle },
        });
      }
      if (chips.length) return chips;
    }

    // A parked write awaiting confirmation inside a multi-step plan.
    if (resume && resume.reason === "confirm" && resume.token) {
      chips.push({ id: "confirm", label: "Confirm", kind: "confirm", primary: true, action: { type: "confirm", token: resume.token } });
    }

    // Mutual availability found → offer the next natural write step, still
    // routed through the assistant's normal confirm-before-write booking gate.
    const suggestedBooking = artifact.suggestedBooking && typeof artifact.suggestedBooking === "object" ? artifact.suggestedBooking : null;
    if (suggestedBooking && suggestedBooking.prompt) {
      const label = suggestedBooking.slotLabel ? "Book suggested time" : "Book meeting";
      chips.push({ id: "book-suggested", label, kind: "prompt", primary: true, action: { type: "prompt", text: suggestedBooking.prompt } });
    }

    // Named peer not invited → Invite peer (carries the personRef).
    const invite = artifact.invite && typeof artifact.invite === "object" ? artifact.invite : null;
    if (invite || /not an invited peer/i.test(note)) {
      const personRef = (invite && invite.personRef) || artifact.personRef || "";
      chips.push({ id: "invite", label: "Invite peer", kind: "invitePeer", action: { type: "invitePeer", personRef } });
    }

    // Recipient not in contacts → prefer the self-describing path ("Invite on
    // Blocks") so the contact materializes itself, with the manual "Add
    // contact" form kept as the non-Blocks fallback (Workstream I.5).
    if (artifact.needsContact && artifact.needsContact.name) {
      const missName = artifact.needsContact.name;
      chips.push({ id: "invite-blocks", label: "Invite on Blocks", kind: "invitePeer", action: { type: "invitePeer", personRef: missName } });
      chips.push({ id: "add-contact", label: "Add contact", kind: "addContact", action: { type: "addContact", name: missName } });
    }

    // Google not connected. Prefer the machine signal the runtime now emits
    // for a disconnected owner (needsConnection); fall back to pairing the
    // live integration status with the friendly copy for older turns.
    const needsConnection = artifact.needsConnection && typeof artifact.needsConnection === "object" ? artifact.needsConnection : null;
    if ((needsConnection && needsConnection.provider === "google")
      || (c.googleConnected === false && /connect (your )?google|connect your google account/i.test(reply))) {
      chips.push({ id: "connect-google", label: "Connect Google", kind: "connectGoogle", action: { type: "connectGoogle" } });
    }

    // Expired confirm token → re-propose.
    if (error === "unknown-confirm-token") {
      chips.push({ id: "repropose", label: "Re-propose", kind: "retry", action: { type: "retry" } });
    }
    // Integration write rejected / specialist hiccup / bridge → retry.
    if (error === "integration-write-failed" || error === "specialist-failed") {
      chips.push({ id: "retry", label: "Retry", kind: "retry", action: { type: "retry" } });
    }

    // A multi-step plan that stopped short (and isn't already parked on a
    // confirm/disambiguation) → offer to finish the dropped step.
    if (artifact.multiStep && artifact.partial && !resume && error !== "integration-write-failed") {
      chips.push({ id: "finish", label: "Finish step", kind: "retry", action: { type: "finish" } });
    }

    return chips;
  }

  function ActionChips({ artifact, googleConnected, disabled, state, settings, selfAssistant, onAction }) {
    const [open, setOpen] = useState("");
    const chips = assistantRemedies(artifact, { googleConnected });
    if (!chips.length) return null;
    const status = state && state.status;
    const resolved = status === "resolved";

    if (resolved) {
      return (
        <div className="action-chips done">
          <span className="chip-done"><Icons.Check s={13} /> {(state && state.label) || "Done"}</span>
        </div>
      );
    }

    return (
      <div className="action-chips">
        <div className="chip-row">
          {chips.map((chip) => (
            <button
              key={chip.id}
              className={"action-chip" + (chip.primary ? " primary" : "") + (open === chip.id ? " active" : "")}
              disabled={disabled || status === "pending"}
              onClick={() => {
                if (chip.kind === "addContact" || chip.kind === "invitePeer") {
                  setOpen((o) => (o === chip.id ? "" : chip.id));
                } else {
                  onAction && onAction(chip.action);
                }
              }}
            >
              {status === "pending" ? <span className="spinner" /> : null}
              {chip.label}
            </button>
          ))}
        </div>
        {open === "add-contact" ? (
          <AddContactForm
            name={((chips.find((c) => c.id === "add-contact") || {}).action || {}).name}
            settings={settings}
            disabled={disabled}
            onCancel={() => setOpen("")}
            onSaved={() => { setOpen(""); onAction && onAction({ type: "retry" }); }}
          />
        ) : null}
        {open === "invite" || open === "invite-blocks" ? (
          <InvitePeerChipForm
            personRef={((chips.find((c) => c.id === open) || {}).action || {}).personRef}
            settings={settings}
            assistant={selfAssistant}
            disabled={disabled}
            onCancel={() => setOpen("")}
            onInvited={() => { setOpen(""); onAction && onAction({ type: "retry" }); }}
          />
        ) : null}
        {status === "error" && state.error ? <div className="chip-err">{state.error}</div> : null}
      </div>
    );
  }

  // Inline Add-contact remedy (UI.3): resolve "Dana" → address, then re-run
  // the parked email step. Pre-fills the unresolved name from needsContact.
  function AddContactForm({ name, settings, disabled, onCancel, onSaved }) {
    const [form, setForm] = useState({ name: name || "", email: "", aliases: "" });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
    const submit = async () => {
      const cn = (form.name || "").trim();
      const ce = (form.email || "").trim();
      if (!cn || !ce) { setErr("A contact needs both a name and an email."); return; }
      setBusy(true); setErr("");
      try {
        await window.saveContact(settings, {
          name: cn,
          email: ce,
          aliases: (form.aliases || "").split(",").map((a) => a.trim()).filter(Boolean),
        });
        onSaved && onSaved();
      } catch (e) { setErr(String(e.message || e)); }
      finally { setBusy(false); }
    };
    return (
      <div className="chip-form">
        <input placeholder="Name" value={form.name} onChange={(e) => set("name", e.target.value)} disabled={busy} />
        <input placeholder="email@example.com" value={form.email} onChange={(e) => set("email", e.target.value)} disabled={busy} />
        <input placeholder="aliases (comma-separated)" value={form.aliases} onChange={(e) => set("aliases", e.target.value)} disabled={busy} />
        {err ? <div className="chip-err">{err}</div> : null}
        <div className="chip-form-actions">
          <button className="mini-btn" onClick={submit} disabled={busy || disabled}>{busy ? "Saving…" : "Save & send"}</button>
          <button className="mini-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    );
  }

  // Inline Invite-peer remedy (UI.4): exchange a small identity card so the
  // named person resolves to a peer, then re-run the parked call-peer step.
  function InvitePeerChipForm({ personRef, settings, assistant, disabled, onCancel, onInvited }) {
    const [form, setForm] = useState({ peerAgentName: "", peerOwnerName: personRef || "", peerEmail: "", peerCapabilities: "" });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
    const submit = async () => {
      const handle = (form.peerAgentName || "").trim();
      if (!handle) { setErr("A peer handle (e.g. pa_kayley) is required."); return; }
      const selfHandle = assistant && assistant.agentName;
      if (!selfHandle) { setErr("Open the roster panel above to invite — your assistant handle isn't loaded here yet."); return; }
      setBusy(true); setErr("");
      try {
        await window.invitePeer(settings, {
          owner: assistant.owner,
          agentName: selfHandle,
          peerAgentName: handle,
          peerOwnerName: (form.peerOwnerName || "").trim(),
          peerEmail: (form.peerEmail || "").trim(),
          peerCapabilities: (form.peerCapabilities || "").split(",").map((s) => s.trim()).filter(Boolean),
        });
        onInvited && onInvited();
      } catch (e) { setErr(String(e.message || e)); }
      finally { setBusy(false); }
    };
    return (
      <div className="chip-form">
        <input placeholder="Peer handle (pa_kayley)" value={form.peerAgentName} onChange={(e) => set("peerAgentName", e.target.value)} disabled={busy} />
        <input placeholder="Person name (Kayley Chen)" value={form.peerOwnerName} onChange={(e) => set("peerOwnerName", e.target.value)} disabled={busy} />
        <input placeholder="Their email (so 'email Kayley' works)" value={form.peerEmail} onChange={(e) => set("peerEmail", e.target.value)} disabled={busy} />
        <input placeholder="Capabilities (free-busy, book)" value={form.peerCapabilities} onChange={(e) => set("peerCapabilities", e.target.value)} disabled={busy} />
        {err ? <div className="chip-err">{err}</div> : null}
        <div className="chip-form-actions">
          <button className="mini-btn" onClick={submit} disabled={busy || disabled}>{busy ? "Inviting…" : "Invite & retry"}</button>
          <button className="mini-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    );
  }

  /* --------------------------- Empty state -------------------------- */
  function EmptyState({ onPick }) {
    const suggestions = [
      { t: "Check my availability", s: "calendar via Blocks", p: "Am I free Thursday afternoon?" },
      { t: "Draft an email", s: "Gmail via Blocks", p: "Draft an email to my team about Friday's demo." },
      { t: "Summarize a link", s: "hire a specialist", p: "Summarize https://example.com in three bullets." },
      { t: "Describe an image", s: "attach one below", p: "What's in this image? Suggest a caption." },
    ];
    return (
      <div className="empty-state">
        <div className="empty-mark" aria-hidden="true"></div>
        <h2>What can I get made for you?</h2>
        <p>I’m OpenClaw. Ask me anything — and when a task needs a specialist, I’ll hire one on the Blocks.ai network and bring the result back inline.</p>
        <div className="suggestions">
          {suggestions.map((s, i) => (
            <button key={i} className="suggestion" onClick={() => onPick(s.p)}>
              <b>{s.t}</b><span>{s.s}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* --------------------- Assistant overview panel -------------------- */
  function AssistantOverviewPanel({ settings }) {
    const [state, setState] = useState({ loading: true, data: null, error: "" });
    const [liveness, setLiveness] = useState({});
    const refresh = useCallback(() => {
      const controller = new AbortController();
      setState((prev) => ({ ...prev, loading: true, error: "" }));
      window.assistantOverview(settings, controller.signal)
        .then((data) => setState({ loading: false, data, error: "" }))
        .catch((err) => setState({ loading: false, data: null, error: String(err.message || err) }));
      return () => controller.abort();
    }, [settings.baseUrl]);

    useEffect(() => refresh(), [refresh]);

    const assistants = state.data && Array.isArray(state.data.assistants)
      ? state.data.assistants.filter((assistant) => String(assistant.agentName || "").startsWith("pa_"))
      : [];
    const assistant = assistants[0] || null;
    const peers = assistant && Array.isArray(assistant.peers) ? assistant.peers : rosterPrivatePeers(assistants);
    const peerHandles = peers.slice(0, 8).map((peer) => peer.agentName).filter(Boolean);
    const peerHandlesKey = peerHandles.join(",");
    const integrations = (assistant && assistant.integrations) || {};
    const googleReady = connected(integrations.calendar) || connected(integrations.gmail) || connected(integrations.google);
    const subtitle = state.loading && !state.data
      ? "Checking demo setup..."
      : state.error
        ? "Assistant status unavailable"
        : demoOverviewSubtitle(assistant, googleReady, peers, liveness);

    useEffect(() => {
      if (!peerHandles.length) return;
      let cancelled = false;
      const controller = new AbortController();
      setLiveness((prev) => {
        const next = { ...prev };
        peerHandles.forEach((handle) => { next[handle] = { status: "checking", reason: "" }; });
        return next;
      });
      peerHandles.forEach((handle) => {
        window.peerStatus(handle, settings, controller.signal)
          .then((result) => {
            if (!cancelled) setLiveness((prev) => ({ ...prev, [handle]: result }));
          })
          .catch(() => { /* AbortError on unmount - ignore */ });
      });
      return () => { cancelled = true; controller.abort(); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peerHandlesKey, settings.baseUrl]);

    return (
      <section className="overview-panel" aria-label="Assistant overview">
        <div className="overview-head">
          <div>
            <div className="overview-title">Personal assistant</div>
            <div className="overview-sub">{subtitle}</div>
          </div>
          <button className="icon-btn" title="Refresh overview" onClick={refresh} disabled={state.loading}>
            <Icons.Refresh s={16} />
          </button>
        </div>
        {state.error ? (
          <div className="overview-empty">{state.error}</div>
        ) : (
          assistant ? (
            <DemoAssistantSummary
              assistant={assistant}
              peers={peers}
              integrations={integrations}
              liveness={liveness}
            />
          ) : <div className="overview-empty">{state.loading ? "Loading assistant..." : "No personal assistant found."}</div>
        )}
      </section>
    );
  }

  function demoOverviewSubtitle(assistant, googleReady, peers, liveness) {
    if (!assistant) return "No hosted personal assistant found.";
    const parts = [];
    parts.push(assistant.live ? "Live on Blocks" : "Offline");
    parts.push(googleReady ? "Google connected" : "Google not connected");
    if (peers.length) parts.push(peerSummaryText(peers, liveness));
    return parts.join(" · ");
  }

  function DemoAssistantSummary({ assistant, peers, integrations, liveness }) {
    const hops = Array.isArray(assistant.hops) ? assistant.hops.slice(0, 2) : [];
    const googleReady = connected(integrations.calendar) || connected(integrations.gmail) || connected(integrations.google);
    const calendarReady = connected(integrations.calendar) || connected(integrations.google);
    const gmailReady = connected(integrations.gmail) || connected(integrations.google);
    const visiblePeers = peers.slice(0, 6);
    const hiddenPeerCount = Math.max(0, peers.length - visiblePeers.length);
    return (
      <div className="demo-overview-body">
        <div className="demo-assistant-line">
          <div className="demo-assistant-name">
            <span className={"demo-live-dot " + (assistant.live ? "on" : "off")} aria-hidden="true"></span>
            <div>
              <b>{assistant.owner ? assistant.owner + "'s assistant" : "Private assistant"}</b>
              <span>{assistant.agentName || "personal assistant"}</span>
            </div>
          </div>
          <span className={"live-pill" + (assistant.live ? " on" : "")}>{assistant.live ? "Live" : "Offline"}</span>
        </div>

        <div className="demo-status-row">
          <DemoStatusItem
            label="Google"
            value={googleReady ? "Connected" : "Not connected"}
            detail={[
              calendarReady ? "Calendar" : "",
              gmailReady ? "Gmail" : "",
            ].filter(Boolean).join(" + ") || "Connect in the header"
            }
            tone={googleReady ? "good" : "warn"}
          />
          <DemoStatusItem
            label={peers.length === 1 ? "Private peer" : "Private peers"}
            value={peerSummaryValue(peers)}
            detail={peerSummaryDetail(peers, liveness)}
            tone={peerSummaryTone(peers, liveness)}
          />
          <DemoStatusItem
            label="Coordination"
            value={peers.length ? "Ready" : "Waiting"}
            detail={peers.length ? `${peers.length} peer${peers.length === 1 ? "" : "s"} rostered` : "No peer rostered"}
            tone={peers.length ? "good" : "warn"}
          />
        </div>

        {peers.length ? (
          <div className="demo-peer-strip" aria-label="Available private peers">
            <span className="demo-strip-label">Can coordinate with</span>
            <div className="demo-peer-list">
              {visiblePeers.map((peer) => {
                const live = liveness[peer.agentName] || { status: "checking", reason: "" };
                const dotTitle = (PEER_DOT_TITLE[live.status] || "") + (live.reason ? `\n\n${live.reason}` : "");
                return (
                  <span className="demo-peer-token" key={peer.agentName} title={peer.agentName}>
                    <span className={"peer-dot " + live.status} title={dotTitle} aria-label={`liveness: ${live.status}`} />
                    <b>{peerDisplayName(peer)}</b>
                    <small>{peer.agentName}</small>
                  </span>
                );
              })}
              {hiddenPeerCount ? <span className="demo-peer-token more">+{hiddenPeerCount} more</span> : null}
            </div>
          </div>
        ) : null}

        {hops.length ? (
          <div className="demo-hop-strip" aria-label="Recent handoffs">
            <span className="demo-strip-label">Recent handoffs</span>
            {hops.map((hop) => (
              <span key={`${hop.at}-${hop.direction}-${hop.from}-${hop.to}`}>{handoffSummary(hop)}</span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function DemoStatusItem({ label, value, detail, tone }) {
    return (
      <div className={"demo-status-item " + (tone || "")}>
        <span>{label}</span>
        <b>{value}</b>
        <small>{detail}</small>
      </div>
    );
  }

  function peerDisplayName(peer) {
    return (peer && (peer.ownerName || peer.displayName || peer.owner || peer.agentName)) || "Private peer";
  }

  function peerSummaryValue(peers) {
    if (!peers.length) return "None yet";
    if (peers.length === 1) return peerDisplayName(peers[0]);
    return `${peers.length} connected`;
  }

  function peerSummaryText(peers, liveness) {
    if (!peers.length) return "";
    if (peers.length === 1) {
      const peer = peers[0];
      const live = liveness[peer.agentName] || { status: "checking" };
      return `${peerDisplayName(peer)} ${peerStatusWord(live.status)}`;
    }
    const available = availablePeerCount(peers, liveness);
    if (available === peers.length) return `${peers.length} private peers available`;
    if (available > 0) return `${available}/${peers.length} private peers available`;
    return `${peers.length} private peers rostered`;
  }

  function peerSummaryDetail(peers, liveness) {
    if (!peers.length) return "Add a peer for coordination";
    if (peers.length === 1) {
      const live = liveness[peers[0].agentName] || { status: "checking" };
      return peerStatusWord(live.status);
    }
    const names = peers.slice(0, 2).map(peerDisplayName).join(", ");
    const more = peers.length > 2 ? ` +${peers.length - 2}` : "";
    return `${names}${more} · ${peerAvailabilitySummary(peers, liveness)}`;
  }

  function peerSummaryTone(peers, liveness) {
    if (!peers.length) return "warn";
    const statuses = peers.map((peer) => (liveness[peer.agentName] || {}).status).filter(Boolean);
    if (statuses.length && statuses.every((status) => status === "offline")) return "warn";
    if (statuses.some((status) => status === "online") || peers.length) return "good";
    return "neutral";
  }

  function availablePeerCount(peers, liveness) {
    return peers.filter((peer) => (liveness[peer.agentName] || {}).status === "online").length;
  }

  function peerAvailabilitySummary(peers, liveness) {
    const available = availablePeerCount(peers, liveness);
    if (available === peers.length) return "all available";
    if (available > 0) return `${available}/${peers.length} available`;
    return "rostered";
  }

  function peerStatusWord(status) {
    if (status === "online") return "available";
    if (status === "offline") return "offline";
    return "rostered";
  }

  function peerStatusTone(status) {
    if (status === "offline") return "warn";
    if (status === "unknown") return "neutral";
    return "good";
  }

  function handoffSummary(hop) {
    const peer = hop.direction === "out" ? hop.to : hop.from;
    const verb = hop.direction === "out" ? "Sent to" : "Received from";
    return `${verb} ${peer || "peer"}${hop.outcome ? " · " + hop.outcome : ""}`;
  }

  // The pill reflects the Blocks *directory listing*, NOT per-agent liveness:
  // the registry only tells us an agent is invited/registered, never whether
  // it's currently serving. Labelling that "online" wrongly implies the peer
  // is reachable — so we say "listed" and spell out the distinction on hover.
  const PRIVATE_STATUS_LABEL = {
    online: "listed",
    offline: "offline",
    unauthenticated: "no key",
    unavailable: "unavailable",
  };
  const PRIVATE_STATUS_TITLE = {
    online: "The Blocks directory responded. “Listed” means these agents are invited/registered to your account — it does NOT mean a peer is currently online and serving requests.",
    offline: "Offline mode — showing local rosters only.",
    unauthenticated: "Authenticate to Blocks to load the private directory.",
    unavailable: "Couldn’t reach the Blocks private directory.",
  };

  const PEER_DOT_TITLE = {
    online: "Online — a live instance answered a reachability probe.",
    offline: "Offline — registered/invited, but no instance responded to a reachability probe.",
    unknown: "Liveness unknown — couldn’t probe (offline mode, no Blocks key, or transport error).",
    checking: "Checking if this peer is serving right now…",
  };

  function BlocksPrivateAgentsPanel({ privateAgents, assistants, settings }) {
    const agents = Array.isArray(privateAgents.agents) ? privateAgents.agents : [];
    const rosterPeers = rosterPrivatePeers(assistants);
    const directoryOnly = agents.filter((agent) => !rosterPeers.some((peer) => peer.agentName === agent.agentName));
    const visible = [...rosterPeers, ...directoryOnly].slice(0, 6);
    const status = privateAgents.status || "unavailable";
    const total = privateAgents.totalCount || agents.length;
    const hiddenOwned = privateAgents.hiddenOwnedCount || 0;
    const rosterCount = rosterPeers.length;
    const subtitle = status === "online"
      ? `${rosterCount} rostered private peer${rosterCount === 1 ? "" : "s"} · ${total} visible in Blocks directory${hiddenOwned ? ` · ${hiddenOwned} owned hidden` : ""}`
      : privateAgents.note || "Private listing unavailable.";
    const emptyText = status === "online"
      ? privateAgents.error || "No rostered private peers yet."
      : (privateAgents.error && privateAgents.error !== subtitle ? privateAgents.error : "");

    // Per-peer liveness: the listing only proves these are registered, so we
    // actively probe each one (bridge → bounded A2A reachability ping) and
    // render a dot. Probe once per visible handle-set; never poll.
    const [liveness, setLiveness] = useState({});
    const handles = visible.map((a) => a.agentName);
    const handlesKey = handles.join(",");
    const baseUrl = settings && settings.baseUrl;
    useEffect(() => {
      if (status !== "online" || !handles.length) return;
      let cancelled = false;
      const controller = new AbortController();
      setLiveness((prev) => {
        const next = { ...prev };
        handles.forEach((h) => { next[h] = { status: "checking", reason: "" }; });
        return next;
      });
      handles.forEach((h) => {
        window.peerStatus(h, settings, controller.signal)
          .then((r) => { if (!cancelled) setLiveness((prev) => ({ ...prev, [h]: r })); })
          .catch(() => { /* AbortError on unmount — ignore */ });
      });
      return () => { cancelled = true; controller.abort(); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handlesKey, status, baseUrl]);

    return (
      <div className="blocks-private-panel">
        <div className="blocks-private-head">
          <div>
            <b>Private peer roster</b>
            <span>{subtitle}</span>
          </div>
          <span className={"private-status " + (rosterCount ? "online" : status)} title={rosterCount ? "Rostered peers are the assistants this private assistant can actually call through A2A." : (PRIVATE_STATUS_TITLE[status] || "")}>
            {rosterCount ? "rostered" : (PRIVATE_STATUS_LABEL[status] || status)}
          </span>
        </div>
        {visible.length ? (
          <div className="blocks-private-list">
            {visible.map((agent) => {
              const live = liveness[agent.agentName] || { status: "checking", reason: "" };
              const dotTitle = (PEER_DOT_TITLE[live.status] || "") + (live.reason ? `\n\n${live.reason}` : "");
              const display = agent.ownerName || agent.displayName || agent.owner || agent.agentName;
              return (
                <span key={agent.agentName} title={agent.description || display || agent.agentName}>
                  <span className="peer-id">
                    <span className={"peer-dot " + live.status} title={dotTitle} aria-label={`liveness: ${live.status}`} />
                    <b>{agent.agentName}</b>
                  </span>
                  <small>{display || "private agent"}{agent.source === "roster" ? " · roster" : ""}</small>
                </span>
              );
            })}
          </div>
        ) : (
          emptyText ? <div className="blocks-private-empty">{emptyText}</div> : null
        )}
      </div>
    );
  }

  function rosterPrivatePeers(assistants) {
    const map = new Map();
    for (const assistant of assistants || []) {
      for (const peer of (assistant && assistant.peers) || []) {
        if (!peer || !peer.agentName || map.has(peer.agentName)) continue;
        map.set(peer.agentName, {
          ...peer,
          displayName: peer.displayName || peer.ownerName || peer.owner,
          source: "roster",
        });
      }
    }
    return Array.from(map.values());
  }

  function AssistantOverviewCard({ assistant, settings, onChanged }) {
    const peers = Array.isArray(assistant.peers) ? assistant.peers : [];
    const hops = Array.isArray(assistant.hops) ? assistant.hops.slice(0, 3) : [];
    const spend = assistant.spendToday || {};
    const integrations = assistant.integrations || {};
    // Pillar 3.5: name a peer for display (owner/display name first, handle as
    // the fallback) so the roster reads as identities, not bare strings.
    const peerName = (peer) => peer.ownerName || peer.displayName || peer.agentName;
    const peerTitle = (peer) => {
      const caps = Array.isArray(peer.capabilities) && peer.capabilities.length ? ` · can: ${peer.capabilities.join(", ")}` : "";
      return `${peer.agentName}${peer.owner ? " — " + peer.owner : ""}${caps}`;
    };
    return (
      <article className="assistant-card">
        <div className="assistant-card-head">
          <div className="assistant-id">
            <b>{assistant.agentName || "assistant"}</b>
            <span>{assistant.owner || "owner unknown"}</span>
          </div>
          <span className={"live-pill" + (assistant.live ? " on" : "")}>{assistant.live ? "Live" : "Offline"}</span>
        </div>
        <div className="assistant-metrics">
          <Metric label="Peers" value={peers.length} />
          <Metric label="A2A" value={`${spend.a2aCalls || 0}/${spend.dailyCap || 0}`} />
        </div>
        <div className="integration-pills">
          <IntegrationPill label="Calendar" connected={connected(integrations.calendar) || connected(integrations.google)} />
          <IntegrationPill label="Gmail" connected={connected(integrations.gmail) || connected(integrations.google)} />
        </div>
        <div className="peer-list">
          {peers.length ? peers.slice(0, 4).map((peer) => (
            <span key={peer.agentName} title={peerTitle(peer)}>
              <b>{peerName(peer)}</b>
              {peerName(peer) !== peer.agentName ? <small>{peer.agentName}</small> : null}
            </span>
          )) : <em>No peers</em>}
        </div>
        <PeerInviteAffordance assistant={assistant} settings={settings} onChanged={onChanged} />
        <div className="hop-list">
          {hops.length ? hops.map((hop) => (
            <div key={`${hop.at}-${hop.direction}-${hop.from}-${hop.to}`} className="hop-row">
              <span className={"hop-dir " + hop.direction}>{hop.direction === "out" ? "Out" : "In"}</span>
              <span>{hop.from} → {hop.to}</span>
              <small>{hop.outcome || "recorded"}</small>
            </div>
          )) : <div className="hop-empty">No recent hops</div>}
        </div>
      </article>
    );
  }

  /* Pillar 3.5: the "Invite peer" affordance for the not-introduced case. A
   * minimal inline form that exchanges a small identity card (name +
   * capabilities) so a natural reference resolves to the new peer afterwards. */
  function PeerInviteAffordance({ assistant, settings, onChanged }) {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({ peerAgentName: "", peerOwnerName: "", peerEmail: "", peerCapabilities: "" });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
    const submit = async () => {
      const handle = (form.peerAgentName || "").trim();
      if (!handle) { setErr("A peer handle (e.g. pa_kayley) is required."); return; }
      setBusy(true); setErr("");
      try {
        await window.invitePeer(settings, {
          owner: assistant.owner,
          agentName: assistant.agentName,
          peerAgentName: handle,
          peerOwnerName: (form.peerOwnerName || "").trim(),
          peerEmail: (form.peerEmail || "").trim(),
          peerCapabilities: (form.peerCapabilities || "").split(",").map((s) => s.trim()).filter(Boolean),
        });
        setOpen(false);
        setForm({ peerAgentName: "", peerOwnerName: "", peerEmail: "", peerCapabilities: "" });
        onChanged && onChanged();
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        setBusy(false);
      }
    };
    if (!open) {
      return <button className="mini-btn invite-peer-btn" onClick={() => setOpen(true)}>+ Invite peer</button>;
    }
    return (
      <div className="invite-peer-form">
        <input placeholder="Peer handle (pa_kayley)" value={form.peerAgentName} onChange={(e) => set("peerAgentName", e.target.value)} disabled={busy} />
        <input placeholder="Person name (Kayley Chen)" value={form.peerOwnerName} onChange={(e) => set("peerOwnerName", e.target.value)} disabled={busy} />
        <input placeholder="Their email (so 'email Kayley' works)" value={form.peerEmail} onChange={(e) => set("peerEmail", e.target.value)} disabled={busy} />
        <input placeholder="Capabilities (free-busy, book)" value={form.peerCapabilities} onChange={(e) => set("peerCapabilities", e.target.value)} disabled={busy} />
        {err ? <div className="invite-peer-err">{err}</div> : null}
        <div className="invite-peer-actions">
          <button className="mini-btn" onClick={submit} disabled={busy}>{busy ? "Inviting…" : "Invite"}</button>
          <button className="mini-btn" onClick={() => { setOpen(false); setErr(""); }} disabled={busy}>Cancel</button>
        </div>
      </div>
    );
  }

  function Metric({ label, value }) {
    return <div className="metric"><span>{label}</span><b>{value}</b></div>;
  }

  function IntegrationPill({ label, connected }) {
    return <span className={"integration-pill" + (connected ? " connected" : "")}>{label}: {connected ? "connected" : "not connected"}</span>;
  }

  function connected(value) {
    return !!(value && value.connected);
  }

  /* --------------------------- Settings ----------------------------- */
  function SettingsModal({ settings, onClose, onSave, onResetLocalSession }) {
    const [s, setS] = useState(settings);
    const set = (k, v) => setS((prev) => ({ ...prev, [k]: v }));
    const deployedBaseUrl = ((window.OPENCLAW_CONFIG && window.OPENCLAW_CONFIG.baseUrl) || "").trim();
    const usingDeployedBridge = (s.baseUrl || "").trim().replace(/\/+$/, "") === deployedBaseUrl.replace(/\/+$/, "");
    const useDeployedBridge = () => set("baseUrl", deployedBaseUrl);

    // Pillar 0: owner identity profile + contact book. Loaded from the
    // bridge when an Owner ID is set; edited inline and persisted on Save
    // (profile) or immediately (contacts).
    const owner = (s.ownerId || "").trim();
    const [profile, setProfile] = useState({ displayName: "", email: "", timezone: "" });
    const [contacts, setContacts] = useState([]);
    // Workstream I.4: capabilities live on the roster (one source of truth),
    // so join them into the contact list by peerHandle for the "Blocks peer"
    // rows rather than denormalizing them onto the contact.
    const [peerCaps, setPeerCaps] = useState({});
    const [newContact, setNewContact] = useState({ name: "", email: "", aliases: "" });
    const [identityErr, setIdentityErr] = useState("");
    const [identityBusy, setIdentityBusy] = useState(false);

    useEffect(() => {
      if (!owner) { setProfile({ displayName: "", email: "", timezone: "" }); setContacts([]); setPeerCaps({}); return; }
      let cancelled = false;
      const controller = new AbortController();
      (async () => {
        try {
          const [p, c] = await Promise.all([
            window.loadProfile(s, controller.signal),
            window.loadContacts(s, controller.signal),
          ]);
          if (cancelled) return;
          const pr = (p && p.profile) || {};
          setProfile({ displayName: pr.displayName || "", email: pr.email || "", timezone: pr.timezone || "" });
          setContacts((c && c.contacts) || []);
        } catch (e) {
          if (!cancelled && e && e.name !== "AbortError") setIdentityErr(e.message || String(e));
        }
        // Best-effort capabilities join — a failure here just omits the
        // capability hints, it never blocks the contact list.
        try {
          const ov = await window.assistantOverview(s, controller.signal);
          if (cancelled) return;
          const caps = {};
          for (const a of (ov && ov.assistants) || []) {
            for (const peer of (a && a.peers) || []) {
              if (peer && peer.agentName && Array.isArray(peer.capabilities) && peer.capabilities.length) {
                caps[peer.agentName] = peer.capabilities;
              }
            }
          }
          setPeerCaps(caps);
        } catch (e) { /* overview is optional for the contact list */ }
      })();
      return () => { cancelled = true; controller.abort(); };
    }, [owner, s.baseUrl, s.token]);

    const setProfileField = (k, v) => setProfile((prev) => ({ ...prev, [k]: v }));

    const addContact = async () => {
      const name = (newContact.name || "").trim();
      const email = (newContact.email || "").trim();
      if (!name || !email) { setIdentityErr("A contact needs both a name and an email."); return; }
      const aliases = (newContact.aliases || "").split(",").map((a) => a.trim()).filter(Boolean);
      setIdentityBusy(true); setIdentityErr("");
      try {
        const r = await window.saveContact(s, { name, email, aliases });
        setContacts((r && r.contacts) || []);
        setNewContact({ name: "", email: "", aliases: "" });
      } catch (e) { setIdentityErr(e.message || String(e)); }
      finally { setIdentityBusy(false); }
    };

    const deleteContact = async (name) => {
      setIdentityBusy(true); setIdentityErr("");
      try {
        const r = await window.removeContact(s, name);
        setContacts((r && r.contacts) || []);
      } catch (e) { setIdentityErr(e.message || String(e)); }
      finally { setIdentityBusy(false); }
    };

    const save = async () => {
      // Persist the profile alongside the local settings so the assistant
      // immediately knows its name/email/timezone. Contacts are already
      // saved as they're added.
      if (owner) {
        try { await window.saveProfile(s, profile); }
        catch (e) { setIdentityErr(e.message || String(e)); return; }
      }
      onSave(s);
    };

    return (
      <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal" role="dialog" aria-label="Settings">
          <div className="modal-head">
            <h3>Settings</h3>
            <button className="icon-btn" onClick={onClose}><Icons.Close s={18} /></button>
          </div>
          <div className="modal-body">
            <div className="field">
              <label>Gateway base URL</label>
              <input type="text" value={s.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)} placeholder="(blank = via foundation bridge)" />
              <span className="hint">Current deployment bridge: <code style={{ fontFamily: "var(--mono)" }}>{deployedBaseUrl || "same origin"}</code></span>
              <div className="inline-actions">
                <button className="btn secondary" type="button" onClick={useDeployedBridge} disabled={usingDeployedBridge}>
                  Use deployed bridge
                </button>
              </div>
              <span className="hint">This controls where assistant, Google, and peer calls go. Use the deployed bridge for the EC2 demo.</span>
            </div>
            <div className="field">
              <label>Owner ID</label>
              <input type="text" value={s.ownerId || ""}
                onChange={(e) => set("ownerId", e.target.value)} placeholder="auto-filled from bridge" />
              <span className="hint">Used for private assistant authorization and per-owner Google Calendar/Gmail connections.</span>
            </div>
            <div className="field">
              <label>Gateway token</label>
              <input type="password" value={s.token}
                onChange={(e) => set("token", e.target.value)} placeholder="(blank = injected by the bridge)" />
              <span className="hint">Sent as <code style={{ fontFamily: "var(--mono)" }}>Authorization: Bearer …</code>. Leave blank to let the bridge inject <code style={{ fontFamily: "var(--mono)" }}>OPENCLAW_GATEWAY_TOKEN</code>.</span>
            </div>

            <div className="settings-section">
              <h4>Image generation</h4>
              <span className="hint">When more than one Blocks text-to-image agent can do the job, how should they be coordinated? Collapses to a single hire when only one agent is available; only free agents are hired.</span>
            </div>
            <div className="field">
              <label>When multiple image agents match</label>
              <select value={s.imageStrategy || "single"} onChange={(e) => set("imageStrategy", e.target.value)}>
                <option value="single">Single — hire the best-ranked agent (fastest, cheapest)</option>
                <option value="race">Race — hire all, first image to finish wins</option>
                <option value="compare">Compare — hire all, show every agent’s image</option>
                <option value="best">Best — hire all, a local judge picks the winner</option>
              </select>
              <span className="hint">Race &amp; Best return one picture (from several hires); Compare shows them all side by side.</span>
            </div>

            <div className="settings-section">
              <h4>Demo session</h4>
              <span className="hint">Clear saved chats in this browser while keeping the selected bridge, owner, profile, contacts, and Google connection.</span>
            </div>
            <div className="field">
              <button className="btn secondary" onClick={onResetLocalSession}>Fresh local session</button>
            </div>

            <div className="settings-section">
              <h4>Your profile</h4>
              <span className="hint">So the assistant can state who it is, sign mail as you, and book in your timezone.{owner ? "" : " Set an Owner ID above first."}</span>
            </div>
            <div className="field" style={{ opacity: owner ? 1 : 0.5 }}>
              <label>Display name</label>
              <input type="text" value={profile.displayName} disabled={!owner}
                onChange={(e) => setProfileField("displayName", e.target.value)} placeholder="e.g. Alice Rivera" />
            </div>
            <div className="field" style={{ opacity: owner ? 1 : 0.5 }}>
              <label>Your email</label>
              <input type="text" value={profile.email} disabled={!owner}
                onChange={(e) => setProfileField("email", e.target.value)} placeholder="you@example.com" />
            </div>
            <div className="field" style={{ opacity: owner ? 1 : 0.5 }}>
              <label>Timezone</label>
              <input type="text" value={profile.timezone} disabled={!owner}
                onChange={(e) => setProfileField("timezone", e.target.value)} placeholder="e.g. America/New_York" />
              <span className="hint">An IANA timezone name. Overrides the server timezone when the assistant proposes meeting times.</span>
            </div>

            <div className="settings-section">
              <h4>Contacts</h4>
              <span className="hint">So “email Dana the summary” resolves to a real address instead of a guess. Invited Blocks peers appear here automatically — name, email, and handle, no typing.</span>
            </div>
            {owner && contacts.length > 0 && (() => {
              // Workstream I.4: invited Blocks peers first (self-described,
              // joined by handle), manual contacts after.
              const blocksPeers = contacts.filter((c) => c.peerHandle);
              const manual = contacts.filter((c) => !c.peerHandle);
              const contactRow = (c, isPeer) => {
                const caps = isPeer && peerCaps[c.peerHandle] ? peerCaps[c.peerHandle] : null;
                return (
                  <li key={c.name} className="contact-row">
                    <span className="contact-id">
                      <b>{c.name}</b>
                      {isPeer ? <span className="contact-badge">Blocks peer</span> : null}
                      <span className="contact-email">{c.email}</span>
                      {isPeer ? <span className="contact-handle"> · {c.peerHandle}</span> : null}
                      {caps ? <span className="contact-caps"> · can: {caps.join(", ")}</span> : null}
                      {!isPeer && c.aliases && c.aliases.length ? <span className="contact-aliases"> · {c.aliases.join(", ")}</span> : null}
                    </span>
                    <button className="icon-btn" title="Remove contact" disabled={identityBusy}
                      onClick={() => deleteContact(c.name)}><Icons.Close s={16} /></button>
                  </li>
                );
              };
              return (
                <ul className="contacts-list">
                  {blocksPeers.map((c) => contactRow(c, true))}
                  {manual.map((c) => contactRow(c, false))}
                </ul>
              );
            })()}
            <div className="settings-subsection">
              <span className="hint">{owner ? "Add someone not on Blocks — people on Blocks arrive automatically when you invite their assistant." : "Set an Owner ID above first."}</span>
            </div>
            <div className="field" style={{ opacity: owner ? 1 : 0.5 }}>
              <div className="contact-add">
                <input type="text" value={newContact.name} disabled={!owner}
                  onChange={(e) => setNewContact((p) => ({ ...p, name: e.target.value }))} placeholder="Name" />
                <input type="text" value={newContact.email} disabled={!owner}
                  onChange={(e) => setNewContact((p) => ({ ...p, email: e.target.value }))} placeholder="email@example.com" />
                <input type="text" value={newContact.aliases} disabled={!owner}
                  onChange={(e) => setNewContact((p) => ({ ...p, aliases: e.target.value }))} placeholder="aliases (comma-separated)" />
                <button className="btn secondary" disabled={!owner || identityBusy} onClick={addContact}>Add someone not on Blocks</button>
              </div>
            </div>
            {identityErr ? <div className="field"><span className="hint" style={{ color: "var(--danger, #c0392b)" }}>{identityErr}</span></div> : null}
          </div>
          <div className="modal-footer">
            <button className="btn secondary" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    );
  }

  /* --------------------------- Lightbox ----------------------------- */
  function Lightbox() {
    const [src, setSrc] = useState(null);
    useEffect(() => {
      const open = (e) => setSrc(e.detail.src);
      const onKey = (e) => { if (e.key === "Escape") setSrc(null); };
      window.addEventListener("openclaw:lightbox", open);
      window.addEventListener("keydown", onKey);
      return () => { window.removeEventListener("openclaw:lightbox", open); window.removeEventListener("keydown", onKey); };
    }, []);
    if (!src) return null;
    return (
      <div className="lightbox" onClick={() => setSrc(null)}>
        <button className="lb-close" onClick={() => setSrc(null)}><Icons.Close s={20} /></button>
        <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      </div>
    );
  }

  /* ------------------- Meeting-request handshake -------------------- */
  // Two-sided peer booking: subscribes to the owner-scoped notification
  // channel and surfaces each live meeting request. The initiator sees
  // "Waiting for … to accept"; the peer gets an actionable card with
  // Accept / Decline. A meeting commits to BOTH calendars only once both
  // owners accept, so this panel is the owner's entry point into that
  // handshake — never an auto-book.
  function MeetingRequestsPanel({ settings }) {
    const ownerId = ((settings && settings.ownerId) || "").trim();
    // threadId → latest notification (newest state wins, like the server fold).
    const [byThread, setByThread] = useState({});
    const [busy, setBusy] = useState({});
    const [error, setError] = useState("");

    useEffect(() => {
      if (!ownerId) return;
      setByThread({});
      setError("");
      let sub = null;
      try {
        sub = window.subscribeMeetingRequests(settings, {
          onMeetingRequest: (note) => {
            if (!note || !note.threadId) return;
            setByThread((prev) => ({ ...prev, [note.threadId]: note }));
          },
          onError: (err) => setError(String((err && err.message) || err)),
        });
      } catch (err) {
        setError(String((err && err.message) || err));
      }
      return () => { if (sub) sub.cancel(); };
    }, [settings.baseUrl, settings.token, ownerId]);

    const respond = useCallback((note, decision) => {
      setBusy((prev) => ({ ...prev, [note.threadId]: decision }));
      window.respondMeetingRequest(settings, {
        threadId: note.threadId,
        decision,
        confirmToken: note.confirmToken,
      })
        .then(() => setError(""))
        .catch((err) => setError(String((err && err.message) || err)))
        .finally(() => setBusy((prev) => { const n = { ...prev }; delete n[note.threadId]; return n; }));
    }, [settings.baseUrl, settings.token, ownerId]);

    if (!ownerId) return null;
    // Terminal states drop out of the active list once resolved.
    const active = Object.values(byThread).filter(
      (n) => n.status === "pending-both" || n.status === "both-accepted",
    );
    const resolved = Object.values(byThread).filter(
      (n) => n.status === "committed" || n.status === "declined" || n.status === "expired" || n.status === "commit-failed",
    );
    if (!active.length && !resolved.length && !error) return null;

    return (
      <section className="mreq-panel" aria-label="Meeting requests">
        <div className="mreq-head">
          <div className="mreq-title">Meeting requests</div>
          <div className="mreq-sub">Two-sided booking · both owners must accept</div>
        </div>
        {error ? <div className="mreq-error">{error}</div> : null}
        {active.map((note) => {
          const actionable = note.status === "pending-both" && !!note.confirmToken;
          const working = busy[note.threadId];
          return (
            <div key={note.threadId} className={"mreq-card " + (actionable ? "actionable" : "waiting")}>
              <div className="mreq-msg">{note.message || "Meeting request"}</div>
              <div className="mreq-meta">
                <span className={"mreq-badge status-" + note.status}>{mreqStatusLabel(note.status)}</span>
                {note.role ? <span className="mreq-role">{note.role === "peer" ? "You were invited" : "You proposed"}</span> : null}
              </div>
              {actionable ? (
                <div className="mreq-actions">
                  <button className="mreq-btn accept" disabled={!!working}
                    onClick={() => respond(note, "accept")}>
                    {working === "accept" ? "Accepting…" : "Accept"}
                  </button>
                  <button className="mreq-btn decline" disabled={!!working}
                    onClick={() => respond(note, "decline")}>
                    {working === "decline" ? "Declining…" : "Decline"}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
        {resolved.map((note) => (
          <div key={note.threadId} className="mreq-card resolved">
            <div className="mreq-msg">{note.message || mreqStatusLabel(note.status)}</div>
            <span className={"mreq-badge status-" + note.status}>{mreqStatusLabel(note.status)}</span>
          </div>
        ))}
      </section>
    );
  }

  function mreqStatusLabel(status) {
    switch (status) {
      case "pending-both": return "Awaiting both";
      case "both-accepted": return "Booking…";
      case "committed": return "Booked";
      case "declined": return "Declined";
      case "expired": return "Expired";
      case "commit-failed": return "Booking failed";
      default: return status || "";
    }
  }

  /* ----------------------------- Toast ------------------------------ */
  function Toast({ text }) { return text ? <div className="toast">{text}</div> : null; }

  // Memoize Message: while a reply streams, only the streaming message's
  // props change each token. Without this, every prior message (including
  // any with heavy inline media) re-renders on every token, which locks the
  // main thread and can crash the tab.
  const MemoMessage = React.memo(Message);

  Object.assign(window, { Icons, Sidebar, ToolActivity, ThinkingTabs, Message: MemoMessage, EmptyState, AssistantOverviewPanel, MeetingRequestsPanel, NetworkAgentsPanel, SettingsModal, Lightbox, Toast });
})();
