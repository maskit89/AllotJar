<#
.SYNOPSIS
    Self-contained tests for deploy/ProvisionHelpers.psm1 — the pure decision logic behind
    TLS binding (wildcard cert coverage, rebind-vs-keep) and the backup task's R2 arguments.
    No Pester dependency (runs identically under Windows PowerShell 5.1 and pwsh on any OS,
    including the ubuntu CI runner): plain assertions, non-zero exit on any failure.

.EXAMPLE
    pwsh -File deploy/tests/Test-DeployHelpers.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'ProvisionHelpers.psm1') -Force

$script:Failures = 0
function Assert-True {
    param([bool]$Condition, [string]$Name)
    if ($Condition) {
        Write-Host "  ok  $Name"
    } else {
        Write-Host "FAIL  $Name" -ForegroundColor Red
        $script:Failures++
    }
}

Write-Host '== Test-HostCoveredByDnsNames (wildcard cert coverage) =='
$san = @('*.allotjar.com', 'allotjar.com')
Assert-True (Test-HostCoveredByDnsNames -DnsNames $san -HostHeader 'allotjar.com')           'apex covered by explicit SAN entry'
Assert-True (Test-HostCoveredByDnsNames -DnsNames $san -HostHeader 'www.allotjar.com')       'one-label host covered by wildcard'
Assert-True (Test-HostCoveredByDnsNames -DnsNames $san -HostHeader 'staging.allotjar.com')   'staging covered by wildcard'
Assert-True (Test-HostCoveredByDnsNames -DnsNames $san -HostHeader 'WWW.ALLOTJAR.COM')       'matching is case-insensitive'
Assert-True (-not (Test-HostCoveredByDnsNames -DnsNames $san -HostHeader 'a.b.allotjar.com')) 'wildcard never spans two labels'
Assert-True (-not (Test-HostCoveredByDnsNames -DnsNames $san -HostHeader 'allotjar.org'))     'different domain not covered'
Assert-True (-not (Test-HostCoveredByDnsNames -DnsNames $san -HostHeader 'evilallotjar.com')) 'suffix-alike domain not covered'
# The historical staging mis-bind: an apex/www-only cert must NOT cover staging.
$apexOnly = @('allotjar.com', 'www.allotjar.com')
Assert-True (-not (Test-HostCoveredByDnsNames -DnsNames $apexOnly -HostHeader 'staging.allotjar.com')) 'apex/www-only cert does not cover staging'
Assert-True (-not (Test-HostCoveredByDnsNames -DnsNames @('*.allotjar.com') -HostHeader 'allotjar.com')) 'wildcard alone does not cover the bare apex'
Assert-True (-not (Test-HostCoveredByDnsNames -DnsNames @() -HostHeader 'allotjar.com'))     'empty SAN list covers nothing'

Write-Host '== Get-SslBindingAction (rebind decision) =='
Assert-True ((Get-SslBindingAction -ExistingThumbprint $null -DesiredThumbprint 'AABB') -eq 'create') 'no binding -> create'
Assert-True ((Get-SslBindingAction -ExistingThumbprint ''    -DesiredThumbprint 'AABB') -eq 'create') 'empty binding -> create'
Assert-True ((Get-SslBindingAction -ExistingThumbprint 'AABB' -DesiredThumbprint 'AABB') -eq 'keep')  'same cert -> keep'
Assert-True ((Get-SslBindingAction -ExistingThumbprint 'aabb' -DesiredThumbprint 'AABB') -eq 'keep')  'same cert, different case -> keep'
Assert-True ((Get-SslBindingAction -ExistingThumbprint 'CCDD' -DesiredThumbprint 'AABB') -eq 'rebind') 'different cert -> rebind (never silently kept)'

Write-Host '== New-BackupTaskArgumentLine / Get-R2BucketFromArgumentLine (R2 round-trip) =='
$local = New-BackupTaskArgumentLine -ScriptPath 'C:\deploy\Backup-Database.ps1' -Server '.\SQLEXPRESS' `
    -Database 'AllotJarStaging' -BackupDir 'C:\deploy\backups' -RetentionDays 14
Assert-True ($local -notmatch '-R2Bucket') 'local-only line carries no R2 arguments'
Assert-True ($null -eq (Get-R2BucketFromArgumentLine -ArgumentLine $local)) 'no bucket parsed from a local-only line'

$prod = New-BackupTaskArgumentLine -ScriptPath 'C:\deploy\Backup-Database.ps1' -Server '.\SQLEXPRESS' `
    -Database 'AllotJarProd' -BackupDir 'C:\deploy\backups' -RetentionDays 14 `
    -R2Bucket 'allotjar-db-backups' -Rclone 'C:\deploy\rclone\rclone.exe' `
    -RcloneConf 'C:\deploy\rclone.conf' -R2Remote 'r2' -R2Prefix 'db-backups-enc'
Assert-True ($prod -match '-R2Bucket "allotjar-db-backups"') 'production line carries the R2 bucket'
Assert-True ($prod -match '-Rclone ')                        'production line carries the rclone path'
Assert-True ((Get-R2BucketFromArgumentLine -ArgumentLine $prod) -eq 'allotjar-db-backups') 'bucket parses back out of the line (preserve path)'
Assert-True ((Get-R2BucketFromArgumentLine -ArgumentLine '-Foo -R2Bucket bare-bucket -Bar') -eq 'bare-bucket') 'unquoted bucket parses too'
Assert-True ($null -eq (Get-R2BucketFromArgumentLine -ArgumentLine $null)) 'null argument line yields no bucket'

Write-Host '== Assert-R2SizeMatches (post-upload verify) =='
Assert-True ((Assert-R2SizeMatches -SizeJson '{"count":1,"bytes":8638464}' -LocalBytes 8638464 -Name 'x.bak') -eq 8638464) 'matching size passes and returns the remote bytes'
$threw = $false; try { [void](Assert-R2SizeMatches -SizeJson '{"count":1,"bytes":100}' -LocalBytes 200 -Name 'x.bak') } catch { $threw = $true }
Assert-True $threw 'a size mismatch throws'
$threw = $false; try { [void](Assert-R2SizeMatches -SizeJson '{"count":0}' -LocalBytes 200 -Name 'x.bak') } catch { $threw = $true }
Assert-True $threw 'an answer without a byte count throws'
# Regression: the upload script once parsed the JSON into `$remote`, the same variable as its
# [string]$Remote parameter (names ignore case), so every upload failed its own check.
$uploadSource = Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) 'Upload-BackupToR2.ps1') -Raw
Assert-True ($uploadSource -notmatch '(?im)^\s*\$remote\s*=') 'Upload-BackupToR2.ps1 never assigns to $remote (the [string]$Remote parameter)'

$strict = $false; try { Set-StrictMode -Version Latest; [void](Assert-R2SizeMatches -SizeJson '{"count":0}' -LocalBytes 1 -Name 'x') } catch { $strict = $_.Exception.Message -match 'no byte count' } finally { Set-StrictMode -Off }
Assert-True $strict 'a missing byte count gives the clear message even under StrictMode'
Assert-True ((Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) 'Backup-Database.ps1') -Raw) -match 'Tls12') 'the ping opts in to TLS 1.2 for Windows PowerShell 5.1'

Write-Host '== Get-BackupLoginSql / Get-BackupDbUserSql (SQL rights for the backup task) =='
$sql = Get-BackupLoginSql
$dbSql = Get-BackupDbUserSql
Assert-True ($sql -match 'CREATE LOGIN \[NT AUTHORITY\\SYSTEM\] FROM WINDOWS') 'creates the SYSTEM login when missing'
Assert-True ($sql -match 'GRANT CREATE ANY DATABASE TO \[NT AUTHORITY\\SYSTEM\]') 'grants CREATE ANY DATABASE (RESTORE VERIFYONLY)'
Assert-True ($sql -notmatch 'sysadmin' -and $dbSql -notmatch 'sysadmin') 'never makes the account a sysadmin'
Assert-True ($dbSql -match 'owner_sid = SUSER_SID' -and $dbSql -match 'RETURN') 'skips a database the account owns (dbo), where CREATE USER would fail'
Assert-True ($dbSql -match 'CREATE USER \[NT AUTHORITY\\SYSTEM\] FOR LOGIN') 'creates the database user when missing'
Assert-True ($dbSql -match 'ALTER ROLE \[db_backupoperator\] ADD MEMBER \[NT AUTHORITY\\SYSTEM\]') 'adds it to db_backupoperator (BACKUP DATABASE)'
Assert-True ($sql -match 'IF NOT EXISTS' -and $dbSql -match 'IF NOT EXISTS' -and $dbSql -match 'IS_ROLEMEMBER') 'creation steps are guarded, so re-running is safe'
Assert-True ((Get-BackupLoginSql -Account "a'b]c") -match "N'a''b\]c'") 'quotes in the account name are escaped'

Write-Host '== $PSScriptRoot in param() defaults (empty under `powershell -File` on Windows PowerShell 5.1) =='
# Deploy.ps1 is exempt: it is only ever called with & (never -File) from the deploy workflow.
foreach ($script in 'Register-BackupTask.ps1', 'Export-DevData.ps1', 'Backup-Database.ps1', 'Upload-BackupToR2.ps1') {
    $text = Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) $script) -Raw
    Assert-True ($text -notmatch '(?m)^\s*\[\w+\]\s*\$\w+\s*=.*\$PSScriptRoot') "$script resolves PSScriptRoot-based defaults in the body, not in param()"
}

Write-Host '== Set-ConnectionStringDatabase (settings rewrite keeps everything but the database) =='
$cs = 'Server=localhost\SQLEXPRESS;Database=AllotJar;Trusted_Connection=True;Encrypt=True;TrustServerCertificate=True;MultipleActiveResultSets=true'
$renamed = Set-ConnectionStringDatabase -ConnectionString $cs -Database 'AllotJarStaging'
Assert-True ($renamed -eq ($cs -replace 'Database=AllotJar;', 'Database=AllotJarStaging;')) 'only the Database= value changes'
Assert-True ((Set-ConnectionStringDatabase -ConnectionString 'Server=.;Initial Catalog=A;Integrated Security=True' -Database 'B') -eq 'Server=.;Initial Catalog=B;Integrated Security=True') 'Initial Catalog= is handled too'
$threw = $false; try { [void](Set-ConnectionStringDatabase -ConnectionString 'Server=.;Integrated Security=True' -Database 'B') } catch { $threw = $true }
Assert-True $threw 'a connection string without a database throws instead of being left pointing at the default database'

Write-Host '== Set-AncmEnvironmentVariable (ASPNETCORE_ENVIRONMENT pinned per stack in the API web.config) =='
# The web.config `dotnet publish` emits for the API: a self-closing <aspNetCore> under <location>.
$published = @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet" arguments=".\AllotJar.Api.dll" stdoutLogEnabled="false" stdoutLogFile=".\logs\stdout" hostingModel="inprocess" />
    </system.webServer>
  </location>
</configuration>
'@
$staging = Set-AncmEnvironmentVariable -WebConfigXml $published -Name 'ASPNETCORE_ENVIRONMENT' -Value 'Staging'
$doc = [xml]$staging
$vars = @($doc.configuration.location.'system.webServer'.aspNetCore.environmentVariables.environmentVariable)
Assert-True ($vars.Count -eq 1 -and $vars[0].name -eq 'ASPNETCORE_ENVIRONMENT' -and $vars[0].value -eq 'Staging') 'adds ASPNETCORE_ENVIRONMENT=Staging to a published web.config'
Assert-True ($doc.configuration.location.'system.webServer'.aspNetCore.hostingModel -eq 'inprocess') 'the other aspNetCore attributes survive'
$again = Set-AncmEnvironmentVariable -WebConfigXml $staging -Name 'ASPNETCORE_ENVIRONMENT' -Value 'Production'
$vars2 = @(([xml]$again).configuration.location.'system.webServer'.aspNetCore.environmentVariables.environmentVariable)
Assert-True ($vars2.Count -eq 1 -and $vars2[0].value -eq 'Production') 're-running replaces the value instead of adding a second variable'
$threw = $false; try { [void](Set-AncmEnvironmentVariable -WebConfigXml '<configuration><system.webServer /></configuration>' -Name 'X' -Value 'Y') } catch { $threw = $true }
Assert-True $threw 'a web.config without <aspNetCore> (the front site has none) is refused'
# Regression (PR #313 review P1-1): the result is written to disk as UTF-8 by Deploy.ps1, so its
# declaration must say utf-8 and the FILE must load, not just the in-memory string.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ancm-{0}.config" -f [guid]::NewGuid())
[System.IO.File]::WriteAllText($tmp, $staging, (New-Object System.Text.UTF8Encoding($false)))
Assert-True ((Get-Content $tmp -First 1) -match 'encoding="utf-8"') 'the written web.config declares utf-8'
$loaded = $false; try { $d2 = New-Object System.Xml.XmlDocument; $d2.Load($tmp); $loaded = $null -ne $d2.SelectSingleNode('//aspNetCore/environmentVariables/environmentVariable[@name="ASPNETCORE_ENVIRONMENT"]') } catch { $loaded = $false }
Assert-True $loaded 'the web.config file on disk loads with XmlDocument.Load and holds the variable'
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

Write-Host '== Staging is called staging (no stack component of staging is left with a bare or prod name) =='
$deployDir = Split-Path $PSScriptRoot -Parent
$deployScript = Get-Content (Join-Path $deployDir 'Deploy.ps1') -Raw
Assert-True ($deployScript -match 'appsettings\.Staging\.json' -and $deployScript -match 'appsettings\.Production\.json') 'Deploy.ps1 preserves the settings files of both environments across the robocopy mirror'
Assert-True ($deployScript -notmatch "'C:\\inetpub\\allotjar\\") 'Deploy.ps1 no longer defaults to the unsuffixed (pre-rename) staging folders'
$workflow = Get-Content (Join-Path (Split-Path $deployDir -Parent) '.github/workflows/deploy.yml') -Raw
Assert-True ($workflow -notmatch 'staging-prod\b' -and $workflow -notmatch 'incoming-prod\b') 'deploy.yml does not unpack production in a folder called staging-prod'
Assert-True ($workflow -match '-AspNetEnvironment Staging' -and $workflow -match '-AspNetEnvironment Production') 'deploy.yml pins the ASP.NET Core environment of each stack'

Write-Host '== Get-RestoreFileMoves (restoring one database''s backup onto another on the same instance) =='
$data = 'C:\SQL\DATA\'
$prodBak = @(
    [pscustomobject]@{ LogicalName = 'AllotJarProd';     PhysicalName = 'C:\SQL\DATA\AllotJarProd.mdf';     Type = 'D' },
    [pscustomobject]@{ LogicalName = 'AllotJarProd_log'; PhysicalName = 'C:\SQL\DATA\AllotJarProd_log.ldf'; Type = 'L' }
)
$stagingFiles = @(
    [pscustomobject]@{ type_desc = 'ROWS'; physical_name = 'C:\SQL\DATA\AllotJarStaging.mdf' },
    [pscustomobject]@{ type_desc = 'LOG';  physical_name = 'C:\SQL\DATA\AllotJarStaging_log.ldf' }
)
$prodFiles = @(
    [pscustomobject]@{ db = 'AllotJarProd'; physical_name = 'C:\SQL\DATA\AllotJarProd.mdf' },
    [pscustomobject]@{ db = 'AllotJarProd'; physical_name = 'C:\SQL\DATA\AllotJarProd_log.ldf' }
)
# The restore test: production's nightly .bak onto the (renamed) staging database, which keeps its own files.
$plan = Get-RestoreFileMoves -Database AllotJarStaging -BackupFiles $prodBak -TargetFiles $stagingFiles -OtherFiles $prodFiles -DataDir $data
Assert-True $plan.ReusedTargetFiles 'an existing target with matching file counts keeps its own files'
Assert-True ($plan.Moves[0] -eq "MOVE N'AllotJarProd' TO N'C:\SQL\DATA\AllotJarStaging.mdf'") 'the data file lands on the target''s own .mdf'
Assert-True ($plan.Moves[1] -eq "MOVE N'AllotJarProd_log' TO N'C:\SQL\DATA\AllotJarStaging_log.ldf'") 'the log file lands on the target''s own .ldf'
Assert-True (-not ($plan.Targets -contains 'C:\SQL\DATA\AllotJarProd.mdf')) 'production''s live .mdf is never a destination'
# A target that does not exist yet gets its own names, never the backup's leaf names.
$plan = Get-RestoreFileMoves -Database AllotJarStaging -BackupFiles $prodBak -OtherFiles $prodFiles -DataDir $data -LogDir 'C:\SQL\LOG\'
Assert-True (-not $plan.ReusedTargetFiles) 'a missing target does not reuse files'
Assert-True ($plan.Targets[0] -eq 'C:\SQL\DATA\AllotJarStaging.mdf') 'a missing target gets <Database>.mdf in the data folder'
Assert-True ($plan.Targets[1] -eq 'C:\SQL\LOG\AllotJarStaging_log.ldf') 'a missing target gets <Database>_log.ldf in the log folder'
# The old behaviour (default folder + the backup's own leaf names) is exactly what must be refused.
$collide = @([pscustomobject]@{ type_desc = 'ROWS'; physical_name = 'C:\SQL\DATA\AllotJarProd.mdf' }, [pscustomobject]@{ type_desc = 'LOG'; physical_name = 'C:\SQL\DATA\AllotJarProd_log.ldf' })
$threw = $false
try { Get-RestoreFileMoves -Database AllotJarStaging -BackupFiles $prodBak -TargetFiles $collide -OtherFiles $prodFiles -DataDir $data | Out-Null } catch { $threw = $_.Exception.Message -match 'AllotJarProd' }
Assert-True $threw 'a destination that is another database''s live file is refused, naming that database'
# Restoring production's own backup over production (rollback) still reuses production's files.
$prodOwn = @([pscustomobject]@{ type_desc = 'ROWS'; physical_name = 'C:\SQL\DATA\AllotJarProd.mdf' }, [pscustomobject]@{ type_desc = 'LOG'; physical_name = 'C:\SQL\DATA\AllotJarProd_log.ldf' })
$plan = Get-RestoreFileMoves -Database AllotJarProd -BackupFiles $prodBak -TargetFiles $prodOwn -OtherFiles @() -DataDir $data
Assert-True ($plan.ReusedTargetFiles -and $plan.Targets[0] -eq 'C:\SQL\DATA\AllotJarProd.mdf') 'restoring a database over itself keeps its files'
# A file count mismatch falls back to fresh names rather than guessing a pairing.
$twoData = $prodBak + @([pscustomobject]@{ LogicalName = 'AllotJarProd_2'; PhysicalName = 'C:\SQL\DATA\AllotJarProd_2.ndf'; Type = 'D' })
$plan = Get-RestoreFileMoves -Database AllotJarStaging -BackupFiles $twoData -TargetFiles $stagingFiles -OtherFiles $prodFiles -DataDir $data
Assert-True ((-not $plan.ReusedTargetFiles) -and $plan.Targets[1] -eq 'C:\SQL\DATA\AllotJarStaging_1.ndf') 'a file-count mismatch uses fresh <Database>_n.ndf names'

Write-Host '== Get-StackSettingsProblems (a settings file must fit its stack) =='
# Staging's real file shape: // comments, a "//" key, the staging database, no AppBaseUrl.
# This is the 12 October 2026 bug: the API's default origin is production, so staging's
# reset emails linked to www.allotjar.com.
$stagingNoUrl = @'
{
  // server-only settings
  "ConnectionStrings": {
    "//": "Database is AllotJarStaging for staging.",
    "DefaultConnection": "Server=localhost\\SQLEXPRESS;Database=AllotJarStaging;Trusted_Connection=True;Encrypt=True;TrustServerCertificate=True;MultipleActiveResultSets=true"
  },
  "Email": {
    "Provider": "cloudflare",
    "FromAddress": "AllotJar <no-reply@allotjar.com>"
  }
}
'@
$p = Get-StackSettingsProblems -SettingsText $stagingNoUrl -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'AppBaseUrl is missing' -and $p[0] -match 'https://staging\.allotjar\.com') 'staging without Email:AppBaseUrl is refused, naming the staging origin'
$p = Get-StackSettingsProblems -SettingsText ($stagingNoUrl -replace 'AllotJarStaging', 'AllotJarProd') -AspNetEnvironment Production
Assert-True ($p.Count -eq 0) 'production may omit Email:AppBaseUrl (the built-in default is its own origin)'

$stagingOk = $stagingNoUrl -replace '"Provider": "cloudflare",', '"Provider": "cloudflare", "AppBaseUrl": "https://staging.allotjar.com",'
$p = Get-StackSettingsProblems -SettingsText $stagingOk -AspNetEnvironment Staging
Assert-True ($p.Count -eq 0) 'staging naming its own database and origin passes'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'https://staging\.allotjar\.com', 'HTTPS://Staging.AllotJar.com/') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 0) 'origin comparison ignores case and a trailing slash'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'https://staging\.allotjar\.com', 'https://www.allotjar.com') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'would open https://www\.allotjar\.com') 'staging pointing emailed links at production is refused'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'https://staging\.allotjar\.com', 'staging.allotjar.com') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'not an absolute http') 'a schemeless AppBaseUrl is refused'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'Database=AllotJarStaging', 'Database=AllotJarProd') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'Database=AllotJarProd' -and $p[0] -match 'AllotJarStaging') 'staging naming the production database is refused'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'Database=AllotJarStaging;', '') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'names no database') 'a connection string without a database is refused'
$p = Get-StackSettingsProblems -SettingsText '{ "Jwt": { "Key": "x" } }' -AspNetEnvironment Staging
Assert-True ($p.Count -eq 2 -and $p[0] -match 'DefaultConnection is missing') 'a file without a connection string reports every problem'
# Both wrong at once: the staging stack reading a copy of production's file.
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'AllotJarStaging', 'AllotJarProd' -replace 'staging\.allotjar', 'www.allotjar') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 2) 'a production file under the staging name reports the database and the origin'
# A commented-out line neither satisfies nor fails a check.
$p = Get-StackSettingsProblems -SettingsText ($stagingNoUrl -replace '"Provider": "cloudflare",', "`"Provider`": `"cloudflare`",`n    // `"AppBaseUrl`": `"https://staging.allotjar.com`",") -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'AppBaseUrl is missing') 'a commented-out AppBaseUrl does not count'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace '"Email": \{', '"Email": { "AppBaseUrl": "https://staging.allotjar.com",') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'appears 2 times') 'two AppBaseUrl entries are refused rather than guessed between'
# Production is public at the apex as well as www: both fit, and only those two.
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'AllotJarStaging', 'AllotJarProd' -replace 'https://staging\.allotjar\.com', 'https://allotjar.com') -AspNetEnvironment Production
Assert-True ($p.Count -eq 0) 'production naming the apex origin passes'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'AllotJarStaging', 'AllotJarProd' -replace 'https://staging\.allotjar\.com', 'https://www.allotjar.com') -AspNetEnvironment Production
Assert-True ($p.Count -eq 0) 'production naming the www origin passes'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'AllotJarStaging', 'AllotJarProd' -replace 'https://staging\.allotjar\.com', 'https://app.allotjar.com') -AspNetEnvironment Production
Assert-True ($p.Count -eq 1 -and $p[0] -match 'https://www\.allotjar\.com or https://allotjar\.com') 'production naming another host is refused, listing both accepted origins'
$p = Get-StackSettingsProblems -SettingsText ($stagingOk -replace 'https://staging\.allotjar\.com', 'https://allotjar.com') -AspNetEnvironment Staging
Assert-True ($p.Count -eq 1 -and $p[0] -match 'would open https://allotjar\.com') 'staging pointing emailed links at the apex is refused'
# Production must never name staging.
$prodWrong = $stagingOk -replace 'AllotJarStaging', 'AllotJarProd'
$p = Get-StackSettingsProblems -SettingsText $prodWrong -AspNetEnvironment Production
Assert-True ($p.Count -eq 1 -and $p[0] -match 'would open https://staging\.allotjar\.com') 'production pointing emailed links at staging is refused'
# The expected values can be overridden (another domain, another database name).
$p = Get-StackSettingsProblems -SettingsText $stagingOk -AspNetEnvironment Staging -ExpectedDatabase 'Other' -ExpectedAppBaseUrl 'https://test.example'
Assert-True ($p.Count -eq 2) 'overridden expectations are honoured'

Write-Host '== Get-BackupCryptRemoteProblems / Get-RcloneConfValue (uploads are encrypted or refused) =='
$goodConf = "[r2]`ntype = s3`nprovider = Cloudflare`n`n[r2crypt]`ntype = crypt`nremote = r2:allotjar/db-backups-enc`nfilename_encryption = off`ndirectory_name_encryption = false`npassword = AAA`npassword2 = BBB`n"
$cp = @{ CryptRemote = 'r2crypt'; Remote = 'r2'; Bucket = 'allotjar'; Prefix = 'db-backups-enc' }
Assert-True ((Get-RcloneConfValue -ConfText $goodConf -Section 'r2crypt' -Key 'remote') -eq 'r2:allotjar/db-backups-enc') 'reads a value from the named section'
Assert-True ($null -eq (Get-RcloneConfValue -ConfText $goodConf -Section 'r2' -Key 'password')) 'a key of another section is not picked up'
Assert-True (@(Get-BackupCryptRemoteProblems -ConfText $goodConf @cp).Count -eq 0) 'a complete crypt remote passes'
Assert-True (@(Get-BackupCryptRemoteProblems -ConfText ($goodConf -replace "`r?`n", "`r`n") @cp).Count -eq 0) 'CRLF config passes'
$noCrypt = @(Get-BackupCryptRemoteProblems -ConfText "[r2]`ntype = s3`n" @cp)
Assert-True ($noCrypt.Count -eq 1 -and $noCrypt[0] -match 'not be encrypted') 'no crypt remote is refused (no plain-text fallback)'
Assert-True (@(Get-BackupCryptRemoteProblems -ConfText ($goodConf -replace 'db-backups-enc', 'db-backups') @cp).Count -eq 1) 'a crypt remote aimed at the plain folder is refused'
Assert-True (@(Get-BackupCryptRemoteProblems -ConfText ($goodConf -replace 'allotjar/', 'other/') @cp).Count -eq 1) 'a crypt remote aimed at another bucket is refused'
Assert-True (@(Get-BackupCryptRemoteProblems -ConfText ($goodConf -replace 'type = crypt', 'type = alias') @cp).Count -eq 1) 'a non-crypt remote is refused'
Assert-True (@(Get-BackupCryptRemoteProblems -ConfText ($goodConf -replace 'password2 = BBB', '') @cp).Count -eq 1) 'a missing salt is refused'
Assert-True (@(Get-BackupCryptRemoteProblems -ConfText ($goodConf -replace 'filename_encryption = off', 'filename_encryption = standard') @cp).Count -eq 1) 'encrypted file names are refused (the newest backup could not be found)'

Write-Host '== Test-RcloneCryptFile =='
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("crypt-magic-" + [guid]::NewGuid().ToString('N'))
try {
    [IO.File]::WriteAllBytes($tmp, [byte[]](0x52, 0x43, 0x4C, 0x4F, 0x4E, 0x45, 0x00, 0x00, 1, 2, 3))
    Assert-True (Test-RcloneCryptFile -Path $tmp) 'rclone crypt magic is recognised'
    [IO.File]::WriteAllBytes($tmp, [System.Text.Encoding]::ASCII.GetBytes('TAPE'))
    Assert-True (-not (Test-RcloneCryptFile -Path $tmp)) 'a short file is not encrypted'
    [IO.File]::WriteAllBytes($tmp, [System.Text.Encoding]::ASCII.GetBytes('TAPE....and more bytes'))
    Assert-True (-not (Test-RcloneCryptFile -Path $tmp)) 'a .bak header is not encrypted'
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }

Write-Host '== Get-UrlOrigin =='
Assert-True ((Get-UrlOrigin -Url 'HTTPS://Staging.AllotJar.com/reset?x=1') -eq 'https://staging.allotjar.com') 'origin drops path and case'
Assert-True ((Get-UrlOrigin -Url 'http://127.0.0.1:5000/') -eq 'http://127.0.0.1:5000') 'origin keeps a non-default port'
Assert-True ($null -eq (Get-UrlOrigin -Url 'www.allotjar.com')) 'a bare host is not an origin'
Assert-True ($null -eq (Get-UrlOrigin -Url 'ftp://allotjar.com')) 'a non-http scheme is not an origin'
Assert-True ($null -eq (Get-UrlOrigin -Url '')) 'empty is not an origin'

Write-Host '== Get-AppPoolSid (IIS AppPool identity SIDs) =='
# The well-known SID of IIS AppPool\DefaultAppPool proves the algorithm (lower-cased name, SHA-1).
Assert-True ((Get-AppPoolSid -Name 'DefaultAppPool') -eq 'S-1-5-82-3006700770-424185619-1745488364-794895919-4004696415') 'DefaultAppPool has its well-known SID'
Assert-True ((Get-AppPoolSid -Name 'DEFAULTAPPPOOL') -eq (Get-AppPoolSid -Name 'defaultapppool')) 'the pool name is case-insensitive'
Assert-True ((Get-AppPoolSid -Name 'ZeroBudget-Prod-Api') -ne (Get-AppPoolSid -Name 'AllotJar-Prod-Api')) 'a renamed pool has a new SID'

Write-Host '== Convert-ZeroBudgetNames (old server names -> AllotJar) =='
$cs = 'Server=localhost\\SQLEXPRESS;Database=ZeroBudgetProd;Trusted_Connection=True'
Assert-True ((Convert-ZeroBudgetNames -Text $cs) -eq 'Server=localhost\\SQLEXPRESS;Database=AllotJarProd;Trusted_Connection=True') 'the production database name changes'
Assert-True ((Convert-ZeroBudgetNames -Text 'Database=ZeroBudgetStaging;') -eq 'Database=AllotJarStaging;') 'the staging database name changes'
Assert-True ((Convert-ZeroBudgetNames -Text '"KeysPath": "C:\\inetpub\\zerobudget-dp-keys"') -eq '"KeysPath": "C:\\inetpub\\allotjar-prod-dp-keys"') 'production''s key folder gets prod in its name'
Assert-True ((Convert-ZeroBudgetNames -Text 'C:\inetpub\zerobudget-staging-dp-keys') -eq 'C:\inetpub\allotjar-staging-dp-keys') 'staging''s key folder changes'
Assert-True ((Convert-ZeroBudgetNames -Text 'IIS APPPOOL\ZeroBudget-Prod-Api and ZeroBudget-Prod') -eq 'IIS APPPOOL\AllotJar-Prod-Api and AllotJar-Prod') 'pool and site names change whole'
Assert-True ((Convert-ZeroBudgetNames -Text 'C:\inetpub\zerobudget-prod\api') -eq 'C:\inetpub\allotjar-prod\api') 'the stack folder changes'
Assert-True ((Convert-ZeroBudgetNames -Text '-Database "ZeroBudgetProd" -PingUrl "https://hc-ping.com/x"') -eq '-Database "AllotJarProd" -PingUrl "https://hc-ping.com/x"') 'a backup task argument changes, the ping URL does not'
Assert-True ((Convert-ZeroBudgetNames -Text '"Issuer": "ZeroBudget", "Recipient": "zerobudget.alerts@example.com"') -eq '"Issuer": "ZeroBudget", "Recipient": "zerobudget.alerts@example.com"') 'a bare ZeroBudget and unrelated values are left alone'
Assert-True ((Convert-ZeroBudgetNames -Text 'AllotJarProd') -eq 'AllotJarProd') 'an already renamed name stays as it is'

Write-Host '== Get-ZeroBudgetLineNumbers =='
$lines = Get-ZeroBudgetLineNumbers -Text "{`r`n  `"a`": `"ZEROBUDGET`",`r`n  `"b`": 1,`r`n  `"c`": `"zerobudget-x`"`r`n}"
Assert-True (($lines -join ',') -eq '2,4') 'lines mentioning the old name in any case are listed'
Assert-True ((Get-ZeroBudgetLineNumbers -Text 'AllotJar').Count -eq 0) 'no mention, no lines'

Write-Host '== Convert-ScheduledTaskXml (re-register a task under its AllotJar name) =='
$taskXml = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\ZeroBudget-Prod-DbBackup</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-11-01T19:00:00</StartBoundary>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "C:\deploy\Backup-Database.ps1" -Server ".\SQLEXPRESS" -Database "ZeroBudgetProd" -BackupDir "C:\deploy\backups" -RetentionDays 14 -R2Bucket "allotjar" -PingUrl "https://hc-ping.com/abc"</Arguments>
    </Exec>
  </Actions>
</Task>
'@
$newXml = Convert-ScheduledTaskXml -Xml $taskXml -NewTaskName 'AllotJar-Prod-DbBackup'
$cmds = Get-ScheduledTaskXmlCommands -Xml $newXml
Assert-True ($cmds.Count -eq 1 -and $cmds[0] -match '-Database "AllotJarProd"') 'the backup task backs up the renamed database'
Assert-True ($cmds[0] -match '-R2Bucket "allotjar"' -and $cmds[0] -match 'hc-ping\.com/abc') 'R2 and ping arguments are kept'
Assert-True ($cmds[0] -notmatch '(?i)zerobudget') 'no old name is left in the command line'
Assert-True ($newXml -match '<URI>\\AllotJar-Prod-DbBackup</URI>') 'the task URI names the new task'
Assert-True ($newXml -match '<StartBoundary>2026-11-01T19:00:00</StartBoundary>' -and $newXml -match 'IgnoreNew' -and $newXml -match 'PT1H') 'trigger and settings are kept exactly'
$oldCmds = Get-ScheduledTaskXmlCommands -Xml $taskXml
Assert-True ((Convert-ZeroBudgetNames -Text $oldCmds[0]) -eq $cmds[0]) 'the new command line is the old one with the names changed and nothing else'

Write-Host '== Every deploy script parses =='
# The server scripts run only on Windows, so this is the one place CI sees a syntax error in them.
foreach ($f in @(Get-ChildItem -Path (Split-Path $PSScriptRoot -Parent) -Include '*.ps1', '*.psm1' -Recurse -File)) {
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
    Assert-True (-not $errs) ("{0} parses{1}" -f $f.Name, $(if ($errs) { ": $($errs[0].Message) (line $($errs[0].Extent.StartLineNumber))" } else { '' }))
}

if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) assertion(s) FAILED." -ForegroundColor Red
    exit 1
}
Write-Host 'All deploy-helper assertions passed.' -ForegroundColor Green
exit 0
