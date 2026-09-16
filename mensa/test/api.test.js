import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi, purgeExpired } from '../src/api.js';
import { openSqlite } from '../src/db-sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
const env = { SESSION_SECRET: 'segreto-di-prova' };

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

/** Scenario completo: ristorante → azienda → dipendenti → menù. */
async function scenario() {
  const db = freshDb();
  await call(db, 'POST', '/api/setup', { body: { name: 'Trattoria Bella', code: 'RISTO99' } });
  const admin = (await call(db, 'POST', '/api/login', { body: { code: 'risto-99' } })).body.token;

  const alfa = (
    await call(db, 'POST', '/api/admin/companies', {
      token: admin,
      body: {
        name: 'Alfa SpA',
        courses: [
          { name: 'Primo', max: 1 },
          { name: 'Secondo', max: 1 },
          { name: 'Contorno', max: 2 },
        ],
      },
    })
  ).body;
  const beta = (
    await call(db, 'POST', '/api/admin/companies', {
      token: admin,
      body: { name: 'Beta Srl', courses: [{ name: 'Primo', max: 1 }, { name: 'Secondo', max: 1 }] },
    })
  ).body;

  const mgrAlfa = (await call(db, 'POST', '/api/login', { body: { code: alfa.codeManager } })).body.token;
  const mgrBeta = (await call(db, 'POST', '/api/login', { body: { code: beta.codeManager } })).body.token;
  const rossi = (await call(db, 'POST', '/api/manager/employees', { token: mgrAlfa, body: { name: 'Mario Rossi', locker: '12' } })).body;
  const bianchi = (await call(db, 'POST', '/api/manager/employees', { token: mgrAlfa, body: { name: 'Anna Bianchi', locker: '3' } })).body;
  const verdi = (await call(db, 'POST', '/api/manager/employees', { token: mgrBeta, body: { name: 'Luca Verdi', locker: '7' } })).body;

  const week = '2026-W38';
  const menu = [];
  for (const day of [1, 2, 3, 4, 5]) {
    menu.push({ day, courseId: alfa.courses[0].id, name: 'Pasta al pomodoro' });
    menu.push({ day, courseId: alfa.courses[0].id, name: 'Riso in bianco' });
    menu.push({ day, courseId: alfa.courses[1].id, name: 'Pollo arrosto' });
    menu.push({ day, courseId: alfa.courses[2].id, name: 'Insalata' });
    menu.push({ day, courseId: alfa.courses[2].id, name: 'Patate' });
  }
  await call(db, 'PUT', '/api/admin/menu', { token: admin, body: { companyId: alfa.id, week, items: menu } });

  return { db, admin, alfa, beta, mgrAlfa, mgrBeta, rossi, bianchi, verdi, week };
}

async function staffToken(db, code, employeeId) {
  const login = (await call(db, 'POST', '/api/login', { body: { code } })).body.token;
  return (await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId } })).body.token;
}

test('il primo avvio si esegue una volta sola', async () => {
  const db = freshDb();
  const first = await call(db, 'POST', '/api/setup', { body: { name: 'Trattoria', code: 'ABCDEF' } });
  assert.equal(first.status, 201);
  const second = await call(db, 'POST', '/api/setup', { body: { name: 'Altra', code: 'GHIJKL' } });
  assert.equal(second.status, 409);
});

test('il codice di accesso determina il ruolo ed è tollerante a spazi e minuscole', async () => {
  const { db, alfa } = await scenario();
  assert.equal((await call(db, 'POST', '/api/login', { body: { code: 'risto 99' } })).body.role, 'admin');
  assert.equal((await call(db, 'POST', '/api/login', { body: { code: alfa.codeManager } })).body.role, 'manager');
  assert.equal((await call(db, 'POST', '/api/login', { body: { code: alfa.codeStaff } })).body.role, 'staff');
  assert.equal((await call(db, 'POST', '/api/login', { body: { code: 'XXXXXX' } })).status, 401);
});

test("il nome si sceglie da elenco: un id di un'altra azienda viene rifiutato", async () => {
  const { db, alfa, verdi } = await scenario();
  const login = (await call(db, 'POST', '/api/login', { body: { code: alfa.codeStaff } })).body.token;
  const elenco = await call(db, 'GET', '/api/staff/employees', { token: login });
  assert.deepEqual(elenco.body.employees.map((e) => e.name).sort(), ['Anna Bianchi', 'Mario Rossi']);
  const intruso = await call(db, 'POST', '/api/staff/identify', { token: login, body: { employeeId: verdi.id } });
  assert.equal(intruso.status, 400);
});

test("i dati di un'azienda non sono visibili a un'altra", async () => {
  const { db, mgrBeta, alfa } = await scenario();
  const elenco = await call(db, 'GET', '/api/manager/employees', { token: mgrBeta });
  assert.deepEqual(elenco.body.employees.map((e) => e.name), ['Luca Verdi']);
  // un referente non può usare le rotte del ristorante
  assert.equal((await call(db, 'GET', '/api/admin/companies', { token: mgrBeta })).status, 403);
  // né modificare le persone di un'altra azienda
  const altrui = await call(db, 'DELETE', `/api/manager/employees/${alfa.id === 1 ? 1 : 1}`, { token: mgrBeta });
  assert.equal(altrui.status, 404);
});

test("l'ordine rispetta i massimi per portata", async () => {
  const { db, alfa, rossi, week } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const settimana = (await call(db, 'GET', `/api/staff/week?week=${week}`, { token })).body;
  const lun = settimana.menu.filter((m) => m.day === 1);
  const primi = lun.filter((m) => m.courseId === alfa.courses[0].id).map((m) => m.id);
  const contorni = lun.filter((m) => m.courseId === alfa.courses[2].id).map((m) => m.id);

  const troppi = await call(db, 'POST', '/api/staff/order', {
    token,
    body: { week, days: [{ day: 1, items: primi }] },
  });
  assert.equal(troppi.status, 400);
  assert.match(troppi.body.error, /massimo 1 per "Primo"/);

  const ok = await call(db, 'POST', '/api/staff/order', {
    token,
    body: { week, days: [{ day: 1, items: [primi[0], ...contorni] }] },
  });
  assert.equal(ok.status, 200);
});

test("un piatto di un'altra azienda o di un altro giorno viene rifiutato", async () => {
  const { db, admin, alfa, beta, rossi, week } = await scenario();
  const corsiBeta = beta.courses;
  await call(db, 'PUT', '/api/admin/menu', {
    token: admin,
    body: { companyId: beta.id, week, items: [{ day: 1, courseId: corsiBeta[0].id, name: 'Lasagne' }] },
  });
  const lasagne = (await call(db, `GET`, `/api/admin/menu?companyId=${beta.id}&week=${week}`, { token: admin })).body.items[0];

  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const altrui = await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [lasagne.id] }] } });
  assert.equal(altrui.status, 400);

  const settimana = (await call(db, 'GET', `/api/staff/week?week=${week}`, { token })).body;
  const primoLunedi = settimana.menu.find((m) => m.day === 1 && m.courseId === alfa.courses[0].id);
  const giornoSbagliato = await call(db, 'POST', '/api/staff/order', {
    token,
    body: { week, days: [{ day: 2, items: [primoLunedi.id] }] },
  });
  assert.equal(giornoSbagliato.status, 400);
});

test('vale sempre l\'ultimo invio, e "non pranzo" azzera le scelte del giorno', async () => {
  const { db, alfa, rossi, week } = await scenario();
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  const menu = (await call(db, 'GET', `/api/staff/week?week=${week}`, { token })).body.menu;
  const primo = (day) => menu.find((m) => m.day === day && m.courseId === alfa.courses[0].id).id;

  await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [primo(1)] }, { day: 2, items: [primo(2)] }] } });
  await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [primo(1)] }, { day: 2, skip: true }] } });

  const dopo = (await call(db, 'GET', `/api/staff/week?week=${week}`, { token })).body;
  assert.deepEqual(dopo.order.days['1'].items, [primo(1)]);
  assert.equal(dopo.order.days['2'].skip, true);
  assert.deepEqual(dopo.order.days['2'].items, []);
  const righe = await db.first('SELECT COUNT(*) AS n FROM orders WHERE employee_id = ?', [rossi.id]);
  assert.equal(righe.n, 1, 'un solo ordine per persona per settimana');
});

test('riepilogo cucina: somma le porzioni di tutte le aziende', async () => {
  const { db, admin, alfa, beta, rossi, bianchi, verdi, week } = await scenario();
  await call(db, 'PUT', '/api/admin/menu', {
    token: admin,
    body: {
      companyId: beta.id,
      week,
      items: [
        { day: 1, courseId: beta.courses[0].id, name: 'Pasta al pomodoro' },
        { day: 1, courseId: beta.courses[1].id, name: 'Pollo arrosto' },
      ],
    },
  });
  const menuAlfa = (await call(db, 'GET', `/api/admin/menu?companyId=${alfa.id}&week=${week}`, { token: admin })).body.items;
  const menuBeta = (await call(db, 'GET', `/api/admin/menu?companyId=${beta.id}&week=${week}`, { token: admin })).body.items;
  const pastaAlfa = menuAlfa.find((m) => m.day === 1 && m.name === 'Pasta al pomodoro').id;
  const pastaBeta = menuBeta.find((m) => m.name === 'Pasta al pomodoro').id;

  for (const [code, employee, item] of [
    [alfa.codeStaff, rossi, pastaAlfa],
    [alfa.codeStaff, bianchi, pastaAlfa],
    [beta.codeStaff, verdi, pastaBeta],
  ]) {
    const token = await staffToken(db, code, employee.id);
    await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [item] }] } });
  }

  const cucina = (await call(db, 'GET', `/api/admin/report/kitchen?week=${week}`, { token: admin })).body;
  const lunedi = cucina.days.find((d) => d.day === 1);
  const pasta = lunedi.courses.flatMap((c) => c.dishes).find((d) => d.name === 'Pasta al pomodoro');
  assert.equal(pasta.qty, 3, 'le tre porzioni delle due aziende sono sommate');
  assert.equal(lunedi.people, 3);
});

test('riepilogo consegne: persone ordinate per armadietto, divise per azienda', async () => {
  const { db, admin, alfa, rossi, bianchi, week } = await scenario();
  const menu = (await call(db, 'GET', `/api/admin/menu?companyId=${alfa.id}&week=${week}`, { token: admin })).body.items;
  const primo = menu.find((m) => m.day === 1 && m.courseId === alfa.courses[0].id).id;
  for (const employee of [rossi, bianchi]) {
    const token = await staffToken(db, alfa.codeStaff, employee.id);
    await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [primo] }] } });
  }
  const consegne = (await call(db, 'GET', `/api/admin/report/delivery?week=${week}`, { token: admin })).body;
  const azienda = consegne.days.find((d) => d.day === 1).companies[0];
  assert.equal(azienda.company, 'Alfa SpA');
  assert.deepEqual(azienda.people.map((p) => p.locker), ['3', '12'], 'ordinamento numerico, non alfabetico');
  assert.equal(azienda.people[0].name, 'Anna Bianchi');
});

test('modificare il menù non cancella gli ordini già inviati', async () => {
  const { db, admin, alfa, rossi, week } = await scenario();
  const before = (await call(db, 'GET', `/api/admin/menu?companyId=${alfa.id}&week=${week}`, { token: admin })).body.items;
  const primo = before.find((m) => m.day === 1 && m.courseId === alfa.courses[0].id).id;
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [primo] }] } });

  const modificato = before.map((m) => ({ day: m.day, courseId: m.courseId, name: m.name }));
  modificato.push({ day: 1, courseId: alfa.courses[0].id, name: 'Gnocchi' });
  await call(db, 'PUT', '/api/admin/menu', { token: admin, body: { companyId: alfa.id, week, items: modificato } });

  const dopo = (await call(db, 'GET', `/api/staff/week?week=${week}`, { token })).body;
  assert.deepEqual(dopo.order.days['1'].items, [primo], 'la scelta del dipendente sopravvive alla modifica del menù');
});

test('copia a tutte: allinea i piatti per nome di portata', async () => {
  const { db, admin, alfa, beta, week } = await scenario();
  const esito = await call(db, 'POST', '/api/admin/menu/copy', {
    token: admin,
    body: { fromCompanyId: alfa.id, week, toCompanyIds: 'all' },
  });
  assert.equal(esito.status, 200);
  const copiato = (await call(db, 'GET', `/api/admin/menu?companyId=${beta.id}&week=${week}`, { token: admin })).body;
  const nomiPortate = new Set(copiato.courses.map((c) => c.id));
  assert.ok(copiato.items.length > 0);
  assert.ok(copiato.items.every((i) => nomiPortate.has(i.courseId)));
  // Beta non ha "Contorno": quei piatti restano fuori invece di finire nella portata sbagliata.
  assert.equal(copiato.items.length, esito.body.report[0].copied);
  assert.equal(esito.body.report[0].skipped, 10);
});

test('cancellare una persona cancella i suoi ordini', async () => {
  const { db, admin, alfa, mgrAlfa, rossi, week } = await scenario();
  const menu = (await call(db, 'GET', `/api/admin/menu?companyId=${alfa.id}&week=${week}`, { token: admin })).body.items;
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [menu[0].id] }] } });
  await call(db, 'DELETE', `/api/manager/employees/${rossi.id}`, { token: mgrAlfa });
  const rimasti = await db.first('SELECT COUNT(*) AS n FROM orders WHERE employee_id = ?', [rossi.id]);
  assert.equal(rimasti.n, 0);
  const scelte = await db.first('SELECT COUNT(*) AS n FROM order_choices');
  assert.equal(scelte.n, 0);
});

test('la cancellazione dei dati storici rispetta la settimana limite', async () => {
  const { db, admin, alfa, rossi, week } = await scenario();
  const menu = (await call(db, 'GET', `/api/admin/menu?companyId=${alfa.id}&week=${week}`, { token: admin })).body.items;
  const token = await staffToken(db, alfa.codeStaff, rossi.id);
  await call(db, 'POST', '/api/staff/order', { token, body: { week, days: [{ day: 1, items: [menu[0].id] }] } });

  const primaNo = await call(db, 'POST', '/api/admin/purge', { token: admin, body: { beforeWeek: '2026-W38' } });
  assert.equal(primaNo.body.orders, 0, 'la settimana limite non viene toccata');
  const dopo = await call(db, 'POST', '/api/admin/purge', { token: admin, body: { beforeWeek: '2026-W39' } });
  assert.equal(dopo.body.orders, 1);
  assert.equal((await purgeExpired(db, 12)).orders, 0);
});

test('senza sessione valida non si legge nulla', async () => {
  const { db, week } = await scenario();
  assert.equal((await call(db, 'GET', '/api/admin/companies')).status, 401);
  assert.equal((await call(db, 'GET', `/api/staff/week?week=${week}`, { token: 'falso.token' })).status, 401);
  assert.equal((await call(db, 'GET', '/api/manager/employees', { token: 'a.b' })).status, 401);
});
