/**
 * MES Pizzami - logica dell'interfaccia tablet.
 * Una sola schermata: scansione -> scheda bancale -> avanzamento di stato.
 */
import { parseGs1, GS } from '/gs1/parser.js';

const $ = (sel) => document.querySelector(sel);
const el = {
  plantName: $('#plantName'),
  scannerState: $('#scannerState'),
  operatorBtn: $('#operatorBtn'),
  operatorOverlay: $('#operatorOverlay'),
  operatorGrid: $('#operatorGrid'),
  scanInput: $('#scanInput'),
  scanBtn: $('#scanBtn'),
  examplesBtn: $('#examplesBtn'),
  examplesOverlay: $('#examplesOverlay'),
  examplesList: $('#examplesList'),
  examplesCloseBtn: $('#examplesCloseBtn'),
  banner: $('#banner'),
  resultArea: $('#resultArea'),
  recentList: $('#recentList'),
  refreshRecentBtn: $('#refreshRecentBtn'),
};

const state = {
  meta: null,
  user: null,
  lastRaw: '',       // ultimo barcode letto (serve per "Registra bancale")
  current: null,     // ultima risposta di /api/scan o dettaglio bancale
  busy: false,
};

const EXAMPLES = [
  ['Bancale PRODOTTO – Pizza Margherita', '(00)380999990000000019(01)18099999000015(15)270915(3103)126000(10)L260915A(37)60'],
  ['Bancale misto (2 lotti) – Pizza Margherita', '(00)380999990000000026(01)18099999000015(15)270915(10)L260915A'],
  ['Bancale PRENOTATO – Pizza 4 Formaggi', '(00)380999990000000033(01)18099999000022(15)270915(10)L260915B(37)60'],
  ['Bancale PRODOTTO – Pinsa fresca (scadenza)', '(00)380999990000000040(01)18099999000039(11)260916(17)261016(10)L260916A(37)80'],
  ['Bancale SPEDITO – Pane in cassetta', '(00)380999990000000057(01)18099999000046(11)260914(17)261005(10)L260914A(37)72'],
  ['Bancale DA PRODURRE – Focaccia', '(00)380999990000000064(01)18099999000053(15)270917(10)L260917A(37)48'],
  ['SSCC nuovo: registra bancale – Focaccia', '(00)380999990000000071(01)18099999000053(15)270914(3103)153600(10)L260914A(37)48'],
  ['SSCC nuovo: registra bancale – Pinsa fresca', '(00)380999990000000088(01)18099999000039(11)260917(17)261017(10)L260917B(37)80'],
  ['Errore: check digit SSCC sbagliato', '(00)380999990000000018(01)18099999000015(10)L260915A'],
  ['Errore: GTIN non in anagrafica', '(00)380999990000000071(01)18099999000060(10)L260917X'],
  ['Etichetta di collo senza SSCC', '(01)18099999000015(15)270915(10)L260915A'],
  ['Errore: AI sconosciuto', '(00)380999990000000019(99)ABC'],
  ['Stringa grezza del lettore (con ]C1 e GS)', ']C1' + '00380999990000000019' + '0118099999000015' + '15270915' + '3103126000' + '10L260915A' + GS + '3760'],
];

// ---------- utilità ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDate(iso) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtSscc(sscc) {
  if (!sscc || sscc.length !== 18) return esc(sscc);
  return `${sscc[0]} ${sscc.slice(1, 8)} ${sscc.slice(8, 17)} ${sscc[17]}`;
}
function fmtKg(v) { return v == null ? '—' : `${Number(v).toLocaleString('it-IT', { maximumFractionDigits: 3 })} kg`; }

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* corpo vuoto */ }
  if (!res.ok) throw new Error(data?.error || `Errore ${res.status}`);
  return data;
}

// ---------- segnali acustici ----------
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = kind === 'ok' ? [[880, 0, 0.12]] : kind === 'warn' ? [[660, 0, 0.15], [660, 0.2, 0.15]] : [[220, 0, 0.25], [220, 0.3, 0.25]];
    for (const [freq, start, dur] of tones) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = 'square';
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + start);
      osc.stop(audioCtx.currentTime + start + dur);
    }
  } catch { /* audio non disponibile */ }
}

// ---------- focus sempre sul campo di scansione ----------
function focusScan() {
  if (!el.operatorOverlay.classList.contains('hidden')) return;
  if (!el.examplesOverlay.classList.contains('hidden')) return;
  if (document.activeElement && document.activeElement.matches('input[data-keep-focus]')) return;
  el.scanInput.focus();
}
document.addEventListener('click', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  setTimeout(focusScan, 0);
});
window.addEventListener('focus', () => setTimeout(focusScan, 0));
el.scanInput.addEventListener('focus', () => { el.scannerState.textContent = '● Lettore pronto'; el.scannerState.classList.remove('off'); });
el.scanInput.addEventListener('blur', () => { el.scannerState.textContent = '○ Tocca il campo di scansione'; el.scannerState.classList.add('off'); });

// Il lettore invia il separatore GS come Ctrl+] : lo trasformiamo nel carattere ASCII 29
el.scanInput.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = el.scanInput;
    el.scanInput.value = value.slice(0, s) + GS + value.slice(en);
    el.scanInput.setSelectionRange(s + 1, s + 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    submitScan();
  }
});
el.scanBtn.addEventListener('click', submitScan);

// ---------- banner ----------
function showBanner(kind, title, detail) {
  el.banner.className = `banner ${kind}`;
  const icon = kind === 'ok' ? '✔' : kind === 'warn' ? '!' : '✖';
  el.banner.innerHTML = `<span class="icon">${icon}</span><div><div>${esc(title)}</div>${detail ? `<div class="detail">${detail}</div>` : ''}</div>`;
  beep(kind);
}
function hideBanner() { el.banner.className = 'banner hidden'; }

// ---------- operatori ----------
function renderOperators() {
  el.operatorGrid.innerHTML = state.meta.users.map((u) => `
    <button type="button" class="btn btn-ghost" data-user="${u.userId}">
      <span>${esc(u.fullName)}</span><small>${esc(u.role)}</small>
    </button>`).join('');
  el.operatorGrid.querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', () => {
    const user = state.meta.users.find((u) => u.userId === Number(b.dataset.user));
    setUser(user);
  }));
}
function setUser(user) {
  state.user = user;
  try { sessionStorage.setItem('mes.userId', String(user.userId)); } catch { /* ignora */ }
  el.operatorBtn.textContent = `Operatore: ${user.fullName}`;
  el.operatorOverlay.classList.add('hidden');
  focusScan();
}
el.operatorBtn.addEventListener('click', () => el.operatorOverlay.classList.remove('hidden'));

// ---------- esempi ----------
function renderExamples() {
  el.examplesList.innerHTML = EXAMPLES.map(([label, code], i) => `
    <button type="button" class="example-item" data-example="${i}">
      <span>${esc(label)}</span><span class="code">${esc(code.replace(GS, '<GS>'))}</span>
    </button>`).join('');
  el.examplesList.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => {
    el.examplesOverlay.classList.add('hidden');
    el.scanInput.value = EXAMPLES[Number(b.dataset.example)][1];
    submitScan();
  }));
}
el.examplesBtn.addEventListener('click', () => el.examplesOverlay.classList.remove('hidden'));
el.examplesCloseBtn.addEventListener('click', () => { el.examplesOverlay.classList.add('hidden'); focusScan(); });

// ---------- scansione ----------
async function submitScan() {
  const raw = el.scanInput.value;
  if (!raw.trim() || state.busy) return;
  el.scanInput.value = '';
  state.lastRaw = raw;
  state.busy = true;
  el.scanBtn.disabled = true;
  // La scheda precedente sparisce subito: dopo una nuova scansione l'operatore non
  // deve poter premere per sbaglio un pulsante del bancale letto prima.
  el.resultArea.innerHTML = '';
  state.current = null;
  try {
    const local = parseGs1(raw);   // feedback immediato anche prima della risposta del server
    if (!local.ok) showBanner('err', 'Barcode non valido', local.errors.map((e) => esc(e.message)).join('<br>'));

    const data = await api('/api/scan', { method: 'POST', body: { raw, userId: state.user?.userId ?? null } });
    state.current = data;
    renderScanResult(data);
  } catch (err) {
    showBanner('err', 'Errore di comunicazione', esc(err.message));
  } finally {
    state.busy = false;
    el.scanBtn.disabled = false;
    focusScan();
  }
}

function renderScanResult(data) {
  const f = data.parse.fields;
  switch (data.outcome) {
    case 'invalid':
      showBanner('err', 'Barcode non valido', data.parse.errors.map((e) => esc(e.message)).join('<br>'));
      el.resultArea.innerHTML = renderAiDetails(data.parse, true);
      break;
    case 'found':
      showBanner('ok', 'Bancale trovato', `${esc(data.pallet.productDescription)} · stato <b>${esc(data.pallet.statusName)}</b>`);
      el.resultArea.innerHTML = renderPalletCard(data) + renderAiDetails(data.parse, false);
      bindPalletActions();
      break;
    case 'new':
      showBanner('warn', 'Bancale non ancora registrato', `SSCC ${esc(f.sscc)} non presente. Puoi registrarlo adesso.`);
      el.resultArea.innerHTML = renderNewPalletCard(data) + renderAiDetails(data.parse, false);
      bindNewPalletActions();
      break;
    case 'unknown-product':
      showBanner('err', 'Articolo non in anagrafica', `GTIN ${esc(f.gtin ?? f.gtinContained ?? '—')} sconosciuto: verificare l'anagrafica prodotto.`);
      el.resultArea.innerHTML = renderAiDetails(data.parse, true);
      break;
    case 'no-sscc':
      showBanner('warn', 'Non è un bancale', 'Il barcode non contiene un SSCC (00): probabilmente è un\'etichetta di collo.');
      el.resultArea.innerHTML = renderAiDetails(data.parse, true);
      break;
    default:
      showBanner('err', 'Risposta non riconosciuta');
  }
}

function renderAiDetails(parse, open) {
  if (!parse.elements.length) return '';
  const rows = parse.elements.map((e) => `
    <tr><td class="mono">(${esc(e.ai)})</td><td>${esc(e.title)}</td><td class="mono">${esc(e.value)}</td>
        <td>${e.parsed == null ? '<span class="muted">non valido</span>' : esc(typeof e.parsed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.parsed) ? fmtDate(e.parsed) : e.parsed)}</td></tr>`).join('');
  return `
    <div class="card">
      <details class="ai-details" ${open ? 'open' : ''}>
        <summary>Dettaglio barcode (Application Identifier)</summary>
        <table class="tbl"><thead><tr><th>AI</th><th>Campo</th><th>Valore letto</th><th>Interpretato</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="muted" style="font-size:0.9rem">${esc(parse.humanReadable)}</div>
      </details>
    </div>`;
}

// ---------- scheda bancale ----------
function renderPalletCard(data) {
  const p = data.pallet;
  const lots = data.lots.map((l) => `
    <tr><td class="mono">${esc(l.lotNumber)}</td><td>${fmtDate(l.productionDate)}</td>
        <td>${l.bestBeforeDate ? 'TMC ' + fmtDate(l.bestBeforeDate) : l.expiryDate ? 'Scad. ' + fmtDate(l.expiryDate) : '—'}</td>
        <td class="num">${esc(l.cases)}</td></tr>`).join('');

  const actions = p.statusIsFinal
    ? `<div class="final-note">Bancale in stato finale <b>${esc(p.statusName)}</b>: nessuna operazione disponibile.</div>`
    : data.transitions.length === 0
      ? '<div class="final-note">Nessuna transizione ammessa da questo stato.</div>'
      : `<div class="actions">${data.transitions.map((t) => `
           <button type="button" class="btn btn-primary btn-big" data-transition="${esc(t.toStatusCode)}">
             ${esc(t.actionName)}<small>→ ${esc(t.toStatusName)}</small>
           </button>`).join('')}</div>
         <div class="notes-row"><input id="notesInput" data-keep-focus type="text" maxlength="400" placeholder="Note (facoltative): ordine, DDT, motivo…"></div>`;

  const log = data.log.map((g) => `
    <li><span class="when">${fmtDateTime(g.loggedAt)}</span>
        <span class="what">${g.fromStatusName ? esc(g.fromStatusName) + ' → ' : ''}${esc(g.toStatusName)}
          <span class="who"> · ${esc(g.userFullName)}</span>
          ${g.notes ? `<span class="note">${esc(g.notes)}</span>` : ''}</span></li>`).join('');

  return `
    <div class="card" id="palletCard" data-pallet-id="${p.palletId}">
      <div class="pallet-head">
        <div class="sscc">${fmtSscc(p.sscc)}<small>SSCC</small></div>
        <span class="pill ${esc(p.statusCode)}">${esc(p.statusName)}</span>
      </div>
      <div class="product-title">${esc(p.productDescription)}</div>
      <div class="muted">${esc(p.productCode)} · GTIN ${esc(p.gtin)} · ${esc(p.formatName)} · ${esc(p.storageTypeName)}</div>
      <div class="facts">
        <div class="fact"><div class="k">Colli sul bancale</div><div class="v">${esc(p.totalCases)}${p.expectedCases ? ` <span class="muted">/ ${esc(p.expectedCases)}</span>` : ''}</div></div>
        <div class="fact"><div class="k">Pezzi</div><div class="v">${p.piecesPerCase ? esc(p.totalCases * p.piecesPerCase) : '—'}</div></div>
        <div class="fact"><div class="k">Lotti</div><div class="v">${esc(p.lotCount)}</div></div>
        <div class="fact"><div class="k">Peso netto</div><div class="v">${fmtKg(p.netWeightKg)}</div></div>
      </div>
      <table class="tbl"><thead><tr><th>Lotto</th><th>Produzione</th><th>TMC / Scadenza</th><th class="num">Colli</th></tr></thead><tbody>${lots}</tbody></table>
      ${actions}
      <h2 style="margin-top:18px">Storico</h2>
      <ul class="log">${log || '<li><span class="muted">Nessuna transizione registrata</span></li>'}</ul>
    </div>`;
}

function bindPalletActions() {
  const card = $('#palletCard');
  if (!card) return;
  card.querySelectorAll('[data-transition]').forEach((b) => b.addEventListener('click', () => doTransition(Number(card.dataset.palletId), b.dataset.transition)));
  const notes = $('#notesInput');
  if (notes) notes.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusScan(); } });
}

async function doTransition(palletId, toStatusCode) {
  if (!state.user) { el.operatorOverlay.classList.remove('hidden'); return; }
  if (state.busy) return;
  state.busy = true;
  const before = state.current?.pallet?.statusName;
  try {
    const notes = $('#notesInput')?.value ?? '';
    const detail = await api(`/api/pallets/${palletId}/transition`, { method: 'POST', body: { toStatusCode, userId: state.user.userId, notes } });
    state.current = { ...state.current, ...detail, outcome: 'found' };
    showBanner('ok', 'Stato aggiornato', `${esc(before)} → <b>${esc(detail.pallet.statusName)}</b> · ${esc(state.user.fullName)}`);
    el.resultArea.innerHTML = renderPalletCard(detail) + (state.current.parse ? renderAiDetails(state.current.parse, false) : '');
    bindPalletActions();
    loadRecent();
  } catch (err) {
    showBanner('err', 'Operazione rifiutata', esc(err.message));
  } finally {
    state.busy = false;
    focusScan();
  }
}

// ---------- registrazione nuovo bancale ----------
function renderNewPalletCard(data) {
  const f = data.parse.fields;
  const p = data.product;
  const cases = f.caseCount ?? p.casesPerPallet ?? '';
  return `
    <div class="card" id="newPalletCard">
      <div class="pallet-head">
        <div class="sscc">${fmtSscc(f.sscc)}<small>SSCC – nuovo</small></div>
        <span class="pill">NON REGISTRATO</span>
      </div>
      <div class="product-title">${esc(p.description)}</div>
      <div class="muted">${esc(p.code)} · GTIN ${esc(p.gtin)} · ${esc(p.formatName)} · ${esc(p.storageTypeName)}</div>
      <div class="facts">
        <div class="fact"><div class="k">Lotto</div><div class="v mono">${esc(f.lot ?? '—')}</div></div>
        <div class="fact"><div class="k">Produzione</div><div class="v">${fmtDate(f.productionDate)}</div></div>
        <div class="fact"><div class="k">${f.expiryDate ? 'Scadenza' : 'TMC'}</div><div class="v">${fmtDate(f.expiryDate ?? f.bestBeforeDate)}</div></div>
        <div class="fact"><div class="k">Peso netto</div><div class="v">${fmtKg(f.netWeightKg)}</div></div>
      </div>
      ${f.lot ? '' : '<div class="final-note">Il barcode non contiene il lotto (10): impossibile registrare.</div>'}
      <div class="notes-row">
        <label for="casesInput">Colli</label>
        <input id="casesInput" data-keep-focus type="number" min="1" step="1" value="${esc(cases)}" style="flex:0 0 140px">
        <input id="newNotesInput" data-keep-focus type="text" maxlength="400" placeholder="Note (facoltative)">
      </div>
      <div class="actions">
        <button type="button" class="btn btn-ok btn-big" id="registerBtn" ${f.lot ? '' : 'disabled'}>
          Registra bancale<small>stato iniziale: ${esc(state.meta?.initialStatus ?? 'PRODOTTO')}</small>
        </button>
      </div>
    </div>`;
}

function bindNewPalletActions() {
  $('#registerBtn')?.addEventListener('click', registerPallet);
}

async function registerPallet() {
  if (!state.user) { el.operatorOverlay.classList.remove('hidden'); return; }
  if (state.busy) return;
  state.busy = true;
  try {
    const detail = await api('/api/pallets/register', {
      method: 'POST',
      body: { raw: state.lastRaw, userId: state.user.userId, cases: $('#casesInput')?.value, notes: $('#newNotesInput')?.value ?? '' },
    });
    state.current = { ...state.current, ...detail, outcome: 'found' };
    showBanner('ok', 'Bancale registrato', `${esc(detail.pallet.productDescription)} · stato <b>${esc(detail.pallet.statusName)}</b>`);
    el.resultArea.innerHTML = renderPalletCard(detail) + (state.current.parse ? renderAiDetails(state.current.parse, false) : '');
    bindPalletActions();
    loadRecent();
  } catch (err) {
    showBanner('err', 'Registrazione rifiutata', esc(err.message));
  } finally {
    state.busy = false;
    focusScan();
  }
}

// ---------- elenco ultimi bancali ----------
async function loadRecent() {
  try {
    const list = await api('/api/pallets?limit=12');
    el.recentList.innerHTML = list.map((p) => `
      <button type="button" class="recent-item" data-pallet="${p.palletId}">
        <div class="row"><span class="sscc-small">${esc(p.sscc)}</span><span class="pill ${esc(p.statusCode)}">${esc(p.statusName)}</span></div>
        <span class="desc">${esc(p.productDescription)}</span>
        <span class="muted" style="font-size:0.85rem">${esc(p.totalCases)} colli · ${esc(p.lotCount)} ${p.lotCount === 1 ? 'lotto' : 'lotti'}</span>
      </button>`).join('') || '<div class="muted">Nessun bancale</div>';
    el.recentList.querySelectorAll('[data-pallet]').forEach((b) => b.addEventListener('click', () => openPallet(Number(b.dataset.pallet))));
  } catch (err) {
    el.recentList.innerHTML = `<div class="muted">Elenco non disponibile: ${esc(err.message)}</div>`;
  }
}
el.refreshRecentBtn.addEventListener('click', loadRecent);

async function openPallet(palletId) {
  try {
    const detail = await api(`/api/pallets/${palletId}`);
    state.current = { ...detail, outcome: 'found', parse: null };
    hideBanner();
    el.resultArea.innerHTML = renderPalletCard(detail);
    bindPalletActions();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    showBanner('err', 'Bancale non disponibile', esc(err.message));
  } finally {
    focusScan();
  }
}

// ---------- avvio ----------
async function init() {
  renderExamples();
  try {
    state.meta = await api('/api/meta');
    el.plantName.textContent = `${state.meta.tenant.name} · ${state.meta.plant.name}`;
    renderOperators();
    let savedId = null;
    try { savedId = Number(sessionStorage.getItem('mes.userId')); } catch { /* ignora */ }
    const saved = state.meta.users.find((u) => u.userId === savedId);
    if (saved) setUser(saved);
    loadRecent();
  } catch (err) {
    el.operatorOverlay.classList.add('hidden');
    showBanner('err', 'Server non raggiungibile', esc(err.message));
  }
  focusScan();
}

init();
