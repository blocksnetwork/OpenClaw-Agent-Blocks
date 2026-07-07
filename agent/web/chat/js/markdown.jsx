/* ===========================================================================
   markdown.jsx — pragmatic Markdown → React renderer for assistant messages.
   Handles headings, lists, blockquotes, fenced code, inline code/bold/italic,
   links, image cards (click → lightbox), and audio players for .mp3/.wav links.
   Re-parses on every streamed token; cheap enough for chat-length content.
   =========================================================================== */
(function () {
  const RE_IMG = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
  const RE_AUDIO_LINK = /^\[([^\]]*)\]\(([^)\s]+\.(?:mp3|wav))\)$/i;
  const AUDIO_HREF = /\.(mp3|wav)(\?|$)/i;
  // The OpenClaw gateway emits generated artifacts as a "MEDIA: <path>" line
  // pointing at its container-side .openclaw/media dir. That dir is served by
  // the dashboard at /media/, so we map the path and render it inline.
  const RE_MEDIA = /^MEDIA:\s*(\S+\.(?:png|jpe?g|gif|webp|svg|mp3|wav|ogg|m4a|mp4))\s*$/i;
  const MEDIA_AUDIO = /\.(mp3|wav|ogg|m4a)$/i;

  function mediaUrlFromPath(p) {
    const marker = "/.openclaw/media/";
    let idx = p.indexOf(marker);
    let sub = idx >= 0 ? p.slice(idx + marker.length) : null;
    if (sub == null) { idx = p.indexOf("/media/"); sub = idx >= 0 ? p.slice(idx + "/media/".length) : null; }
    if (sub == null) return null;
    return "/media/" + sub.split("/").map(encodeURIComponent).join("/");
  }

  // The bridge base URL the app keeps in sync with settings.baseUrl
  // (falling back to the deployment config in /config.js). Empty string =
  // same origin, which is correct when the bridge serves this UI.
  function baseUrl() {
    let b = (typeof window !== "undefined" && window.__OPENCLAW_BASE_URL) || "";
    if (!b && typeof window !== "undefined" && window.OPENCLAW_CONFIG) b = window.OPENCLAW_CONFIG.baseUrl || "";
    return String(b || "").replace(/\/$/, "");
  }

  // Resolve a media/link URL for rendering. Root-relative paths the bridge
  // serves (e.g. /media/…, /outputs/…) must be rewritten to the bridge
  // origin so they load when the UI is hosted separately (Netlify); a bare
  // "/media/foo.png" would otherwise resolve against the page origin and
  // 404. data:, blob:, absolute (http(s):) and protocol-relative URLs are
  // left untouched.
  function resolveUrl(u) {
    if (!u) return u;
    if (u[0] === "/" && u[1] !== "/") return baseUrl() + u;
    return u;
  }

  function openLightbox(src) {
    window.dispatchEvent(new CustomEvent("openclaw:lightbox", { detail: { src } }));
  }

  /* ----------------------------- inline ----------------------------- */
  const INLINE_SRC = "(`[^`]+`)|(!\\[[^\\]]*\\]\\([^)\\s]+(?:\\s+\"[^\"]*\")?\\))|(\\[[^\\]]+\\]\\([^)\\s]+\\))|(\\*\\*[^*]+\\*\\*)|(__[^_]+__)|(\\*[^*\\s][^*]*\\*)|(_[^_\\s][^_]*_)";

  function parseInline(str, kp) {
    // A FRESH regex per call: parseInline recurses for bold/italic, and a
    // shared global (/g) regex carries mutable lastIndex — a recursive call
    // resets it to 0, making the outer loop re-match the same token forever
    // (an infinite loop that locks the tab). A local instance is isolated.
    const INLINE = new RegExp(INLINE_SRC, "g");
    const out = [];
    let last = 0, m, i = 0;
    while ((m = INLINE.exec(str)) !== null) {
      if (m.index > last) out.push(str.slice(last, m.index));
      const tok = m[0];
      const key = kp + "-i" + (i++);
      if (m[1]) {
        out.push(<code className="inline" key={key}>{tok.slice(1, -1)}</code>);
      } else if (m[2]) {
        const im = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(tok);
        if (im) { const src = resolveUrl(im[2]); out.push(<img key={key} className="md-inline-img" src={src} alt={im[1]} onClick={() => openLightbox(src)} style={{ maxWidth: "120px", borderRadius: "8px", verticalAlign: "middle", cursor: "zoom-in" }} />); }
      } else if (m[3]) {
        const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
        if (lm) {
          const href = resolveUrl(lm[2]);
          if (AUDIO_HREF.test(lm[2])) {
            out.push(<a key={key} href={href} target="_blank" rel="noreferrer">▶ {lm[1]}</a>);
          } else {
            out.push(<a key={key} href={href} target="_blank" rel="noreferrer">{lm[1]}</a>);
          }
        }
      } else if (m[4] || m[5]) {
        out.push(<strong key={key}>{parseInline((m[4] || m[5]).slice(2, -2), key)}</strong>);
      } else if (m[6] || m[7]) {
        out.push(<em key={key}>{parseInline((m[6] || m[7]).slice(1, -1), key)}</em>);
      }
      last = m.index + tok.length;
    }
    if (last < str.length) out.push(str.slice(last));
    return out;
  }

  /* ----------------------------- blocks ----------------------------- */
  // Parsing is O(text length). While a reply streams, `text` grows by a
  // token at a time, so re-parsing on EVERY token is O(n²) — for a large
  // reply (e.g. an inline data: image) that locks the main thread and
  // balloons memory until the tab is killed. So during streaming we
  // coalesce parses to ~10fps; the final (non-streaming) render parses the
  // complete text exactly once.
  const STREAM_PARSE_INTERVAL_MS = 100;

  // Data: URLs larger than this are never inlined into the DOM directly — a
  // multi-megabyte <img src>/<audio src> that React reconciles on every
  // streamed token will lock the main thread and can crash the tab. Instead
  // we render a lightweight card and only attach the heavy blob on demand.
  const MAX_INLINE_DATA_URL = 2_000_000; // ~2MB

  function MarkdownRenderer({ text, streaming }) {
    const latest = React.useRef(text || "");
    latest.current = text || "";
    const [view, setView] = React.useState(text || "");
    const timer = React.useRef(null);
    const lastAt = React.useRef(0);

    React.useEffect(() => {
      if (!streaming) {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        setView(latest.current);
        return;
      }
      const flush = () => { lastAt.current = performance.now(); timer.current = null; setView(latest.current); };
      const elapsed = performance.now() - lastAt.current;
      if (elapsed >= STREAM_PARSE_INTERVAL_MS) flush();
      else if (!timer.current) timer.current = setTimeout(flush, STREAM_PARSE_INTERVAL_MS - elapsed);
    }, [text, streaming]);

    React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const blocks = React.useMemo(() => parseBlocks(view || ""), [view]);
    return <React.Fragment>{blocks}</React.Fragment>;
  }

  function parseBlocks(src) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const nodes = [];
    let i = 0, k = 0;

    while (i < lines.length) {
      let line = lines[i];

      // blank
      if (!line.trim()) { i++; continue; }

      // fenced code
      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        const lang = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing fence
        nodes.push(<pre key={"b" + k++}><code data-lang={lang}>{buf.join("\n")}</code></pre>);
        continue;
      }

      const tline = line.trim();

      // Gateway media reference: "MEDIA: /home/node/.openclaw/media/…/foo.png".
      // The browser can't load the container path, so map it to /media/ and
      // render the artifact inline. Only matches once the path (with a known
      // extension) has fully streamed, so it never flashes a partial path.
      const mediaM = RE_MEDIA.exec(tline);
      if (mediaM) {
        const url = mediaUrlFromPath(mediaM[1]);
        if (url) {
          nodes.push(MEDIA_AUDIO.test(url)
            ? <AudioCard key={"b" + k++} label="Audio" url={url} />
            : <ImageCard key={"b" + k++} url={url} alt="Generated image" />);
          i++; continue;
        }
      }

      // Big / data: URL image — cheap detection FIRST, so a megabyte data
      // URL never goes through the inline regex (O(n) per token while it
      // streams). Handles the still-streaming, not-yet-closed case too by
      // showing a placeholder instead of re-scanning the giant string.
      if (tline.startsWith("![")) {
        const altEnd = tline.indexOf("](");
        if (altEnd > 1) {
          const alt = tline.slice(2, altEnd);
          const rest = tline.slice(altEnd + 2);
          const closed = rest.endsWith(")");
          const url = closed ? rest.slice(0, -1) : rest;
          if (url.startsWith("data:") || url.length > 2048) {
            if (!closed) {
              nodes.push(<span key={"b" + k++} className="md-img-pending">rendering image…</span>);
            } else if (url.length > MAX_INLINE_DATA_URL) {
              nodes.push(<BigMediaCard key={"b" + k++} url={url} label={alt || "image"} kind="image" />);
            } else {
              nodes.push(<ImageCard key={"b" + k++} url={url} alt={alt} />);
            }
            i++; continue;
          }
        }
      }

      // Block-level link (audio clip, file, or oversized data: URL) — cheap
      // string detection BEFORE the inline regex, so a megabyte data: URL is
      // rendered as a player or a lazy card and never dumped into a giant
      // <a href> that React reconciles on every streamed token.
      if (tline.startsWith("[") && tline.endsWith(")")) {
        const lblEnd = tline.indexOf("](");
        if (lblEnd > 1) {
          const label = tline.slice(1, lblEnd);
          const url = tline.slice(lblEnd + 2, -1);
          const isData = url.startsWith("data:");
          if ((isData || url.length > 2048) && !/\s/.test(url)) {
            const isAudio = /^data:audio\//i.test(url) || AUDIO_HREF.test(url);
            if (isData && url.length > MAX_INLINE_DATA_URL) {
              nodes.push(<BigMediaCard key={"b" + k++} url={url} label={label.replace(/^▶\s*/, "")} kind={isAudio ? "audio" : "file"} />);
            } else if (isAudio) {
              nodes.push(<AudioCard key={"b" + k++} label={label.replace(/^▶\s*/, "")} url={url} />);
            } else {
              nodes.push(<a key={"b" + k++} href={resolveUrl(url)} target="_blank" rel="noreferrer">{label}</a>);
            }
            i++; continue;
          }
        }
      }

      // standalone image
      const imgM = RE_IMG.exec(line.trim());
      if (imgM) {
        const [, alt, url] = imgM;
        nodes.push(<ImageCard key={"b" + k++} url={url} alt={alt} />);
        i++; continue;
      }

      // standalone audio link
      const audM = RE_AUDIO_LINK.exec(line.trim());
      if (audM) {
        nodes.push(<AudioCard key={"b" + k++} label={audM[1].replace(/^▶\s*/, "")} url={audM[2]} />);
        i++; continue;
      }

      // heading
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const lvl = Math.min(3, h[1].length);
        const Tag = "h" + lvl;
        nodes.push(<Tag key={"b" + k++}>{parseInline(h[2], "b" + k)}</Tag>);
        i++; continue;
      }

      // hr
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { nodes.push(<hr key={"b" + k++} />); i++; continue; }

      // blockquote
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
        nodes.push(<blockquote key={"b" + k++}>{parseInline(buf.join(" "), "b" + k)}</blockquote>);
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++;
        }
        nodes.push(<ul key={"b" + k++}>{items.map((it, j) => <li key={j}>{parseInline(it, "b" + k + "-" + j)}</li>)}</ul>);
        continue;
      }

      // ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++;
        }
        nodes.push(<ol key={"b" + k++}>{items.map((it, j) => <li key={j}>{parseInline(it, "b" + k + "-" + j)}</li>)}</ol>);
        continue;
      }

      // paragraph — gather consecutive non-blank, non-special lines
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
             !/^>\s?/.test(lines[i]) && !RE_IMG.test(lines[i].trim()) &&
             !RE_AUDIO_LINK.test(lines[i].trim()) && !RE_MEDIA.test(lines[i].trim())) {
        buf.push(lines[i]); i++;
      }
      const para = [];
      buf.forEach((ln, j) => {
        if (j > 0) para.push(<br key={"br" + j} />);
        para.push(...parseInline(ln, "b" + k + "-l" + j));
      });
      nodes.push(<p key={"b" + k++}>{para}</p>);
    }
    return nodes;
  }

  function ImageCard({ url, alt }) {
    const src = resolveUrl(url);
    return (
      <span className="img-card" onClick={() => openLightbox(src)}>
        <img src={src} alt={alt || ""} />
        <span className="img-zoom" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
        </span>
        {alt ? <span className="img-caption">{alt}</span> : null}
      </span>
    );
  }

  // Heavy media (multi-MB data: URL) shown as a compact card. The blob is
  // only mounted into the DOM when the user clicks "Load", so it never sits
  // in the render/reconcile path while messages stream.
  function BigMediaCard({ url, label, kind }) {
    const [open, setOpen] = React.useState(false);
    const mb = (url.length / 1048576).toFixed(1);
    if (open) {
      return kind === "image"
        ? <ImageCard url={url} alt={label} />
        : <AudioCard label={label} url={url} />;
    }
    const icon = kind === "image" ? "Image" : "Audio";
    return (
      <div className="md-bigmedia">
        <span className="md-bigmedia-meta">{icon} · {mb} MB</span>
        <span className="md-bigmedia-label">{label}</span>
        <button className="mini-btn" onClick={() => setOpen(true)}>Load</button>
      </div>
    );
  }

  function AudioCard({ label, url }) {
    return (
      <div className="audio-card">
        <div className="audio-label">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
          {label || "Audio"}
        </div>
        <audio controls preload="metadata" src={resolveUrl(url)}></audio>
      </div>
    );
  }

  Object.assign(window, { MarkdownRenderer, ImageCard, AudioCard, BigMediaCard });
})();
