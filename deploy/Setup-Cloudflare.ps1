<#
.SYNOPSIS
    Applies the Cloudflare zone changes for the staging/production topology:
      * a WAF custom rule that BLOCKS staging.allotjar.com for every IP not on
        the allowlist (applied BEFORE the staging DNS record so the host is
        never exposed unfiltered)
      * DNS: proxied A record for staging; proxied A records for apex + www
        (the production app); deletes the retired app.allotjar.com record

.DESCRIPTION
    Needs a Cloudflare API token scoped to the zone with:
      Zone -> DNS  -> Edit
      Zone -> Zone WAF -> Edit
    Create it at dash.cloudflare.com -> My Profile -> API Tokens, run this, then
    revoke the token.

    NOTE: removing the coming-soon Worker's custom domains (apex + www) is NOT
    done here - it needs an account-scoped Workers permission. Remove them in the
    dashboard first (Workers & Pages -> allotjar-coming-soon -> Settings ->
    Domains & Routes -> remove allotjar.com and www.allotjar.com), otherwise the
    apex/www DNS upserts below fail because the Worker owns those hostnames.

    Phases:
      staging     WAF allowlist rule + staging DNS record
      production  apex/www A records + delete the app record (run AFTER the
                  Worker custom domains are removed and the prod stack answers)
      all         both, in that order

.EXAMPLE
    .\Setup-Cloudflare.ps1 -ApiToken $token -OriginIp <vps-ip> -AllowedIps <admin-ip> -Phase staging
    .\Setup-Cloudflare.ps1 -ApiToken $token -OriginIp <vps-ip> -AllowedIps <admin-ip> -Phase production
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ApiToken,
    [string]$Zone       = 'allotjar.com',
    # No origin IP is committed to the repo: pass -OriginIp <addr> at run time. Publishing the
    # origin address lets an attacker target the VPS directly and skip Cloudflare's edge.
    [Parameter(Mandatory = $true)][string]$OriginIp,
    [string]$StagingHost = 'staging.allotjar.com',
    # The staging allowlist source IP(s) — supply per run rather than committing them.
    [Parameter(Mandatory = $true)][string[]]$AllowedIps,
    [ValidateSet('staging', 'production', 'all')][string]$Phase = 'all'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$api = 'https://api.cloudflare.com/client/v4'
$headers = @{ Authorization = "Bearer $ApiToken"; 'Content-Type' = 'application/json' }
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

function Invoke-Cf {
    param([string]$Method, [string]$Path, $Body = $null)
    $args = @{ Method = $Method; Uri = "$api$Path"; Headers = $headers }
    if ($null -ne $Body) { $args.Body = ($Body | ConvertTo-Json -Depth 20) }
    $resp = Invoke-RestMethod @args
    if (-not $resp.success) { throw "Cloudflare API error on $Method $Path : $($resp.errors | ConvertTo-Json -Depth 5)" }
    return $resp.result
}

Info "Resolving zone id for $Zone"
$zoneInfo = Invoke-Cf GET "/zones?name=$Zone"
if (-not $zoneInfo) { throw "Zone $Zone not found (token missing Zone Read?)" }
$zoneId = $zoneInfo[0].id
Info "  zone id $zoneId"

function Set-DnsARecord {
    param([string]$Name, [string]$Ip, [bool]$Proxied = $true)
    $fqdn = if ($Name -eq '@') { $Zone } else { "$Name.$Zone" }
    $existing = Invoke-Cf GET "/zones/$zoneId/dns_records?name=$fqdn&type=A"
    $body = @{ type = 'A'; name = $fqdn; content = $Ip; ttl = 1; proxied = $Proxied }
    if ($existing) {
        Info "  updating A $fqdn -> $Ip (proxied=$Proxied)"
        Invoke-Cf PUT "/zones/$zoneId/dns_records/$($existing[0].id)" $body | Out-Null
    } else {
        Info "  creating A $fqdn -> $Ip (proxied=$Proxied)"
        Invoke-Cf POST "/zones/$zoneId/dns_records" $body | Out-Null
    }
}

function Remove-DnsRecord {
    param([string]$Fqdn)
    $existing = Invoke-Cf GET "/zones/$zoneId/dns_records?name=$Fqdn"
    if ($existing) {
        foreach ($r in $existing) {
            Info "  deleting $($r.type) $Fqdn"
            Invoke-Cf DELETE "/zones/$zoneId/dns_records/$($r.id)" | Out-Null
        }
    } else {
        Info "  no DNS record for $Fqdn (already gone)"
    }
}

# -----------------------------------------------------------------------------
# Phase: staging - WAF allowlist FIRST, then the DNS record
# -----------------------------------------------------------------------------
if ($Phase -in @('staging', 'all')) {
    $ruleDescription = 'staging-ip-allowlist'
    $ipList = ($AllowedIps | ForEach-Object { $_ }) -join ' '
    $expression = "(http.host eq `"$StagingHost`" and not ip.src in {$ipList})"

    Info "Upserting WAF custom rule '$ruleDescription': block $StagingHost except {$ipList}"
    $ruleset = $null
    try {
        $ruleset = Invoke-Cf GET "/zones/$zoneId/rulesets/phases/http_request_firewall_custom/entrypoint"
    } catch {
        # No entrypoint ruleset yet - create it with our rule in one go.
    }
    $rule = @{ description = $ruleDescription; expression = $expression; action = 'block'; enabled = $true }
    if (-not $ruleset) {
        Invoke-Cf POST "/zones/$zoneId/rulesets" @{
            name  = 'zone custom firewall'
            kind  = 'zone'
            phase = 'http_request_firewall_custom'
            rules = @($rule)
        } | Out-Null
        Info '  created the custom-rules ruleset with the allowlist rule.'
    } else {
        $existingRule = $ruleset.rules | Where-Object { $_.description -eq $ruleDescription }
        if ($existingRule) {
            Invoke-Cf PATCH "/zones/$zoneId/rulesets/$($ruleset.id)/rules/$($existingRule.id)" $rule | Out-Null
            Info '  updated the existing allowlist rule.'
        } else {
            Invoke-Cf POST "/zones/$zoneId/rulesets/$($ruleset.id)/rules" $rule | Out-Null
            Info '  appended the allowlist rule.'
        }
    }

    Info 'Staging DNS'
    Set-DnsARecord -Name 'staging' -Ip $OriginIp -Proxied $true
    Info 'Staging phase done.'
}

# -----------------------------------------------------------------------------
# Phase: production - apex/www onto the origin, retire app.
# Prerequisite: the coming-soon Worker's custom domains are already removed.
# -----------------------------------------------------------------------------
if ($Phase -in @('production', 'all')) {
    Info 'Production DNS (apex + www -> origin; app retired)'
    Set-DnsARecord -Name '@'   -Ip $OriginIp -Proxied $true
    Set-DnsARecord -Name 'www' -Ip $OriginIp -Proxied $true
    Remove-DnsRecord -Fqdn "app.$Zone"
    Info 'Production phase done.'
}

Info 'Cloudflare setup complete.'
