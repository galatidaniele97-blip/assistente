-- =============================================================================
-- MES Pizzami - 02: funzioni e stored procedure
-- La logica di business (macchina a stati, registrazione bancale) vive qui,
-- cosi' vale per qualunque client. Idempotente (CREATE OR ALTER).
--
-- Codici errore (THROW):
--   50001 stato non trovato               50020 SSCC gia' registrato
--   50002 utente non trovato              50021 articolo (GTIN) non trovato
--   50010 bancale non trovato             50022 SSCC / GTIN non valido
--   50011 transizione non ammessa         50030 bancale in stato finale
--                                         50031 lotto di un altro articolo
-- =============================================================================
USE MesPizzami;
GO

-- -----------------------------------------------------------------------------
-- Conversione quantita' tra unita' di misura di un articolo.
-- Percorso: diretto (From->To), inverso (To->From) o a due passi passando per
-- un'unita' intermedia (es. PZ->CO->BC). Restituisce NULL se non c'e' percorso.
-- -----------------------------------------------------------------------------
CREATE OR ALTER FUNCTION mes.fn_ConvertQuantity
(
    @ProductId   INT,
    @Quantity    DECIMAL(18,6),
    @FromUomCode NVARCHAR(10),
    @ToUomCode   NVARCHAR(10)
)
RETURNS DECIMAL(18,6)
AS
BEGIN
    IF @FromUomCode = @ToUomCode RETURN @Quantity;

    DECLARE @FromId INT, @ToId INT, @TenantId INT, @PlantId INT;
    SELECT @TenantId = TenantId, @PlantId = PlantId FROM mes.Product WHERE ProductId = @ProductId;
    SELECT @FromId = UomId FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = @FromUomCode AND IsDeleted = 0;
    SELECT @ToId   = UomId FROM mes.UnitOfMeasure WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = @ToUomCode   AND IsDeleted = 0;
    IF @FromId IS NULL OR @ToId IS NULL RETURN NULL;

    DECLARE @Result DECIMAL(18,6) = NULL;

    -- 1) fattore diretto: From -> To
    SELECT @Result = @Quantity / Factor
    FROM mes.UomConversion
    WHERE ProductId = @ProductId AND FromUomId = @FromId AND ToUomId = @ToId AND IsDeleted = 0;
    IF @Result IS NOT NULL RETURN @Result;

    -- 2) fattore inverso: To -> From
    SELECT @Result = @Quantity * Factor
    FROM mes.UomConversion
    WHERE ProductId = @ProductId AND FromUomId = @ToId AND ToUomId = @FromId AND IsDeleted = 0;
    IF @Result IS NOT NULL RETURN @Result;

    -- 3) due passi: From -> X -> To  (es. PZ -> CO -> BC)
    SELECT TOP (1) @Result = @Quantity / (a.Factor * b.Factor)
    FROM mes.UomConversion a
    JOIN mes.UomConversion b ON b.ProductId = a.ProductId AND b.FromUomId = a.ToUomId AND b.IsDeleted = 0
    WHERE a.ProductId = @ProductId AND a.FromUomId = @FromId AND b.ToUomId = @ToId AND a.IsDeleted = 0;
    IF @Result IS NOT NULL RETURN @Result;

    -- 4) due passi inverso: To -> X -> From  (es. BC -> CO -> PZ)
    SELECT TOP (1) @Result = @Quantity * (a.Factor * b.Factor)
    FROM mes.UomConversion a
    JOIN mes.UomConversion b ON b.ProductId = a.ProductId AND b.FromUomId = a.ToUomId AND b.IsDeleted = 0
    WHERE a.ProductId = @ProductId AND a.FromUomId = @ToId AND b.ToUomId = @FromId AND a.IsDeleted = 0;

    RETURN @Result;
END;
GO

-- -----------------------------------------------------------------------------
-- Cambio di stato di un bancale (macchina a stati).
-- Verifica che la transizione (stato corrente -> @ToStatusCode) esista in
-- mes.PalletStatusTransition; altrimenti THROW 50011 e nessuna modifica.
-- Aggiorna il bancale e scrive mes.PalletStatusLog nella stessa transazione.
-- -----------------------------------------------------------------------------
CREATE OR ALTER PROCEDURE mes.usp_Pallet_ChangeStatus
    @TenantId     INT,
    @PlantId      INT,
    @PalletId     INT,
    @ToStatusCode NVARCHAR(20),
    @UserId       INT,
    @Notes        NVARCHAR(400) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @UserCode NVARCHAR(20);
    SELECT @UserCode = Code FROM mes.AppUser
    WHERE UserId = @UserId AND TenantId = @TenantId AND IsDeleted = 0 AND IsActive = 1;
    IF @UserCode IS NULL
        THROW 50002, N'Operatore non trovato o non attivo.', 1;

    DECLARE @ToStatusId INT;
    SELECT @ToStatusId = StatusId FROM mes.PalletStatus
    WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = @ToStatusCode AND IsDeleted = 0;
    IF @ToStatusId IS NULL
        THROW 50001, N'Stato di destinazione non trovato.', 1;

    -- Se il chiamante ha gia' una transazione aperta si usa un savepoint, cosi' la
    -- procedura e' riutilizzabile da script e import senza rompere la transazione esterna.
    DECLARE @OuterTran INT = @@TRANCOUNT;
    BEGIN TRY
        IF @OuterTran = 0 BEGIN TRANSACTION; ELSE SAVE TRANSACTION usp_Pallet_ChangeStatus;

        -- Blocco della riga: due tablet che avanzano lo stesso bancale nello stesso
        -- istante vengono serializzati e il secondo trova lo stato gia' cambiato.
        DECLARE @FromStatusId INT;
        SELECT @FromStatusId = StatusId
        FROM mes.Pallet WITH (UPDLOCK, HOLDLOCK)
        WHERE PalletId = @PalletId AND TenantId = @TenantId AND PlantId = @PlantId AND IsDeleted = 0;
        IF @FromStatusId IS NULL
            THROW 50010, N'Bancale non trovato.', 1;

        IF NOT EXISTS (
            SELECT 1 FROM mes.PalletStatusTransition
            WHERE TenantId = @TenantId AND PlantId = @PlantId
              AND FromStatusId = @FromStatusId AND ToStatusId = @ToStatusId AND IsDeleted = 0)
        BEGIN
            DECLARE @FromCode NVARCHAR(20) = (SELECT Code FROM mes.PalletStatus WHERE StatusId = @FromStatusId);
            DECLARE @Msg NVARCHAR(200) = N'Transizione non ammessa: da ' + @FromCode + N' a ' + @ToStatusCode + N'.';
            THROW 50011, @Msg, 1;
        END;

        UPDATE mes.Pallet
        SET StatusId = @ToStatusId, UpdatedAt = SYSDATETIME(), UpdatedBy = @UserCode
        WHERE PalletId = @PalletId;

        INSERT INTO mes.PalletStatusLog (TenantId, PlantId, PalletId, FromStatusId, ToStatusId, UserId, Notes, CreatedBy)
        VALUES (@TenantId, @PlantId, @PalletId, @FromStatusId, @ToStatusId, @UserId, @Notes, @UserCode);

        IF @OuterTran = 0 COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @OuterTran = 0
        BEGIN
            IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        END
        ELSE IF XACT_STATE() = 1
            ROLLBACK TRANSACTION usp_Pallet_ChangeStatus;
        THROW;
    END CATCH;

    SELECT * FROM mes.vw_Pallet WHERE PalletId = @PalletId;
END;
GO

-- -----------------------------------------------------------------------------
-- Registrazione di un nuovo bancale a partire dai campi del barcode GS1.
-- Trova l'articolo dal GTIN, trova o crea il lotto, crea bancale + contenuto e
-- scrive la prima riga di log (FromStatusId NULL -> stato iniziale).
-- Se @Cases e' NULL usa i colli per bancale dell'articolo.
-- -----------------------------------------------------------------------------
CREATE OR ALTER PROCEDURE mes.usp_Pallet_Register
    @TenantId          INT,
    @PlantId           INT,
    @Sscc              CHAR(18),
    @Gtin              CHAR(14),
    @LotNumber         NVARCHAR(20),
    @UserId            INT,
    @ProductionDate    DATE          = NULL,
    @BestBeforeDate    DATE          = NULL,
    @ExpiryDate        DATE          = NULL,
    @Cases             INT           = NULL,
    @NetWeightKg       DECIMAL(10,3) = NULL,
    @InitialStatusCode NVARCHAR(20)  = N'PRODOTTO',
    @Notes             NVARCHAR(400) = NULL,
    @PalletId          INT           = NULL OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    IF mes.fn_IsGs1CheckDigitValid(@Sscc) = 0 OR LEN(@Sscc) <> 18
        THROW 50022, N'SSCC non valido (lunghezza o check digit errati).', 1;
    IF mes.fn_IsGs1CheckDigitValid(@Gtin) = 0 OR LEN(@Gtin) <> 14
        THROW 50022, N'GTIN non valido (lunghezza o check digit errati).', 1;
    IF @LotNumber IS NULL OR LTRIM(RTRIM(@LotNumber)) = N''
        THROW 50022, N'Numero di lotto mancante.', 1;

    DECLARE @UserCode NVARCHAR(20);
    SELECT @UserCode = Code FROM mes.AppUser
    WHERE UserId = @UserId AND TenantId = @TenantId AND IsDeleted = 0 AND IsActive = 1;
    IF @UserCode IS NULL
        THROW 50002, N'Operatore non trovato o non attivo.', 1;

    DECLARE @StatusId INT;
    SELECT @StatusId = StatusId FROM mes.PalletStatus
    WHERE TenantId = @TenantId AND PlantId = @PlantId AND Code = @InitialStatusCode AND IsDeleted = 0;
    IF @StatusId IS NULL
        THROW 50001, N'Stato iniziale non trovato.', 1;

    DECLARE @ProductId INT, @CasesPerPallet INT;
    SELECT @ProductId = ProductId, @CasesPerPallet = CasesPerPallet
    FROM mes.vw_Product
    WHERE TenantId = @TenantId AND Gtin = @Gtin AND IsActive = 1;
    IF @ProductId IS NULL
        THROW 50021, N'Articolo non trovato per questo GTIN.', 1;

    IF EXISTS (SELECT 1 FROM mes.Pallet WHERE TenantId = @TenantId AND Sscc = @Sscc AND IsDeleted = 0)
        THROW 50020, N'SSCC gia'' registrato.', 1;

    IF @Cases IS NULL SET @Cases = @CasesPerPallet;
    IF @Cases IS NULL OR @Cases <= 0
        THROW 50022, N'Numero di colli mancante o non valido.', 1;

    -- Se il chiamante ha gia' una transazione aperta si usa un savepoint, cosi' la
    -- procedura e' riutilizzabile da script e import senza rompere la transazione esterna.
    DECLARE @OuterTran INT = @@TRANCOUNT;
    BEGIN TRY
        IF @OuterTran = 0 BEGIN TRANSACTION; ELSE SAVE TRANSACTION usp_Pallet_Register;

        -- Lotto: trova o crea. Se esiste, completa le date eventualmente mancanti.
        DECLARE @LotId INT;
        SELECT @LotId = LotId FROM mes.ProductionLot
        WHERE TenantId = @TenantId AND ProductId = @ProductId AND LotNumber = @LotNumber AND IsDeleted = 0;

        IF @LotId IS NULL
        BEGIN
            INSERT INTO mes.ProductionLot (TenantId, PlantId, ProductId, LotNumber, ProductionDate, BestBeforeDate, ExpiryDate, CreatedBy)
            VALUES (@TenantId, @PlantId, @ProductId, @LotNumber, @ProductionDate, @BestBeforeDate, @ExpiryDate, @UserCode);
            SET @LotId = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            UPDATE mes.ProductionLot
            SET ProductionDate = ISNULL(ProductionDate, @ProductionDate),
                BestBeforeDate = ISNULL(BestBeforeDate, @BestBeforeDate),
                ExpiryDate     = ISNULL(ExpiryDate, @ExpiryDate),
                UpdatedAt = SYSDATETIME(), UpdatedBy = @UserCode
            WHERE LotId = @LotId
              AND (   (ProductionDate IS NULL AND @ProductionDate IS NOT NULL)
                   OR (BestBeforeDate IS NULL AND @BestBeforeDate IS NOT NULL)
                   OR (ExpiryDate     IS NULL AND @ExpiryDate     IS NOT NULL));
        END;

        INSERT INTO mes.Pallet (TenantId, PlantId, Sscc, ProductId, StatusId, ExpectedCases, NetWeightKg, Notes, CreatedBy)
        VALUES (@TenantId, @PlantId, @Sscc, @ProductId, @StatusId, @CasesPerPallet, @NetWeightKg, @Notes, @UserCode);
        SET @PalletId = SCOPE_IDENTITY();

        INSERT INTO mes.PalletLot (TenantId, PlantId, PalletId, LotId, Cases, CreatedBy)
        VALUES (@TenantId, @PlantId, @PalletId, @LotId, @Cases, @UserCode);

        INSERT INTO mes.PalletStatusLog (TenantId, PlantId, PalletId, FromStatusId, ToStatusId, UserId, Notes, CreatedBy)
        VALUES (@TenantId, @PlantId, @PalletId, NULL, @StatusId, @UserId, N'Registrazione bancale', @UserCode);

        IF @OuterTran = 0 COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @OuterTran = 0
        BEGIN
            IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        END
        ELSE IF XACT_STATE() = 1
            ROLLBACK TRANSACTION usp_Pallet_Register;
        THROW;
    END CATCH;

    SELECT * FROM mes.vw_Pallet WHERE PalletId = @PalletId;
END;
GO

-- -----------------------------------------------------------------------------
-- Aggiunta di un lotto (o di altri colli dello stesso lotto) a un bancale
-- esistente: serve per i bancali misti di fine produzione.
-- Regole: bancale non in stato finale; il lotto deve essere dello stesso articolo.
-- -----------------------------------------------------------------------------
CREATE OR ALTER PROCEDURE mes.usp_Pallet_AddLot
    @TenantId       INT,
    @PlantId        INT,
    @PalletId       INT,
    @LotNumber      NVARCHAR(20),
    @Cases          INT,
    @UserId         INT,
    @ProductionDate DATE = NULL,
    @BestBeforeDate DATE = NULL,
    @ExpiryDate     DATE = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @Cases IS NULL OR @Cases <= 0
        THROW 50022, N'Numero di colli mancante o non valido.', 1;

    DECLARE @UserCode NVARCHAR(20);
    SELECT @UserCode = Code FROM mes.AppUser
    WHERE UserId = @UserId AND TenantId = @TenantId AND IsDeleted = 0 AND IsActive = 1;
    IF @UserCode IS NULL
        THROW 50002, N'Operatore non trovato o non attivo.', 1;

    -- Se il chiamante ha gia' una transazione aperta si usa un savepoint, cosi' la
    -- procedura e' riutilizzabile da script e import senza rompere la transazione esterna.
    DECLARE @OuterTran INT = @@TRANCOUNT;
    BEGIN TRY
        IF @OuterTran = 0 BEGIN TRANSACTION; ELSE SAVE TRANSACTION usp_Pallet_AddLot;

        DECLARE @ProductId INT, @IsFinal BIT;
        SELECT @ProductId = b.ProductId, @IsFinal = s.IsFinal
        FROM mes.Pallet b WITH (UPDLOCK, HOLDLOCK)
        JOIN mes.PalletStatus s ON s.StatusId = b.StatusId
        WHERE b.PalletId = @PalletId AND b.TenantId = @TenantId AND b.PlantId = @PlantId AND b.IsDeleted = 0;
        IF @ProductId IS NULL
            THROW 50010, N'Bancale non trovato.', 1;
        IF @IsFinal = 1
            THROW 50030, N'Il bancale e'' in uno stato finale: contenuto non modificabile.', 1;

        -- Un lotto con lo stesso numero ma di un altro articolo non puo' finire su questo bancale
        IF EXISTS (SELECT 1 FROM mes.ProductionLot
                   WHERE TenantId = @TenantId AND LotNumber = @LotNumber AND IsDeleted = 0 AND ProductId <> @ProductId)
           AND NOT EXISTS (SELECT 1 FROM mes.ProductionLot
                   WHERE TenantId = @TenantId AND LotNumber = @LotNumber AND IsDeleted = 0 AND ProductId = @ProductId)
            THROW 50031, N'Il lotto appartiene a un altro articolo.', 1;

        DECLARE @LotId INT;
        SELECT @LotId = LotId FROM mes.ProductionLot
        WHERE TenantId = @TenantId AND ProductId = @ProductId AND LotNumber = @LotNumber AND IsDeleted = 0;
        IF @LotId IS NULL
        BEGIN
            INSERT INTO mes.ProductionLot (TenantId, PlantId, ProductId, LotNumber, ProductionDate, BestBeforeDate, ExpiryDate, CreatedBy)
            VALUES (@TenantId, @PlantId, @ProductId, @LotNumber, @ProductionDate, @BestBeforeDate, @ExpiryDate, @UserCode);
            SET @LotId = SCOPE_IDENTITY();
        END;

        IF EXISTS (SELECT 1 FROM mes.PalletLot WHERE PalletId = @PalletId AND LotId = @LotId AND IsDeleted = 0)
            UPDATE mes.PalletLot
            SET Cases = Cases + @Cases, UpdatedAt = SYSDATETIME(), UpdatedBy = @UserCode
            WHERE PalletId = @PalletId AND LotId = @LotId AND IsDeleted = 0;
        ELSE
            INSERT INTO mes.PalletLot (TenantId, PlantId, PalletId, LotId, Cases, CreatedBy)
            VALUES (@TenantId, @PlantId, @PalletId, @LotId, @Cases, @UserCode);

        UPDATE mes.Pallet SET UpdatedAt = SYSDATETIME(), UpdatedBy = @UserCode WHERE PalletId = @PalletId;

        IF @OuterTran = 0 COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @OuterTran = 0
        BEGIN
            IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        END
        ELSE IF XACT_STATE() = 1
            ROLLBACK TRANSACTION usp_Pallet_AddLot;
        THROW;
    END CATCH;

    SELECT * FROM mes.vw_PalletLot WHERE PalletId = @PalletId;
END;
GO

-- -----------------------------------------------------------------------------
-- Registrazione di una scansione (riuscita o fallita). Restituisce ScanId.
-- -----------------------------------------------------------------------------
CREATE OR ALTER PROCEDURE mes.usp_ScanEvent_Insert
    @TenantId       INT,
    @PlantId        INT,
    @RawValue       NVARCHAR(400),
    @ParseOk        BIT,
    @UserId         INT           = NULL,
    @ErrorMessage   NVARCHAR(400) = NULL,
    @Sscc           CHAR(18)      = NULL,
    @Gtin           CHAR(14)      = NULL,
    @LotNumber      NVARCHAR(20)  = NULL,
    @ProductionDate DATE          = NULL,
    @BestBeforeDate DATE          = NULL,
    @ExpiryDate     DATE          = NULL,
    @CaseCount      INT           = NULL,
    @NetWeightKg    DECIMAL(10,3) = NULL,
    @PalletId       INT           = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @UserCode NVARCHAR(20) = ISNULL((SELECT Code FROM mes.AppUser WHERE UserId = @UserId), N'system');

    INSERT INTO mes.ScanEvent (TenantId, PlantId, UserId, RawValue, ParseOk, ErrorMessage,
                               Sscc, Gtin, LotNumber, ProductionDate, BestBeforeDate, ExpiryDate,
                               CaseCount, NetWeightKg, PalletId, CreatedBy)
    VALUES (@TenantId, @PlantId, @UserId, @RawValue, @ParseOk, @ErrorMessage,
            @Sscc, @Gtin, @LotNumber, @ProductionDate, @BestBeforeDate, @ExpiryDate,
            @CaseCount, @NetWeightKg, @PalletId, @UserCode);

    SELECT CAST(SCOPE_IDENTITY() AS INT) AS ScanId;
END;
GO
