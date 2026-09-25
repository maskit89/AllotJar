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
            .IsInEnum();

        RuleFor(x => x.Currency)
            .NotEmpty().WithMessage("An account needs a currency.")
            .Matches("^[A-Za-z]{3}$").WithMessage("Currency must be a 3-letter ISO 4217 code.");

        RuleFor(x => x.OpeningBalance)
            .InclusiveBetween(-99_999_999_999_999.9999m, 99_999_999_999_999.9999m)
            .WithMessage("Opening balance exceeds the supported range.");

        // The opening balance is meaningless without the date it applies from: without it no
        // balance can be calculated, and inferring one is exactly what rule 40 forbids.
        RuleFor(x => x.OpeningDate)
            .NotNull().WithMessage("Enter the date the opening balance applies from.");
    }
}
