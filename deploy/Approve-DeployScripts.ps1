<#
.SYNOPSIS
    Shows what changed in Deploy.ps1 / ProvisionHelpers.psm1 in a release that the upload-only
    deploy stopped as "blocked", and on your typed OK makes them the trusted copies.

.DESCRIPTION
    Invoke-PendingDeploy.ps1 runs only the trusted copies in C:\deploy\bin\trusted, never the ones
    inside an upload, because those run as SYSTEM. When a merged change edits either file, the
    next deploy stops as "blocked" and leaves the unpacked release in C:\deploy\release-<stack>.

    Run this in an Administrator PowerShell on the VPS:
        C:\deploy\bin\Approve-DeployScripts.ps1 -Stack staging
    It prints the commit the release was built from (check it is on main), and the added (+) and
    removed (-) lines of each changed file. Type APPROVE to copy them into the trusted folder
    (the old copies are kept in C:\deploy\bin\trusted\previous). Then re-run the Deploy job.
    Anything else leaves everything as it was.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('staging', 'production')][string]$Stack,
    [string]$TrustedDir = 'C:\deploy\bin\trusted'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $TrustedDir 'ProvisionHelpers.psm1') -Force
$s = Get-UploadDeployStack -Stack $Stack

$commitFile = Join-Path $s.ReleaseDir 'COMMIT'
$commit = if (Test-Path -LiteralPath $commitFile) { (Get-Content -LiteralPath $commitFile -TotalCount 1).Trim() } else { '(not recorded)' }
"Release waiting in $($s.ReleaseDir), built from commit: $commit"
"Check on GitHub that this commit is on main before you approve."
''

$changed = @()
foreach ($f in 'Deploy.ps1', 'ProvisionHelpers.psm1') {
    $pending = Join-Path $s.ReleaseDir $f
    $trusted = Join-Path $TrustedDir $f
    if (-not (Test-Path -LiteralPath $pending)) { throw "$pending is missing: there is no release waiting for $Stack. Nothing changed." }
    $same = (Test-Path -LiteralPath $trusted) -and ((Get-FileHash -LiteralPath $pending).Hash -eq (Get-FileHash -LiteralPath $trusted).Hash)
    if ($same) { "== $f is unchanged"; continue }
    $changed += $f
    "== $f changed (+ added, - removed):"
    $old = if (Test-Path -LiteralPath $trusted) { @(Get-Content -LiteralPath $trusted) } else { @() }
    Get-ScriptChangeLines -Trusted $old -Pending @(Get-Content -LiteralPath $pending) | ForEach-Object { "   $_" }
    ''
}
if (-not $changed.Count) { 'Both files already match the trusted copies. Nothing to approve: re-run the Deploy job.'; return }

$answer = Read-Host 'Type APPROVE to trust these files for every future deploy (anything else cancels)'
if ($answer -cne 'APPROVE') { 'Cancelled. Nothing changed.'; return }

$previous = Join-Path $TrustedDir ('previous\{0:yyyyMMdd-HHmmss}' -f (Get-Date))
New-Item -ItemType Directory -Force -Path $previous | Out-Null
foreach ($f in $changed) {
    $trusted = Join-Path $TrustedDir $f
    if (Test-Path -LiteralPath $trusted) { Copy-Item -LiteralPath $trusted -Destination $previous }
    Copy-Item -LiteralPath (Join-Path $s.ReleaseDir $f) -Destination $trusted -Force
    "Trusted now: $f  SHA256 $((Get-FileHash -LiteralPath $trusted).Hash)"
}
try { Write-EventLog -LogName Application -Source 'AllotJar Deploy' -EventId 4103 -EntryType Information -Message "Approved $($changed -join ', ') from commit $commit for every stack." } catch { }
"Old copies kept in $previous. Now re-run the Deploy job that was blocked."
