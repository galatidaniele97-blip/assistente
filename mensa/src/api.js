// Router API. Ogni handler ricava il perimetro dati (azienda) dalla sessione firmata,
// mai da un parametro inviato dal client: è così che i dati di un'azienda restano
// invisibili alle altre.

import { HttpError, bad, json, csv, str, int, id, readJson, lockerSort } from './util.js';
import {
  issueToken,
  requireSession,
  normalizeCode,
  generateCode,
  clientIp,
  checkLoginRate,
  recordFailedLogin,
  hashCode,
  verifyCode,
  checkPinRate,
  recordFailedPin,
} from './auth.js';
import { normalizeSettings, deadlineFor, isLocked, deadlineLabel } from '../public/shared/scadenza.js';
import { isValidWeek, currentWeek, shiftWeek, GIORNI, dayLabel, weekLabel } from '../public/shared/week.js';
import { verificaGiorno } from '../public/shared/regole.js';

const DAYS = [1, 2, 3, 4, 5];

function week(value) {
  if (!isValidWeek(value)) throw bad('Settimana non valida.');
  return value;
}

/** L'azienda del token deve esistere: un codice revocato non deve restare valido. */
async function companyOf(db, session) {
  const company = await db.first('SELECT id, name FROM companies WHERE id = ?', [session.c]);
  if (!company) throw new HttpError(401, 'Azienda non più disponibile. Contatta il ristorante.');
  return company;
}

/** Le impostazioni del ristorante: nome e scadenza di ordinazione. */
async function settingsOf(db) {
  const row = await db.first(
    'SELECT name, deadline_day AS day, deadline_time AS time, timezone FROM restaurant WHERE id = 1'
  );
  return { name: row?.name ?? 'Ristorante', deadline: normalizeSettings(row ?? {}) };
}

/** Stato della scadenza per una settimana: quando scade, se è già chiusa, come dirlo. */
function deadlineInfo(week, deadline) {
  return { at: deadlineFor(week, deadline), locked: isLocked(week, deadline), label: deadlineLabel(week, deadline) };
}

async function coursesOf(db, companyId) {
  const courses = await db.all(
    'SELECT id, name, max_per_day AS max, single_dish AS single, pos FROM courses WHERE company_id = ? ORDER BY pos, id',
    [companyId]
  );
  const slots = await db.all(
    'SELECT id, course_id AS courseId, code, pos FROM slots WHERE company_id = ? ORDER BY pos, id',
    [companyId]
  );
  for (const course of courses) {
    course.single = !!course.single;
    course.slots = slots.filter((s) => s.courseId === course.id);
  }
  return courses;
}

/** Le regole con cui si valida un giorno: piatti al giorno e massimi per portata. */
async function rulesOf(db, companyId) {
  const company = await db.first('SELECT max_dishes AS maxDishes FROM companies WHERE id = ?', [companyId]);
  const courses = await coursesOf(db, companyId);
  return {
    maxDishes: company?.maxDishes ?? 3,
    courses: courses.map((c) => ({ id: c.id, name: c.name, max: c.max })),
  };
}

/** Il menù di una settimana, con la lettera e l'indicazione di piatto unico. */
function menuOf(db, companyId, w) {
  return db.all(
    `SELECT mi.id, mi.day, mi.name, s.id AS slotId, s.code, s.course_id AS courseId,
            (mi.single_dish OR c.single_dish) AS single
       FROM menu_items mi
       JOIN slots s   ON s.id = mi.slot_id
       JOIN courses c ON c.id = s.course_id
      WHERE mi.company_id = ? AND mi.week = ?
      ORDER BY mi.day, s.pos, s.id`,
    [companyId, w]
  );
}

// ── Autenticazione ────────────────────────────────────────────────────────────

async function login(request, env, db) {
  const ip = clientIp(request);
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  if (code.length < 4) throw bad('Codice troppo corto.');
  await checkLoginRate(db, ip, code);

  const restaurant = await db.first('SELECT id, name, code_hash, token_version AS v FROM restaurant WHERE id = 1');
  if (restaurant && (await verifyCode(code, restaurant.code_hash))) {
    return json({
      token: await issueToken(env.SESSION_SECRET, { r: 'admin', v: restaurant.v }),
      role: 'admin',
      name: restaurant.name,
      deadline: (await settingsOf(db)).deadline,
    });
  }

  const company = await db.first(
    'SELECT id, name, code_staff, code_manager, token_version AS v FROM companies WHERE code_manager = ? OR code_staff = ?',
    [code, code]
  );
  if (company) {
    const role = company.code_manager === code ? 'manager' : 'staff';
    return json({
      token: await issueToken(env.SESSION_SECRET, { r: role, c: company.id, v: company.v }),
      role,
      name: company.name,
      deadline: (await settingsOf(db)).deadline,
    });
  }

  await recordFailedLogin(db, ip, code);
  throw new HttpError(401, 'Codice non riconosciuto.');
}

async function me(request, env, db) {
  const session = await requireSession(request, env, ['admin', 'manager', 'staff'], db);
  const settings = await settingsOf(db);
  if (session.r === 'admin') {
    return json({ role: 'admin', name: settings.name, deadline: settings.deadline });
  }
  const company = await companyOf(db, session);
  let employee = null;
  if (session.e) {
    employee = await db.first('SELECT id, name, locker FROM employees WHERE id = ? AND company_id = ? AND active = 1', [
      session.e,
      company.id,
    ]);
  }
  return json({ role: session.r, name: company.name, companyId: company.id, employee, deadline: settings.deadline });
}

// ── Dipendente ────────────────────────────────────────────────────────────────

async function staffEmployees(request, env, db) {
  const session = await requireSession(request, env, ['staff'], db);
  const company = await companyOf(db, session);
  const employees = await db.all(
    'SELECT id, name, locker, (pin_hash IS NOT NULL) AS hasPin FROM employees WHERE company_id = ? AND active = 1 ORDER BY name COLLATE NOCASE',
    [company.id]
  );
  return json({ company: company.name, employees: employees.map((e) => ({ ...e, hasPin: !!e.hasPin })) });
}

const PIN_RE = /^\d{4,6}$/;

/**
 * Il nome si sceglie dall'elenco; il PIN personale dice che sei davvero tu.
 * Al primo accesso la persona lo sceglie; da lì in poi lo inserisce.
 * Se qualcun altro l'ha impostato prima di lei, il referente lo azzera.
 */
async function staffIdentify(request, env, db) {
  const session = await requireSession(request, env, ['staff'], db);
  const company = await companyOf(db, session);
  const body = await readJson(request);
  const employee = await db.first(
    'SELECT id, name, locker, pin_hash AS pinHash FROM employees WHERE id = ? AND company_id = ? AND active = 1',
    [id(body.employeeId, 'employeeId'), company.id]
  );
  if (!employee) throw bad('Nominativo non disponibile.');

  if (!employee.pinHash) {
    const newPin = String(body.newPin ?? '');
    if (!PIN_RE.test(newPin)) throw bad('Scegli un PIN di 4-6 cifre: ti servirà ogni volta che entri.');
    await db.run('UPDATE employees SET pin_hash = ? WHERE id = ?', [await hashCode(newPin), employee.id]);
  } else {
    await checkPinRate(db, employee.id);
    if (!(await verifyCode(String(body.pin ?? ''), employee.pinHash))) {
      await recordFailedPin(db, employee.id);
      throw new HttpError(401, 'PIN errato.');
    }
  }
  return json({
    token: await issueToken(env.SESSION_SECRET, { r: 'staff', c: company.id, e: employee.id, v: session.v }),
    employee: { id: employee.id, name: employee.name, locker: employee.locker },
  });
}

async function requireEmployee(request, env, db) {
  const session = await requireSession(request, env, ['staff'], db);
  const company = await companyOf(db, session);
  if (!session.e) throw new HttpError(403, 'Scegli prima il tuo nominativo.');
  const employee = await db.first(
    'SELECT id, name, locker FROM employees WHERE id = ? AND company_id = ? AND active = 1',
    [session.e, company.id]
  );
  if (!employee) throw new HttpError(403, 'Nominativo non più disponibile. Scegli di nuovo il tuo nome.');
  return { company, employee };
}

async function staffWeek(request, env, db, url) {
  const { company, employee } = await requireEmployee(request, env, db);
  const w = week(url.searchParams.get('week'));
  const courses = await coursesOf(db, company.id);
  const rules = await rulesOf(db, company.id);
  const items = (await menuOf(db, company.id, w)).map((item) => ({ ...item, single: !!item.single }));
  const order = await db.first('SELECT id, updated_at AS updatedAt FROM orders WHERE employee_id = ? AND week = ?', [
    employee.id,
    w,
  ]);
  const days = {};
  if (order) {
    for (const row of await db.all('SELECT day, skip FROM order_days WHERE order_id = ?', [order.id])) {
      days[row.day] = { skip: !!row.skip, items: [] };
    }
    for (const row of await db.all('SELECT day, item_id AS itemId FROM order_choices WHERE order_id = ?', [order.id])) {
      (days[row.day] ??= { skip: false, items: [] }).items.push(row.itemId);
    }
  }
  const { deadline } = await settingsOf(db);
  const suspended = (await db.all('SELECT day FROM employee_suspensions WHERE employee_id = ? AND week = ?', [employee.id, w])).map((r) => r.day);
  return json({
    week: w,
    company: company.name,
    employee,
    courses,
    rules,
    menu: items,
    order: order ? { updatedAt: order.updatedAt, days } : null,
    deadline: deadlineInfo(w, deadline),
    suspended,
  });
}

async function staffOrder(request, env, db) {
  const { company, employee } = await requireEmployee(request, env, db);
  const body = await readJson(request);
  const w = week(body.week);

  // Chiusa la scadenza, l'ordine della settimana è definitivo: la cucina ci conta.
  const { deadline } = await settingsOf(db);
  if (isLocked(w, deadline)) {
    throw new HttpError(423, `Ordini chiusi ${deadlineLabel(w, deadline)}: questa settimana non si modifica più.`);
  }

  const rules = await rulesOf(db, company.id);
  const allowed = new Map();
  for (const item of await menuOf(db, company.id, w)) {
    allowed.set(item.id, { ...item, single: !!item.single });
  }

  if (!Array.isArray(body.days)) throw bad('Ordine non valido.');
  const parsed = [];
  for (const entry of body.days) {
    const day = int(entry?.day, { field: 'giorno', min: 1, max: 5 });
    const skip = entry.skip === true;
    const items = skip ? [] : [...new Set((Array.isArray(entry.items) ? entry.items : []).map((v) => id(v, 'piatto')))];
    const scelte = items.map((itemId) => {
      const item = allowed.get(itemId);
      if (!item || item.day !== day) throw bad(`Piatto non disponibile per ${GIORNI[day - 1]}.`);
      return item;
    });
    // Stesse regole che il client applica ai pulsanti: qui si rifiuta comunque.
    const errore = verificaGiorno(scelte, rules);
    if (errore) throw bad(`${GIORNI[day - 1]}: ${errore}`);
    parsed.push({ day, skip, items });
  }
  if (parsed.length !== new Set(parsed.map((p) => p.day)).size) throw bad("Giorno ripetuto nell'ordine.");

  await db.run(
    `INSERT INTO orders (company_id, employee_id, week) VALUES (?, ?, ?)
     ON CONFLICT(employee_id, week) DO UPDATE SET updated_at = datetime('now')`,
    [company.id, employee.id, w]
  );
  const order = await db.first('SELECT id, updated_at AS updatedAt FROM orders WHERE employee_id = ? AND week = ?', [
    employee.id,
    w,
  ]);

  // Vale sempre l'ultimo invio: si riscrive tutta la settimana in una sola transazione.
  const statements = [
    { sql: 'DELETE FROM order_days WHERE order_id = ?', params: [order.id] },
    { sql: 'DELETE FROM order_choices WHERE order_id = ?', params: [order.id] },
  ];
  for (const entry of parsed) {
    if (!entry.skip && entry.items.length === 0) continue;
    statements.push({
      sql: 'INSERT INTO order_days (order_id, day, skip) VALUES (?, ?, ?)',
      params: [order.id, entry.day, entry.skip ? 1 : 0],
    });
    for (const itemId of entry.items) {
      statements.push({
        sql: 'INSERT INTO order_choices (order_id, day, item_id) VALUES (?, ?, ?)',
        params: [order.id, entry.day, itemId],
      });
    }
  }
  await db.batch(statements);
  return json({ ok: true, updatedAt: order.updatedAt });
}

async function staffDeleteOrders(request, env, db) {
  const { employee } = await requireEmployee(request, env, db);
  const result = await db.run('DELETE FROM orders WHERE employee_id = ?', [employee.id]);
  return json({ ok: true, deleted: result.changes });
}

// ── Referente azienda ─────────────────────────────────────────────────────────

async function managerEmployees(request, env, db) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const employees = await db.all(
    'SELECT id, name, locker, active, (pin_hash IS NOT NULL) AS hasPin FROM employees WHERE company_id = ? ORDER BY name COLLATE NOCASE',
    [company.id]
  );
  employees.sort((a, b) => lockerSort(a.locker, b.locker));
  return json({ company: company.name, codeStaff: (await db.first('SELECT code_staff AS c FROM companies WHERE id = ?', [company.id])).c, employees: employees.map((e) => ({ ...e, hasPin: !!e.hasPin })) });
}

async function managerCreateEmployee(request, env, db) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const body = await readJson(request);
  const name = str(body.name, { field: 'nome', max: 80 });
  const locker = str(body.locker, { field: 'armadietto', max: 10 });
  const clash = await db.first(
    'SELECT id FROM employees WHERE company_id = ? AND active = 1 AND locker = ? COLLATE NOCASE',
    [company.id, locker]
  );
  if (clash) throw bad(`L'armadietto ${locker} è già assegnato.`);
  const result = await db.run('INSERT INTO employees (company_id, name, locker) VALUES (?, ?, ?)', [
    company.id,
    name,
    locker,
  ]);
  return json({ id: result.lastId, name, locker, active: 1 }, 201);
}

/**
 * Elenco incollato dal referente (nome + armadietto per riga). Chi c'è già
 * viene saltato, un armadietto occupato blocca solo quella riga: il resto entra.
 */
async function managerBulkEmployees(request, env, db) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const body = await readJson(request);
  if (!Array.isArray(body.people) || !body.people.length) throw bad('Nessuna persona da importare.');
  if (body.people.length > 500) throw bad('Massimo 500 persone per importazione.');

  const existing = await db.all('SELECT name, locker FROM employees WHERE company_id = ? AND active = 1', [company.id]);
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  const lockers = new Map(existing.map((e) => [e.locker.toLowerCase(), e.name]));
  const inserted = [];
  const skipped = [];
  const conflicts = [];
  const statements = [];
  for (const raw of body.people) {
    const name = str(raw?.name, { field: 'nome', max: 80 });
    const locker = str(raw?.locker, { field: 'armadietto', max: 10 });
    if (names.has(name.toLowerCase())) {
      skipped.push(name);
      continue;
    }
    const takenBy = lockers.get(locker.toLowerCase());
    if (takenBy) {
      conflicts.push({ name, locker, by: takenBy });
      continue;
    }
    names.add(name.toLowerCase());
    lockers.set(locker.toLowerCase(), name);
    inserted.push(name);
    statements.push({
      sql: 'INSERT INTO employees (company_id, name, locker) VALUES (?, ?, ?)',
      params: [company.id, name, locker],
    });
  }
  await db.batch(statements);
  return json({ inserted: inserted.length, skipped, conflicts }, statements.length ? 201 : 200);
}

/** Il referente azzera il PIN: al prossimo accesso la persona ne sceglie uno nuovo. */
async function managerResetPin(request, env, db, employeeId) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const result = await db.run('UPDATE employees SET pin_hash = NULL WHERE id = ? AND company_id = ?', [employeeId, company.id]);
  if (!result.changes) throw new HttpError(404, 'Persona non trovata.');
  await db.run('DELETE FROM login_attempts WHERE key = ?', [`pin|${employeeId}`]);
  return json({ ok: true });
}

/**
 * Stand-by di una persona per un giorno (malattia, ferie): il pasto non si
 * cucina e non si consegna. Vale anche a settimana chiusa, perché toglie soltanto;
 * riattivare ripristina un pasto che era già stato pianificato.
 */
async function managerSuspend(request, env, db) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const body = await readJson(request);
  const employeeId = id(body.employeeId, 'employeeId');
  const w = week(body.week);
  const day = int(body.day, { field: 'giorno', min: 1, max: 5 });
  const employee = await db.first('SELECT id FROM employees WHERE id = ? AND company_id = ?', [employeeId, company.id]);
  if (!employee) throw new HttpError(404, 'Persona non trovata.');
  if (body.suspended === true) {
    await db.run('INSERT OR IGNORE INTO employee_suspensions (employee_id, week, day) VALUES (?, ?, ?)', [employeeId, w, day]);
  } else {
    await db.run('DELETE FROM employee_suspensions WHERE employee_id = ? AND week = ? AND day = ?', [employeeId, w, day]);
  }
  return json({ ok: true, suspended: body.suspended === true });
}

/** Il menù della settimana visto dal referente: serve per comporre i pasti extra. */
async function managerMenu(request, env, db, url) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const w = week(url.searchParams.get('week'));
  const { deadline } = await settingsOf(db);
  return json({
    week: w,
    courses: await coursesOf(db, company.id),
    rules: await rulesOf(db, company.id),
    menu: (await menuOf(db, company.id, w)).map((item) => ({ ...item, single: !!item.single })),
    deadline: deadlineInfo(w, deadline),
  });
}

async function extrasOf(db, companyId, w) {
  const extras = await db.all(
    'SELECT id, day, qty, note, updated_at AS updatedAt FROM extra_orders WHERE company_id = ? AND week = ? ORDER BY day, id',
    [companyId, w]
  );
  if (!extras.length) return [];
  const placeholders = extras.map(() => '?').join(',');
  const choices = await db.all(
    `SELECT xc.extra_id AS extraId, mi.id AS itemId, s.code, mi.name AS dish
       FROM extra_choices xc JOIN menu_items mi ON mi.id = xc.item_id JOIN slots s ON s.id = mi.slot_id
      WHERE xc.extra_id IN (${placeholders}) ORDER BY s.pos`,
    extras.map((x) => x.id)
  );
  for (const extra of extras) extra.choices = choices.filter((c) => c.extraId === extra.id).map(({ itemId, code, dish }) => ({ itemId, code, dish }));
  return extras;
}

/**
 * Pasti extra per persone non in elenco (un interinale per un giorno). Stesse
 * regole di un ordine normale; entro la scadenza, perché aggiunge lavoro alla cucina.
 */
async function managerAddExtra(request, env, db) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const body = await readJson(request);
  const w = week(body.week);
  const { deadline } = await settingsOf(db);
  if (isLocked(w, deadline)) {
    throw new HttpError(423, `Ordini chiusi ${deadlineLabel(w, deadline)}: dopo la scadenza si possono solo togliere pasti, non aggiungerne.`);
  }
  const day = int(body.day, { field: 'giorno', min: 1, max: 5 });
  const qty = int(body.qty, { field: 'quantità', min: 1, max: 99 });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 60) : '';
  const rules = await rulesOf(db, company.id);
  const allowed = new Map((await menuOf(db, company.id, w)).map((item) => [item.id, { ...item, single: !!item.single }]));
  const items = [...new Set((Array.isArray(body.items) ? body.items : []).map((v) => id(v, 'piatto')))];
  if (!items.length) throw bad('Scegli almeno un piatto.');
  const scelte = items.map((itemId) => {
    const item = allowed.get(itemId);
    if (!item || item.day !== day) throw bad(`Piatto non disponibile per ${GIORNI[day - 1]}.`);
    return item;
  });
  const errore = verificaGiorno(scelte, rules);
  if (errore) throw bad(`${GIORNI[day - 1]}: ${errore}`);
  const created = await db.run('INSERT INTO extra_orders (company_id, week, day, qty, note) VALUES (?, ?, ?, ?, ?)', [company.id, w, day, qty, note]);
  await db.batch(items.map((itemId) => ({ sql: 'INSERT INTO extra_choices (extra_id, item_id) VALUES (?, ?)', params: [created.lastId, itemId] })));
  return json({ id: created.lastId }, 201);
}

/** Togliere un extra si può sempre: la cucina cuoce di meno. */
async function managerDeleteExtra(request, env, db, extraId) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const result = await db.run('DELETE FROM extra_orders WHERE id = ? AND company_id = ?', [extraId, company.id]);
  if (!result.changes) throw new HttpError(404, 'Pasto extra non trovato.');
  return json({ ok: true });
}

async function managerUpdateEmployee(request, env, db, employeeId) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const body = await readJson(request);
  const existing = await db.first('SELECT id FROM employees WHERE id = ? AND company_id = ?', [employeeId, company.id]);
  if (!existing) throw new HttpError(404, 'Persona non trovata.');
  const name = str(body.name, { field: 'nome', max: 80 });
  const locker = str(body.locker, { field: 'armadietto', max: 10 });
  const active = body.active === false ? 0 : 1;
  const clash = await db.first(
    'SELECT id FROM employees WHERE company_id = ? AND active = 1 AND locker = ? COLLATE NOCASE AND id <> ?',
    [company.id, locker, employeeId]
  );
  if (active && clash) throw bad(`L'armadietto ${locker} è già assegnato.`);
  await db.run('UPDATE employees SET name = ?, locker = ?, active = ? WHERE id = ?', [name, locker, active, employeeId]);
  return json({ id: employeeId, name, locker, active });
}

/** Cancellare una persona cancella anche i suoi ordini (art. 17 GDPR). */
async function managerDeleteEmployee(request, env, db, employeeId) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const result = await db.run('DELETE FROM employees WHERE id = ? AND company_id = ?', [employeeId, company.id]);
  if (!result.changes) throw new HttpError(404, 'Persona non trovata.');
  return json({ ok: true });
}

async function managerWeek(request, env, db, url) {
  const session = await requireSession(request, env, ['manager'], db);
  const company = await companyOf(db, session);
  const w = week(url.searchParams.get('week'));
  const employees = await db.all(
    'SELECT id, name, locker FROM employees WHERE company_id = ? AND active = 1 ORDER BY name COLLATE NOCASE',
    [company.id]
  );
  const orders = await db.all('SELECT id, employee_id AS employeeId, updated_at AS updatedAt FROM orders WHERE company_id = ? AND week = ?', [
    company.id,
    w,
  ]);
  const byEmployee = new Map(orders.map((o) => [o.employeeId, o]));
  const counts = new Map();
  if (orders.length) {
    const placeholders = orders.map(() => '?').join(',');
    for (const row of await db.all(
      `SELECT order_id AS orderId, day, COUNT(*) AS n FROM order_choices WHERE order_id IN (${placeholders}) GROUP BY order_id, day`,
      orders.map((o) => o.id)
    )) {
      counts.set(`${row.orderId}:${row.day}`, row.n);
    }
    for (const row of await db.all(
      `SELECT order_id AS orderId, day FROM order_days WHERE skip = 1 AND order_id IN (${placeholders})`,
      orders.map((o) => o.id)
    )) {
      counts.set(`${row.orderId}:${row.day}`, 'skip');
    }
  }
  const suspended = new Set(
    (await db.all(
      `SELECT es.employee_id AS employeeId, es.day FROM employee_suspensions es
         JOIN employees e ON e.id = es.employee_id WHERE e.company_id = ? AND es.week = ?`,
      [company.id, w]
    )).map((r) => `${r.employeeId}:${r.day}`)
  );
  const rows = employees
    .map((e) => {
      const order = byEmployee.get(e.id);
      return {
        ...e,
        submitted: !!order,
        updatedAt: order?.updatedAt ?? null,
        days: DAYS.map((d) => (suspended.has(`${e.id}:${d}`) ? 'sospeso' : order ? counts.get(`${order.id}:${d}`) ?? 0 : 0)),
      };
    })
    .sort((a, b) => lockerSort(a.locker, b.locker));
  const { deadline } = await settingsOf(db);
  return json({
    week: w,
    company: company.name,
    employees: rows,
    extras: await extrasOf(db, company.id, w),
    deadline: deadlineInfo(w, deadline),
  });
}

// ── Ristorante: aziende e regole ──────────────────────────────────────────────

// La struttura con cui il ristorante lavora già oggi sul foglio settimanale.
const DEFAULT_COURSES = [
  { name: 'Primi', max: 1, single: false, slots: ['A', 'B'] },
  { name: 'Secondi', max: 1, single: false, slots: ['E', 'F'] },
  { name: 'Contorni', max: 2, single: false, slots: ['G', 'H'] },
  { name: 'Dessert', max: 1, single: false, slots: ['L'] },
  { name: 'Frutta', max: 1, single: false, slots: ['P'] },
  { name: 'Pasto unico', max: 1, single: true, slots: ['T'] },
];
const DEFAULT_MAX_DISHES = 3;

function parseSlots(raw, field) {
  const slots = Array.isArray(raw) ? raw : [];
  if (!slots.length) throw bad(`La portata "${field}" deve avere almeno una lettera.`);
  if (slots.length > 6) throw bad(`Troppe lettere per la portata "${field}".`);
  return slots.map((slot) => ({
    id: slot?.id ? Number(slot.id) : undefined,
    code: str(typeof slot === 'string' ? slot : slot?.code, { field: 'lettera', max: 3 }).toUpperCase(),
  }));
}

async function uniqueCode(db) {
  for (let i = 0; i < 20; i++) {
    const code = generateCode();
    const clash = await db.first('SELECT 1 AS x FROM companies WHERE code_staff = ? OR code_manager = ?', [code, code]);
    if (!clash) return code;
  }
  throw new HttpError(500, 'Impossibile generare un codice. Riprova.');
}

async function adminCompanies(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const companies = await db.all(
    `SELECT c.id, c.name, c.code_staff AS codeStaff, c.code_manager AS codeManager, c.max_dishes AS maxDishes,
            (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.id AND e.active = 1) AS employees
     FROM companies c ORDER BY c.name COLLATE NOCASE`
  );
  for (const company of companies) company.courses = await coursesOf(db, company.id);
  return json({ companies });
}

async function adminCreateCompany(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const name = str(body.name, { field: 'nome azienda', max: 80 });
  const maxDishes = body.maxDishes === undefined ? DEFAULT_MAX_DISHES : int(body.maxDishes, { field: 'piatti al giorno', min: 1, max: 9 });
  const codeStaff = await uniqueCode(db);
  const codeManager = await uniqueCode(db);
  const result = await db.run(
    'INSERT INTO companies (name, code_staff, code_manager, max_dishes) VALUES (?, ?, ?, ?)',
    [name, codeStaff, codeManager, maxDishes]
  );
  const companyId = result.lastId;
  const courses = Array.isArray(body.courses) && body.courses.length ? body.courses : DEFAULT_COURSES;
  let position = 0;
  for (const raw of courses) {
    const courseName = str(raw.name, { field: 'portata', max: 40 });
    const course = await db.run(
      'INSERT INTO courses (company_id, name, max_per_day, single_dish, pos) VALUES (?, ?, ?, ?, ?)',
      [companyId, courseName, int(raw.max, { field: 'massimo', min: 0, max: 9 }), raw.single ? 1 : 0, position++]
    );
    await db.batch(
      parseSlots(raw.slots, courseName).map((slot, i) => ({
        sql: 'INSERT INTO slots (company_id, course_id, code, pos) VALUES (?, ?, ?, ?)',
        params: [companyId, course.lastId, slot.code, position * 10 + i],
      }))
    );
  }
  return json({ id: companyId, name, codeStaff, codeManager, maxDishes, courses: await coursesOf(db, companyId) }, 201);
}

async function adminUpdateCompany(request, env, db, companyId) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const existing = await db.first('SELECT id FROM companies WHERE id = ?', [companyId]);
  if (!existing) throw new HttpError(404, 'Azienda non trovata.');
  const name = str(body.name, { field: 'nome azienda', max: 80 });
  await db.run('UPDATE companies SET name = ? WHERE id = ?', [name, companyId]);
  return json({ id: companyId, name });
}

async function adminRegenCodes(request, env, db, companyId) {
  await requireSession(request, env, ['admin'], db);
  const existing = await db.first('SELECT id FROM companies WHERE id = ?', [companyId]);
  if (!existing) throw new HttpError(404, 'Azienda non trovata.');
  const codeStaff = await uniqueCode(db);
  const codeManager = await uniqueCode(db);
  await db.run(
    'UPDATE companies SET code_staff = ?, code_manager = ?, token_version = token_version + 1 WHERE id = ?',
    [codeStaff, codeManager, companyId]
  );
  return json({ id: companyId, codeStaff, codeManager });
}

async function adminDeleteCompany(request, env, db, companyId) {
  await requireSession(request, env, ['admin'], db);
  const result = await db.run('DELETE FROM companies WHERE id = ?', [companyId]);
  if (!result.changes) throw new HttpError(404, 'Azienda non trovata.');
  return json({ ok: true });
}

/** Salvataggio differenziale: portate e lettere invariate mantengono l'id, così gli ordini restano validi. */
async function adminSaveCourses(request, env, db, companyId) {
  await requireSession(request, env, ['admin'], db);
  const company = await db.first('SELECT id FROM companies WHERE id = ?', [companyId]);
  if (!company) throw new HttpError(404, 'Azienda non trovata.');
  const body = await readJson(request);
  if (!Array.isArray(body.courses) || body.courses.length === 0) throw bad('Serve almeno una portata.');
  if (body.courses.length > 10) throw bad('Massimo 10 portate per azienda.');
  const maxDishes = int(body.maxDishes, { field: 'piatti al giorno', min: 1, max: 9 });

  const existing = await coursesOf(db, companyId);
  const existingSlots = existing.flatMap((c) => c.slots);
  const keptCourses = new Set();
  const keptSlots = new Set();
  const updates = [];
  const inserts = [];

  body.courses.forEach((raw, i) => {
    const courseName = str(raw.name, { field: 'portata', max: 40 });
    const max = int(raw.max, { field: 'massimo', min: 0, max: 9 });
    const single = raw.single ? 1 : 0;
    const found = raw.id ? existing.find((e) => e.id === Number(raw.id)) : null;
    const slots = parseSlots(raw.slots, courseName);
    if (new Set(slots.map((s) => s.code)).size !== slots.length) throw bad(`Lettera ripetuta in "${courseName}".`);

    if (found) {
      keptCourses.add(found.id);
      updates.push({
        sql: 'UPDATE courses SET name = ?, max_per_day = ?, single_dish = ?, pos = ? WHERE id = ? AND company_id = ?',
        params: [courseName, max, single, i, found.id, companyId],
      });
      slots.forEach((slot, j) => {
        const slotFound = slot.id ? existingSlots.find((s) => s.id === slot.id) : null;
        if (slotFound) {
          keptSlots.add(slotFound.id);
          updates.push({
            sql: 'UPDATE slots SET code = ?, course_id = ?, pos = ? WHERE id = ? AND company_id = ?',
            params: [slot.code, found.id, i * 10 + j, slotFound.id, companyId],
          });
        } else {
          inserts.push({ courseRef: { existingId: found.id }, code: slot.code, pos: i * 10 + j });
        }
      });
    } else {
      inserts.push({ newCourse: { name: courseName, max, single, pos: i }, slots, base: i * 10 });
    }
  });

  // Prima le cancellazioni, poi gli aggiornamenti: il vincolo di unicità
  // sulle lettere non deve scattare mentre se ne libera una.
  const statements = [];
  for (const slot of existingSlots) {
    if (!keptSlots.has(slot.id)) statements.push({ sql: 'DELETE FROM slots WHERE id = ?', params: [slot.id] });
  }
  for (const course of existing) {
    if (!keptCourses.has(course.id)) statements.push({ sql: 'DELETE FROM courses WHERE id = ?', params: [course.id] });
  }
  statements.push(...updates);
  await db.batch(statements);

  for (const entry of inserts) {
    if (entry.newCourse) {
      const created = await db.run(
        'INSERT INTO courses (company_id, name, max_per_day, single_dish, pos) VALUES (?, ?, ?, ?, ?)',
        [companyId, entry.newCourse.name, entry.newCourse.max, entry.newCourse.single, entry.newCourse.pos]
      );
      await db.batch(
        entry.slots.map((slot, j) => ({
          sql: 'INSERT INTO slots (company_id, course_id, code, pos) VALUES (?, ?, ?, ?)',
          params: [companyId, created.lastId, slot.code, entry.base + j],
        }))
      );
    } else {
      await db.run('INSERT INTO slots (company_id, course_id, code, pos) VALUES (?, ?, ?, ?)', [
        companyId,
        entry.courseRef.existingId,
        entry.code,
        entry.pos,
      ]);
    }
  }
  await db.run('UPDATE companies SET max_dishes = ? WHERE id = ?', [maxDishes, companyId]);
  return json({ maxDishes, courses: await coursesOf(db, companyId) });
}

// ── Ristorante: menù ──────────────────────────────────────────────────────────

async function adminMenu(request, env, db, url) {
  await requireSession(request, env, ['admin'], db);
  const companyId = id(url.searchParams.get('companyId'), 'companyId');
  const w = week(url.searchParams.get('week'));
  const company = await db.first('SELECT id, name, max_dishes AS maxDishes FROM companies WHERE id = ?', [companyId]);
  if (!company) throw new HttpError(404, 'Azienda non trovata.');
  const items = (await menuOf(db, companyId, w)).map((item) => ({ ...item, single: !!item.single }));
  const orders = await db.first('SELECT COUNT(*) AS n FROM orders WHERE company_id = ? AND week = ?', [companyId, w]);
  return json({ week: w, company, courses: await coursesOf(db, companyId), items, orders: orders.n });
}

/**
 * La griglia della settimana: una casella per lettera e per giorno, come il
 * foglio cartaceo. Le caselle invariate mantengono l'id del piatto, quindi
 * correggere il menù non azzera gli ordini già inviati; e chi ha ordinato la
 * "A" di lunedì continua ad avere la A anche se il piatto viene corretto.
 */
async function saveMenuItems(db, companyId, w, incoming) {
  const existing = await db.all(
    'SELECT id, day, slot_id AS slotId, name, single_dish AS single FROM menu_items WHERE company_id = ? AND week = ?',
    [companyId, w]
  );
  const byCell = new Map(existing.map((item) => [`${item.slotId}:${item.day}`, item]));
  const statements = [];
  const kept = new Set();
  for (const entry of incoming) {
    const key = `${entry.slotId}:${entry.day}`;
    const found = byCell.get(key);
    if (found) {
      kept.add(found.id);
      if (found.name !== entry.name || !!found.single !== entry.single) {
        statements.push({
          sql: 'UPDATE menu_items SET name = ?, single_dish = ? WHERE id = ?',
          params: [entry.name, entry.single ? 1 : 0, found.id],
        });
      }
    } else {
      statements.push({
        sql: 'INSERT INTO menu_items (company_id, week, day, slot_id, name, single_dish) VALUES (?, ?, ?, ?, ?, ?)',
        params: [companyId, w, entry.day, entry.slotId, entry.name, entry.single ? 1 : 0],
      });
    }
  }
  for (const item of existing) {
    if (!kept.has(item.id)) statements.push({ sql: 'DELETE FROM menu_items WHERE id = ?', params: [item.id] });
  }
  await db.batch(statements);
}

async function adminSaveMenu(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const companyId = id(body.companyId, 'companyId');
  const w = week(body.week);
  const courses = await coursesOf(db, companyId);
  const slotIds = new Set(courses.flatMap((c) => c.slots).map((s) => s.id));
  if (!slotIds.size) throw bad('Configura prima le portate di questa azienda.');
  if (!Array.isArray(body.items)) throw bad('Menù non valido.');
  if (body.items.length > 200) throw bad('Troppi piatti per una settimana.');
  const visti = new Set();
  const incoming = body.items.map((raw) => {
    const day = int(raw?.day, { field: 'giorno', min: 1, max: 5 });
    const slotId = id(raw?.slotId, 'slotId');
    if (!slotIds.has(slotId)) throw bad('Lettera non appartenente a questa azienda.');
    const key = `${slotId}:${day}`;
    if (visti.has(key)) throw bad('La stessa casella compare due volte.');
    visti.add(key);
    return { day, slotId, name: str(raw?.name, { field: 'piatto', max: 90 }), single: raw?.single === true };
  });
  await saveMenuItems(db, companyId, w, incoming);
  return json({ ok: true, items: incoming.length });
}

/** "Copia a tutte": i piatti vengono riassegnati per LETTERA, perché ogni azienda ha la sua griglia. */
async function adminCopyMenu(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const fromCompanyId = id(body.fromCompanyId, 'fromCompanyId');
  const w = week(body.week);
  const sourceItems = await menuOf(db, fromCompanyId, w);
  if (!sourceItems.length) throw bad('Il menù di partenza è vuoto.');

  const targets =
    body.toCompanyIds === 'all'
      ? (await db.all('SELECT id FROM companies WHERE id <> ?', [fromCompanyId])).map((r) => r.id)
      : (Array.isArray(body.toCompanyIds) ? body.toCompanyIds : []).map((v) => id(v, 'toCompanyIds'));
  if (!targets.length) throw bad('Nessuna azienda di destinazione.');

  const report = [];
  for (const targetId of targets) {
    const target = await db.first('SELECT id, name FROM companies WHERE id = ?', [targetId]);
    if (!target) continue;
    const byCode = new Map(
      (await db.all('SELECT id, code FROM slots WHERE company_id = ?', [targetId])).map((s) => [s.code, s.id])
    );
    const incoming = [];
    const mancanti = new Set();
    for (const item of sourceItems) {
      const slotId = byCode.get(item.code);
      if (!slotId) {
        mancanti.add(item.code);
        continue;
      }
      incoming.push({ day: item.day, slotId, name: item.name, single: !!item.single });
    }
    await saveMenuItems(db, targetId, w, incoming);
    report.push({ company: target.name, copied: incoming.length, missing: [...mancanti].sort() });
  }
  return json({ ok: true, report });
}

async function adminImportWeek(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const companyId = id(body.companyId, 'companyId');
  const fromWeek = week(body.fromWeek);
  const toWeek = week(body.toWeek);
  if (fromWeek === toWeek) throw bad('Le due settimane coincidono.');
  const items = await menuOf(db, companyId, fromWeek);
  if (!items.length) throw bad('La settimana di partenza non ha un menù.');
  await saveMenuItems(
    db,
    companyId,
    toWeek,
    items.map((item) => ({ day: item.day, slotId: item.slotId, name: item.name, single: !!item.single }))
  );
  return json({ ok: true, items: items.length });
}

// ── Ristorante: i due riepiloghi ──────────────────────────────────────────────

/** Cucina: porzioni per piatto e per giorno, sommando tutte le aziende. */
async function reportKitchen(db, w) {
  const rows = await db.all(
    `SELECT mi.day AS day, c.name AS course, MIN(c.pos) AS pos, mi.name AS dish,
            GROUP_CONCAT(DISTINCT s.code) AS codes, MIN(s.code) AS firstCode, COUNT(*) AS qty
       FROM order_choices oc
       JOIN orders o      ON o.id = oc.order_id
       JOIN menu_items mi ON mi.id = oc.item_id
       JOIN slots s       ON s.id = mi.slot_id
       JOIN courses c     ON c.id = s.course_id
       JOIN employees e   ON e.id = o.employee_id AND e.active = 1
      WHERE o.week = ?
        AND NOT EXISTS (SELECT 1 FROM employee_suspensions es WHERE es.employee_id = o.employee_id AND es.week = o.week AND es.day = oc.day)
      GROUP BY mi.day, c.name COLLATE NOCASE, mi.name COLLATE NOCASE
      ORDER BY mi.day, pos, c.name COLLATE NOCASE, firstCode, mi.name COLLATE NOCASE`,
    [w]
  );
  // I pasti extra ordinati dai referenti si cuociono come gli altri.
  const extraRows = await db.all(
    `SELECT mi.day AS day, c.name AS course, MIN(c.pos) AS pos, mi.name AS dish,
            GROUP_CONCAT(DISTINCT s.code) AS codes, MIN(s.code) AS firstCode, SUM(x.qty) AS qty
       FROM extra_choices xc
       JOIN extra_orders x ON x.id = xc.extra_id
       JOIN menu_items mi  ON mi.id = xc.item_id
       JOIN slots s        ON s.id = mi.slot_id
       JOIN courses c      ON c.id = s.course_id
      WHERE x.week = ?
      GROUP BY mi.day, c.name COLLATE NOCASE, mi.name COLLATE NOCASE`,
    [w]
  );
  for (const extra of extraRows) {
    const found = rows.find((r) => r.day === extra.day && r.course.toLowerCase() === extra.course.toLowerCase() && r.dish.toLowerCase() === extra.dish.toLowerCase());
    if (found) found.qty += extra.qty;
    else rows.push(extra);
  }
  rows.sort((a, b) => a.day - b.day || a.pos - b.pos || a.course.localeCompare(b.course, 'it') || String(a.firstCode).localeCompare(String(b.firstCode)) || a.dish.localeCompare(b.dish, 'it'));
  const meals = await db.all(
    `SELECT oc.day AS day, COUNT(DISTINCT oc.order_id) AS people
       FROM order_choices oc
       JOIN orders o    ON o.id = oc.order_id
       JOIN employees e ON e.id = o.employee_id AND e.active = 1
      WHERE o.week = ?
        AND NOT EXISTS (SELECT 1 FROM employee_suspensions es WHERE es.employee_id = o.employee_id AND es.week = o.week AND es.day = oc.day)
      GROUP BY oc.day`,
    [w]
  );
  const extraMeals = await db.all('SELECT day, SUM(qty) AS people FROM extra_orders WHERE week = ? GROUP BY day', [w]);
  const peopleByDay = new Map(meals.map((m) => [m.day, m.people]));
  for (const m of extraMeals) peopleByDay.set(m.day, (peopleByDay.get(m.day) ?? 0) + m.people);
  const days = DAYS.map((day) => ({
    day,
    label: dayLabel(w, day),
    people: peopleByDay.get(day) ?? 0,
    courses: [],
  }));
  const index = new Map(days.map((d) => [d.day, d]));
  for (const row of rows) {
    const target = index.get(row.day);
    let course = target.courses.find((c) => c.name === row.course);
    if (!course) {
      course = { name: row.course, dishes: [] };
      target.courses.push(course);
    }
    course.dishes.push({ name: row.dish, qty: row.qty, codes: String(row.codes ?? '').split(',').sort().join('/') });
  }
  return { week: w, label: weekLabel(w), days };
}

/** Consegne: per giorno e azienda, le persone ordinate per armadietto con le loro scelte. */
async function reportDelivery(db, w, onlyCompanyId = null) {
  const params = [w];
  let filter = '';
  if (onlyCompanyId) {
    filter = ' AND o.company_id = ?';
    params.push(onlyCompanyId);
  }
  const rows = await db.all(
    `SELECT oc.day AS day, o.company_id AS companyId, co.name AS company,
            e.id AS employeeId, e.name AS employee, e.locker AS locker,
            s.code AS code, c.name AS course, s.pos AS slotPos, mi.name AS dish
       FROM order_choices oc
       JOIN orders o      ON o.id = oc.order_id
       JOIN employees e   ON e.id = o.employee_id AND e.active = 1
       JOIN companies co  ON co.id = o.company_id
       JOIN menu_items mi ON mi.id = oc.item_id
       JOIN slots s       ON s.id = mi.slot_id
       JOIN courses c     ON c.id = s.course_id
      WHERE o.week = ?${filter}
        AND NOT EXISTS (SELECT 1 FROM employee_suspensions es WHERE es.employee_id = o.employee_id AND es.week = o.week AND es.day = oc.day)
      ORDER BY oc.day, co.name COLLATE NOCASE, s.pos, s.code`,
    params
  );
  const extraRows = await db.all(
    `SELECT x.id AS extraId, x.day AS day, x.company_id AS companyId, co.name AS company, x.qty AS qty, x.note AS note,
            s.code AS code, mi.name AS dish
       FROM extra_orders x
       JOIN companies co   ON co.id = x.company_id
       JOIN extra_choices xc ON xc.extra_id = x.id
       JOIN menu_items mi  ON mi.id = xc.item_id
       JOIN slots s        ON s.id = mi.slot_id
      WHERE x.week = ?${filter.replace('o.company_id', 'x.company_id')}
      ORDER BY x.day, co.name COLLATE NOCASE, x.id, s.pos`,
    params
  );
  const days = DAYS.map((day) => ({ day, label: dayLabel(w, day), companies: [] }));
  const index = new Map(days.map((d) => [d.day, d]));
  for (const row of rows) {
    const target = index.get(row.day);
    let company = target.companies.find((c) => c.companyId === row.companyId);
    if (!company) {
      company = { companyId: row.companyId, company: row.company, people: [] };
      target.companies.push(company);
    }
    let person = company.people.find((p) => p.employeeId === row.employeeId);
    if (!person) {
      person = { employeeId: row.employeeId, name: row.employee, locker: row.locker, choices: [] };
      company.people.push(person);
    }
    person.choices.push({ code: row.code, course: row.course, dish: row.dish });
  }
  for (const row of extraRows) {
    const target = index.get(row.day);
    let company = target.companies.find((c) => c.companyId === row.companyId);
    if (!company) {
      company = { companyId: row.companyId, company: row.company, people: [] };
      target.companies.push(company);
    }
    company.extras ??= [];
    let extra = company.extras.find((x) => x.id === row.extraId);
    if (!extra) {
      extra = { id: row.extraId, qty: row.qty, note: row.note, choices: [] };
      company.extras.push(extra);
    }
    extra.choices.push({ code: row.code, dish: row.dish });
  }
  for (const day of days) {
    day.companies.sort((a, b) => a.company.localeCompare(b.company, 'it'));
    for (const company of day.companies) company.people.sort((a, b) => lockerSort(a.locker, b.locker));
  }
  return { week: w, label: weekLabel(w), days };
}

function kitchenCsv(report) {
  const rows = [['Giorno', 'Data', 'Lettera', 'Portata', 'Piatto', 'Porzioni']];
  for (const day of report.days) {
    for (const course of day.courses) {
      for (const dish of course.dishes) {
        rows.push([GIORNI[day.day - 1], day.label, dish.codes, course.name, dish.name, dish.qty]);
      }
    }
  }
  return csv(rows, `cucina-${report.week}.csv`);
}

function deliveryCsv(report) {
  const rows = [['Giorno', 'Data', 'Azienda', 'Armadietto', 'Persona', 'Lettere', 'Scelte']];
  for (const day of report.days) {
    for (const company of day.companies) {
      for (const person of company.people) {
        rows.push([
          GIORNI[day.day - 1],
          day.label,
          company.company,
          person.locker,
          person.name,
          person.choices.map((c) => c.code).join(''),
          person.choices.map((c) => `${c.code} ${c.dish}`).join(' | '),
        ]);
      }
      for (const extra of company.extras ?? []) {
        rows.push([
          GIORNI[day.day - 1],
          day.label,
          company.company,
          'EXTRA',
          `${extra.qty} × ${extra.note || 'pasti extra'}`,
          extra.choices.map((c) => c.code).join(''),
          extra.choices.map((c) => `${c.code} ${c.dish}`).join(' | '),
        ]);
      }
    }
  }
  return csv(rows, `consegne-${report.week}.csv`);
}

// ── Ristorante: conservazione dei dati ────────────────────────────────────────

async function adminPurge(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const before = week(body.beforeWeek);
  const orders = await db.run('DELETE FROM orders WHERE week < ?', [before]);
  let menus = { changes: 0 };
  if (body.includeMenus === true) menus = await db.run('DELETE FROM menu_items WHERE week < ?', [before]);
  return json({ ok: true, orders: orders.changes, menus: menus.changes });
}

export async function purgeExpired(db, retentionWeeks) {
  const cutoff = shiftWeek(currentWeek(), -Math.max(1, retentionWeeks));
  const orders = await db.run('DELETE FROM orders WHERE week < ?', [cutoff]);
  await db.run('DELETE FROM login_attempts WHERE window_ts < ?', [Math.floor(Date.now() / 1000 / 900) - 96]);
  return { cutoff, orders: orders.changes };
}

// ── Primo avvio ───────────────────────────────────────────────────────────────

async function setup(request, env, db) {
  const existing = await db.first('SELECT id FROM restaurant WHERE id = 1');
  if (existing) throw new HttpError(409, 'Configurazione già effettuata.');
  const body = await readJson(request);
  // Fra la messa in rete e il primo avvio la pagina è raggiungibile da chiunque:
  // con SETUP_CODE impostato, solo chi lo conosce può fare la configurazione.
  if (env.SETUP_CODE && normalizeCode(body.setupCode) !== normalizeCode(env.SETUP_CODE)) {
    throw new HttpError(403, 'Codice di installazione mancante o errato.');
  }
  const name = str(body.name, { field: 'nome ristorante', max: 80 });
  const code = normalizeCode(body.code) || generateCode(8);
  if (code.length < 6) throw bad('Il codice del ristorante deve avere almeno 6 caratteri.');
  await db.run('INSERT INTO restaurant (id, name, code_hash) VALUES (1, ?, ?)', [name, await hashCode(code)]);
  return json({ ok: true, name, code }, 201);
}

// ── Ristorante: impostazioni ──────────────────────────────────────────────────

async function adminSettings(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const settings = await settingsOf(db);
  return json({ ...settings, example: deadlineLabel(shiftWeek(currentWeek(), 1), settings.deadline) });
}

async function adminSaveSettings(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const name = str(body.name, { field: 'nome ristorante', max: 80 });
  const deadline = normalizeSettings(body.deadline ?? {});
  const [hour, minute] = deadline.time.split(':').map(Number);
  if (hour > 23 || minute > 59) throw bad('Orario di scadenza non valido.');
  try {
    new Intl.DateTimeFormat('it-IT', { timeZone: deadline.timezone });
  } catch {
    throw bad('Fuso orario non riconosciuto.');
  }
  await db.run('UPDATE restaurant SET name = ?, deadline_day = ?, deadline_time = ?, timezone = ? WHERE id = 1', [
    name,
    deadline.day,
    deadline.time,
    deadline.timezone,
  ]);
  return json({ ok: true, ...(await settingsOf(db)) });
}

/** Cambio del codice del ristorante: serve quello attuale, e le altre sessioni decadono. */
async function adminChangeCode(request, env, db) {
  await requireSession(request, env, ['admin'], db);
  const body = await readJson(request);
  const restaurant = await db.first('SELECT code_hash, token_version AS v FROM restaurant WHERE id = 1');
  if (!(await verifyCode(normalizeCode(body.current), restaurant.code_hash))) {
    throw new HttpError(403, 'Il codice attuale non è corretto.');
  }
  const next = normalizeCode(body.next);
  if (next.length < 6) throw bad('Il nuovo codice deve avere almeno 6 caratteri.');
  await db.run('UPDATE restaurant SET code_hash = ?, token_version = token_version + 1 WHERE id = 1', [await hashCode(next)]);
  return json({ ok: true, token: await issueToken(env.SESSION_SECRET, { r: 'admin', v: restaurant.v + 1 }) });
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handleApi(request, env, db) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const segments = path.split('/').filter(Boolean).slice(1); // toglie "api"
  const [a, b, c, d] = segments;

  try {
    if (method === 'GET' && a === 'status') {
      const restaurant = await db.first('SELECT name FROM restaurant WHERE id = 1');
      return json({ ready: !!restaurant, name: restaurant?.name ?? null });
    }
    if (method === 'POST' && a === 'setup') return await setup(request, env, db);
    if (method === 'POST' && a === 'login') return await login(request, env, db);
    if (method === 'GET' && a === 'me') return await me(request, env, db);

    if (a === 'staff') {
      if (method === 'GET' && b === 'employees') return await staffEmployees(request, env, db);
      if (method === 'POST' && b === 'identify') return await staffIdentify(request, env, db);
      if (method === 'GET' && b === 'week') return await staffWeek(request, env, db, url);
      if (method === 'POST' && b === 'order') return await staffOrder(request, env, db);
      if (method === 'DELETE' && b === 'orders') return await staffDeleteOrders(request, env, db);
    }

    if (a === 'manager') {
      if (method === 'GET' && b === 'employees') return await managerEmployees(request, env, db);
      if (method === 'POST' && b === 'employees' && !c) return await managerCreateEmployee(request, env, db);
      if (method === 'POST' && b === 'employees' && c === 'bulk') return await managerBulkEmployees(request, env, db);
      if (method === 'PUT' && b === 'employees' && c) return await managerUpdateEmployee(request, env, db, id(c));
      if (method === 'DELETE' && b === 'employees' && c) return await managerDeleteEmployee(request, env, db, id(c));
      if (method === 'POST' && b === 'employees' && c && d === 'pin' && segments[4] === 'reset') return await managerResetPin(request, env, db, id(c));
      if (method === 'PUT' && b === 'suspensions') return await managerSuspend(request, env, db);
      if (method === 'GET' && b === 'menu') return await managerMenu(request, env, db, url);
      if (method === 'POST' && b === 'extras' && !c) return await managerAddExtra(request, env, db);
      if (method === 'DELETE' && b === 'extras' && c) return await managerDeleteExtra(request, env, db, id(c));
      if (method === 'GET' && b === 'week') return await managerWeek(request, env, db, url);
      if (method === 'GET' && b === 'delivery') {
        const session = await requireSession(request, env, ['manager'], db);
        const company = await companyOf(db, session);
        const report = await reportDelivery(db, week(url.searchParams.get('week')), company.id);
        return url.searchParams.get('format') === 'csv' ? deliveryCsv(report) : json(report);
      }
    }

    if (a === 'admin') {
      if (method === 'GET' && b === 'companies' && !c) return await adminCompanies(request, env, db);
      if (method === 'POST' && b === 'companies' && !c) return await adminCreateCompany(request, env, db);
      if (method === 'PUT' && b === 'companies' && c && !d) return await adminUpdateCompany(request, env, db, id(c));
      if (method === 'DELETE' && b === 'companies' && c) return await adminDeleteCompany(request, env, db, id(c));
      if (method === 'POST' && b === 'companies' && c && d === 'codes') return await adminRegenCodes(request, env, db, id(c));
      if (method === 'PUT' && b === 'companies' && c && d === 'courses') return await adminSaveCourses(request, env, db, id(c));
      if (method === 'GET' && b === 'menu') return await adminMenu(request, env, db, url);
      if (method === 'PUT' && b === 'menu') return await adminSaveMenu(request, env, db);
      if (method === 'POST' && b === 'menu' && c === 'copy') return await adminCopyMenu(request, env, db);
      if (method === 'POST' && b === 'menu' && c === 'import-week') return await adminImportWeek(request, env, db);
      if (method === 'GET' && b === 'report' && (c === 'kitchen' || c === 'delivery')) {
        await requireSession(request, env, ['admin'], db);
        const w = week(url.searchParams.get('week'));
        const report = c === 'kitchen' ? await reportKitchen(db, w) : await reportDelivery(db, w);
        if (url.searchParams.get('format') === 'csv') {
          return c === 'kitchen' ? kitchenCsv(report) : deliveryCsv(report);
        }
        return json(report);
      }
      if (method === 'POST' && b === 'purge') return await adminPurge(request, env, db);
      if (method === 'GET' && b === 'settings') return await adminSettings(request, env, db);
      if (method === 'PUT' && b === 'settings') return await adminSaveSettings(request, env, db);
      if (method === 'POST' && b === 'code') return await adminChangeCode(request, env, db);
    }

    return json({ error: 'Risorsa non trovata.' }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error('Errore API', error);
    return json({ error: 'Errore interno. Riprova.' }, 500);
  }
}
