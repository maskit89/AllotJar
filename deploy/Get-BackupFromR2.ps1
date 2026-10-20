<#
.SYNOPSIS
    Download one encrypted backup from R2 and decrypt it to a plain .bak on this machine,
    ready for Migrate-FromBak.ps1. Run on the VPS, or on a new server after a loss (see
    docs/deployment/README.md > Restore test > If the VPS is lost).

.DESCRIPTION
    Reads through the rclone crypt remote (default r2crypt), so it needs the same rclone.conf
    as the nightly upload: an [r2] remote with a token that can read the bucket, and [r2crypt]
    with the backup password and salt. On a new machine create both first (an [r2] section
    with a new token, then Set-BackupEncryption.ps1 with the two secrets from the password
    manager). The wrong key fails loudly ("failed to authenticate decrypted block"); it never
    yields a wrong file.

    -Name latest (default) picks the newest <Database>_*.bak; or pass an exact file name as
    shown by `rclone lsf r2crypt:`. The download's size is checked against R2's answer.
    The result is a PLAIN copy of all user data: delete it after the restore.

.EXAMPLE
    .\Get-BackupFromR2.ps1 -Bucket allotjar
    .\Migrate-FromBak.ps1 -Environment staging -BakPath <the path this prints>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Bucket,
    [string]$Name        = 'latest',
    [string]$Database    = 'ZeroBudgetProd',
    [string]$OutDir      = 'C:\deploy\restore-test',
    [string]$Rclone      = 'C:\deploy\rclone\rclone.exe',
    [string]$RcloneConf  = 'C:\deploy\rclone.conf',
    [string]$Remote      = 'r2',
    [string]$Prefix      = 'db-backups-enc',
    [string]$CryptRemote = 'r2crypt'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force

if (-not (Test-Path -LiteralPath $Rclone))     { throw "rclone not found at $Rclone." }
if (-not (Test-Path -LiteralPath $RcloneConf)) { throw "rclone config not found at $RcloneConf." }
$problems = @(Get-BackupCryptRemoteProblems -ConfText (Get-Content -LiteralPath $RcloneConf -Raw) `
    -CryptRemote $CryptRemote -Remote $Remote -Bucket $Bucket -Prefix $Prefix)
if ($problems.Count -gt 0) { throw ($problems -join ' ') }

if ($Name -eq 'latest') {
    # Names end in a sortable yyyyMMdd_HHmmss stamp.
    $names = @(& $Rclone lsf --config $RcloneConf "${CryptRemote}:" --files-only --s3-no-check-bucket)
    if ($LASTEXITCODE -ne 0) { throw "Could not list ${CryptRemote}: (exit $LASTEXITCODE)." }
    $Name = $names | Where-Object { $_ -like "$($Database)_*.bak" } | Sort-Object | Select-Object -Last 1
    if (-not $Name) { throw "No $($Database)_*.bak in r2:${Bucket}/${Prefix}/." }
}
if ($Name -notmatch '^[\w.-]+\.bak$') { throw "Unexpected backup name '$Name'." }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir $Name
Write-Host "Downloading and decrypting ${CryptRemote}:$Name -> $out" -ForegroundColor Cyan
& $Rclone copyto --config $RcloneConf "${CryptRemote}:$Name" $out --s3-no-check-bucket
if ($LASTEXITCODE -ne 0) { throw "Download failed (exit $LASTEXITCODE). A 'failed to authenticate decrypted block' error means the password or salt in [$CryptRemote] is not the one the backup was made with." }

$ErrorActionPreference = 'Continue'
$sizeJson = & $Rclone size --config $RcloneConf "${CryptRemote}:$Name" --json 2>$null
$sizeExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($sizeExit -ne 0 -or -not $sizeJson) { throw 'Could not read the backup size back from R2 to check the download.' }
[void](Assert-R2SizeMatches -SizeJson ($sizeJson -join "`n") -LocalBytes (Get-Item -LiteralPath $out).Length -Name $Name)
if (Test-RcloneCryptFile -Path $out) { throw "$out is still encrypted." }

Write-Host "Decrypted and size-checked: $out" -ForegroundColor Green
Write-Host "Next: .\Migrate-FromBak.ps1 -Environment <staging|production> -BakPath `"$out`"   (then delete ${out}: it holds all user data in plain text)"
