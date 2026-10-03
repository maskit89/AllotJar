<#
.SYNOPSIS
    Export the local dev database (LocalDB) to a portable .bacpac so the real
    household data can be moved onto the production SQL Server. Run on THIS
    (developer) machine.

.DESCRIPTION
    A BACPAC captures schema + data + the __EFMigrationsHistory table, so the
    imported production DB is an exact copy of dev and the API's startup migrate
    finds nothing pending.

    Requires the free sqlpackage tool:
        dotnet tool install -g microsoft.sqlpackage

    Then copy the resulting .bacpac to the VPS (scp / RDP) and run
    Import-ToServer.ps1 there. The .bacpac is gitignored - never commit it.
#>
[CmdletBinding()]
param(
    [string]$Source  = 'Server=(localdb)\MSSQLLocalDB;Database=ZeroBudget;Trusted_Connection=True;TrustServerCertificate=True',
    [string]$OutFile   # default: ZeroBudget.bacpac beside this script (set below)
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty inside a param() default under `powershell -File` on Windows PowerShell 5.1.
if (-not $OutFile) { $OutFile = Join-Path $PSScriptRoot 'ZeroBudget.bacpac' }

if (-not (Get-Command sqlpackage -ErrorAction SilentlyContinue)) {
    throw "sqlpackage not found. Install it with: dotnet tool install -g microsoft.sqlpackage"
}

if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

Write-Host "Exporting $Source -> $OutFile ..." -ForegroundColor Cyan
sqlpackage /Action:Export /SourceConnectionString:"$Source" /TargetFile:"$OutFile"

Write-Host "Done. Copy this file to the VPS and run Import-ToServer.ps1:" -ForegroundColor Green
Write-Host "  $OutFile"
