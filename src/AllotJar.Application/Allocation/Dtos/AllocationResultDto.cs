using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Allocation.Dtos;

/// <summary>The computed allocation for a month — the waterfall steps and each member's surplus.</summary>
public class AllocationResultDto
{
    public decimal Pool { get; set; }
    public decimal EnvelopesTotal { get; set; }
    public decimal JarsTotal { get; set; }
    public IReadOnlyList<AllocationStepDto> Steps { get; set; } = Array.Empty<AllocationStepDto>();
    public IReadOnlyList<MemberAllocationDto> Members { get; set; } = Array.Empty<MemberAllocationDto>();

    /// <summary>How many savings transfers a commit recorded (0 for a preview).</summary>
    public int TransfersCreated { get; set; }

    /// <summary>
    /// How many of this month's previously recorded transfers a commit left exactly as recorded
    /// because the movement was unchanged (0 for a preview). Distinguishes "nothing changed" from
    /// "nothing to save".
    /// </summary>
    public int TransfersRetained { get; set; }

    /// <summary>
    /// Always true since rule 28: the pool is the month's budgeted income lines and nothing
    /// else. Kept so older clients and fixtures keep their shape.
    /// </summary>
    public bool IncomeFromBudget { get; set; }

    /// <summary>
    /// Budgeted income not attributed to any active person, shared equally across members.
    /// </summary>
    public decimal UnattributedIncome { get; set; }
}

public class AllocationStepDto
{
    public AllocationRuleType Type { get; set; }
    public decimal Total { get; set; }
    public IReadOnlyList<MemberShareDto> PerMember { get; set; } = Array.Empty<MemberShareDto>();
}

public class MemberShareDto
{
    public Guid MemberId { get; set; }
    public string Name { get; set; } = string.Empty;
    public decimal Amount { get; set; }
}

public class MemberAllocationDto
{
    public Guid MemberId { get; set; }
    public string Name { get; set; } = string.Empty;
    public decimal NetIncome { get; set; }
    public decimal Residual { get; set; }

    /// <summary>
    /// The member's actual savings-account balance today, before this month's allocation (for
    /// the balance-tilt view). Null when unavailable — the account has no opening date — rather
    /// than zero.
    /// </summary>
    public decimal? SavingsBalance { get; set; }

    public Guid? SavingsAccountId { get; set; }
}

public static class AllocationResultMapping
{
    public static AllocationResultDto ToDto(
        this AllocationResult r,
        decimal envelopesTotal,
        decimal jarsTotal,
        int transfersCreated = 0,
        decimal unattributedIncome = 0m,
        bool incomeFromBudget = false,
        int transfersRetained = 0) => new()
    {
        Pool = r.Pool,
        EnvelopesTotal = envelopesTotal,
        JarsTotal = jarsTotal,
        TransfersCreated = transfersCreated,
        TransfersRetained = transfersRetained,
        IncomeFromBudget = incomeFromBudget,
        UnattributedIncome = unattributedIncome,
        Steps = r.Steps
            .Select(s => new AllocationStepDto
            {
                Type = s.Type,
                Total = s.Total,
                PerMember = s.PerMember
                    .Select(m => new MemberShareDto { MemberId = m.MemberId, Name = m.Name, Amount = m.Amount })
                    .ToList(),
            })
            .ToList(),
        Members = r.Members
            .Select(m => new MemberAllocationDto
            {
                MemberId = m.MemberId,
                Name = m.Name,
                NetIncome = m.NetIncome,
                Residual = m.Residual,
                SavingsBalance = m.SavingsBalanceAvailable ? m.SavingsBalance : null,
                SavingsAccountId = m.SavingsAccountId,
            })
            .ToList(),
    };
}
