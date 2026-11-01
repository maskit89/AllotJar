/*
    AllotJar - database + app-pool login bootstrap (idempotent).

    Run AFTER installing SQL Server Express, e.g.:
        sqlcmd -S .\SQLEXPRESS -E -i Setup-Database.sql

    Grants the STAGING app-pool identity (IIS APPPOOL\AllotJar-Staging-Api) db_owner
    on the AllotJarStaging database, so the API can connect with Trusted_Connection
    (no stored password) AND apply EF Core migrations (DDL) on startup. The production
    database (AllotJarProd, pool AllotJar-Prod-Api) is created by
    Provision-Production.ps1.

    NOTE on data migration: if you are restoring household data from the dev
    machine, run Import-ToServer.ps1 FIRST (the BACPAC import creates the database),
    then run this script - the CREATE DATABASE below is skipped if it already exists,
    and only the login/grant is (re)applied.
*/

IF DB_ID(N'AllotJarStaging') IS NULL
BEGIN
    PRINT 'Creating database AllotJarStaging...';
    CREATE DATABASE [AllotJarStaging];
END
ELSE
    PRINT 'Database AllotJarStaging already exists - leaving data intact.';
GO

USE [master];
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'IIS APPPOOL\AllotJar-Staging-Api')
BEGIN
    PRINT 'Creating login for IIS APPPOOL\AllotJar-Staging-Api...';
    CREATE LOGIN [IIS APPPOOL\AllotJar-Staging-Api] FROM WINDOWS;
END
GO

USE [AllotJarStaging];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'IIS APPPOOL\AllotJar-Staging-Api')
BEGIN
    PRINT 'Creating database user for the app-pool login...';
    CREATE USER [IIS APPPOOL\AllotJar-Staging-Api] FOR LOGIN [IIS APPPOOL\AllotJar-Staging-Api];
END
GO

-- db_owner is required because EF Core migrations run DDL under this identity.
ALTER ROLE [db_owner] ADD MEMBER [IIS APPPOOL\AllotJar-Staging-Api];
GO

PRINT 'Setup-Database.sql complete.';
GO
