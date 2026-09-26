using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Dtos;

/// <summary>
/// A jar with its read-time-derived figures (actual balance, required monthly contribution,
/// projection and status). Enum fields are serialised as their numeric value, mirroring
/// <see cref="AccountType"/>.
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

    /// <summary>The account holding this jar's money (rule 2); always set.</summary>
    public Guid FundingAccountId { get; set; }
    public bool IsArchived { get; set; }

    /// <summary>
    /// The jar's actual balance in its account as of <see cref="BalanceAsOf"/>: the allocations posted
    /// against it, never planned contributions (rule 1). Null when the account's balance is
    /// unavailable (rule 67), never zero.
    /// </summary>
    public decimal? CurrentBalance { get; set; }

    public DateOnly BalanceAsOf { get; set; }

    /// <summary>What to put in this month, per the jar's accrual method (0 when the balance is unavailable).</summary>
    public decimal RequiredMonthlyContribution { get; set; }

    /// <summary>When the jar is projected to reach its target at the required rate; null when funded or open-ended.</summary>
    public DateOnly? ProjectedFullyFundedDate { get; set; }

    /// <summary>Unavailable | Overspent | Unfunded | FullyFunded | Behind | OnTrack.</summary>
    public string Status { get; set; } = "OnTrack";
}

public static class JarMapping
{
    public static JarDto ToDto(this Jar f, decimal? currentBalance, decimal requiredMonthly, DateOnly asOf)
    {
        var balance = currentBalance ?? 0m;
        var remaining = f.TargetAmount > 0m ? Math.Max(0m, f.TargetAmount - balance) : 0m;

        // Recurrence-adjusted: a Recurring jar with a cycle re-arms to its next due
        // date, so "Behind" below describes a Goal (or a date-less/cycle-less legacy
        // jar that cannot roll), never a healthy recurring jar.
        var effectiveDue = JarAccrualCalculator.EffectiveTargetDate(f, asOf);

        string status;
        if (currentBalance is null)
        {
            status = "Unavailable";
        }
        else if (balance < 0m)
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
        if (currentBalance is not null && remaining > 0m && requiredMonthly > 0m)
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
            // The stored anchor, not the rolled date — so an edit round-trips faithfully
            // (prefill → PUT never silently advances the date), and switching a passed
            // Recurring jar to a Goal keeps the real date rather than a rolled one it
            // never chose. Recurrence is applied where it's needed (status, seeding).
            TargetDate = f.TargetDate,
            CoverStart = f.CoverStart,
            CoverEnd = f.CoverEnd,
            Accrual = f.Accrual,
            RecurMonths = f.RecurMonths,
            FundingAccountId = f.FundingAccountId,
            IsArchived = f.IsArchived,
            CurrentBalance = currentBalance,
            BalanceAsOf = asOf,
            RequiredMonthlyContribution = currentBalance is null ? 0m : requiredMonthly,
            ProjectedFullyFundedDate = projected,
            Status = status,
        };
    }

    /// <summary>The jar's figures from a ledger snapshot: balance (null when unavailable) and the contribution it implies.</summary>
    public static JarDto ToDto(this Jar f, JarLedgerSnapshot snapshot)
    {
        var balance = snapshot.BalanceOf(f.Id);
        var required = balance is decimal b ? JarAccrualCalculator.RequiredMonthlyContribution(f, snapshot.AsOf, b) : 0m;
        return f.ToDto(balance, required, snapshot.AsOf);
    }
}
