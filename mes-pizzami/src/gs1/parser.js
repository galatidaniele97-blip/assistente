/**
 * Parser GS1-128 per etichette logistiche (bancali) e di collo.
 *
 * Modulo puro, senza dipendenze: viene usato sia dal server Node (validazione
 * autoritativa prima di salvare) sia dal browser sul tablet (feedback immediato).
 *
 * Ingresso accettato:
 *  - stringa grezza del lettore in modalita' tastiera, con eventuale prefisso di
 *    simbologia (]C1, ]d2, ]Q3, ...) e separatore FNC1/GS (ASCII 29) dopo i campi
 *    a lunghezza variabile; e' accettata anche la sequenza letterale "<GS>";
 *  - notazione leggibile con parentesi: (00)380999990000000019(10)L260915A
 *
 * Uscita: { ok, errors[], elements[], fields{}, raw, storable, humanReadable }
 */

export const GS = String.fromCharCode(29);
const GS_RE = new RegExp(GS, 'g');

/** Application Identifier supportati. Gli AI non in tabella sono un errore esplicito. */
export const AI_TABLE = {
  '00':   { field: 'sscc',           title: 'SSCC',              fixed: true,  length: 18, type: 'sscc' },
  '01':   { field: 'gtin',           title: 'GTIN',              fixed: true,  length: 14, type: 'gtin' },
  '02':   { field: 'gtinContained',  title: 'GTIN contenuto',    fixed: true,  length: 14, type: 'gtin' },
  '10':   { field: 'lot',            title: 'Lotto',             fixed: false, maxLength: 20, type: 'alnum' },
  '11':   { field: 'productionDate', title: 'Data produzione',   fixed: true,  length: 6,  type: 'date' },
  '15':   { field: 'bestBeforeDate', title: 'TMC',               fixed: true,  length: 6,  type: 'date' },
  '17':   { field: 'expiryDate',     title: 'Scadenza',          fixed: true,  length: 6,  type: 'date' },
  '37':   { field: 'caseCount',      title: 'Colli',             fixed: false, maxLength: 8, type: 'int' },
  '3100': { field: 'netWeightKg',    title: 'Peso netto (kg)',   fixed: true,  length: 6,  type: 'decimal', decimals: 0 },
  '3101': { field: 'netWeightKg',    title: 'Peso netto (kg)',   fixed: true,  length: 6,  type: 'decimal', decimals: 1 },
  '3102': { field: 'netWeightKg',    title: 'Peso netto (kg)',   fixed: true,  length: 6,  type: 'decimal', decimals: 2 },
  '3103': { field: 'netWeightKg',    title: 'Peso netto (kg)',   fixed: true,  length: 6,  type: 'decimal', decimals: 3 },
  '3104': { field: 'netWeightKg',    title: 'Peso netto (kg)',   fixed: true,  length: 6,  type: 'decimal', decimals: 4 },
  '3105': { field: 'netWeightKg',    title: 'Peso netto (kg)',   fixed: true,  length: 6,  type: 'decimal', decimals: 5 },
};

/** Caratteri ammessi da GS1 nei campi alfanumerici (sottoinsieme ISO 646). */
const GS1_ALNUM = /^[A-Za-z0-9!"%&'()*+,\-./:;<=>?_ ]+$/;

/** Calcola il check digit (modulo 10) del corpo numerico passato (senza check digit). */
export function computeCheckDigit(body) {
  if (!/^\d+$/.test(body)) throw new Error('Il corpo deve contenere solo cifre');
  let sum = 0;
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Verifica lunghezza e check digit di GTIN (8/12/13/14) e SSCC (18). */
export function isGs1CheckDigitValid(code) {
  if (typeof code !== 'string' || !/^\d+$/.test(code)) return false;
  if (![8, 12, 13, 14, 18].includes(code.length)) return false;
  return computeCheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/**
 * Converte una data GS1 AAMMGG in ISO AAAA-MM-GG.
 * Secolo secondo la regola GS1 (finestra +/- 50 anni rispetto all'anno corrente).
 * Giorno "00" = ultimo giorno del mese.
 */
export function parseGs1Date(value, today = new Date()) {
  if (!/^\d{6}$/.test(value)) return { error: 'Data non nel formato AAMMGG' };
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  let dd = Number(value.slice(4, 6));
  if (mm < 1 || mm > 12) return { error: 'Mese non valido' };

  const currentYear = today.getFullYear();
  const currentCentury = Math.floor(currentYear / 100) * 100;
  let year = currentCentury + yy;
  const diff = year - currentYear;
  if (diff >= 51) year -= 100;
  else if (diff <= -50) year += 100;

  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  if (dd === 0) dd = lastDay;
  if (dd > lastDay) return { error: 'Giorno non valido per il mese' };

  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return { iso };
}

/** Rimuove prefissi di simbologia, CR/LF finali e normalizza il separatore GS. */
export function normalizeRaw(input) {
  let s = String(input ?? '');
  s = s.replace(/[\r\n\t]+$/g, '').trim();
  s = s.replace(/^\](C1|C0|d2|Q3|e0|E0)/, '');    // identificatore di simbologia
  s = s.replace(/<GS>/gi, GS);                   // forma letterale usata nei test e nei log
  s = s.replace(/\u00a0/g, ' ');            // spazio non separabile -> spazio
  return s;
}

/** Rappresentazione salvabile/leggibile della stringa grezza (GS -> "<GS>"). */
export function toStorableRaw(raw) {
  return String(raw ?? '').replace(/[\r\n]+$/g, '').replace(GS_RE, '<GS>');
}

/** Rappresentazione leggibile con parentesi: (00)...(10)... */
export function toHumanReadable(elements) {
  return elements.map((e) => `(${e.ai})${e.value}`).join('');
}

/** Spezza la notazione con parentesi in coppie AI/valore. */
function splitParenthesized(s) {
  const elements = [];
  const errors = [];
  const re = /\((\d{2,4})\)([^()]*)/g;
  let consumed = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) {
      errors.push({ ai: null, message: `Testo non riconosciuto in posizione ${consumed + 1}` });
      break;
    }
    const ai = m[1];
    const value = m[2].replace(GS_RE, '');
    const def = AI_TABLE[ai];
    // Un campo a lunghezza fissa seguito da altro testo: il testo in eccesso non e' parte del valore
    if (def && def.fixed && value.length > def.length) {
      elements.push({ ai, value: value.slice(0, def.length) });
      errors.push({ ai: null, message: `Testo non riconosciuto in posizione ${m.index + ai.length + 2 + def.length + 1}` });
      break;
    }
    elements.push({ ai, value });
    consumed = re.lastIndex;
  }
  if (errors.length === 0 && consumed !== s.length) {
    errors.push({ ai: null, message: `Testo non riconosciuto in posizione ${consumed + 1}` });
  }
  return { elements, errors };
}

/** Spezza la stringa grezza (con GS) in coppie AI/valore seguendo la tabella degli AI. */
function splitRaw(s) {
  const elements = [];
  const errors = [];
  let pos = 0;
  while (pos < s.length) {
    if (s[pos] === GS) { pos++; continue; }          // GS residuo (es. subito dopo il prefisso)

    let ai = null;
    for (const len of [2, 3, 4]) {
      const candidate = s.substr(pos, len);
      if (AI_TABLE[candidate]) { ai = candidate; break; }
    }
    if (!ai) {
      const shown = s.substr(pos, 4).replace(GS_RE, '<GS>');
      errors.push({ ai: null, message: `AI sconosciuto o non supportato in posizione ${pos + 1}: "${shown}"` });
      break;
    }
    pos += ai.length;
    const def = AI_TABLE[ai];

    let value;
    if (def.fixed) {
      value = s.substr(pos, def.length);
      pos += value.length;
    } else {
      const end = s.indexOf(GS, pos);
      value = end === -1 ? s.slice(pos) : s.slice(pos, end);
      pos = end === -1 ? s.length : end + 1;
    }
    elements.push({ ai, value });
  }
  return { elements, errors };
}

/** Valida e converte il valore di un elemento secondo il tipo dell'AI. */
function interpretElement(el, today) {
  const def = AI_TABLE[el.ai];
  if (!def) return { error: `AI (${el.ai}) non supportato` };
  const v = el.value;

  if (def.fixed && v.length !== def.length) {
    return { error: `(${el.ai}) ${def.title}: attesi ${def.length} caratteri, trovati ${v.length}` };
  }
  if (!def.fixed) {
    if (v.length === 0) return { error: `(${el.ai}) ${def.title}: valore vuoto` };
    if (v.length > def.maxLength) return { error: `(${el.ai}) ${def.title}: massimo ${def.maxLength} caratteri, trovati ${v.length}` };
  }

  switch (def.type) {
    case 'sscc':
    case 'gtin': {
      if (!/^\d+$/.test(v)) return { error: `(${el.ai}) ${def.title}: deve contenere solo cifre` };
      if (!isGs1CheckDigitValid(v)) return { error: `(${el.ai}) ${def.title}: check digit errato` };
      return { parsed: v };
    }
    case 'date': {
      const d = parseGs1Date(v, today);
      if (d.error) return { error: `(${el.ai}) ${def.title}: ${d.error}` };
      return { parsed: d.iso };
    }
    case 'int': {
      if (!/^\d+$/.test(v)) return { error: `(${el.ai}) ${def.title}: deve contenere solo cifre` };
      return { parsed: Number(v) };
    }
    case 'decimal': {
      if (!/^\d+$/.test(v)) return { error: `(${el.ai}) ${def.title}: deve contenere solo cifre` };
      return { parsed: Number(v) / 10 ** def.decimals };
    }
    case 'alnum': {
      if (!GS1_ALNUM.test(v)) return { error: `(${el.ai}) ${def.title}: caratteri non ammessi` };
      return { parsed: v };
    }
    default:
      return { error: `(${el.ai}) tipo non gestito` };
  }
}

/**
 * Analizza una stringa GS1-128.
 * @param {string} input  stringa del lettore o notazione con parentesi
 * @param {{today?: Date}} [options]
 */
export function parseGs1(input, options = {}) {
  const today = options.today ?? new Date();
  const raw = String(input ?? '');
  const normalized = normalizeRaw(raw);
  const result = {
    ok: false,
    raw,
    storable: toStorableRaw(raw),
    humanReadable: '',
    elements: [],
    fields: {
      sscc: null, gtin: null, gtinContained: null, lot: null,
      productionDate: null, bestBeforeDate: null, expiryDate: null,
      caseCount: null, netWeightKg: null,
    },
    errors: [],
  };

  if (normalized.length === 0) {
    result.errors.push({ ai: null, message: 'Nessun codice letto' });
    return result;
  }

  const split = normalized.includes('(') ? splitParenthesized(normalized) : splitRaw(normalized);
  result.errors.push(...split.errors);

  const seenFields = new Set();
  for (const el of split.elements) {
    const def = AI_TABLE[el.ai];
    const out = { ai: el.ai, title: def ? def.title : `AI ${el.ai}`, value: el.value, parsed: null };
    const interp = interpretElement(el, today);
    if (interp.error) {
      result.errors.push({ ai: el.ai, message: interp.error });
    } else {
      out.parsed = interp.parsed;
      if (seenFields.has(def.field)) {
        result.errors.push({ ai: el.ai, message: `(${el.ai}) ${def.title}: campo ripetuto` });
      } else {
        seenFields.add(def.field);
        result.fields[def.field] = interp.parsed;
      }
    }
    result.elements.push(out);
  }

  if (split.elements.length === 0 && result.errors.length === 0) {
    result.errors.push({ ai: null, message: 'Nessun Application Identifier trovato' });
  }

  result.ok = result.errors.length === 0;
  result.humanReadable = toHumanReadable(result.elements);
  return result;
}

export default parseGs1;
