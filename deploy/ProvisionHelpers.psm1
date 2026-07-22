<#
.SYNOPSIS
    Pure helper functions shared by the provisioning/backup scripts, extracted so the
    decision logic (wildcard cert coverage, SSL rebinds, backup-task argument lines) is
    unit-testable without IIS or the Task Scheduler. deploy/tests/Test-DeployHelpers.ps1
    exercises every function here; keep additions pure (no Get-Website / Get-ScheduledTask
    calls in this module).
#>

Set-StrictMode -Version Latest

<#
.SYNOPSIS
    True when a certificate valid for the given DNS names covers $HostHeader.
    A wildcard matches exactly one label and never the bare apex.
#>
function Test-HostCoveredByDnsNames {
    param(
        [string[]]$DnsNames,
        [Parameter(Mandatory)][string]$HostHeader
    )
    $h = $HostHeader.ToLowerInvariant()
    foreach ($n in @($DnsNames | Where-Object { $_ })) {
        $name = $n.ToLowerInvariant()
        if ($name -eq $h) { return $true }
        if ($name.StartsWith('*.')) {
            $suffix = $name.Substring(1)                    # '*.allotjar.com' -> '.allotjar.com'
            if ($h.EndsWith($suffix)) {
                $left = $h.Substring(0, $h.Length - $suffix.Length)
                # '*.allotjar.com' covers 'staging.allotjar.com' but NOT 'a.b.allotjar.com'
                # and NOT the bare apex 'allotjar.com'.
                if ($left -and $left.IndexOf('.') -lt 0) { return $true }
            }
        }
    }
    return $false
}

<#
.SYNOPSIS
    What to do with an SSL binding slot given what is bound now and what should be:
    'create' when nothing is bound, 'keep' when the right cert is already bound,
    'rebind' when a DIFFERENT cert is bound (the old behavior silently kept it —
    which is how a wrong cert survives a re-provision with the correct thumbprint).
#>
function Get-SslBindingAction {
    param(
        [string]$ExistingThumbprint,
        [Parameter(Mandatory)][string]$DesiredThumbprint
    )
    if (-not $ExistingThumbprint) { return 'create' }
    if ($ExistingThumbprint.ToUpperInvariant() -eq $DesiredThumbprint.ToUpperInvariant()) { return 'keep' }
    return 'rebind'
}

<#
.SYNOPSIS
    The scheduled-task argument line that runs Backup-Database.ps1 — with the off-host R2
    upload arguments when a bucket is given. Built here (not inline in Register-BackupTask)
    so a test can assert a production line ALWAYS carries -R2Bucket.
#>
function New-BackupTaskArgumentLine {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$Server,
        [Parameter(Mandatory)][string]$Database,
        [Parameter(Mandatory)][string]$BackupDir,
        [Parameter(Mandatory)][int]$RetentionDays,
        [string]$R2Bucket,
        [string]$Rclone,
        [string]$RcloneConf,
        [string]$R2Remote,
        [string]$R2Prefix
    )
    $line = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Server "{1}" -Database "{2}" -BackupDir "{3}" -RetentionDays {4}' -f `
        $ScriptPath, $Server, $Database, $BackupDir, $RetentionDays
    if ($R2Bucket) {
        $line += ' -R2Bucket "{0}" -Rclone "{1}" -RcloneConf "{2}" -R2Remote "{3}" -R2Prefix "{4}"' -f `
            $R2Bucket, $Rclone, $RcloneConf, $R2Remote, $R2Prefix
    }
    return $line
}

<#
.SYNOPSIS
    The R2 bucket named in a scheduled-task argument line, or $null when the line has no
    -R2Bucket. Lets provisioning PRESERVE an existing off-host backup configuration instead
    of silently downgrading the task to local-only.
#>
function Get-R2BucketFromArgumentLine {
    param([string]$ArgumentLine)
    if (-not $ArgumentLine) { return $null }
    if ($ArgumentLine -match '-R2Bucket\s+"([^"]+)"') { return $Matches[1] }
    if ($ArgumentLine -match "-R2Bucket\s+'([^']+)'") { return $Matches[1] }
    if ($ArgumentLine -match '-R2Bucket\s+([^\s"'']+)') { return $Matches[1] }
    return $null
}

Export-ModuleMember -Function Test-HostCoveredByDnsNames, Get-SslBindingAction, New-BackupTaskArgumentLine, Get-R2BucketFromArgumentLine
