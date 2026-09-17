/** Dati di contesto per il tablet: tenant, stabilimento, operatori, stati. */
import { Router } from 'express';
import { getContext, query } from '../db.js';

const router = Router();

router.get('/meta', async (req, res) => {
  const ctx = await getContext();
  const users = await query(
    `SELECT UserId AS userId, Code AS code, FullName AS fullName, Role AS role
     FROM mes.AppUser
     WHERE TenantId = @tenantId AND PlantId = @plantId AND IsDeleted = 0 AND IsActive = 1
     ORDER BY FullName`,
    { tenantId: ctx.tenantId, plantId: ctx.plantId },
  );
  const statuses = await query(
    `SELECT StatusId AS statusId, Code AS code, Name AS name, SortOrder AS sortOrder, IsFinal AS isFinal
     FROM mes.PalletStatus
     WHERE TenantId = @tenantId AND PlantId = @plantId AND IsDeleted = 0
     ORDER BY SortOrder`,
    { tenantId: ctx.tenantId, plantId: ctx.plantId },
  );
  res.json({
    tenant: { id: ctx.tenantId, code: ctx.tenantCode, name: ctx.tenantName },
    plant: { id: ctx.plantId, code: ctx.plantCode, name: ctx.plantName },
    initialStatus: ctx.initialStatus,
    users: users.recordset,
    statuses: statuses.recordset,
  });
});

export default router;
