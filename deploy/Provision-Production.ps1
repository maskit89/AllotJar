<#
.SYNOPSIS
    One-time (idempotent) provisioning of the PRODUCTION stack on the existing VPS,
    alongside the staging stack. Run over SSH by the "Provision production" GitHub
    Actions workflow, or by hand in an elevated session.

.DESCRIPTION
    The box already runs the staging stack (IIS site 'ZeroBudget' = SPA front +
    'ZeroBudget-Api' on 127.0.0.1:5000, SQL Express DB 'ZeroBudget'). This script
    stands up a parallel, fully separate production stack:

      * dirs        C:\inetpub\zerobudget-prod\{api,web}  (+ C:\deploy\incoming-prod / staging-prod)
      * app pools   ZeroBudget-Prod-Web / ZeroBudget-Prod-Api  (No Managed Code, AlwaysRunning)
      * IIS sites   'ZeroBudget-Prod'      -> the SPA front, host-bound to allotjar.com + www.allotjar.com
                    'ZeroBudget-Prod-Api'  -> ANCM API on 127.0.0.1:5001
      * TLS         SNI 443 bindings for apex/www (and staging.allotjar.com on the
                    staging site), reusing the certificate already bound on 443
                    (Cloudflare connects with SSL mode Full, so the origin cert
                    only has to exist, not be publicly trusted)
      * SQL         database 'ZeroBudgetProd' + db_owner for the prod app-pool identity
      * config      appsettings.Production.json cloned from the staging API's copy
                    with the prod DB name and a FRESH random JWT signing key
                    (never overwritten if it already exists)
      * backups     daily backup tasks re-registered for BOTH databases

    It does NOT deploy application binaries - the prod deploy job in
    .github/workflows/deploy.yml does that (Deploy.ps1 -ApiProxyPort 5001 ...).

    Re-run with -TrimStagingBindings AFTER the Cloudflare DNS cutover to strip the
    now-dead hostnames (catch-all, apex, www, app.allotjar.com) off the staging site
    so each site answers exactly its own hosts.
#>
[CmdletBinding()]
param(
    [string]$ProdWebRoot   = 'C:\inetpub\zerobudget-prod\web',
    [string]$ProdApiRoot   = 'C:\inetpub\zerobudget-prod\api',
    [int]   $ProdApiPort   = 5001,
    [string]$ProdDatabase  = 'ZeroBudgetProd',
    [string]$ProdWebPool   = 'ZeroBudget-Prod-Web',
    [string]$ProdApiPool   = 'ZeroBudget-Prod-Api',
    [string]$ProdWebSite   = 'ZeroBudget-Prod',
    [string]$ProdApiSite   = 'ZeroBudget-Prod-Api',
    [string[]]$ProdHosts   = @('allotjar.com', 'www.allotjar.com'),

    [string]$StagingSite    = 'ZeroBudget',
    [string]$StagingApiRoot = 'C:\inetpub\zerobudget\api',
    [string]$StagingHost    = 'staging.allotjar.com',

    [string]$SqlServer     = '.\SQLEXPRESS',

    # Post-cutover cleanup: remove catch-all/apex/www/app.allotjar.com bindings from
    # the staging site (leaving only $StagingHost). Run this only AFTER DNS moved
    # apex/www onto the prod site, or current users lose the site mid-flight.
    [switch]$TrimStagingBindings
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# A site whose bindings collide with another site's (e.g. apex/www living on BOTH
# the old staging site and the new prod site until the trim) fails to AUTO-start
# but starts fine once the collision is gone - so always try to start explicitly.
function Start-SiteIfStopped($name) {
    $site = Get-Website -Name $name -ErrorAction SilentlyContinue
    if (-not $site) { return }
    if ($site.State -ne 'Started') {
        Info "Starting site '$name' (was $($site.State))"
        Start-Website -Name $name
    }
}

# --- SQL helper (System.Data.SqlClient over Shared Memory; no sqlcmd needed) --
Add-Type -AssemblyName System.Data
function Invoke-Sql {
    param([string]$Database, [string]$Query)
    $cn = New-Object System.Data.SqlClient.SqlConnection
    $cn.ConnectionString = "Server=$SqlServer;Database=$Database;Integrated Security=True;TrustServerCertificate=True"
    $cn.Open()
    try {
        $cmd = $cn.CreateCommand()
        $cmd.CommandText = $Query
        $cmd.CommandTimeout = 300
        [void]$cmd.ExecuteNonQuery()
    } finally { $cn.Close() }
}

# =============================================================================
# Finalize mode: trim the staging site's bindings after the DNS cutover.
# =============================================================================
if ($TrimStagingBindings) {
    Info "Trimming staging site '$StagingSite' bindings down to $StagingHost"
    $bindings = Get-WebBinding -Name $StagingSite
    foreach ($b in $bindings) {
        # bindingInformation is IP:port:hostHeader
        $parts = $b.bindingInformation -split ':', 3
        $hostHeader = $parts[2]
        if ($hostHeader -eq $StagingHost) { continue }
        Info "  removing $($b.protocol) binding '$($b.bindingInformation)'"
        Remove-WebBinding -Name $StagingSite -BindingInformation $b.bindingInformation -Protocol $b.protocol
    }
    $left = @(Get-WebBinding -Name $StagingSite)
    if ($left.Count -eq 0) { throw "Refusing to leave '$StagingSite' with zero bindings - aborting (was $StagingHost ever added?)" }
    Info 'Staging bindings trimmed.'

    # The binding collision is gone now, so the prod sites can (re)start and
    # HTTP.sys will route apex/www to them instead of the old catch-all.
    Start-SiteIfStopped $ProdApiSite
    Start-SiteIfStopped $ProdWebSite
    Start-SiteIfStopped $StagingSite
    Get-Website | Select-Object Name, State | Format-Table -AutoSize | Out-String | Write-Host
    return
}

# =============================================================================
# 1. Folders
# =============================================================================
Info 'Creating production folder layout'
foreach ($d in @($ProdWebRoot, $ProdApiRoot, 'C:\deploy\incoming-prod', 'C:\deploy\staging-prod')) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# =============================================================================
# 2. App pools
# =============================================================================
Info 'Creating production app pools'
foreach ($pool in @($ProdWebPool, $ProdApiPool)) {
    if (-not (Test-Path "IIS:\AppPools\$pool")) { New-WebAppPool -Name $pool | Out-Null }
    Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ''
    Set-ItemProperty "IIS:\AppPools\$pool" -Name startMode -Value 'AlwaysRunning'
}

# =============================================================================
# 3. Sites
# =============================================================================
Info 'Creating production IIS sites'
if (-not (Get-Website -Name $ProdApiSite -ErrorAction SilentlyContinue)) {
    New-Website -Name $ProdApiSite -PhysicalPath $ProdApiRoot -ApplicationPool $ProdApiPool `
        -IPAddress '127.0.0.1' -Port $ProdApiPort | Out-Null
} else {
    Set-ItemProperty "IIS:\Sites\$ProdApiSite" -Name physicalPath -Value $ProdApiRoot
}

if (-not (Get-Website -Name $ProdWebSite -ErrorAction SilentlyContinue)) {
    New-Website -Name $ProdWebSite -PhysicalPath $ProdWebRoot -ApplicationPool $ProdWebPool `
        -HostHeader $ProdHosts[0] -Port 80 | Out-Null
} else {
    Set-ItemProperty "IIS:\Sites\$ProdWebSite" -Name physicalPath -Value $ProdWebRoot
}

function Add-HttpBinding {
    param([string]$Site, [string]$HostHeader)
    $existing = Get-WebBinding -Name $Site -Protocol http | Where-Object {
        ($_.bindingInformation -split ':', 3)[2] -eq $HostHeader
    }
    if (-not $existing) {
        Info "  http binding $HostHeader -> $Site"
        New-WebBinding -Name $Site -Protocol http -Port 80 -HostHeader $HostHeader
    }
}

# =============================================================================
# 4. TLS: SNI 443 bindings reusing the certificate already on the box
# =============================================================================
Info 'Resolving the existing origin certificate'
$ssl = Get-ChildItem IIS:\SslBindings | Where-Object { $_.Port -eq 443 } | Select-Object -First 1
if (-not $ssl) { throw 'No existing 443 SSL binding found to copy the certificate from.' }
$store = if ($ssl.Store) { $ssl.Store } else { 'My' }
$cert = Get-Item "Cert:\LocalMachine\$store\$($ssl.Thumbprint)"
Info "  using cert $($ssl.Thumbprint) from LocalMachine\$store"

function Add-HttpsSniBinding {
    param([string]$Site, [string]$HostHeader)
    $existing = Get-WebBinding -Name $Site -Protocol https | Where-Object {
        ($_.bindingInformation -split ':', 3)[2] -eq $HostHeader
    }
    if (-not $existing) {
        Info "  https (SNI) binding $HostHeader -> $Site"
        New-WebBinding -Name $Site -Protocol https -Port 443 -HostHeader $HostHeader -SslFlags 1
    }
    $sslPath = "IIS:\SslBindings\!443!$HostHeader"
    if (-not (Test-Path $sslPath)) {
        $cert | New-Item -Path $sslPath -SSLFlags 1 | Out-Null
    }
}

foreach ($h in $ProdHosts) {
    Add-HttpBinding     -Site $ProdWebSite -HostHeader $h
    Add-HttpsSniBinding -Site $ProdWebSite -HostHeader $h
}

Info "Adding $StagingHost bindings to the staging site"
Add-HttpBinding     -Site $StagingSite -HostHeader $StagingHost
Add-HttpsSniBinding -Site $StagingSite -HostHeader $StagingHost

# =============================================================================
# 5. SQL: production database + app-pool login/grant
# =============================================================================
Info "Ensuring database [$ProdDatabase] and the prod app-pool grant"
Invoke-Sql -Database 'master' -Query @"
IF DB_ID(N'$ProdDatabase') IS NULL CREATE DATABASE [$ProdDatabase];
"@
Invoke-Sql -Database 'master' -Query @"
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'IIS APPPOOL\$ProdApiPool')
    CREATE LOGIN [IIS APPPOOL\$ProdApiPool] FROM WINDOWS;
"@
Invoke-Sql -Database $ProdDatabase -Query @"
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'IIS APPPOOL\$ProdApiPool')
    CREATE USER [IIS APPPOOL\$ProdApiPool] FOR LOGIN [IIS APPPOOL\$ProdApiPool];
ALTER ROLE [db_owner] ADD MEMBER [IIS APPPOOL\$ProdApiPool];
"@

# =============================================================================
# 6. appsettings.Production.json for the prod API (clone + new DB + fresh JWT key)
# =============================================================================
$prodSettings = Join-Path $ProdApiRoot 'appsettings.Production.json'
if (Test-Path $prodSettings) {
    Info 'appsettings.Production.json already exists for prod - leaving it untouched.'
} else {
    Info 'Generating prod appsettings.Production.json from the staging copy'
    $stagingSettings = Join-Path $StagingApiRoot 'appsettings.Production.json'
    if (-not (Test-Path $stagingSettings)) { throw "Staging settings not found at $stagingSettings" }
    $json = [System.IO.File]::ReadAllText($stagingSettings) | ConvertFrom-Json

    # Same server, its own database.
    $cs = [string]$json.ConnectionStrings.DefaultConnection
    if (-not $cs) { throw 'Staging settings have no ConnectionStrings.DefaultConnection' }
    $json.ConnectionStrings.DefaultConnection = ($cs -replace 'Database=[^;]+', "Database=$ProdDatabase")

    # Fresh signing key so staging tokens can never be replayed against prod.
    $bytes = New-Object byte[] 64
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $json.Jwt.Key = [Convert]::ToBase64String($bytes)

    $out = $json | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($prodSettings, $out, (New-Object System.Text.UTF8Encoding($false)))
    Info '  written (DB + fresh JWT key; other settings cloned).'
}

# =============================================================================
# 7. Daily backups for BOTH databases (idempotent re-register)
# =============================================================================
$registerScript = Join-Path $PSScriptRoot 'Register-BackupTask.ps1'
if (Test-Path $registerScript) {
    Info 'Registering daily backup tasks (staging + prod databases)'
    & $registerScript -Server $SqlServer -Database 'ZeroBudget'    -TaskName 'ZeroBudget-DbBackup'
    & $registerScript -Server $SqlServer -Database $ProdDatabase   -TaskName 'ZeroBudget-Prod-DbBackup'
} else {
    Write-Warning "Register-BackupTask.ps1 not found next to this script - backup tasks NOT registered."
}

# =============================================================================
# 8. Make sure every site is actually running
# =============================================================================
Start-SiteIfStopped $ProdApiSite
Start-SiteIfStopped $ProdWebSite
Start-SiteIfStopped $StagingSite
Get-Website | Select-Object Name, State | Format-Table -AutoSize | Out-String | Write-Host

Info 'Production provisioning complete.'
Write-Host @"

Next steps:
  1. Approve the pending 'production' deploy job (or re-run the Deploy workflow) so the
     prod stack gets its first build; Deploy.ps1 health-checks http://127.0.0.1:$ProdApiPort/health.
  2. Apply the Cloudflare changes (deploy/Setup-Cloudflare.ps1 + docs/deployment/staging-prod.md):
     staging WAF allowlist + DNS, then move apex/www off the coming-soon Worker onto the origin.
  3. AFTER DNS is flipped, re-run this script with -TrimStagingBindings.
"@ -ForegroundColor Green
