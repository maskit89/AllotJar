<#
.SYNOPSIS
    One-time bootstrap of a fresh Windows Server VPS to host ZeroBudget natively
    (IIS + ASP.NET Core Module + SQL Server Express + OpenSSH for CI/CD). It creates
    the STAGING stack (every name says staging); Provision-Production.ps1 adds the
    production stack next to it later.

.DESCRIPTION
    Idempotent: safe to re-run. Installs IIS + the modules the app needs
    (URL Rewrite, ARR, .NET Hosting Bundle), enables OpenSSH Server for the
    GitHub Actions SSH deploy, creates the two app pools + sites, the on-disk
    folder layout, and the firewall rules.

    Run as Administrator in an elevated PowerShell session over RDP:
        powershell -ExecutionPolicy Bypass -File .\Setup-Server.ps1

    NOT covered here (do these separately, see docs/deployment/README.md):
      * Install SQL Server Express + run Setup-Database.sql
      * Drop your real appsettings.Staging.json into the API folder (the staging API
        runs with ASPNETCORE_ENVIRONMENT=Staging, pinned by Deploy.ps1)
      * Generate the SSH deploy key and add the public half to the server
      * TLS via win-acme, and the public DNS A-record
#>
[CmdletBinding()]
param(
    # Leave blank to bind the site to the server IP over HTTP (no domain needed).
    # Pass a hostname later (and run win-acme) to add a domain + HTTPS.
    [string]$Domain      = '',
    [string]$WebRoot     = 'C:\inetpub\zerobudget-staging\web',
    [string]$ApiRoot     = 'C:\inetpub\zerobudget-staging\api',
    [string]$DeployRoot  = 'C:\deploy',
    [int]   $ApiPort     = 5000,
    [string]$WebSite     = 'ZeroBudget-Staging',
    [string]$ApiSite     = 'ZeroBudget-Staging-Api',
    [string]$WebPool     = 'ZeroBudget-Staging-Web',
    [string]$ApiPool     = 'ZeroBudget-Staging-Api',

    # External installers. URL Rewrite + ARR links are the long-stable Microsoft
    # download URLs. Verify the Hosting Bundle URL is the latest .NET 10 build.
    [string]$UrlRewriteUrl    = 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi',
    [string]$ArrUrl           = 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi',
    [string]$HostingBundleUrl = 'https://builds.dotnet.microsoft.com/dotnet/aspnetcore/Runtime/10.0.0/dotnet-hosting-10.0.0-win.exe'
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# --- 1. IIS role + features -------------------------------------------------
Info 'Installing IIS roles and features'
Enable-WindowsOptionalFeature -Online -NoRestart -All -FeatureName `
    IIS-WebServerRole, IIS-WebServer, IIS-CommonHttpFeatures, `
    IIS-StaticContent, IIS-DefaultDocument, IIS-HttpErrors, `
    IIS-HttpRedirect, IIS-ApplicationDevelopment, `
    IIS-HttpCompressionStatic, IIS-HttpCompressionDynamic, `
    IIS-Security, IIS-RequestFiltering, `
    IIS-ManagementConsole, IIS-ManagementScriptingTools | Out-Null

# --- 2. Helper: download + silently install an MSI/EXE ----------------------
function Install-Package {
    param([string]$Name, [string]$Url, [string]$SilentArgs)
    Info "Installing $Name"
    $ext  = if ($Url -match '\.msi($|\?)') { 'msi' } else { 'exe' }
    $file = Join-Path $env:TEMP ("zb_{0}.{1}" -f ($Name -replace '\W', ''), $ext)
    Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
    if ($ext -eq 'msi') {
        Start-Process msiexec.exe -ArgumentList "/i `"$file`" /quiet /norestart" -Wait
    } else {
        Start-Process $file -ArgumentList $SilentArgs -Wait
    }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
}

Install-Package -Name 'UrlRewrite'      -Url $UrlRewriteUrl
Install-Package -Name 'ARR'             -Url $ArrUrl
# The .NET Hosting Bundle ships the ASP.NET Core Module + runtime that IIS needs.
Install-Package -Name 'HostingBundle'   -Url $HostingBundleUrl -SilentArgs '/install /quiet /norestart'
Info 'Resetting IIS so the Hosting Bundle / ANCM is picked up'
net stop was /y 2>$null | Out-Null
iisreset /restart | Out-Null

# --- 3. Enable ARR server-level reverse proxy -------------------------------
Info 'Enabling ARR proxy at the server level'
Import-Module WebAdministration
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' `
    -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'

# --- 4. Folder layout -------------------------------------------------------
Info 'Creating folder layout'
foreach ($d in @($WebRoot, $ApiRoot, $DeployRoot, "$DeployRoot\incoming-staging", "$DeployRoot\release-staging")) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# --- 5. App pools (both "No Managed Code" - .NET Core doesn't load the CLR) --
Info 'Creating app pools'
foreach ($pool in @($WebPool, $ApiPool)) {
    if (-not (Test-Path "IIS:\AppPools\$pool")) { New-WebAppPool -Name $pool | Out-Null }
    Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ''
    Set-ItemProperty "IIS:\AppPools\$pool" -Name startMode -Value 'AlwaysRunning'
}

# --- 6. Sites ---------------------------------------------------------------
Info 'Creating IIS sites'
# Front site: public, serves the SPA + reverse-proxies /api. With no -Domain it
# binds to all hosts on :80 so it answers on the raw server IP.
if (-not (Get-Website -Name $WebSite -ErrorAction SilentlyContinue)) {
    if ([string]::IsNullOrWhiteSpace($Domain)) {
        New-Website -Name $WebSite -PhysicalPath $WebRoot -ApplicationPool $WebPool -Port 80 | Out-Null
    } else {
        New-Website -Name $WebSite -PhysicalPath $WebRoot -ApplicationPool $WebPool `
            -HostHeader $Domain -Port 80 | Out-Null
    }
} else {
    Set-ItemProperty "IIS:\Sites\$WebSite" -Name physicalPath -Value $WebRoot
}
# Remove the stock Default Web Site so it doesn't squat on port 80.
if (Get-Website -Name 'Default Web Site' -ErrorAction SilentlyContinue) {
    Remove-Website -Name 'Default Web Site'
}

# API site: internal only, bound to localhost:$ApiPort, hosted via ANCM.
if (-not (Get-Website -Name $ApiSite -ErrorAction SilentlyContinue)) {
    New-Website -Name $ApiSite -PhysicalPath $ApiRoot -ApplicationPool $ApiPool `
        -IPAddress '127.0.0.1' -Port $ApiPort | Out-Null
} else {
    Set-ItemProperty "IIS:\Sites\$ApiSite" -Name physicalPath -Value $ApiRoot
}

# --- 7. OpenSSH Server (used by the GitHub Actions deploy) ------------------
Info 'Installing and starting OpenSSH Server'
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
# Make PowerShell the default SSH shell so the deploy commands behave predictably.
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -PropertyType String -Force | Out-Null

# --- 8. Firewall ------------------------------------------------------------
# Web traffic reaches this box ONLY through Cloudflare, so scope 80/443 to Cloudflare's
# published edge ranges. That is what actually backstops the staging IP-allowlist: the
# Cloudflare WAF rule is edge-only and is bypassed by connecting straight to the origin IP,
# so without this host rule a direct hit reaches IIS unfiltered. SSH (22) stays open for the
# GitHub Actions deploy — tighten it to a known admin/bastion IP if you can.
Info 'Fetching Cloudflare IP ranges'
try {
    $cfRanges = @()
    foreach ($u in @('https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6')) {
        $body = Invoke-RestMethod -Uri $u
        $cfRanges += ($body -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
}
catch {
    throw "Could not fetch Cloudflare IP ranges ($_). Refusing to open 80/443 to the whole internet; re-run when online."
}
if ($cfRanges.Count -lt 1) {
    throw 'Cloudflare IP range list was empty; aborting rather than opening 80/443 to Any.'
}

Info "Restricting web ports 80/443 to $($cfRanges.Count) Cloudflare ranges"
foreach ($p in @(80, 443)) {
    $name = "ZeroBudget-TCP-$p"
    # Recreate each run so re-provisioning re-applies the scope. Windows Allow rules union,
    # so an older Allow-from-Any rule would otherwise linger and defeat the restriction.
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $p -RemoteAddress $cfRanges | Out-Null
}

Info 'Opening firewall port 22 (SSH, for the deploy pipeline)'
$sshName = 'ZeroBudget-TCP-22'
if (-not (Get-NetFirewallRule -DisplayName $sshName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $sshName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort 22 | Out-Null
}

Info 'Server setup complete.'
$tlsNote = if ([string]::IsNullOrWhiteSpace($Domain)) {
    "  4. (Later) point a domain at this VPS, re-run with -Domain, then run win-acme (wacs.exe) for HTTPS."
} else {
    "  4. Point DNS A-record '$Domain' at this VPS, then run win-acme (wacs.exe) for TLS."
}
Write-Host @"

Next steps (see docs/deployment/README.md):
  1. Install SQL Server Express, then run:  sqlcmd -S .\SQLEXPRESS -E -i Setup-Database.sql
  2. Copy appsettings.Production.json.example -> $ApiRoot\appsettings.Staging.json and fill in secrets
     (Database=ZeroBudgetStaging; the staging API runs as ASPNETCORE_ENVIRONMENT=Staging).
  3. Add your CI public key to C:\ProgramData\ssh\administrators_authorized_keys.
$tlsNote
"@ -ForegroundColor Green
