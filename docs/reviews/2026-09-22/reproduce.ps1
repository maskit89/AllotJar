$ErrorActionPreference = 'Stop'
$repo = Join-Path $PSScriptRoot '../../..'
$sources = @('Common/BaseEntity.cs','Enums/JarKind.cs','Enums/AccrualMethod.cs','Enums/AllocationRuleType.cs','Enums/SplitMethod.cs','Entities/Jar.cs','Services/JarAccrualCalculator.cs','Services/IncomeAllocator.cs') | ForEach-Object { Get-Content -Raw (Join-Path "$repo/src/AllotJar.Domain" $_) }
$sources += Get-Content -Raw "$repo/src/AllotJar.Application/Jars/Dtos/JarDto.cs"
$code = "#nullable enable`nglobal using System;`nglobal using System.Linq;`nglobal using System.Collections.Generic;`nglobal using AllotJar.Domain.Common;`nglobal using AllotJar.Domain.Entities;`nglobal using AllotJar.Domain.Enums;`nglobal using AllotJar.Domain.Services;`n"
foreach ($source in $sources) {
    $source = [regex]::Replace($source, '(?m)^using [\w.]+;\r?\n', '')
    $code += [regex]::Replace($source, 'namespace ([\w.]+);', 'namespace $1 {') + "`n}`n"
}
Add-Type -TypeDefinition $code -WarningAction SilentlyContinue
$jar = [AllotJar.Domain.Entities.Jar]::new()
$jar.Kind = [AllotJar.Domain.Enums.JarKind]::Recurring
$jar.Accrual = [AllotJar.Domain.Enums.AccrualMethod]::TargetByDate
$jar.TargetAmount = 1200
$jar.TargetDate = [DateOnly]::new(2026,9,1)
$jar.RecurMonths = 12
$asOf = [DateOnly]::new(2026,9,22)
'Recurring due Sep 1, as of Sep 22: effective date and monthly contribution'
[AllotJar.Domain.Services.JarAccrualCalculator]::EffectiveTargetDate($jar,$asOf).ToString('yyyy-MM-dd')
[AllotJar.Domain.Services.JarAccrualCalculator]::TargetByDate($jar,$asOf,0)
$jar.Kind = [AllotJar.Domain.Enums.JarKind]::Goal
$jar.TargetAmount = 100
$jar.TargetDate = [DateOnly]::new(2026,12,22)
$monthly = [AllotJar.Domain.Services.JarAccrualCalculator]::TargetByDate($jar,$asOf,0)
'100 target over 3 months: monthly, three payments, projected finish'
$monthly
$monthly * 3
[AllotJar.Application.Jars.Dtos.JarMapping]::ToDto($jar,0,$monthly,$asOf).ProjectedFullyFundedDate.ToString('yyyy-MM-dd')
$jar.TargetAmount = 1200
$jar.TargetDate = $null
$balance = [decimal]0
1..12 | ForEach-Object { $balance += [AllotJar.Domain.Services.JarAccrualCalculator]::TargetByDate($jar,$asOf.AddMonths($_-1),$balance) }
'No-date 1200 goal: balance after twelve recalculated monthly contributions'
$balance
$members = [System.Collections.Generic.List[AllotJar.Domain.Services.AllocationMember]]::new()
1..4 | ForEach-Object { $members.Add([AllotJar.Domain.Services.AllocationMember]::new([Guid]::NewGuid(),"Member $_",1,$null,0)) }
$rules = [System.Collections.Generic.List[AllotJar.Domain.Services.AllocationRuleInput]]::new()
$rules.Add([AllotJar.Domain.Services.AllocationRuleInput]::new(0,[AllotJar.Domain.Enums.AllocationRuleType]::FundEnvelopes,[AllotJar.Domain.Enums.SplitMethod]::Equal,0,0.02))
'Equal split of 0.02 across four people'
[AllotJar.Domain.Services.IncomeAllocator]::Compute($members,$rules,25).Steps[0].PerMember | Select-Object Name,Amount
