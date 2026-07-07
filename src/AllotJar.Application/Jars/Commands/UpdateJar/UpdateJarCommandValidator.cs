using FluentValidation;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

public class UpdateJarCommandValidator : AbstractValidator<UpdateJarCommand>
{
    private const decimal MaxAmount = 99_999_999_999_999.9999m;

    public UpdateJarCommandValidator()
    {
        RuleFor(x => x.Id).NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A fund needs a name.")
            .MaximumLength(120);

        RuleFor(x => x.Kind).IsInEnum();
        RuleFor(x => x.Accrual).IsInEnum();

        RuleFor(x => x.TargetAmount)
            .InclusiveBetween(0m, MaxAmount)
            .WithMessage("Target amount is out of range.");

        RuleFor(x => x.OpeningBalance)
            .InclusiveBetween(-MaxAmount, MaxAmount)
            .WithMessage("Opening balance is out of range.");

        // The recurrence cycle, when set, is bounded. Whether a Recurring jar *must*
        // carry a date and target is a form concern (the New-jar form collects them) —
        // the server stays permissive so imported and legacy jars (open-ended pools,
        // date-less recurring funds) remain editable.
        RuleFor(x => x.RecurMonths)
            .InclusiveBetween(1, 120)
            .When(x => x.RecurMonths.HasValue)
            .WithMessage("Repeat cycle must be between 1 and 120 months.");

        RuleFor(x => x.CoverEnd)
            .GreaterThan(x => x.CoverStart!.Value)
            .When(x => x.CoverStart.HasValue && x.CoverEnd.HasValue)
            .WithMessage("Cover end must be after cover start.");
    }
}
