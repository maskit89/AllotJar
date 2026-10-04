<#
.SYNOPSIS
    Server-side deploy: swap in a new build with zero file-lock errors, then
    verify it. Invoked over SSH by the GitHub Actions "Deploy" workflow.

.DESCRIPTION
    The CI job ships a release.zip whose extracted layout is:
        <release>\api\         (dotnet publish output, incl. ANCM web.config)
        <release>\web\         (Vite dist, incl. the front-site web.config)
        <release>\Deploy.ps1   (this script)

    Steps:
      1. Check the stack exists (pools, the settings file for -AspNetEnvironment).
      2. Drop app_offline.htm so ANCM gracefully stops the API and releases locks.
      3. robocopy /MIR the new files, preserving the server-only settings files,
         the offline marker and the ANCM logs folder.
      4. Pin ASPNETCORE_ENVIRONMENT in the API's web.config, so the staging stack
         reads appsettings.Staging.json and the production stack
         appsettings.Production.json. Patch the front site's /api proxy port.
      5. Remove the marker and recycle both app pools.
      6. Poll /health until 200 - EF migrations run on the first request.

    The SQL Server database and its files are never touched, so data persists
    across every deploy.

    Two stacks share this VPS. Every name says which one it is:
        staging     C:\inetpub\zerobudget-staging\{api,web}  pools ZeroBudget-Staging-Api / -Web
                    API :5000, ASPNETCORE_ENVIRONMENT=Staging, appsettings.Staging.json
        production  C:\inetpub\zerobudget-prod\{api,web}     pools ZeroBudget-Prod-Api / -Web
                    API :5001, ASPNETCORE_ENVIRONMENT=Production, appsettings.Production.json
    The defaults below are the staging stack; the workflow passes every value explicitly
    for both stacks so a reader of deploy.yml sees which stack a job targets.
#>
[CmdletBinding()]
param(
    [string]$ReleaseDir   = $PSScriptRoot,
    [string]$ApiDir       = 'C:\inetpub\zerobudget-staging\api',
    [string]$WebDir       = 'C:\inetpub\zerobudget-staging\web',
    [string]$ApiPool      = 'ZeroBudget-Staging-Api',
    [string]$WebPool      = 'ZeroBudget-Staging-Web',
    [string]$HealthUrl    = 'http://127.0.0.1:5000/health', # IPv4: the API binds to 127.0.0.1
    # Port the front site's ARR rule proxies /api to. deploy/web/web.config ships with
    # 5000 baked in (the staging stack); the production stack passes 5001 and the
    # copied web.config is patched after the sync.
    [int]   $ApiProxyPort = 5000,
    # ASP.NET Core environment of this stack. Decides which appsettings.<Env>.json the API
    # reads, so staging's settings are called staging and production's production. Written
    # into the API's web.config after every sync (the published web.config has no value, and
    # ASP.NET Core would then default to Production for both stacks).
    [ValidateSet('Staging', 'Production')]
    [string]$AspNetEnvironment = 'Staging'
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# Restart-WebAppPool fails if the pool is stopped ("you have to start stopped
# object before restarting it"), so start-if-stopped, restart-if-running.
function Restart-Pool($name) {
    if ((Get-WebAppPoolState -Name $name).Value -eq 'Started') { Restart-WebAppPool -Name $name }
    else { Start-WebAppPool -Name $name }
}

$apiSrc = Join-Path $ReleaseDir 'api'
$webSrc = Join-Path $ReleaseDir 'web'
if (-not (Test-Path $apiSrc)) { throw "Missing API payload at $apiSrc" }
if (-not (Test-Path $webSrc)) { throw "Missing web payload at $webSrc" }

# --- 1. Preflight: the stack this deploy targets must exist under these names --
# A missing pool or settings file is reported here, before the API is taken offline,
# instead of as a health-check failure twenty retries later. The usual cause is a
# stack still under its old names: run deploy\Rename-StagingStack.ps1 once.
foreach ($pool in @($ApiPool, $WebPool)) {
    if (-not (Test-Path "IIS:\AppPools\$pool")) {
        throw "App pool '$pool' does not exist on this server. If this is the staging stack still under its pre-rename names (ZeroBudget-Api / ZeroBudget-Web), run deploy\Rename-StagingStack.ps1 once, then deploy again."
    }
}
$settingsName = "appsettings.$AspNetEnvironment.json"
$settingsPath = Join-Path $ApiDir $settingsName
if (-not (Test-Path $settingsPath)) {
    throw "$settingsPath is missing: the $AspNetEnvironment API would start with no connection string. Create it from appsettings.Production.json.example (for a renamed staging stack, Rename-StagingStack.ps1 renames the old appsettings.Production.json to appsettings.Staging.json)."
}

New-Item -ItemType Directory -Force -Path $ApiDir, $WebDir | Out-Null

# --- 2. Take the API offline (releases the EXE/DLL locks ANCM holds) ---------
Info 'Taking API offline'
$offline = Join-Path $ApiDir 'app_offline.htm'
Set-Content -Path $offline -Value '<!doctype html><h1>Updating, back in a moment...</h1>' -Encoding utf8
Start-Sleep -Seconds 2

# --- 3. Mirror new files ----------------------------------------------------
# robocopy exit codes 0-7 are success; >=8 is a real failure. Both environments'
# settings files are excluded so a mirror never deletes the server-only secrets,
# whichever environment this stack is.
Info 'Syncing API files'
robocopy $apiSrc $ApiDir /MIR /XF app_offline.htm appsettings.Staging.json appsettings.Production.json /XD logs /R:3 /W:3 /NFL /NDL /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy(api) failed with code $LASTEXITCODE" }

Info 'Syncing web files'
robocopy $webSrc $WebDir /MIR /R:3 /W:3 /NFL /NDL /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy(web) failed with code $LASTEXITCODE" }

# --- 4. Per-stack patches of the two shipped web.config files ----------------
# The API's web.config comes from `dotnet publish` and names no environment; pin it
# so this stack reads its own appsettings.<Env>.json.
Info "Pinning ASPNETCORE_ENVIRONMENT=$AspNetEnvironment in the API web.config"
$apiWebConfig = Join-Path $ApiDir 'web.config'
$apiXml = Set-AncmEnvironmentVariable -WebConfigXml ([System.IO.File]::ReadAllText($apiWebConfig)) `
    -Name 'ASPNETCORE_ENVIRONMENT' -Value $AspNetEnvironment
[System.IO.File]::WriteAllText($apiWebConfig, $apiXml, (New-Object System.Text.UTF8Encoding($false)))

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

# --- 5. Bring it back online ------------------------------------------------
Info 'Bringing API online and recycling pools'
Remove-Item $offline -Force -ErrorAction SilentlyContinue
Restart-Pool $ApiPool
Restart-Pool $WebPool

# --- 6. Smoke test ----------------------------------------------------------
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
