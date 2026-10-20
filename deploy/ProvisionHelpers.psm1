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
    The connection string with its Database= (or Initial Catalog=) pointed at $Database.
    Throws when the string names no database, so a settings file can never be rewritten
    into one that silently falls back to the login's default database.
#>
function Set-ConnectionStringDatabase {
    param(
        [Parameter(Mandatory)][string]$ConnectionString,
        [Parameter(Mandatory)][string]$Database
    )
    if ($ConnectionString -notmatch '(?i)(^|;)\s*(Database|Initial Catalog)\s*=') {
        throw "Connection string names no database (no Database= or Initial Catalog=): $ConnectionString"
    }
    return [regex]::Replace($ConnectionString, '(?i)((?:^|;)\s*(?:Database|Initial Catalog)\s*=)[^;]*', ('${1}' + $Database))
}

<#
.SYNOPSIS
    The ANCM web.config (as emitted by `dotnet publish`) with <aspNetCore> carrying the
    environment variable $Name=$Value. Creates <environmentVariables> when absent and
    replaces the value when the variable is already there, so a deploy can pin
    ASPNETCORE_ENVIRONMENT per stack (Staging reads appsettings.Staging.json, Production
    appsettings.Production.json) without a hand-edited web.config on the server.
#>
function Set-AncmEnvironmentVariable {
    param(
        [Parameter(Mandatory)][string]$WebConfigXml,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Value
    )
    $doc = New-Object System.Xml.XmlDocument
    $doc.LoadXml($WebConfigXml)
    $aspNetCore = $doc.SelectSingleNode('/configuration/location/system.webServer/aspNetCore')
    if (-not $aspNetCore) { $aspNetCore = $doc.SelectSingleNode('/configuration/system.webServer/aspNetCore') }
    if (-not $aspNetCore) { throw 'web.config has no <aspNetCore> element: is this the API''s ANCM web.config?' }

    $vars = $aspNetCore.SelectSingleNode('environmentVariables')
    if (-not $vars) {
        $vars = $doc.CreateElement('environmentVariables')
        [void]$aspNetCore.AppendChild($vars)
    }
    $var = $vars.SelectNodes('environmentVariable') | Where-Object { $_.GetAttribute('name') -eq $Name } | Select-Object -First 1
    if (-not $var) {
        $var = $doc.CreateElement('environmentVariable')
        $var.SetAttribute('name', $Name)
        [void]$vars.AppendChild($var)
    }
    $var.SetAttribute('value', $Value)

    # Serialise through a MemoryStream, not a StringWriter: XmlWriter takes a TextWriter's
    # encoding (a StringWriter says UTF-16), so the declaration would read encoding="utf-16"
    # while the callers write UTF-8 bytes, and IIS could not parse the file (500.19).
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Indent = $true
    $settings.OmitXmlDeclaration = $false
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $ms = New-Object System.IO.MemoryStream
    $writer = [System.Xml.XmlWriter]::Create($ms, $settings)
    $doc.Save($writer)
    $writer.Close()
    return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
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
    # PSObject.Properties, not .bytes: a missing property throws under Set-StrictMode.
    if ($null -eq $sizeInfo -or -not $sizeInfo.PSObject.Properties['bytes'] -or $null -eq $sizeInfo.bytes) {
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
IF EXISTS (SELECT 1 FROM sys.databases WHERE name = DB_NAME() AND owner_sid = SUSER_SID(N'$q'))
    RETURN; -- the account owns this database (it maps to dbo), which can already back it up
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$q')
    CREATE USER [$id] FOR LOGIN [$id];
IF IS_ROLEMEMBER(N'db_backupoperator', N'$q') <> 1
    ALTER ROLE [db_backupoperator] ADD MEMBER [$id];
"@
}

<#
.SYNOPSIS
    Plan the MOVE clauses for restoring a backup onto -Database, so that a restore onto a
    DIFFERENT database on the SAME instance never points at the source database's live files.

.DESCRIPTION
    A .bak carries the SOURCE database's physical file names (ZeroBudgetProd.mdf, ...). Restoring
    it onto another database with "MOVE ... TO <default data folder>\<same leaf>" targets the files
    the live source database is using, and SQL Server refuses (error 1834/3156). So:
      - when the target database exists and has the same number of data and log files as the
        backup, each backup file is moved onto the target's OWN existing file, in file order
        (data onto ROWS files, log onto LOG files): the target keeps its files, nothing else is touched;
      - otherwise the target gets fresh names in the instance's default folders:
        <Database>.mdf, <Database>_<n>.ndf, <Database>_log.ldf, <Database>_log<n>.ldf.
    Every planned destination is then checked against the other databases' files (-OtherFiles) and
    the function throws if any would overwrite one of them.

    Pure: takes rows (RESTORE FILELISTONLY, sys.master_files) and returns the plan; runs no SQL.
#>
function Get-RestoreFileMoves {
    param(
        [Parameter(Mandatory)][string]$Database,
        # RESTORE FILELISTONLY rows: LogicalName, PhysicalName, Type ('D' data, 'L' log, other = data).
        [Parameter(Mandatory)][object[]]$BackupFiles,
        # sys.master_files rows of the TARGET database: type_desc ('ROWS' / 'LOG'), physical_name. Empty when it does not exist.
        [object[]]$TargetFiles = @(),
        # sys.master_files rows of every OTHER database: db, physical_name.
        [object[]]$OtherFiles = @(),
        [Parameter(Mandatory)][string]$DataDir,
        [string]$LogDir
    )
    if (-not $LogDir) { $LogDir = $DataDir }
    # Not Join-Path: this also runs in the CI tests on Linux, where a Windows drive letter is not a PSDrive.
    function Join-WinPath([string]$dir, [string]$leaf) { return $dir.TrimEnd('\', '/') + '\' + $leaf }
    $bakData = @($BackupFiles | Where-Object { [string]$_.Type -ne 'L' })
    $bakLogs = @($BackupFiles | Where-Object { [string]$_.Type -eq 'L' })
    $ownRows = @($TargetFiles | Where-Object { [string]$_.type_desc -eq 'ROWS' } | ForEach-Object { [string]$_.physical_name })
    $ownLogs = @($TargetFiles | Where-Object { [string]$_.type_desc -eq 'LOG' }  | ForEach-Object { [string]$_.physical_name })
    $reuse = ($TargetFiles.Count -gt 0) -and ($ownRows.Count -eq $bakData.Count) -and ($ownLogs.Count -eq $bakLogs.Count)

    $moves = New-Object System.Collections.Generic.List[string]
    $targets = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $bakData.Count; $i++) {
        $dest = if ($reuse) { $ownRows[$i] }
                elseif ($i -eq 0) { Join-WinPath $DataDir "$Database.mdf" }
                else { Join-WinPath $DataDir ('{0}_{1}.ndf' -f $Database, $i) }
        $moves.Add(("MOVE N'{0}' TO N'{1}'" -f ([string]$bakData[$i].LogicalName).Replace("'", "''"), $dest.Replace("'", "''")))
        $targets.Add($dest)
    }
    for ($i = 0; $i -lt $bakLogs.Count; $i++) {
        $dest = if ($reuse) { $ownLogs[$i] }
                elseif ($i -eq 0) { Join-WinPath $LogDir "${Database}_log.ldf" }
                else { Join-WinPath $LogDir ('{0}_log{1}.ldf' -f $Database, $i) }
        $moves.Add(("MOVE N'{0}' TO N'{1}'" -f ([string]$bakLogs[$i].LogicalName).Replace("'", "''"), $dest.Replace("'", "''")))
        $targets.Add($dest)
    }
    foreach ($t in $targets) {
        $hit = @($OtherFiles | Where-Object { [string]$_.physical_name -ieq $t })
        if ($hit.Count -gt 0) {
            throw "Refusing to restore: $t is a live file of database [$($hit[0].db)], not of [$Database]."
        }
    }
    return [pscustomobject]@{
        Moves             = @($moves)
        Targets           = @($targets)
        ReusedTargetFiles = $reuse
    }
}

<#
.SYNOPSIS
    The ways a stack's server-side settings file (appsettings.<Env>.json, read as TEXT because
    the files carry // comments) would make that stack act as the OTHER one: a connection
    string naming the other stack's database, or an Email:AppBaseUrl that puts the other
    stack's origin into every emailed link (password reset, invite). An empty array means the
    file fits the stack. Deploy.ps1 runs this in its preflight, before the API is taken
    offline, so a wrong file stops the deploy while the stack keeps running its old build.

    Email:AppBaseUrl is REQUIRED for the staging stack: the API's built-in default is the
    production origin, so a staging file that omits it emails links that open production
    (where the reset token, signed with staging's DataProtection keys, is not valid). This
    is exactly what happened on 12 October 2026. Production may omit it (the default is its
    own origin) but must not name staging.
#>
function Get-StackSettingsProblems {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$SettingsText,
        [Parameter(Mandatory)][ValidateSet('Staging', 'Production')][string]$AspNetEnvironment,
        # The stack's own values; the defaults are the names in docs/deployment/staging-prod.md.
        [string]$ExpectedDatabase = $(if ($AspNetEnvironment -eq 'Staging') { 'ZeroBudgetStaging' } else { 'ZeroBudgetProd' }),
        # Production is public at both www.allotjar.com and the apex, so either origin fits it.
        [string[]]$ExpectedAppBaseUrl = $(if ($AspNetEnvironment -eq 'Staging') { @('https://staging.allotjar.com') } else { @('https://www.allotjar.com', 'https://allotjar.com') })
    )
    $problems = @()
    # Drop whole-line // comments so a commented-out setting can neither satisfy nor fail a check.
    $text = [regex]::Replace($SettingsText, '(?m)^\s*//[^\r\n]*', '')

    $cs = [regex]::Match($text, '"DefaultConnection"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if (-not $cs.Success) {
        $problems += 'ConnectionStrings:DefaultConnection is missing, so the API would start with no connection string.'
    } else {
        $value = $cs.Groups[1].Value -replace '\\\\', '\'
        $db = if ($value -match '(?i)(?:^|;)\s*(?:Database|Initial Catalog)\s*=\s*([^;]*)') { $Matches[1].Trim() } else { '' }
        if (-not $db) {
            $problems += 'ConnectionStrings:DefaultConnection names no database (no Database= or Initial Catalog=).'
        } elseif ($db -ine $ExpectedDatabase) {
            $problems += "ConnectionStrings:DefaultConnection names Database=$db; the $AspNetEnvironment stack's database is $ExpectedDatabase."
        }
    }

    $urls = [regex]::Matches($text, '"AppBaseUrl"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($urls.Count -gt 1) {
        $problems += "Email:AppBaseUrl appears $($urls.Count) times; keep exactly one."
    } elseif ($urls.Count -eq 0) {
        if ($AspNetEnvironment -eq 'Staging') {
            $problems += "Email:AppBaseUrl is missing; the API's built-in default is https://www.allotjar.com, so every emailed link (password reset, invite) would open production. Set it to $($ExpectedAppBaseUrl[0]) in the Email section."
        }
    } else {
        $url = $urls[0].Groups[1].Value
        $origin = Get-UrlOrigin -Url $url
        $expected = @($ExpectedAppBaseUrl | ForEach-Object { Get-UrlOrigin -Url $_ })
        if (-not $origin) {
            $problems += "Email:AppBaseUrl '$url' is not an absolute http(s) URL."
        } elseif ($expected -notcontains $origin) {
            $problems += "Email:AppBaseUrl is $url, so every emailed link (password reset, invite) would open $origin; the $AspNetEnvironment stack's origin is $($ExpectedAppBaseUrl -join ' or ')."
        }
    }
    return ,$problems
}

<#
.SYNOPSIS
    scheme://host[:port] of an absolute http(s) URL, lower-cased, with any path dropped;
    $null when the value is not one. Lets two settings be compared as origins, so a trailing
    slash or a capital letter never counts as a mismatch.
#>
function Get-UrlOrigin {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Url)
    $uri = $null
    if (-not [Uri]::TryCreate($Url.Trim(), [UriKind]::Absolute, [ref]$uri)) { return $null }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return $null }
    return $uri.GetLeftPart([UriPartial]::Authority).ToLowerInvariant()
}

<#
.SYNOPSIS
    One value from one [section] of rclone.conf text, or $null when the section or key is
    absent. Pure text parsing so a test can drive it (rclone itself is not needed).
#>
function Get-RcloneConfValue {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$ConfText,
        [Parameter(Mandatory)][string]$Section,
        [Parameter(Mandatory)][string]$Key
    )
    $inSection = $false
    foreach ($line in ($ConfText -split "\r?\n")) {
        $t = $line.Trim()
        if ($t -match '^\[(.+)\]$') { $inSection = ($Matches[1] -ieq $Section); continue }
        if ($inSection -and $t -match '^([^=\s]+)\s*=\s*(.*)$' -and $Matches[1] -ieq $Key) { return $Matches[2].Trim() }
    }
    return $null
}

<#
.SYNOPSIS
    Why the encrypted backup remote in rclone.conf cannot be used (an empty list means it
    can). Backups go to R2 ONLY through a crypt remote that points at
    <Remote>:<Bucket>/<Prefix>: a missing remote, a different type, a different target (the
    plain prefix, another bucket) or readable file names would each ship unencrypted data or
    scatter it, so the upload refuses instead of falling back to plain text.
#>
function Get-BackupCryptRemoteProblems {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$ConfText,
        [Parameter(Mandatory)][string]$CryptRemote,
        [Parameter(Mandatory)][string]$Remote,
        [Parameter(Mandatory)][string]$Bucket,
        [Parameter(Mandatory)][string]$Prefix
    )
    $problems = @()
    $type = Get-RcloneConfValue -ConfText $ConfText -Section $CryptRemote -Key 'type'
    if (-not $type) {
        return @("rclone.conf has no [$CryptRemote] remote, so the backup would not be encrypted. Run Set-BackupEncryption.ps1 once (docs/deployment/README.md > Off-host backups).")
    }
    if ($type -ne 'crypt') { $problems += "[$CryptRemote] in rclone.conf is type '$type', not 'crypt'." }
    $want = "${Remote}:${Bucket}/${Prefix}"
    $has  = Get-RcloneConfValue -ConfText $ConfText -Section $CryptRemote -Key 'remote'
    if ($has -ne $want) { $problems += "[$CryptRemote] points at '$has', expected '$want'." }
    foreach ($k in 'password', 'password2') {
        if (-not (Get-RcloneConfValue -ConfText $ConfText -Section $CryptRemote -Key $k)) { $problems += "[$CryptRemote] has no $k (the encryption key and its salt)." }
    }
    $fe = Get-RcloneConfValue -ConfText $ConfText -Section $CryptRemote -Key 'filename_encryption'
    if ($fe -ne 'off') { $problems += "[$CryptRemote] filename_encryption is '$fe', expected 'off' (the .bak names stay readable so the newest backup can be found)." }
    return $problems
}

<#
.SYNOPSIS
    True when the file starts with rclone crypt's "RCLONE\0\0" magic: an encrypted download
    that was never decrypted. Migrate-FromBak.ps1 refuses these with a pointer to
    Get-BackupFromR2.ps1 instead of letting SQL Server fail on garbage.
#>
function Test-RcloneCryptFile {
    param([Parameter(Mandatory)][string]$Path)
    $magic = [byte[]](0x52, 0x43, 0x4C, 0x4F, 0x4E, 0x45, 0x00, 0x00)
    $buf = New-Object byte[] 8
    $fs = [System.IO.File]::OpenRead($Path)
    try { $n = $fs.Read($buf, 0, 8) } finally { $fs.Dispose() }
    if ($n -lt 8) { return $false }
    for ($i = 0; $i -lt 8; $i++) { if ($buf[$i] -ne $magic[$i]) { return $false } }
    return $true
}

<#
.SYNOPSIS
    `rclone obscure` of a secret, passed on STDIN with no trailing newline (a piped string
    would carry one, and rclone would obscure it as part of the password) so the secret never
    appears on a command line.
#>
function ConvertTo-RcloneObscured {
    param([Parameter(Mandatory)][string]$Rclone, [Parameter(Mandatory)][string]$Secret)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Rclone
    $psi.Arguments = 'obscure -'
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write($Secret)
    $proc.StandardInput.Close()
    $out = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0 -or -not $out.Trim()) { throw "rclone obscure failed (exit $($proc.ExitCode))." }
    return $out.Trim()
}

Export-ModuleMember -Function Test-HostCoveredByDnsNames, Get-SslBindingAction, New-BackupTaskArgumentLine, Get-R2BucketFromArgumentLine, Assert-R2SizeMatches, Get-BackupLoginSql, Get-BackupDbUserSql, Set-ConnectionStringDatabase, Set-AncmEnvironmentVariable, Get-RestoreFileMoves, Get-StackSettingsProblems, Get-UrlOrigin, Get-RcloneConfValue, Get-BackupCryptRemoteProblems, Test-RcloneCryptFile, ConvertTo-RcloneObscured
