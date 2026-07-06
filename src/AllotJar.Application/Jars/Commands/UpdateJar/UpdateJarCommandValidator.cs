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

        // The lifecycle contract: a Recurring jar rolls its date forward each cycle,
        // so it must have a date (and a real target) to roll.
        RuleFor(x => x.TargetDate)
            .NotNull()
            .When(x => x.Kind == Domain.Enums.JarKind.Recurring)
            .WithMessage("A recurring jar needs its next due date.");

        RuleFor(x => x.TargetAmount)
            .GreaterThan(0m)
            .When(x => x.Kind == Domain.Enums.JarKind.Recurring)
            .WithMessage("A recurring jar needs a target amount.");

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
