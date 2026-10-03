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
    -Database 'ZeroBudget' -BackupDir 'C:\deploy\backups' -RetentionDays 14
Assert-True ($local -notmatch '-R2Bucket') 'local-only line carries no R2 arguments'
Assert-True ($null -eq (Get-R2BucketFromArgumentLine -ArgumentLine $local)) 'no bucket parsed from a local-only line'

$prod = New-BackupTaskArgumentLine -ScriptPath 'C:\deploy\Backup-Database.ps1' -Server '.\SQLEXPRESS' `
    -Database 'ZeroBudgetProd' -BackupDir 'C:\deploy\backups' -RetentionDays 14 `
    -R2Bucket 'allotjar-db-backups' -Rclone 'C:\deploy\rclone\rclone.exe' `
    -RcloneConf 'C:\deploy\rclone.conf' -R2Remote 'r2' -R2Prefix 'db-backups'
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

if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) assertion(s) FAILED." -ForegroundColor Red
    exit 1
}
Write-Host 'All deploy-helper assertions passed.' -ForegroundColor Green
exit 0
