/**
 * Read-only static server for `agent/outputs/`.
 *
 * This is the ONLY surface we expose through a public tunnel so that
 * multimodal artifacts (posters, narration) can render inline in the
 * OpenClaw chat. OpenClaw fetches chat media server-side and its SSRF
 * guard rejects loopback/private hosts, so the bridge's own
 * `127.0.0.1:18888/outputs/` route can never be embedded. Putting a
 * tunnel in front of THIS server (instead of the dashboard) keeps the
 * action endpoints (`/api/serve`, `/api/call-agent`, …) off the public
 * internet — only finished output files are reachable, read-only, GET
 * only, with flat-name + prefix validation against path traversal.
 *
 *   npm run outputs            # → http://127.0.0.1:18890
 *   cloudflared tunnel --url http://127.0.0.1:18890
 */

import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.env.OUTPUTS_HOST ?? '127.0.0.1';
const port = Number(process.env.OUTPUTS_PORT ?? 18890);

const OUTPUTS_DIR = resolve(fileURLToPath(new URL('../../outputs', import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

const server = createServer(async (req, res) => {
  if ((req.method ?? 'GET') !== 'GET') return end(res, 405, 'method not allowed');

  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  if (url.pathname === '/healthz') return end(res, 200, 'ok');
  if (!url.pathname.startsWith('/outputs/')) return end(res, 404, 'not found');

  const name = decodeURIComponent(url.pathname.slice('/outputs/'.length));
  if (!name || name !== basename(name) || name.includes('..')) return end(res, 404, 'not found');

  const filePath = resolve(join(OUTPUTS_DIR, name));
  if (!filePath.startsWith(OUTPUTS_DIR + sep)) return end(res, 404, 'not found');

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return end(res, 404, 'not found');
  }
  if (!info.isFile()) return end(res, 404, 'not found');

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store',
  });
  res.end(await readFile(filePath));
});

function end(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

server.listen(port, host, () => {
  console.log(`Outputs server (read-only): http://${host}:${port}/outputs/<file>`);
  console.log(`Serving: ${OUTPUTS_DIR}`);
  console.log('Put a tunnel in front of this to render chat media inline:');
  console.log(`  cloudflared tunnel --url http://${host}:${port}`);
});
