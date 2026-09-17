-- =============================================================================
-- MES Pizzami - 03: dati di esempio (demo)
-- Idempotente: ogni blocco inserisce solo se il record non esiste gia'.
-- I bancali vengono creati tramite le stored procedure, cosi' il seed
-- esercita la stessa logica usata dal tablet (log incluso).
--
-- Codici GS1 fittizi: prefisso aziendale 8099999 (non assegnato a Pizzami).
-- GTIN-14 dei colli: 18099999000015, 18099999000022, 18099999000039,
--                    18099999000046, 18099999000053
-- SSCC:  380999990000000019 ... 380999990000000088 (i primi 6 usati qui,
--        gli ultimi due liberi per provare "Registra bancale" dal tablet).
-- =============================================================================
USE MesPizzami;
GO
SET NOCOUNT ON;

DECLARE @Seed NVARCHAR(50) = N'seed';

-- Tenant e stabilimento --------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM mes.Tenant WHERE Code = N'PIZZAMI')
    INSERT INTO mes.Tenant (Code, Name, CreatedBy) VALUES (N'PIZZAMI', N'Pizzami S.r.l.', @Seed);
DECLARE @TenantId INT = (SELECT TenantId FROM mes.Tenant WHERE Code = N'PIZZAMI');

IF NOT EXISTS (SELECT 1 FROM mes.Plant WHERE TenantId = @TenantId AND Code = N'PARMA')
    INSERT INTO mes.Plant (TenantId, Code, Name, CreatedBy) VALUES (@TenantId, N'PARMA', N'Stabilimento di Parma', @Seed);
DECLARE @PlantId INT = (SELECT PlantId FROM mes.Plant WHERE TenantId = @TenantId AND Code = N'PARMA');

-- Operatori --------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM mes.AppUser WHERE TenantId = @TenantId AND Code = N'MROSSI')
    INSERT INTO mes.AppUser (TenantId, PlantId, Code, FullName, Role, CreatedBy)
    VALUES (@TenantId, @PlantId, N'MROSSI', N'Mario Rossi', N'OPERATORE', @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.AppUser WHERE TenantId = @TenantId AND Code = N'LBIANCHI')
    INSERT INTO mes.AppUser (TenantId, PlantId, Code, FullName, Role, CreatedBy)
    VALUES (@TenantId, @PlantId, N'LBIANCHI', N'Lucia Bianchi', N'CAPOTURNO', @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.AppUser WHERE TenantId = @TenantId AND Code = N'GVERDI')
    INSERT INTO mes.AppUser (TenantId, PlantId, Code, FullName, Role, CreatedBy)
    VALUES (@TenantId, @PlantId, N'GVERDI', N'Giulia Verdi', N'LOGISTICA', @Seed);

DECLARE @UserOperatore INT = (SELECT UserId FROM mes.AppUser WHERE TenantId = @TenantId AND Code = N'MROSSI');
DECLARE @UserCapoturno INT = (SELECT UserId FROM mes.AppUser WHERE TenantId = @TenantId AND Code = N'LBIANCHI');
DECLARE @UserLogistica INT = (SELECT UserId FROM mes.AppUser WHERE TenantId = @TenantId AND Code = N'GVERDI');

-- Unita' di misura -------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PZ')
    INSERT INTO mes.UnitOfMeasure (TenantId, PlantId, Code, Name, SortOrder, CreatedBy) VALUES (@TenantId, @PlantId, N'PZ', N'Pezzo', 1, @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'CO')
    INSERT INTO mes.UnitOfMeasure (TenantId, PlantId, Code, Name, SortOrder, CreatedBy) VALUES (@TenantId, @PlantId, N'CO', N'Collo', 2, @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'BC')
    INSERT INTO mes.UnitOfMeasure (TenantId, PlantId, Code, Name, SortOrder, CreatedBy) VALUES (@TenantId, @PlantId, N'BC', N'Bancale', 3, @Seed);

DECLARE @UomPz INT = (SELECT UomId FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PZ');
DECLARE @UomCo INT = (SELECT UomId FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'CO');
DECLARE @UomBc INT = (SELECT UomId FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'BC');

-- Formati e tipi di conservazione ---------------------------------------------
IF NOT EXISTS (SELECT 1 FROM mes.ProductFormat WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PIZZA')
    INSERT INTO mes.ProductFormat (TenantId, PlantId, Code, Name, CreatedBy) VALUES (@TenantId, @PlantId, N'PIZZA', N'Pizza', @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.ProductFormat WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PINSA')
    INSERT INTO mes.ProductFormat (TenantId, PlantId, Code, Name, CreatedBy) VALUES (@TenantId, @PlantId, N'PINSA', N'Pinsa', @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.ProductFormat WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PANE')
    INSERT INTO mes.ProductFormat (TenantId, PlantId, Code, Name, CreatedBy) VALUES (@TenantId, @PlantId, N'PANE', N'Pane', @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.ProductFormat WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'FOCACCIA')
    INSERT INTO mes.ProductFormat (TenantId, PlantId, Code, Name, CreatedBy) VALUES (@TenantId, @PlantId, N'FOCACCIA', N'Focaccia', @Seed);

IF NOT EXISTS (SELECT 1 FROM mes.StorageType WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'FRESCO')
    INSERT INTO mes.StorageType (TenantId, PlantId, Code, Name, CreatedBy) VALUES (@TenantId, @PlantId, N'FRESCO', N'Fresco (0-4 °C)', @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.StorageType WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'SURGELATO')
    INSERT INTO mes.StorageType (TenantId, PlantId, Code, Name, CreatedBy) VALUES (@TenantId, @PlantId, N'SURGELATO', N'Surgelato (-18 °C)', @Seed);

-- Articoli ---------------------------------------------------------------------
-- Tabella temporanea con i 5 articoli demo e i loro fattori di conversione
DECLARE @P TABLE (
    Gtin CHAR(14), Code NVARCHAR(30), Description NVARCHAR(200),
    FormatCode NVARCHAR(20), StorageCode NVARCHAR(20),
    NetWeightPieceG INT, ShelfLifeDays INT, PiecesPerCase INT, CasesPerPallet INT
);
INSERT INTO @P VALUES
    ('18099999000015', N'PZ-MARG-350', N'Pizza Margherita senza glutine surgelata 350 g', N'PIZZA',    N'SURGELATO', 350, 365, 6,  60),
    ('18099999000022', N'PZ-4FOR-350', N'Pizza 4 Formaggi senza glutine surgelata 350 g', N'PIZZA',    N'SURGELATO', 350, 365, 6,  60),
    ('18099999000039', N'PN-ROMA-230', N'Pinsa Romana senza glutine fresca 230 g',        N'PINSA',    N'FRESCO',    230,  30, 8,  80),
    ('18099999000046', N'PA-CASS-300', N'Pane in cassetta senza glutine fresco 300 g',    N'PANE',     N'FRESCO',    300,  21, 10, 72),
    ('18099999000053', N'FO-GENO-400', N'Focaccia Genovese senza glutine surgelata 400 g', N'FOCACCIA', N'SURGELATO', 400, 365, 8,  48);

INSERT INTO mes.Product (TenantId, PlantId, Gtin, Code, Description, FormatId, StorageTypeId, BaseUomId, NetWeightPieceG, ShelfLifeDays, CreatedBy)
SELECT @TenantId, @PlantId, p.Gtin, p.Code, p.Description, f.FormatId, s.StorageTypeId, @UomPz, p.NetWeightPieceG, p.ShelfLifeDays, @Seed
FROM @P p
JOIN mes.ProductFormat f ON f.TenantId = @TenantId AND f.PlantId = @PlantId AND f.Code = p.FormatCode
JOIN mes.StorageType   s ON s.TenantId = @TenantId AND s.PlantId = @PlantId AND s.Code = p.StorageCode
WHERE NOT EXISTS (SELECT 1 FROM mes.Product x WHERE x.TenantId = @TenantId AND x.Gtin = p.Gtin AND x.IsDeleted = 0);

-- Conversioni: PZ -> CO e CO -> BC per ogni articolo (PZ -> BC si deriva)
INSERT INTO mes.UomConversion (TenantId, PlantId, ProductId, FromUomId, ToUomId, Factor, CreatedBy)
SELECT @TenantId, @PlantId, x.ProductId, @UomPz, @UomCo, p.PiecesPerCase, @Seed
FROM @P p JOIN mes.Product x ON x.TenantId = @TenantId AND x.Gtin = p.Gtin AND x.IsDeleted = 0
WHERE NOT EXISTS (SELECT 1 FROM mes.UomConversion c WHERE c.ProductId = x.ProductId AND c.FromUomId = @UomPz AND c.ToUomId = @UomCo AND c.IsDeleted = 0);

INSERT INTO mes.UomConversion (TenantId, PlantId, ProductId, FromUomId, ToUomId, Factor, CreatedBy)
SELECT @TenantId, @PlantId, x.ProductId, @UomCo, @UomBc, p.CasesPerPallet, @Seed
FROM @P p JOIN mes.Product x ON x.TenantId = @TenantId AND x.Gtin = p.Gtin AND x.IsDeleted = 0
WHERE NOT EXISTS (SELECT 1 FROM mes.UomConversion c WHERE c.ProductId = x.ProductId AND c.FromUomId = @UomCo AND c.ToUomId = @UomBc AND c.IsDeleted = 0);

-- Stati del bancale --------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'DA_PRODURRE')
    INSERT INTO mes.PalletStatus (TenantId, PlantId, Code, Name, SortOrder, IsFinal, CreatedBy) VALUES (@TenantId, @PlantId, N'DA_PRODURRE', N'Da produrre', 1, 0, @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PRODOTTO')
    INSERT INTO mes.PalletStatus (TenantId, PlantId, Code, Name, SortOrder, IsFinal, CreatedBy) VALUES (@TenantId, @PlantId, N'PRODOTTO', N'Prodotto', 2, 0, @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PRENOTATO')
    INSERT INTO mes.PalletStatus (TenantId, PlantId, Code, Name, SortOrder, IsFinal, CreatedBy) VALUES (@TenantId, @PlantId, N'PRENOTATO', N'Prenotato', 3, 0, @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'SPEDITO')
    INSERT INTO mes.PalletStatus (TenantId, PlantId, Code, Name, SortOrder, IsFinal, CreatedBy) VALUES (@TenantId, @PlantId, N'SPEDITO', N'Spedito', 4, 1, @Seed);

DECLARE @StDaProdurre INT = (SELECT StatusId FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'DA_PRODURRE');
DECLARE @StProdotto   INT = (SELECT StatusId FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PRODOTTO');
DECLARE @StPrenotato  INT = (SELECT StatusId FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'PRENOTATO');
DECLARE @StSpedito    INT = (SELECT StatusId FROM mes.PalletStatus WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = N'SPEDITO');

-- Transizioni ammesse (il ciclo lineare richiesto). Per aggiungerne altre, ad
-- esempio "Annulla prenotazione" (PRENOTATO -> PRODOTTO), basta un INSERT qui.
IF NOT EXISTS (SELECT 1 FROM mes.PalletStatusTransition WHERE TenantId = @TenantId AND PlantId = @PlantId AND FromStatusId = @StDaProdurre AND ToStatusId = @StProdotto)
    INSERT INTO mes.PalletStatusTransition (TenantId, PlantId, FromStatusId, ToStatusId, ActionName, SortOrder, CreatedBy)
    VALUES (@TenantId, @PlantId, @StDaProdurre, @StProdotto, N'Segna prodotto', 1, @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.PalletStatusTransition WHERE TenantId = @TenantId AND PlantId = @PlantId AND FromStatusId = @StProdotto AND ToStatusId = @StPrenotato)
    INSERT INTO mes.PalletStatusTransition (TenantId, PlantId, FromStatusId, ToStatusId, ActionName, SortOrder, CreatedBy)
    VALUES (@TenantId, @PlantId, @StProdotto, @StPrenotato, N'Prenota', 1, @Seed);
IF NOT EXISTS (SELECT 1 FROM mes.PalletStatusTransition WHERE TenantId = @TenantId AND PlantId = @PlantId AND FromStatusId = @StPrenotato AND ToStatusId = @StSpedito)
    INSERT INTO mes.PalletStatusTransition (TenantId, PlantId, FromStatusId, ToStatusId, ActionName, SortOrder, CreatedBy)
    VALUES (@TenantId, @PlantId, @StPrenotato, @StSpedito, N'Spedisci', 1, @Seed);

-- Bancali di esempio (creati con le stored procedure) ---------------------------
DECLARE @PalletId INT;

-- 1) Pizza Margherita, lotto unico, PRODOTTO
IF NOT EXISTS (SELECT 1 FROM mes.Pallet WHERE TenantId = @TenantId AND Sscc = '380999990000000019' AND IsDeleted = 0)
BEGIN
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000019', '18099999000015', N'L260915A', @UserOperatore,
         @ProductionDate = '2026-09-15', @BestBeforeDate = '2027-09-15', @Cases = 60, @NetWeightKg = 126.000,
         @InitialStatusCode = N'DA_PRODURRE', @PalletId = @PalletId OUTPUT;
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRODOTTO', @UserOperatore, N'Fine linea 1';
END;

-- 2) Pizza Margherita, bancale MISTO: 40 colli lotto L260915A + 20 colli lotto L260916C, PRODOTTO
IF NOT EXISTS (SELECT 1 FROM mes.Pallet WHERE TenantId = @TenantId AND Sscc = '380999990000000026' AND IsDeleted = 0)
BEGIN
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000026', '18099999000015', N'L260915A', @UserOperatore,
         @ProductionDate = '2026-09-15', @BestBeforeDate = '2027-09-15', @Cases = 40, @NetWeightKg = 126.000,
         @InitialStatusCode = N'DA_PRODURRE', @PalletId = @PalletId OUTPUT;
    EXEC mes.usp_Pallet_AddLot @TenantId, @PlantId, @PalletId, N'L260916C', 20, @UserOperatore,
         @ProductionDate = '2026-09-16', @BestBeforeDate = '2027-09-16';
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRODOTTO', @UserOperatore, N'Bancale misto di fine lotto';
END;

-- 3) Pizza 4 Formaggi, PRENOTATO
IF NOT EXISTS (SELECT 1 FROM mes.Pallet WHERE TenantId = @TenantId AND Sscc = '380999990000000033' AND IsDeleted = 0)
BEGIN
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000033', '18099999000022', N'L260915B', @UserOperatore,
         @ProductionDate = '2026-09-15', @BestBeforeDate = '2027-09-15', @Cases = 60, @NetWeightKg = 126.000,
         @InitialStatusCode = N'PRODOTTO', @PalletId = @PalletId OUTPUT;
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRENOTATO', @UserLogistica, N'Ordine cliente 2026/1187';
END;

-- 4) Pinsa Romana fresca (scadenza invece di TMC), PRODOTTO
IF NOT EXISTS (SELECT 1 FROM mes.Pallet WHERE TenantId = @TenantId AND Sscc = '380999990000000040' AND IsDeleted = 0)
BEGIN
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000040', '18099999000039', N'L260916A', @UserOperatore,
         @ProductionDate = '2026-09-16', @ExpiryDate = '2026-10-16', @Cases = 80, @NetWeightKg = 147.200,
         @InitialStatusCode = N'PRODOTTO', @PalletId = @PalletId OUTPUT;
END;

-- 5) Pane in cassetta fresco, SPEDITO (ciclo completo nello storico)
IF NOT EXISTS (SELECT 1 FROM mes.Pallet WHERE TenantId = @TenantId AND Sscc = '380999990000000057' AND IsDeleted = 0)
BEGIN
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000057', '18099999000046', N'L260914A', @UserOperatore,
         @ProductionDate = '2026-09-14', @ExpiryDate = '2026-10-05', @Cases = 72, @NetWeightKg = 216.000,
         @InitialStatusCode = N'DA_PRODURRE', @PalletId = @PalletId OUTPUT;
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRODOTTO',  @UserOperatore, NULL;
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRENOTATO', @UserLogistica, N'Ordine cliente 2026/1180';
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'SPEDITO',   @UserLogistica, N'DDT 2026/0932';
END;

-- 6) Focaccia Genovese, DA_PRODURRE (bancale pianificato, ancora vuoto in linea)
IF NOT EXISTS (SELECT 1 FROM mes.Pallet WHERE TenantId = @TenantId AND Sscc = '380999990000000064' AND IsDeleted = 0)
BEGIN
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000064', '18099999000053', N'L260917A', @UserCapoturno,
         @ProductionDate = '2026-09-17', @BestBeforeDate = '2027-09-17', @Cases = 48,
         @InitialStatusCode = N'DA_PRODURRE', @PalletId = @PalletId OUTPUT;
END;

PRINT N'Seed completato.';
SELECT Sscc, ProductCode, StatusCode, TotalCases, LotCount FROM mes.vw_Pallet WHERE TenantId = @TenantId ORDER BY Sscc;
GO
