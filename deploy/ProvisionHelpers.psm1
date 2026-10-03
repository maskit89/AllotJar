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

<#
.SYNOPSIS
    The byte count in `rclone size --json` output, checked against the local file's size.
    Throws when the JSON is unreadable or the sizes differ; returns the remote byte count
    otherwise. Lives here (not inline in Upload-BackupToR2.ps1) so a test can drive it: the
    inline version assigned the parsed object to `$remote`, which PowerShell treats as the
    same variable as that script's `[string]$Remote` parameter (names ignore case), so the
    [string] constraint turned the object into text and EVERY upload failed its own check.
#>
function Assert-R2SizeMatches {
    param(
        [Parameter(Mandatory)][string]$SizeJson,
        [Parameter(Mandatory)][int64]$LocalBytes,
        [Parameter(Mandatory)][string]$Name
    )
    $sizeInfo = $SizeJson | ConvertFrom-Json
    if ($null -eq $sizeInfo -or $null -eq $sizeInfo.bytes) {
        throw "Post-upload verify failed: rclone's size answer for $Name has no byte count: $SizeJson"
    }
    if ([int64]$sizeInfo.bytes -ne $LocalBytes) {
        throw "Post-upload verify failed: local $LocalBytes bytes vs remote $($sizeInfo.bytes) bytes for $Name."
    }
    return [int64]$sizeInfo.bytes
}

<#
.SYNOPSIS
    T-SQL (idempotent) that lets the account a backup task runs as take backups, in two
    batches because the second must run inside the database being backed up.
    Get-BackupLoginSql (run in master): a Windows login for the account, and CREATE ANY
    DATABASE, which RESTORE VERIFYONLY needs. Get-BackupDbUserSql (run in the target
    database): a user for that login in the db_backupoperator role, which BACKUP DATABASE
    needs. The task runs as NT AUTHORITY\SYSTEM, which SQL Server 2012 and later no longer
    makes a sysadmin: on the production VPS its login existed with no rights at all, so every
    nightly run failed at BACKUP. Least privilege: no sysadmin.
#>
function Get-BackupLoginSql {
    param([string]$Account = 'NT AUTHORITY\SYSTEM')
    $q = $Account.Replace("'", "''")
    $id = $Account.Replace(']', ']]')
    return @"
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'$q')
    CREATE LOGIN [$id] FROM WINDOWS;
GRANT CREATE ANY DATABASE TO [$id];
"@
}

function Get-BackupDbUserSql {
    param([string]$Account = 'NT AUTHORITY\SYSTEM')
    $q = $Account.Replace("'", "''")
    $id = $Account.Replace(']', ']]')
    return @"
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$q')
    CREATE USER [$id] FOR LOGIN [$id];
IF IS_ROLEMEMBER(N'db_backupoperator', N'$q') <> 1
    ALTER ROLE [db_backupoperator] ADD MEMBER [$id];
"@
}

Export-ModuleMember -Function Test-HostCoveredByDnsNames, Get-SslBindingAction, New-BackupTaskArgumentLine, Get-R2BucketFromArgumentLine, Assert-R2SizeMatches, Get-BackupLoginSql, Get-BackupDbUserSql
