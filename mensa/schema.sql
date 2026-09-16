-- Schema Mensa — SQLite / Cloudflare D1
-- Giorni: 1 = Lunedì ... 5 = Venerdì
-- Settimana: stringa ISO "AAAA-Www" (es. "2026-W38"), ordinabile lessicograficamente.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS restaurant (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  name        TEXT NOT NULL,
  code        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  code_staff   TEXT NOT NULL UNIQUE,   -- codice consegnato ai dipendenti
  code_manager TEXT NOT NULL UNIQUE,   -- codice del referente aziendale
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Portate configurabili per azienda (es. Primo max 1, Contorno max 2)
CREATE TABLE IF NOT EXISTS courses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  max_per_day INTEGER NOT NULL DEFAULT 1 CHECK (max_per_day >= 0),
  pos         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_courses_company ON courses(company_id, pos);

CREATE TABLE IF NOT EXISTS employees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  locker     TEXT NOT NULL,            -- numero armadietto (testo: ammette "12A")
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id, active);

CREATE TABLE IF NOT EXISTS menu_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  week       TEXT NOT NULL,
  day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 5),
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  pos        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_menu_week ON menu_items(company_id, week, day, course_id, pos);
CREATE INDEX IF NOT EXISTS idx_menu_week_all ON menu_items(week);

-- Un ordine per persona per settimana, sovrascritto ad ogni invio.
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  week        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employee_id, week)
);
CREATE INDEX IF NOT EXISTS idx_orders_week ON orders(company_id, week);
CREATE INDEX IF NOT EXISTS idx_orders_week_all ON orders(week);

CREATE TABLE IF NOT EXISTS order_days (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  day      INTEGER NOT NULL CHECK (day BETWEEN 1 AND 5),
  skip     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, day)
);

CREATE TABLE IF NOT EXISTS order_choices (
  order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  day       INTEGER NOT NULL CHECK (day BETWEEN 1 AND 5),
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  PRIMARY KEY (order_id, day, item_id)
);
CREATE INDEX IF NOT EXISTS idx_choices_item ON order_choices(item_id);

-- Limitazione tentativi di accesso (pulita dal cron di retention)
CREATE TABLE IF NOT EXISTS login_attempts (
  ip        TEXT NOT NULL,
  window_ts INTEGER NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window_ts)
);
