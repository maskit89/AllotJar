using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Dtos;

/// <summary>
/// A sinking fund with its read-time-derived figures (balance, required monthly
/// contribution, projection and status). Enum fields are serialised as their numeric
/// value, mirroring <see cref="AccountType"/>.
/// </summary>
public class JarDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public JarKind Kind { get; set; }
    public decimal TargetAmount { get; set; }
    public DateOnly? TargetDate { get; set; }
    public DateOnly? CoverStart { get; set; }
    public DateOnly? CoverEnd { get; set; }
    public AccrualMethod Accrual { get; set; }

    /// <summary>A Recurring jar's cycle length in months (its date rolls forward by this); null for Goals.</summary>
    public int? RecurMonths { get; set; }
    public decimal OpeningBalance { get; set; }
    public DateOnly? OpeningAsOf { get; set; }
    public Guid? FundingAccountId { get; set; }
    public bool IsArchived { get; set; }

    /// <summary>Opening balance plus every contribution minus every spend for this fund (all months).</summary>
    public decimal CurrentBalance { get; set; }

    /// <summary>What to put in this month, per the fund's accrual method.</summary>
    public decimal RequiredMonthlyContribution { get; set; }

    /// <summary>When the fund is projected to reach its target at the required rate; null when funded or open-ended.</summary>
    public DateOnly? ProjectedFullyFundedDate { get; set; }

    /// <summary>Overspent | Unfunded | FullyFunded | Behind | OnTrack.</summary>
    public string Status { get; set; } = "OnTrack";
}

public static class JarMapping
{
    public static JarDto ToDto(
        this Jar f, decimal currentBalance, decimal requiredMonthly, DateOnly asOf)
    {
        var remaining = f.TargetAmount > 0m ? Math.Max(0m, f.TargetAmount - currentBalance) : 0m;

        // Recurrence-adjusted: a Recurring jar's passed date has already rolled
        // forward here, so "Behind" below can only ever describe a Goal.
        var effectiveDue = JarAccrualCalculator.EffectiveTargetDate(f, asOf);

        string status;
        if (currentBalance < 0m)
        {
            status = "Overspent";
        }
        else if (f.TargetAmount <= 0m)
        {
            status = "Unfunded";
        }
        else if (remaining == 0m)
        {
            status = "FullyFunded";
        }
        else if (effectiveDue is { } due && due < asOf)
        {
            status = "Behind";
        }
        else
        {
            status = "OnTrack";
        }

        DateOnly? projected = null;
        if (remaining > 0m && requiredMonthly > 0m)
        {
            var monthsNeeded = (int)Math.Ceiling(remaining / requiredMonthly);
            projected = asOf.AddMonths(monthsNeeded);
        }

        return new JarDto
        {
            Id = f.Id,
            Name = f.Name,
            Kind = f.Kind,
            TargetAmount = f.TargetAmount,
            // The recurrence-adjusted date, so a Recurring jar never displays (or
            // prefills an edit form with) a stale, already-passed cycle date.
            TargetDate = effectiveDue,
            CoverStart = f.CoverStart,
            CoverEnd = f.CoverEnd,
            Accrual = f.Accrual,
            RecurMonths = f.RecurMonths,
            OpeningBalance = f.OpeningBalance,
            OpeningAsOf = f.OpeningAsOf,
            FundingAccountId = f.FundingAccountId,
            IsArchived = f.IsArchived,
            CurrentBalance = currentBalance,
            RequiredMonthlyContribution = requiredMonthly,
            ProjectedFullyFundedDate = projected,
            Status = status,
        };
    }
}
