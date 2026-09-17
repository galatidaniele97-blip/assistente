/** Anagrafica prodotto finito (sola lettura nella demo). */
import { Router } from 'express';
import { getContext, query, HttpError } from '../db.js';

const router = Router();

const PRODUCT_COLUMNS = `
  ProductId AS productId, Gtin AS gtin, Code AS code, Description AS description,
  FormatCode AS formatCode, FormatName AS formatName,
  StorageTypeCode AS storageTypeCode, StorageTypeName AS storageTypeName,
  BaseUomCode AS baseUomCode, NetWeightPieceG AS netWeightPieceG, ShelfLifeDays AS shelfLifeDays,
  PiecesPerCase AS piecesPerCase, CasesPerPallet AS casesPerPallet, PiecesPerPallet AS piecesPerPallet,
  IsActive AS isActive`;

router.get('/products', async (req, res) => {
  const ctx = await getContext();
  const r = await query(
    `SELECT ${PRODUCT_COLUMNS} FROM mes.vw_Product
     WHERE TenantId = @tenantId AND PlantId = @plantId
     ORDER BY Code`,
    { tenantId: ctx.tenantId, plantId: ctx.plantId },
  );
  res.json(r.recordset);
});

router.get('/products/by-gtin/:gtin', async (req, res) => {
  const ctx = await getContext();
  const r = await query(
    `SELECT ${PRODUCT_COLUMNS} FROM mes.vw_Product WHERE TenantId = @tenantId AND Gtin = @gtin`,
    { tenantId: ctx.tenantId, gtin: req.params.gtin },
  );
  if (r.recordset.length === 0) throw new HttpError(404, 'Articolo non trovato per questo GTIN');
  res.json(r.recordset[0]);
});

export { PRODUCT_COLUMNS };
export default router;
