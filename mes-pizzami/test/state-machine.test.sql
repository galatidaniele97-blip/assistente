-- =============================================================================
-- MES Pizzami - test della macchina a stati e delle regole del database
-- Esecuzione: sqlcmd -S localhost,1433 -U sa -P "Pizzami!Demo2026" -C -b -i test/state-machine.test.sql
-- Richiede schema, procedure e seed gia' caricati.
-- Tutto gira in una transazione che viene annullata alla fine: il database
-- resta come prima. Con errori il batch termina con RAISERROR (exit code <> 0).
-- =============================================================================
USE MesPizzami;
GO
SET NOCOUNT ON;

DECLARE @Failures INT = 0, @Passed INT = 0;
DECLARE @TenantId INT = (SELECT TenantId FROM mes.Tenant WHERE Code = N'PIZZAMI');
DECLARE @PlantId  INT = (SELECT PlantId  FROM mes.Plant  WHERE TenantId = @TenantId AND Code = N'PARMA');
DECLARE @UserId   INT = (SELECT UserId   FROM mes.AppUser WHERE TenantId = @TenantId AND Code = N'MROSSI');
DECLARE @Results TABLE (Test NVARCHAR(200), Ok BIT, Detail NVARCHAR(400));

DECLARE @PalletId INT, @ErrNum INT, @ErrMsg NVARCHAR(400), @StatusCode NVARCHAR(20), @LogCount INT, @Val DECIMAL(18,6);

BEGIN TRANSACTION;

-- T1: registrazione di un bancale nuovo (SSCC libero del seed) -----------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000088', '18099999000053', N'L260917B', @UserId,
         @ProductionDate = '2026-09-17', @BestBeforeDate = '2027-09-17', @PalletId = @PalletId OUTPUT;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); SET @ErrMsg = ERROR_MESSAGE(); END CATCH;
SELECT @StatusCode = StatusCode FROM mes.vw_Pallet WHERE PalletId = @PalletId;
SELECT @LogCount = COUNT(*) FROM mes.PalletStatusLog WHERE PalletId = @PalletId;
INSERT INTO @Results VALUES (N'T1 registrazione: stato iniziale PRODOTTO, 1 riga di log, colli = colli/bancale (48)',
    CASE WHEN @ErrNum IS NULL AND @StatusCode = N'PRODOTTO' AND @LogCount = 1
          AND (SELECT TotalCases FROM mes.vw_Pallet WHERE PalletId = @PalletId) = 48 THEN 1 ELSE 0 END,
    ISNULL(@ErrMsg, N'stato=' + ISNULL(@StatusCode, N'?') + N' log=' + CAST(@LogCount AS NVARCHAR(10))));

-- T2: transizione ammessa PRODOTTO -> PRENOTATO ---------------------------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRENOTATO', @UserId, N'test';
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); SET @ErrMsg = ERROR_MESSAGE(); END CATCH;
SELECT @StatusCode = StatusCode FROM mes.vw_Pallet WHERE PalletId = @PalletId;
SELECT @LogCount = COUNT(*) FROM mes.PalletStatusLog WHERE PalletId = @PalletId;
INSERT INTO @Results VALUES (N'T2 transizione ammessa PRODOTTO -> PRENOTATO, log = 2',
    CASE WHEN @ErrNum IS NULL AND @StatusCode = N'PRENOTATO' AND @LogCount = 2 THEN 1 ELSE 0 END,
    ISNULL(@ErrMsg, N'stato=' + @StatusCode));

-- T3: transizione NON ammessa PRENOTATO -> DA_PRODURRE (indietro) ---------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'DA_PRODURRE', @UserId, NULL;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); SET @ErrMsg = ERROR_MESSAGE(); END CATCH;
SELECT @StatusCode = StatusCode FROM mes.vw_Pallet WHERE PalletId = @PalletId;
SELECT @LogCount = COUNT(*) FROM mes.PalletStatusLog WHERE PalletId = @PalletId;
INSERT INTO @Results VALUES (N'T3 transizione rifiutata PRENOTATO -> DA_PRODURRE (errore 50011, stato e log invariati)',
    CASE WHEN @ErrNum = 50011 AND @StatusCode = N'PRENOTATO' AND @LogCount = 2 THEN 1 ELSE 0 END,
    N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno') + N' stato=' + @StatusCode);

-- T4: salto di stato NON ammesso PRENOTATO -> PRENOTATO / PRODOTTO -> SPEDITO ---
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRENOTATO', @UserId, NULL;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); SET @ErrMsg = ERROR_MESSAGE(); END CATCH;
INSERT INTO @Results VALUES (N'T4 transizione verso lo stesso stato rifiutata (50011)',
    CASE WHEN @ErrNum = 50011 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

-- T5: stato sconosciuto -----------------------------------------------------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'INESISTENTE', @UserId, NULL;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
INSERT INTO @Results VALUES (N'T5 stato di destinazione inesistente rifiutato (50001)',
    CASE WHEN @ErrNum = 50001 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

-- T6: PRENOTATO -> SPEDITO ammessa; SPEDITO e' finale ------------------------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'SPEDITO', @UserId, N'DDT test';
    EXEC mes.usp_Pallet_ChangeStatus @TenantId, @PlantId, @PalletId, N'PRODOTTO', @UserId, NULL;   -- deve fallire
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
SELECT @StatusCode = StatusCode FROM mes.vw_Pallet WHERE PalletId = @PalletId;
INSERT INTO @Results VALUES (N'T6 PRENOTATO -> SPEDITO ammessa, poi nessuna uscita da SPEDITO',
    CASE WHEN @ErrNum = 50011 AND @StatusCode = N'SPEDITO'
          AND NOT EXISTS (SELECT 1 FROM mes.vw_PalletAllowedTransition WHERE PalletId = @PalletId) THEN 1 ELSE 0 END,
    N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno') + N' stato=' + @StatusCode);

-- T7: contenuto non modificabile in stato finale -----------------------------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_AddLot @TenantId, @PlantId, @PalletId, N'L260917C', 5, @UserId;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
INSERT INTO @Results VALUES (N'T7 aggiunta lotto su bancale SPEDITO rifiutata (50030)',
    CASE WHEN @ErrNum = 50030 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

-- T8: SSCC duplicato --------------------------------------------------------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    DECLARE @Dup INT;
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000088', '18099999000053', N'L260917B', @UserId, @PalletId = @Dup OUTPUT;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
INSERT INTO @Results VALUES (N'T8 SSCC gia'' registrato rifiutato (50020)',
    CASE WHEN @ErrNum = 50020 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

-- T9: check digit errato (SSCC) e GTIN sconosciuto ---------------------------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    DECLARE @Bad INT;
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000018', '18099999000053', N'L260917B', @UserId, @PalletId = @Bad OUTPUT;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
INSERT INTO @Results VALUES (N'T9a SSCC con check digit errato rifiutato (50022)',
    CASE WHEN @ErrNum = 50022 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    EXEC mes.usp_Pallet_Register @TenantId, @PlantId, '380999990000000071', '18099999000060', N'L260917B', @UserId, @PalletId = @Bad OUTPUT;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
INSERT INTO @Results VALUES (N'T9b GTIN valido ma non in anagrafica rifiutato (50021)',
    CASE WHEN @ErrNum = 50021 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

-- T10: il CHECK constraint sulla tabella rifiuta un SSCC non valido anche con INSERT diretto
SET @ErrNum = NULL; SET @ErrMsg = NULL;
BEGIN TRY
    INSERT INTO mes.Pallet (TenantId, PlantId, Sscc, ProductId, StatusId, CreatedBy)
    SELECT @TenantId, @PlantId, '380999990000000018', ProductId, StatusId, N'test'
    FROM mes.vw_Pallet WHERE Sscc = '380999990000000019';
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
INSERT INTO @Results VALUES (N'T10 CHECK constraint check digit su INSERT diretto (errore 547)',
    CASE WHEN @ErrNum = 547 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

-- T11: lotto di un altro articolo su bancale misto ----------------------------------
SET @ErrNum = NULL; SET @ErrMsg = NULL;
DECLARE @MixedPallet INT = (SELECT PalletId FROM mes.vw_Pallet WHERE Sscc = '380999990000000026');
BEGIN TRY
    -- L260915B nel seed appartiene alla Pizza 4 Formaggi, il bancale e' di Margherita
    EXEC mes.usp_Pallet_AddLot @TenantId, @PlantId, @MixedPallet, N'L260915B', 5, @UserId;
END TRY
BEGIN CATCH SET @ErrNum = ERROR_NUMBER(); END CATCH;
INSERT INTO @Results VALUES (N'T11 lotto di un altro articolo rifiutato (50031)',
    CASE WHEN @ErrNum = 50031 THEN 1 ELSE 0 END, N'err=' + ISNULL(CAST(@ErrNum AS NVARCHAR(10)), N'nessuno'));

-- T12: bancale misto del seed: 2 lotti, 60 colli -----------------------------------
INSERT INTO @Results VALUES (N'T12 bancale misto del seed: 2 lotti e 60 colli totali',
    CASE WHEN EXISTS (SELECT 1 FROM mes.vw_Pallet WHERE PalletId = @MixedPallet AND LotCount = 2 AND TotalCases = 60) THEN 1 ELSE 0 END, N'');

-- T13: conversione unita' di misura ---------------------------------------------------
DECLARE @Marg INT = (SELECT ProductId FROM mes.vw_Product WHERE Gtin = '18099999000015');
SET @Val = mes.fn_ConvertQuantity(@Marg, 1, N'BC', N'PZ');
INSERT INTO @Results VALUES (N'T13a 1 bancale di Margherita = 360 pezzi',
    CASE WHEN @Val = 360 THEN 1 ELSE 0 END, N'val=' + ISNULL(CAST(@Val AS NVARCHAR(30)), N'NULL'));
SET @Val = mes.fn_ConvertQuantity(@Marg, 720, N'PZ', N'CO');
INSERT INTO @Results VALUES (N'T13b 720 pezzi = 120 colli',
    CASE WHEN @Val = 120 THEN 1 ELSE 0 END, N'val=' + ISNULL(CAST(@Val AS NVARCHAR(30)), N'NULL'));
SET @Val = mes.fn_ConvertQuantity(@Marg, 30, N'CO', N'BC');
INSERT INTO @Results VALUES (N'T13c 30 colli = 0.5 bancali',
    CASE WHEN @Val = 0.5 THEN 1 ELSE 0 END, N'val=' + ISNULL(CAST(@Val AS NVARCHAR(30)), N'NULL'));

-- T14: DELETE fisica trasformata in soft delete -----------------------------------
DELETE FROM mes.ScanEvent WHERE ScanId = -1;   -- nessuna riga: solo per verificare che il trigger esista
DECLARE @ScanId INT;
EXEC mes.usp_ScanEvent_Insert @TenantId, @PlantId, N'test', 0, @UserId, N'test soft delete';
SELECT @ScanId = MAX(ScanId) FROM mes.ScanEvent WHERE RawValue = N'test';
DELETE FROM mes.ScanEvent WHERE ScanId = @ScanId;
INSERT INTO @Results VALUES (N'T14 DELETE diventa soft delete (riga presente con IsDeleted = 1)',
    CASE WHEN EXISTS (SELECT 1 FROM mes.ScanEvent WHERE ScanId = @ScanId AND IsDeleted = 1 AND DeletedAt IS NOT NULL) THEN 1 ELSE 0 END, N'');

ROLLBACK TRANSACTION;

-- Riepilogo ----------------------------------------------------------------------------
SELECT CASE WHEN Ok = 1 THEN N'OK  ' ELSE N'FAIL' END AS Esito, Test, Detail FROM @Results;
SELECT @Passed = SUM(CASE WHEN Ok = 1 THEN 1 ELSE 0 END), @Failures = SUM(CASE WHEN Ok = 0 THEN 1 ELSE 0 END) FROM @Results;
PRINT N'Test superati: ' + CAST(@Passed AS NVARCHAR(10)) + N', falliti: ' + CAST(@Failures AS NVARCHAR(10));
IF @Failures > 0
    RAISERROR (N'Alcuni test della macchina a stati sono falliti.', 16, 1);
GO
