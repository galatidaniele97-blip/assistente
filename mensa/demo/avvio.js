/**
 * Avvio della dimostrazione: SQLite in WebAssembly nel browser, l'API vera
 * sopra, e fetch dirottato verso di essa. Nessun server, nessun dato che esce
 * dal telefono: ricaricando la pagina si riparte da capo.
 */

import { openSqlJs } from './db-sqljs.js';
import { seminaDimostrazione, CODICI } from './dati.js';
import { handleApi } from '../src/api.js';
import { SCHEMA } from './schema.js';

const env = { SESSION_SECRET: crypto.randomUUID(), RETENTION_WEEKS: '12' };
let dati;

async function chiamaApi(method, path, body, token) {
  const init = { method, headers: {} };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const risposta = await handleApi(new Request(`https://dimostrazione.locale${path}`, init), env, db);
  const testo = await risposta.text();
  const esito = testo ? JSON.parse(testo) : {};
  if (!risposta.ok) throw new Error(`${method} ${path}: ${risposta.status} ${testo}`);
  return esito;
}

/**
 * SQLite in WebAssembly, con ripiego sulla versione in solo JavaScript: certi
 * ambienti con politiche di sicurezza strette non permettono di compilare WASM.
 */
async function apriSqlite() {
  try {
    return await window.initSqlJs({ locateFile: () => new URL('./sql-wasm.wasm', import.meta.url).href });
  } catch (errore) {
    console.warn('WebAssembly non disponibile, uso la versione JavaScript.', errore);
    await new Promise((risolvi, rifiuta) => {
      const script = document.createElement('script');
      script.src = new URL('./sql-asm.js', import.meta.url).href;
      script.onload = risolvi;
      script.onerror = rifiuta;
      document.head.append(script);
    });
    return window.initSqlJs({});
  }
}

const SQL = await apriSqlite();
const database = new SQL.Database();
database.run('PRAGMA foreign_keys = ON');
database.run(SCHEMA);
const db = openSqlJs(database);
dati = await seminaDimostrazione(chiamaApi);

// Da qui in poi il client crede di parlare con un server: parla con sé stesso.
const fetchOriginale = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const indirizzo = new URL(typeof input === 'string' ? input : input.url, location.href);
  const inizio = indirizzo.pathname.indexOf('/api/');
  if (inizio === -1) return fetchOriginale(input, init);
  const richiesta = new Request(`https://dimostrazione.locale${indirizzo.pathname.slice(inizio)}${indirizzo.search}`, init);
  return handleApi(richiesta, env, db);
};

// ── Pannello con i codici da provare ────────────────────────────────────────

function h(tag, props, ...figli) {
  const nodo = document.createElement(tag);
  for (const [chiave, valore] of Object.entries(props || {})) {
    if (valore === null || valore === undefined || valore === false) continue;
    if (chiave === 'class') nodo.className = valore;
    else if (chiave === 'text') nodo.textContent = valore;
    else if (chiave.startsWith('on')) nodo.addEventListener(chiave.slice(2), valore);
    else nodo.setAttribute(chiave, valore);
  }
  for (const figlio of figli.flat(3)) {
    if (figlio === null || figlio === undefined || figlio === false) continue;
    nodo.append(figlio.nodeType ? figlio : document.createTextNode(String(figlio)));
  }
  return nodo;
}

function rigaCodice(etichetta, codice, descrizione) {
  return h('div', { class: 'demo-riga' },
    h('div', { class: 'grow' },
      h('div', { class: 'demo-ruolo', text: etichetta }),
      h('div', { class: 'demo-nota', text: descrizione })),
    h('button', {
      class: 'code-chip demo-copia',
      title: 'Tocca per usarlo',
      text: codice,
      onclick: () => {
        const campo = document.getElementById('codice');
        if (campo) {
          campo.value = codice;
          campo.focus();
        }
        navigator.clipboard?.writeText(codice).catch(() => {});
        chiudiPannello();
      },
    }));
}

function contenutoCodici() {
  const [alfa, beta] = dati.aziende;
  return [
    rigaCodice('Ristorante', CODICI.ristorante, 'Aziende, menù, riepiloghi cucina e consegne'),
    rigaCodice(`Referente · ${alfa.nome}`, alfa.referente, 'Persone, stato ordini, stand-by, pasti extra'),
    rigaCodice(`Dipendente · ${alfa.nome}`, alfa.dipendenti, `Scegli un nome, PIN ${CODICI.pin}`),
    rigaCodice(`Referente · ${beta.nome}`, beta.referente, 'Azienda con regole diverse: 2 piatti al giorno'),
    rigaCodice(`Dipendente · ${beta.nome}`, beta.dipendenti, `Scegli un nome, PIN ${CODICI.pin}`),
  ];
}

let pannello = null;
function chiudiPannello() {
  pannello?.remove();
  pannello = null;
}

function apriPannello(primaVolta = false) {
  chiudiPannello();
  pannello = h('div', { class: 'demo-fondo', onclick: (e) => { if (e.target === pannello) chiudiPannello(); } },
    h('div', { class: 'demo-pannello' },
      h('h2', { text: 'Dimostrazione' }),
      primaVolta
        ? h('p', { class: 'demo-intro', text: 'Questa è l’app vera, che gira tutta dentro il telefono: i dati sono finti e si azzerano ricaricando la pagina. Scegli con quale ruolo entrare.' })
        : h('p', { class: 'demo-intro', text: 'I codici da provare. I dati si azzerano ricaricando la pagina.' }),
      h('div', { class: 'demo-elenco' }, contenutoCodici()),
      h('p', { class: 'demo-nota', text: `Gli ordini sono aperti per la settimana ${dati.settimana}: è lì che atterra il dipendente. Quella corrente è già chiusa dalla scadenza del venerdì — si vede, non si modifica.` }),
      h('button', { class: 'btn btn-primary btn-block', text: 'Chiudi', onclick: chiudiPannello })));
  document.body.append(pannello);
}

document.body.append(h('button', { class: 'demo-badge', text: 'DEMO · codici', onclick: () => apriPannello(false) }));

await import('../public/app.js');
apriPannello(true);
