<#
.SYNOPSIS
    Import a .bacpac (produced by Export-DevData.ps1) into the production SQL
    Server. Run ON THE VPS, as a one-time data seed.

.DESCRIPTION
    BACPAC import CREATES the target database, so it must NOT already exist.
    Order of operations for a data-migrated install:
        1. Import-ToServer.ps1   (creates ZeroBudgetStaging with all data)
        2. Setup-Database.sql     (adds the app-pool login/grant on the new DB)
        3. Deploy (API auto-migrate finds nothing pending - history is current)

    Requires the free sqlpackage tool:
        dotnet tool install -g microsoft.sqlpackage
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$BacpacPath,
    [string]$Server   = '.\SQLEXPRESS',
    [string]$Database = 'ZeroBudgetStaging'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command sqlpackage -ErrorAction SilentlyContinue)) {
    throw "sqlpackage not found. Install it with: dotnet tool install -g microsoft.sqlpackage"
}
if (-not (Test-Path $BacpacPath)) { throw "BACPAC not found: $BacpacPath" }

$target = "Server=$Server;Database=$Database;Trusted_Connection=True;Encrypt=True;TrustServerCertificate=True"

Write-Host "Importing $BacpacPath -> $Server/$Database ..." -ForegroundColor Cyan
Write-Host "(The target database must not already exist.)" -ForegroundColor Yellow
sqlpackage /Action:Import /SourceFile:"$BacpacPath" /TargetConnectionString:"$target"

Write-Host "Import complete. Now run Setup-Database.sql to grant the app-pool login." -ForegroundColor Green
