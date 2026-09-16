/**
 * Lettura di testo incollato da Excel (o da un CSV): la griglia del menù e
 * l'elenco dei dipendenti. Funzioni pure, così si provano anche fuori dal browser.
 */

const VUOTO = /^[\s\/\-—–_.]*$/;

function celle(riga) {
  // Excel incolla con il tabulatore; un CSV italiano usa il punto e virgola.
  const sep = riga.includes('\t') ? '\t' : riga.includes(';') ? ';' : null;
  return (sep ? riga.split(sep) : [riga]).map((c) => c.replace(/^"|"$/g, '').trim());
}

/**
 * Griglia del menù: una riga per lettera, con o senza la colonna della portata,
 * poi le cinque colonne dei giorni. Le righe che non iniziano con una lettera
 * nota (intestazione, settimana, righe vuote) vengono ignorate e riportate.
 *
 * slots: [{ id, code, courseName }]
 * → { righe: [{ code, slotId, giorni: [5 stringhe] }], ignorate: [stringa], mancanti: [code] }
 */
export function leggiGriglia(testo, slots) {
  const byCode = new Map(slots.map((s) => [s.code.toUpperCase(), s]));
  const courseNames = new Set(slots.map((s) => (s.courseName ?? '').toLowerCase()).filter(Boolean));
  const righe = [];
  const ignorate = [];
  const visti = new Set();

  for (const grezza of String(testo ?? '').split(/\r?\n/)) {
    if (VUOTO.test(grezza)) continue;
    const c = celle(grezza);
    const posizione = c.findIndex((x) => byCode.has(x.toUpperCase()));
    if (posizione === -1) {
      ignorate.push(grezza.trim().slice(0, 60));
      continue;
    }
    const slot = byCode.get(c[posizione].toUpperCase());
    if (visti.has(slot.code)) {
      ignorate.push(`${slot.code} ripetuta`);
      continue;
    }
    let resto = c.slice(posizione + 1);
    // Colonna facoltativa con il nome della portata ("Primi"), da saltare.
    if (resto.length > 5 && courseNames.has((resto[0] ?? '').toLowerCase())) resto = resto.slice(1);
    const giorni = [0, 1, 2, 3, 4].map((i) => (VUOTO.test(resto[i] ?? '') ? '' : resto[i].replace(/\s+/g, ' ')));
    visti.add(slot.code);
    righe.push({ code: slot.code, slotId: slot.id, giorni });
  }
  righe.sort((a, b) => slots.findIndex((s) => s.code === a.code) - slots.findIndex((s) => s.code === b.code));
  const mancanti = slots.map((s) => s.code).filter((code) => !visti.has(code));
  return { righe, ignorate, mancanti };
}

const ARMADIETTO = /^[A-Za-z]?\d{1,4}[A-Za-z]?$/;

/**
 * Elenco persone: una per riga, nome e armadietto in qualunque ordine, separati
 * da tabulatore, punto e virgola o virgola. "12 Mario Rossi" e "Rossi Mario;12"
 * vanno bene entrambi.
 * → { persone: [{ name, locker }], senzaArmadietto: [nome], doppioni: [nome] }
 */
export function leggiPersone(testo) {
  const persone = [];
  const senzaArmadietto = [];
  const doppioni = [];
  const nomi = new Set();

  for (const grezza of String(testo ?? '').split(/\r?\n/)) {
    if (VUOTO.test(grezza)) continue;
    let parti = grezza.includes('\t') || grezza.includes(';') || grezza.includes(',')
      ? grezza.split(/\t|;|,/).map((x) => x.trim()).filter(Boolean)
      : grezza.trim().split(/\s+/);
    let locker = '';
    const indice = parti.findIndex((x) => ARMADIETTO.test(x));
    if (indice !== -1) {
      locker = parti[indice].toUpperCase();
      parti = parti.filter((_, i) => i !== indice);
    }
    const name = parti.join(' ').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    if (/^(nome|cognome|nominativo|dipendente|armadietto)\b/i.test(name)) continue; // intestazione
    if (nomi.has(name.toLowerCase())) {
      doppioni.push(name);
      continue;
    }
    nomi.add(name.toLowerCase());
    if (!locker) {
      senzaArmadietto.push(name);
      continue;
    }
    persone.push({ name, locker });
  }
  return { persone, senzaArmadietto, doppioni };
}
