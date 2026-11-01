<#
.SYNOPSIS
    One-time, idempotent rename of ONE stack on the VPS from its old ZeroBudget names to
    AllotJar names, keeping its data. Run ON THE VPS in an elevated Windows PowerShell 5.1
    console, from a copy of the deploy folder of the pull request that added it, staging first:

        powershell -ExecutionPolicy Bypass -File .\Rename-ToAllotJar.ps1 -Stack staging -Check   # report only
        powershell -ExecutionPolicy Bypass -File .\Rename-ToAllotJar.ps1 -Stack staging          # rename
        (then the same with -Stack production)

.DESCRIPTION
    The app was called ZeroBudget before it was AllotJar, and the server still says so. For the
    stack named by -Stack this script renames:

                         staging                                   production
        IIS sites        ZeroBudget-Staging(-Api) -> AllotJar-...    ZeroBudget-Prod(-Api) -> AllotJar-...
        app pools        ZeroBudget-Staging-Web/-Api -> AllotJar-... ZeroBudget-Prod-Web/-Api -> AllotJar-...
        folder           C:\inetpub\zerobudget-staging -> allotjar-  C:\inetpub\zerobudget-prod -> allotjar-
        database         ZeroBudgetStaging -> AllotJarStaging        ZeroBudgetProd -> AllotJarProd
        key folder       C:\inetpub\zerobudget-staging-dp-keys       C:\inetpub\zerobudget-dp-keys
                           -> C:\inetpub\allotjar-staging-dp-keys      -> C:\inetpub\allotjar-prod-dp-keys
        settings         appsettings.<Env>.json: the old names in it (Database=, KeysPath, comments)
        SQL login        IIS APPPOOL\ZeroBudget-...-Api -> IIS APPPOOL\AllotJar-...-Api (db_owner)
        file rights      what the old pool identities held (the 25 Oct lock-down: settings file read,
                         key folder modify) moves to the new identities
        tasks            every ZeroBudget-<Stack>-* scheduled task (DbBackup, HealthPing) is re-registered
                         as AllotJar-<Stack>-* from its own exported definition: same trigger times,
                         settings, account, R2 and ping arguments, with the database name changed
        boot recovery    the stack's pool and folder in C:\deploy\Recover-AfterBoot.ps1
        local backups    C:\deploy\backups\<OldDatabase>_*.bak -> <NewDatabase>_*.bak, same dates, so
                         the nightly 14-day pruning (which matches <Database>_*.bak) still removes them
        firewall labels  (production run only) rules shown as ZeroBudget-* -> AllotJar-*; display
                         names only, what each rule allows does not change

    The database is renamed by copy: a verified backup of the old database (kept in
    C:\deploy\backups as <NewDatabase>_<time>.bak, pruned after 14 days like every other backup),
    restored as the new database with new file names, and the old database is dropped only after
    the stack answers /health/ready on the new one. Until then the old database is untouched.

    The stack is offline for a minute or two (its pools are stopped). The other stack is never
    changed: the script refuses to start unless the other stack answers /health/ready, and checks
    it again at the end. Production's health ping may send one "down" email during its run.

    Idempotent: each step looks at what exists and skips what is done, so a failed run can be
    re-run after fixing the cause. -Check reports the state and every problem that would stop the
    run, and changes nothing.

    Memory (the 4 GB VPS): every SQL call opens one connection and closes it in finally; every
    query returns a bounded result (counts, one database's files, at most a few dozen rows); every
    wait has a limit; nothing is left running. The database copy is a backup and restore of one
    small database, which SQL Server Express caps at its own memory limit.

    Not while a Deploy workflow run is in progress, and not within 30 minutes of the stack's
    nightly backup (the script checks both). Close SSMS windows on the stack's database first.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('staging', 'production')][string]$Stack,
    [switch]$Check,
    [string]$SqlServer         = '.\SQLEXPRESS',
    [string]$BackupDir         = 'C:\deploy\backups',
    [string]$SettingsBackupDir = 'C:\deploy\settings-backups',
    [string]$RecoverScript     = 'C:\deploy\Recover-AfterBoot.ps1',
    # Pass only when the other stack is down on purpose: the script then skips its health checks.
    [switch]$SkipOtherStackCheck
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Off
Import-Module WebAdministration
Import-Module (Join-Path $PSScriptRoot 'ProvisionHelpers.psm1') -Force
Add-Type -AssemblyName System.Data
Add-Type -Path (Join-Path $env:windir 'system32\inetsrv\Microsoft.Web.Administration.dll')
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "    $m" -ForegroundColor Green }
function Skip($m) { Write-Host "    $m (already done)" -ForegroundColor DarkGray }
function Note($m) { Write-Host "    $m" }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this in an elevated (Administrator) PowerShell. Nothing changed.' }

# --- The two stacks --------------------------------------------------------------
$stacks = @{
    staging = @{
        Env = 'Staging'; Settings = 'appsettings.Staging.json'; HealthUrl = 'http://127.0.0.1:5000/health/ready'
        Old = @{ Root = 'C:\inetpub\zerobudget-staging'; WebSite = 'ZeroBudget-Staging'; ApiSite = 'ZeroBudget-Staging-Api'
                 WebPool = 'ZeroBudget-Staging-Web'; ApiPool = 'ZeroBudget-Staging-Api'; Database = 'ZeroBudgetStaging'
                 KeysPath = 'C:\inetpub\zerobudget-staging-dp-keys'; TaskPrefix = 'ZeroBudget-Staging-' }
        New = @{ Root = 'C:\inetpub\allotjar-staging'; WebSite = 'AllotJar-Staging'; ApiSite = 'AllotJar-Staging-Api'
                 WebPool = 'AllotJar-Staging-Web'; ApiPool = 'AllotJar-Staging-Api'; Database = 'AllotJarStaging'
                 KeysPath = 'C:\inetpub\allotjar-staging-dp-keys'; TaskPrefix = 'AllotJar-Staging-' }
    }
    production = @{
        Env = 'Production'; Settings = 'appsettings.Production.json'; HealthUrl = 'http://127.0.0.1:5001/health/ready'
        Old = @{ Root = 'C:\inetpub\zerobudget-prod'; WebSite = 'ZeroBudget-Prod'; ApiSite = 'ZeroBudget-Prod-Api'
                 WebPool = 'ZeroBudget-Prod-Web'; ApiPool = 'ZeroBudget-Prod-Api'; Database = 'ZeroBudgetProd'
                 KeysPath = 'C:\inetpub\zerobudget-dp-keys'; TaskPrefix = 'ZeroBudget-Prod-' }
        New = @{ Root = 'C:\inetpub\allotjar-prod'; WebSite = 'AllotJar-Prod'; ApiSite = 'AllotJar-Prod-Api'
                 WebPool = 'AllotJar-Prod-Web'; ApiPool = 'AllotJar-Prod-Api'; Database = 'AllotJarProd'
                 KeysPath = 'C:\inetpub\allotjar-prod-dp-keys'; TaskPrefix = 'AllotJar-Prod-' }
    }
}
$Cfg = $stacks[$Stack]; $Old = $Cfg.Old; $New = $Cfg.New
$otherName = if ($Stack -eq 'staging') { 'production' } else { 'staging' }
$Oth = $stacks[$otherName]

# Names of the other stack (old and new) that this run must never touch or target.
$otherNames = @($Oth.Old.Root, $Oth.New.Root, $Oth.Old.WebSite, $Oth.New.WebSite, $Oth.Old.ApiSite, $Oth.New.ApiSite,
                $Oth.Old.WebPool, $Oth.New.WebPool, $Oth.Old.ApiPool, $Oth.New.ApiPool, $Oth.Old.Database, $Oth.New.Database,
                $Oth.Old.KeysPath, $Oth.New.KeysPath)
foreach ($n in @($New.Root, $New.WebSite, $New.ApiSite, $New.WebPool, $New.ApiPool, $New.Database, $New.KeysPath, $Old.Database, $Old.KeysPath)) {
    if ($otherNames -contains $n) { throw "Internal error: '$n' is also a $otherName name. Nothing changed." }
}

# --- Helpers -------------------------------------------------------------------------
function Test-Health([string]$Url, [int]$TimeoutSec = 30) {
    try { return ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec).StatusCode -eq 200) } catch { return $false }
}
function Wait-Health([string]$Url, [int]$Tries = 20) {
    for ($i = 1; $i -le $Tries; $i++) { if (Test-Health $Url) { return $true }; Start-Sleep -Seconds 3 }
    return $false
}

# One connection per call (Windows auth, the calling admin is a sysadmin), closed in finally.
function Invoke-Sql {
    param([string]$Database = 'master', [string]$Query, [switch]$Scalar, [switch]$Rows)
    $cn = New-Object System.Data.SqlClient.SqlConnection
    $cn.ConnectionString = "Server=$SqlServer;Database=$Database;Integrated Security=True;TrustServerCertificate=True;Connect Timeout=30"
    $cn.Open()
    try {
        $cmd = $cn.CreateCommand(); $cmd.CommandText = $Query; $cmd.CommandTimeout = 600
        if ($Scalar) { return $cmd.ExecuteScalar() }
        if ($Rows) {
            $r = $cmd.ExecuteReader(); $out = New-Object System.Collections.ArrayList
            try {
                while ($r.Read()) { $row = @{}; for ($i = 0; $i -lt $r.FieldCount; $i++) { $row[$r.GetName($i)] = $r.GetValue($i) }; [void]$out.Add([pscustomobject]$row) }
            } finally { $r.Close() }
            return $out.ToArray()   # callers wrap the result in @()
        }
        [void]$cmd.ExecuteNonQuery()
    } finally { $cn.Close() }
}
function Q([string]$s) { return $s.Replace("'", "''") }
function Get-DbState([string]$Name) {
    $v = Invoke-Sql -Query "SELECT state_desc FROM sys.databases WHERE name = N'$(Q $Name)'" -Scalar
    if ($null -eq $v -or $v -is [DBNull]) { return $null }
    return [string]$v
}
function Test-Login([string]$Name) { return [int](Invoke-Sql -Query "SELECT COUNT(*) FROM sys.server_principals WHERE name = N'$(Q $Name)'" -Scalar) -gt 0 }

function Get-StackTasks([string]$Prefix) {
    return @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "$Prefix*" })
}

# A settings file as text (the files carry // comments, so they are never parsed as JSON and
# never re-serialised), with its encoding, the database it names and its key folder.
function Read-Settings([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = [System.IO.File]::ReadAllText($Path)
    $db = ''
    $m = [regex]::Match($text, '"DefaultConnection"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($m.Success) {
        $cs = $m.Groups[1].Value -replace '\\\\', '\'
        if ($cs -match '(?i)(?:^|;)\s*(?:Database|Initial Catalog)\s*=\s*([^;]*)') { $db = $Matches[1].Trim() }
    }
    $keys = @([regex]::Matches($text, '"KeysPath"\s*:\s*"((?:[^"\\]|\\.)*)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' })
    return @{ Path = $Path; Text = $text; Bom = $bom; Database = $db; KeysPaths = $keys; HasConnection = $m.Success }
}
function Test-JsonWithComments([string]$Text) {
    # The repo's rule for these files: strip // comments (pattern \s+//[^\r\n]*), then parse.
    try { [void](ConvertFrom-Json ([regex]::Replace($Text, '\s+//[^\r\n]*', ''))); return $true } catch { return $false }
}
function Write-TextFile([string]$Path, [string]$Text, [bool]$Bom) {
    # Overwrites the content of the existing file, so its permissions (the lock-down) stay as they are.
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($Bom)))
    if ([System.IO.File]::ReadAllText($Path) -cne $Text) { throw "$Path does not read back as written." }
}

# Explicit permission entries of $Sid on one file or folder.
function Get-ExplicitRules($Acl, [string]$Sid) {
    return @($Acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $Sid })
}
function Test-HasRight([string]$Path, [string]$Sid, [System.Security.AccessControl.FileSystemRights]$Right) {
    $acl = Get-Acl -LiteralPath $Path
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $Sid })
    $allow = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $Right) -eq $Right })
    $deny  = @($rules | Where-Object { $_.AccessControlType -eq 'Deny' })
    return ($allow.Count -gt 0 -and $deny.Count -eq 0)
}

$sidOldApi = Get-AppPoolSid -Name $Old.ApiPool; $sidOldWeb = Get-AppPoolSid -Name $Old.WebPool
$sidNewApi = Get-AppPoolSid -Name $New.ApiPool; $sidNewWeb = Get-AppPoolSid -Name $New.WebPool

# --- State --------------------------------------------------------------------------
function Get-State {
    $sm = New-Object Microsoft.Web.Administration.ServerManager
    [ordered]@{
        'folder'     = @{ old = (Test-Path -LiteralPath $Old.Root);              new = (Test-Path -LiteralPath $New.Root) }
        'web site'   = @{ old = ($null -ne $sm.Sites[$Old.WebSite]);             new = ($null -ne $sm.Sites[$New.WebSite]) }
        'api site'   = @{ old = ($null -ne $sm.Sites[$Old.ApiSite]);             new = ($null -ne $sm.Sites[$New.ApiSite]) }
        'web pool'   = @{ old = ($null -ne $sm.ApplicationPools[$Old.WebPool]);  new = ($null -ne $sm.ApplicationPools[$New.WebPool]) }
        'api pool'   = @{ old = ($null -ne $sm.ApplicationPools[$Old.ApiPool]);  new = ($null -ne $sm.ApplicationPools[$New.ApiPool]) }
        'key folder' = @{ old = (Test-Path -LiteralPath $Old.KeysPath);          new = (Test-Path -LiteralPath $New.KeysPath) }
        'database'   = @{ old = ($null -ne (Get-DbState $Old.Database));        new = ($null -ne (Get-DbState $New.Database)) }
        'sql login'  = @{ old = (Test-Login "IIS APPPOOL\$($Old.ApiPool)");     new = (Test-Login "IIS APPPOOL\$($New.ApiPool)") }
        'tasks'      = @{ old = ((Get-StackTasks $Old.TaskPrefix).Count -gt 0); new = ((Get-StackTasks $New.TaskPrefix).Count -gt 0) }
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

# Read-only list of anything on this server still named ZeroBudget (bounded: names only).
function Show-Leftovers {
    Info 'Anything on this server still named ZeroBudget'
    $found = New-Object System.Collections.ArrayList
    $sm = New-Object Microsoft.Web.Administration.ServerManager
    foreach ($s in $sm.Sites) { if ($s.Name -match '(?i)zerobudget') { [void]$found.Add("IIS site $($s.Name)") } }
    foreach ($p in $sm.ApplicationPools) { if ($p.Name -match '(?i)zerobudget') { [void]$found.Add("app pool $($p.Name)") } }
    foreach ($t in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match '(?i)zerobudget' })) { [void]$found.Add("scheduled task $($t.TaskPath)$($t.TaskName)") }
    foreach ($r in @(Invoke-Sql -Query "SELECT TOP 20 name FROM sys.databases WHERE name LIKE N'%zerobudget%'" -Rows)) { [void]$found.Add("database $($r.name)") }
    foreach ($r in @(Invoke-Sql -Query "SELECT TOP 20 name FROM sys.server_principals WHERE name LIKE N'%zerobudget%'" -Rows)) { [void]$found.Add("SQL login $($r.name)") }
    foreach ($r in @(Invoke-Sql -Query "SELECT TOP 20 DB_NAME(database_id) AS db, physical_name FROM sys.master_files WHERE physical_name LIKE N'%zerobudget%'" -Rows)) { [void]$found.Add("database file $($r.physical_name) (of $($r.db))") }
    foreach ($dir in @('C:\inetpub', 'C:\deploy')) {
        foreach ($i in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)zerobudget' } | Select-Object -First 20)) { [void]$found.Add("$($i.FullName)") }
    }
    $baks = @(Get-ChildItem -LiteralPath $BackupDir -Filter 'ZeroBudget*.bak' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'ZeroBudget*.bak' })
    if ($baks.Count) { [void]$found.Add("$($baks.Count) backup file(s) $BackupDir\ZeroBudget*.bak (ZeroBudget_*.bak are from before 4 Oct: block 5 of the wipe runbook removes them)") }
    foreach ($r in @(Get-NetFirewallRule -DisplayName 'ZeroBudget*' -ErrorAction SilentlyContinue)) { [void]$found.Add("firewall rule label $($r.DisplayName)") }
    if (Test-Path -LiteralPath $RecoverScript) {
        $l = Get-ZeroBudgetLineNumbers -Text ([System.IO.File]::ReadAllText($RecoverScript))
        if ($l.Count) { [void]$found.Add("$RecoverScript lines $($l -join ', ')") }
    }
    foreach ($st in $stacks.Values) {
        foreach ($root in @($st.New.Root, $st.Old.Root)) {
            $f = Join-Path $root "api\$($st.Settings)"
            if (Test-Path -LiteralPath $f) {
                $l = Get-ZeroBudgetLineNumbers -Text ([System.IO.File]::ReadAllText($f))
                if ($l.Count) { [void]$found.Add("$f lines $($l -join ', ') (line numbers only; open the file to look)") }
            }
        }
    }
    if ($found.Count) { $found | ForEach-Object { Note $_ } } else { Done 'nothing' }
}

# ======================================================================================
# Preflight: read everything, change nothing. Problems are collected so -Check lists all.
# ======================================================================================
$problems = New-Object System.Collections.ArrayList
function Problem([string]$m) { [void]$problems.Add($m); Write-Host "    PROBLEM: $m" -ForegroundColor Yellow }

Info "$($Cfg.Env) stack, current state"
$state = Get-State
Show-State $state
foreach ($k in @('folder', 'web site', 'api site', 'web pool', 'api pool', 'key folder')) {
    if ($state[$k].old -and $state[$k].new) { Problem "Both the old and the new $k exist. Decide which one is $Stack's and remove the other (this script never guesses)." }
}
if (-not ($state['folder'].old -or $state['folder'].new)) { Problem "Neither $($Old.Root) nor $($New.Root) exists." }

# Pool identities: the file-rights step relies on ApplicationPoolIdentity, and on the computed SIDs.
$sm = New-Object Microsoft.Web.Administration.ServerManager
foreach ($pool in @($Old.ApiPool, $Old.WebPool, $New.ApiPool, $New.WebPool)) {
    $p = $sm.ApplicationPools[$pool]
    if (-not $p) { continue }
    if ("$($p.ProcessModel.IdentityType)" -ne 'ApplicationPoolIdentity') { Problem "Pool $pool runs as $($p.ProcessModel.IdentityType), not ApplicationPoolIdentity." }
    try {
        $real = (New-Object System.Security.Principal.NTAccount("IIS AppPool\$pool")).Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($real -ne (Get-AppPoolSid -Name $pool)) { Problem "Windows gives pool $pool the SID $real, not the computed one; the file-rights step cannot be trusted." }
    } catch { Problem "Could not resolve the identity of pool $pool ($($_.Exception.Message))." }
}

# IIS keeps some per-site settings under <location path="SiteName">; a renamed site would lose them.
$locs = @($sm.GetApplicationHostConfiguration().GetLocationPaths() | Where-Object { $_ -and (($_ -split '/')[0] -in @($Old.WebSite, $Old.ApiSite)) })
if ($locs.Count) { Problem ("applicationHost.config has settings under the old site name(s): {0}. They would not follow the rename; tell the thread." -f ($locs -join ', ')) }

# A deploy in progress leaves app_offline.htm in the API folder.
foreach ($root in @($Old.Root, $New.Root)) {
    if (Test-Path -LiteralPath (Join-Path $root 'api\app_offline.htm')) { Problem "$root\api\app_offline.htm exists: a deploy is in progress (or stopped half-way). Wait for it, or check the Actions page." }
}

# Settings file
$apiRootNow = if (Test-Path -LiteralPath $New.Root) { Join-Path $New.Root 'api' } else { Join-Path $Old.Root 'api' }
$settingsPath = Join-Path $apiRootNow $Cfg.Settings
$settings = $null
if (-not (Test-Path -LiteralPath $settingsPath)) {
    Problem "$settingsPath not found."
} else {
    $settings = Read-Settings $settingsPath
    Note ("settings file: {0}; it names Database={1}; KeysPath={2}" -f $settingsPath, $settings.Database, ($settings.KeysPaths -join ' | '))
    if (-not $settings.HasConnection) { Problem "$settingsPath has no ConnectionStrings:DefaultConnection." }
    elseif ($settings.Database -ine $Old.Database -and $settings.Database -ine $New.Database) { Problem "$settingsPath names Database=$($settings.Database), neither $($Old.Database) nor $($New.Database)." }
    if ($settings.KeysPaths.Count -gt 1) { Problem "$settingsPath has $($settings.KeysPaths.Count) KeysPath lines; keep one." }
    elseif ($settings.KeysPaths.Count -eq 1) {
        $kp = $settings.KeysPaths[0].TrimEnd('\')
        if ($kp -ine $Old.KeysPath -and $kp -ine $New.KeysPath) { Problem "$settingsPath has KeysPath $kp, neither $($Old.KeysPath) nor $($New.KeysPath)." }
        if ($kp -ieq $Old.KeysPath -and -not (Test-Path -LiteralPath $Old.KeysPath) -and -not (Test-Path -LiteralPath $New.KeysPath)) { Problem "The key folder $($Old.KeysPath) does not exist." }
    }
    if (-not (Test-JsonWithComments $settings.Text)) { Problem "$settingsPath does not parse as JSON (with // comments stripped) even before any change." }
    $planned = Convert-ZeroBudgetNames -Text $settings.Text
    if (-not (Test-JsonWithComments $planned)) { Problem "$settingsPath would not parse after the name change." }
    $left = Get-ZeroBudgetLineNumbers -Text $planned
    if ($left.Count) { Note ("after the change, lines {0} of the settings file still mention zerobudget (left as they are; open the file to look)" -f ($left -join ', ')) }
    $pp = Get-StackSettingsProblems -SettingsText $planned -AspNetEnvironment $Cfg.Env -ExpectedDatabase $New.Database
    foreach ($p in $pp) { Problem "After the change the settings file would not pass the deploy check: $p" }
}

# The database the settings name must exist; the other stack's databases are never touched.
$oldDbState = Get-DbState $Old.Database; $newDbState = Get-DbState $New.Database
Note ("database {0}: {1}; {2}: {3}" -f $Old.Database, $(if ($oldDbState) { $oldDbState } else { 'none' }), $New.Database, $(if ($newDbState) { $newDbState } else { 'none' }))
if ($settings) {
    if ($settings.Database -ieq $Old.Database -and $oldDbState -ne 'ONLINE') { Problem "The settings name $($Old.Database), which is not ONLINE." }
    if ($settings.Database -ieq $New.Database -and $newDbState -ne 'ONLINE') { Problem "The settings name $($New.Database), which is not ONLINE." }
}

# Free space for one backup and one restored copy (plus margin).
if ($oldDbState -eq 'ONLINE') {
    $mb = [double](Invoke-Sql -Query "SELECT CAST(SUM(CAST(size AS bigint)) * 8 / 1024.0 AS float) FROM sys.master_files WHERE database_id = DB_ID(N'$(Q $Old.Database)')" -Scalar)
    $freeMb = [math]::Floor((Get-PSDrive -Name C).Free / 1MB)
    Note ("{0} uses {1:N0} MB on disk; C: has {2:N0} MB free" -f $Old.Database, $mb, $freeMb)
    if ($freeMb -lt (3 * $mb + 1024)) { Problem "C: has $freeMb MB free; the copy needs about $([math]::Ceiling(3 * $mb + 1024)) MB." }
}

# Scheduled tasks: none running, no nightly backup within 30 minutes, and each one's new definition.
$taskPlans = New-Object System.Collections.ArrayList
foreach ($t in (Get-StackTasks $Old.TaskPrefix)) {
    $newName = $New.TaskPrefix + $t.TaskName.Substring($Old.TaskPrefix.Length)
    $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath
    if ($t.State -eq 'Running' -and $t.TaskName -like '*-DbBackup') { Problem "Task $($t.TaskName) is running right now. Wait for it to finish." }
    if ($t.TaskName -like '*-DbBackup' -and $info.NextRunTime -and $info.NextRunTime -gt (Get-Date) -and $info.NextRunTime -lt (Get-Date).AddMinutes(30)) {
        Problem "Task $($t.TaskName) runs at $($info.NextRunTime) (server time), within 30 minutes. Run this after it has finished."
    }
    $xml = Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
    $newXml = Convert-ScheduledTaskXml -Xml $xml -NewTaskName $newName -TaskPath $t.TaskPath
    $cmds = Get-ScheduledTaskXmlCommands -Xml $newXml
    foreach ($c in $cmds) { if ($c -match '(?i)zerobudget') { Problem "Task $($t.TaskName) would still name ZeroBudget after the change." } }
    Note ("task {0} -> {1}: runs {2}" -f $t.TaskName, $newName, (($cmds | ForEach-Object { $_ -replace 'https?://\S+', '<url>' }) -join ' ; '))
    [void]$taskPlans.Add(@{ OldName = $t.TaskName; NewName = $newName; Path = $t.TaskPath; Xml = $newXml; Commands = $cmds; Enabled = [bool]$t.Settings.Enabled })
}
foreach ($t in (Get-StackTasks $New.TaskPrefix)) { Note "task $($t.TaskName) exists already" }

# Boot recovery script: this stack's pool and folder appear exactly once, under one of the names.
$recoverPlan = $null
if (Test-Path -LiteralPath $RecoverScript) {
    $rText = [System.IO.File]::ReadAllText($RecoverScript)
    $pairs = @(@("'$($Old.ApiPool)'", "'$($New.ApiPool)'"), @("'$($Old.Root)\api'", "'$($New.Root)\api'"))
    $count = { param($t, $s) ([regex]::Matches($t, [regex]::Escape($s))).Count }
    $oldHits = @($pairs | ForEach-Object { & $count $rText $_[0] }); $newHits = @($pairs | ForEach-Object { & $count $rText $_[1] })
    if (($oldHits -join ',') -eq '1,1' -and ($newHits -join ',') -eq '0,0') { $recoverPlan = $pairs; Note "$RecoverScript names this stack's old pool and folder once each; they will change" }
    elseif (($oldHits -join ',') -eq '0,0' -and ($newHits -join ',') -eq '1,1') { Note "$RecoverScript already names the new pool and folder" }
    else { Problem "$RecoverScript does not name this stack's pool and folder exactly once (old $($oldHits -join '/'), new $($newHits -join '/')); edit it by hand or tell the thread." }
} else { Note "$RecoverScript not found; nothing to change there" }

$oldBaks = @(Get-ChildItem -LiteralPath $BackupDir -Filter "$($Old.Database)_*.bak" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$($Old.Database)_*.bak" })
Note ("{0} local backup(s) named {1}_*.bak will become {2}_*.bak (same dates)" -f $oldBaks.Count, $Old.Database, $New.Database)

# Health of both stacks.
Note 'checking /health/ready of both stacks (an idle API can take a minute to answer)...'
$selfUp = Wait-Health $Cfg.HealthUrl -Tries 5
Note ("{0} {1}: {2}" -f $Stack, $Cfg.HealthUrl, $(if ($selfUp) { 'OK' } else { 'NOT answering' }))
$otherUp = $true
if (-not $SkipOtherStackCheck) {
    $otherUp = Wait-Health $Oth.HealthUrl -Tries 5
    Note ("{0} {1}: {2}" -f $otherName, $Oth.HealthUrl, $(if ($otherUp) { 'OK' } else { 'NOT answering' }))
    if (-not $otherUp) { Problem "$otherName does not answer $($Oth.HealthUrl). Fix it first, or pass -SkipOtherStackCheck if it is down on purpose." }
}
if (-not $selfUp -and $state['api pool'].old -and $settings -and $settings.Database -ieq $Old.Database) {
    Problem "$Stack does not answer $($Cfg.HealthUrl) before the rename. Fix it first, so a problem afterwards is known to come from the rename."
}

if ($Check) {
    Show-Leftovers
    if ($problems.Count) { Write-Host "`nCheck only; nothing changed. $($problems.Count) problem(s) above would stop the rename." -ForegroundColor Yellow }
    else { Write-Host "`nCheck only; nothing changed. No problems: the rename can run." -ForegroundColor Green }
    return
}
if ($problems.Count) { throw "$($problems.Count) problem(s) above; nothing changed." }

# ======================================================================================
# The rename. On any error: the old tasks are switched back on (if they were not replaced),
# whatever pools and sites exist are started again, and the error is shown.
# ======================================================================================
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$tasksDone = $false
$warnings = New-Object System.Collections.ArrayList
$oldDbBackup = $null
try {

# --- 1. Pause this stack's scheduled tasks, stop its sites and pools -----------------
Info 'Pausing the stack''s scheduled tasks'
foreach ($tp in $taskPlans) {
    if ($tp.Enabled) { Disable-ScheduledTask -TaskName $tp.OldName -TaskPath $tp.Path | Out-Null; Done "paused $($tp.OldName)" }
}
# A health ping that was mid-run finishes within its 3-minute limit; wait for it (bounded).
$t0 = Get-Date
while (@($taskPlans | Where-Object { (Get-ScheduledTask -TaskName $_.OldName -TaskPath $_.Path).State -eq 'Running' }).Count -and ((Get-Date) - $t0).TotalMinutes -lt 4) { Start-Sleep -Seconds 5 }
Info "Stopping the $Stack sites and pools"
$sm = New-Object Microsoft.Web.Administration.ServerManager
foreach ($site in @($Old.WebSite, $New.WebSite, $Old.ApiSite, $New.ApiSite)) { $s = $sm.Sites[$site]; if ($s -and $s.State -ne 'Stopped') { [void]$s.Stop() } }
foreach ($pool in @($Old.WebPool, $New.WebPool, $Old.ApiPool, $New.ApiPool)) { $p = $sm.ApplicationPools[$pool]; if ($p -and $p.State -ne 'Stopped') { [void]$p.Stop() } }
for ($i = 0; $i -lt 20; $i++) {
    $sm = New-Object Microsoft.Web.Administration.ServerManager
    $busy = @(@($Old.WebPool, $New.WebPool, $Old.ApiPool, $New.ApiPool) | Where-Object { $sm.ApplicationPools[$_] -and $sm.ApplicationPools[$_].State -ne 'Stopped' })
    if ($busy.Count -eq 0) { break }
    Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 3   # let w3wp release its file handles
Done "$Stack stopped"

# --- 2. Database: verified backup of the old one, restored under the new name -------------
Info 'SQL Server: database'
$settings = Read-Settings $settingsPath
if ($settings.Database -ieq $Old.Database) {
    $oldDbBackup = Join-Path $BackupDir ("{0}_{1}.bak" -f $New.Database, $stamp)
    Invoke-Sql -Query "BACKUP DATABASE [$($Old.Database)] TO DISK = N'$(Q $oldDbBackup)' WITH CHECKSUM, INIT;"
    Invoke-Sql -Query "RESTORE VERIFYONLY FROM DISK = N'$(Q $oldDbBackup)' WITH CHECKSUM;"
    Done "backed up and verified $($Old.Database) -> $oldDbBackup"

    $dataDir = [string](Invoke-Sql -Query "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000))" -Scalar)
    if ([string]::IsNullOrWhiteSpace($dataDir)) { $dataDir = (Split-Path ([string](Invoke-Sql -Query "SELECT physical_name FROM sys.master_files WHERE database_id = 1 AND type = 0" -Scalar)) -Parent) + '\' }
    $logDir = [string](Invoke-Sql -Query "SELECT CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000))" -Scalar)
    if ([string]::IsNullOrWhiteSpace($logDir)) { $logDir = $dataDir }
    $files = @(Invoke-Sql -Query "RESTORE FILELISTONLY FROM DISK = N'$(Q $oldDbBackup)'" -Rows)
    $own   = @(Invoke-Sql -Query "SELECT type_desc, physical_name FROM sys.master_files WHERE database_id = ISNULL(DB_ID(N'$(Q $New.Database)'), -1) ORDER BY type, file_id" -Rows)
    $other = @(Invoke-Sql -Query "SELECT DB_NAME(database_id) AS db, physical_name FROM sys.master_files WHERE database_id <> ISNULL(DB_ID(N'$(Q $New.Database)'), -1)" -Rows)
    $plan = Get-RestoreFileMoves -Database $New.Database -BackupFiles @($files) -TargetFiles @($own) -OtherFiles @($other) -DataDir $dataDir -LogDir $logDir
    # A new-named database left by an earlier run that stopped before the settings were switched
    # was never used (the settings still named the old one), so it is restored over.
    if (Get-DbState $New.Database) { Note "$($New.Database) exists from an earlier run that did not finish; it is restored over" }
    # One batch on one connection: take the single-user slot (if the database exists and is online),
    # restore over it, open it again.
    Invoke-Sql -Query (@"
IF DB_ID(N'{0}') IS NOT NULL AND DATABASEPROPERTYEX(N'{0}', 'Status') = 'ONLINE' ALTER DATABASE [{0}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
RESTORE DATABASE [{0}] FROM DISK = N'{1}' WITH REPLACE, RECOVERY, CHECKSUM, {2};
ALTER DATABASE [{0}] SET MULTI_USER;
"@ -f $New.Database, (Q $oldDbBackup), ($plan.Moves -join ', '))
    Done ("restored as {0} in {1}" -f $New.Database, ($plan.Targets -join ', '))
    # Logical file names too, so a backup of the new database says its own name.
    $bakData = @($files | Where-Object { [string]$_.Type -ne 'L' }); $bakLogs = @($files | Where-Object { [string]$_.Type -eq 'L' })
    if ($bakData.Count -ge 1 -and [string]$bakData[0].LogicalName -ne $New.Database) { Invoke-Sql -Query "ALTER DATABASE [$($New.Database)] MODIFY FILE (NAME = N'$(Q ([string]$bakData[0].LogicalName))', NEWNAME = N'$($New.Database)');" }
    if ($bakLogs.Count -ge 1 -and [string]$bakLogs[0].LogicalName -ne "$($New.Database)_log") { Invoke-Sql -Query "ALTER DATABASE [$($New.Database)] MODIFY FILE (NAME = N'$(Q ([string]$bakLogs[0].LogicalName))', NEWNAME = N'$($New.Database)_log');" }
    # Keep the database open between requests (step 12 of the 25 Oct fixes did this for the old one).
    Invoke-Sql -Query "ALTER DATABASE [$($New.Database)] SET AUTO_CLOSE OFF;"
    # Same tables and the same last migration in both.
    $cmp = "SELECT (SELECT COUNT(*) FROM sys.tables) AS t, (SELECT TOP 1 MigrationId FROM dbo.__EFMigrationsHistory ORDER BY MigrationId DESC) AS m"
    $a = @(Invoke-Sql -Database $Old.Database -Query $cmp -Rows)[0]; $b = @(Invoke-Sql -Database $New.Database -Query $cmp -Rows)[0]
    if ($a.t -ne $b.t -or [string]$a.m -ne [string]$b.m) { throw "The restored $($New.Database) differs from $($Old.Database) (tables $($a.t)/$($b.t), last migration $($a.m)/$($b.m))." }
    Done ("{0} has the same {1} tables and last migration {2}" -f $New.Database, $b.t, $b.m)
} elseif ($settings.Database -ieq $New.Database) {
    Skip "the settings already name $($New.Database)"
} else { throw "The settings name $($settings.Database)." }

# --- 3. Settings file: old names -> new names (a copy is kept first) ------------------------
Info 'Settings file'
$settings = Read-Settings $settingsPath
$newText = Convert-ZeroBudgetNames -Text $settings.Text
if ($newText -ceq $settings.Text) {
    Skip "$($Cfg.Settings) names nothing old"
} else {
    New-Item -ItemType Directory -Force -Path $SettingsBackupDir | Out-Null
    $copy = Join-Path $SettingsBackupDir ("{0}.before-allotjar-{1}" -f $Cfg.Settings, $stamp)
    Copy-Item -LiteralPath $settingsPath -Destination $copy
    if ([System.IO.File]::ReadAllText($copy) -cne $settings.Text) { throw "The copy $copy does not match the settings file; nothing written." }
    Done "kept a copy: $copy"
    if (-not (Test-JsonWithComments $newText)) { throw 'The changed settings would not parse; nothing written.' }
    $pp = Get-StackSettingsProblems -SettingsText $newText -AspNetEnvironment $Cfg.Env -ExpectedDatabase $New.Database
    if ($pp.Count) { throw ("The changed settings would not pass the deploy check; nothing written: " + ($pp -join ' ')) }
    Write-TextFile -Path $settingsPath -Text $newText -Bom $settings.Bom
    $after = Read-Settings $settingsPath
    Done ("{0} now names Database={1}; KeysPath={2}" -f $Cfg.Settings, $after.Database, ($after.KeysPaths -join ' | '))
}

# --- 4. Folders: the stack root and its key folder ------------------------------------------
Info 'Folders'
function Move-Folder([string]$From, [string]$To) {
    if ((Test-Path -LiteralPath $From) -and -not (Test-Path -LiteralPath $To)) {
        $moved = $false
        for ($i = 1; $i -le 5 -and -not $moved; $i++) {
            try { Move-Item -LiteralPath $From -Destination $To; $moved = $true } catch { if ($i -eq 5) { throw }; Start-Sleep -Seconds 3 }
        }
        Done "moved $From -> $To (its permissions move with it)"
    } elseif (Test-Path -LiteralPath $To) { Skip "$To exists" }
    else { throw "Neither $From nor $To exists." }
}
Move-Folder $Old.Root $New.Root
$settingsPath = Join-Path $New.Root "api\$($Cfg.Settings)"
if ((Read-Settings $settingsPath).KeysPaths.Count -eq 1) { Move-Folder $Old.KeysPath $New.KeysPath } else { Note 'no KeysPath in the settings; no key folder to move' }

# --- 5. IIS: rename pools and sites, repoint pools and paths --------------------------------
# A renamed pool is a new object to WAS and would start at once (AlwaysRunning), before its file
# rights and SQL login exist, so it is committed with autoStart off; step 10 turns it back on.
Info 'IIS sites and pools'
$sm = New-Object Microsoft.Web.Administration.ServerManager
$changed = $false
foreach ($pair in @(@($Old.ApiPool, $New.ApiPool), @($Old.WebPool, $New.WebPool))) {
    $p = $sm.ApplicationPools[$pair[0]]
    if ($p -and -not $sm.ApplicationPools[$pair[1]]) { $p.Name = $pair[1]; $p.AutoStart = $false; $changed = $true; Done "pool $($pair[0]) -> $($pair[1])" }
    elseif ($sm.ApplicationPools[$pair[1]]) { Skip "pool $($pair[1])" }
    else { throw "App pool $($pair[0]) not found." }
}
foreach ($pair in @(@($Old.WebSite, $New.WebSite), @($Old.ApiSite, $New.ApiSite))) {
    $s = $sm.Sites[$pair[0]]
    if ($s -and -not $sm.Sites[$pair[1]]) { $s.Name = $pair[1]; $changed = $true; Done "site $($pair[0]) -> $($pair[1])" }
    elseif ($sm.Sites[$pair[1]]) { Skip "site $($pair[1])" }
    else { throw "Site $($pair[0]) not found." }
}
$poolMap = @{ $Old.ApiPool = $New.ApiPool; $Old.WebPool = $New.WebPool }
$oldPrefix = $Old.Root.TrimEnd('\') + '\'
foreach ($siteName in @($New.WebSite, $New.ApiSite)) {
    foreach ($app in $sm.Sites[$siteName].Applications) {
        if ($poolMap.ContainsKey($app.ApplicationPoolName)) { $app.ApplicationPoolName = $poolMap[$app.ApplicationPoolName]; $changed = $true }
        foreach ($vdir in $app.VirtualDirectories) {
            $pp = [string]$vdir.PhysicalPath
            if ($pp.TrimEnd('\') -ieq $Old.Root.TrimEnd('\') -or $pp.StartsWith($oldPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $vdir.PhysicalPath = $New.Root.TrimEnd('\') + $pp.Substring($Old.Root.TrimEnd('\').Length); $changed = $true
            }
        }
    }
}
if ($changed) { $sm.CommitChanges(); Start-Sleep -Seconds 2 }
$sm = New-Object Microsoft.Web.Administration.ServerManager
foreach ($siteName in @($New.WebSite, $New.ApiSite)) {
    $app = $sm.Sites[$siteName].Applications['/']
    $path = [string]$app.VirtualDirectories['/'].PhysicalPath
    if ($path -match '(?i)zerobudget' -or $app.ApplicationPoolName -match '(?i)zerobudget') { throw "Site $siteName still points at $path / pool $($app.ApplicationPoolName)." }
    Done ("site {0}: pool {1}, path {2}" -f $siteName, $app.ApplicationPoolName, $path)
}
foreach ($pool in @($New.ApiPool, $New.WebPool)) {
    $real = (New-Object System.Security.Principal.NTAccount("IIS AppPool\$pool")).Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($real -ne (Get-AppPoolSid -Name $pool)) { throw "Windows gives the new pool $pool the SID $real, not the computed one." }
}

# --- 6. File rights: what the old pool identities held, the new ones hold -------------------
# Explicit entries only (inherited ones follow the folder). The 25 Oct lock-down gave the API
# pool read on its settings file and modify on its key folder, with inheritance turned off.
Info 'File rights for the renamed pool identities'
$sidMap = @{ $sidOldApi = $sidNewApi; $sidOldWeb = $sidNewWeb }
$moved = 0
function Move-Rights([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $acl = $item.GetAccessControl('Access')
    $hit = $false
    foreach ($oldSid in @($sidMap.Keys)) {
        foreach ($r in (Get-ExplicitRules $acl $oldSid)) {
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                (New-Object System.Security.Principal.SecurityIdentifier($sidMap[$oldSid])), $r.FileSystemRights, $r.InheritanceFlags, $r.PropagationFlags, $r.AccessControlType)))
            [void]$acl.RemoveAccessRuleSpecific($r)
            $hit = $true
        }
    }
    if ($hit) { $item.SetAccessControl($acl); $script:moved++ }
}
foreach ($top in @($New.Root, $New.KeysPath)) {
    if (-not (Test-Path -LiteralPath $top)) { continue }
    Move-Rights $top
    Get-ChildItem -LiteralPath $top -Recurse -Force -ErrorAction Stop | ForEach-Object { Move-Rights $_.FullName }
}
foreach ($one in @($BackupDir, $SettingsBackupDir)) { if (Test-Path -LiteralPath $one) { Move-Rights $one } }
Done "$moved file(s) or folder(s) had entries for the old identities; moved to the new ones"
# The API must read its settings and write its key ring, or it fails to start / emailed links die.
$settingsAcl = Get-Acl -LiteralPath $settingsPath
if ($settingsAcl.AreAccessRulesProtected -and -not (Test-HasRight $settingsPath $sidNewApi ([System.Security.AccessControl.FileSystemRights]::Read))) {
    throw "IIS AppPool\$($New.ApiPool) cannot read $settingsPath."
}
if ((Get-ExplicitRules $settingsAcl $sidOldApi).Count) { throw "$settingsPath still has an entry for the old pool." }
Done "IIS AppPool\$($New.ApiPool) can read $($Cfg.Settings)"
if ((Test-Path -LiteralPath $New.KeysPath) -and (Get-Acl -LiteralPath $New.KeysPath).AreAccessRulesProtected) {
    if (-not (Test-HasRight $New.KeysPath $sidNewApi ([System.Security.AccessControl.FileSystemRights]::Modify))) { throw "IIS AppPool\$($New.ApiPool) cannot modify $($New.KeysPath)." }
    Done "IIS AppPool\$($New.ApiPool) can modify $($New.KeysPath)"
}

# --- 7. SQL: the new pool identity owns the new database ----------------------------------
Info 'SQL Server: app-pool login'
$newLogin = "IIS APPPOOL\$($New.ApiPool)"; $oldLogin = "IIS APPPOOL\$($Old.ApiPool)"
Invoke-Sql -Query "IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'$newLogin') CREATE LOGIN [$newLogin] FROM WINDOWS;"
Invoke-Sql -Database $New.Database -Query @"
IF USER_ID(N'$oldLogin') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sys.schemas WHERE principal_id = USER_ID(N'$oldLogin')) DROP USER [$oldLogin];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$newLogin') CREATE USER [$newLogin] FOR LOGIN [$newLogin];
IF IS_ROLEMEMBER('db_owner', N'$newLogin') = 0 ALTER ROLE [db_owner] ADD MEMBER [$newLogin];
"@
Done "$newLogin is db_owner of $($New.Database)"
# The nightly backup runs as SYSTEM and needs backup rights in the new database (restored with it; made sure here).
Invoke-Sql -Database $New.Database -Query (Get-BackupDbUserSql)
Done "NT AUTHORITY\SYSTEM can back up $($New.Database)"

# --- 8. Boot recovery script ----------------------------------------------------------------
Info 'Boot recovery script'
if ($recoverPlan) {
    $rBytes = [System.IO.File]::ReadAllBytes($RecoverScript)
    $rBom = ($rBytes.Length -ge 3 -and $rBytes[0] -eq 0xEF -and $rBytes[1] -eq 0xBB -and $rBytes[2] -eq 0xBF)
    $rText = [System.IO.File]::ReadAllText($RecoverScript)
    foreach ($pair in $recoverPlan) { $rText = $rText.Replace($pair[0], $pair[1]) }
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($rText, [ref]$null, [ref]$errs)
    if ($errs) { throw "The changed $RecoverScript would not parse; nothing written." }
    Write-TextFile -Path $RecoverScript -Text $rText -Bom $rBom
    Done "$RecoverScript now names $($New.ApiPool) and $($New.Root)\api"
} else { Skip 'nothing to change' }

# --- 9. Local backups: old name -> new name, same dates ---------------------------------------
Info 'Local backups'
$n = 0
foreach ($f in @(Get-ChildItem -LiteralPath $BackupDir -Filter "$($Old.Database)_*.bak" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$($Old.Database)_*.bak" })) {
    $to = $New.Database + $f.Name.Substring($Old.Database.Length)
    if (Test-Path -LiteralPath (Join-Path $BackupDir $to)) { [void]$warnings.Add("$($f.Name) not renamed: $to exists"); continue }
    Rename-Item -LiteralPath $f.FullName -NewName $to; $n++
}
if ($n) { Done "$n backup file(s) renamed to $($New.Database)_*.bak; the nightly pruning removes them on their usual dates" } else { Skip "no $($Old.Database)_*.bak left" }

# --- 10. Start the stack and prove it works on the new database -------------------------------
Info "Starting $Stack"
$sm = New-Object Microsoft.Web.Administration.ServerManager
$changed = $false
foreach ($pool in @($New.ApiPool, $New.WebPool)) { if (-not $sm.ApplicationPools[$pool].AutoStart) { $sm.ApplicationPools[$pool].AutoStart = $true; $changed = $true } }
if ($changed) { $sm.CommitChanges(); Start-Sleep -Seconds 2; $sm = New-Object Microsoft.Web.Administration.ServerManager }
foreach ($pool in @($New.ApiPool, $New.WebPool)) { if ($sm.ApplicationPools[$pool].State -ne 'Started') { [void]$sm.ApplicationPools[$pool].Start() } }
foreach ($site in @($New.ApiSite, $New.WebSite)) { if ($sm.Sites[$site].State -ne 'Started') { [void]$sm.Sites[$site].Start() } }
if (Wait-Health $Cfg.HealthUrl) { Done "$Stack answers $($Cfg.HealthUrl) (the API reads its settings and reaches $($New.Database))" }
else { throw "$Stack does not answer $($Cfg.HealthUrl) after the rename. Check the Application event log for the API's startup error. The old database $($Old.Database) is still there." }

# --- 11. Scheduled tasks under the new names -------------------------------------------------
Info 'Scheduled tasks'
foreach ($tp in $taskPlans) {
    if (-not (Get-ScheduledTask -TaskName $tp.NewName -TaskPath $tp.Path -ErrorAction SilentlyContinue)) {
        Register-ScheduledTask -Xml $tp.Xml -TaskName $tp.NewName -TaskPath $tp.Path | Out-Null
    }
    $stored = Get-ScheduledTask -TaskName $tp.NewName -TaskPath $tp.Path
    $storedCmds = @($stored.Actions | ForEach-Object { ('{0} {1}' -f $_.Execute, $_.Arguments).Trim() })
    if (($storedCmds -join "`n") -ne ($tp.Commands -join "`n")) { throw "Task $($tp.NewName) was stored with a different command line; the old task $($tp.OldName) is kept (paused)." }
    if ([bool]$stored.Settings.Enabled -ne $tp.Enabled) { if ($tp.Enabled) { Enable-ScheduledTask -TaskName $tp.NewName -TaskPath $tp.Path | Out-Null } else { Disable-ScheduledTask -TaskName $tp.NewName -TaskPath $tp.Path | Out-Null } }
    Unregister-ScheduledTask -TaskName $tp.OldName -TaskPath $tp.Path -Confirm:$false
    Done "$($tp.OldName) -> $($tp.NewName) (same trigger, settings and account)"
}
$tasksDone = $true
# Prove the nightly backup works under its new name: run it once now (bounded wait).
foreach ($tp in @($taskPlans | Where-Object { $_.NewName -like '*-DbBackup' -and $_.Enabled })) {
    Note "running $($tp.NewName) once now as a test (up to 15 minutes)..."
    $t0 = Get-Date
    Start-ScheduledTask -TaskName $tp.NewName -TaskPath $tp.Path
    Start-Sleep -Seconds 5
    while ((Get-ScheduledTask -TaskName $tp.NewName -TaskPath $tp.Path).State -eq 'Running' -and ((Get-Date) - $t0).TotalMinutes -lt 15) { Start-Sleep -Seconds 10 }
    $res = (Get-ScheduledTaskInfo -TaskName $tp.NewName -TaskPath $tp.Path).LastTaskResult
    $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'AllotJar Backup'; StartTime = $t0 } -MaxEvents 3 -ErrorAction SilentlyContinue)
    $okEv = @($ev | Where-Object { $_.Id -eq 4000 -and $_.Message -like "*$($New.Database)*" })
    if ($res -eq 0 -and $okEv.Count) { Done "$($tp.NewName) finished OK: $($okEv[0].Message)" }
    else { [void]$warnings.Add("The test run of $($tp.NewName) did not report success (result $res; events: $(($ev | ForEach-Object { "$($_.Id) $($_.Message)" }) -join ' | ')). Paste this output in the thread.") }
}

# --- 12. The old database and login go -------------------------------------------------------
Info 'SQL Server: the old database'
if (Get-DbState $Old.Database) {
    if (-not $oldDbBackup) {
        # A re-run: take a fresh verified copy before dropping, whatever an earlier run did.
        $oldDbBackup = Join-Path $BackupDir ("{0}_{1}.bak" -f $New.Database, $stamp)
        Invoke-Sql -Query "BACKUP DATABASE [$($Old.Database)] TO DISK = N'$(Q $oldDbBackup)' WITH CHECKSUM, INIT;"
        Invoke-Sql -Query "RESTORE VERIFYONLY FROM DISK = N'$(Q $oldDbBackup)' WITH CHECKSUM;"
    }
    # One batch: if the drop fails (a reconnecting SSMS window took the slot), the database is opened again.
    Invoke-Sql -Query @"
ALTER DATABASE [$($Old.Database)] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
BEGIN TRY
    DROP DATABASE [$($Old.Database)];
END TRY
BEGIN CATCH
    ALTER DATABASE [$($Old.Database)] SET MULTI_USER;
    THROW;
END CATCH
"@
    Done "dropped $($Old.Database) (its last copy: $oldDbBackup, pruned with the other backups after 14 days)"
} else { Skip "no database $($Old.Database)" }
if (Test-Login $oldLogin) {
    $users = 0
    foreach ($r in @(Invoke-Sql -Query "SELECT TOP 50 name FROM sys.databases WHERE state_desc = 'ONLINE'" -Rows)) {
        $users += [int](Invoke-Sql -Database ([string]$r.name) -Query "SELECT COUNT(*) FROM sys.database_principals WHERE sid = (SELECT sid FROM sys.server_principals WHERE name = N'$oldLogin')" -Scalar)
    }
    if ($users -gt 0) { [void]$warnings.Add("Login $oldLogin still has a user in $users database(s); left in place. Tell the thread.") }
    else { Invoke-Sql -Query "DROP LOGIN [$oldLogin];"; Done "dropped the old login $oldLogin" }
} else { Skip "no login $oldLogin" }

# --- 13. Server-wide labels (production run only) ----------------------------------------------
if ($Stack -eq 'production') {
    Info 'Firewall rule labels'
    $rules = @(Get-NetFirewallRule -DisplayName 'ZeroBudget-*' -ErrorAction SilentlyContinue)
    foreach ($r in $rules) {
        $label = 'AllotJar-' + $r.DisplayName.Substring('ZeroBudget-'.Length)
        Set-NetFirewallRule -Name $r.Name -NewDisplayName $label
        Done "label $($r.DisplayName) -> $label (the rule itself is unchanged)"
    }
    if (-not $rules.Count) { Skip 'no rule labelled ZeroBudget-*' }
}

} catch {
    $err = $_
    Write-Host "`nSTOPPED: $($err.Exception.Message)" -ForegroundColor Red
    if (-not $tasksDone) {
        foreach ($tp in $taskPlans) {
            if ($tp.Enabled -and (Get-ScheduledTask -TaskName $tp.OldName -TaskPath $tp.Path -ErrorAction SilentlyContinue)) {
                try { Enable-ScheduledTask -TaskName $tp.OldName -TaskPath $tp.Path | Out-Null; Write-Host "    switched $($tp.OldName) back on" } catch { }
            }
        }
    }
    # Bring back whatever exists, under either name, so the stack is not left down while you are away.
    try {
        $sm = New-Object Microsoft.Web.Administration.ServerManager
        foreach ($pool in @($New.ApiPool, $New.WebPool, $Old.ApiPool, $Old.WebPool)) {
            $p = $sm.ApplicationPools[$pool]
            if ($p) { if (-not $p.AutoStart) { $p.AutoStart = $true }; }
        }
        $sm.CommitChanges(); Start-Sleep -Seconds 2
        $sm = New-Object Microsoft.Web.Administration.ServerManager
        foreach ($pool in @($New.ApiPool, $New.WebPool, $Old.ApiPool, $Old.WebPool)) { $p = $sm.ApplicationPools[$pool]; if ($p -and $p.State -ne 'Started') { [void]$p.Start() } }
        foreach ($site in @($New.ApiSite, $New.WebSite, $Old.ApiSite, $Old.WebSite)) { $s = $sm.Sites[$site]; if ($s -and $s.State -ne 'Started') { [void]$s.Start() } }
        Write-Host ("    started the {0} pools and sites again; {1} answers: {2}" -f $Stack, $Cfg.HealthUrl, (Wait-Health $Cfg.HealthUrl -Tries 10))
    } catch { Write-Host "    could not start $Stack again: $($_.Exception.Message)" -ForegroundColor Red }
    Write-Host '    Paste this whole output in the thread. The script can be run again once the cause is fixed.' -ForegroundColor Yellow
    throw $err
}

# --- Finish -------------------------------------------------------------------------------------
if (-not $SkipOtherStackCheck) {
    if (Wait-Health $Oth.HealthUrl -Tries 5) { Done "$otherName still answers $($Oth.HealthUrl)" } else { [void]$warnings.Add("$otherName stopped answering $($Oth.HealthUrl) during the run.") }
}
Info 'Final state'
Show-State (Get-State)
Show-Leftovers
foreach ($w in $warnings) { Write-Host "WARNING: $w" -ForegroundColor Yellow }
Write-Host ("`n{0} now runs under AllotJar names on {1}. Paste this output in the thread." -f $Cfg.Env, $New.Database) -ForegroundColor Green
