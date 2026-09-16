// Adattatore Cloudflare D1.

export function d1(DB) {
  if (!DB) throw new Error('Binding D1 "DB" non configurato.');
  const prepare = (sql, params = []) => (params.length ? DB.prepare(sql).bind(...params) : DB.prepare(sql));
  return {
    async all(sql, params) {
      const result = await prepare(sql, params).all();
      return result.results ?? [];
    },
    first(sql, params) {
      return prepare(sql, params).first();
    },
    async run(sql, params) {
      const result = await prepare(sql, params).run();
      return { changes: result.meta?.changes ?? 0, lastId: result.meta?.last_row_id ?? null };
    },
    async batch(statements) {
      if (!statements.length) return [];
      // db.batch() di D1 è una transazione implicita: o passa tutto, o non passa nulla.
      return DB.batch(statements.map((s) => prepare(s.sql, s.params ?? [])));
    },
  };
}
