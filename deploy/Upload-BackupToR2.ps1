<#
.SYNOPSIS
    Encrypt a verified database backup and copy it off-host to Cloudflare R2 using
    rclone, then verify the uploaded object's size. Old copies expire through the R2
    bucket's lifecycle rule (docs/deployment/README.md > Off-host backups), not from here.

.DESCRIPTION
    Uploads a specific -File, or the newest <Database>_*.bak in -BackupDir, through the
    rclone crypt remote -CryptRemote (default r2crypt) to r2:<Bucket>/<Prefix>/<name>.bin
    via `rclone copyto`, then checks the remote object's decrypted byte count matches the
    local file and fails loudly on mismatch. rclone crypt is authenticated encryption
    (XSalsa20-Poly1305), applied before anything leaves the VPS; the file names stay
    readable (filename_encryption = off) so the newest backup can be found.

    The upload REFUSES to run when rclone.conf has no matching crypt remote: it never falls
    back to uploading the plain .bak. Create the remote once with Set-BackupEncryption.ps1.

    NO SECRETS live in this script or the repo. The R2 access key / secret / endpoint
    live in an rclone config file OUTSIDE the repo (default C:\deploy\rclone.conf),
    under an [r2] remote of type=s3, provider=Cloudflare, next to the [r2crypt] remote
    that holds the (obscured, not secret-safe) encryption key. Lock that file down to
    SYSTEM + Administrators (icacls). The key's real home is the owner's password manager:
    without it no backup in R2 can be read, even by the owner.

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
    [string]$Prefix     = 'db-backups-enc',          # the crypt remote's target folder in the bucket
    [string]$CryptRemote = 'r2crypt'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force

if (-not (Test-Path $Rclone)) {
    throw "rclone not found at $Rclone. Install it and/or pass -Rclone (see docs/deployment/README.md > Off-host backups)."
}
if (-not (Test-Path $RcloneConf)) {
    throw "rclone config not found at $RcloneConf. Create the '$Remote' remote there (see docs/deployment/README.md > Off-host backups)."
}

# Fail closed: only ever upload through a crypt remote that points at the encrypted folder.
$problems = @(Get-BackupCryptRemoteProblems -ConfText (Get-Content -LiteralPath $RcloneConf -Raw) `
    -CryptRemote $CryptRemote -Remote $Remote -Bucket $Bucket -Prefix $Prefix)
if ($problems.Count -gt 0) { throw ("Refusing to upload: " + ($problems -join ' ')) }

# Resolve the file: explicit -File, else the newest <Database>_*.bak under -BackupDir.
if (-not $File) {
    $newest = Get-ChildItem -Path (Join-Path $BackupDir "$($Database)_*.bak") -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $newest) { throw "No $($Database)_*.bak found in $BackupDir to upload." }
    $File = $newest.FullName
}
if (-not (Test-Path $File)) { throw "Backup file not found: $File" }

$name  = Split-Path $File -Leaf
$dest  = "${CryptRemote}:${name}"
$local = (Get-Item $File).Length

Write-Host "Encrypting and uploading $File ($local bytes) -> $dest (r2:${Bucket}/${Prefix}/${name}.bin)" -ForegroundColor Cyan
# --s3-no-check-bucket: a bucket-scoped token can't HeadBucket, so skip that probe.
& $Rclone copyto --config $RcloneConf $File $dest --s3-no-check-bucket
if ($LASTEXITCODE -ne 0) { throw "rclone upload failed (exit $LASTEXITCODE)." }

# Verify the remote object exists and its (decrypted) size matches the local file. rclone may print
# notices on stderr; under Windows PowerShell 5.1 a redirected native stderr line becomes
# a terminating error while $ErrorActionPreference is Stop, so relax it for this one call
# and judge by the exit code instead.
$ErrorActionPreference = 'Continue'
$sizeJson = & $Rclone size --config $RcloneConf $dest --json 2>$null
$sizeExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($sizeExit -ne 0 -or -not $sizeJson) { throw "Post-upload verify failed: could not read '$dest' back from R2." }
[void](Assert-R2SizeMatches -SizeJson ($sizeJson -join "`n") -LocalBytes $local -Name $name)

Write-Host "Encrypted off-host copy verified in R2: $dest ($local bytes)." -ForegroundColor Green
