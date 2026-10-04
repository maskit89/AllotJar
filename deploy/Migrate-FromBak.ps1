<#
.SYNOPSIS
    Restore a .bak over a chosen environment's database (RESTORE ... WITH REPLACE).
    Run ON THE VPS, in an elevated PowerShell. DESTRUCTIVE — overwrites the target DB.

.DESCRIPTION
    -Environment resolves the whole tuple (DB name, app pool, health port) so they
    cannot drift apart. Post-GA-cutover:
        staging     -> DB ZeroBudget,     pool ZeroBudget-Api,      health :5000
        production  -> DB ZeroBudgetProd, pool ZeroBudget-Prod-Api, health :5001
    The target DB already exists (created empty + EF-migrated by the first deploy).
    This RESTORE ... WITH REPLACE overwrites it with the .bak's data, keeping the target's
    own data/log files (a new target gets <Database>.mdf / <Database>_log.ldf in the
    instance's default folders), then re-grants the app-pool login (the restored DB carries
    the source's users, not the target's) and renames the logical files after the target.
    The .bak is checked first (RESTORE VERIFYONLY WITH CHECKSUM) while the API still runs.

    Restoring one environment's backup onto the OTHER environment on the same instance is
    supported and is how a backup is restore-tested: production's nightly .bak onto staging.
    The MOVE targets are planned by Get-RestoreFileMoves (ProvisionHelpers.psm1), which
    refuses any destination that is a live file of another database, so production's
    files can never be overwritten by a restore aimed at staging.

    Uses System.Data.SqlClient over Shared Memory -- no sqlcmd/sqlpackage needed.
    Restoring an older backup onto a newer SQL Server (dev -> SQL 2025) is supported.
    Prompts for the target DB name to confirm before overwriting; pass -Force to skip.

    Example:
        .\Migrate-FromBak.ps1 -Environment production -BakPath C:\deploy\incoming\migrate.bak
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$BakPath,
    [Parameter(Mandatory)] [ValidateSet('staging', 'production')] [string]$Environment,
    [string]$SqlInstance = '.\SQLEXPRESS',
    [string]$Database,
    [string]$ApiPool,
    [string]$AppLogin,
    [string]$HealthUrl,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Data
Import-Module WebAdministration
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# Resolve the environment tuple so DB / pool / health port cannot be mixed across envs.
$envMap = @{
    staging    = @{ Database = 'ZeroBudget';     ApiPool = 'ZeroBudget-Api';      HealthUrl = 'http://127.0.0.1:5000/health' }
    production = @{ Database = 'ZeroBudgetProd'; ApiPool = 'ZeroBudget-Prod-Api'; HealthUrl = 'http://127.0.0.1:5001/health' }
}
$tuple = $envMap[$Environment]
if (-not $Database)  { $Database  = $tuple.Database }
if (-not $ApiPool)   { $ApiPool   = $tuple.ApiPool }
if (-not $HealthUrl) { $HealthUrl = $tuple.HealthUrl }
if (-not $AppLogin)  { $AppLogin  = "IIS APPPOOL\$ApiPool" }

if (-not (Test-Path $BakPath)) { throw "Backup file not found: $BakPath" }

Info "Target [$Environment]: RESTORE [$Database] on $SqlInstance (pool $ApiPool, health $HealthUrl)"
Info "Source: $BakPath"
if (-not $Force) {
    Write-Host "This OVERWRITES [$Database] via WITH REPLACE and is destructive." -ForegroundColor Yellow
    $confirm = Read-Host "Type the target database name to proceed"
    if ($confirm -ne $Database) { throw "Confirmation '$confirm' did not match '$Database'. Aborted." }
}
$masterCs = "Server=$SqlInstance;Database=master;Integrated Security=True;TrustServerCertificate=True;Connect Timeout=30"

function Read-Sql([string]$query) {
    $cn = New-Object System.Data.SqlClient.SqlConnection; $cn.ConnectionString = $masterCs; $cn.Open()
    try {
        $cmd = $cn.CreateCommand(); $cmd.CommandText = $query; $cmd.CommandTimeout = 0
        $dt = New-Object System.Data.DataTable
        (New-Object System.Data.SqlClient.SqlDataAdapter $cmd).Fill($dt) | Out-Null
        return ,$dt   # comma-wrap: stop PowerShell unrolling the DataTable into DataRows
    } finally { $cn.Close() }
}

# --- 1. Check the backup before anything is stopped or overwritten -----------
$header = (Read-Sql "RESTORE HEADERONLY FROM DISK = N'$BakPath'").Rows[0]
Info ("Backup of [{0}] from {1}, taken {2} (finished {3}), SQL Server {4}.{5}" -f $header.DatabaseName, $header.ServerName, $header.BackupStartDate, $header.BackupFinishDate, $header.SoftwareVersionMajor, $header.SoftwareVersionMinor)
# Backup-Database.ps1 writes WITH CHECKSUM; a backup made without one cannot be checked WITH CHECKSUM.
$hasChecksums = [bool]$header.HasBackupChecksums
$checksum = if ($hasChecksums) { ', CHECKSUM' } else { '' }
Info ("Verifying the backup (RESTORE VERIFYONLY{0})" -f $(if ($hasChecksums) { ' WITH CHECKSUM' } else { '' }))
Read-Sql ("RESTORE VERIFYONLY FROM DISK = N'$BakPath'{0}" -f $(if ($hasChecksums) { ' WITH CHECKSUM' } else { '' })) | Out-Null
Info "Backup verified"

# --- 2. Plan where the restored files go --------------------------------------
# The .bak names the SOURCE database's files. On a shared instance those may be another live
# database's files (production's, when restoring onto staging), so the target keeps its own.
$dataDir = [string]((Read-Sql "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) AS p").Rows[0].p)
if ([string]::IsNullOrWhiteSpace($dataDir)) {
    $master = [string]((Read-Sql "SELECT physical_name FROM sys.master_files WHERE database_id=1 AND type=0").Rows[0].physical_name)
    $dataDir = (Split-Path $master -Parent) + '\'
}
$logDir = [string]((Read-Sql "SELECT CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)) AS p").Rows[0].p)
if ([string]::IsNullOrWhiteSpace($logDir)) { $logDir = $dataDir }

$files   = Read-Sql "RESTORE FILELISTONLY FROM DISK = N'$BakPath'"
$ownFiles   = Read-Sql "SELECT type_desc, physical_name FROM sys.master_files WHERE database_id = DB_ID(N'$Database') ORDER BY type, file_id"
$otherFiles = Read-Sql "SELECT DB_NAME(database_id) AS db, physical_name FROM sys.master_files WHERE database_id <> ISNULL(DB_ID(N'$Database'), 0)"
$plan = Get-RestoreFileMoves -Database $Database -BackupFiles @($files.Rows) -TargetFiles @($ownFiles.Rows) -OtherFiles @($otherFiles.Rows) -DataDir $dataDir -LogDir $logDir
$moves = $plan.Moves
if ($plan.ReusedTargetFiles) { Info "Restoring onto [$Database]'s own files:" } else { Info "Restoring into new files for [$Database]:" }
$plan.Targets | ForEach-Object { Info "    $_" }

# --- 2b. Stop the API so it releases its DB connections -----------------------
Info "Stopping app pool $ApiPool"
if ((Get-WebAppPoolState $ApiPool -ErrorAction SilentlyContinue).Value -eq 'Started') {
    Stop-WebAppPool $ApiPool; Start-Sleep -Seconds 3
}

# --- 3. Single connection: drop connections, restore, rename files, re-grant --
$grant = @"
USE [$Database];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$AppLogin')
    CREATE USER [$AppLogin] FOR LOGIN [$AppLogin];
ALTER ROLE [db_owner] ADD MEMBER [$AppLogin];
"@

# The restored database keeps the source's logical file names (ZeroBudgetProd, ...); rename them
# after the target so RESTORE FILELISTONLY of this database's own backups names this database.
$renames = @()
$bakData = @($files.Rows | Where-Object { [string]$_.Type -ne 'L' }); $bakLogs = @($files.Rows | Where-Object { [string]$_.Type -eq 'L' })
if ($bakData.Count -ge 1 -and [string]$bakData[0].LogicalName -ne $Database)          { $renames += "ALTER DATABASE [$Database] MODIFY FILE (NAME = N'$($bakData[0].LogicalName)', NEWNAME = N'$Database')" }
if ($bakLogs.Count -ge 1 -and [string]$bakLogs[0].LogicalName -ne "${Database}_log") { $renames += "ALTER DATABASE [$Database] MODIFY FILE (NAME = N'$($bakLogs[0].LogicalName)', NEWNAME = N'${Database}_log')" }

$steps = @(
    "IF DB_ID('$Database') IS NOT NULL ALTER DATABASE [$Database] SET SINGLE_USER WITH ROLLBACK IMMEDIATE",
    "RESTORE DATABASE [$Database] FROM DISK = N'$BakPath' WITH REPLACE, RECOVERY$checksum, $($moves -join ', ')",
    "ALTER DATABASE [$Database] SET MULTI_USER"
) + $renames + @($grant)

$cn = New-Object System.Data.SqlClient.SqlConnection; $cn.ConnectionString = $masterCs; $cn.Open()
try {
    foreach ($s in $steps) {
        $cmd = $cn.CreateCommand(); $cmd.CommandText = $s; $cmd.CommandTimeout = 0
        Info ("Running: " + ($s -split "`n")[0].Trim())
        [void]$cmd.ExecuteNonQuery()
    }
} finally { $cn.Close() }

# --- 4. Restart the API and verify ------------------------------------------
Info "Starting app pool $ApiPool"
Start-WebAppPool $ApiPool

$rows = [int]((Read-Sql "SELECT COUNT(*) AS c FROM [$Database].dbo.Transactions").Rows[0].c)
Info "Transactions in restored DB: $rows"

Info "Health-checking $HealthUrl"
$ok = $false
for ($i = 1; $i -le 20; $i++) {
    try { if ((Invoke-WebRequest $HealthUrl -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { $ok = $true; break } }
    catch { Start-Sleep -Seconds 3 }
}
if (-not $ok) { throw "Health check FAILED at $HealthUrl after restore." }

Write-Host ("Restore complete: [{0}] now holds the backup of [{1}] taken {2}, and the app is serving it." -f $Database, $header.DatabaseName, $header.BackupStartDate) -ForegroundColor Green
