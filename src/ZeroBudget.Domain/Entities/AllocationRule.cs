using ZeroBudget.Domain.Common;
using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Domain.Entities;

/// <summary>
/// One step in an <see cref="AllocationProfile"/>'s waterfall. The amount for
/// <see cref="AllocationRuleType.FundEnvelopes"/> / <see cref="AllocationRuleType.FundJars"/>
/// is derived live from the month's budget (not stored); <see cref="FixedAmountPerMember"/>
/// applies to <see cref="AllocationRuleType.FixedPerMember"/>.
/// </summary>
public class AllocationRule : BaseEntity
{
    public Guid AllocationProfileId { get; set; }
    public AllocationProfile AllocationProfile { get; set; } = null!;

    public int Order { get; set; }

    public AllocationRuleType Type { get; set; }

    public SplitMethod Split { get; set; } = SplitMethod.Equal;

    /// <summary>The per-member amount for a <see cref="AllocationRuleType.FixedPerMember"/> rule (e.g. pocket money). Mapped to decimal(18,4).</summary>
    public decimal FixedAmountPerMember { get; set; }
}
