/**
 * Connessione a SQL Server e contesto (tenant / stabilimento) dell'istanza.
 * Configurazione da variabili d'ambiente (vedi .env.example).
 */
import sql from 'mssql';

const env = process.env;

const config = {
  server: env.DB_SERVER || 'localhost',
  database: env.DB_NAME || 'MesPizzami',
  user: env.DB_USER || 'sa',
  password: env.DB_PASSWORD || 'Pizzami!Demo2026',
  options: {
    encrypt: true,
    trustServerCertificate: (env.DB_TRUST_CERT ?? 'true').toLowerCase() === 'true',
    useUTC: false,   // date/ora del database sono ora locale del server (SYSDATETIME)
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 15000,
};
// Porta e istanza nominata sono alternative (SQL Express usa l'istanza)
if (env.DB_INSTANCE) config.options.instanceName = env.DB_INSTANCE;
else config.port = Number(env.DB_PORT || 1433);

export { sql };

let poolPromise = null;

/** Pool condiviso: si connette al primo utilizzo. */
export function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

/** Esegue una query con parametri: query('SELECT ... WHERE Id = @id', { id: 3 }) */
export async function query(text, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [name, value] of Object.entries(params)) request.input(name, value);
  return request.query(text);
}

let context = null;

/** Tenant e stabilimento serviti da questa istanza (MES_TENANT / MES_PLANT). */
export async function getContext() {
  if (context) return context;
  const tenantCode = env.MES_TENANT || 'PIZZAMI';
  const plantCode = env.MES_PLANT || 'PARMA';
  const r = await query(
    `SELECT t.TenantId, t.Code AS TenantCode, t.Name AS TenantName,
            p.PlantId, p.Code AS PlantCode, p.Name AS PlantName
     FROM mes.Tenant t
     JOIN mes.Plant p ON p.TenantId = t.TenantId AND p.IsDeleted = 0
     WHERE t.Code = @tenantCode AND p.Code = @plantCode AND t.IsDeleted = 0`,
    { tenantCode, plantCode },
  );
  if (r.recordset.length === 0) {
    throw new Error(`Tenant "${tenantCode}" / stabilimento "${plantCode}" non trovati: eseguire db/03_seed.sql`);
  }
  const row = r.recordset[0];
  context = {
    tenantId: row.TenantId, tenantCode: row.TenantCode, tenantName: row.TenantName,
    plantId: row.PlantId, plantCode: row.PlantCode, plantName: row.PlantName,
    initialStatus: env.MES_INITIAL_STATUS || 'PRODOTTO',
  };
  return context;
}

/** Errore applicativo con codice HTTP. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Traduce gli errori sollevati dalle stored procedure (THROW 50xxx) in codici HTTP. */
export function mapSqlError(err) {
  const byNumber = {
    50001: 400, 50002: 400, 50010: 404, 50011: 409, 50020: 409, 50021: 404,
    50022: 400, 50030: 409, 50031: 409, 547: 400, 2601: 409, 2627: 409,
  };
  const status = byNumber[err?.number];
  if (status) return new HttpError(status, err.message);
  return err;
}
