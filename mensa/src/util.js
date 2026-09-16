// Helper HTTP e validazione input.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function csv(rows, filename) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // ';' come separatore e BOM: Excel italiano apre il file senza passaggi manuali.
  const body = '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

/** Stringa obbligatoria, ripulita e con lunghezza massima. */
export function str(value, { field, max = 120, min = 1 } = {}) {
  const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (s.length < min) throw bad(`Campo "${field}" obbligatorio.`);
  if (s.length > max) throw bad(`Campo "${field}" troppo lungo (max ${max} caratteri).`);
  return s;
}

export function int(value, { field, min = 0, max = 99 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bad(`Campo "${field}" non valido (atteso un numero tra ${min} e ${max}).`);
  }
  return n;
}

export function id(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw bad(`Identificatore "${field}" non valido.`);
  return n;
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw bad('Corpo della richiesta non valido.');
  }
}

/** Ordina gli armadietti "1, 2, 10, 10A, A3" in modo naturale. */
export function lockerSort(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  const va = Number.isNaN(na) ? Number.MAX_SAFE_INTEGER : na;
  const vb = Number.isNaN(nb) ? Number.MAX_SAFE_INTEGER : nb;
  if (va !== vb) return va - vb;
  return String(a).localeCompare(String(b), 'it');
}
