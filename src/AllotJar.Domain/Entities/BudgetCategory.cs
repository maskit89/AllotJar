using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A grouping of budget lines within a single month. Most groups are expenses
/// (e.g. "Housing", "Transport"); an <see cref="CategoryKind.Income"/> group sits
/// at the top and holds the user's income sources.
/// </summary>
public class BudgetCategory : BaseEntity, IVersioned
{
    /// <inheritdoc />
    public byte[] Version { get; set; } = [];

    public Guid BudgetMonthId { get; set; }
    public BudgetMonth BudgetMonth { get; set; } = null!;

    [MaskCardNumbers]
    public string Name { get; set; } = string.Empty;

    /// <summary>Whether this group holds income sources or planned expenses.</summary>
    public CategoryKind Kind { get; set; } = CategoryKind.Expense;

    /// <summary>
    /// When true, the income-allocation engine ignores this category's planned amounts as a
    /// shared obligation. Used for categories that represent an allocation *output* rather than
    /// a cost (e.g. "Personal Savings"), so the surplus isn't subtracted from the pool twice.
    /// </summary>
    public bool ExcludeFromAllocation { get; set; }

    public int DisplayOrder { get; set; }

    public ICollection<BudgetItem> Items { get; set; } = new List<BudgetItem>();

    /// <summary>Sum of all planned amounts for the lines in this category.</summary>
    public decimal TotalPlanned => Items.Sum(i => i.PlannedAmount);

    /// <summary>Sum of all actual amounts for the lines in this category.</summary>
    public decimal TotalActual => Items.Sum(i => i.ActualAmount);
}
