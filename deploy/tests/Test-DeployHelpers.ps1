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

if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) assertion(s) FAILED." -ForegroundColor Red
    exit 1
}
Write-Host 'All deploy-helper assertions passed.' -ForegroundColor Green
exit 0
