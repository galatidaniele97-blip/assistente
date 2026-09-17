-- =============================================================================
-- MES Pizzami - 00: creazione database
-- Compatibile con SQL Server 2017+ (Express, Standard, Enterprise, Developer).
-- Idempotente: si puo' rieseguire senza effetti collaterali.
-- =============================================================================
IF DB_ID(N'MesPizzami') IS NULL
BEGIN
    CREATE DATABASE MesPizzami;
END;
GO
ALTER DATABASE MesPizzami SET RECOVERY SIMPLE;   -- ambiente demo; in produzione valutare FULL + backup log
GO
