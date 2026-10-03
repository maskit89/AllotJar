<#
.SYNOPSIS
    Copy a verified database backup off-host to Cloudflare R2 using rclone, then
    verify the uploaded object's size. Immutability (ransomware/host-compromise
    resistance) comes from the R2 bucket's Object Lock retention, not from here.

.DESCRIPTION
    Uploads a specific -File, or the newest <Database>_*.bak in -BackupDir, to
    r2:<Bucket>/<Prefix>/<name> via `rclone copyto`, then checks the remote object's
    byte count matches the local file and fails loudly on mismatch.

    NO SECRETS live in this script or the repo. The R2 access key / secret / endpoint
    live in an rclone config file OUTSIDE the repo (default C:\deploy\rclone.conf),
    under an [r2] remote of type=s3, provider=Cloudflare. Lock that file down to
    SYSTEM + Administrators (icacls) since it holds the access key in plaintext.

    Chained automatically after RESTORE VERIFYONLY by Backup-Database.ps1 when its
    -R2Bucket is set; can also be run by hand.

.EXAMPLE
    .\Upload-BackupToR2.ps1 -Bucket allotjar -Database ZeroBudgetProd
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Bucket,
    [string]$Database   = 'ZeroBudgetProd',
    [string]$BackupDir  = 'C:\deploy\backups',
    [string]$File,                                   # specific .bak; default = newest for -Database
    [string]$Rclone     = 'C:\deploy\rclone\rclone.exe',
    [string]$RcloneConf = 'C:\deploy\rclone.conf',
    [string]$Remote     = 'r2',
    [string]$Prefix     = 'db-backups'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force

if (-not (Test-Path $Rclone)) {
    throw "rclone not found at $Rclone. Install it and/or pass -Rclone (see docs/deployment/README.md > Off-host backups)."
}
if (-not (Test-Path $RcloneConf)) {
    throw "rclone config not found at $RcloneConf. Create the '$Remote' remote there (see docs/deployment/README.md > Off-host backups)."
}

# Resolve the file: explicit -File, else the newest <Database>_*.bak under -BackupDir.
if (-not $File) {
    $newest = Get-ChildItem -Path (Join-Path $BackupDir "$($Database)_*.bak") -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $newest) { throw "No $($Database)_*.bak found in $BackupDir to upload." }
    $File = $newest.FullName
}
if (-not (Test-Path $File)) { throw "Backup file not found: $File" }

$name  = Split-Path $File -Leaf
$dest  = "${Remote}:${Bucket}/${Prefix}/${name}"
$local = (Get-Item $File).Length

Write-Host "Uploading $File ($local bytes) -> $dest" -ForegroundColor Cyan
# --s3-no-check-bucket: a bucket-scoped token can't HeadBucket, so skip that probe.
& $Rclone copyto --config $RcloneConf $File $dest --s3-no-check-bucket
if ($LASTEXITCODE -ne 0) { throw "rclone upload failed (exit $LASTEXITCODE)." }

# Verify the remote object exists and its size matches the local file. rclone may print
# notices on stderr; under Windows PowerShell 5.1 a redirected native stderr line becomes
# a terminating error while $ErrorActionPreference is Stop, so relax it for this one call
# and judge by the exit code instead.
$ErrorActionPreference = 'Continue'
$sizeJson = & $Rclone size --config $RcloneConf $dest --json 2>$null
$sizeExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($sizeExit -ne 0 -or -not $sizeJson) { throw "Post-upload verify failed: could not read '$dest' back from R2." }
[void](Assert-R2SizeMatches -SizeJson ($sizeJson -join "`n") -LocalBytes $local -Name $name)

Write-Host "Off-host copy verified in R2: $dest ($local bytes)." -ForegroundColor Green
