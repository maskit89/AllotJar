<#
.SYNOPSIS
    Server-side deploy: swap in a new build with zero file-lock errors, then
    verify it. Invoked over SSH by the GitHub Actions "Deploy" workflow.

.DESCRIPTION
    The CI job ships a release.zip whose extracted layout is:
        <staging>\api\         (dotnet publish output, incl. ANCM web.config)
        <staging>\web\         (Vite dist, incl. the front-site web.config)
        <staging>\Deploy.ps1   (this script)

    Steps:
      1. Drop app_offline.htm so ANCM gracefully stops the API and releases locks.
      2. robocopy /MIR the new files, preserving the server-only secrets file,
         the offline marker and the ANCM logs folder.
      3. Remove the marker and recycle both app pools.
      4. Poll /health until 200 - EF migrations run on the first request.

    The SQL Server database and its files are never touched, so data persists
    across every deploy.
#>
[CmdletBinding()]
param(
    [string]$StagingDir   = $PSScriptRoot,
    [string]$ApiDir       = 'C:\inetpub\zerobudget\api',
    [string]$WebDir       = 'C:\inetpub\zerobudget\web',
    [string]$ApiPool      = 'ZeroBudget-Api',
    [string]$WebPool      = 'ZeroBudget-Web',
    [string]$HealthUrl    = 'http://127.0.0.1:5000/health', # IPv4: the API binds to 127.0.0.1
    # Port the front site's ARR rule proxies /api to. deploy/web/web.config ships with
    # 5000 baked in (the staging stack); the production stack passes 5001 and the
    # copied web.config is patched after the sync.
    [int]   $ApiProxyPort = 5000
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# Restart-WebAppPool fails if the pool is stopped ("you have to start stopped
# object before restarting it"), so start-if-stopped, restart-if-running.
function Restart-Pool($name) {
    if ((Get-WebAppPoolState -Name $name).Value -eq 'Started') { Restart-WebAppPool -Name $name }
    else { Start-WebAppPool -Name $name }
}

$apiSrc = Join-Path $StagingDir 'api'
$webSrc = Join-Path $StagingDir 'web'
if (-not (Test-Path $apiSrc)) { throw "Missing API payload at $apiSrc" }
if (-not (Test-Path $webSrc)) { throw "Missing web payload at $webSrc" }

New-Item -ItemType Directory -Force -Path $ApiDir, $WebDir | Out-Null

# --- 1. Take the API offline (releases the EXE/DLL locks ANCM holds) ---------
Info 'Taking API offline'
$offline = Join-Path $ApiDir 'app_offline.htm'
Set-Content -Path $offline -Value '<!doctype html><h1>Updating, back in a moment...</h1>' -Encoding utf8
Start-Sleep -Seconds 2

# --- 2. Mirror new files ----------------------------------------------------
# robocopy exit codes 0-7 are success; >=8 is a real failure.
Info 'Syncing API files'
robocopy $apiSrc $ApiDir /MIR /XF app_offline.htm appsettings.Production.json /XD logs /R:3 /W:3 /NFL /NDL /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy(api) failed with code $LASTEXITCODE" }

Info 'Syncing web files'
robocopy $webSrc $WebDir /MIR /R:3 /W:3 /NFL /NDL /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy(web) failed with code $LASTEXITCODE" }

# Point the ARR /api proxy at this stack's API port. The checked-in web.config
# says 5000; a non-default port (production = 5001) is patched in post-sync so
# one web.config serves every stack.
if ($ApiProxyPort -ne 5000) {
    Info "Patching web.config ApiProxy to port $ApiProxyPort"
    $webConfig = Join-Path $WebDir 'web.config'
    $xml = [System.IO.File]::ReadAllText($webConfig)
    $xml = $xml.Replace('http://127.0.0.1:5000/api/', "http://127.0.0.1:$ApiProxyPort/api/")
    [System.IO.File]::WriteAllText($webConfig, $xml, (New-Object System.Text.UTF8Encoding($true)))
}

# --- 3. Bring it back online ------------------------------------------------
Info 'Bringing API online and recycling pools'
Remove-Item $offline -Force -ErrorAction SilentlyContinue
Restart-Pool $ApiPool
Restart-Pool $WebPool

# --- 4. Smoke test ----------------------------------------------------------
Info "Health-checking $HealthUrl"
$ok = $false
for ($i = 1; $i -le 20; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5
        if ($resp.StatusCode -eq 200) { $ok = $true; break }
    } catch {
        Start-Sleep -Seconds 3   # app warming up / migrations running
    }
}
if (-not $ok) { throw "Health check FAILED at $HealthUrl after deploy." }

Info 'Deploy succeeded.'
