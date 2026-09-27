using FluentValidation;

namespace AllotJar.Application.Accounts.Commands.CreateAccount;

public class CreateAccountCommandValidator : AbstractValidator<CreateAccountCommand>
{
    public CreateAccountCommandValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("An account needs a name.")
            .MaximumLength(120);

        RuleFor(x => x.Type)
            .IsInEnum()
            // Rule 75: a credit card is money owed, not money held.
            .NotEqual(Domain.Enums.AccountType.CreditCard)
            .WithMessage("Credit cards are not accounts here: an account holds money, a card owes it.");

        RuleFor(x => x.Currency)
            .NotEmpty().WithMessage("An account needs a currency.")
            .Matches("^[A-Za-z]{3}$").WithMessage("Currency must be a 3-letter ISO 4217 code.");

        // Rule 74: no account may be negative, including at its opening.
        RuleFor(x => x.OpeningBalance)
            .InclusiveBetween(0m, 99_999_999_999_999.9999m)
            .WithMessage("The opening balance must be zero or more: an account never has a negative balance here.");

        // The opening balance is meaningless without the date it applies from: without it no
        // balance can be calculated, and inferring one is exactly what rule 40 forbids.
        RuleFor(x => x.OpeningDate)
            .NotNull().WithMessage("Enter the date the opening balance applies from.");

        BankIdentifiers.Apply(this, x => x.Iban, x => x.Bic, x => x.SortCode, x => x.AccountNumber);
    }
}
