import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi, purgeExpired } from '../src/api.js';
import { openSqlite } from '../src/db-sqlite.js';
import { currentWeek, shiftWeek } from '../public/shared/week.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
const env = { SESSION_SECRET: 'segreto-di-prova' };
// Si ordina per una settimana ancora aperta: quella corrente è già chiusa dalla scadenza del venerdì.
const WEEK = shiftWeek(currentWeek(), 2);
const NEXT = shiftWeek(WEEK, 1);

function freshDb() {
  const db = openSqlite(':memory:');
  db.handle.exec(SCHEMA);
  return db;
}

async function call(db, method, path, { token, body } = {}) {
  const init = { method, headers: {} };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await handleApi(new Request(`http://t.local${path}`, init), env, db);
  const text = await response.text();
  const isJson = (response.headers.get('content-type') || '').includes('json');
  return { status: response.status, body: isJson && text ? JSON.parse(text) : text };
}

/** Il menù reale del ristorante: una riga per lettera, una colonna per giorno. */
const GRIGLIA = {
  A: ['Pasta e ceci', 'Pasta alla carbonara', 'Pasta alla puttanesca', 'Pasta e lenticchie', 'Pasta al ragù di polpo'],
  B: ['Pasta al pomodoro', 'Pasta al pomodoro', 'Riso in bianco', 'Pasta al pomodoro', 'Riso in bianco'],
  E: ['Salsiccia al vino bianco', 'Scaloppina al burro e salvia', 'Trancio di pizza alta', 'Bistecca di lonza', 'Trancio di pesce alle olive'],
  F: ['Stracchino', 'Mortadella', 'Frittata con cipolle', 'Bresaola', 'Tomino al forno'],
  G: ['Piselli al burro', 'Fagiolini lessi', '', 'Carote prezzemolate', 'Patate lesse'],
  H: ['Insalata verde', 'Insalata di carote', 'Insalata di pomodori', 'Insalata verde', 'Insalata mista'],
  L: ['Yogurt alla frutta', 'Dolce della casa', 'Yogurt alla frutta', 'Dolce della casa', 'Yogurt alla frutta'],
  P: ['Macedonia', 'Frutto', 'Macedonia', 'Frutto', 'Macedonia'],
  T: ['Rotolo farcito', 'Gran piatto buffet', 'Formaggi misti', 'Puccia con pancetta', 'Insalata di legumi e verdure'],
};

function grigliaItems(slotByCode) {
  const items = [];
  for (const [code, piatti] of Object.entries(GRIGLIA)) {
    piatti.forEach((nome, i) => {
      if (!nome) return;
      // La pizza del mercoledì è un piatto unico anche se sta fra i secondi.
      const single = nome.toLowerCase().includes('pizza');
      items.push({ day: i + 1, slotId: slotByCode[code], name: nome, single });
    });
  }
  return items;
}

async function scenario() {
  const db = freshDb();
  await call(db, 'POST', '/api/setup', { body: { name: 'Time Out', code: 'RISTO99' } });
  const admin = (await call(db, 'POST', '/api/login', { body: { code: 'risto-99' } })).body.token;

  const alfa = (await call(db, 'POST', '/api/admin/companies', { token: admin, body: { name: 'Alfa SpA' } })).body;
  const beta = (await call(db, 'POST', '/api/admin/companies', {
    token: admin,
    body: {
      name: 'Beta Srl',
      maxDishes: 2,
      courses: [
        { name: 'Primi', max: 1, slots: ['A', 'B'] },
        { name: 'Secondi', max: 1, slots: ['E'] },
      ],
    },
  })).body;

  const mgrAlfa = (await call(db, 'POST', '/api/login', { body: { code: alfa.codeManager } })).body.token;
  const mgrBeta = (await call(db, 'POST', '/api/login', { body: { code: beta.codeManager } })).body.token;
  const rossi = (await call(db, 'POST', '/api/manager/employees', { token: mgrAlfa, body: { name: 'Mario Rossi', locker: '12' } })).body;
  const bianchi = (await call(db, 'POST', '/api/manager/employees', { token: mgrAlfa, body: { name: 'Anna Bianchi', locker: '3' } })).body;
  const verdi = (await call(db, 'POST', '/api/manager/employees', { token: mgrBeta, body: { name: 'Luca Verdi', locker: '7' } })).body;

  const slotByCode = {};
  for (const course of alfa.courses) for (const slot of course.slots) slotByCode[slot.code] = slot.id;
  await call(db, 'PUT', '/api/admin/menu', { token: admin, body: { companyId: alfa.id, week: WEEK, items: grigliaItems(slotByCode) } });

  return { db, admin, alfa, beta, mgrAlfa, mgrBeta, rossi, bianchi, verdi, slotByCode };
}

/** Al primo accesso la persona sceglie il PIN; poi lo inserisce. Qui si fanno entrambe le cose con lo stesso valore. */
async function staffToken(db, code, employeeId, pin = '1234') {
  const login = (await call(db, 'POST', '/api/login', { body: { code } })).body.token;
  const esito = await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId, newPin: pin, pin } });
  if (esito.status !== 200) throw new Error(`identify: ${esito.status} ${JSON.stringify(esito.body)}`);
  return esito.body.token;
}

/** Gli id dei piatti di un giorno, per lettera. */
async function piattiDelGiorno(db, token, day) {
  const settimana = (await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token })).body;
  const mappa = {};
  for (const item of settimana.menu) if (item.day === day) mappa[item.code] = item.id;
  return { mappa, settimana };
}

const ordina = (db, token, day, items) =>
  call(db, 'POST', '/api/staff/order', { token, body: { week: WEEK, days: [{ day, items }] } });

test('la nuova azienda nasce con la griglia A B E F G H L P T e 3 piatti al giorno', async () => {
  const { alfa } = await scenario();
  assert.equal(alfa.maxDishes, 3);
  assert.deepEqual(
    alfa.courses.map((c) => `${c.name}:${c.slots.map((s) => s.code).join('')}:${c.max}`),
    ['Primi:AB:1', 'Secondi:EF:1', 'Contorni:GH:2', 'Dessert:L:1', 'Frutta:P:1', 'Pasto unico:T:1']
  );
  assert.equal(alfa.courses.find((c) => c.name === 'Pasto unico').single, true);
});

test('si ordinano al massimo 3 piatti al giorno', async () => {
  const { db, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);

  assert.equal((await ordina(db, token, 1, [mappa.A, mappa.E, mappa.H])).status, 200, 'primo, secondo e contorno');
  const quattro = await ordina(db, token, 1, [mappa.A, mappa.E, mappa.H, mappa.L]);
  assert.equal(quattro.status, 400);
  assert.match(quattro.body.error, /Massimo 3 piatti/);
});

test('non si ordina doppio secondo, né doppio primo', async () => {
  const { db, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);

  const secondi = await ordina(db, token, 1, [mappa.E, mappa.F]);
  assert.equal(secondi.status, 400);
  assert.match(secondi.body.error, /un solo piatto fra i secondi/i);

  const primi = await ordina(db, token, 1, [mappa.A, mappa.B]);
  assert.equal(primi.status, 400);
  assert.match(primi.body.error, /un solo piatto fra i primi/i);
});

test('i due contorni insieme si possono prendere', async () => {
  const { db, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  assert.equal((await ordina(db, token, 1, [mappa.A, mappa.G, mappa.H])).status, 200);
});

test('il pasto unico T vale da solo: non si combina con altro', async () => {
  const { db, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);

  assert.equal((await ordina(db, token, 1, [mappa.T])).status, 200);
  const misto = await ordina(db, token, 1, [mappa.T, mappa.H]);
  assert.equal(misto.status, 400);
  assert.match(misto.body.error, /piatto unico/i);
});

test('la pizza del mercoledì è un piatto unico pur stando fra i secondi', async () => {
  const { db, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa, settimana } = await piattiDelGiorno(db, token, 3);
  const pizza = settimana.menu.find((m) => m.day === 3 && m.code === 'E');
  assert.equal(pizza.single, true, 'la casella è marcata piatto unico');
  assert.equal(settimana.menu.find((m) => m.day === 3 && m.code === 'F').single, false, 'gli altri secondi no');

  assert.equal((await ordina(db, token, 3, [pizza.id])).status, 200);
  const conContorno = await ordina(db, token, 3, [pizza.id, mappa.H]);
  assert.equal(conContorno.status, 400);
  assert.match(conContorno.body.error, /piatto unico/i);
});

test('ogni azienda ha le sue regole: Beta ha 2 piatti e un solo secondo', async () => {
  const { db, beta, verdi, admin } = await scenario();
  const slotByCode = {};
  for (const course of beta.courses) for (const slot of course.slots) slotByCode[slot.code] = slot.id;
  await call(db, 'PUT', '/api/admin/menu', {
    token: admin,
    body: {
      companyId: beta.id,
      week: WEEK,
      items: [
        { day: 1, slotId: slotByCode.A, name: 'Pasta e ceci' },
        { day: 1, slotId: slotByCode.B, name: 'Pasta al pomodoro' },
        { day: 1, slotId: slotByCode.E, name: 'Salsiccia al vino bianco' },
      ],
    },
  });
  const token = await staffToken(db, beta.codeStaff, verdi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  assert.equal((await ordina(db, token, 1, [mappa.A, mappa.E])).status, 200);
  const tre = await ordina(db, token, 1, [mappa.A, mappa.E, mappa.B]);
  assert.equal(tre.status, 400);
});

test('la casella vuota non si può ordinare (mercoledì non c\'è il contorno G)', async () => {
  const { db, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa, settimana } = await piattiDelGiorno(db, token, 3);
  assert.equal(mappa.G, undefined, 'la casella G del mercoledì è vuota nel foglio');
  const gLunedi = settimana.menu.find((m) => m.day === 1 && m.code === 'G');
  const sbagliato = await ordina(db, token, 3, [gLunedi.id]);
  assert.equal(sbagliato.status, 400);
});

test('vale sempre l\'ultimo invio, e "non pranzo" azzera le scelte del giorno', async () => {
  const { db, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  await call(db, 'POST', '/api/staff/order', { token, body: { week: WEEK, days: [{ day: 1, items: [mappa.A, mappa.E] }, { day: 2, items: [] }] } });
  await call(db, 'POST', '/api/staff/order', { token, body: { week: WEEK, days: [{ day: 1, items: [mappa.B] }, { day: 2, skip: true }] } });

  const dopo = (await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token })).body;
  assert.deepEqual(dopo.order.days['1'].items, [mappa.B]);
  assert.equal(dopo.order.days['2'].skip, true);
  const righe = await db.first('SELECT COUNT(*) AS n FROM orders WHERE employee_id = ?', [rossi.id]);
  assert.equal(righe.n, 1, 'un solo ordine per persona per settimana');
});

test('il nome si sceglie da elenco: un id di un\'altra azienda viene rifiutato', async () => {
  const { db, alfa, verdi } = await scenario();
  const login = (await call(db, 'POST', '/api/login', { body: { code: alfa.codeStaff } })).body.token;
  const elenco = await call(db, 'GET', '/api/staff/employees', { token: login });
  assert.deepEqual(elenco.body.employees.map((e) => e.name).sort(), ['Anna Bianchi', 'Mario Rossi']);
  assert.equal((await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: verdi.id } })).status, 400);
});

test('i dati di un\'azienda non sono visibili a un\'altra', async () => {
  const { db, mgrBeta } = await scenario();
  assert.deepEqual((await call(db, 'GET', '/api/manager/employees', { token: mgrBeta })).body.employees.map((e) => e.name), ['Luca Verdi']);
  assert.equal((await call(db, 'GET', '/api/admin/companies', { token: mgrBeta })).status, 403);
  assert.equal((await call(db, 'DELETE', '/api/manager/employees/1', { token: mgrBeta })).status, 404);
});

test('riepilogo cucina: somma le porzioni di tutte le aziende e riporta la lettera', async () => {
  const { db, admin, alfa, beta, rossi, bianchi, verdi } = await scenario();
  const slotBeta = {};
  for (const course of beta.courses) for (const slot of course.slots) slotBeta[slot.code] = slot.id;
  await call(db, 'PUT', '/api/admin/menu', {
    token: admin,
    body: { companyId: beta.id, week: WEEK, items: [{ day: 1, slotId: slotBeta.A, name: 'Pasta e ceci' }] },
  });

  for (const [code, employee] of [[alfa.codeStaff, rossi], [alfa.codeStaff, bianchi], [beta.codeStaff, verdi]]) {
    const token = await staffToken(db, code, employee.id);
    const { mappa } = await piattiDelGiorno(db, token, 1);
    await ordina(db, token, 1, [mappa.A]);
  }

  const cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body;
  const lunedi = cucina.days.find((d) => d.day === 1);
  const pasta = lunedi.courses.flatMap((c) => c.dishes).find((d) => d.name === 'Pasta e ceci');
  assert.equal(pasta.qty, 3, 'le porzioni delle due aziende sono sommate');
  assert.equal(pasta.codes, 'A');
  assert.equal(lunedi.people, 3);
});

test('riepilogo consegne: persone per armadietto, con le lettere ordinate', async () => {
  const { db, admin, alfa, rossi, bianchi } = await scenario();
  for (const employee of [rossi, bianchi]) {
    const token = await staffToken(db, alfa.codeStaff, employee.id);
    const { mappa } = await piattiDelGiorno(db, token, 1);
    await ordina(db, token, 1, [mappa.H, mappa.A]);
  }
  const consegne = (await call(db, 'GET', `/api/admin/report/delivery?week=${WEEK}`, { token: admin })).body;
  const azienda = consegne.days.find((d) => d.day === 1).companies[0];
  assert.deepEqual(azienda.people.map((p) => p.locker), ['3', '12'], 'ordinamento numerico');
  assert.deepEqual(azienda.people[0].choices.map((c) => c.code), ['A', 'H'], 'lettere in ordine di griglia');
});

test('correggere una casella non azzera gli ordini: chi ha preso la A mantiene la A', async () => {
  const { db, admin, alfa, rossi, slotByCode } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  await ordina(db, token, 1, [mappa.A]);

  const items = grigliaItems(slotByCode).map((item) =>
    item.day === 1 && item.slotId === slotByCode.A ? { ...item, name: 'Pasta e fagioli' } : item
  );
  await call(db, 'PUT', '/api/admin/menu', { token: admin, body: { companyId: alfa.id, week: WEEK, items } });

  const dopo = (await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token })).body;
  assert.deepEqual(dopo.order.days['1'].items, [mappa.A], 'la scelta resta legata alla lettera');
  assert.equal(dopo.menu.find((m) => m.id === mappa.A).name, 'Pasta e fagioli');
});

test('copia a tutte: allinea per lettera e segnala quelle mancanti', async () => {
  const { db, admin, alfa, beta } = await scenario();
  const esito = await call(db, 'POST', '/api/admin/menu/copy', {
    token: admin,
    body: { fromCompanyId: alfa.id, week: WEEK, toCompanyIds: 'all' },
  });
  assert.equal(esito.status, 200);
  // Beta ha solo A, B, E: le altre lettere restano fuori invece di finire nel posto sbagliato.
  assert.deepEqual(esito.body.report[0].missing, ['F', 'G', 'H', 'L', 'P', 'T']);
  const copiato = (await call(db, 'GET', `/api/admin/menu?companyId=${beta.id}&week=${WEEK}`, { token: admin })).body;
  assert.deepEqual([...new Set(copiato.items.map((i) => i.code))].sort(), ['A', 'B', 'E']);
  assert.equal(copiato.items.find((i) => i.day === 3 && i.code === 'E').single, true, 'la pizza resta piatto unico');
});

test('cancellare una persona cancella i suoi ordini', async () => {
  const { db, alfa, mgrAlfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  await ordina(db, token, 1, [mappa.A]);
  await call(db, 'DELETE', `/api/manager/employees/${rossi.id}`, { token: mgrAlfa });
  assert.equal((await db.first('SELECT COUNT(*) AS n FROM orders WHERE employee_id = ?', [rossi.id])).n, 0);
  assert.equal((await db.first('SELECT COUNT(*) AS n FROM order_choices')).n, 0);
});

test('la cancellazione dei dati storici rispetta la settimana limite', async () => {
  const { db, admin, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  await ordina(db, token, 1, [mappa.A]);

  assert.equal((await call(db, 'POST', '/api/admin/purge', { token: admin, body: { beforeWeek: WEEK } })).body.orders, 0);
  assert.equal((await call(db, 'POST', '/api/admin/purge', { token: admin, body: { beforeWeek: NEXT } })).body.orders, 1);
  assert.equal((await purgeExpired(db, 12)).orders, 0);
});

test('le regole si possono cambiare per azienda mantenendo gli ordini validi', async () => {
  const { db, admin, alfa, rossi } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  await ordina(db, token, 1, [mappa.A, mappa.G, mappa.H]);

  const contorni = alfa.courses.find((c) => c.name === 'Contorni');
  const aggiornate = alfa.courses.map((c) => ({
    id: c.id,
    name: c.name,
    max: c.id === contorni.id ? 1 : c.max,
    single: c.single,
    slots: c.slots.map((s) => ({ id: s.id, code: s.code })),
  }));
  const esito = await call(db, 'PUT', `/api/admin/companies/${alfa.id}/courses`, {
    token: admin,
    body: { maxDishes: 3, courses: aggiornate },
  });
  assert.equal(esito.status, 200);
  assert.equal(esito.body.courses.find((c) => c.name === 'Contorni').max, 1);

  // Il vecchio ordine resta in archivio, ma un nuovo invio con due contorni viene rifiutato.
  const nuovo = await ordina(db, token, 1, [mappa.G, mappa.H]);
  assert.equal(nuovo.status, 400);
});

test('senza sessione valida non si legge nulla', async () => {
  const { db } = await scenario();
  assert.equal((await call(db, 'GET', '/api/admin/companies')).status, 401);
  assert.equal((await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token: 'falso.token' })).status, 401);
  assert.equal((await call(db, 'GET', '/api/manager/employees', { token: 'a.b' })).status, 401);
});

test('un collega che sbaglia il codice non blocca tutta l\'azienda', async () => {
  const { db, alfa } = await scenario();
  const tentativo = (code) => {
    const request = new Request('http://t.local/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1' },
      body: JSON.stringify({ code }),
    });
    return handleApi(request, env, db);
  };
  // Un'intera fabbrica esce dallo stesso IP: 20 errori sullo stesso codice sbagliato...
  let bloccato = 0;
  for (let i = 0; i < 20; i++) {
    const r = await tentativo('SBAGLIATO');
    if (r.status === 429) { bloccato = bloccato || i + 1; break; }
  }
  assert.ok(bloccato > 0 && bloccato <= 11, `il codice sbagliato viene bloccato (al tentativo ${bloccato})`);

  // ...non devono impedire al collega con il codice giusto, dallo stesso IP, di entrare.
  const buono = await tentativo(alfa.codeStaff);
  assert.equal(buono.status, 200);
});

test('il foglio cucina elenca i piatti nell\'ordine delle lettere', async () => {
  const { db, admin, alfa, rossi, bianchi } = await scenario();
  for (const [employee, codice] of [[rossi, 'B'], [bianchi, 'A']]) {
    const token = await staffToken(db, alfa.codeStaff, employee.id);
    const { mappa } = await piattiDelGiorno(db, token, 1);
    await ordina(db, token, 1, [mappa[codice]]);
  }
  const cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body;
  const primi = cucina.days.find((d) => d.day === 1).courses.find((c) => c.name === 'Primi');
  assert.deepEqual(primi.dishes.map((d) => d.codes), ['A', 'B'], 'prima la A, poi la B');
});


test('dopo la scadenza la settimana non si modifica più', async () => {
  const { db, alfa, rossi, admin } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  // La settimana corrente è chiusa: la sua scadenza (venerdì scorso alle 12) è passata.
  const chiusa = currentWeek();
  const settimana = (await call(db, 'GET', `/api/staff/week?week=${chiusa}`, { token })).body;
  assert.equal(settimana.deadline.locked, true);
  assert.match(settimana.deadline.label, /venerdì .* alle 12:00/);
  const tentativo = await call(db, 'POST', '/api/staff/order', { token, body: { week: chiusa, days: [{ day: 1, skip: true }] } });
  assert.equal(tentativo.status, 423);
  assert.match(tentativo.body.error, /Ordini chiusi/);

  // Quella fra due settimane è aperta e riporta quando chiuderà.
  const aperta = (await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token })).body;
  assert.equal(aperta.deadline.locked, false);
  assert.ok(aperta.deadline.at > Date.now());

  // Il ristorante può spostare la scadenza: l'etichetta della settimana aperta cambia di conseguenza.
  const salvate = await call(db, 'PUT', '/api/admin/settings', {
    token: admin,
    body: { name: 'Time Out', deadline: { day: 4, time: '18:30', timezone: 'Europe/Rome' } },
  });
  assert.equal(salvate.status, 200);
  const dopo = (await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token })).body;
  assert.match(dopo.deadline.label, /^giovedì .* alle 18:30$/);
});

test('rigenerare i codici revoca le sessioni già aperte', async () => {
  const { db, admin, alfa, rossi, mgrAlfa } = await scenario();
  const staff = await staffToken(db, alfa.codeStaff, rossi.id);
  assert.equal((await call(db, 'GET', '/api/manager/employees', { token: mgrAlfa })).status, 200);
  await call(db, 'POST', `/api/admin/companies/${alfa.id}/codes`, { token: admin });
  assert.equal((await call(db, 'GET', '/api/manager/employees', { token: mgrAlfa })).status, 401, 'il referente deve rientrare');
  assert.equal((await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token: staff })).status, 401, 'anche il dipendente');
  assert.equal((await call(db, 'GET', '/api/admin/companies', { token: admin })).status, 200, 'il ristorante no');
});

test('il codice del ristorante è conservato come impronta e si può cambiare', async () => {
  const { db, admin } = await scenario();
  const row = await db.first('SELECT code_hash FROM restaurant WHERE id = 1');
  assert.ok(row.code_hash.startsWith('pbkdf2$') && !row.code_hash.includes('RISTO99'));

  const sbagliato = await call(db, 'POST', '/api/admin/code', { token: admin, body: { current: 'NO', next: 'NUOVO123' } });
  assert.equal(sbagliato.status, 403);
  const cambiato = await call(db, 'POST', '/api/admin/code', { token: admin, body: { current: 'RISTO99', next: 'NUOVO123' } });
  assert.equal(cambiato.status, 200);
  assert.equal((await call(db, 'GET', '/api/admin/companies', { token: admin })).status, 401, 'la vecchia sessione decade');
  assert.equal((await call(db, 'GET', '/api/admin/companies', { token: cambiato.body.token })).status, 200, 'quella nuova vale');
  assert.equal((await call(db, 'POST', '/api/login', { body: { code: 'RISTO99' } })).status, 401);
  assert.equal((await call(db, 'POST', '/api/login', { body: { code: 'nuovo 123' } })).status, 200);
});

test('con SETUP_CODE impostato il primo avvio è protetto', async () => {
  const db = freshDb();
  const envProtetto = { ...env, SETUP_CODE: 'INSTALLA' };
  const request = (body) =>
    handleApi(new Request('http://t.local/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), envProtetto, db);
  assert.equal((await request({ name: 'T', code: 'RISTO99' })).status, 403);
  assert.equal((await request({ name: 'T', code: 'RISTO99', setupCode: 'installa' })).status, 201);
});

test('il referente importa un elenco incollato: nuovi, già presenti, armadietti occupati', async () => {
  const { db, mgrAlfa } = await scenario();
  const esito = await call(db, 'POST', '/api/manager/employees/bulk', {
    token: mgrAlfa,
    body: {
      people: [
        { name: 'Giulia Conti', locker: '7' },
        { name: 'mario rossi', locker: '40' },      // c'è già (maiuscole diverse): saltato
        { name: 'Paolo Neri', locker: '12' },       // armadietto di Mario Rossi: in conflitto
        { name: 'Sara Gallo', locker: '5' },
      ],
    },
  });
  assert.equal(esito.status, 201);
  assert.equal(esito.body.inserted, 2);
  assert.deepEqual(esito.body.skipped, ['mario rossi']);
  assert.deepEqual(esito.body.conflicts, [{ name: 'Paolo Neri', locker: '12', by: 'Mario Rossi' }]);
  const elenco = (await call(db, 'GET', '/api/manager/employees', { token: mgrAlfa })).body.employees;
  assert.equal(elenco.length, 4);
});

test('un corpo JSON senza content-type o troppo grande viene rifiutato', async () => {
  const { db } = await scenario();
  const senzaTipo = await handleApi(new Request('http://t.local/api/login', { method: 'POST', body: JSON.stringify({ code: 'X' }) }), env, db);
  assert.equal(senzaTipo.status, 400);
  const enorme = await handleApi(
    new Request('http://t.local/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x'.repeat(300 * 1024) }) }),
    env,
    db
  );
  assert.equal(enorme.status, 413);
});

test('i CSV non eseguono formule: un nome che inizia con = viene neutralizzato', async () => {
  const { db, admin, alfa, mgrAlfa } = await scenario();
  const persona = (await call(db, 'POST', '/api/manager/employees', { token: mgrAlfa, body: { name: '=HYPERLINK("http://male")', locker: '77' } })).body;
  const token = await staffToken(db, alfa.codeStaff, persona.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  await ordina(db, token, 1, [mappa.A]);
  const csv = await call(db, 'GET', `/api/admin/report/delivery?week=${WEEK}&format=csv`, { token: admin });
  assert.ok(String(csv.body).includes("'=HYPERLINK"), 'apostrofo davanti alla formula');
  assert.ok(!/;=HYPERLINK/.test(String(csv.body)), 'nessuna cella che inizia con =');
});


test('PIN personale: si sceglie al primo accesso, poi serve; il referente lo azzera', async () => {
  const { db, alfa, rossi, mgrAlfa } = await scenario();
  const login = (await call(db, 'POST', '/api/login', { body: { code: alfa.codeStaff } })).body.token;
  const elenco = (await call(db, 'GET', '/api/staff/employees', { token: login })).body.employees;
  assert.equal(elenco.find((e) => e.id === rossi.id).hasPin, false);

  const senza = await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id } });
  assert.equal(senza.status, 400, 'senza PIN al primo accesso non si entra');
  const corto = await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, newPin: '12' } });
  assert.equal(corto.status, 400);
  assert.equal((await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, newPin: '2468' } })).status, 200);

  const dopo = (await call(db, 'GET', '/api/staff/employees', { token: login })).body.employees;
  assert.equal(dopo.find((e) => e.id === rossi.id).hasPin, true);
  assert.equal((await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, pin: '0000' } })).status, 401);
  assert.equal((await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, newPin: '9999' } })).status, 401, 'con il PIN impostato non si sovrascrive');
  assert.equal((await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, pin: '2468' } })).status, 200);
  assert.ok(!(await db.first('SELECT pin_hash FROM employees WHERE id = ?', [rossi.id])).pin_hash.includes('2468'), 'nel database sta l\'impronta');

  // Troppi tentativi sbagliati: si ferma, anche col PIN giusto, finché il referente non azzera.
  for (let i = 0; i < 8; i++) await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, pin: '1111' } });
  assert.equal((await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, pin: '2468' } })).status, 429);
  assert.equal((await call(db, 'POST', `/api/manager/employees/${rossi.id}/pin/reset`, { token: mgrAlfa })).status, 200);
  assert.equal((await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: rossi.id, newPin: '1357' } })).status, 200, 'dopo l\'azzeramento si sceglie un PIN nuovo');
});

test('stand-by per giorno: il pasto sparisce da cucina e consegne, anche a settimana chiusa', async () => {
  const { db, admin, alfa, rossi, mgrAlfa } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 2);
  await ordina(db, token, 2, [mappa.A, mappa.E]);

  let cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body;
  assert.equal(cucina.days[1].people, 1);

  // Il referente mette Mario in stand-by per martedì.
  const esito = await call(db, 'PUT', '/api/manager/suspensions', { token: mgrAlfa, body: { employeeId: rossi.id, week: WEEK, day: 2, suspended: true } });
  assert.equal(esito.status, 200);
  cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body;
  assert.equal(cucina.days[1].people, 0, 'la cucina non lo cuoce');
  const consegne = (await call(db, 'GET', `/api/admin/report/delivery?week=${WEEK}`, { token: admin })).body;
  assert.equal(consegne.days[1].companies.length, 0, 'non si consegna');
  const stato = (await call(db, 'GET', `/api/manager/week?week=${WEEK}`, { token: mgrAlfa })).body;
  assert.equal(stato.employees.find((e) => e.id === rossi.id).days[1], 'sospeso');
  const visto = (await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token })).body;
  assert.deepEqual(visto.suspended, [2], 'il dipendente lo vede');

  // Anche sulla settimana corrente, già chiusa: togliere si può sempre.
  const chiusa = currentWeek();
  assert.equal((await call(db, 'PUT', '/api/manager/suspensions', { token: mgrAlfa, body: { employeeId: rossi.id, week: chiusa, day: 3, suspended: true } })).status, 200);

  // Riattivare ripristina il pasto pianificato.
  await call(db, 'PUT', '/api/manager/suspensions', { token: mgrAlfa, body: { employeeId: rossi.id, week: WEEK, day: 2, suspended: false } });
  cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body;
  assert.equal(cucina.days[1].people, 1);
});

test('blocco permanente: la persona non entra e i suoi pasti non si preparano', async () => {
  const { db, admin, alfa, rossi, mgrAlfa } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const { mappa } = await piattiDelGiorno(db, token, 1);
  await ordina(db, token, 1, [mappa.A]);
  await call(db, 'PUT', `/api/manager/employees/${rossi.id}`, { token: mgrAlfa, body: { name: 'Mario Rossi', locker: '12', active: false } });
  assert.equal((await call(db, 'GET', `/api/staff/week?week=${WEEK}`, { token })).status, 403, 'la sessione aperta non serve più');
  const login = (await call(db, 'POST', '/api/login', { body: { code: alfa.codeStaff } })).body.token;
  assert.ok(!(await call(db, 'GET', '/api/staff/employees', { token: login })).body.employees.some((e) => e.id === rossi.id), 'non è più nell\'elenco');
  const cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body;
  assert.equal(cucina.days[0].people, 0);
  // Riattivato, torna tutto come prima: l'ordine non è andato perso.
  await call(db, 'PUT', `/api/manager/employees/${rossi.id}`, { token: mgrAlfa, body: { name: 'Mario Rossi', locker: '12', active: true } });
  assert.equal((await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body.days[0].people, 1);
});

test('pasti extra del referente: contati in cucina e in consegna, con le stesse regole', async () => {
  const { db, admin, alfa, mgrAlfa } = await scenario();
  const menu = (await call(db, 'GET', `/api/manager/menu?week=${WEEK}`, { token: mgrAlfa })).body;
  const lun = Object.fromEntries(menu.menu.filter((m) => m.day === 1).map((m) => [m.code, m.id]));

  const troppi = await call(db, 'POST', '/api/manager/extras', { token: mgrAlfa, body: { week: WEEK, day: 1, qty: 2, items: [lun.A, lun.B] } });
  assert.equal(troppi.status, 400, 'due primi no, nemmeno per gli extra');
  const ok = await call(db, 'POST', '/api/manager/extras', { token: mgrAlfa, body: { week: WEEK, day: 1, qty: 3, note: 'interinali', items: [lun.A, lun.E, lun.H] } });
  assert.equal(ok.status, 201);

  const cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body;
  assert.equal(cucina.days[0].people, 3);
  assert.equal(cucina.days[0].courses.find((c) => c.name === 'Primi').dishes[0].qty, 3);
  const consegne = (await call(db, 'GET', `/api/admin/report/delivery?week=${WEEK}`, { token: admin })).body;
  const azienda = consegne.days[0].companies.find((c) => c.company === 'Alfa SpA');
  assert.equal(azienda.extras[0].qty, 3);
  assert.deepEqual(azienda.extras[0].choices.map((c) => c.code), ['A', 'E', 'H']);
  const csv = await call(db, 'GET', `/api/admin/report/delivery?week=${WEEK}&format=csv`, { token: admin });
  assert.ok(String(csv.body).includes(';EXTRA;3 × interinali;AEH;'));

  const stato = (await call(db, 'GET', `/api/manager/week?week=${WEEK}`, { token: mgrAlfa })).body;
  assert.equal(stato.extras.length, 1);

  // A settimana chiusa non si aggiunge; togliere sì.
  const chiusa = currentWeek();
  const tardi = await call(db, 'POST', '/api/manager/extras', { token: mgrAlfa, body: { week: chiusa, day: 1, qty: 1, items: [lun.A] } });
  assert.equal(tardi.status, 423);
  assert.equal((await call(db, 'DELETE', `/api/manager/extras/${ok.body.id}`, { token: mgrAlfa })).status, 200);
  assert.equal((await call(db, 'GET', `/api/admin/report/kitchen?week=${WEEK}`, { token: admin })).body.days[0].people, 0);
});
