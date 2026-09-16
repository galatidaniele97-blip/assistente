/**
 * Adattatore SQLite nel browser (sql.js, SQLite compilato in WebAssembly).
 * Stessa interfaccia degli altri due — all, first, run, batch — così la
 * dimostrazione fa girare l'API vera, senza server e senza modifiche al codice.
 */

export function openSqlJs(database) {
  const esegui = (sql, params = []) => {
    const stmt = database.prepare(sql);
    try {
      if (params.length) stmt.bind(params);
      const righe = [];
      while (stmt.step()) righe.push(stmt.getAsObject());
      return righe;
    } finally {
      stmt.free();
    }
  };

  return {
    raw: database,
    async all(sql, params) {
      return esegui(sql, params);
    },
    async first(sql, params) {
      return esegui(sql, params)[0] ?? null;
    },
    async run(sql, params = []) {
      database.run(sql, params);
      const [riga] = esegui('SELECT last_insert_rowid() AS id');
      return { changes: database.getRowsModified(), lastId: riga.id };
    },
    async batch(statements) {
      if (!statements.length) return [];
      database.run('BEGIN');
      try {
        const esiti = statements.map((s) => {
          database.run(s.sql, s.params ?? []);
          return { changes: database.getRowsModified() };
        });
        database.run('COMMIT');
        return esiti;
      } catch (errore) {
        database.run('ROLLBACK');
        throw errore;
      }
    },
  };
}
