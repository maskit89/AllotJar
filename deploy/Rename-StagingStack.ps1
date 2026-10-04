<#
.SYNOPSIS
    One-time, idempotent rename of the STAGING stack on the VPS so that everything that
    belongs to staging says staging. Production is not touched. Run ON THE VPS in an
    elevated PowerShell, from a copy of the deploy folder:

        powershell -ExecutionPolicy Bypass -File .\Rename-StagingStack.ps1 -Check   # report only
        powershell -ExecutionPolicy Bypass -File .\Rename-StagingStack.ps1          # rename

.DESCRIPTION
    Before the GA cutover the staging stack WAS the only stack, so its names carry no
    environment at all ("ZeroBudget", C:\inetpub\zerobudget, database ZeroBudget), and its
    settings file is called appsettings.Production.json because ASP.NET Core defaults the
    environment to Production when nothing sets it. Next to a production stack whose names
    say "Prod", that reads as if staging were production. This script renames, in place and
    keeping all data and settings:

        IIS sites       ZeroBudget / ZeroBudget-Api        -> ZeroBudget-Staging / ZeroBudget-Staging-Api
        app pools       ZeroBudget-Web / ZeroBudget-Api    -> ZeroBudget-Staging-Web / ZeroBudget-Staging-Api
        folders         C:\inetpub\zerobudget\{api,web}    -> C:\inetpub\zerobudget-staging\{api,web}
        settings        appsettings.Production.json        -> appsettings.Staging.json (same contents,
                        plus ASPNETCORE_ENVIRONMENT=Staging pinned in the API's web.config so it is read)
        database        ZeroBudget                         -> ZeroBudgetStaging (ALTER DATABASE ... MODIFY NAME;
                        the data files stay where they are; the connection string is updated)
        SQL login       IIS APPPOOL\ZeroBudget-Api         -> IIS APPPOOL\ZeroBudget-Staging-Api (db_owner)
        backup task     ZeroBudget-DbBackup                -> ZeroBudget-Staging-DbBackup (local-only, as before)
        deploy scratch  C:\deploy\{incoming,staging,incoming-prod,staging-prod} removed; the Deploy
                        workflow recreates C:\deploy\{incoming,release}-{staging,production}

    Staging is offline for the minute this takes (its pools are stopped so the folder can
    move and the database can be renamed). Production's sites, pools, folders, database,
    settings and backup task are never read for writing; the script refuses to run if any
    target name collides with the production names, and checks production's /health
    before and after.

    Idempotent: each step looks at what exists and skips what is already renamed, so a
    failed run can be re-run after fixing the cause. -Check reports the state of every
    component and changes nothing.

    Run this BEFORE merging the pull request that renames the workflow (or right after: the
    first staging deploy under the new names fails its preflight until this has run, and
    production is unaffected either way).
#>
[CmdletBinding()]
param(
    [switch]$Check,

    [string]$OldRoot       = 'C:\inetpub\zerobudget',
    [string]$NewRoot       = 'C:\inetpub\zerobudget-staging',
    [string]$OldWebSite    = 'ZeroBudget',
    [string]$NewWebSite    = 'ZeroBudget-Staging',
    [string]$OldApiSite    = 'ZeroBudget-Api',
    [string]$NewApiSite    = 'ZeroBudget-Staging-Api',
    [string]$OldWebPool    = 'ZeroBudget-Web',
    [string]$NewWebPool    = 'ZeroBudget-Staging-Web',
    [string]$OldApiPool    = 'ZeroBudget-Api',
    [string]$NewApiPool    = 'ZeroBudget-Staging-Api',
    [string]$OldDatabase   = 'ZeroBudget',
    [string]$NewDatabase   = 'ZeroBudgetStaging',
    [string]$OldTaskName   = 'ZeroBudget-DbBackup',
    [string]$NewTaskName   = 'ZeroBudget-Staging-DbBackup',
    [string]$SqlServer     = '.\SQLEXPRESS',
    [string]$BackupDir     = 'C:\deploy\backups',
    [string]$HealthUrl     = 'http://127.0.0.1:5000/health',

    # Production, named only so the script can refuse to touch it and prove it stayed up.
    [string]$ProductionApiPool   = 'ZeroBudget-Prod-Api',
    [string]$ProductionWebPool   = 'ZeroBudget-Prod-Web',
    [string]$ProductionDatabase  = 'ZeroBudgetProd',
    [string]$ProductionRoot      = 'C:\inetpub\zerobudget-prod',
    [string]$ProductionHealthUrl = 'http://127.0.0.1:5001/health',
    [switch]$SkipProductionCheck
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force
Add-Type -AssemblyName System.Data
Add-Type -Path (Join-Path $env:windir 'system32\inetsrv\Microsoft.Web.Administration.dll')
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "    $m" -ForegroundColor Green }
function Skip($m) { Write-Host "    $m (already done)" -ForegroundColor DarkGray }

$OldApiRoot = Join-Path $OldRoot 'api'; $OldWebRoot = Join-Path $OldRoot 'web'
$NewApiRoot = Join-Path $NewRoot 'api'; $NewWebRoot = Join-Path $NewRoot 'web'

# --- Guards -------------------------------------------------------------------
$prodNames = @($ProductionApiPool, $ProductionWebPool, $ProductionDatabase, $ProductionRoot)
foreach ($n in @($NewWebSite, $NewApiSite, $NewWebPool, $NewApiPool, $NewDatabase, $NewRoot, $NewTaskName)) {
    if ($prodNames -contains $n) { throw "Refusing to run: target name '$n' is a production name." }
}
if ($NewRoot.TrimEnd('\') -ieq $ProductionRoot.TrimEnd('\')) { throw 'Refusing to run: the new root is the production root.' }

function Test-Health([string]$Url) {
    try { return ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) } catch { return $false }
}
function Wait-Health([string]$Url, [int]$Tries = 20) {
    for ($i = 1; $i -le $Tries; $i++) { if (Test-Health $Url) { return $true }; Start-Sleep -Seconds 3 }
    return $false
}

# --- SQL helpers (one connection to master as the calling admin, a sysadmin) -----------
function Invoke-Sql {
    param([string]$Database, [string]$Query, [switch]$Scalar, [switch]$Rows)
    $cn = New-Object System.Data.SqlClient.SqlConnection
    $cn.ConnectionString = "Server=$SqlServer;Database=$Database;Integrated Security=True;TrustServerCertificate=True;Connect Timeout=30"
    $cn.Open()
    try {
        $cmd = $cn.CreateCommand(); $cmd.CommandText = $Query; $cmd.CommandTimeout = 300
        if ($Scalar) { return $cmd.ExecuteScalar() }
        if ($Rows) {
            $r = $cmd.ExecuteReader(); $out = @()
            while ($r.Read()) { $row = @{}; for ($i = 0; $i -lt $r.FieldCount; $i++) { $row[$r.GetName($i)] = $r.GetValue($i) }; $out += ,$row }
            $r.Close(); return $out
        }
        [void]$cmd.ExecuteNonQuery()
    } finally { $cn.Close() }
}
function Test-Db([string]$Name) {
    $v = Invoke-Sql -Database master -Query "SELECT DB_ID(N'$($Name.Replace("'", "''"))')" -Scalar
    return ($null -ne $v) -and ($v -isnot [DBNull])
}
function Test-Login([string]$Name) { return [int](Invoke-Sql -Database master -Query "SELECT COUNT(*) FROM sys.server_principals WHERE name = N'$($Name.Replace("'", "''"))'" -Scalar) -gt 0 }

# --- Current state ------------------------------------------------------------
$sm = New-Object Microsoft.Web.Administration.ServerManager
function Get-State {
    $sm = New-Object Microsoft.Web.Administration.ServerManager
    $apiRoot = if (Test-Path $NewApiRoot) { $NewApiRoot } elseif (Test-Path $OldApiRoot) { $OldApiRoot } else { $null }
    $settingsOld = if ($apiRoot) { Join-Path $apiRoot 'appsettings.Production.json' } else { $null }
    $settingsNew = if ($apiRoot) { Join-Path $apiRoot 'appsettings.Staging.json' } else { $null }
    [ordered]@{
        'folder'        = @{ old = (Test-Path $OldRoot);                         new = (Test-Path $NewRoot) }
        'web site'      = @{ old = ($null -ne $sm.Sites[$OldWebSite]);           new = ($null -ne $sm.Sites[$NewWebSite]) }
        'api site'      = @{ old = ($null -ne $sm.Sites[$OldApiSite]);           new = ($null -ne $sm.Sites[$NewApiSite]) }
        'web pool'      = @{ old = ($null -ne $sm.ApplicationPools[$OldWebPool]); new = ($null -ne $sm.ApplicationPools[$NewWebPool]) }
        'api pool'      = @{ old = ($null -ne $sm.ApplicationPools[$OldApiPool]); new = ($null -ne $sm.ApplicationPools[$NewApiPool]) }
        'settings file' = @{ old = ($settingsOld -and (Test-Path $settingsOld)); new = ($settingsNew -and (Test-Path $settingsNew)) }
        'database'      = @{ old = (Test-Db $OldDatabase);                       new = (Test-Db $NewDatabase) }
        'sql login'     = @{ old = (Test-Login "IIS APPPOOL\$OldApiPool");       new = (Test-Login "IIS APPPOOL\$NewApiPool") }
        'backup task'   = @{ old = ($null -ne (Get-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue)); new = ($null -ne (Get-ScheduledTask -TaskName $NewTaskName -ErrorAction SilentlyContinue)) }
    }
}
function Show-State($state) {
    $rows = foreach ($k in $state.Keys) {
        $s = $state[$k]
        $status = if ($s.new -and -not $s.old) { 'renamed' } elseif ($s.old -and -not $s.new) { 'old name' } elseif ($s.old -and $s.new) { 'BOTH exist' } else { 'MISSING' }
        [pscustomobject]@{ Component = $k; Status = $status }
    }
    $rows | Format-Table -AutoSize | Out-String | Write-Host
}

# The staging settings file (under either name) and the database its connection string names.
# Read before anything is stopped, so a wrong file stops the run while staging is still up.
function Read-StagingSettings {
    $apiRoot = if (Test-Path $NewApiRoot) { $NewApiRoot } elseif (Test-Path $OldApiRoot) { $OldApiRoot } else { throw "Neither $OldApiRoot nor $NewApiRoot exists." }
    $path = Join-Path $apiRoot 'appsettings.Staging.json'
    if (-not (Test-Path $path)) { $path = Join-Path $apiRoot 'appsettings.Production.json' }
    if (-not (Test-Path $path)) { throw "No settings file found in $apiRoot (neither appsettings.Production.json nor appsettings.Staging.json)." }
    $text = [System.IO.File]::ReadAllText($path)
    $m = [regex]::Match($text, '("DefaultConnection"\s*:\s*")((?:[^"\\]|\\.)*)(")')
    if (-not $m.Success) { throw "$path has no ConnectionStrings.DefaultConnection." }
    $cs = $m.Groups[2].Value -replace '\\\\', '\'
    $db = if ($cs -match '(?i)(?:^|;)\s*(?:Database|Initial Catalog)\s*=\s*([^;]*)') { $Matches[1].Trim() } else { '' }
    return @{ Path = $path; Text = $text; Match = $m; ConnectionString = $cs; Database = $db }
}

Info 'Staging stack, current state'
$state = Get-State
Show-State $state
$settings = Read-StagingSettings
Write-Host ("    settings file: {0}, connection string names Database={1}" -f $settings.Path, $settings.Database)
if ($settings.Database -ieq $ProductionDatabase) {
    throw "STOP: staging's settings point at the PRODUCTION database ($ProductionDatabase). That is a separate problem to fix first; this script only renames staging."
}
if ($settings.Database -ine $OldDatabase -and $settings.Database -ine $NewDatabase) {
    throw "The staging connection string names '$($settings.Database)', neither $OldDatabase nor $NewDatabase; edit it by hand, then re-run."
}
if (-not $SkipProductionCheck) {
    $prodUp = Test-Health $ProductionHealthUrl
    Write-Host ("    production /health ({0}): {1}" -f $ProductionHealthUrl, $(if ($prodUp) { 'OK' } else { 'NOT answering' }))
}
if ($Check) { Write-Host 'Check only; nothing changed.'; return }

foreach ($k in $state.Keys) {
    if ($state[$k].old -and $state[$k].new) {
        throw "Both the old and the new $k exist. Decide which one is staging and remove the other before re-running (this script never guesses)."
    }
}
if (-not $SkipProductionCheck -and -not $prodUp) {
    throw "Production is not answering $ProductionHealthUrl before the rename. Fix production first, or pass -SkipProductionCheck if production is deliberately down."
}

# --- 1. Stop staging (pools first, so the folder can move) -----------------------------
Info 'Stopping the staging sites and pools'
foreach ($site in @($OldWebSite, $NewWebSite, $OldApiSite, $NewApiSite)) {
    $s = $sm.Sites[$site]; if ($s -and $s.State -ne 'Stopped') { [void]$s.Stop() }
}
foreach ($pool in @($OldWebPool, $NewWebPool, $OldApiPool, $NewApiPool)) {
    $p = $sm.ApplicationPools[$pool]; if ($p -and $p.State -ne 'Stopped') { [void]$p.Stop() }
}
for ($i = 0; $i -lt 20; $i++) {
    $sm = New-Object Microsoft.Web.Administration.ServerManager
    $busy = @($OldWebPool, $NewWebPool, $OldApiPool, $NewApiPool) | Where-Object { $sm.ApplicationPools[$_] -and $sm.ApplicationPools[$_].State -ne 'Stopped' }
    if ($busy.Count -eq 0) { break }
    Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 3   # let w3wp release its file handles
Done 'staging stopped'

# --- 2. Settings file: appsettings.Production.json -> appsettings.Staging.json ----------
Info 'Settings file'
$apiRootNow = if (Test-Path $NewApiRoot) { $NewApiRoot } else { $OldApiRoot }
$oldSettings = Join-Path $apiRootNow 'appsettings.Production.json'
$newSettings = Join-Path $apiRootNow 'appsettings.Staging.json'
if ((Test-Path $oldSettings) -and -not (Test-Path $newSettings)) {
    Move-Item $oldSettings $newSettings
    Done "renamed $oldSettings -> appsettings.Staging.json"
} elseif (Test-Path $newSettings) {
    Skip 'appsettings.Staging.json exists'
} else {
    throw "No settings file found in $apiRootNow (neither appsettings.Production.json nor appsettings.Staging.json)."
}

# Point its connection string at the renamed database, touching nothing else in the file
# (the file is edited as text, so its layout, comments and secrets stay as they are).
$settings = Read-StagingSettings
$text = $settings.Text; $m = $settings.Match
if ($settings.Database -ieq $NewDatabase) {
    Skip "connection string already names $NewDatabase"
} else {
    $newCs = (Set-ConnectionStringDatabase -ConnectionString $settings.ConnectionString -Database $NewDatabase) -replace '\\', '\\'
    $text = $text.Substring(0, $m.Groups[2].Index) + $newCs + $text.Substring($m.Groups[2].Index + $m.Groups[2].Length)
    [System.IO.File]::WriteAllText($newSettings, $text, (New-Object System.Text.UTF8Encoding($false)))
    Done "connection string now names Database=$NewDatabase"
}
# The DataProtection key folder, if staging uses one (its pool identity must be able to write it).
$keysPath = $null
try { $keysPath = (ConvertFrom-Json $text).DataProtection.KeysPath } catch { }
if (-not $keysPath -and $text -match '"KeysPath"\s*:\s*"((?:[^"\\]|\\.)*)"') { $keysPath = $Matches[1] -replace '\\\\', '\' }

# --- 3. Remember the old pool identities' SIDs (resolvable only while the pools exist) ----
$oldSids = @{}
foreach ($pool in @($OldApiPool, $OldWebPool)) {
    if ($sm.ApplicationPools[$pool]) {
        try { $oldSids[$pool] = (New-Object System.Security.Principal.NTAccount("IIS AppPool\$pool")).Translate([System.Security.Principal.SecurityIdentifier]) } catch { }
    }
}

# --- 4. Folder move ---------------------------------------------------------------------
Info 'Folders'
if ((Test-Path $OldRoot) -and -not (Test-Path $NewRoot)) {
    $moved = $false
    for ($i = 1; $i -le 5 -and -not $moved; $i++) {
        try { Move-Item $OldRoot $NewRoot; $moved = $true } catch { if ($i -eq 5) { throw }; Start-Sleep -Seconds 3 }
    }
    Done "moved $OldRoot -> $NewRoot"
} elseif (Test-Path $NewRoot) { Skip "$NewRoot exists" }
else { throw "Neither $OldRoot nor $NewRoot exists." }

# --- 5. IIS: rename sites and pools, repoint applications and physical paths -------------
Info 'IIS sites and pools'
$sm = New-Object Microsoft.Web.Administration.ServerManager
$changed = $false
foreach ($pair in @(@($OldApiPool, $NewApiPool), @($OldWebPool, $NewWebPool))) {
    $p = $sm.ApplicationPools[$pair[0]]
    if ($p -and -not $sm.ApplicationPools[$pair[1]]) { $p.Name = $pair[1]; $changed = $true; Done "pool $($pair[0]) -> $($pair[1])" }
    elseif ($sm.ApplicationPools[$pair[1]]) { Skip "pool $($pair[1])" }
    else { throw "App pool $($pair[0]) not found." }
}
foreach ($pair in @(@($OldWebSite, $NewWebSite), @($OldApiSite, $NewApiSite))) {
    $s = $sm.Sites[$pair[0]]
    if ($s -and -not $sm.Sites[$pair[1]]) { $s.Name = $pair[1]; $changed = $true; Done "site $($pair[0]) -> $($pair[1])" }
    elseif ($sm.Sites[$pair[1]]) { Skip "site $($pair[1])" }
    else { throw "Site $($pair[0]) not found." }
}
$poolMap = @{ $OldApiPool = $NewApiPool; $OldWebPool = $NewWebPool }
$pathMap = @{ $OldApiRoot.TrimEnd('\').ToLowerInvariant() = $NewApiRoot; $OldWebRoot.TrimEnd('\').ToLowerInvariant() = $NewWebRoot }
foreach ($siteName in @($NewWebSite, $NewApiSite)) {
    foreach ($app in $sm.Sites[$siteName].Applications) {
        if ($poolMap.ContainsKey($app.ApplicationPoolName)) { $app.ApplicationPoolName = $poolMap[$app.ApplicationPoolName]; $changed = $true }
        foreach ($vdir in $app.VirtualDirectories) {
            $key = $vdir.PhysicalPath.TrimEnd('\').ToLowerInvariant()
            if ($pathMap.ContainsKey($key)) { $vdir.PhysicalPath = $pathMap[$key]; $changed = $true }
        }
    }
}
if ($changed) { $sm.CommitChanges(); Start-Sleep -Seconds 2 }
$sm = New-Object Microsoft.Web.Administration.ServerManager
foreach ($siteName in @($NewWebSite, $NewApiSite)) {
    $app = $sm.Sites[$siteName].Applications['/']
    Done ("site {0}: pool {1}, path {2}" -f $siteName, $app.ApplicationPoolName, $app.VirtualDirectories['/'].PhysicalPath)
}

# --- 6. File permissions: whatever the old pool identities held, the new ones hold ----------
Info 'File permissions for the renamed pool identities'
$aclTargets = @($NewApiRoot, $NewWebRoot, $BackupDir) + @($keysPath) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$newIds = @{ $OldApiPool = "IIS AppPool\$NewApiPool"; $OldWebPool = "IIS AppPool\$NewWebPool" }
foreach ($path in $aclTargets) {
    $acl = Get-Acl $path
    $aclChanged = $false
    foreach ($oldPool in $oldSids.Keys) {
        $sid = $oldSids[$oldPool]
        $rules = @($acl.Access | Where-Object {
            if ($_.IsInherited) { return $false }
            try { return ($_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -eq $sid) } catch { return $false }
        })
        foreach ($r in $rules) {
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($newIds[$oldPool], $r.FileSystemRights, $r.InheritanceFlags, $r.PropagationFlags, $r.AccessControlType)))
            [void]$acl.RemoveAccessRule($r)
            $aclChanged = $true
            Done ("{0}: {1} {2} moved to {3}" -f $path, $r.AccessControlType, $r.FileSystemRights, $newIds[$oldPool])
        }
    }
    if ($aclChanged) { Set-Acl $path $acl }
}
# The DataProtection key ring must stay writable by the API, or emailed links die on every restart.
if ($keysPath -and (Test-Path $keysPath)) {
    $acl = Get-Acl $keysPath
    $has = @($acl.Access | Where-Object { $_.IdentityReference.Value -ieq "IIS AppPool\$NewApiPool" -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Modify) })
    if ($has.Count -eq 0) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("IIS AppPool\$NewApiPool", 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        Set-Acl $keysPath $acl
        Done "${keysPath}: Modify granted to IIS AppPool\$NewApiPool"
    } else { Skip "${keysPath}: IIS AppPool\$NewApiPool can modify" }
}

# --- 7. SQL: rename the database, move the app-pool grant to the new identity -------------
Info 'SQL Server'
$oldDbExists = Test-Db $OldDatabase; $newDbExists = Test-Db $NewDatabase
if ($oldDbExists -and -not $newDbExists) {
    Invoke-Sql -Database master -Query @"
ALTER DATABASE [$OldDatabase] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
ALTER DATABASE [$OldDatabase] MODIFY NAME = [$NewDatabase];
ALTER DATABASE [$NewDatabase] SET MULTI_USER;
"@
    Done "database $OldDatabase -> $NewDatabase"
} elseif ($newDbExists) { Skip "database $NewDatabase" }
else { throw "Neither database $OldDatabase nor $NewDatabase exists on $SqlServer." }

# Logical file names too, so a RESTORE FILELISTONLY of a staging backup says staging.
foreach ($f in @(Invoke-Sql -Database $NewDatabase -Query "SELECT name, type_desc FROM sys.database_files" -Rows)) {
    $logical = [string]$f.name
    $want = $null
    if ($logical -ieq $OldDatabase) { $want = $NewDatabase } elseif ($logical -ieq "${OldDatabase}_log") { $want = "${NewDatabase}_log" }
    if ($want) {
        Invoke-Sql -Database master -Query "ALTER DATABASE [$NewDatabase] MODIFY FILE (NAME = [$logical], NEWNAME = [$want]);"
        Done "logical file $logical -> $want (the .mdf/.ldf files on disk keep their names)"
    }
}

$newLogin = "IIS APPPOOL\$NewApiPool"; $oldLogin = "IIS APPPOOL\$OldApiPool"
Invoke-Sql -Database master -Query "IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'$newLogin') CREATE LOGIN [$newLogin] FROM WINDOWS;"
Invoke-Sql -Database $NewDatabase -Query @"
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$newLogin') CREATE USER [$newLogin] FOR LOGIN [$newLogin];
IF IS_ROLEMEMBER('db_owner', N'$newLogin') = 0 ALTER ROLE [db_owner] ADD MEMBER [$newLogin];
"@
Done "$newLogin is db_owner of $NewDatabase"

# The old identity no longer exists in Windows once its pool is renamed; drop its SQL side
# unless production's database still has a user for it (then it is left, and said so).
if (Test-Login $oldLogin) {
    $usedByProd = 0
    if (Test-Db $ProductionDatabase) { $usedByProd = [int](Invoke-Sql -Database $ProductionDatabase -Query "SELECT COUNT(*) FROM sys.database_principals WHERE name = N'$oldLogin'" -Scalar) }
    if ($usedByProd -gt 0) {
        Write-Warning "Login $oldLogin also has a user in $ProductionDatabase; left in place. Remove it by hand if production never used it."
    } else {
        try {
            Invoke-Sql -Database $NewDatabase -Query "IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$oldLogin') DROP USER [$oldLogin];"
            Invoke-Sql -Database master -Query "DROP LOGIN [$oldLogin];"
            Done "dropped the old login $oldLogin"
        } catch { Write-Warning "Could not drop the old login $oldLogin ($($_.Exception.Message)); it is harmless, remove it by hand." }
    }
}

# --- 8. ASPNETCORE_ENVIRONMENT=Staging in the API web.config (Deploy.ps1 re-pins it every deploy) --
Info 'API web.config'
$apiWebConfig = Join-Path $NewApiRoot 'web.config'
if (Test-Path $apiWebConfig) {
    $xml = Set-AncmEnvironmentVariable -WebConfigXml ([System.IO.File]::ReadAllText($apiWebConfig)) -Name 'ASPNETCORE_ENVIRONMENT' -Value 'Staging'
    [System.IO.File]::WriteAllText($apiWebConfig, $xml, (New-Object System.Text.UTF8Encoding($false)))
    Done 'ASPNETCORE_ENVIRONMENT=Staging pinned'
} else { Write-Warning "$apiWebConfig not found (no build deployed yet?); the next deploy writes it." }

# --- 9. Backup task ------------------------------------------------------------------------
Info 'Backup task'
$registerScript = Join-Path $PSScriptRoot 'Register-BackupTask.ps1'
if (Get-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $OldTaskName -Confirm:$false
    Done "removed task $OldTaskName"
}
if (-not (Get-ScheduledTask -TaskName $NewTaskName -ErrorAction SilentlyContinue)) {
    if (-not (Test-Path $registerScript)) { throw "Register-BackupTask.ps1 not found beside this script; run it by hand: -Database $NewDatabase -TaskName $NewTaskName" }
    & $registerScript -Server $SqlServer -Database $NewDatabase -TaskName $NewTaskName -BackupDir $BackupDir
    Done "registered task $NewTaskName (local-only, daily, as the old staging task was)"
} else { Skip "task $NewTaskName" }
$oldBaks = @(Get-ChildItem -Path $BackupDir -Filter "${OldDatabase}_*.bak" -ErrorAction SilentlyContinue)
if ($oldBaks.Count -gt 0) {
    Write-Host ("    {0} older staging backup(s) named {1}_*.bak stay in {2}; retention no longer prunes them, delete them when you like." -f $oldBaks.Count, $OldDatabase, $BackupDir)
}

# --- 10. Deploy scratch folders (recreated by the workflow under their new names) -----------
Info 'Deploy scratch folders'
foreach ($d in @('C:\deploy\incoming', 'C:\deploy\staging', 'C:\deploy\incoming-prod', 'C:\deploy\staging-prod')) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force; Done "removed $d" }
}

# --- 11. Start staging and verify -------------------------------------------------------------
Info 'Starting staging'
$sm = New-Object Microsoft.Web.Administration.ServerManager
foreach ($pool in @($NewApiPool, $NewWebPool)) { if ($sm.ApplicationPools[$pool].State -ne 'Started') { [void]$sm.ApplicationPools[$pool].Start() } }
foreach ($site in @($NewApiSite, $NewWebSite)) { if ($sm.Sites[$site].State -ne 'Started') { [void]$sm.Sites[$site].Start() } }
if (Wait-Health $HealthUrl) { Done "staging answers $HealthUrl" } else { throw "Staging does not answer $HealthUrl after the rename. Check the Application event log for the API's startup error." }
if (-not $SkipProductionCheck) {
    if (Test-Health $ProductionHealthUrl) { Done "production still answers $ProductionHealthUrl" } else { throw "Production stopped answering $ProductionHealthUrl during the rename." }
}

Info 'Final state'
Show-State (Get-State)
Write-Host @"
Staging is now named staging everywhere on this server. Next:
  1. Merge the pull request that renames the Deploy workflow (its staging job uses these names).
  2. Task Scheduler should list $NewTaskName (staging, local) and ZeroBudget-Prod-DbBackup (production, R2).
"@ -ForegroundColor Green
