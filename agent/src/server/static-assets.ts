/**
 * Static file serving for the bridge: the chat UI, generated artifacts under
 * agent/outputs/, and gateway-generated media from the bind-mounted media dir.
 * Every path is resolved + prefix-checked so a crafted request can't escape
 * its directory. Loopback-only, same posture as the rest of the server.
 */

import type { ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORS_ORIGIN, notFound } from './http-io.ts';

export const OUTPUTS_DIR = resolve(fileURLToPath(new URL('../../outputs', import.meta.url)));

const OUTPUT_CONTENT_TYPES: Record<string, string> = {
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
  '.md': 'text/markdown; charset=utf-8',
};

/** Serve a single file from agent/outputs/. Loopback-only like the rest of
 *  the server; flat-name + prefix validation blocks traversal. */
export async function serveOutputFile(res: ServerResponse, pathname: string) {
  const name = decodeURIComponent(pathname.slice('/outputs/'.length));
  if (!name || name !== basename(name) || name.includes('..')) return notFound(res);

  const filePath = resolve(join(OUTPUTS_DIR, name));
  if (!filePath.startsWith(OUTPUTS_DIR + sep)) return notFound(res);

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);

  const contentType = OUTPUT_CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    'cache-control': 'no-store',
    'access-control-allow-origin': CORS_ORIGIN,
  });
  res.end(await readFile(filePath));
}

// The gateway's media dir, bind-mounted to ./data/config/media on the host.
// Override with OPENCLAW_MEDIA_DIR if your compose mounts it elsewhere.
const MEDIA_DIR = resolve(
  process.env.OPENCLAW_MEDIA_DIR ?? fileURLToPath(new URL('../../../data/config/media', import.meta.url)),
);

/** Serve a gateway-generated artifact from the bind-mounted media dir.
 *  Nested subpaths are allowed (e.g. tool-image-generation/foo.png) but
 *  resolved + prefix-checked so a crafted path can't escape the dir. */
export async function serveMediaFile(res: ServerResponse, pathname: string) {
  const rel = decodeURIComponent(pathname.slice('/media/'.length));
  if (!rel || rel.includes('..') || rel.startsWith('/')) return notFound(res);

  const filePath = resolve(join(MEDIA_DIR, rel));
  if (filePath !== MEDIA_DIR && !filePath.startsWith(MEDIA_DIR + sep)) return notFound(res);

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);

  const contentType = OUTPUT_CONTENT_TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    'cache-control': 'no-store',
    'access-control-allow-origin': CORS_ORIGIN,
  });
  res.end(await readFile(filePath));
}

const CHAT_DIR = resolve(fileURLToPath(new URL('../../web/chat', import.meta.url)));

const CHAT_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // JSX is fetched (not executed) by Babel standalone in the browser; the
  // content-type only needs to be text-ish for responseText to populate.
  '.jsx': 'text/babel; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

/** Serve the chat UI and its assets from agent/web/chat/ at the base path.
 *  `/` resolves to index.html; everything else is a path under CHAT_DIR
 *  validated against directory traversal, same posture as /outputs/. */
export async function serveChatAsset(res: ServerResponse, pathname: string) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  rel = decodeURIComponent(rel);
  if (rel === '' || rel.endsWith('/')) rel = `${rel}index.html`;
  if (rel.includes('..') || rel.includes('\0')) return notFound(res);

  const filePath = resolve(join(CHAT_DIR, rel));
  if (filePath !== CHAT_DIR && !filePath.startsWith(CHAT_DIR + sep)) return notFound(res);

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);

  const contentType = CHAT_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  // Vendored libraries and fonts are immutable; the HTML/JSX should stay fresh.
  const immutable = filePath.includes(`${sep}vendor${sep}`) || filePath.includes(`${sep}fonts${sep}`);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=86400' : 'no-store',
  });
  res.end(await readFile(filePath));
}
