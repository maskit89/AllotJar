using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Allocation.Dtos;

public class AllocationProfileDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public Guid? SourceAccountId { get; set; }

    /// <summary>How hard a balance-tilt savings split leans toward equalising balances (0–100).</summary>
    public int BalanceLeanPercent { get; set; }

    public IReadOnlyList<AllocationRuleDto> Rules { get; set; } = Array.Empty<AllocationRuleDto>();
}

public class AllocationRuleDto
{
    public Guid Id { get; set; }
    public int Order { get; set; }
    public AllocationRuleType Type { get; set; }
    public SplitMethod Split { get; set; }
    public decimal FixedAmountPerMember { get; set; }
}

public static class AllocationProfileMapping
{
    public static AllocationProfileDto ToDto(this AllocationProfile p) => new()
    {
        Id = p.Id,
        Name = p.Name,
        SourceAccountId = p.SourceAccountId,
        BalanceLeanPercent = p.BalanceLeanPercent,
        Rules = p.Rules
            .OrderBy(r => r.Order)
            .Select(r => new AllocationRuleDto
            {
                Id = r.Id,
                Order = r.Order,
                Type = r.Type,
                Split = r.Split,
                FixedAmountPerMember = r.FixedAmountPerMember,
            })
            .ToList(),
    };
}
