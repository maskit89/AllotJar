<#
.SYNOPSIS
    Asks the API whether it is up and tells a dead-man's-switch URL the answer.
    Run by the Scheduled Task that Register-HealthPingTask.ps1 creates.

.DESCRIPTION
    GETs -HealthUrl (the API's /health/ready, which also asks the database). On 200 it pings
    -PingUrl; otherwise it pings <PingUrl>/fail. A healthchecks.io check with a 5-minute period and
    a 5-minute grace then emails when the API answers anything but 200, when it does not answer at
    all, and when this task itself stops running (the VPS is down, say) - the one failure the API's
    own error alerts can never report. Writes nothing locally: the Event Log already carries the
    API's failures and the check keeps the history of pings.

    A deploy takes the API offline for a minute (app_offline.htm, then startup migrations), and a
    pool recycle gives a cold start, so a single failed GET is not "down": the GET is retried
    -Attempts times, -RetrySeconds apart, and /fail is pinged only when every attempt failed. The
    whole run stays inside the task's time limit (3 attempts of 20 s plus 2 waits of 20 s is 100 s).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$PingUrl,
    [string]$HealthUrl    = 'http://127.0.0.1:5001/health/ready',
    [int]   $TimeoutSec   = 20,
    [int]   $Attempts     = 3,
    [int]   $RetrySeconds = 20
)

# Windows PowerShell 5.1 defaults to TLS 1.0/1.1, which https endpoints refuse.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$ok = $false
for ($attempt = 1; $attempt -le [Math]::Max(1, $Attempts); $attempt++) {
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec $TimeoutSec
        $ok = ($resp.StatusCode -eq 200)
    } catch {
        Write-Warning "Health check attempt $attempt failed at ${HealthUrl}: $_"
    }
    if ($ok) { break }
    if ($attempt -lt $Attempts) { Start-Sleep -Seconds $RetrySeconds }
}

$target = if ($ok) { $PingUrl } else { $PingUrl.TrimEnd('/') + '/fail' }
try { [void](Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $target) }
catch { Write-Warning "Could not reach -PingUrl: $_" }

if (-not $ok) { exit 1 }
