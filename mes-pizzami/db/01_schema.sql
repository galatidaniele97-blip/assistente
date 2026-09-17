-- =============================================================================
-- MES Pizzami - 01: schema (tabelle, vincoli, viste, trigger di soft delete)
-- Compatibile con SQL Server 2017+. Idempotente.
--
-- Convenzioni su OGNI tabella:
--   TenantId, PlantId            multi-azienda / multi-stabilimento fin dall'inizio
--   CreatedAt, CreatedBy          audit di inserimento
--   UpdatedAt, UpdatedBy          audit di modifica
--   IsDeleted, DeletedAt          soft delete (nessuna DELETE fisica: vedi trigger in fondo)
-- Eccezione documentata: mes.Tenant non ha PlantId (lo stabilimento e' figlio del tenant).
--
-- Le date di audit usano l'ora locale del server (SYSDATETIME): coincide con i
-- registri cartacei dello stabilimento.
-- =============================================================================
USE MesPizzami;
GO
IF SCHEMA_ID(N'mes') IS NULL EXEC (N'CREATE SCHEMA mes');
GO

-- -----------------------------------------------------------------------------
-- Funzione: validazione check digit GS1 (modulo 10) per GTIN-14 e SSCC-18.
-- Usata nei CHECK constraint di Product.Gtin e Pallet.Sscc: il database rifiuta
-- codici non validi anche se arrivano da un client diverso dal tablet.
-- Viene creata solo se assente: una funzione referenziata da un CHECK
-- constraint non si puo' alterare (per modificarla: rimuovere i constraint,
-- ricreare la funzione, riaggiungere i constraint).
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.fn_IsGs1CheckDigitValid') IS NULL
EXEC (N'
CREATE FUNCTION mes.fn_IsGs1CheckDigitValid (@Code VARCHAR(20))
RETURNS BIT
AS
BEGIN
    IF @Code IS NULL OR @Code LIKE ''%[^0-9]%'' OR LEN(@Code) NOT IN (8, 12, 13, 14, 18)
        RETURN 0;

    DECLARE @Body VARCHAR(20) = LEFT(@Code, LEN(@Code) - 1);
    DECLARE @Given INT = CAST(RIGHT(@Code, 1) AS INT);
    DECLARE @Sum INT = 0;
    DECLARE @Pos INT = LEN(@Body);      -- si parte dalla cifra piu'' a destra del corpo
    DECLARE @Weight INT = 3;            -- la cifra piu'' a destra pesa 3, poi 1, 3, 1...

    WHILE @Pos >= 1
    BEGIN
        SET @Sum = @Sum + CAST(SUBSTRING(@Body, @Pos, 1) AS INT) * @Weight;
        SET @Weight = CASE WHEN @Weight = 3 THEN 1 ELSE 3 END;
        SET @Pos = @Pos - 1;
    END;

    RETURN CASE WHEN (10 - (@Sum % 10)) % 10 = @Given THEN 1 ELSE 0 END;
END;
');
GO

-- -----------------------------------------------------------------------------
-- Tenant e stabilimento
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.Tenant') IS NULL
BEGIN
    CREATE TABLE mes.Tenant (
        TenantId    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Tenant PRIMARY KEY,
        Code        NVARCHAR(20)  NOT NULL,
        Name        NVARCHAR(100) NOT NULL,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_Tenant_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_Tenant_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL
    );
    CREATE UNIQUE INDEX UX_Tenant_Code ON mes.Tenant (Code) WHERE IsDeleted = 0;
END;
GO

IF OBJECT_ID(N'mes.Plant') IS NULL
BEGIN
    CREATE TABLE mes.Plant (
        PlantId     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Plant PRIMARY KEY,
        TenantId    INT           NOT NULL CONSTRAINT FK_Plant_Tenant REFERENCES mes.Tenant (TenantId),
        Code        NVARCHAR(20)  NOT NULL,
        Name        NVARCHAR(100) NOT NULL,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_Plant_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_Plant_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        -- Chiave composta referenziata da tutte le altre tabelle: garantisce che
        -- PlantId appartenga davvero al TenantId indicato.
        CONSTRAINT UQ_Plant_TenantPlant UNIQUE (TenantId, PlantId)
    );
    CREATE UNIQUE INDEX UX_Plant_Code ON mes.Plant (TenantId, Code) WHERE IsDeleted = 0;
END;
GO

-- -----------------------------------------------------------------------------
-- Operatori (demo: nessuna password, si sceglie l'operatore da una lista)
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.AppUser') IS NULL
BEGIN
    CREATE TABLE mes.AppUser (
        UserId      INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AppUser PRIMARY KEY,
        TenantId    INT           NOT NULL,
        PlantId     INT           NOT NULL,
        Code        NVARCHAR(20)  NOT NULL,
        FullName    NVARCHAR(100) NOT NULL,
        Role        NVARCHAR(30)  NOT NULL CONSTRAINT CK_AppUser_Role CHECK (Role IN (N'OPERATORE', N'CAPOTURNO', N'LOGISTICA', N'AMMINISTRATORE')),
        IsActive    BIT           NOT NULL CONSTRAINT DF_AppUser_IsActive DEFAULT 1,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_AppUser_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_AppUser_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        CONSTRAINT FK_AppUser_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId)
    );
    CREATE UNIQUE INDEX UX_AppUser_Code ON mes.AppUser (TenantId, Code) WHERE IsDeleted = 0;
END;
GO

-- -----------------------------------------------------------------------------
-- Anagrafiche di supporto: unita' di misura, formato, tipo conservazione
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.UnitOfMeasure') IS NULL
BEGIN
    CREATE TABLE mes.UnitOfMeasure (
        UomId       INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_UnitOfMeasure PRIMARY KEY,
        TenantId    INT           NOT NULL,
        PlantId     INT           NOT NULL,
        Code        NVARCHAR(10)  NOT NULL,      -- PZ, CO, BC
        Name        NVARCHAR(50)  NOT NULL,      -- Pezzo, Collo, Bancale
        SortOrder   INT           NOT NULL CONSTRAINT DF_UnitOfMeasure_SortOrder DEFAULT 0,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_UnitOfMeasure_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_UnitOfMeasure_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        CONSTRAINT FK_UnitOfMeasure_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId)
    );
    CREATE UNIQUE INDEX UX_UnitOfMeasure_Code ON mes.UnitOfMeasure (TenantId, PlantId, Code) WHERE IsDeleted = 0;
END;
GO

IF OBJECT_ID(N'mes.ProductFormat') IS NULL
BEGIN
    CREATE TABLE mes.ProductFormat (
        FormatId    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ProductFormat PRIMARY KEY,
        TenantId    INT           NOT NULL,
        PlantId     INT           NOT NULL,
        Code        NVARCHAR(20)  NOT NULL,      -- PIZZA, PINSA, PANE, FOCACCIA
        Name        NVARCHAR(50)  NOT NULL,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_ProductFormat_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_ProductFormat_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        CONSTRAINT FK_ProductFormat_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId)
    );
    CREATE UNIQUE INDEX UX_ProductFormat_Code ON mes.ProductFormat (TenantId, PlantId, Code) WHERE IsDeleted = 0;
END;
GO

IF OBJECT_ID(N'mes.StorageType') IS NULL
BEGIN
    CREATE TABLE mes.StorageType (
        StorageTypeId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_StorageType PRIMARY KEY,
        TenantId    INT           NOT NULL,
        PlantId     INT           NOT NULL,
        Code        NVARCHAR(20)  NOT NULL,      -- FRESCO, SURGELATO
        Name        NVARCHAR(50)  NOT NULL,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_StorageType_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_StorageType_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        CONSTRAINT FK_StorageType_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId)
    );
    CREATE UNIQUE INDEX UX_StorageType_Code ON mes.StorageType (TenantId, PlantId, Code) WHERE IsDeleted = 0;
END;
GO

-- -----------------------------------------------------------------------------
-- Prodotto finito
-- I fattori pezzo->collo->bancale stanno SOLO in mes.UomConversion (unica fonte);
-- la vista mes.vw_Product li espone come PiecesPerCase / CasesPerPallet.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.Product') IS NULL
BEGIN
    CREATE TABLE mes.Product (
        ProductId       INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Product PRIMARY KEY,
        TenantId        INT           NOT NULL,
        PlantId         INT           NOT NULL,
        Gtin            CHAR(14)      NOT NULL,   -- GTIN-14 dell'unita' logistica (collo), come da AI (01)
        Code            NVARCHAR(30)  NOT NULL,   -- codice articolo interno (allineabile a Business Cube)
        Description     NVARCHAR(200) NOT NULL,
        FormatId        INT           NOT NULL CONSTRAINT FK_Product_Format REFERENCES mes.ProductFormat (FormatId),
        StorageTypeId   INT           NOT NULL CONSTRAINT FK_Product_StorageType REFERENCES mes.StorageType (StorageTypeId),
        BaseUomId       INT           NOT NULL CONSTRAINT FK_Product_BaseUom REFERENCES mes.UnitOfMeasure (UomId),
        NetWeightPieceG INT           NULL,       -- peso netto del singolo pezzo in grammi
        ShelfLifeDays   INT           NULL,       -- giorni di vita utile (TMC o scadenza) dalla produzione
        IsActive        BIT           NOT NULL CONSTRAINT DF_Product_IsActive DEFAULT 1,
        CreatedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_Product_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy       NVARCHAR(50)  NOT NULL,
        UpdatedAt       DATETIME2(0)  NULL,
        UpdatedBy       NVARCHAR(50)  NULL,
        IsDeleted       BIT           NOT NULL CONSTRAINT DF_Product_IsDeleted DEFAULT 0,
        DeletedAt       DATETIME2(0)  NULL,
        CONSTRAINT FK_Product_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId),
        CONSTRAINT CK_Product_Gtin CHECK (mes.fn_IsGs1CheckDigitValid(Gtin) = 1),
        CONSTRAINT CK_Product_ShelfLife CHECK (ShelfLifeDays IS NULL OR ShelfLifeDays > 0)
    );
    CREATE UNIQUE INDEX UX_Product_Gtin ON mes.Product (TenantId, Gtin) WHERE IsDeleted = 0;
    CREATE UNIQUE INDEX UX_Product_Code ON mes.Product (TenantId, Code) WHERE IsDeleted = 0;
END;
GO

IF OBJECT_ID(N'mes.UomConversion') IS NULL
BEGIN
    CREATE TABLE mes.UomConversion (
        ConversionId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_UomConversion PRIMARY KEY,
        TenantId    INT           NOT NULL,
        PlantId     INT           NOT NULL,
        ProductId   INT           NOT NULL CONSTRAINT FK_UomConversion_Product REFERENCES mes.Product (ProductId),
        FromUomId   INT           NOT NULL CONSTRAINT FK_UomConversion_FromUom REFERENCES mes.UnitOfMeasure (UomId),
        ToUomId     INT           NOT NULL CONSTRAINT FK_UomConversion_ToUom REFERENCES mes.UnitOfMeasure (UomId),
        Factor      DECIMAL(18,6) NOT NULL,       -- quante unita' "From" formano una unita' "To" (es. PZ->CO = 6)
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_UomConversion_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_UomConversion_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        CONSTRAINT FK_UomConversion_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId),
        CONSTRAINT CK_UomConversion_Factor CHECK (Factor > 0),
        CONSTRAINT CK_UomConversion_Distinct CHECK (FromUomId <> ToUomId)
    );
    CREATE UNIQUE INDEX UX_UomConversion ON mes.UomConversion (ProductId, FromUomId, ToUomId) WHERE IsDeleted = 0;
END;
GO

-- -----------------------------------------------------------------------------
-- Lotto di produzione: entita' autonoma (un lotto genera molti bancali; il
-- recall parte dal lotto). Le date TMC/scadenza sono del lotto.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.ProductionLot') IS NULL
BEGIN
    CREATE TABLE mes.ProductionLot (
        LotId           INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ProductionLot PRIMARY KEY,
        TenantId        INT           NOT NULL,
        PlantId         INT           NOT NULL,
        ProductId       INT           NOT NULL CONSTRAINT FK_ProductionLot_Product REFERENCES mes.Product (ProductId),
        LotNumber       NVARCHAR(20)  NOT NULL,   -- AI (10), max 20 caratteri
        ProductionDate  DATE          NULL,       -- AI (11)
        BestBeforeDate  DATE          NULL,       -- AI (15) TMC "da consumarsi preferibilmente entro"
        ExpiryDate      DATE          NULL,       -- AI (17) scadenza "da consumarsi entro"
        CreatedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_ProductionLot_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy       NVARCHAR(50)  NOT NULL,
        UpdatedAt       DATETIME2(0)  NULL,
        UpdatedBy       NVARCHAR(50)  NULL,
        IsDeleted       BIT           NOT NULL CONSTRAINT DF_ProductionLot_IsDeleted DEFAULT 0,
        DeletedAt       DATETIME2(0)  NULL,
        CONSTRAINT FK_ProductionLot_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId),
        CONSTRAINT CK_ProductionLot_Dates CHECK (
            (BestBeforeDate IS NULL OR ProductionDate IS NULL OR BestBeforeDate >= ProductionDate) AND
            (ExpiryDate     IS NULL OR ProductionDate IS NULL OR ExpiryDate     >= ProductionDate))
    );
    CREATE UNIQUE INDEX UX_ProductionLot ON mes.ProductionLot (TenantId, ProductId, LotNumber) WHERE IsDeleted = 0;
    CREATE INDEX IX_ProductionLot_LotNumber ON mes.ProductionLot (TenantId, LotNumber);
END;
GO

-- -----------------------------------------------------------------------------
-- Macchina a stati del bancale
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.PalletStatus') IS NULL
BEGIN
    CREATE TABLE mes.PalletStatus (
        StatusId    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PalletStatus PRIMARY KEY,
        TenantId    INT           NOT NULL,
        PlantId     INT           NOT NULL,
        Code        NVARCHAR(20)  NOT NULL,      -- DA_PRODURRE, PRODOTTO, PRENOTATO, SPEDITO
        Name        NVARCHAR(50)  NOT NULL,
        SortOrder   INT           NOT NULL,
        IsFinal     BIT           NOT NULL CONSTRAINT DF_PalletStatus_IsFinal DEFAULT 0,
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_PalletStatus_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_PalletStatus_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        CONSTRAINT FK_PalletStatus_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId)
    );
    CREATE UNIQUE INDEX UX_PalletStatus_Code ON mes.PalletStatus (TenantId, PlantId, Code) WHERE IsDeleted = 0;
END;
GO

-- Le transizioni ammesse sono DATI, non codice: aggiungere una transizione
-- (es. PRENOTATO -> PRODOTTO "Annulla prenotazione") e' un INSERT.
IF OBJECT_ID(N'mes.PalletStatusTransition') IS NULL
BEGIN
    CREATE TABLE mes.PalletStatusTransition (
        TransitionId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PalletStatusTransition PRIMARY KEY,
        TenantId     INT           NOT NULL,
        PlantId      INT           NOT NULL,
        FromStatusId INT           NOT NULL CONSTRAINT FK_PalletStatusTransition_From REFERENCES mes.PalletStatus (StatusId),
        ToStatusId   INT           NOT NULL CONSTRAINT FK_PalletStatusTransition_To   REFERENCES mes.PalletStatus (StatusId),
        ActionName   NVARCHAR(50)  NOT NULL,     -- etichetta del pulsante sul tablet: "Prenota", "Spedisci"...
        SortOrder    INT           NOT NULL CONSTRAINT DF_PalletStatusTransition_SortOrder DEFAULT 0,
        CreatedAt    DATETIME2(0)  NOT NULL CONSTRAINT DF_PalletStatusTransition_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy    NVARCHAR(50)  NOT NULL,
        UpdatedAt    DATETIME2(0)  NULL,
        UpdatedBy    NVARCHAR(50)  NULL,
        IsDeleted    BIT           NOT NULL CONSTRAINT DF_PalletStatusTransition_IsDeleted DEFAULT 0,
        DeletedAt    DATETIME2(0)  NULL,
        CONSTRAINT FK_PalletStatusTransition_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId),
        CONSTRAINT CK_PalletStatusTransition_Distinct CHECK (FromStatusId <> ToStatusId)
    );
    CREATE UNIQUE INDEX UX_PalletStatusTransition ON mes.PalletStatusTransition (TenantId, PlantId, FromStatusId, ToStatusId) WHERE IsDeleted = 0;
END;
GO

-- -----------------------------------------------------------------------------
-- Bancale e contenuto (bancale <-> lotto: molti-a-molti con quantita' colli)
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.Pallet') IS NULL
BEGIN
    CREATE TABLE mes.Pallet (
        PalletId        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Pallet PRIMARY KEY,
        TenantId        INT           NOT NULL,
        PlantId         INT           NOT NULL,
        Sscc            CHAR(18)      NOT NULL,   -- AI (00)
        ProductId       INT           NOT NULL CONSTRAINT FK_Pallet_Product REFERENCES mes.Product (ProductId),
        StatusId        INT           NOT NULL CONSTRAINT FK_Pallet_Status REFERENCES mes.PalletStatus (StatusId),
        ExpectedCases   INT           NULL,       -- colli previsti (default: colli per bancale dell'articolo)
        NetWeightKg     DECIMAL(10,3) NULL,       -- AI (310x)
        Notes           NVARCHAR(400) NULL,
        CreatedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_Pallet_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy       NVARCHAR(50)  NOT NULL,
        UpdatedAt       DATETIME2(0)  NULL,
        UpdatedBy       NVARCHAR(50)  NULL,
        IsDeleted       BIT           NOT NULL CONSTRAINT DF_Pallet_IsDeleted DEFAULT 0,
        DeletedAt       DATETIME2(0)  NULL,
        CONSTRAINT FK_Pallet_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId),
        CONSTRAINT CK_Pallet_Sscc CHECK (LEN(Sscc) = 18 AND mes.fn_IsGs1CheckDigitValid(Sscc) = 1),
        CONSTRAINT CK_Pallet_ExpectedCases CHECK (ExpectedCases IS NULL OR ExpectedCases > 0),
        CONSTRAINT CK_Pallet_NetWeight CHECK (NetWeightKg IS NULL OR NetWeightKg >= 0)
    );
    CREATE UNIQUE INDEX UX_Pallet_Sscc ON mes.Pallet (TenantId, Sscc) WHERE IsDeleted = 0;
    CREATE INDEX IX_Pallet_Status ON mes.Pallet (TenantId, PlantId, StatusId) WHERE IsDeleted = 0;
END;
GO

IF OBJECT_ID(N'mes.PalletLot') IS NULL
BEGIN
    CREATE TABLE mes.PalletLot (
        PalletLotId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PalletLot PRIMARY KEY,
        TenantId    INT           NOT NULL,
        PlantId     INT           NOT NULL,
        PalletId    INT           NOT NULL CONSTRAINT FK_PalletLot_Pallet REFERENCES mes.Pallet (PalletId),
        LotId       INT           NOT NULL CONSTRAINT FK_PalletLot_Lot REFERENCES mes.ProductionLot (LotId),
        Cases       INT           NOT NULL,       -- colli di questo lotto presenti sul bancale
        CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_PalletLot_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy   NVARCHAR(50)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NULL,
        UpdatedBy   NVARCHAR(50)  NULL,
        IsDeleted   BIT           NOT NULL CONSTRAINT DF_PalletLot_IsDeleted DEFAULT 0,
        DeletedAt   DATETIME2(0)  NULL,
        CONSTRAINT FK_PalletLot_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId),
        CONSTRAINT CK_PalletLot_Cases CHECK (Cases > 0)
    );
    CREATE UNIQUE INDEX UX_PalletLot ON mes.PalletLot (PalletId, LotId) WHERE IsDeleted = 0;
    CREATE INDEX IX_PalletLot_Lot ON mes.PalletLot (LotId) WHERE IsDeleted = 0;
END;
GO

-- Storico transizioni: una riga per ogni cambio di stato (FromStatusId NULL = creazione)
IF OBJECT_ID(N'mes.PalletStatusLog') IS NULL
BEGIN
    CREATE TABLE mes.PalletStatusLog (
        LogId        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PalletStatusLog PRIMARY KEY,
        TenantId     INT           NOT NULL,
        PlantId      INT           NOT NULL,
        PalletId     INT           NOT NULL CONSTRAINT FK_PalletStatusLog_Pallet REFERENCES mes.Pallet (PalletId),
        FromStatusId INT           NULL     CONSTRAINT FK_PalletStatusLog_From REFERENCES mes.PalletStatus (StatusId),
        ToStatusId   INT           NOT NULL CONSTRAINT FK_PalletStatusLog_To   REFERENCES mes.PalletStatus (StatusId),
        UserId       INT           NOT NULL CONSTRAINT FK_PalletStatusLog_User REFERENCES mes.AppUser (UserId),
        LoggedAt     DATETIME2(0)  NOT NULL CONSTRAINT DF_PalletStatusLog_LoggedAt DEFAULT SYSDATETIME(),
        Notes        NVARCHAR(400) NULL,
        CreatedAt    DATETIME2(0)  NOT NULL CONSTRAINT DF_PalletStatusLog_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy    NVARCHAR(50)  NOT NULL,
        UpdatedAt    DATETIME2(0)  NULL,
        UpdatedBy    NVARCHAR(50)  NULL,
        IsDeleted    BIT           NOT NULL CONSTRAINT DF_PalletStatusLog_IsDeleted DEFAULT 0,
        DeletedAt    DATETIME2(0)  NULL,
        CONSTRAINT FK_PalletStatusLog_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId)
    );
    CREATE INDEX IX_PalletStatusLog_Pallet ON mes.PalletStatusLog (PalletId, LoggedAt);
END;
GO

-- -----------------------------------------------------------------------------
-- Scansioni: ogni lettura, riuscita o fallita. Campi GS1 in colonne strutturate,
-- stringa grezza solo come riferimento.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'mes.ScanEvent') IS NULL
BEGIN
    CREATE TABLE mes.ScanEvent (
        ScanId          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ScanEvent PRIMARY KEY,
        TenantId        INT           NOT NULL,
        PlantId         INT           NOT NULL,
        ScannedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_ScanEvent_ScannedAt DEFAULT SYSDATETIME(),
        UserId          INT           NULL CONSTRAINT FK_ScanEvent_User REFERENCES mes.AppUser (UserId),
        RawValue        NVARCHAR(400) NOT NULL,   -- stringa cosi' come letta (GS sostituito da <GS> per leggibilita')
        ParseOk         BIT           NOT NULL,
        ErrorMessage    NVARCHAR(400) NULL,
        Sscc            CHAR(18)      NULL,       -- (00)
        Gtin            CHAR(14)      NULL,       -- (01) / (02)
        LotNumber       NVARCHAR(20)  NULL,       -- (10)
        ProductionDate  DATE          NULL,       -- (11)
        BestBeforeDate  DATE          NULL,       -- (15)
        ExpiryDate      DATE          NULL,       -- (17)
        CaseCount       INT           NULL,       -- (37)
        NetWeightKg     DECIMAL(10,3) NULL,       -- (310x)
        PalletId        INT           NULL CONSTRAINT FK_ScanEvent_Pallet REFERENCES mes.Pallet (PalletId),
        CreatedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_ScanEvent_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy       NVARCHAR(50)  NOT NULL,
        UpdatedAt       DATETIME2(0)  NULL,
        UpdatedBy       NVARCHAR(50)  NULL,
        IsDeleted       BIT           NOT NULL CONSTRAINT DF_ScanEvent_IsDeleted DEFAULT 0,
        DeletedAt       DATETIME2(0)  NULL,
        CONSTRAINT FK_ScanEvent_Plant FOREIGN KEY (TenantId, PlantId) REFERENCES mes.Plant (TenantId, PlantId)
    );
    CREATE INDEX IX_ScanEvent_ScannedAt ON mes.ScanEvent (TenantId, PlantId, ScannedAt);
    CREATE INDEX IX_ScanEvent_Sscc ON mes.ScanEvent (Sscc) WHERE Sscc IS NOT NULL;
END;
GO

-- =============================================================================
-- Viste di lettura (usate dall'API e dal tablet)
-- =============================================================================

-- Articolo con formato, conservazione e fattori di conversione risolti
CREATE OR ALTER VIEW mes.vw_Product
AS
SELECT
    p.ProductId, p.TenantId, p.PlantId,
    p.Gtin, p.Code, p.Description,
    f.Code  AS FormatCode,      f.Name  AS FormatName,
    st.Code AS StorageTypeCode, st.Name AS StorageTypeName,
    u.Code  AS BaseUomCode,
    p.NetWeightPieceG, p.ShelfLifeDays, p.IsActive,
    CAST(pc.Factor AS INT) AS PiecesPerCase,                     -- PZ -> CO
    CAST(cb.Factor AS INT) AS CasesPerPallet,                    -- CO -> BC
    CAST(pc.Factor * cb.Factor AS INT) AS PiecesPerPallet        -- PZ -> BC (derivato)
FROM mes.Product p
JOIN mes.ProductFormat f  ON f.FormatId = p.FormatId
JOIN mes.StorageType   st ON st.StorageTypeId = p.StorageTypeId
JOIN mes.UnitOfMeasure u  ON u.UomId = p.BaseUomId
LEFT JOIN mes.UomConversion pc
       JOIN mes.UnitOfMeasure pcFrom ON pcFrom.UomId = pc.FromUomId AND pcFrom.Code = N'PZ'
       JOIN mes.UnitOfMeasure pcTo   ON pcTo.UomId   = pc.ToUomId   AND pcTo.Code   = N'CO'
       ON pc.ProductId = p.ProductId AND pc.IsDeleted = 0
LEFT JOIN mes.UomConversion cb
       JOIN mes.UnitOfMeasure cbFrom ON cbFrom.UomId = cb.FromUomId AND cbFrom.Code = N'CO'
       JOIN mes.UnitOfMeasure cbTo   ON cbTo.UomId   = cb.ToUomId   AND cbTo.Code   = N'BC'
       ON cb.ProductId = p.ProductId AND cb.IsDeleted = 0
WHERE p.IsDeleted = 0;
GO

-- Bancale con articolo, stato e totale colli
CREATE OR ALTER VIEW mes.vw_Pallet
AS
SELECT
    b.PalletId, b.TenantId, b.PlantId, b.Sscc,
    b.ProductId, p.Gtin, p.Code AS ProductCode, p.Description AS ProductDescription,
    p.FormatName, p.StorageTypeCode, p.StorageTypeName, p.CasesPerPallet, p.PiecesPerCase,
    b.StatusId, s.Code AS StatusCode, s.Name AS StatusName, s.IsFinal AS StatusIsFinal,
    b.ExpectedCases,
    ISNULL(pl.TotalCases, 0) AS TotalCases,
    ISNULL(pl.LotCount, 0)   AS LotCount,
    b.NetWeightKg, b.Notes,
    b.CreatedAt, b.CreatedBy, b.UpdatedAt, b.UpdatedBy
FROM mes.Pallet b
JOIN mes.vw_Product  p ON p.ProductId = b.ProductId
JOIN mes.PalletStatus s ON s.StatusId = b.StatusId
LEFT JOIN (
    SELECT PalletId, SUM(Cases) AS TotalCases, COUNT(*) AS LotCount
    FROM mes.PalletLot WHERE IsDeleted = 0
    GROUP BY PalletId
) pl ON pl.PalletId = b.PalletId
WHERE b.IsDeleted = 0;
GO

-- Lotti presenti su ciascun bancale
CREATE OR ALTER VIEW mes.vw_PalletLot
AS
SELECT
    pl.PalletLotId, pl.TenantId, pl.PlantId, pl.PalletId,
    l.LotId, l.LotNumber, l.ProductionDate, l.BestBeforeDate, l.ExpiryDate,
    pl.Cases
FROM mes.PalletLot pl
JOIN mes.ProductionLot l ON l.LotId = pl.LotId
WHERE pl.IsDeleted = 0 AND l.IsDeleted = 0;
GO

-- Transizioni ammesse per ogni bancale a partire dal suo stato corrente:
-- il tablet mostra un pulsante per riga.
CREATE OR ALTER VIEW mes.vw_PalletAllowedTransition
AS
SELECT
    b.PalletId, b.TenantId, b.PlantId,
    t.TransitionId, t.ActionName, t.SortOrder,
    s.StatusId AS ToStatusId, s.Code AS ToStatusCode, s.Name AS ToStatusName
FROM mes.Pallet b
JOIN mes.PalletStatusTransition t
     ON t.TenantId = b.TenantId AND t.PlantId = b.PlantId
    AND t.FromStatusId = b.StatusId AND t.IsDeleted = 0
JOIN mes.PalletStatus s ON s.StatusId = t.ToStatusId AND s.IsDeleted = 0
WHERE b.IsDeleted = 0;
GO

-- Storico leggibile delle transizioni
CREATE OR ALTER VIEW mes.vw_PalletStatusLog
AS
SELECT
    g.LogId, g.TenantId, g.PlantId, g.PalletId, g.LoggedAt,
    sf.Code AS FromStatusCode, sf.Name AS FromStatusName,
    st.Code AS ToStatusCode,   st.Name AS ToStatusName,
    u.Code  AS UserCode, u.FullName AS UserFullName,
    g.Notes
FROM mes.PalletStatusLog g
LEFT JOIN mes.PalletStatus sf ON sf.StatusId = g.FromStatusId
JOIN mes.PalletStatus st ON st.StatusId = g.ToStatusId
JOIN mes.AppUser u ON u.UserId = g.UserId
WHERE g.IsDeleted = 0;
GO

-- =============================================================================
-- Soft delete: un DELETE su qualsiasi tabella dello schema mes diventa un
-- UPDATE di IsDeleted/DeletedAt. Il trigger e' generato per ogni tabella che
-- possiede la colonna IsDeleted, usando la sua chiave primaria.
-- =============================================================================
DECLARE @TableName SYSNAME, @PkColumn SYSNAME, @Sql NVARCHAR(MAX);
DECLARE tables_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT t.name, c.name
    FROM sys.tables t
    JOIN sys.columns col ON col.object_id = t.object_id AND col.name = N'IsDeleted'
    JOIN sys.indexes i   ON i.object_id = t.object_id AND i.is_primary_key = 1
    JOIN sys.index_columns ic ON ic.object_id = t.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c   ON c.object_id = t.object_id AND c.column_id = ic.column_id
    WHERE t.schema_id = SCHEMA_ID(N'mes');
OPEN tables_cur;
FETCH NEXT FROM tables_cur INTO @TableName, @PkColumn;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @Sql = N'CREATE OR ALTER TRIGGER mes.TR_' + @TableName + N'_SoftDelete ON mes.' + QUOTENAME(@TableName) + N'
INSTEAD OF DELETE
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE t SET IsDeleted = 1, DeletedAt = SYSDATETIME(), UpdatedAt = SYSDATETIME(), UpdatedBy = SUSER_SNAME()
    FROM mes.' + QUOTENAME(@TableName) + N' t
    JOIN deleted d ON d.' + QUOTENAME(@PkColumn) + N' = t.' + QUOTENAME(@PkColumn) + N';
END;';
    EXEC sys.sp_executesql @Sql;
    FETCH NEXT FROM tables_cur INTO @TableName, @PkColumn;
END;
CLOSE tables_cur;
DEALLOCATE tables_cur;
GO
