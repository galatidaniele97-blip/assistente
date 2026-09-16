// Interfaccia Mensa. Nessuna dipendenza esterna, nessun innerHTML: tutto costruito nel DOM.

import { currentWeek, shiftWeek, weekLabel, dayLabel, GIORNI_BREVI } from './shared/week.js';
import { simulaAggiunta } from './shared/regole.js';
import { firstOpenWeek, isLocked, deadlineLabel, GIORNI_SETTIMANA } from './shared/scadenza.js';
import { leggiGriglia, leggiPersone } from './shared/importa.js';

const DAYS = [1, 2, 3, 4, 5];
const TOKEN_KEY = 'mensa.token';

const store = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  role: null,
  name: '',
  employee: null,
  week: currentWeek(),
  tab: '',
  appName: '',
  deadline: null,
  companyId: null,
};

// ── Costruzione DOM ───────────────────────────────────────────────────────────

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const main = () => document.getElementById('main');

function paint(...nodes) {
  const target = main();
  target.replaceChildren(...nodes.flat().filter(Boolean));
  return target;
}

let toastTimer = null;
function toast(message, isError = false) {
  document.querySelector('.toast')?.remove();
  const node = h('div', { class: isError ? 'toast error' : 'toast', role: 'status', text: message });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), isError ? 5000 : 2600);
}

function dialog(title, content, actions) {
  const box = h('dialog', {}, h('h2', { text: title }), h('div', { class: 'stack', style: 'margin:14px 0' }, content),
    h('div', { class: 'row', style: 'justify-content:flex-end;flex-wrap:wrap' }, actions));
  document.body.append(box);
  box.addEventListener('close', () => box.remove());
  box.showModal();
  return box;
}

function confirmBox(message, confirmLabel = 'Conferma') {
  return new Promise((resolve) => {
    const box = dialog('Confermi?', h('p', { text: message }), [
      h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => { box.close(); resolve(false); } }),
      h('button', { class: 'btn btn-small btn-danger', text: confirmLabel, onclick: () => { box.close(); resolve(true); } }),
    ]);
  });
}

// ── Chiamate al server ────────────────────────────────────────────────────────

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (store.token) init.headers.authorization = `Bearer ${store.token}`;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  // Un 401 significa "sessione da rifare", tranne dove è la credenziale stessa a
  // essere sbagliata (PIN errato): lì si resta dove si è e si riprova.
  if (response.status === 401 && !path.startsWith('/api/staff/identify')) {
    logout(payload.error || 'Sessione scaduta.');
    throw new Error(payload.error || 'Sessione scaduta.');
  }
  if (!response.ok) throw new Error(payload.error || 'Operazione non riuscita.');
  return payload;
}

async function download(path, filename) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${store.token}` } });
  if (!response.ok) {
    toast('Scaricamento non riuscito.', true);
    return;
  }
  const url = URL.createObjectURL(await response.blob());
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function guard(action) {
  try {
    await action();
  } catch (error) {
    toast(error.message, true);
    // Se il nominativo non è più valido si torna all'elenco invece di restare bloccati.
    if (store.role === 'staff' && store.employee && /nominativo/i.test(error.message)) {
      store.employee = null;
      renderTopbar();
      viewStaffPick().catch(() => {});
    }
  }
}

function logout(message) {
  localStorage.removeItem(TOKEN_KEY);
  store.token = '';
  store.role = null;
  store.employee = null;
  store.tab = '';
  renderTopbar();
  viewLogin(message).catch(() => {});
}

// ── Barra superiore ───────────────────────────────────────────────────────────

const ROLE_LABEL = { admin: 'Ristorante', manager: 'Referente aziendale', staff: 'Il mio ordine' };

function renderTopbar() {
  document.body.classList.toggle('admin', store.role === 'admin');
  const bar = document.getElementById('topbar');
  if (!store.role) {
    bar.className = '';
    bar.replaceChildren();
    return;
  }
  bar.className = 'topbar no-print';
  bar.replaceChildren(
    h('div', { class: 'topbar-inner' },
      h('div', { class: 'grow' },
        h('div', { class: 'who truncate', text: store.employee ? store.employee.name : store.name }),
        h('div', { class: 'sub truncate', text: store.employee ? store.name : ROLE_LABEL[store.role] })),
      store.role === 'staff' && store.employee
        ? h('button', { text: 'Cambia nome', onclick: () => { store.employee = null; renderTopbar(); guard(viewStaffPick); } })
        : null,
      h('button', { text: 'Esci', onclick: () => logout() }))
  );
}

function setSubmitbar(...nodes) {
  const bar = document.getElementById('submitbar');
  if (!nodes.length) {
    bar.className = '';
    bar.replaceChildren();
    return;
  }
  bar.className = 'submitbar no-print';
  bar.replaceChildren(h('div', { class: 'submitbar-inner' }, nodes));
}

function weekBar(onChange, extra) {
  return h('div', { class: 'weekbar no-print', style: 'margin-top:12px' },
    h('button', { 'aria-label': 'Settimana precedente', text: '‹', onclick: () => onChange(-1) }),
    h('div', { class: 'label' },
      h('strong', { text: weekLabel(store.week) }),
      h('span', { text: store.week === currentWeek() ? 'Settimana corrente' : `Settimana ${store.week.slice(6)}` })),
    h('button', { 'aria-label': 'Settimana successiva', text: '›', onclick: () => onChange(1) }),
    extra || null);
}

// ── Accesso ───────────────────────────────────────────────────────────────────

async function boot() {
  if (!store.token) {
    const status = await api('/api/status');
    if (!status.ready) return viewSetup();
    return viewLogin();
  }
  try {
    const me = await api('/api/me');
    store.role = me.role;
    store.name = me.name;
    store.employee = me.employee || null;
    store.companyId = me.companyId || null;
    store.deadline = me.deadline || null;
    if (store.role === 'staff') store.week = firstOpenWeek(currentWeek(), store.deadline, shiftWeek);
    renderTopbar();
    await routeByRole();
  } catch {
    /* logout() ha già mostrato la schermata di accesso */
  }
}

function routeByRole() {
  if (store.role === 'admin') return viewAdmin();
  if (store.role === 'manager') return viewManager();
  return store.employee ? viewStaffOrder() : viewStaffPick();
}

function viewSetup() {
  setSubmitbar();
  const nome = h('input', { class: 'field', id: 'setup-nome', placeholder: 'Trattoria Da Noi', autocomplete: 'off' });
  const codice = h('input', { class: 'field code-input', id: 'setup-codice', maxlength: '12', autocomplete: 'off' });
  const installazione = h('input', { class: 'field', id: 'setup-install', autocomplete: 'off', placeholder: 'Solo se è stato impostato SETUP_CODE' });
  paint(h('div', { class: 'login' },
    h('img', { class: 'logo-img', src: '/icona.svg', alt: '', width: '64', height: '64' }),
    h('h1', { text: 'Primo avvio' }),
    h('p', { class: 'claim', text: 'Imposta il nome del ristorante e il codice con cui accederai.' }),
    h('div', { class: 'stack' },
      h('div', {}, h('label', { for: 'setup-nome', text: 'Nome del ristorante' }), nome),
      h('div', {}, h('label', { for: 'setup-codice', text: 'Codice del ristorante (almeno 6 caratteri)' }), codice),
      h('div', {}, h('label', { for: 'setup-install', text: 'Codice di installazione' }), installazione),
      h('button', {
        class: 'btn btn-primary btn-block',
        text: 'Crea',
        onclick: () => guard(async () => {
          const result = await api('/api/setup', { method: 'POST', body: { name: nome.value, code: codice.value, setupCode: installazione.value } });
          toast(`Codice del ristorante: ${result.code}`);
          store.appName = result.name;
          await viewLogin(`Conserva il codice ${result.code}: serve per accedere.`);
        }),
      }))));
}

async function viewLogin(message) {
  setSubmitbar();
  if (!store.appName) {
    // Il nome del ristorante rende la schermata riconoscibile a chi la apre.
    try {
      store.appName = (await api('/api/status')).name || 'Mensa';
    } catch {
      store.appName = 'Mensa';
    }
  }
  const codice = h('input', {
    class: 'field code-input',
    id: 'codice',
    autocomplete: 'one-time-code',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: '12',
    'aria-label': 'Codice di accesso',
  });
  const entra = () => guard(async () => {
    const result = await api('/api/login', { method: 'POST', body: { code: codice.value } });
    store.token = result.token;
    localStorage.setItem(TOKEN_KEY, result.token);
    store.role = result.role;
    store.name = result.name;
    store.employee = null;
    store.deadline = result.deadline || null;
    // Il dipendente ordina per la prossima settimana ancora aperta: è lì che deve atterrare.
    store.week = result.role === 'staff' ? firstOpenWeek(currentWeek(), store.deadline, shiftWeek) : currentWeek();
    renderTopbar();
    await routeByRole();
  });
  codice.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') entra();
  });
  // Il referente manda in chat un link con il codice già dentro: si entra con un tocco.
  const dalLink = new URLSearchParams(location.search).get('c');
  if (dalLink && !message) {
    codice.value = dalLink;
    history.replaceState(null, '', location.pathname);
    setTimeout(entra, 50);
  }
  paint(h('div', { class: 'login' },
    h('img', { class: 'logo-img', src: '/icona.svg', alt: '', width: '64', height: '64' }),
    h('h1', { text: store.appName }),
    h('p', { class: 'claim', text: 'Inserisci il codice che ti è stato consegnato.' }),
    message ? h('div', { class: 'notice', style: 'margin-bottom:14px', text: message }) : null,
    h('div', { class: 'stack' },
      codice,
      h('button', { class: 'btn btn-primary btn-block', text: 'Entra', onclick: entra }))));
  codice.focus();
}

// ── Dipendente: scelta del nome ───────────────────────────────────────────────

/**
 * Il PIN personale: al primo accesso lo si sceglie, poi lo si inserisce.
 * È quello che permette di mandare il link in una chat di gruppo senza che
 * chiunque possa ordinare a nome di un collega.
 */
function pinDialog(employee) {
  const campo = (placeholder, extra = {}) =>
    h('input', { class: 'field code-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '6', placeholder, ...extra });
  const pin = campo(employee.hasPin ? 'PIN' : 'Scegli un PIN (4-6 cifre)');
  const conferma = employee.hasPin ? null : campo('Ripeti il PIN');
  const entra = h('button', { class: 'btn btn-small btn-primary', text: 'Entra' });
  const box = dialog(`Ciao, ${employee.name.split(' ')[0]}`,
    [
      h('p', { class: 'small muted', text: employee.hasPin
        ? 'Inserisci il tuo PIN.'
        : 'È il tuo primo accesso: scegli un PIN di 4-6 cifre. Ti servirà ogni volta che entri, e nessun altro potrà ordinare a nome tuo.' }),
      pin,
      conferma,
      employee.hasPin ? h('p', { class: 'small muted', text: 'PIN dimenticato? Il referente della tua azienda può azzerarlo.' }) : null,
    ],
    [h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }), entra]);
  const invia = () => guard(async () => {
    if (!employee.hasPin && pin.value !== conferma.value) {
      toast('I due PIN non coincidono.', true);
      return;
    }
    const body = employee.hasPin ? { employeeId: employee.id, pin: pin.value } : { employeeId: employee.id, newPin: pin.value };
    const result = await api('/api/staff/identify', { method: 'POST', body });
    box.close();
    store.token = result.token;
    localStorage.setItem(TOKEN_KEY, result.token);
    store.employee = result.employee;
    renderTopbar();
    await viewStaffOrder();
  });
  entra.addEventListener('click', invia);
  for (const campoPin of [pin, conferma]) campoPin?.addEventListener('keydown', (e) => { if (e.key === 'Enter') invia(); });
  pin.focus();
}

async function viewStaffPick() {
  setSubmitbar();
  const data = await api('/api/staff/employees');
  store.name = data.company;
  renderTopbar();
  const letters = [...new Set(data.employees.map((e) => e.name.trim().charAt(0).toUpperCase()))].sort((a, b) =>
    a.localeCompare(b, 'it')
  );
  let filter = '';

  const names = h('div', { class: 'names' });
  const renderNames = () => {
    const visible = data.employees.filter((e) => !filter || e.name.trim().charAt(0).toUpperCase() === filter);
    names.replaceChildren(...visible.map((employee) =>
      h('button', {
        class: 'name-btn',
        onclick: () => pinDialog(employee),
      },
        h('span', { class: 'locker-badge', text: employee.locker }),
        h('span', { class: 'grow truncate', text: employee.name }))));
    if (!visible.length) names.replaceChildren(h('p', { class: 'muted', text: 'Nessun nominativo in questo gruppo.' }));
  };

  const alpha = h('div', { class: 'alpha' });
  const renderAlpha = () => {
    alpha.replaceChildren(
      h('button', { text: 'Tutti', 'aria-pressed': filter === '' ? 'true' : 'false', onclick: () => { filter = ''; renderAlpha(); renderNames(); } }),
      ...letters.map((letter) =>
        h('button', {
          text: letter,
          'aria-pressed': filter === letter ? 'true' : 'false',
          onclick: () => { filter = filter === letter ? '' : letter; renderAlpha(); renderNames(); },
        })));
  };
  renderAlpha();
  renderNames();

  paint(
    h('div', { class: 'card', style: 'margin-top:16px' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Chi sei?' })),
      h('p', { class: 'muted small', text: 'Tocca il tuo nome. Se non lo trovi, avvisa il referente della tua azienda.' }),
      data.employees.length > 12 ? alpha : null,
      names));
}

// ── Dipendente: ordine della settimana ────────────────────────────────────────

function serializeSelection(selection) {
  return JSON.stringify(DAYS.map((day) => [day, selection[day].skip, [...selection[day].items].sort((a, b) => a - b)]));
}

async function viewStaffOrder() {
  const data = await api(`/api/staff/week?week=${store.week}`);
  store.name = data.company;
  store.employee = data.employee;
  renderTopbar();

  const byId = new Map(data.menu.map((item) => [item.id, item]));
  const infoDi = (id) => byId.get(id);
  const selection = {};
  for (const day of DAYS) {
    const saved = data.order?.days?.[day];
    selection[day] = { skip: !!saved?.skip, items: (saved?.items ?? []).filter((id) => byId.has(id)) };
  }
  let baseline = serializeSelection(selection);
  const dayNodes = new Map();
  const piattiDi = (day, courseId) => data.menu.filter((i) => i.day === day && i.courseId === courseId);

  const chiusa = data.deadline.locked;

  const refreshBar = () => {
    if (chiusa) {
      setSubmitbar(
        h('div', { class: 'state', text: `Ordini chiusi ${data.deadline.label}` }),
        h('button', { class: 'btn btn-primary', text: 'Settimana chiusa', disabled: true }));
      return;
    }
    const dirty = serializeSelection(selection) !== baseline;
    const scelti = DAYS.filter((day) => selection[day].items.length > 0).length;
    const saltati = DAYS.filter((day) => selection[day].skip).length;
    const state = dirty
      ? `${scelti} ${scelti === 1 ? 'giorno scelto' : 'giorni scelti'}${saltati ? `, ${saltati} senza pranzo` : ''}`
      : data.order
        ? `Inviato ${formatStamp(data.order.updatedAt)}`
        : 'Nessun ordine inviato per questa settimana';
    setSubmitbar(
      h('div', { class: 'state', text: state }),
      h('button', {
        class: 'btn btn-primary',
        text: dirty ? 'Invia ordine' : 'Ordine inviato',
        disabled: !dirty,
        onclick: () => guard(async () => {
          const body = {
            week: store.week,
            days: DAYS.map((day) => ({ day, skip: selection[day].skip, items: selection[day].items })),
          };
          const result = await api('/api/staff/order', { method: 'POST', body });
          data.order = { updatedAt: result.updatedAt, days: {} };
          baseline = serializeSelection(selection);
          toast('Ordine inviato');
          refreshBar();
        }),
      }));
  };

  const redrawDay = (day) => {
    const fresh = dayCard(day);
    dayNodes.get(day).replaceWith(fresh);
    dayNodes.set(day, fresh);
    refreshBar();
  };

  const dayCard = (day) => {
    const chosen = selection[day];
    const dayMenu = data.menu.filter((item) => item.day === day);
    const unico = chosen.items.map(infoDi).find((item) => item?.single);
    const sospeso = (data.suspended ?? []).includes(day);
    const card = h('section', { class: chosen.skip ? 'card day skipped' : 'card day' },
      h('div', { class: 'day-head' },
        h('h2', { text: dayLabel(store.week, day) }),
        !chosen.skip && dayMenu.length && !chiusa
          ? h('span', {
              class: unico || chosen.items.length >= data.rules.maxDishes ? 'counter full' : 'counter',
              text: unico ? 'piatto unico' : `${chosen.items.length}/${data.rules.maxDishes} piatti`,
            })
          : null,
        dayMenu.length
          ? h('button', {
              class: 'skip-btn',
              'aria-pressed': chosen.skip ? 'true' : 'false',
              disabled: chiusa,
              text: 'Non pranzo',
              onclick: () => {
                chosen.skip = !chosen.skip;
                if (chosen.skip) chosen.items = [];
                redrawDay(day);
              },
            })
          : null));

    if (sospeso) {
      card.append(h('p', { class: 'notice notice-lock', text: 'Il referente ti ha messo in stand-by per questo giorno: il pasto non verrà consegnato. Se è un errore, parla con lui.' }));
    }
    if (!dayMenu.length) {
      card.append(h('p', { class: 'empty-menu', text: chiusa ? 'Nessun menù per questo giorno.' : 'Menù non ancora pubblicato per questo giorno.' }));
      return card;
    }
    if (chosen.skip) {
      card.append(h('p', { class: 'empty-menu', text: 'Hai segnato che non pranzi. Tocca di nuovo per ordinare.' }));
      return card;
    }

    const courses = h('div', { class: 'courses' });
    for (const course of data.courses) {
      const piatti = piattiDi(day, course.id);
      if (!piatti.length) continue;
      const usati = piatti.filter((p) => chosen.items.includes(p.id)).length;
      courses.append(h('div', { class: 'course' },
        h('div', { class: 'course-head' },
          h('h3', { text: course.name }),
          course.max > 1 ? h('span', { class: usati >= course.max ? 'counter full' : 'counter', text: `${usati}/${course.max}` }) : null),
        h('div', { class: 'options' }, piatti.map((item) => {
          const selezionato = chosen.items.includes(item.id);
          const esito = selezionato ? chosen.items : simulaAggiunta(chosen.items, item, data.rules, infoDi);
          return h('button', {
            class: 'opt',
            type: 'button',
            'aria-pressed': selezionato ? 'true' : 'false',
            disabled: chiusa || (!selezionato && esito === null),
            onclick: () => {
              const prossime = simulaAggiunta(chosen.items, item, data.rules, infoDi);
              if (prossime === null) return;
              chosen.items = prossime;
              chosen.skip = false;
              redrawDay(day);
            },
          },
            h('span', { class: 'mark', text: '\u2713' }),
            h('span', { class: 'slot-code', text: item.code }),
            h('span', { class: 'grow' },
              h('span', { text: item.name }),
              item.single ? h('span', { class: 'unico-badge', text: 'piatto unico' }) : null));
        }))));
    }
    card.append(courses);
    return card;
  };

  const days = DAYS.map((day) => {
    const node = dayCard(day);
    dayNodes.set(day, node);
    return node;
  });

  paint(
    weekBar((delta) => {
      if (serializeSelection(selection) !== baseline && !window.confirm('Hai modifiche non inviate. Cambiare settimana?')) return;
      store.week = shiftWeek(store.week, delta);
      guard(viewStaffOrder);
    }),
    chiusa
      ? h('div', { class: 'notice notice-lock', style: 'margin-top:12px' },
          h('strong', { text: 'Settimana chiusa. ' }),
          h('span', { text: `Gli ordini si potevano fare e correggere fino a ${data.deadline.label}. Qui vedi quello che avevi scelto.` }))
      : h('p', { class: 'small muted center', style: 'margin:10px 0 0', text: `Puoi ordinare e correggere fino a ${data.deadline.label}.` }),
    data.menu.length || chiusa ? null : h('div', { class: 'notice', style: 'margin-top:12px', text: 'Il menù di questa settimana non è ancora stato pubblicato.' }),
    days,
    h('div', { class: 'card', style: 'margin-top:16px' },
      h('p', { class: 'small muted', text: 'Puoi correggere quando vuoi: vale sempre l\u2019ultimo invio.' }),
      h('button', {
        class: 'btn btn-small btn-danger',
        text: 'Cancella i miei ordini',
        onclick: () => guard(async () => {
          if (!(await confirmBox('Vengono cancellati tutti i tuoi ordini, di tutte le settimane. L\u2019operazione non è reversibile.', 'Cancella'))) return;
          await api('/api/staff/orders', { method: 'DELETE' });
          toast('Ordini cancellati');
          await viewStaffOrder();
        }),
      })));
  refreshBar();
}

function formatStamp(value) {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Schede ────────────────────────────────────────────────────────────────────

function tabsBar(tabs, current, onSelect) {
  return h('nav', { class: 'tabs no-print' }, tabs.map((tab) =>
    h('button', {
      text: tab.label,
      role: 'tab',
      'aria-selected': tab.key === current ? 'true' : 'false',
      onclick: () => onSelect(tab.key),
    })));
}

// ── Referente aziendale ───────────────────────────────────────────────────────

const MANAGER_TABS = [
  { key: 'persone', label: 'Persone' },
  { key: 'settimana', label: 'Stato ordini' },
  { key: 'consegne', label: 'Consegne' },
];

function viewManager(tab = store.tab || 'persone') {
  store.tab = MANAGER_TABS.some((t) => t.key === tab) ? tab : 'persone';
  setSubmitbar();
  if (store.tab === 'persone') return guard(managerPeople);
  if (store.tab === 'settimana') return guard(managerStatus);
  return guard(managerDelivery);
}

function managerHeader() {
  return tabsBar(MANAGER_TABS, store.tab, (key) => viewManager(key));
}

function employeeDialog(employee, onSaved) {
  const nome = h('input', { class: 'field', value: employee?.name ?? '', autocomplete: 'off', placeholder: 'Nome e cognome' });
  const armadietto = h('input', { class: 'field', value: employee?.locker ?? '', autocomplete: 'off', inputmode: 'numeric', placeholder: 'es. 14' });
  const box = dialog(employee ? 'Modifica persona' : 'Nuova persona',
    [h('div', {}, h('label', { text: 'Nome e cognome' }), nome), h('div', {}, h('label', { text: 'Numero armadietto' }), armadietto)],
    [
      h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }),
      h('button', {
        class: 'btn btn-small btn-primary',
        text: 'Salva',
        onclick: () => guard(async () => {
          const body = { name: nome.value, locker: armadietto.value };
          if (employee) await api(`/api/manager/employees/${employee.id}`, { method: 'PUT', body });
          else await api('/api/manager/employees', { method: 'POST', body });
          box.close();
          toast('Elenco aggiornato');
          await onSaved();
        }),
      }),
    ]);
  nome.focus();
}

async function managerPeople() {
  const data = await api('/api/manager/employees');
  store.name = data.company;
  renderTopbar();
  const list = h('div', { class: 'list' }, data.employees.map((employee) =>
    h('div', { class: employee.active ? 'list-item' : 'list-item inactive' },
      h('span', { class: 'locker-badge', text: employee.locker }),
      // min-width evita che il nome venga schiacciato dai pulsanti: piuttosto vanno a capo loro.
      h('span', { class: 'grow', style: 'min-width:9rem', text: employee.name }),
      employee.active ? null : h('span', { class: 'pill pill-skip', text: 'bloccata' }),
      employee.active && !employee.hasPin ? h('span', { class: 'pill pill-todo', text: 'PIN da scegliere' }) : null,
      h('button', { class: 'btn btn-small', style: 'margin-left:auto', text: 'Modifica', onclick: () => employeeDialog(employee, managerPeople) }),
      h('button', {
        class: 'btn btn-small',
        text: employee.active ? 'Blocca' : 'Riattiva',
        title: employee.active ? 'Non entra più e i suoi pasti non si preparano, finché non la riattivi' : 'Torna in elenco con i suoi ordini',
        onclick: () => guard(async () => {
          await api(`/api/manager/employees/${employee.id}`, { method: 'PUT', body: { name: employee.name, locker: employee.locker, active: !employee.active } });
          toast(employee.active ? `${employee.name} bloccata: niente pasti finché non la riattivi` : `${employee.name} riattivata`);
          await managerPeople();
        }),
      }),
      employee.hasPin ? h('button', {
        class: 'btn btn-small',
        text: 'Azzera PIN',
        onclick: () => guard(async () => {
          if (!(await confirmBox(`Azzerare il PIN di ${employee.name}? Al prossimo accesso ne sceglierà uno nuovo.`, 'Azzera'))) return;
          await api(`/api/manager/employees/${employee.id}/pin/reset`, { method: 'POST' });
          toast('PIN azzerato');
          await managerPeople();
        }),
      }) : null,
      h('button', {
        class: 'btn btn-small btn-danger',
        text: 'Elimina',
        onclick: () => guard(async () => {
          if (!(await confirmBox(`Eliminare ${employee.name}? Vengono cancellati anche i suoi ordini.`, 'Elimina'))) return;
          await api(`/api/manager/employees/${employee.id}`, { method: 'DELETE' });
          toast('Persona eliminata');
          await managerPeople();
        }),
      }))));
  paint(managerHeader(),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Persone' }),
        h('span', { class: 'muted small', text: `${data.employees.length} in elenco` })),
      h('p', { class: 'muted small', text: 'Il numero di armadietto ordina la lista di consegna: deve essere unico in azienda. "Blocca" toglie una persona dai pasti finché non la riattivi; per un\u2019assenza di qualche giorno usa lo stand-by in "Stato ordini".' }),
      shareLinkBox(data.codeStaff),
      data.employees.length ? list : h('p', { class: 'muted', text: 'Nessuna persona inserita.' }),
      h('div', { class: 'row-wrap', style: 'margin-top:14px' },
        h('button', { class: 'btn btn-primary grow', text: '+ Aggiungi persona', onclick: () => employeeDialog(null, managerPeople) }),
        h('button', { class: 'btn', text: 'Incolla un elenco', onclick: () => bulkEmployeesDialog(managerPeople) }))));
}

/** Il link con il codice dell'azienda già dentro, da mandare nella chat di gruppo. */
function shareLinkBox(codeStaff) {
  const link = `${location.origin}${location.pathname}?c=${codeStaff}`;
  return h('div', { class: 'notice', style: 'margin:10px 0 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
    h('span', { class: 'grow small', style: 'word-break:break-all' }, h('strong', { text: 'Link per i dipendenti: ' }), h('span', { text: link })),
    h('button', {
      class: 'btn btn-small',
      text: 'Copia',
      onclick: () => navigator.clipboard?.writeText(link).then(() => toast('Link copiato: incollalo nella chat di gruppo')).catch(() => toast(link)),
    }));
}

/** Elenco incollato da Excel: anteprima di che cosa entra e che cosa no, poi si importa. */
function bulkEmployeesDialog(onDone) {
  const area = h('textarea', { class: 'field', rows: '8', spellcheck: 'false', placeholder: 'Mario Rossi\t12\nAnna Bianchi\t3\n...' });
  const anteprima = h('div', { class: 'stack' });
  const importa = h('button', { class: 'btn btn-small btn-primary', text: 'Importa', disabled: true });
  let lettura = { persone: [] };

  const aggiorna = () => {
    lettura = leggiPersone(area.value);
    anteprima.replaceChildren();
    if (lettura.persone.length) {
      anteprima.append(h('p', { class: 'small' }, h('strong', { text: `${lettura.persone.length} persone pronte: ` }),
        h('span', { class: 'muted', text: lettura.persone.slice(0, 6).map((x) => `${x.name} (${x.locker})`).join(', ') + (lettura.persone.length > 6 ? '…' : '') })));
    }
    if (lettura.senzaArmadietto.length) {
      anteprima.append(h('p', { class: 'small notice', text: `Senza armadietto, non importate: ${lettura.senzaArmadietto.join(', ')}` }));
    }
    if (lettura.doppioni.length) {
      anteprima.append(h('p', { class: 'small muted', text: `Ripetute nel testo, prese una volta: ${lettura.doppioni.join(', ')}` }));
    }
    importa.disabled = !lettura.persone.length;
    importa.textContent = lettura.persone.length ? `Importa ${lettura.persone.length}` : 'Importa';
  };
  area.addEventListener('input', aggiorna);

  const box = dialog('Incolla un elenco',
    [
      h('p', { class: 'small muted', text: 'Una persona per riga, con nome e numero di armadietto: come esce da Excel va bene. Chi è già in elenco viene saltato.' }),
      area,
      anteprima,
    ],
    [
      h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }),
      importa,
    ]);
  importa.addEventListener('click', () => guard(async () => {
    const esito = await api('/api/manager/employees/bulk', { method: 'POST', body: { people: lettura.persone } });
    box.close();
    const parti = [`${esito.inserted} inserite`];
    if (esito.skipped.length) parti.push(`${esito.skipped.length} già presenti`);
    if (esito.conflicts.length) parti.push(`${esito.conflicts.length} con armadietto occupato: ${esito.conflicts.map((c) => `${c.name} (${c.locker} è di ${c.by})`).join(', ')}`);
    toast(parti.join(' · '), esito.conflicts.length > 0);
    await onDone();
  }));
  area.focus();
}

async function managerStatus() {
  const data = await api(`/api/manager/week?week=${store.week}`);
  const inviati = data.employees.filter((e) => e.submitted).length;
  const rows = data.employees.map((employee) =>
    h('div', { class: 'list-item' },
      h('span', { class: 'locker-badge', text: employee.locker }),
      h('span', { class: 'grow', text: employee.name }),
      h('span', { class: 'small muted', text: employee.submitted ? formatStamp(employee.updatedAt) : 'mai inviato' }),
      h('div', { class: 'row-wrap small', style: 'gap:4px;width:100%' }, employee.days.map((value, index) => {
        const label = GIORNI_BREVI[index];
        const sospeso = value === 'sospeso';
        // Un tocco sul giorno mette la persona in stand-by (malattia, ferie) o la rimette: vale anche a settimana chiusa.
        const toggle = () => guard(async () => {
          await api('/api/manager/suspensions', { method: 'PUT', body: { employeeId: employee.id, week: store.week, day: index + 1, suspended: !sospeso } });
          toast(sospeso ? `${employee.name}: ${label} riattivato` : `${employee.name}: ${label} in stand-by, il pasto non si prepara`);
          await managerStatus();
        });
        const classe = sospeso ? 'pill pill-lock' : value === 'skip' ? 'pill pill-skip' : value > 0 ? 'pill pill-ok' : 'pill pill-todo';
        const testo = sospeso ? `${label} stand-by` : value === 'skip' ? `${label} non pranza` : value > 0 ? `${label} \u2713` : `${label} \u2014`;
        return h('button', { type: 'button', class: `${classe} pill-btn`, text: testo, title: sospeso ? 'Tocca per riattivare' : 'Tocca per mettere in stand-by questo giorno', onclick: toggle });
      }))));

  const extrasBox = h('div', { class: 'card', style: 'margin-top:12px' },
    h('div', { class: 'card-head' },
      h('h2', { text: 'Pasti extra' }),
      h('span', { class: 'muted small', text: `${data.extras.reduce((s, x) => s + x.qty, 0)} in totale` })),
    h('p', { class: 'small muted', text: 'Per chi non è in elenco: un interinale, un ospite. Si aggiungono entro la scadenza; togliere si può sempre.' }),
    data.extras.length
      ? h('div', { class: 'list' }, data.extras.map((extra) =>
          h('div', { class: 'list-item' },
            h('span', { class: 'locker-badge', text: `${extra.qty}\u00d7` }),
            h('div', { class: 'grow' },
              h('div', {}, h('strong', { text: GIORNI_BREVI[extra.day - 1] }), extra.note ? h('span', { class: 'muted', text: ` \u00b7 ${extra.note}` }) : null),
              h('div', { class: 'choices' }, extra.choices.map((c, i) => [i ? h('span', { text: ' \u00b7 ' }) : null, h('span', { class: 'slot-code', text: c.code }), h('span', { text: c.dish })]))),
            h('button', {
              class: 'btn btn-small btn-danger', text: 'Togli',
              onclick: () => guard(async () => {
                await api(`/api/manager/extras/${extra.id}`, { method: 'DELETE' });
                toast('Pasti extra tolti');
                await managerStatus();
              }),
            }))))
      : h('p', { class: 'muted small', text: 'Nessun pasto extra questa settimana.' }),
    data.deadline.locked
      ? null
      : h('button', { class: 'btn btn-block', style: 'margin-top:12px', text: '+ Aggiungi pasti extra', onclick: () => extraDialog(managerStatus) }));

  paint(managerHeader(),
    weekBar((delta) => { store.week = shiftWeek(store.week, delta); viewManager('settimana'); }),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Stato ordini' }),
        h('span', { class: 'muted small', text: `${inviati} su ${data.employees.length} hanno inviato` })),
      h('p', { class: data.deadline.locked ? 'small notice notice-lock' : 'small muted', style: 'margin-bottom:12px',
        text: data.deadline.locked ? `Settimana chiusa ${data.deadline.label}: gli ordini sono definitivi.` : `Aperta fino a ${data.deadline.label}.` }),
      h('p', { class: 'small muted', text: 'Tocca un giorno per mettere la persona in stand-by (malattia, ferie): il pasto non si prepara. Vale anche a settimana chiusa.' }),
      data.employees.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted', text: 'Nessuna persona in elenco.' })),
    extrasBox);
}

/** Pasti extra: giorno, quantità e piatti, con le stesse regole di un ordine normale. */
async function extraDialog(onDone) {
  const dati = await api(`/api/manager/menu?week=${store.week}`);
  const byId = new Map(dati.menu.map((i) => [i.id, i]));
  const infoDi = (id) => byId.get(id);
  let giorno = DAYS.find((d) => dati.menu.some((m) => m.day === d)) ?? 1;
  let scelte = [];
  const qta = h('input', { class: 'field', type: 'number', min: '1', max: '99', value: '1', style: 'width:90px' });
  const nota = h('input', { class: 'field grow', placeholder: 'Nota (es. interinali)', maxlength: '60', autocomplete: 'off' });
  const giorni = h('div', { class: 'tabs', style: 'padding:0' });
  const opzioni = h('div', { class: 'stack' });
  const aggiungi = h('button', { class: 'btn btn-small btn-primary', text: 'Aggiungi', disabled: true });

  const disegna = () => {
    giorni.replaceChildren(...DAYS.map((d) => h('button', { text: dayLabel(store.week, d), 'aria-selected': d === giorno ? 'true' : 'false', onclick: () => { giorno = d; scelte = []; disegna(); } })));
    opzioni.replaceChildren();
    for (const course of dati.courses) {
      const piatti = dati.menu.filter((m) => m.day === giorno && m.courseId === course.id);
      if (!piatti.length) continue;
      opzioni.append(h('div', { class: 'course' },
        h('div', { class: 'course-head' }, h('h3', { text: course.name })),
        h('div', { class: 'options' }, piatti.map((item) => {
          const selezionato = scelte.includes(item.id);
          const esito = selezionato ? scelte : simulaAggiunta(scelte, item, dati.rules, infoDi);
          return h('button', {
            class: 'opt', type: 'button', 'aria-pressed': selezionato ? 'true' : 'false', disabled: !selezionato && esito === null,
            onclick: () => { const p = simulaAggiunta(scelte, item, dati.rules, infoDi); if (p) { scelte = p; disegna(); } },
          }, h('span', { class: 'mark', text: '\u2713' }), h('span', { class: 'slot-code', text: item.code }), h('span', { class: 'grow', text: item.name }));
        }))));
    }
    if (!opzioni.children.length) opzioni.append(h('p', { class: 'muted small', text: 'Nessun menù per questo giorno.' }));
    aggiungi.disabled = !scelte.length;
  };
  disegna();

  const box = dialog('Pasti extra',
    [giorni, h('div', { class: 'row' }, h('span', { text: 'Quanti' }), qta, nota), opzioni],
    [h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }), aggiungi]);
  box.classList.add('wide');
  aggiungi.addEventListener('click', () => guard(async () => {
    await api('/api/manager/extras', { method: 'POST', body: { week: store.week, day: giorno, qty: Number(qta.value), note: nota.value, items: scelte } });
    box.close();
    toast('Pasti extra aggiunti');
    await onDone();
  }));
}

async function managerDelivery() {
  const report = await api(`/api/manager/delivery?week=${store.week}`);
  paint(managerHeader(),
    weekBar((delta) => { store.week = shiftWeek(store.week, delta); viewManager('consegne'); }),
    h('div', { class: 'row-wrap no-print', style: 'margin-top:12px' },
      h('button', { class: 'btn btn-small', text: 'Stampa', onclick: () => window.print() }),
      h('button', { class: 'btn btn-small', text: 'Scarica CSV', onclick: () => download(`/api/manager/delivery?week=${store.week}&format=csv`, `consegne-${store.week}.csv`) })),
    deliveryNodes(report, false));
}

// ── Ristorante ────────────────────────────────────────────────────────────────

const ADMIN_TABS = [
  { key: 'aziende', label: 'Aziende' },
  { key: 'menu', label: 'Menù' },
  { key: 'cucina', label: 'Cucina' },
  { key: 'consegne', label: 'Consegne' },
  { key: 'dati', label: 'Impostazioni' },
];

function viewAdmin(tab = store.tab || 'aziende') {
  store.tab = ADMIN_TABS.some((t) => t.key === tab) ? tab : 'aziende';
  setSubmitbar();
  const views = { aziende: adminCompanies, menu: adminMenu, cucina: adminKitchen, consegne: adminDelivery, dati: adminData };
  return guard(views[store.tab]);
}

function adminHeader() {
  return tabsBar(ADMIN_TABS, store.tab, (key) => viewAdmin(key));
}

/**
 * Le regole dell'azienda: quanti piatti al giorno, quali portate, con quali
 * lettere del foglio settimanale e quali valgono da sole un pasto.
 */
function coursesDialog(company, onSaved) {
  const piattiAlGiorno = h('input', {
    class: 'field', type: 'number', min: '1', max: '9', style: 'width:92px', value: String(company.maxDishes ?? 3),
  });
  const rows = h('div', { class: 'stack' });

  const addRow = (course) => {
    const nome = h('input', { class: 'field grow', value: course?.name ?? '', placeholder: 'es. Primi', autocomplete: 'off' });
    const lettere = h('input', {
      class: 'field', style: 'width:110px', autocomplete: 'off', placeholder: 'A, B',
      value: (course?.slots ?? []).map((s) => s.code).join(', '),
    });
    const max = h('input', { class: 'field', style: 'width:78px', type: 'number', min: '0', max: '9', value: String(course?.max ?? 1) });
    const unico = h('input', { type: 'checkbox', style: 'width:22px;height:22px' });
    unico.checked = !!course?.single;
    const row = h('div', { class: 'card', style: 'padding:12px' },
      h('div', { class: 'row' }, nome,
        h('button', { class: 'btn btn-small btn-danger', text: '\u2715', 'aria-label': 'Rimuovi portata', onclick: () => row.remove() })),
      h('div', { class: 'row-wrap', style: 'margin-top:8px' },
        h('span', { class: 'small muted', text: 'Lettere' }), lettere,
        h('span', { class: 'small muted', text: 'Max/giorno' }), max),
      h('label', { class: 'row', style: 'margin-top:8px;font-weight:400' }, unico,
        h('span', { class: 'small', text: 'Pasto unico: vale da solo un pasto completo' })));
    row._dati = { course, nome, lettere, max, unico };
    rows.append(row);
  };
  (company.courses.length ? company.courses : [{ name: 'Primi', max: 1, slots: [{ code: 'A' }] }]).forEach(addRow);

  const box = dialog(`Regole di ${company.name}`,
    [
      h('div', { class: 'row' }, h('span', { text: 'Piatti al giorno' }), piattiAlGiorno),
      h('p', { class: 'small muted', text: 'Le lettere sono quelle del foglio settimanale: chi ordina sceglie una casella, il ristorante decide che cosa ci mette. Il limite viene applicato durante l\u2019ordine, non segnalato dopo.' }),
      rows,
      h('button', { class: 'btn btn-small', text: '+ Aggiungi portata', onclick: () => addRow(null) }),
    ],
    [
      h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }),
      h('button', {
        class: 'btn btn-small btn-primary',
        text: 'Salva',
        onclick: () => guard(async () => {
          const courses = [...rows.children].map((row) => {
            const { course, nome, lettere, max, unico } = row._dati;
            const codici = lettere.value.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
            return {
              id: course?.id,
              name: nome.value,
              max: Number(max.value),
              single: unico.checked,
              // Le lettere già esistenti conservano il proprio id: gli ordini restano validi.
              slots: codici.map((code) => ({ id: (course?.slots ?? []).find((s) => s.code === code)?.id, code })),
            };
          });
          await api(`/api/admin/companies/${company.id}/courses`, {
            method: 'PUT',
            body: { maxDishes: Number(piattiAlGiorno.value), courses },
          });
          box.close();
          toast('Regole aggiornate');
          await onSaved();
        }),
      }),
    ]);
}

async function adminCompanies() {
  const data = await api('/api/admin/companies');
  const cards = data.companies.map((company) =>
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { class: 'truncate', text: company.name }),
        h('span', { class: 'muted small', text: `${company.employees} persone` })),
      h('div', { class: 'row-wrap', style: 'margin-bottom:10px' },
        h('span', { class: 'small muted', text: 'Codice dipendenti' }), h('span', { class: 'code-chip', text: company.codeStaff }),
        h('span', { class: 'small muted', text: 'Codice referente' }), h('span', { class: 'code-chip', text: company.codeManager })),
      h('p', { class: 'small muted' },
        h('strong', { text: `${company.maxDishes} piatti al giorno` }),
        h('span', { text: company.courses.length
          ? ' \u00b7 ' + company.courses.map((c) => `${c.name} ${c.slots.map((s) => s.code).join('')} (max ${c.max})`).join(' \u00b7 ')
          : ' \u00b7 nessuna portata configurata' })),
      h('div', { class: 'row-wrap' },
        h('button', { class: 'btn btn-small', text: 'Regole', onclick: () => coursesDialog(company, adminCompanies) }),
        h('button', { class: 'btn btn-small', text: 'Rinomina', onclick: () => renameDialog(company) }),
        h('button', {
          class: 'btn btn-small',
          text: 'Nuovi codici',
          onclick: () => guard(async () => {
            if (!(await confirmBox(`Rigenerare i codici di ${company.name}? I vecchi codici smettono di funzionare subito.`, 'Rigenera'))) return;
            await api(`/api/admin/companies/${company.id}/codes`, { method: 'POST' });
            toast('Codici rigenerati');
            await adminCompanies();
          }),
        }),
        h('button', {
          class: 'btn btn-small btn-danger',
          text: 'Elimina',
          onclick: () => guard(async () => {
            if (!(await confirmBox(`Eliminare ${company.name}? Vengono cancellati persone, menù e ordini dell’azienda.`, 'Elimina'))) return;
            await api(`/api/admin/companies/${company.id}`, { method: 'DELETE' });
            toast('Azienda eliminata');
            await adminCompanies();
          }),
        }))));

  paint(adminHeader(),
    h('button', {
      class: 'btn btn-primary btn-block',
      style: 'margin-bottom:12px',
      text: '+ Nuova azienda',
      onclick: () => {
        const nome = h('input', { class: 'field', placeholder: 'Nome azienda', autocomplete: 'off' });
        const box = dialog('Nuova azienda',
          [h('div', {}, h('label', { text: 'Nome azienda' }), nome),
           h('p', { class: 'small muted', text: 'Vengono creati due codici (dipendenti e referente) e le portate standard Primo, Secondo, Contorno, tutte con massimo 1. Le regole si modificano subito dopo.' })],
          [h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }),
           h('button', {
             class: 'btn btn-small btn-primary',
             text: 'Crea',
             onclick: () => guard(async () => {
               const created = await api('/api/admin/companies', { method: 'POST', body: { name: nome.value } });
               box.close();
               toast(`Codice dipendenti: ${created.codeStaff}`);
               await adminCompanies();
             }),
           })]);
        nome.focus();
      },
    }),
    data.companies.length ? cards : h('div', { class: 'card' }, h('p', { class: 'muted', text: 'Nessuna azienda cliente. Creane una per iniziare.' })));
}

function renameDialog(company) {
  const nome = h('input', { class: 'field', value: company.name, autocomplete: 'off' });
  const box = dialog('Rinomina azienda', h('div', {}, h('label', { text: 'Nome azienda' }), nome), [
    h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }),
    h('button', {
      class: 'btn btn-small btn-primary',
      text: 'Salva',
      onclick: () => guard(async () => {
        await api(`/api/admin/companies/${company.id}`, { method: 'PUT', body: { name: nome.value } });
        box.close();
        await adminCompanies();
      }),
    }),
  ]);
}

/** Il menù della settimana è la stessa griglia del foglio: una riga per lettera, una colonna per giorno. */
async function adminMenu() {
  const companies = (await api('/api/admin/companies')).companies;
  if (!companies.length) {
    paint(adminHeader(), h('div', { class: 'card' }, h('p', { class: 'muted', text: 'Crea prima un\u2019azienda cliente.' })));
    return;
  }
  if (!companies.some((c) => c.id === store.companyId)) store.companyId = companies[0].id;
  const data = await api(`/api/admin/menu?companyId=${store.companyId}&week=${store.week}`);

  const select = h('select', { class: 'field', onchange: (event) => { store.companyId = Number(event.target.value); viewAdmin('menu'); } },
    companies.map((company) => h('option', { value: company.id, selected: company.id === store.companyId }, company.name)));

  const righe = data.courses.flatMap((course) =>
    course.slots.map((slot) => ({ ...slot, courseName: course.name, courseSingle: course.single })));
  const celle = new Map();

  const corpo = h('tbody', {}, righe.map((slot) =>
    h('tr', {},
      h('th', { scope: 'row' },
        h('span', { class: 'slot-code', text: slot.code }),
        h('span', { class: 'small muted', text: slot.courseName })),
      DAYS.map((day) => {
        const item = data.items.find((i) => i.slotId === slot.id && i.day === day);
        const campo = h('input', { class: 'field', autocomplete: 'off', spellcheck: 'false', placeholder: '\u2014' });
        campo.value = item?.name ?? '';
        const unico = h('button', {
          type: 'button',
          class: 'unico-toggle',
          title: 'Piatto unico: da solo vale un pasto completo',
          'aria-pressed': item?.single ? 'true' : 'false',
          text: 'unico',
          onclick: (event) => {
            const btn = event.currentTarget;
            btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
          },
        });
        // Il contrassegno serve di rado (la pizza): compare solo dove c'è un piatto.
        const aggiornaUnico = () => {
          unico.hidden = !campo.value.trim() && unico.getAttribute('aria-pressed') !== 'true';
        };
        campo.addEventListener('input', aggiornaUnico);
        aggiornaUnico();
        celle.set(`${slot.id}:${day}`, { campo, unico });
        return h('td', {}, campo, slot.courseSingle ? null : unico);
      }))));

  const collect = () => {
    const items = [];
    for (const slot of righe) {
      for (const day of DAYS) {
        const cella = celle.get(`${slot.id}:${day}`);
        const nome = cella.campo.value.trim();
        if (!nome) continue;
        items.push({ day, slotId: slot.id, name: nome, single: cella.unico.getAttribute('aria-pressed') === 'true' });
      }
    }
    return items;
  };

  const salva = (messaggio = 'Menù salvato') => guard(async () => {
    await api('/api/admin/menu', { method: 'PUT', body: { companyId: store.companyId, week: store.week, items: collect() } });
    toast(messaggio);
    await adminMenu();
  });

  paint(adminHeader(),
    h('div', { class: 'card' },
      h('label', { text: 'Azienda' }), select,
      weekBar((delta) => { store.week = shiftWeek(store.week, delta); viewAdmin('menu'); }),
      data.orders
        ? h('div', { class: 'notice', style: 'margin-top:12px', text: `${data.orders} ordini già inviati. Correggere una casella non cancella gli ordini; svuotarla toglie la scelta a chi l\u2019aveva presa.` })
        : null),
    righe.length
      ? h('div', { class: 'card' },
          h('p', { class: 'small muted', text: 'Una riga per lettera, una colonna per giorno. Casella vuota: quel giorno la lettera non c\u2019è.' }),
          h('div', { class: 'grid-scroll' },
            h('table', { class: 'menu-grid' },
              h('thead', {}, h('tr', {}, h('th', { text: '' }), DAYS.map((day) => h('th', { text: dayLabel(store.week, day) })))),
              corpo)))
      : h('div', { class: 'card' }, h('p', { class: 'muted', text: 'Configura prima le portate e le lettere nella scheda Aziende.' })),
    h('div', { class: 'card' },
      h('div', { class: 'stack' },
        h('button', { class: 'btn btn-primary btn-block', text: 'Salva menù', onclick: () => salva() }),
        h('button', { class: 'btn btn-block', text: 'Incolla da Excel', onclick: () => pasteMenuDialog(righe, celle) }),
        h('button', {
          class: 'btn btn-block',
          text: 'Copia questo menù a tutte le aziende',
          onclick: () => guard(async () => {
            if (!(await confirmBox('Il menù di questa settimana viene copiato su tutte le altre aziende, sostituendo quello esistente. Le lettere che un\u2019azienda non ha vengono ignorate.', 'Copia a tutte'))) return;
            await api('/api/admin/menu', { method: 'PUT', body: { companyId: store.companyId, week: store.week, items: collect() } });
            const result = await api('/api/admin/menu/copy', { method: 'POST', body: { fromCompanyId: store.companyId, week: store.week, toCompanyIds: 'all' } });
            const mancanti = [...new Set(result.report.flatMap((r) => r.missing))].sort();
            toast(`Copiato su ${result.report.length} aziende${mancanti.length ? `, lettere ignorate: ${mancanti.join(' ')}` : ''}`);
            await adminMenu();
          }),
        }),
        h('button', {
          class: 'btn btn-block',
          text: 'Riprendi il menù della settimana precedente',
          onclick: () => guard(async () => {
            await api('/api/admin/menu/import-week', {
              method: 'POST',
              body: { companyId: store.companyId, fromWeek: shiftWeek(store.week, -1), toWeek: store.week },
            });
            toast('Menù ripreso dalla settimana precedente');
            await adminMenu();
          }),
        }))));
}

/**
 * Il ristorante seleziona la griglia nel suo foglio, la copia e la incolla qui:
 * anteprima di che cosa è stato riconosciuto, poi si riempiono le caselle.
 * Il salvataggio resta un passo a parte, così si può ancora correggere.
 */
function pasteMenuDialog(righe, celle) {
  const slots = righe.map((r) => ({ id: r.id, code: r.code, courseName: r.courseName }));
  const area = h('textarea', { class: 'field', rows: '10', spellcheck: 'false', placeholder: 'A\tPrimi\tPasta e ceci\tPasta alla carbonara\t...' });
  const anteprima = h('div', { class: 'stack' });
  const applica = h('button', { class: 'btn btn-small btn-primary', text: 'Riempi la griglia', disabled: true });
  let lettura = { righe: [] };

  const aggiorna = () => {
    lettura = leggiGriglia(area.value, slots);
    anteprima.replaceChildren();
    if (lettura.righe.length) {
      anteprima.append(h('div', { class: 'grid-scroll' }, h('table', { class: 'menu-grid anteprima' },
        h('thead', {}, h('tr', {}, h('th', { text: '' }), DAYS.map((d) => h('th', { text: GIORNI_BREVI[d - 1] })))),
        h('tbody', {}, lettura.righe.map((r) => h('tr', {},
          h('th', {}, h('span', { class: 'slot-code', text: r.code })),
          r.giorni.map((g) => h('td', { class: g ? '' : 'muted', text: g || '\u2014' }))))))));
      const pizze = lettura.righe.flatMap((r) => r.giorni.filter((g) => /pizza/i.test(g)));
      if (pizze.length) anteprima.append(h('p', { class: 'small muted', text: `Contrassegnate come piatto unico: ${pizze.join(', ')}` }));
    }
    if (lettura.mancanti.length) anteprima.append(h('p', { class: 'small muted', text: `Lettere non trovate nel testo: ${lettura.mancanti.join(' ')} (le caselle restano come sono).` }));
    if (lettura.ignorate.length) anteprima.append(h('p', { class: 'small muted', text: `Righe ignorate: ${lettura.ignorate.length}` }));
    applica.disabled = !lettura.righe.length;
  };
  area.addEventListener('input', aggiorna);

  const box = dialog('Incolla da Excel',
    [h('p', { class: 'small muted', text: 'Seleziona nel foglio le righe delle lettere con i cinque giorni, copia e incolla qui. Va bene anche con la colonna della portata e con l\u2019intestazione.' }), area, anteprima],
    [h('button', { class: 'btn btn-small', text: 'Annulla', onclick: () => box.close() }), applica]);
  box.classList.add('wide'); // l'anteprima ha cinque colonne: serve spazio
  applica.addEventListener('click', () => {
    for (const r of lettura.righe) {
      r.giorni.forEach((nome, i) => {
        const cella = celle.get(`${r.slotId}:${i + 1}`);
        if (!cella) return;
        cella.campo.value = nome;
        cella.unico.setAttribute('aria-pressed', /pizza/i.test(nome) ? 'true' : 'false');
        cella.campo.dispatchEvent(new Event('input'));
      });
    }
    box.close();
    toast('Griglia riempita: controlla e poi salva');
  });
  area.focus();
}

async function adminKitchen() {
  const report = await api(`/api/admin/report/kitchen?week=${store.week}`);
  const days = report.days.map((day) => {
    const section = h('section', { class: 'report-day' },
      h('h2', {}, h('span', { text: day.label }), h('span', { text: `${day.people} ${day.people === 1 ? 'pasto' : 'pasti'}` })));
    if (!day.courses.length) {
      section.append(h('p', { class: 'muted small', text: 'Nessun ordine.' }));
      return section;
    }
    for (const course of day.courses) {
      section.append(h('div', { class: 'course-label', text: course.name }));
      for (const dish of course.dishes) {
        section.append(h('div', { class: 'dish-row' },
          h('span', { class: 'qty', text: dish.qty }),
          dish.codes ? h('span', { class: 'slot-code', text: dish.codes }) : null,
          h('span', { class: 'name', text: dish.name })));
      }
    }
    return section;
  });
  paint(adminHeader(),
    weekBar((delta) => { store.week = shiftWeek(store.week, delta); viewAdmin('cucina'); }),
    h('div', { class: 'row-wrap no-print', style: 'margin-top:12px' },
      h('button', { class: 'btn btn-small', text: 'Stampa', onclick: () => window.print() }),
      h('button', { class: 'btn btn-small', text: 'Scarica CSV', onclick: () => download(`/api/admin/report/kitchen?week=${store.week}&format=csv`, `cucina-${store.week}.csv`) })),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('h1', { text: `Cucina — ${report.label}` }),
      h('p', { class: 'small muted', text: 'Porzioni da preparare, sommando tutte le aziende.' }),
      days));
}

function deliveryNodes(report, showCompany = true) {
  const days = report.days.map((day) => {
    const section = h('section', { class: 'report-day' },
      h('h2', {}, h('span', { text: day.label }),
        h('span', { text: `${day.companies.reduce((sum, c) => sum + c.people.length, 0)} consegne` })));
    if (!day.companies.length) {
      section.append(h('p', { class: 'muted small', text: 'Nessuna consegna.' }));
      return section;
    }
    for (const company of day.companies) {
      if (showCompany) section.append(h('div', { class: 'course-label', text: `${company.company} · ${company.people.length} persone` }));
      for (const extra of company.extras ?? []) {
        section.append(h('div', { class: 'delivery-person' },
          h('span', { class: 'locker-badge', text: `${extra.qty}\u00d7` }),
          h('div', { class: 'grow' },
            h('div', {}, h('strong', { text: `Extra${extra.note ? ` \u00b7 ${extra.note}` : ''}` })),
            h('div', { class: 'choices' }, extra.choices.map((c, index) => [
              index ? h('span', { text: ' \u00b7 ' }) : null,
              h('span', { class: 'slot-code', text: c.code }),
              h('span', { text: c.dish }),
            ])))));
      }
      for (const person of company.people) {
        section.append(h('div', { class: 'delivery-person' },
          h('span', { class: 'locker-badge', text: person.locker }),
          h('div', { class: 'grow' },
            h('div', {}, h('strong', { text: person.name })),
            h('div', { class: 'choices' }, person.choices.map((c, index) => [
              index ? h('span', { text: ' \u00b7 ' }) : null,
              h('span', { class: 'slot-code', text: c.code }),
              h('span', { text: c.dish }),
            ])))));
      }
    }
    return section;
  });
  return h('div', { class: 'card', style: 'margin-top:12px' },
    h('h1', { text: `Consegne — ${report.label}` }),
    h('p', { class: 'small muted', text: 'Persone ordinate per numero di armadietto.' }),
    days);
}

async function adminDelivery() {
  const report = await api(`/api/admin/report/delivery?week=${store.week}`);
  paint(adminHeader(),
    weekBar((delta) => { store.week = shiftWeek(store.week, delta); viewAdmin('consegne'); }),
    h('div', { class: 'row-wrap no-print', style: 'margin-top:12px' },
      h('button', { class: 'btn btn-small', text: 'Stampa', onclick: () => window.print() }),
      h('button', { class: 'btn btn-small', text: 'Scarica CSV', onclick: () => download(`/api/admin/report/delivery?week=${store.week}&format=csv`, `consegne-${store.week}.csv`) })),
    deliveryNodes(report, true));
}

async function adminData() {
  const impostazioni = await api('/api/admin/settings');
  const nome = h('input', { class: 'field', value: impostazioni.name, autocomplete: 'off' });
  const giorno = h('select', { class: 'field', style: 'width:auto' },
    GIORNI_SETTIMANA.map((g, i) => h('option', { value: i + 1, selected: impostazioni.deadline.day === i + 1 }, g)));
  const ora = h('input', { class: 'field', style: 'width:120px', type: 'time', value: impostazioni.deadline.time });
  const esempio = h('p', { class: 'small muted', text: `Esempio: la prossima settimana si chiude ${impostazioni.example}.` });
  const attuale = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', placeholder: 'Codice attuale' });
  const nuovo = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: 'Nuovo codice (almeno 6 caratteri)' });
  const settimane = h('input', { class: 'field', style: 'width:110px', type: 'number', min: '1', max: '104', value: '12' });
  const anche = h('input', { type: 'checkbox', id: 'anche-menu', style: 'width:22px;height:22px' });
  paint(adminHeader(),
    h('div', { class: 'card' },
      h('h2', { text: 'Scadenza degli ordini' }),
      h('p', { class: 'small muted', text: 'Le aziende ordinano e correggono la settimana successiva fino a questo momento della settimana precedente. Poi tutto si blocca e non si modifica più.' }),
      h('div', { class: 'row-wrap', style: 'margin-top:10px' }, h('span', { text: 'Ogni' }), giorno, h('span', { text: 'alle' }), ora),
      esempio,
      h('label', { text: 'Nome del ristorante' }), nome,
      h('button', {
        class: 'btn btn-primary btn-block',
        style: 'margin-top:12px',
        text: 'Salva impostazioni',
        onclick: () => guard(async () => {
          const esito = await api('/api/admin/settings', {
            method: 'PUT',
            body: { name: nome.value, deadline: { day: Number(giorno.value), time: ora.value, timezone: impostazioni.deadline.timezone } },
          });
          store.appName = esito.name;
          store.deadline = esito.deadline;
          toast('Impostazioni salvate');
          await adminData();
        }),
      })),
    h('div', { class: 'card' },
      h('h2', { text: 'Codice del ristorante' }),
      h('p', { class: 'small muted', text: 'Cambiandolo, chi è entrato con quello vecchio deve rientrare. Nel database ne resta solo un\u2019impronta.' }),
      h('div', { class: 'stack', style: 'margin-top:10px' }, attuale, nuovo,
        h('button', {
          class: 'btn btn-block',
          text: 'Cambia codice',
          onclick: () => guard(async () => {
            const esito = await api('/api/admin/code', { method: 'POST', body: { current: attuale.value, next: nuovo.value } });
            store.token = esito.token;
            localStorage.setItem(TOKEN_KEY, esito.token);
            attuale.value = '';
            nuovo.value = '';
            toast('Codice cambiato');
          }),
        }))),
    h('div', { class: 'card' },
      h('h2', { text: 'Conservazione dei dati' }),
      h('p', { class: 'small muted', text: 'Le scelte alimentari possono rivelare informazioni personali delicate. Gli ordini più vecchi del periodo impostato vengono cancellati automaticamente; qui puoi anticipare la pulizia.' }),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('span', { text: 'Conserva le ultime' }), settimane, h('span', { text: 'settimane' })),
      h('label', { class: 'row', style: 'margin-top:12px;font-weight:400' }, anche, h('span', { text: 'Cancella anche i menù, non solo gli ordini' })),
      h('button', {
        class: 'btn btn-danger btn-block',
        style: 'margin-top:14px',
        text: 'Cancella i dati storici',
        onclick: () => guard(async () => {
          const keep = Math.max(1, Number(settimane.value) || 12);
          const beforeWeek = shiftWeek(currentWeek(), -keep);
          if (!(await confirmBox(`Vengono cancellati gli ordini precedenti alla settimana ${beforeWeek}. L’operazione non è reversibile.`, 'Cancella'))) return;
          const result = await api('/api/admin/purge', { method: 'POST', body: { beforeWeek, includeMenus: anche.checked } });
          toast(`Cancellati ${result.orders} ordini${result.menus ? ` e ${result.menus} voci di menù` : ''}`);
        }),
      })),
    h('div', { class: 'card' },
      h('h2', { text: 'Privacy' }),
      h('p', { class: 'small muted', text: 'L’informativa è raggiungibile da ogni schermata, in fondo alla pagina.' }),
      h('a', { class: 'btn btn-small', href: '/privacy.html', text: 'Apri l’informativa' })));
}

// ── Avvio ─────────────────────────────────────────────────────────────────────

guard(boot);
