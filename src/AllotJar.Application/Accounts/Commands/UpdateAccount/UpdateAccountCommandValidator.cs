using FluentValidation;

namespace AllotJar.Application.Accounts.Commands.UpdateAccount;

public class UpdateAccountCommandValidator : AbstractValidator<UpdateAccountCommand>
{
    public UpdateAccountCommandValidator()
    {
        RuleFor(x => x.Id)
            .NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("An account needs a name.")
            .MaximumLength(120);

        RuleFor(x => x.Type)
            .IsInEnum()
            // Rule 75: a credit card is money owed, not money held.
            .NotEqual(Domain.Enums.AccountType.CreditCard)
            .WithMessage("Credit cards are not accounts here: an account holds money, a card owes it.");

        // Rule 74: no account may be negative, including at its opening.
        RuleFor(x => x.OpeningBalance)
            .InclusiveBetween(0m, 99_999_999_999_999.9999m)
            .WithMessage("The opening balance must be zero or more: an account never has a negative balance here.");

        RuleFor(x => x.OpeningDate)
            .NotNull().WithMessage("Enter the date the opening balance applies from.");
    }
}
