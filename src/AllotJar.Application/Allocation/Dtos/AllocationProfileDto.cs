using AllotJar.Application.Common;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Allocation.Dtos;

public class AllocationProfileDto
{
    public Guid Id { get; set; }

    /// <summary>The row version the edit form sends back with its save (D11); null where the store keeps none.</summary>
    public string? Version { get; set; }

    public string Name { get; set; } = string.Empty;
    /// <summary>The account the allocation pays out of; null when <see cref="SourcePrivate"/> (P53).</summary>
    public Guid? SourceAccountId { get; set; }

    /// <summary>
    /// P53: the source is set but its holder has since made it private, so the viewer is told that
    /// much without its id. Only that holder can commit from it; anyone may choose another source.
    /// </summary>
    public bool SourcePrivate { get; set; }

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
    /// <param name="sourceHidden">The source is private to another login (<see cref="Accounts.HiddenAccounts"/>).</param>
    public static AllocationProfileDto ToDto(this AllocationProfile p, bool sourceHidden) => new()
    {
        Id = p.Id,
        Version = EditVersions.Of(p),
        Name = p.Name,
        SourceAccountId = sourceHidden ? null : p.SourceAccountId,
        SourcePrivate = sourceHidden,
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
