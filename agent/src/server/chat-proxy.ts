/**
 * OpenAI-compatible streaming proxy to the OpenClaw gateway.
 *
 * The browser never holds the gateway token: if the caller omits a bearer we
 * inject OPENCLAW_GATEWAY_TOKEN here, server-side. SSE bytes are piped back
 * unbuffered so the chat UI streams token-by-token.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { CORS_ORIGIN, json } from './http-io.ts';
import { traceCtx, tstep, tnote, terror, previewValue } from './trace.ts';

export async function proxyChatCompletions(req: IncomingMessage, res: ServerResponse) {
  const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789').replace(/\/+$/u, '');

  // A bearer from the browser wins (lets an operator override per-tab);
  // otherwise fall back to the server's configured operator token.
  const incomingAuth = req.headers['authorization'];
  const clientBearer = typeof incomingAuth === 'string' && /^Bearer\s+\S/u.test(incomingAuth) ? incomingAuth : undefined;
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const authorization = clientBearer ?? (envToken ? `Bearer ${envToken}` : undefined);
  if (!authorization) {
    return json(res, { ok: false, error: 'No gateway token: set OPENCLAW_GATEWAY_TOKEN in .env or send Authorization: Bearer <token>' }, 401);
  }

  // Collect the request body. Multimodal turns carry base64 images, so allow
  // a much larger cap than a typical JSON endpoint.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32_000_000) {
      return json(res, { ok: false, error: 'request body too large (32MB cap)' }, 413);
    }
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  describeChatTurn(body);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization,
  };
  const sessionKey = req.headers['x-openclaw-session-key'];
  if (typeof sessionKey === 'string' && sessionKey) headers['x-openclaw-session-key'] = sessionKey;
  for (const passthrough of ['x-openclaw-model', 'x-openclaw-agent-id', 'x-openclaw-message-channel']) {
    const value = req.headers[passthrough];
    if (typeof value === 'string' && value) headers[passthrough] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body,
      // Agent runs can take a while; allow generous headroom.
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    terror(`gateway unreachable at ${gatewayUrl}: ${message}`);
    return json(res, { ok: false, error: `Could not reach OpenClaw gateway at ${gatewayUrl}: ${message}` }, 502);
  }
  tnote(`gateway responded ${upstream.status} — streaming SSE back to the browser…`);

  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': CORS_ORIGIN,
    'x-accel-buffering': 'no',
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  // Pipe the upstream web stream straight to the client unbuffered.
  const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  let bytes = 0;
  let chunkCount = 0;
  try {
    for await (const chunk of nodeStream) {
      bytes += (chunk as Buffer).length;
      chunkCount += 1;
      res.write(chunk);
    }
  } catch {
    // client disconnected or upstream aborted — best effort
  } finally {
    res.end();
    tnote(`streamed ${chunkCount} chunk(s), ${bytes} bytes to the browser`);
  }
}

/** Best-effort summary of an inbound chat turn for the live trace — pulls
 *  the model + last user message text without dumping any base64 image
 *  parts the multimodal UI may attach. */
function describeChatTurn(body: Buffer): void {
  if (traceCtx.getStore()?.verbosity !== 'verbose') return;
  let parsed: { model?: unknown; messages?: unknown };
  try {
    parsed = JSON.parse(body.toString('utf8')) as typeof parsed;
  } catch {
    tstep(`chat turn (${body.byteLength} bytes, unparseable body)`);
    return;
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const model = typeof parsed.model === 'string' ? parsed.model : 'openclaw/default';
  tstep(`chat turn · model=${model} · ${messages.length} message(s)`);

  const lastUser = [...messages].reverse().find(
    (m) => (m as { role?: unknown }).role === 'user',
  ) as { content?: unknown } | undefined;
  if (lastUser) tnote(`user: "${previewValue(extractMessageText(lastUser.content), 120)}"`);
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: unknown; text?: unknown };
        if (typeof p.text === 'string') return p.text;
        if (p.type && p.type !== 'text') return `[${String(p.type)}]`;
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return '';
}
