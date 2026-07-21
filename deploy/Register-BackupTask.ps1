<#
.SYNOPSIS
    Register a daily Scheduled Task that runs Backup-Database.ps1 as SYSTEM.
    Run once on the VPS AFTER SQL Server Express is installed. Idempotent (-Force).

.DESCRIPTION
    Copies Backup-Database.ps1 to a stable location (so the deploy/staging churn
    can't break the task), then schedules it daily. Re-run this script to change
    the schedule/retention or to pick up an updated backup script.
#>
[CmdletBinding()]
param(
    [string]$BackupScript  = (Join-Path $PSScriptRoot 'Backup-Database.ps1'),
    [string]$UploadScript  = (Join-Path $PSScriptRoot 'Upload-BackupToR2.ps1'),
    [string]$InstallDir    = 'C:\deploy',
    [string]$Time          = '02:30',
    [string]$Server        = '.\SQLEXPRESS',
    [string]$Database      = 'ZeroBudget',
    [string]$BackupDir     = 'C:\deploy\backups',
    [int]   $RetentionDays = 14,
    [string]$TaskName      = 'ZeroBudget-DbBackup',

    # Set -R2Bucket to have the daily task also ship each verified backup off-host to
    # Cloudflare R2. Leave empty for a local-only backup task (e.g. staging).
    [string]$R2Bucket,
    [string]$Rclone        = 'C:\deploy\rclone\rclone.exe',
    [string]$RcloneConf    = 'C:\deploy\rclone.conf',
    [string]$R2Remote      = 'r2',
    [string]$R2Prefix      = 'db-backups'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $BackupScript)) { throw "Backup script not found: $BackupScript" }
New-Item -ItemType Directory -Force -Path $InstallDir, $BackupDir | Out-Null

# Stable copies, decoupled from C:\deploy\staging which is wiped on every deploy.
$target = Join-Path $InstallDir 'Backup-Database.ps1'
Copy-Item $BackupScript $target -Force
if (Test-Path $UploadScript) {
    Copy-Item $UploadScript (Join-Path $InstallDir 'Upload-BackupToR2.ps1') -Force
}

$argLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Server "{1}" -Database "{2}" -BackupDir "{3}" -RetentionDays {4}' -f `
    $target, $Server, $Database, $BackupDir, $RetentionDays
if ($R2Bucket) {
    $argLine += ' -R2Bucket "{0}" -Rclone "{1}" -RcloneConf "{2}" -R2Remote "{3}" -R2Prefix "{4}"' -f `
        $R2Bucket, $Rclone, $RcloneConf, $R2Remote, $R2Prefix
}

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
$trigger   = New-ScheduledTaskTrigger -Daily -At $Time
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Scheduled task '$TaskName' registered: daily at $Time as SYSTEM." -ForegroundColor Green
Write-Host "Backups -> $BackupDir (retain $RetentionDays days). Test it now with:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
