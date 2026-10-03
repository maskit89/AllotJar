using FluentValidation;
using ValidationException = AllotJar.Application.Common.Exceptions.ValidationException;

namespace AllotJar.Application.Common;

/// <summary>
/// A typed amount carries at most two decimals, the budget currency's cents (D1, client review
/// P3-7): 12.345 is refused with a message, never rounded without a word. Amounts are stored at
/// four decimals, and some already carry more than two (a converted amount restated by the
/// <c>ForeignAmounts</c> migration, P67; a planned amount the jar planner worked out), so an
/// edit that sends the stored amount back unchanged still saves (W10).
/// </summary>
public static class MoneyInput
{
    public const string TooPrecise = "Enter at most 2 decimal places.";

    public static bool IsWholeCents(decimal amount) => decimal.Round(amount, 2) == amount;

    /// <summary>A changed amount must be whole cents; the stored one passes as it is.</summary>
    public static bool Accepts(decimal amount, decimal? stored) => amount == stored || IsWholeCents(amount);

    public static IRuleBuilderOptions<T, decimal> WholeCents<T>(this IRuleBuilder<T, decimal> rule) =>
        rule.Must(IsWholeCents).WithMessage(TooPrecise);

    public static IRuleBuilderOptions<T, decimal?> WholeCents<T>(this IRuleBuilder<T, decimal?> rule) =>
        rule.Must(a => a is not decimal amount || IsWholeCents(amount)).WithMessage(TooPrecise);

    /// <summary>Refuses each changed amount that isn't whole cents, under its field's key.</summary>
    public static void EnsureAccepted(params (string Key, decimal? Amount, decimal? Stored)[] fields)
    {
        var errors = fields
            .Where(f => f.Amount is decimal amount && !Accepts(amount, f.Stored))
            .ToDictionary(f => f.Key, _ => new[] { TooPrecise });
        if (errors.Count > 0)
        {
            throw new ValidationException(errors);
        }
    }
}
