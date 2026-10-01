using AllotJar.Application.Allocation;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Household.Dtos;

public class HouseholdMemberDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>The saved default income: a helper for filling in a new budget, never a figure any calculation uses (rule 28).</summary>
    public decimal NetMonthlyIncome { get; set; }

    /// <summary>This member's income in the selected month's budget: their attributed income lines plus an equal share of the unattributed ones.</summary>
    public decimal BudgetIncome { get; set; }

    /// <summary>The year and month <see cref="BudgetIncome"/> and <see cref="IncomeSharePct"/> were read from.</summary>
    public int IncomeYear { get; set; }
    public int IncomeMonth { get; set; }

    /// <summary>False when that month has no budget yet (income and share are then zero).</summary>
    public bool HasBudget { get; set; }

    /// <summary>The person's savings account; null when <see cref="SavingsPrivate"/> (P56: the others never receive its id).</summary>
    public Guid? PersonalSavingsAccountId { get; set; }

    /// <summary>
    /// P53: the person has a savings account, but it is private to another login, so the viewer
    /// sees that one is set without its id (as <c>MemberAllocationDto.SavingsPrivate</c> does).
    /// </summary>
    public bool SavingsPrivate { get; set; }
    public int DisplayOrder { get; set; }
    public bool IsArchived { get; set; }

    /// <summary>This member's share of the household's income in the selected month's budget (0–1), the figure an income-based split uses.</summary>
    public decimal IncomeSharePct { get; set; }
}

public static class HouseholdMemberMapping
{
    /// <param name="shares">The month's budget income per member (rule 28), from <see cref="MemberIncome.SharesAsync"/>.</param>
    /// <param name="hiddenAccounts">Accounts private to another login, from <see cref="Accounts.HiddenAccounts.AmongAsync"/>.</param>
    public static HouseholdMemberDto ToDto(
        this HouseholdMember m, MemberIncomeShares shares, int year, int month, IReadOnlySet<Guid> hiddenAccounts) => new()
    {
        Id = m.Id,
        Name = m.Name,
        NetMonthlyIncome = m.NetMonthlyIncome,
        BudgetIncome = shares.Income.GetValueOrDefault(m.Id),
        IncomeYear = year,
        IncomeMonth = month,
        HasBudget = shares.HasBudget,
        PersonalSavingsAccountId = SavingsHidden(m, hiddenAccounts) ? null : m.PersonalSavingsAccountId,
        SavingsPrivate = SavingsHidden(m, hiddenAccounts),
        DisplayOrder = m.DisplayOrder,
        IsArchived = m.IsArchived,
        IncomeSharePct = shares.ShareOf(m.Id),
    };

    private static bool SavingsHidden(HouseholdMember m, IReadOnlySet<Guid> hiddenAccounts) =>
        m.PersonalSavingsAccountId is Guid id && hiddenAccounts.Contains(id);
}
