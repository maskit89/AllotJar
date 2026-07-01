using AllotJar.Domain.Entities;

namespace AllotJar.Application.Household.Dtos;

public class HouseholdMemberDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public decimal NetMonthlyIncome { get; set; }
    public Guid? PersonalSavingsAccountId { get; set; }
    public int DisplayOrder { get; set; }
    public bool IsArchived { get; set; }

    /// <summary>This member's share of the household's total net income (0–1), used by the allocation split.</summary>
    public decimal IncomeSharePct { get; set; }
}

public static class HouseholdMemberMapping
{
    public static HouseholdMemberDto ToDto(this HouseholdMember m, decimal totalActiveNet) => new()
    {
        Id = m.Id,
        Name = m.Name,
        NetMonthlyIncome = m.NetMonthlyIncome,
        PersonalSavingsAccountId = m.PersonalSavingsAccountId,
        DisplayOrder = m.DisplayOrder,
        IsArchived = m.IsArchived,
        IncomeSharePct = totalActiveNet > 0m
            ? Math.Round(m.NetMonthlyIncome / totalActiveNet, 4, MidpointRounding.AwayFromZero)
            : 0m,
    };
}
