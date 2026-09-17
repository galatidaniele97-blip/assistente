/**
 * Bancali: scansione, dettaglio, registrazione, cambio di stato.
 * La logica di business sta nelle stored procedure; qui si valida l'input,
 * si traducono gli errori e si compongono le risposte per il tablet.
 */
import { Router } from 'express';
import { sql, getPool, getContext, query, HttpError, mapSqlError } from '../db.js';
import { parseGs1 } from '../../gs1/parser.js';
import { PRODUCT_COLUMNS } from './products.js';

const router = Router();

const PALLET_COLUMNS = `
  PalletId AS palletId, Sscc AS sscc, ProductId AS productId, Gtin AS gtin,
  ProductCode AS productCode, ProductDescription AS productDescription,
  FormatName AS formatName, StorageTypeCode AS storageTypeCode, StorageTypeName AS storageTypeName,
  CasesPerPallet AS casesPerPallet, PiecesPerCase AS piecesPerCase,
  StatusId AS statusId, StatusCode AS statusCode, StatusName AS statusName, StatusIsFinal AS statusIsFinal,
  ExpectedCases AS expectedCases, TotalCases AS totalCases, LotCount AS lotCount,
  NetWeightKg AS netWeightKg, Notes AS notes,
  CreatedAt AS createdAt, CreatedBy AS createdBy, UpdatedAt AS updatedAt, UpdatedBy AS updatedBy`;

/** Scheda completa: bancale, lotti, transizioni ammesse, storico. */
async function loadPalletDetail(ctx, palletId) {
  const r = await query(
    `SELECT ${PALLET_COLUMNS} FROM mes.vw_Pallet WHERE PalletId = @palletId AND TenantId = @tenantId;
     SELECT LotId AS lotId, LotNumber AS lotNumber,
            CONVERT(char(10), ProductionDate, 23) AS productionDate,
            CONVERT(char(10), BestBeforeDate, 23) AS bestBeforeDate,
            CONVERT(char(10), ExpiryDate, 23) AS expiryDate, Cases AS cases
     FROM mes.vw_PalletLot WHERE PalletId = @palletId ORDER BY LotNumber;
     SELECT TransitionId AS transitionId, ActionName AS actionName, ToStatusCode AS toStatusCode, ToStatusName AS toStatusName
     FROM mes.vw_PalletAllowedTransition WHERE PalletId = @palletId ORDER BY SortOrder, ActionName;
     SELECT LogId AS logId, LoggedAt AS loggedAt, FromStatusCode AS fromStatusCode, FromStatusName AS fromStatusName,
            ToStatusCode AS toStatusCode, ToStatusName AS toStatusName, UserCode AS userCode,
            UserFullName AS userFullName, Notes AS notes
     FROM mes.vw_PalletStatusLog WHERE PalletId = @palletId ORDER BY LoggedAt DESC, LogId DESC;`,
    { palletId, tenantId: ctx.tenantId },
  );
  const [pallets, lots, transitions, log] = r.recordsets;
  if (pallets.length === 0) return null;
  return { pallet: pallets[0], lots, transitions, log };
}

async function findPalletIdBySscc(ctx, sscc) {
  const r = await query(
    'SELECT PalletId FROM mes.Pallet WHERE TenantId = @tenantId AND Sscc = @sscc AND IsDeleted = 0',
    { tenantId: ctx.tenantId, sscc },
  );
  return r.recordset[0]?.PalletId ?? null;
}

async function findProductByGtin(ctx, gtin) {
  if (!gtin) return null;
  const r = await query(
    `SELECT ${PRODUCT_COLUMNS} FROM mes.vw_Product WHERE TenantId = @tenantId AND Gtin = @gtin AND IsActive = 1`,
    { tenantId: ctx.tenantId, gtin },
  );
  return r.recordset[0] ?? null;
}

function requireUserId(body) {
  const userId = Number(body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new HttpError(400, 'Selezionare un operatore');
  return userId;
}

/** Salva la scansione (riuscita o no) in mes.ScanEvent. */
async function saveScanEvent(ctx, { parse, userId, palletId }) {
  const pool = await getPool();
  const f = parse.fields;
  const r = await pool.request()
    .input('TenantId', sql.Int, ctx.tenantId)
    .input('PlantId', sql.Int, ctx.plantId)
    .input('RawValue', sql.NVarChar(400), parse.storable.slice(0, 400))
    .input('ParseOk', sql.Bit, parse.ok)
    .input('UserId', sql.Int, userId ?? null)
    .input('ErrorMessage', sql.NVarChar(400), parse.ok ? null : parse.errors.map((e) => e.message).join('; ').slice(0, 400))
    .input('Sscc', sql.Char(18), f.sscc)
    .input('Gtin', sql.Char(14), f.gtin ?? f.gtinContained)
    .input('LotNumber', sql.NVarChar(20), f.lot)
    .input('ProductionDate', sql.Date, f.productionDate)
    .input('BestBeforeDate', sql.Date, f.bestBeforeDate)
    .input('ExpiryDate', sql.Date, f.expiryDate)
    .input('CaseCount', sql.Int, f.caseCount)
    .input('NetWeightKg', sql.Decimal(10, 3), f.netWeightKg)
    .input('PalletId', sql.Int, palletId ?? null)
    .execute('mes.usp_ScanEvent_Insert');
  return r.recordset[0]?.ScanId ?? null;
}

// GET /api/pallets?limit=20  -> ultimi bancali movimentati
router.get('/pallets', async (req, res) => {
  const ctx = await getContext();
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const r = await query(
    `SELECT TOP (@limit) ${PALLET_COLUMNS} FROM mes.vw_Pallet
     WHERE TenantId = @tenantId AND PlantId = @plantId
     ORDER BY ISNULL(UpdatedAt, CreatedAt) DESC, PalletId DESC`,
    { limit, tenantId: ctx.tenantId, plantId: ctx.plantId },
  );
  res.json(r.recordset);
});

// GET /api/pallets/:id -> scheda completa
router.get('/pallets/:id', async (req, res) => {
  const ctx = await getContext();
  const palletId = Number(req.params.id);
  if (!Number.isInteger(palletId)) throw new HttpError(400, 'Id bancale non valido');
  const detail = await loadPalletDetail(ctx, palletId);
  if (!detail) throw new HttpError(404, 'Bancale non trovato');
  res.json(detail);
});

// POST /api/scan { raw, userId } -> scomposizione GS1 + bancale (se esiste)
router.post('/scan', async (req, res) => {
  const ctx = await getContext();
  const raw = typeof req.body?.raw === 'string' ? req.body.raw : '';
  const userId = req.body?.userId ? Number(req.body.userId) : null;

  const parse = parseGs1(raw);
  let detail = null;
  let product = null;
  let palletId = null;

  if (parse.ok && parse.fields.sscc) {
    palletId = await findPalletIdBySscc(ctx, parse.fields.sscc);
    if (palletId) detail = await loadPalletDetail(ctx, palletId);
  }
  if (!detail) product = await findProductByGtin(ctx, parse.fields.gtin ?? parse.fields.gtinContained);

  const scanId = await saveScanEvent(ctx, { parse, userId, palletId });

  let outcome;
  if (!parse.ok) outcome = 'invalid';
  else if (detail) outcome = 'found';
  else if (!parse.fields.sscc) outcome = 'no-sscc';
  else if (!product) outcome = 'unknown-product';
  else outcome = 'new';

  res.json({
    scanId,
    outcome,
    parse: { ok: parse.ok, errors: parse.errors, elements: parse.elements, fields: parse.fields, humanReadable: parse.humanReadable },
    product,
    ...(detail ?? { pallet: null, lots: [], transitions: [], log: [] }),
  });
});

// POST /api/pallets/register { raw, userId, cases?, notes? } -> nuovo bancale dal barcode
router.post('/pallets/register', async (req, res) => {
  const ctx = await getContext();
  const userId = requireUserId(req.body);
  const raw = typeof req.body?.raw === 'string' ? req.body.raw : '';
  const parse = parseGs1(raw);   // il server ri-analizza il barcode: non si fida dei campi del client
  if (!parse.ok) throw new HttpError(400, 'Barcode non valido: ' + parse.errors.map((e) => e.message).join('; '));
  const f = parse.fields;
  const gtin = f.gtin ?? f.gtinContained;
  if (!f.sscc) throw new HttpError(400, 'Il barcode non contiene un SSCC (00): non è un bancale');
  if (!gtin) throw new HttpError(400, 'Il barcode non contiene un GTIN (01)/(02)');
  if (!f.lot) throw new HttpError(400, 'Il barcode non contiene il lotto (10)');

  const cases = req.body?.cases != null && req.body.cases !== '' ? Number(req.body.cases) : f.caseCount;
  if (cases != null && (!Number.isInteger(cases) || cases <= 0)) throw new HttpError(400, 'Numero di colli non valido');

  const pool = await getPool();
  let r;
  try {
    r = await pool.request()
      .input('TenantId', sql.Int, ctx.tenantId)
      .input('PlantId', sql.Int, ctx.plantId)
      .input('Sscc', sql.Char(18), f.sscc)
      .input('Gtin', sql.Char(14), gtin)
      .input('LotNumber', sql.NVarChar(20), f.lot)
      .input('UserId', sql.Int, userId)
      .input('ProductionDate', sql.Date, f.productionDate)
      .input('BestBeforeDate', sql.Date, f.bestBeforeDate)
      .input('ExpiryDate', sql.Date, f.expiryDate)
      .input('Cases', sql.Int, cases ?? null)
      .input('NetWeightKg', sql.Decimal(10, 3), f.netWeightKg)
      .input('InitialStatusCode', sql.NVarChar(20), ctx.initialStatus)
      .input('Notes', sql.NVarChar(400), req.body?.notes ? String(req.body.notes).slice(0, 400) : null)
      .output('PalletId', sql.Int)
      .execute('mes.usp_Pallet_Register');
  } catch (err) {
    throw mapSqlError(err);
  }
  const palletId = r.output.PalletId;
  const detail = await loadPalletDetail(ctx, palletId);
  await saveScanEvent(ctx, { parse, userId, palletId });
  res.status(201).json(detail);
});

// POST /api/pallets/:id/transition { toStatusCode, userId, notes? } -> macchina a stati
router.post('/pallets/:id/transition', async (req, res) => {
  const ctx = await getContext();
  const palletId = Number(req.params.id);
  if (!Number.isInteger(palletId)) throw new HttpError(400, 'Id bancale non valido');
  const userId = requireUserId(req.body);
  const toStatusCode = String(req.body?.toStatusCode ?? '').trim().toUpperCase();
  if (!toStatusCode) throw new HttpError(400, 'Stato di destinazione mancante');

  const pool = await getPool();
  try {
    await pool.request()
      .input('TenantId', sql.Int, ctx.tenantId)
      .input('PlantId', sql.Int, ctx.plantId)
      .input('PalletId', sql.Int, palletId)
      .input('ToStatusCode', sql.NVarChar(20), toStatusCode)
      .input('UserId', sql.Int, userId)
      .input('Notes', sql.NVarChar(400), req.body?.notes ? String(req.body.notes).slice(0, 400) : null)
      .execute('mes.usp_Pallet_ChangeStatus');
  } catch (err) {
    throw mapSqlError(err);
  }
  res.json(await loadPalletDetail(ctx, palletId));
});

export default router;
