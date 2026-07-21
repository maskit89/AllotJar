<#
.SYNOPSIS
    Timestamped backup of a target database with retention pruning. Pass -Database
    explicitly (staging = ZeroBudget, production = ZeroBudgetProd) — there is no
    default, so a by-hand run can't back up the wrong environment silently.
    Intended to run as a daily Scheduled Task (see Register-BackupTask.ps1),
    but can also be run by hand before a risky deploy.

.DESCRIPTION
    Writes a fresh <Database>_<timestamp>.bak under -BackupDir, verifies it with
    RESTORE VERIFYONLY, then deletes backups older than -RetentionDays. Uses
    Windows auth (-E), so the calling identity needs BACKUP rights on the
    instance (NT AUTHORITY\SYSTEM is a sysadmin by default on SQL Server).
#>
[CmdletBinding()]
param(
    [string]$Server        = '.\SQLEXPRESS',
    [Parameter(Mandatory = $true)][string]$Database,
    [string]$BackupDir     = 'C:\deploy\backups',
    [int]   $RetentionDays = 14
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$file  = Join-Path $BackupDir "$($Database)_$stamp.bak"

# WITH CHECKSUM verifies page integrity. COMPRESSION is intentionally omitted -
# SQL Server Express does not support backup compression. Run via System.Data.SqlClient
# (shared memory) so no sqlcmd tool is required on the server.
Write-Host "Backing up [$Database] -> $file" -ForegroundColor Cyan
Add-Type -AssemblyName System.Data
$cn = New-Object System.Data.SqlClient.SqlConnection
$cn.ConnectionString = "Server=$Server;Database=master;Integrated Security=True;TrustServerCertificate=True"
$cn.Open()
try {
    foreach ($q in @(
        "BACKUP DATABASE [$Database] TO DISK = N'$file' WITH CHECKSUM, STATS = 10;",
        "RESTORE VERIFYONLY FROM DISK = N'$file' WITH CHECKSUM;"
    )) {
        $cmd = $cn.CreateCommand(); $cmd.CommandText = $q; $cmd.CommandTimeout = 0
        [void]$cmd.ExecuteNonQuery()
    }
} finally { $cn.Close() }

# Prune old backups.
$cutoff = (Get-Date).AddDays(-$RetentionDays)
Get-ChildItem -Path $BackupDir -Filter "$($Database)_*.bak" |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
        Write-Host "Pruning $($_.Name)"
        Remove-Item $_.FullName -Force
    }

Write-Host "Backup complete." -ForegroundColor Green
