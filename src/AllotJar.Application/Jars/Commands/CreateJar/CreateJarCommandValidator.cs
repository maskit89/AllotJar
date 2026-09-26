using FluentValidation;

namespace AllotJar.Application.Jars.Commands.CreateJar;

public class CreateJarCommandValidator : AbstractValidator<CreateJarCommand>
{
    // Mirrors the decimal(18,4) range used elsewhere (e.g. account opening balance).
    private const decimal MaxAmount = 99_999_999_999_999.9999m;

    public CreateJarCommandValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A jar needs a name.")
            .MaximumLength(120);

        RuleFor(x => x.Kind).IsInEnum();
        RuleFor(x => x.Accrual).IsInEnum();

        RuleFor(x => x.TargetAmount)
            .InclusiveBetween(0m, MaxAmount)
            .WithMessage("Target amount is out of range.");

        // Rule 73: no jar without the account that holds its money.
        RuleFor(x => x.FundingAccountId)
            .NotEmpty().WithMessage("Choose the account this jar's money is held in.");

        // Rule 77: money already in the account, divided into the jar — never negative.
        RuleFor(x => x.InitialAllocation)
            .InclusiveBetween(0m, MaxAmount)
            .WithMessage("The amount already set aside must be zero or more.");

        // The recurrence cycle, when set, is bounded. Whether a Recurring jar *must*
        // carry a date and target is a form concern (the New-jar form collects them).
        RuleFor(x => x.RecurMonths)
            .InclusiveBetween(1, 120)
            .When(x => x.RecurMonths.HasValue)
            .WithMessage("Repeat cycle must be between 1 and 120 months.");

        // When both cover dates are given the window must be positive.
        RuleFor(x => x.CoverEnd)
            .GreaterThan(x => x.CoverStart!.Value)
            .When(x => x.CoverStart.HasValue && x.CoverEnd.HasValue)
            .WithMessage("Cover end must be after cover start.");
    }
}
