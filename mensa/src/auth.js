// Sessioni firmate (HMAC-SHA256) e gestione dei codici di accesso.
// Nessuno stato lato server: il token porta ruolo e perimetro dati.

import { HttpError } from './util.js';

const TTL_SECONDS = { admin: 12 * 3600, manager: 12 * 3600, staff: 30 * 24 * 3600 };
// Alfabeto senza caratteri ambigui (0/O, 1/I/L): i codici vengono letti a voce e trascritti.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function issueToken(secret, payload) {
  const ttl = TTL_SECONDS[payload.r] ?? 3600;
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttl };
  const data = b64urlEncode(enc.encode(JSON.stringify(body)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(data)));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function readToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), b64urlDecode(sig), enc.encode(data));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(data)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** Estrae la sessione dall'header Authorization e ne verifica il ruolo. */
export async function requireSession(request, env, roles) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = await readToken(env.SESSION_SECRET, token);
  if (!session) throw new HttpError(401, 'Sessione scaduta. Inserisci di nuovo il codice.');
  if (!roles.includes(session.r)) throw new HttpError(403, 'Operazione non consentita per questo accesso.');
  return session;
}

/** I codici si leggono a voce e si scrivono male: normalizziamo prima di confrontare. */
export function normalizeCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function generateCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

// ── Limitazione dei tentativi di accesso ──────────────────────────────────────
const WINDOW_SECONDS = 900;
const MAX_ATTEMPTS = 25;

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'sconosciuto'
  );
}

export async function checkLoginRate(db, ip) {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const row = await db.first('SELECT count FROM login_attempts WHERE ip = ? AND window_ts = ?', [ip, window]);
  if (row && row.count >= MAX_ATTEMPTS) {
    throw new HttpError(429, 'Troppi tentativi. Riprova tra qualche minuto.');
  }
}

export async function recordFailedLogin(db, ip) {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  await db.run(
    `INSERT INTO login_attempts (ip, window_ts, count) VALUES (?, ?, 1)
     ON CONFLICT(ip, window_ts) DO UPDATE SET count = count + 1`,
    [ip, window]
  );
}
