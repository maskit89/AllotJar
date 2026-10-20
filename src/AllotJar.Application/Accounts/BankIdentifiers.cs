using System.Text.RegularExpressions;
using FluentValidation;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Accounts;

/// <summary>
/// Optional bank identifiers on an account (rule 76): never required, because an account may be
/// a piggy bank; normalised (trimmed, spaces removed, upper-cased where the standard is
/// case-insensitive) and format-checked only when supplied.
/// </summary>
public static partial class BankIdentifiers
{
    public static string? NormalizeIban(string? value) => Compact(value)?.ToUpperInvariant();
    public static string? NormalizeBic(string? value) => Compact(value)?.ToUpperInvariant();
    public static string? NormalizeSortCode(string? value) => Compact(value)?.Replace("-", "");
    public static string? NormalizeAccountNumber(string? value) => Compact(value);

    public static bool IsValidIban(string? value) => value is null || IbanPattern().IsMatch(NormalizeIban(value)!);
    public static bool IsValidBic(string? value) => value is null || BicPattern().IsMatch(NormalizeBic(value)!);
    public static bool IsValidSortCode(string? value) => value is null || SortCodePattern().IsMatch(NormalizeSortCode(value)!);
    public static bool IsValidAccountNumber(string? value) => value is null || AccountNumberPattern().IsMatch(NormalizeAccountNumber(value)!);

    /// <summary>False for a card number (<see cref="CardNumberMask.IsCardNumber"/>), spaces and hyphens ignored.</summary>
    public static bool IsNotACardNumber(string? value) =>
        NormalizeAccountNumber(value)?.Replace("-", "") is not string compact || !CardNumberMask.IsCardNumber(compact);

    /// <summary>The shared FluentValidation rules for the four optional fields.</summary>
    public static void Apply<T>(AbstractValidator<T> validator,
        Func<T, string?> iban, Func<T, string?> bic, Func<T, string?> sortCode, Func<T, string?> accountNumber)
    {
        validator.RuleFor(x => iban(x)).Must(IsValidIban).WithName("Iban")
            .WithMessage("Enter a valid IBAN (two letters, two digits, then 11 to 30 letters or digits).");
        validator.RuleFor(x => bic(x)).Must(IsValidBic).WithName("Bic")
            .WithMessage("Enter a valid BIC/SWIFT code (8 or 11 characters).");
        validator.RuleFor(x => sortCode(x)).Must(IsValidSortCode).WithName("SortCode")
            .WithMessage("Enter a valid sort code (six digits, e.g. 12-34-56).");
        validator.RuleFor(x => accountNumber(x)).Must(IsValidAccountNumber).WithName("AccountNumber")
            .WithMessage("Enter a valid account number (4 to 34 letters or digits).");
        // Compliance fix 12: no card number is ever stored, and this is where one is most likely typed.
        validator.RuleFor(x => accountNumber(x)).Must(IsNotACardNumber).WithName("AccountNumber")
            .WithMessage("That looks like a card number. Enter only its last four digits.");
    }

    private static string? Compact(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        return string.Concat(value.Where(c => !char.IsWhiteSpace(c)));
    }

    [GeneratedRegex("^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$")]
    private static partial Regex IbanPattern();

    [GeneratedRegex("^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$")]
    private static partial Regex BicPattern();

    [GeneratedRegex("^[0-9]{6}$")]
    private static partial Regex SortCodePattern();

    [GeneratedRegex("^[A-Za-z0-9]{4,34}$")]
    private static partial Regex AccountNumberPattern();
}
