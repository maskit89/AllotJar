<#
.SYNOPSIS
    Register a daily Scheduled Task that runs Backup-Database.ps1 as SYSTEM.
    Run once on the VPS AFTER SQL Server Express is installed. Idempotent (-Force).

.DESCRIPTION
    Copies Backup-Database.ps1 to a stable location (so the deploy's release-folder
    churn can't break the task), then schedules it daily. The defaults are the staging
    task (local-only); Provision-Production.ps1 registers the production task
    (ZeroBudget-Prod-DbBackup, database ZeroBudgetProd, shipped to R2). Re-run this script to change
    the schedule/retention or to pick up an updated backup script.
#>
[CmdletBinding()]
param(
    [string]$BackupScript,    # default: Backup-Database.ps1 beside this script (set below)
    [string]$UploadScript,    # default: Upload-BackupToR2.ps1 beside this script (set below)
    [string]$InstallDir    = 'C:\deploy',
    [string]$Time          = '02:30',
    [string]$Server        = '.\SQLEXPRESS',
    [string]$Database      = 'ZeroBudgetStaging',
    [string]$BackupDir     = 'C:\deploy\backups',
    [int]   $RetentionDays = 14,
    [string]$TaskName      = 'ZeroBudget-Staging-DbBackup',

    # Set -R2Bucket to have the daily task also ship each verified backup off-host to
    # Cloudflare R2. Leave empty for a local-only backup task (e.g. staging).
    [string]$R2Bucket,
    [string]$Rclone        = 'C:\deploy\rclone\rclone.exe',
    [string]$RcloneConf    = 'C:\deploy\rclone.conf',
    [string]$R2Remote      = 'r2',
    [string]$R2Prefix      = 'db-backups',

    # The account the task runs as must be able to take backups. By default this script
    # gives NT AUTHORITY\SYSTEM the SQL rights to back up -Database (idempotent; needs the
    # CALLING identity to be a sysadmin, as the installing admin is). Pass -SkipSqlLogin
    # if you manage SQL permissions yourself.
    [switch]$SkipSqlLogin,

    # Optional dead-man's-switch URL (e.g. a healthchecks.io check): the task pings it after
    # every successful run and pings <url>/fail on failure, so a night that never runs at all
    # is noticed too. Leave empty for no external ping (Event Log entries are always written).
    [string]$PingUrl
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty inside a param() default under `powershell -File` on Windows PowerShell 5.1
# ("Cannot bind argument to parameter 'Path' because it is an empty string"), so the defaults are
# resolved here, where it is always set.
if (-not $BackupScript) { $BackupScript = Join-Path $PSScriptRoot 'Backup-Database.ps1' }
if (-not $UploadScript) { $UploadScript = Join-Path $PSScriptRoot 'Upload-BackupToR2.ps1' }
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force

if (-not (Test-Path $BackupScript)) { throw "Backup script not found: $BackupScript" }
New-Item -ItemType Directory -Force -Path $InstallDir, $BackupDir | Out-Null

# Stable copies, decoupled from C:\deploy\release-* which is wiped on every deploy.
$target = Join-Path $InstallDir 'Backup-Database.ps1'
Copy-Item $BackupScript $target -Force
# The upload script imports the helpers module beside it; keep that copy next to the task's scripts.
Copy-Item (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') (Join-Path $InstallDir 'ProvisionHelpers.psm1') -Force
if (Test-Path $UploadScript) {
    Copy-Item $UploadScript (Join-Path $InstallDir 'Upload-BackupToR2.ps1') -Force
} elseif ($R2Bucket) {
    # An R2-enabled task without its upload script would fail every night — refuse now,
    # loudly, rather than discovering it after the host is lost.
    throw "R2 upload requested (-R2Bucket $R2Bucket) but the upload script is missing: $UploadScript"
}

$argLine = New-BackupTaskArgumentLine -ScriptPath $target -Server $Server -Database $Database `
    -BackupDir $BackupDir -RetentionDays $RetentionDays `
    -R2Bucket $R2Bucket -Rclone $Rclone -RcloneConf $RcloneConf -R2Remote $R2Remote -R2Prefix $R2Prefix

if ($PingUrl) { $argLine += ' -PingUrl "{0}"' -f $PingUrl }

if (-not $SkipSqlLogin) {
    # BACKUP runs under the task's account, which on SQL Server 2012+ has no backup rights by
    # default (its login exists, empty). Two batches: server level in master, then the
    # backup-operator role inside the target database.
    Add-Type -AssemblyName System.Data
    foreach ($batch in @(@('master', (Get-BackupLoginSql)), @($Database, (Get-BackupDbUserSql)))) {
        $cn = New-Object System.Data.SqlClient.SqlConnection
        $cn.ConnectionString = "Server=$Server;Database=$($batch[0]);Integrated Security=True;TrustServerCertificate=True"
        $cn.Open()
        try {
            $cmd = $cn.CreateCommand(); $cmd.CommandText = $batch[1]
            [void]$cmd.ExecuteNonQuery()
        } finally { $cn.Close() }
    }
    Write-Host "SQL rights: NT AUTHORITY\SYSTEM can back up [$Database] on $Server (db_backupoperator + CREATE ANY DATABASE)." -ForegroundColor Green
}

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
$trigger   = New-ScheduledTaskTrigger -Daily -At $Time
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

# Read the task BACK and, when R2 was requested, require the R2 arguments on the stored
# action — the assertion is about what the scheduler will actually run.
$stored = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$storedArgs = ($stored.Actions | Select-Object -First 1).Arguments
if ($R2Bucket -and -not (Get-R2BucketFromArgumentLine -ArgumentLine $storedArgs)) {
    throw "Task '$TaskName' was registered WITHOUT the R2 arguments: $storedArgs"
}

Write-Host "Scheduled task '$TaskName' registered: daily at $Time as SYSTEM." -ForegroundColor Green
if ($R2Bucket) {
    Write-Host "Off-host copy: each verified backup ships to R2 bucket '$R2Bucket'." -ForegroundColor Green
}
Write-Host "Backups -> $BackupDir (retain $RetentionDays days). Test it now with:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
