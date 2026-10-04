<#
.SYNOPSIS
    Register a Scheduled Task that checks the API's /health every few minutes and reports to a
    dead-man's-switch URL (a healthchecks.io check). Run once on the VPS as an administrator.
    Idempotent (-Force): re-run it to change the URL, the port or the interval.

.DESCRIPTION
    The API's error alerts (ErrorAlerts in appsettings) email about errors the API can see. They
    cannot say the API is down, the app pool stopped, or the VPS is off: nothing runs to send
    them. This task closes that gap from the outside in the same free way the nightly backup is
    watched: a check that expects a ping every -IntervalMinutes and emails when one is late.

    Create the check first (healthchecks.io: period = the interval, grace = a few minutes, your
    email as the integration) and pass its ping URL as -PingUrl. Then:

        .\Register-HealthPingTask.ps1 -PingUrl https://hc-ping.com/<uuid>              # production (port 5001)
        .\Register-HealthPingTask.ps1 -PingUrl https://hc-ping.com/<uuid> -HealthUrl http://127.0.0.1:5000/health -TaskName ZeroBudget-Staging-HealthPing

    Copies Ping-Health.ps1 to -InstallDir, as Register-BackupTask.ps1 does, so a deploy's wipe of
    the staging folder cannot break the task.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$PingUrl,
    [string]$HealthUrl       = 'http://127.0.0.1:5001/health',  # production API; staging is 5000
    [int]   $IntervalMinutes = 5,
    [string]$TaskName        = 'ZeroBudget-Prod-HealthPing',
    [string]$InstallDir      = 'C:\deploy',
    [string]$PingScript                                           # default: Ping-Health.ps1 beside this script
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty inside a param() default under `powershell -File` on Windows PowerShell 5.1.
if (-not $PingScript) { $PingScript = Join-Path $PSScriptRoot 'Ping-Health.ps1' }
if (-not (Test-Path $PingScript)) { throw "Ping script not found: $PingScript" }
if ($IntervalMinutes -lt 1) { throw "-IntervalMinutes must be at least 1." }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir 'Ping-Health.ps1'
Copy-Item $PingScript $target -Force

$argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -PingUrl "{1}" -HealthUrl "{2}"' -f $target, $PingUrl, $HealthUrl

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
# A repeating trigger: starts a minute from now and repeats for the task's whole life.
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
# The task only reads two URLs, so it runs as a low-privilege built-in account, not SYSTEM.
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

# Read the task back: the assertion is about what the scheduler will actually run.
$stored = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$storedArgs = ($stored.Actions | Select-Object -First 1).Arguments
if ($storedArgs -notlike "*$PingUrl*") { throw "Task '$TaskName' was registered WITHOUT the ping URL: $storedArgs" }

Write-Host "Scheduled task '$TaskName' registered: every $IntervalMinutes min, GET $HealthUrl then ping $PingUrl (or /fail)." -ForegroundColor Green
Write-Host "Test it now with:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "then confirm the check went green. Stop the API's app pool once to see the /fail ping turn it red."
