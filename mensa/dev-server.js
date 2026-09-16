// Server locale (solo Node, nessuna dipendenza): stessa API del Worker, database SQLite su file.
// Uso: node dev-server.js [--port 8787] [--db mensa.db]

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { handleApi, purgeExpired } from './src/api.js';
import { openSqlite } from './src/db-sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, 'public');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf('port', process.env.PORT || 8787));
const DB_FILE = resolve(here, argOf('db', process.env.DB_FILE || 'data/mensa.db'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = join(here, 'data', '.session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  await writeFile(file, secret, { mode: 0o600 });
  console.log('Generato un SESSION_SECRET locale in data/.session-secret');
  return secret;
}

await mkdir(join(here, 'data'), { recursive: true });
const db = openSqlite(DB_FILE);
db.handle.exec(await readFile(join(here, 'schema.sql'), 'utf8'));
const env = { SESSION_SECRET: await sessionSecret(), RETENTION_WEEKS: process.env.RETENTION_WEEKS ?? 12 };

async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url, `http://localhost:${PORT}`), {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
}

async function serveStatic(pathname, res) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const target = join(PUBLIC_DIR, clean === '/' ? 'index.html' : clean);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Vietato');
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    }).end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Pagina non trovata');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const response = await handleApi(await toRequest(req), env, db);
    const headers = Object.fromEntries(response.headers.entries());
    res.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  await serveStatic(url.pathname, res);
});

// Stesso lavoro del cron su Cloudflare: pulizia dei dati storici all'avvio e ogni 24 h.
const retention = async () => {
  const result = await purgeExpired(db, Number(env.RETENTION_WEEKS));
  if (result.orders) console.log(`Retention: eliminati ${result.orders} ordini precedenti a ${result.cutoff}.`);
};
await retention();
setInterval(retention, 24 * 3600 * 1000).unref?.();

server.listen(PORT, () => {
  console.log(`Mensa in ascolto su http://localhost:${PORT}  (database: ${DB_FILE})`);
});
