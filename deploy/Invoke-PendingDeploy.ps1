<#
.SYNOPSIS
    Deploys a release that a workflow uploaded through an upload-only account. Runs every minute
    as SYSTEM from the scheduled task AllotJar-UploadDeploy (set up by Enable-UploadOnlyDeploy.ps1).

.DESCRIPTION
    The Deploy workflow's SSH keys can only upload files into their own stack's folder
    (C:\deploy\upload\staging or \production, an sftp jail); they cannot run any command here.
    This script is the other half. For each stack, when <upload>\incoming\release.zip exists:

      1. Moves release.zip and release.id out of the jail (to C:\deploy\incoming-<stack>),
         so the uploader cannot swap the file while it is unpacked.
      2. Checks the zip: size, and every entry name stays inside the release folder.
      3. Unpacks it into C:\deploy\release-<stack>.
      4. Compares the release's Deploy.ps1 and ProvisionHelpers.psm1 with the trusted copies in
         C:\deploy\bin\trusted. If either differs it stops ("blocked"): the owner reviews the
         change on the server with Approve-DeployScripts.ps1. The upload can never choose the
         code that runs as SYSTEM.
      5. Runs the TRUSTED Deploy.ps1 with this stack's fixed folders, pools and ports.
      6. Writes the result to <upload>\status.txt (the jail's root: the account can read it but
         not write it), which the workflow polls over sftp, and to
         the Application event log (source "AllotJar Deploy": 4100 ok, 4101 failed, 4102 blocked).

    An idle run only tests for two files and exits. Nothing is left running between runs.
#>
[CmdletBinding()]
param(
    [string]$TrustedDir = 'C:\deploy\bin\trusted',
    [long]  $MaxZipBytes = 400MB,
    [long]  $MaxUnpackedBytes = 1500MB
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $TrustedDir 'ProvisionHelpers.psm1') -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Write-DeployEvent([int]$Id, [string]$Type, [string]$Text) {
    try { Write-EventLog -LogName Application -Source 'AllotJar Deploy' -EventId $Id -EntryType $Type -Message $Text } catch { }
}

function Write-Status($s, [string]$Id, [string]$State, [string]$Message, [string[]]$Log = @()) {
    $text = ConvertTo-UploadDeployStatus -Id $Id -State $State -Message $Message -LogLines $Log
    $path = Join-Path $s.UploadDir 'status.txt'
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
}

function Expand-ReleaseZip([string]$Zip, [string]$Destination, [long]$MaxUnpacked) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $total = 0L
        foreach ($e in $archive.Entries) {
            if (-not (Test-ZipEntryNameSafe -EntryName $e.FullName)) { throw "The release holds an entry outside its folder: '$($e.FullName)'." }
            $total += $e.Length
            if ($total -gt $MaxUnpacked) { throw "The release unpacks to more than $([math]::Round($MaxUnpacked / 1MB)) MB." }
        }
    } finally { $archive.Dispose() }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

function Test-SameFile([string]$A, [string]$B) {
    if (-not (Test-Path -LiteralPath $A) -or -not (Test-Path -LiteralPath $B)) { return $false }
    return (Get-FileHash -LiteralPath $A -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $B -Algorithm SHA256).Hash
}

foreach ($stackName in @('staging', 'production')) {
    $s = Get-UploadDeployStack -Stack $stackName
    $uploadZip = Join-Path $s.UploadInbox 'release.zip'
    if (-not (Test-Path -LiteralPath $uploadZip)) { continue }

    $idText = $null
    $uploadId = Join-Path $s.UploadInbox 'release.id'
    if (Test-Path -LiteralPath $uploadId) { $idText = Get-Content -LiteralPath $uploadId -TotalCount 1 -ErrorAction SilentlyContinue }
    $id = Get-UploadReleaseId -Text $idText -Stack $stackName
    $log = @()
    try {
        Write-Status $s $id 'running' "Deploying to $stackName."
        New-Item -ItemType Directory -Force -Path $s.IncomingDir | Out-Null
        $zip = Join-Path $s.IncomingDir 'release.zip'
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $uploadZip -Destination $zip
        Remove-Item -LiteralPath $uploadId -Force -ErrorAction SilentlyContinue

        if ((Get-Item -LiteralPath $zip).Length -gt $MaxZipBytes) { throw "The release is larger than $([math]::Round($MaxZipBytes / 1MB)) MB." }
        Expand-ReleaseZip $zip $s.ReleaseDir $MaxUnpackedBytes

        $changed = @(foreach ($f in 'Deploy.ps1', 'ProvisionHelpers.psm1') {
            if (-not (Test-SameFile (Join-Path $s.ReleaseDir $f) (Join-Path $TrustedDir $f))) { $f }
        })
        if ($changed.Count) {
            $msg = "$($changed -join ' and ') changed in this release. Review it on the server with: C:\deploy\bin\Approve-DeployScripts.ps1 -Stack $stackName, then re-run this Deploy job."
            Write-Status $s $id 'blocked' $msg
            Write-DeployEvent 4102 Warning "$stackName deploy $id blocked: $msg"
            continue
        }

        $deploy = Join-Path $TrustedDir 'Deploy.ps1'
        $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $deploy,
            '-ReleaseDir', $s.ReleaseDir, '-ApiDir', $s.ApiDir, '-WebDir', $s.WebDir,
            '-ApiPool', $s.ApiPool, '-WebPool', $s.WebPool, '-HealthUrl', $s.HealthUrl,
            '-ApiProxyPort', $s.ApiProxyPort, '-AspNetEnvironment', $s.AspNetEnvironment)
        $ErrorActionPreference = 'Continue'
        $log = @(& powershell.exe @argList 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($code -ne 0) { throw "Deploy.ps1 failed (exit $code)." }

        Write-Status $s $id 'ok' "Deployed to $stackName." $log
        Write-DeployEvent 4100 Information "$stackName deploy $id succeeded."
    } catch {
        $why = $_.Exception.Message
        $ErrorActionPreference = 'Stop'
        try { Write-Status $s $id 'failed' $why $log } catch { }
        Write-DeployEvent 4101 Error "$stackName deploy $id failed: $why"
    }
}
