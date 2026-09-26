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
            .IsInEnum();

        RuleFor(x => x.OpeningBalance)
            .InclusiveBetween(-99_999_999_999_999.9999m, 99_999_999_999_999.9999m)
            .WithMessage("Opening balance exceeds the supported range.");

        RuleFor(x => x.OpeningDate)
            .NotNull().WithMessage("Enter the date the opening balance applies from.");
    }
}
