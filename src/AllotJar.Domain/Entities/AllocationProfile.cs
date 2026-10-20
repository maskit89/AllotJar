using AllotJar.Domain.Common;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A named, ordered set of rules describing how the household's pooled net income is
/// routed each month (the spreadsheet's "Salary Split"). Shared costs are funded first,
/// then the surplus is split to each member's personal savings.
/// </summary>
public class AllocationProfile : BaseEntity, IVersioned
{
    /// <inheritdoc />
    public byte[] Version { get; set; } = [];

    public string OwnerId { get; set; } = string.Empty;

    [MaskCardNumbers]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// The account the allocated surplus is transferred out of when committing (e.g. the
    /// joint current account). A soft hint (no FK); required only to commit an allocation.
    /// </summary>
    public Guid? SourceAccountId { get; set; }

    /// <summary>
    /// How hard a <see cref="Enums.SplitMethod.BalanceTilt"/> savings split leans toward equalising
    /// the members' saving-account balances (0 = plain even split, 100 = fully fill the lowest
    /// first). Default 25 — a gentle lean where everyone still saves something each month.
    /// </summary>
    public int BalanceLeanPercent { get; set; } = 25;

    public ICollection<AllocationRule> Rules { get; set; } = new List<AllocationRule>();
}
