// Adattatore SQLite locale (node:sqlite) — sviluppo, test e piccole installazioni.

import { DatabaseSync } from 'node:sqlite';

export function openSqlite(file) {
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  const plain = (row) => (row ? { ...row } : row);
  return {
    handle,
    async all(sql, params = []) {
      return handle.prepare(sql).all(...params).map(plain);
    },
    async first(sql, params = []) {
      return plain(handle.prepare(sql).get(...params)) ?? null;
    },
    async run(sql, params = []) {
      const result = handle.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
    },
    async batch(statements) {
      if (!statements.length) return [];
      handle.exec('BEGIN');
      try {
        const out = statements.map((s) => handle.prepare(s.sql).run(...(s.params ?? [])));
        handle.exec('COMMIT');
        return out;
      } catch (error) {
        handle.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
