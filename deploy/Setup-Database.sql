/*
    ZeroBudget - database + app-pool login bootstrap (idempotent).

    Run AFTER installing SQL Server Express, e.g.:
        sqlcmd -S .\SQLEXPRESS -E -i Setup-Database.sql

    Grants the STAGING app-pool identity (IIS APPPOOL\ZeroBudget-Staging-Api) db_owner
    on the ZeroBudgetStaging database, so the API can connect with Trusted_Connection
    (no stored password) AND apply EF Core migrations (DDL) on startup. The production
    database (ZeroBudgetProd, pool ZeroBudget-Prod-Api) is created by
    Provision-Production.ps1.

    NOTE on data migration: if you are restoring household data from the dev
    machine, run Import-ToServer.ps1 FIRST (the BACPAC import creates the database),
    then run this script - the CREATE DATABASE below is skipped if it already exists,
    and only the login/grant is (re)applied.
*/

IF DB_ID(N'ZeroBudgetStaging') IS NULL
BEGIN
    PRINT 'Creating database ZeroBudgetStaging...';
    CREATE DATABASE [ZeroBudgetStaging];
END
ELSE
    PRINT 'Database ZeroBudgetStaging already exists - leaving data intact.';
GO

USE [master];
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'IIS APPPOOL\ZeroBudget-Staging-Api')
BEGIN
    PRINT 'Creating login for IIS APPPOOL\ZeroBudget-Staging-Api...';
    CREATE LOGIN [IIS APPPOOL\ZeroBudget-Staging-Api] FROM WINDOWS;
END
GO

USE [ZeroBudgetStaging];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'IIS APPPOOL\ZeroBudget-Staging-Api')
BEGIN
    PRINT 'Creating database user for the app-pool login...';
    CREATE USER [IIS APPPOOL\ZeroBudget-Staging-Api] FOR LOGIN [IIS APPPOOL\ZeroBudget-Staging-Api];
END
GO

-- db_owner is required because EF Core migrations run DDL under this identity.
ALTER ROLE [db_owner] ADD MEMBER [IIS APPPOOL\ZeroBudget-Staging-Api];
GO

PRINT 'Setup-Database.sql complete.';
GO
