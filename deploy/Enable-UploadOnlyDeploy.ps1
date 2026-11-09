<#
.SYNOPSIS
    Sets up the upload-only deploy on the VPS: one Windows account and SSH key per stack that can
    only upload into that stack's folder, and a SYSTEM task that deploys what was uploaded.
    Run once in an Administrator PowerShell; safe to run again (finished parts are skipped).

.DESCRIPTION
    Before this, the Deploy workflow signed in with one key on the Administrator account, so the
    key could run anything on the box, for either stack. After it:

      * allotjar-up-staging and allotjar-up-prod are plain local accounts (random password that is
        never shown; no RDP). sshd lets each one in by key only, to sftp only, jailed in
        C:\deploy\upload\staging or C:\deploy\upload\production, where it may write only into
        \incoming. No shell, no commands, no forwarding, and neither can see the other's folder.
      * A new ed25519 key pair per account. The private halves are written to C:\deploy\newkeys
        (Administrators only) for you to copy into the GitHub secrets VPS_SSH_KEY_STAGING and
        VPS_SSH_KEY_PRODUCTION; delete that folder afterwards. They are never printed.
      * C:\deploy\bin holds Invoke-PendingDeploy.ps1 and Approve-DeployScripts.ps1, and
        C:\deploy\bin\trusted the Deploy.ps1 and ProvisionHelpers.psm1 that deploys run.
        Only Administrators and SYSTEM can change them.
      * Scheduled task AllotJar-UploadDeploy runs Invoke-PendingDeploy.ps1 as SYSTEM every minute
        (one at a time, stopped after 20 minutes).
      * sshd_config gets one Match block per account at its end; the file is backed up first,
        checked with "sshd -t", and put back if the check or the restart fails.
      * A self-test signs in as each account with its new key: an upload must work, and a
        command must be refused.

    The existing Administrator deploy key keeps working until you remove it (a later step), so
    the current workflow is not interrupted.

    It installs the scripts from its own folder (bin\) and the release root above it. Never run
    it straight from C:\deploy\release-*: once the upload-only keys are in use, the upload account
    controls those folders. Copy bin\, Deploy.ps1 and ProvisionHelpers.psm1 into a folder only
    Administrators and SYSTEM can write, check every copy's hash against a main commit, and run
    the copy (docs/deployment/README.md, "SSH deploy keys"):
        & C:\deploy\setup-src\bin\Enable-UploadOnlyDeploy.ps1 -Check   # read-only report
        & C:\deploy\setup-src\bin\Enable-UploadOnlyDeploy.ps1          # set up
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [string]$SourceDir,                       # default: this script's folder (release\bin)
    [string]$SshDir   = 'C:\ProgramData\ssh',
    [string]$BinDir   = 'C:\deploy\bin',
    [string]$KeyOutDir = 'C:\deploy\newkeys',
    [string]$TaskName = 'AllotJar-UploadDeploy'
)

$ErrorActionPreference = 'Stop'
if (-not $SourceDir) { $SourceDir = $PSScriptRoot }
$releaseDir = Split-Path $SourceDir -Parent      # release root: Deploy.ps1 and ProvisionHelpers.psm1
Import-Module (Join-Path $releaseDir 'ProvisionHelpers.psm1') -Force

$sshd    = 'C:\Windows\System32\OpenSSH\sshd.exe'
$sftp    = 'C:\Windows\System32\OpenSSH\sftp.exe'
$ssh     = 'C:\Windows\System32\OpenSSH\ssh.exe'
$keygen  = 'C:\Windows\System32\OpenSSH\ssh-keygen.exe'
$cfg     = Join-Path $SshDir 'sshd_config'
$keysDir = Join-Path $SshDir 'deploy_keys'
$stacks  = @((Get-UploadDeployStack -Stack staging), (Get-UploadDeployStack -Stack production))
$marker  = '# AllotJar upload-only deploy accounts'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# Inheritance off; only the named principals, each with the named right.
function Set-ExactAcl([string]$Path, [hashtable]$Grants) {
    $isDir = (Get-Item -LiteralPath $Path).PSIsContainer
    $acl = if ($isDir) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.NTAccount 'BUILTIN\Administrators'))
    foreach ($who in $Grants.Keys) {
        $rule = if ($isDir) {
            New-Object Security.AccessControl.FileSystemAccessRule($who, $Grants[$who], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else {
            New-Object Security.AccessControl.FileSystemAccessRule($who, $Grants[$who], 'Allow')
        }
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Get-SshdPort {
    $m = Select-String -LiteralPath $cfg -Pattern '^\s*Port\s+(\d+)' | Select-Object -First 1
    if ($m) { return [int]$m.Matches[0].Groups[1].Value } else { return 22 }
}

function Get-MatchBlock {
    $lines = @('', "$marker (Enable-UploadOnlyDeploy.ps1, $(Get-Date -Format yyyy-MM-dd))")
    foreach ($s in $stacks) {
        $lines += "Match User $($s.User)"
        $lines += "    AuthorizedKeysFile __PROGRAMDATA__/ssh/deploy_keys/$($s.User)"
        $lines += "    ChrootDirectory $($s.UploadDir)"
        $lines += '    ForceCommand internal-sftp'
        $lines += '    AllowTcpForwarding no'
        $lines += '    AllowAgentForwarding no'
        $lines += '    PermitTTY no'
        $lines += '    X11Forwarding no'
    }
    return ($lines -join "`r`n") + "`r`n"
}

# ---------------------------------------------------------------- report ---
function Show-State {
    '== Accounts'
    foreach ($s in $stacks) {
        $u = Get-LocalUser -Name $s.User -ErrorAction SilentlyContinue
        if ($u) { "    {0}: exists, enabled {1}" -f $s.User, $u.Enabled } else { "    $($s.User): missing" }
    }
    '== Upload folders and key files'
    foreach ($s in $stacks) {
        "    {0}: {1}" -f $s.UploadDir, $(if (Test-Path -LiteralPath $s.UploadDir) { 'exists' } else { 'missing' })
        $kf = Join-Path $keysDir $s.User
        "    {0}: {1}" -f $kf, $(if (Test-Path -LiteralPath $kf) { 'exists' } else { 'missing' })
    }
    '== sshd_config'
    $text = [IO.File]::ReadAllText($cfg)
    "    upload-only Match blocks: $(if ($text.Contains($marker)) { 'present' } else { 'missing' })"
    '== Scripts'
    foreach ($f in (Join-Path $BinDir 'Invoke-PendingDeploy.ps1'), (Join-Path $BinDir 'Approve-DeployScripts.ps1'), (Join-Path $BinDir 'trusted\Deploy.ps1'), (Join-Path $BinDir 'trusted\ProvisionHelpers.psm1')) {
        "    {0}: {1}" -f $f, $(if (Test-Path -LiteralPath $f) { 'installed' } else { 'missing' })
    }
    '== Scheduled task'
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { "    $TaskName : $($t.State)" } else { "    $TaskName : missing" }
    '== Event log source'
    "    AllotJar Deploy: $(if ([Diagnostics.EventLog]::SourceExists('AllotJar Deploy')) { 'registered' } else { 'missing' })"
}

foreach ($f in $sshd, $sftp, $ssh, $keygen, $cfg) { if (-not (Test-Path -LiteralPath $f)) { throw "$f not found; nothing changed." } }
foreach ($f in 'Invoke-PendingDeploy.ps1', 'Approve-DeployScripts.ps1') { if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $f))) { throw "$f is not in $SourceDir; nothing changed." } }
foreach ($f in 'Deploy.ps1', 'ProvisionHelpers.psm1') { if (-not (Test-Path -LiteralPath (Join-Path $releaseDir $f))) { throw "$f is not in $releaseDir; nothing changed." } }

if ($Check) { Show-State; 'Check only: nothing changed.'; return }

$admins = 'BUILTIN\Administrators'; $system = 'NT AUTHORITY\SYSTEM'

# ----------------------------------------------------- 1. scripts, trusted --
Info "Installing scripts in $BinDir"
New-Item -ItemType Directory -Force -Path $BinDir, (Join-Path $BinDir 'trusted') | Out-Null
Set-ExactAcl $BinDir @{ $admins = 'FullControl'; $system = 'FullControl' }
foreach ($f in 'Invoke-PendingDeploy.ps1', 'Approve-DeployScripts.ps1') { Copy-Item -LiteralPath (Join-Path $SourceDir $f) -Destination $BinDir -Force }
foreach ($f in 'Deploy.ps1', 'ProvisionHelpers.psm1') {
    $dest = Join-Path $BinDir "trusted\$f"
    if (Test-Path -LiteralPath $dest) { "    trusted\$f already installed: kept (changes go through Approve-DeployScripts.ps1)" }
    else { Copy-Item -LiteralPath (Join-Path $releaseDir $f) -Destination $dest; "    trusted\$f installed" }
}

# ----------------------------------------------------------- 2. accounts ---
Info 'Creating the upload-only accounts'
foreach ($s in $stacks) {
    if (Get-LocalUser -Name $s.User -ErrorAction SilentlyContinue) { "    $($s.User) already exists"; continue }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $pw = ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + 'a1!') -AsPlainText -Force
    New-LocalUser -Name $s.User -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires `
        -Description "AllotJar upload-only deploy ($($s.Stack))" | Out-Null   # Windows allows 48 characters
    Add-LocalGroupMember -Group 'Users' -Member $s.User
    "    $($s.User) created"
}

# ---------------------------------------------------- 3. upload folders ----
Info 'Creating the upload folders'
New-Item -ItemType Directory -Force -Path 'C:\deploy\upload' | Out-Null
Set-ExactAcl 'C:\deploy\upload' @{ $admins = 'FullControl'; $system = 'FullControl' }
# sshd refuses a chroot that its user can write to, so the jail's root is read-only for the
# account (it reads status.txt there) and only its "incoming" subfolder takes uploads.
foreach ($s in $stacks) {
    New-Item -ItemType Directory -Force -Path $s.UploadDir, $s.UploadInbox | Out-Null
    Set-ExactAcl $s.UploadDir @{ $admins = 'FullControl'; $system = 'FullControl'; $s.User = 'ReadAndExecute' }
    Set-ExactAcl $s.UploadInbox @{ $admins = 'FullControl'; $system = 'FullControl'; $s.User = 'Modify' }
    "    $($s.UploadDir): $($s.User) may read; only $($s.UploadInbox) takes its uploads"
}

# --------------------------------------------------------------- 4. keys ---
Info 'Creating one SSH key per account'
New-Item -ItemType Directory -Force -Path $keysDir, $KeyOutDir | Out-Null
Set-ExactAcl $keysDir @{ $admins = 'FullControl'; $system = 'FullControl' }
Set-ExactAcl $KeyOutDir @{ $admins = 'FullControl'; $system = 'FullControl' }
foreach ($s in $stacks) {
    $authFile = Join-Path $keysDir $s.User
    if (Test-Path -LiteralPath $authFile) { "    $($s.User) already has a key: kept"; continue }
    $priv = Join-Path $KeyOutDir $s.Stack
    Remove-Item -LiteralPath $priv, "$priv.pub" -Force -ErrorAction SilentlyContinue
    $ErrorActionPreference = 'Continue'
    & $keygen -q -t ed25519 -N '""' -C "github-actions-$($s.Stack)" -f $priv 2>&1 | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0 -or -not (Test-Path -LiteralPath "$priv.pub")) { throw "ssh-keygen failed for $($s.Stack) (exit $code)." }
    $pub = (Get-Content -LiteralPath "$priv.pub" -TotalCount 1).Trim()
    [IO.File]::WriteAllText($authFile, "restrict $pub`r`n", (New-Object Text.UTF8Encoding $false))
    Set-ExactAcl $authFile @{ $admins = 'FullControl'; $system = 'FullControl' }
    $fp = & $keygen -lf "$priv.pub"
    "    $($s.User): $fp"
}

# ------------------------------------------------------- 5. event source ---
if (-not [Diagnostics.EventLog]::SourceExists('AllotJar Deploy')) { New-EventLog -LogName Application -Source 'AllotJar Deploy' }

# ------------------------------------------------------------- 6. sshd -----
$port = Get-SshdPort
$text = [IO.File]::ReadAllText($cfg)
if ($text.Contains($marker)) {
    Info 'sshd_config already has the upload-only Match blocks: kept'
} else {
    Info 'Adding the upload-only Match blocks to sshd_config'
    foreach ($s in $stacks) {
        if ($text -match "(?im)^\s*Match\s+User\s+.*\b$([regex]::Escape($s.User))\b") { throw "sshd_config already has a Match block for $($s.User) without this script's marker. Nothing changed in sshd_config." }
    }
    $bak = "$cfg.bak-{0:yyyyMMdd-HHmmss}" -f (Get-Date)
    Copy-Item -LiteralPath $cfg -Destination $bak
    "    backup: $bak"
    $nl = if ($text.EndsWith("`n")) { '' } else { "`r`n" }
    try {
        [IO.File]::WriteAllText($cfg, $text + $nl + (Get-MatchBlock), (New-Object Text.UTF8Encoding $false))
        $ErrorActionPreference = 'Continue'
        $test = & $sshd -t 2>&1
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($code -ne 0) { throw "sshd -t rejected the file (exit $code): $test" }
        Restart-Service sshd
        Start-Sleep -Seconds 2
        if ((Get-Service sshd).Status -ne 'Running') { throw 'sshd did not start again.' }
    } catch {
        $why = $_.Exception.Message
        Copy-Item -LiteralPath $bak -Destination $cfg -Force
        $restart = 'sshd restarted'
        try { Restart-Service sshd } catch { $restart = "sshd did NOT restart ($($_.Exception.Message)); run: Start-Service sshd" }
        throw "$why The sshd_config backup was put back; $restart. The accounts, folders and keys made above stay; run this script again after the fix."
    }
}

# ----------------------------------------------------------- 7. task -------
Info "Registering scheduled task $TaskName"
$script = Join-Path $BinDir 'Invoke-PendingDeploy.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$stored = Get-ScheduledTask -TaskName $TaskName
$rep = ($stored.Triggers | Select-Object -First 1).Repetition
if ($rep.Interval -ne 'PT1M') { throw "Task $TaskName was stored without its every-minute repetition." }
# No duration means "repeat for ever"; a stored duration would stop the deploys silently later.
if ($rep.Duration) { throw "Task $TaskName repeats only for $($rep.Duration), not indefinitely." }
"    every minute as SYSTEM, one at a time, stopped after 20 minutes"

# ------------------------------------------------------- 8. self-test ------
Info 'Self-test: each account may upload, and may not run a command'
$failures = @()
foreach ($s in $stacks) {
    $priv = Join-Path $KeyOutDir $s.Stack
    if (-not (Test-Path -LiteralPath $priv)) { "    $($s.User): no new private key in $KeyOutDir (key made earlier), skipped"; continue }
    $common = @('-i', $priv, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'ConnectTimeout=10')
    $probe = Join-Path $env:TEMP "allotjar-probe-$($s.Stack).txt"
    $batch = Join-Path $env:TEMP "allotjar-probe-$($s.Stack).sftp"
    Set-Content -LiteralPath $probe -Value 'probe' -Encoding ascii
    Set-Content -LiteralPath $batch -Value @("put `"$probe`" /incoming/probe.txt", 'rm /incoming/probe.txt', 'ls /') -Encoding ascii
    $ErrorActionPreference = 'Continue'
    $up = & $sftp @common -P $port -b $batch "$($s.User)@127.0.0.1" 2>&1
    $upCode = $LASTEXITCODE
    # -n: stdin is empty, so the forced sftp server ends at once instead of waiting.
    $cmd = & $ssh @common -n -p $port "$($s.User)@127.0.0.1" 'whoami' 2>&1
    $cmdOut = ($cmd | Out-String)
    $ErrorActionPreference = 'Stop'
    Remove-Item -LiteralPath $probe, $batch -Force -ErrorAction SilentlyContinue
    if ($upCode -eq 0) { "    $($s.User): upload works" } else { $failures += "$($s.User) could not upload: $($up -join ' ')" }
    # whoami would print "<computer>\<account>": seeing the account name means a command ran.
    $ranCommand = $cmdOut -match ('(?i)\\' + [regex]::Escape($s.User))
    if ($ranCommand) { $failures += "$($s.User) could run a command: $cmdOut" }
    else { "    $($s.User): commands refused" }
}

''
Show-State
''
if ($failures.Count) { throw ("Self-test FAILED:`n - " + ($failures -join "`n - ")) }
"Done. Next: copy each private key file in $KeyOutDir (staging, production; open with notepad) into the GitHub secret"
"VPS_SSH_KEY_STAGING / VPS_SSH_KEY_PRODUCTION. Do not paste or screenshot them anywhere else."
"Delete $KeyOutDir only after both secrets are saved: a re-run keeps an existing key and cannot show it again."
