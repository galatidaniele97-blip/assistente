// Interfaccia Mensa. Nessuna dipendenza esterna, nessun innerHTML: tutto costruito nel DOM.

import { currentWeek, shiftWeek, weekLabel, dayLabel, GIORNI_BREVI } from './shared/week.js';
import { simulaAggiunta } from './shared/regole.js';

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
  if (response.status === 401) {
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
  paint(h('div', { class: 'login' },
    h('img', { class: 'logo-img', src: '/icona.svg', alt: '', width: '64', height: '64' }),
    h('h1', { text: 'Primo avvio' }),
    h('p', { class: 'claim', text: 'Imposta il nome del ristorante e il codice con cui accederai.' }),
    h('div', { class: 'stack' },
      h('div', {}, h('label', { for: 'setup-nome', text: 'Nome del ristorante' }), nome),
      h('div', {}, h('label', { for: 'setup-codice', text: 'Codice del ristorante (almeno 6 caratteri)' }), codice),
      h('button', {
        class: 'btn btn-primary btn-block',
        text: 'Crea',
        onclick: () => guard(async () => {
          const result = await api('/api/setup', { method: 'POST', body: { name: nome.value, code: codice.value } });
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
    store.week = currentWeek();
    renderTopbar();
    await routeByRole();
  });
  codice.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') entra();
  });
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
        onclick: () => guard(async () => {
          const result = await api('/api/staff/identify', { method: 'POST', body: { employeeId: employee.id } });
          store.token = result.token;
          localStorage.setItem(TOKEN_KEY, result.token);
          store.employee = result.employee;
          renderTopbar();
          await viewStaffOrder();
        }),
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

  const refreshBar = () => {
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
    const card = h('section', { class: chosen.skip ? 'card day skipped' : 'card day' },
      h('div', { class: 'day-head' },
        h('h2', { text: dayLabel(store.week, day) }),
        !chosen.skip && dayMenu.length
          ? h('span', {
              class: unico || chosen.items.length >= data.rules.maxDishes ? 'counter full' : 'counter',
              text: unico ? 'piatto unico' : `${chosen.items.length}/${data.rules.maxDishes} piatti`,
            })
          : null,
        dayMenu.length
          ? h('button', {
              class: 'skip-btn',
              'aria-pressed': chosen.skip ? 'true' : 'false',
              text: 'Non pranzo',
              onclick: () => {
                chosen.skip = !chosen.skip;
                if (chosen.skip) chosen.items = [];
                redrawDay(day);
              },
            })
          : null));

    if (!dayMenu.length) {
      card.append(h('p', { class: 'empty-menu', text: 'Menù non ancora pubblicato per questo giorno.' }));
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
            disabled: !selezionato && esito === null,
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
    data.menu.length ? null : h('div', { class: 'notice', style: 'margin-top:12px', text: 'Il menù di questa settimana non è ancora stato pubblicato.' }),
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
      h('button', { class: 'btn btn-small', style: 'margin-left:auto', text: 'Modifica', onclick: () => employeeDialog(employee, managerPeople) }),
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
      h('p', { class: 'muted small', text: 'Il numero di armadietto ordina la lista di consegna: deve essere unico in azienda.' }),
      data.employees.length ? list : h('p', { class: 'muted', text: 'Nessuna persona inserita.' }),
      h('button', { class: 'btn btn-primary btn-block', style: 'margin-top:14px', text: '+ Aggiungi persona', onclick: () => employeeDialog(null, managerPeople) })));
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
        if (value === 'skip') return h('span', { class: 'pill pill-skip', text: `${label} non pranza` });
        if (value > 0) return h('span', { class: 'pill pill-ok', text: `${label} ✓` });
        return h('span', { class: 'pill pill-todo', text: `${label} —` });
      }))));

  paint(managerHeader(),
    weekBar((delta) => { store.week = shiftWeek(store.week, delta); viewManager('settimana'); }),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Stato ordini' }),
        h('span', { class: 'muted small', text: `${inviati} su ${data.employees.length} hanno inviato` })),
      data.employees.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted', text: 'Nessuna persona in elenco.' })));
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
  { key: 'dati', label: 'Dati' },
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
      h('p', { class: 'small muted', text: company.courses.map((c) => `${c.name} (max ${c.max})`).join(' · ') || 'Nessuna portata configurata' }),
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

function adminData() {
  const settimane = h('input', { class: 'field', style: 'width:110px', type: 'number', min: '1', max: '104', value: '12' });
  const anche = h('input', { type: 'checkbox', id: 'anche-menu', style: 'width:22px;height:22px' });
  paint(adminHeader(),
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
