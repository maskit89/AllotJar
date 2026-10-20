<#
.SYNOPSIS
    One-time setup of backup encryption on the VPS: adds an rclone "crypt" remote (r2crypt)
    to rclone.conf, then proves it works against R2 with a throwaway file. Run in an elevated
    Windows PowerShell console (not the ISE) on the VPS.

.DESCRIPTION
    Upload-BackupToR2.ps1 sends every backup through this remote, so each .bak is encrypted
    on the VPS (rclone crypt: XSalsa20-Poly1305, authenticated) before it reaches R2, and
    lands in r2:<Bucket>/<Prefix>/<name>.bak.bin. File names stay readable.

    THE KEY. You choose two long random secrets (the password and its salt, 20+ characters
    each; generate them in your password manager). They are typed here as hidden input, never
    shown, never put on a command line, never in the repo or in chat. rclone.conf then holds
    them in obscured (reversible, NOT secret) form, which is why that file is locked to
    SYSTEM + Administrators. BEFORE you press Enter on the second prompt, save BOTH secrets in
    your password manager under one entry: if the VPS is lost, the rclone.conf copy is lost
    with it, and without these two secrets every backup in R2 is unreadable for good.

    -CheckKey proves the password-manager copy matches the VPS: it asks for the two secrets
    again (open the entry, copy them from there, not from where you typed them first) and
    compares them with what rclone.conf decrypts to, printing only OK or MISMATCH. Run it
    once after the entry is saved and closed, BEFORE the plain backups are allowed to expire.
    Secrets must be printable ASCII (a character outside it can be written in another code
    page and silently make the VPS key differ from the entry).

    Refuses to run when [r2crypt] already exists (it would replace the key and orphan every
    backup made under the old one). -VerifyOnly re-runs just the proof against the existing
    remote.

.EXAMPLE
    .\Set-BackupEncryption.ps1 -Bucket allotjar
    .\Set-BackupEncryption.ps1 -Bucket allotjar -VerifyOnly
    .\Set-BackupEncryption.ps1 -Bucket allotjar -CheckKey
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Bucket,
    [string]$Rclone      = 'C:\deploy\rclone\rclone.exe',
    [string]$RcloneConf  = 'C:\deploy\rclone.conf',
    [string]$Remote      = 'r2',
    [string]$Prefix      = 'db-backups-enc',
    [string]$CryptRemote = 'r2crypt',
    [switch]$VerifyOnly,
    [switch]$CheckKey
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

if (-not (Test-Path -LiteralPath $Rclone))     { throw "rclone not found at $Rclone (docs/deployment/README.md > Off-host backups)." }
if (-not (Test-Path -LiteralPath $RcloneConf)) { throw "rclone config not found at $RcloneConf." }
$conf = Get-Content -LiteralPath $RcloneConf -Raw
if ((Get-RcloneConfValue -ConfText $conf -Section $Remote -Key 'type') -ne 's3') { throw "rclone.conf has no [$Remote] remote of type s3 - set up R2 access first." }
$exists = [bool](Get-RcloneConfValue -ConfText $conf -Section $CryptRemote -Key 'type')

function Read-Secret([string]$what, [switch]$NoConfirm) {
    while ($true) {
        $a = Read-Host "Paste the $what (hidden)" -AsSecureString
        if (-not $NoConfirm) { $b = Read-Host "Paste the $what again to confirm (hidden)" -AsSecureString }
        $ba = [IntPtr]::Zero; $bb = [IntPtr]::Zero
        try {
            $ba = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($a)
            $pa = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ba)
            $pb = $pa
            if (-not $NoConfirm) {
                $bb = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($b)
                $pb = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bb)
            }
        } finally {
            if ($ba -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ba) }
            if ($bb -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bb) }
        }
        if ($pa -cne $pb) { Write-Warning 'The two entries differ. Try again.'; continue }
        if ($pa.Length -lt 20) { Write-Warning 'Use at least 20 characters. Try again.'; continue }
        if ($pa -notmatch '^[\x20-\x7E]+$') { Write-Warning 'Use printable ASCII characters only (letters, digits, symbols; no accents or currency signs). Generate a new one in the password manager.'; continue }
        return $pa
    }
}

if ($CheckKey) {
    if (-not $exists) { throw "[$CryptRemote] is not in $RcloneConf yet." }
    Write-Host 'Open the password manager entry and copy the values from THERE.' -ForegroundColor Yellow
    $okAll = $true
    foreach ($pair in @(@('PASSWORD', 'password'), @('SALT', 'password2'))) {
        $typed  = Read-Secret $pair[0] -NoConfirm
        $stored = Get-RcloneConfValue -ConfText $conf -Section $CryptRemote -Key $pair[1]
        $same = $typed -ceq (Get-RcloneRevealed -Rclone $Rclone -Obscured $stored)
        $typed = $null
        Write-Host ('{0}: {1}' -f $pair[0], $(if ($same) { 'OK, matches the VPS' } else { 'MISMATCH' })) -ForegroundColor $(if ($same) { 'Green' } else { 'Red' })
        if (-not $same) { $okAll = $false }
    }
    if (-not $okAll) { throw 'The password manager entry does NOT match the key on the VPS. Fix the entry (or tell the thread) before anything else.' }
    Write-Host 'The password manager entry matches the key on the VPS.' -ForegroundColor Green
    return
}

if ($VerifyOnly) {
    if (-not $exists) { throw "[$CryptRemote] is not in $RcloneConf yet - run this script without -VerifyOnly." }
} else {
    if ($exists) { throw "[$CryptRemote] already exists in $RcloneConf. Refusing to replace the key: backups made under it would become unreadable. Use -VerifyOnly to test it." }
    Write-Host ''
    Write-Host 'Save TWO secrets in your password manager first (one entry, e.g. "AllotJar backup encryption"): a password and a salt, 20+ random characters each.' -ForegroundColor Yellow
    Write-Host 'Without them no backup in R2 can ever be read again. Press Ctrl+C now if they are not saved yet.' -ForegroundColor Yellow
    Write-Host ''
    $pw   = Read-Secret 'PASSWORD'
    $salt = Read-Secret 'SALT'
    if ($pw -ceq $salt) { throw 'The password and the salt must differ.' }
    $pwObs   = ConvertTo-RcloneObscured -Rclone $Rclone -Secret $pw
    $saltObs = ConvertTo-RcloneObscured -Rclone $Rclone -Secret $salt
    # What rclone will use must be exactly what was typed (no code-page or BOM change on the way in).
    if ((Get-RcloneRevealed -Rclone $Rclone -Obscured $pwObs) -cne $pw -or (Get-RcloneRevealed -Rclone $Rclone -Obscured $saltObs) -cne $salt) {
        throw 'rclone did not store the secrets exactly as typed (an encoding problem). Nothing was written. Use plain ASCII secrets.'
    }
    $pw = $null; $salt = $null
    $section = "`r`n[$CryptRemote]`r`ntype = crypt`r`nremote = ${Remote}:${Bucket}/${Prefix}`r`nfilename_encryption = off`r`ndirectory_name_encryption = false`r`npassword = $pwObs`r`npassword2 = $saltObs`r`n"
    $backup = "$RcloneConf.before-encryption"
    Copy-Item -LiteralPath $RcloneConf -Destination $backup -Force
    # A copy takes C:\deploy's ACL, not the original's: give it the original's (SYSTEM + Administrators only).
    Set-Acl -LiteralPath $backup -AclObject (Get-Acl -LiteralPath $RcloneConf)
    [System.IO.File]::AppendAllText($RcloneConf, $section, (New-Object System.Text.UTF8Encoding($false)))
    Info "Added [$CryptRemote] to $RcloneConf (a locked-down copy of the old file is at $backup; it is deleted once the proof below passes)."
    $conf = Get-Content -LiteralPath $RcloneConf -Raw
}

$problems = @(Get-BackupCryptRemoteProblems -ConfText $conf -CryptRemote $CryptRemote -Remote $Remote -Bucket $Bucket -Prefix $Prefix)
if ($problems.Count -gt 0) { throw ($problems -join ' ') }

# --- Proof: encrypt a throwaway file into R2, check what R2 holds is not the plain file, read it back ---
Info 'Proof: uploading a throwaway file through the crypt remote'
$tag  = [guid]::NewGuid().ToString('N').Substring(0, 8)
$name = "EncryptionSelfTest_$tag.bak"
$dir  = Join-Path ([IO.Path]::GetTempPath()) "allotjar-enc-$tag"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
try {
    $plain = Join-Path $dir $name
    $raw   = Join-Path $dir 'raw.bin'
    $back  = Join-Path $dir 'back.bak'
    $bytes = New-Object byte[] 200000
    (New-Object System.Random).NextBytes($bytes)
    [System.Text.Encoding]::ASCII.GetBytes('PLAINTEXT-MARKER').CopyTo($bytes, 0)
    [IO.File]::WriteAllBytes($plain, $bytes)

    & $Rclone copyto --config $RcloneConf $plain "${CryptRemote}:$name" --s3-no-check-bucket
    if ($LASTEXITCODE -ne 0) { throw "Upload through ${CryptRemote} failed (exit $LASTEXITCODE)." }

    & $Rclone copyto --config $RcloneConf "${Remote}:${Bucket}/${Prefix}/$name.bin" $raw --s3-no-check-bucket
    if ($LASTEXITCODE -ne 0) { throw "Could not read the object back as stored (exit $LASTEXITCODE)." }
    if (-not (Test-RcloneCryptFile -Path $raw)) { throw 'The object in R2 is NOT an rclone-encrypted file. Backups would be stored in plain text - STOP.' }
    if ([IO.File]::ReadAllText($raw, [Text.Encoding]::ASCII).Contains('PLAINTEXT-MARKER')) { throw 'The stored object contains the plain text - STOP.' }

    & $Rclone copyto --config $RcloneConf "${CryptRemote}:$name" $back --s3-no-check-bucket
    if ($LASTEXITCODE -ne 0) { throw "Download through ${CryptRemote} failed (exit $LASTEXITCODE)." }
    if ((Get-FileHash -LiteralPath $plain -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $back -Algorithm SHA256).Hash) { throw 'The decrypted file differs from the original - STOP.' }

    & $Rclone deletefile --config $RcloneConf "${CryptRemote}:$name" --s3-no-check-bucket
    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not delete the throwaway object $Prefix/$name.bin; the lifecycle rule will expire it." }
} finally {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}
if ($backup -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Force; Info "Deleted $backup." }
Write-Host "Encryption works: stored encrypted, read back identical. Nightly backups through ${CryptRemote} go to r2:${Bucket}/${Prefix}/." -ForegroundColor Green
