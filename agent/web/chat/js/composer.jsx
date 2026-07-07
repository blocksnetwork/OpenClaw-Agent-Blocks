/* ===========================================================================
   composer.jsx — input bar: growing textarea, media attachments via
   drag-and-drop / paste / file-picker (images downscaled to base64), mic recorder,
   Enter-to-send. Exposed as window.Composer.
   =========================================================================== */
(function () {
  const { useState, useRef, useEffect, useCallback } = React;
  const Icons = window.Icons;
  const MIN_VOICE_BLOB_BYTES = 6000;
  const MIC_DEVICE_KEY = "openclaw:micDeviceId";

  function toast(text) { window.dispatchEvent(new CustomEvent("openclaw:toast", { detail: { text } })); }

  function Composer({ onSend, streaming, onStop, inject, selectedAgent, onClearSelectedAgent }) {
    const [text, setText] = useState("");
    const [atts, setAtts] = useState([]);          // {id, kind, url, name, loading}
    const [recording, setRecording] = useState(false);
    const [recSecs, setRecSecs] = useState(0);
    const [micDevices, setMicDevices] = useState([]);
    const [micDeviceId, setMicDeviceId] = useState(loadSavedMicDevice);
    const [activeMicLabel, setActiveMicLabel] = useState("");
    const [micMenuOpen, setMicMenuOpen] = useState(false);
    const taRef = useRef(null);
    const fileRef = useRef(null);
    const micMenuRef = useRef(null);
    const recRef = useRef(null);                    // { recorder, stream, chunks, timer }

    /* grow textarea */
    const autosize = useCallback(() => {
      const el = taRef.current; if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 220) + "px";
    }, []);
    useEffect(autosize, [text, autosize]);

    /* external injection (suggestion clicks / retry) */
    useEffect(() => {
      if (inject && inject.text != null) {
        setText(inject.text);
        requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
      } else if (inject && inject.focusOnly) {
        requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
      }
    }, [inject]);

    useEffect(() => {
      if (!selectedAgent) return;
      requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    }, [selectedAgent]);

    /* ---- attachment handling ---- */
    const addMediaFiles = useCallback(async (files) => {
      const all = Array.from(files || []);
      const imgs = all.filter((f) => window.ACCEPTED_IMAGE.includes(f.type));
      const audio = all.filter((f) => isAudioFile(f));
      const rejected = all.length - imgs.length - audio.length;
      if (rejected > 0) toast("Only images or audio clips are supported.");
      for (const f of imgs) {
        const tmpId = window.uid("att");
        setAtts((p) => [...p, { id: tmpId, kind: "image", loading: true, name: f.name }]);
        try {
          const processed = await window.processImageFile(f);
          setAtts((p) => p.map((a) => (a.id === tmpId ? { ...processed, loading: false } : a)));
        } catch (e) {
          setAtts((p) => p.filter((a) => a.id !== tmpId));
          toast("Couldn’t read “" + f.name + "”.");
        }
      }
      for (const f of audio) {
        if (f.size < MIN_VOICE_BLOB_BYTES) {
          toast("Audio file was too short or silent. Use 5-10 seconds of clear speech.");
          continue;
        }
        const tmpId = window.uid("att");
        setAtts((p) => [...p, { id: tmpId, kind: "audio", loading: true, name: f.name || "audio-clip" }]);
        try {
          const url = await window.readFileAsDataURL(f);
          setAtts((p) => p.map((a) => (a.id === tmpId ? {
            id: tmpId,
            kind: "audio",
            url,
            name: f.name || "audio-clip",
            mime: f.type || "audio/webm",
            loading: false,
          } : a)));
        } catch (e) {
          setAtts((p) => p.filter((a) => a.id !== tmpId));
          toast("Couldn’t read “" + (f.name || "audio clip") + "”.");
        }
      }
    }, []);

    const removeAtt = (id) => setAtts((p) => p.filter((a) => a.id !== id));

    /* ---- microphone input ---- */
    const refreshMicDevices = useCallback(async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((d) => d.kind === "audioinput");
        setMicDevices(inputs);
        setMicDeviceId((current) => {
          if (!current || inputs.some((d) => d.deviceId === current)) return current;
          clearSavedMicDevice();
          return "";
        });
        return inputs;
      } catch (e) {
        return [];
      }
    }, []);

    useEffect(() => {
      refreshMicDevices();
      const md = navigator.mediaDevices;
      if (!md || !md.addEventListener) return undefined;
      md.addEventListener("devicechange", refreshMicDevices);
      return () => md.removeEventListener("devicechange", refreshMicDevices);
    }, [refreshMicDevices]);

    const setMicInput = useCallback((deviceId) => {
      setMicDeviceId(deviceId);
      saveMicDevice(deviceId);
      if (!deviceId) setActiveMicLabel("");
      setMicMenuOpen(false);
    }, []);

    useEffect(() => {
      if (!micMenuOpen) return undefined;
      const close = (e) => {
        if (e.type === "keydown" && e.key !== "Escape") return;
        if (e.type !== "keydown" && micMenuRef.current && micMenuRef.current.contains(e.target)) return;
        setMicMenuOpen(false);
      };
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", close);
      return () => {
        document.removeEventListener("mousedown", close);
        document.removeEventListener("keydown", close);
      };
    }, [micMenuOpen]);

    /* ---- paste ---- */
    const onPaste = useCallback((e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) { if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); } }
      if (files.length) { e.preventDefault(); addMediaFiles(files); }
    }, [addMediaFiles]);

    /* ---- drag over composer ---- */
    const [dragover, setDragover] = useState(false);
    const dragDepth = useRef(0);
    const onDragEnter = (e) => { e.preventDefault(); dragDepth.current++; if (hasFiles(e)) setDragover(true); };
    const onDragOver = (e) => { e.preventDefault(); };
    const onDragLeave = (e) => { e.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { setDragover(false); dragDepth.current = 0; } };
    const onDrop = (e) => {
      e.preventDefault(); setDragover(false); dragDepth.current = 0;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addMediaFiles(e.dataTransfer.files);
    };

    /* ---- mic recording ---- */
    const startRec = useCallback(async () => {
      if (!navigator.mediaDevices || !window.MediaRecorder) { toast("Recording isn’t supported in this browser."); return; }
      try {
        let stream;
        const audio = micDeviceId ? { deviceId: { exact: micDeviceId } } : true;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (e) {
          if (micDeviceId && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) {
            clearSavedMicDevice();
            setMicDeviceId("");
            toast("Selected microphone was not available. Using the default mic.");
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } else {
            throw e;
          }
        }
        const track = stream.getAudioTracks && stream.getAudioTracks()[0];
        const settings = track && track.getSettings ? track.getSettings() : {};
        const label = (track && track.label) || selectedMicLabel(micDevices, micDeviceId) || "";
        setActiveMicLabel(label);
        if (settings && settings.deviceId && !micDeviceId) setActiveMicLabel(label || "Default microphone");
        refreshMicDevices();
        const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks = [];
        recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          if (recRef.current && recRef.current.timer) clearInterval(recRef.current.timer);
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size < MIN_VOICE_BLOB_BYTES) {
            toast("Voice clip was too short or silent. Record 5-10 seconds of clear speech.");
            setRecording(false); setRecSecs(0); recRef.current = null;
            return;
          }
          const url = await window.readFileAsDataURL(blob);
          setAtts((p) => [...p, { id: window.uid("att"), kind: "audio", url, name: "voice-clip", mime: blob.type }]);
          setRecording(false); setRecSecs(0); recRef.current = null;
        };
        const timer = setInterval(() => setRecSecs((s) => {
          if (s + 1 >= 60) { stopRec(); return 60; }   // cap at 60s
          return s + 1;
        }), 1000);
        recRef.current = { recorder, stream, chunks, timer };
        // Pass a timeslice so the browser emits `ondataavailable` every second
        // instead of only once on stop. Without it, some browsers (and some
        // codecs) buffer everything and can hand back a near-empty blob on
        // stop — the root of the intermittent "clip too short or silent".
        recorder.start(1000);
        setRecording(true); setRecSecs(0);
      } catch (e) {
        toast("Microphone permission denied or no input device found.");
      }
    }, [micDeviceId, micDevices, refreshMicDevices]);

    const stopRec = useCallback(() => {
      const r = recRef.current;
      if (r && r.recorder && r.recorder.state !== "inactive") r.recorder.stop();
    }, []);

    useEffect(() => () => { // cleanup on unmount
      const r = recRef.current;
      if (r) { try { r.recorder.stop(); } catch (e) {} if (r.timer) clearInterval(r.timer); }
    }, []);

    /* ---- send ---- */
    const ready = atts.length > 0 && atts.every((a) => !a.loading);
    const selectedHandle = selectedAgent && (selectedAgent.handle || selectedAgent.agentName);
    const selectedName = selectedAgent && (selectedAgent.displayName || selectedAgent.name || selectedHandle);
    const selectedMicName = selectedMicLabel(micDevices, micDeviceId) || "Default mic";
    const canSend = !streaming && (selectedHandle
      ? text.trim().length > 0
      : (text.trim().length > 0 || (atts.length > 0 && ready)));

    const submit = () => {
      if (streaming) return;
      if (selectedHandle && !text.trim()) return;
      if (!selectedHandle && !text.trim() && atts.length === 0) return;
      if (atts.some((a) => a.loading)) { toast("Still processing an attachment…"); return; }
      onSend({ text: text.trim(), attachments: atts.map(({ loading, ...a }) => a), targetBlocksAgent: selectedAgent || null });
      setText(""); setAtts([]);
      if (selectedHandle && onClearSelectedAgent) onClearSelectedAgent();
      requestAnimationFrame(autosize);
    };

    const onKeyDown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    };

    return (
      <div className="composer-wrap">
        <div className="composer-inner">
          <div className={"composer" + (dragover ? " dragover" : "")}
            onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            {selectedHandle ? (
              <div className="selected-agent-strip">
                <div className="selected-agent-chip">
                  <span className="selected-agent-dot" />
                  <span className="selected-agent-copy">
                    <b>{selectedName || selectedHandle}</b>
                    {selectedHandle && selectedName !== selectedHandle ? <small>{selectedHandle}</small> : null}
                  </span>
                  <button type="button" className="selected-agent-remove" title="Remove selected Blocks agent" onClick={onClearSelectedAgent} disabled={streaming}>
                    <Icons.Close s={11} />
                  </button>
                </div>
                <span className="selected-agent-help">Next prompt goes directly to this Blocks agent; availability is checked on send.</span>
              </div>
            ) : null}
            {atts.length > 0 && (
              <div className="attachments">
                {atts.map((a) => (
                  a.kind === "audio" ? (
                    <div key={a.id} className="attachment audio">
                      <Icons.Mic s={14} /> {shortFileName(a.name || "Audio clip")}
                      <button className="remove" onClick={() => removeAtt(a.id)} title="Remove"><Icons.Close s={11} /></button>
                    </div>
                  ) : a.loading ? (
                    <div key={a.id} className="attachment loading"><span className="att-spin" /></div>
                  ) : (
                    <div key={a.id} className="attachment">
                      <img src={a.url} alt={a.name} />
                      <button className="remove" onClick={() => removeAtt(a.id)} title="Remove"><Icons.Close s={11} /></button>
                    </div>
                  )
                ))}
              </div>
            )}

            <div className="composer-row">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,audio/*,.m4a,.mp3,.wav,.webm,.ogg,.oga,.flac" multiple
                style={{ display: "none" }} onChange={(e) => { addMediaFiles(e.target.files); e.target.value = ""; }} />
              <button className="icon-btn" title="Attach image or audio" onClick={() => fileRef.current && fileRef.current.click()} disabled={streaming}>
                <Icons.Image s={19} />
              </button>

              {recording ? (
                <div className="ta" style={{ display: "flex", alignItems: "center" }}>
                  <span className="rec-indicator">
                    <span className="rec-dot" /> Recording… {fmtSecs(recSecs)}
                    {activeMicLabel ? <small className="rec-device">{shortFileName(activeMicLabel)}</small> : null}
                  </span>
                </div>
              ) : (
                <textarea ref={taRef} className="ta" rows={1} value={text}
                  placeholder={selectedHandle ? `Prompt ${selectedName || selectedHandle} on Blocks…` : "Message OpenClaw…  Attach audio/images, or ask it to make one."}
                  onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} disabled={streaming} />
              )}

              <div className="composer-actions">
                {navigator.mediaDevices ? (
                  <div className="mic-menu" ref={micMenuRef}>
                    <button type="button"
                      className={"mic-menu-btn" + (micDeviceId ? " selected" : "") + (micMenuOpen ? " open" : "")}
                      aria-label={"Microphone input: " + selectedMicName}
                      aria-expanded={micMenuOpen}
                      title={"Microphone input: " + selectedMicName}
                      disabled={streaming || recording}
                      onClick={() => {
                        const next = !micMenuOpen;
                        setMicMenuOpen(next);
                        if (next) refreshMicDevices();
                      }}>
                      <Icons.Sliders s={16} />
                      <span className="mic-menu-dot" />
                    </button>
                    {micMenuOpen ? (
                      <div className="mic-popover" role="menu" aria-label="Microphone input">
                        <div className="mic-popover-head">
                          <b>Microphone</b>
                          <span>{micDevices.length ? micDevices.length + " input" + (micDevices.length === 1 ? "" : "s") : "browser default"}</span>
                        </div>
                        <button type="button" className={"mic-option" + (!micDeviceId ? " active" : "")}
                          onClick={() => setMicInput("")}>
                          <span>Default mic</span>
                          {!micDeviceId ? <Icons.Check s={14} /> : null}
                        </button>
                        {micDevices.map((d, i) => (
                          <button type="button" key={d.deviceId || "mic-" + i}
                            className={"mic-option" + (micDeviceId === d.deviceId ? " active" : "")}
                            onClick={() => setMicInput(d.deviceId)}>
                            <span>{deviceLabel(d, i)}</span>
                            {micDeviceId === d.deviceId ? <Icons.Check s={14} /> : null}
                          </button>
                        ))}
                        {!micDevices.length ? <div className="mic-empty">Allow mic access to show device names.</div> : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button className={"icon-btn" + (recording ? " recording" : "")} title={recording ? "Stop recording" : "Record voice"}
                  onClick={recording ? stopRec : startRec} disabled={streaming && !recording}>
                  {recording ? <Icons.Stop s={16} /> : <Icons.Mic s={19} />}
                </button>
                {streaming ? (
                  <button className="send-btn stop" title="Stop" onClick={onStop}><Icons.Stop s={15} /></button>
                ) : (
                  <button className="send-btn" title="Send" onClick={submit} disabled={!canSend}><Icons.Send s={18} /></button>
                )}
              </div>
            </div>
          </div>
          <div className="composer-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line · drag, paste or attach files
          </div>
        </div>
      </div>
    );
  }

  function hasFiles(e) {
    const dt = e.dataTransfer; if (!dt) return false;
    if (dt.items) { for (const it of dt.items) if (it.kind === "file") return true; return false; }
    return dt.types && Array.prototype.indexOf.call(dt.types, "Files") !== -1;
  }
  function isAudioFile(file) {
    if (!file) return false;
    const type = (file.type || "").toLowerCase();
    if (type.startsWith("audio/")) return true;
    if (window.ACCEPTED_AUDIO && window.ACCEPTED_AUDIO.includes(type)) return true;
    return /\.(m4a|mp3|wav|webm|ogg|oga|flac)$/i.test(file.name || "");
  }
  function shortFileName(value) {
    const name = String(value || "Audio clip");
    return name.length > 28 ? name.slice(0, 17) + "..." + name.slice(-8) : name;
  }
  function deviceLabel(device, index) {
    return (device && device.label) || "Microphone " + (index + 1);
  }
  function selectedMicLabel(devices, deviceId) {
    if (!deviceId) return "";
    const idx = (devices || []).findIndex((d) => d.deviceId === deviceId);
    return idx >= 0 ? deviceLabel(devices[idx], idx) : "";
  }
  function loadSavedMicDevice() {
    try { return localStorage.getItem(MIC_DEVICE_KEY) || ""; } catch (e) { return ""; }
  }
  function saveMicDevice(deviceId) {
    try {
      if (deviceId) localStorage.setItem(MIC_DEVICE_KEY, deviceId);
      else localStorage.removeItem(MIC_DEVICE_KEY);
    } catch (e) {}
  }
  function clearSavedMicDevice() { saveMicDevice(""); }
  function fmtSecs(s) { const m = Math.floor(s / 60); const r = s % 60; return m + ":" + String(r).padStart(2, "0"); }

  Object.assign(window, { Composer });
})();
