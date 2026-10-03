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
    instance. NT AUTHORITY\SYSTEM is NOT a sysadmin by default on SQL Server 2012+;
    Register-BackupTask.ps1 grants it a login in the sysadmin role.

    When -R2Bucket is set, the verified backup is also copied off-host to Cloudflare
    R2 (via Upload-BackupToR2.ps1 next to this script) so a disk/host/ransomware event
    can't take out the data and every recovery point at once. Only verified backups
    are shipped, and the R2 upload failing fails the whole run.
#>
[CmdletBinding()]
param(
    [string]$Server        = '.\SQLEXPRESS',
    [Parameter(Mandatory = $true)][string]$Database,
    [string]$BackupDir     = 'C:\deploy\backups',
    [int]   $RetentionDays = 14,

    # Off-host copy to Cloudflare R2. Optional: when -R2Bucket is empty the script
    # behaves exactly as before (so the staging task is unaffected).
    [string]$R2Bucket,
    [string]$Rclone        = 'C:\deploy\rclone\rclone.exe',
    [string]$RcloneConf    = 'C:\deploy\rclone.conf',
    [string]$R2Remote      = 'r2',
    [string]$R2Prefix      = 'db-backups',

    # Optional dead-man's-switch URL (healthchecks.io style): GET after a successful run,
    # GET <url>/fail after a failed one. Never makes the backup itself fail.
    [string]$PingUrl
)

$ErrorActionPreference = 'Stop'

# A scheduled task that fails is silent: nobody looks at Task Scheduler. Every outcome goes to
# the Windows Application event log (source 'AllotJar Backup', Error on failure) and, when
# -PingUrl is set, to that URL. Reporting problems never change the backup's own result.
function Send-BackupOutcome {
    param([bool]$Ok, [string]$Message)
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists('AllotJar Backup')) {
            New-EventLog -LogName Application -Source 'AllotJar Backup'
        }
        Write-EventLog -LogName Application -Source 'AllotJar Backup' -EntryType $(if ($Ok) { 'Information' } else { 'Error' }) `
            -EventId $(if ($Ok) { 4000 } else { 4001 }) -Message $Message
    } catch { Write-Warning "Could not write the event log entry: $_" }
    if ($PingUrl) {
        try { [void](Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $(if ($Ok) { $PingUrl } else { $PingUrl.TrimEnd('/') + '/fail' })) }
        catch { Write-Warning "Could not reach -PingUrl: $_" }
    }
}

try {
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

# Ship the just-verified backup off-host BEFORE pruning, so a failure here can't
# leave us having deleted an old copy without a new remote one. Only runs when
# -R2Bucket is set.
if ($R2Bucket) {
    $uploader = Join-Path $PSScriptRoot 'Upload-BackupToR2.ps1'
    if (-not (Test-Path $uploader)) {
        throw "Upload-BackupToR2.ps1 not found next to this script ($uploader) - needed for -R2Bucket."
    }
    & $uploader -File $file -Bucket $R2Bucket -Database $Database `
        -Rclone $Rclone -RcloneConf $RcloneConf -Remote $R2Remote -Prefix $R2Prefix
}

# Prune old LOCAL backups (remote retention is enforced by the R2 lifecycle/Object Lock).
$cutoff = (Get-Date).AddDays(-$RetentionDays)
Get-ChildItem -Path $BackupDir -Filter "$($Database)_*.bak" |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
        Write-Host "Pruning $($_.Name)"
        Remove-Item $_.FullName -Force
    }

Write-Host "Backup complete." -ForegroundColor Green
Send-BackupOutcome -Ok $true -Message "Backup of [$Database] completed and verified: $file"
} catch {
    Send-BackupOutcome -Ok $false -Message "Backup of [$Database] FAILED: $($_.Exception.Message)"
    throw
}
