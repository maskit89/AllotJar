using FluentValidation;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

public class UpdateJarCommandValidator : AbstractValidator<UpdateJarCommand>
{
    public UpdateJarCommandValidator()
    {
        RuleFor(x => x.Id).NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A jar needs a name.")
            .MaximumLength(120);

        this.JarDefinition();

        // A date given as just a month is the 1st of it (Jar.MonthOnly).
        RuleFor(x => x.TargetDate)
            .Must(d => d is null || d.Value.Day == 1)
            .When(x => x.MonthOnly == true && x.Accrual == AccrualMethod.TargetByDate)
            .WithMessage("A date given as just the month must be the 1st of that month.");

        RuleFor(x => x.FundingAccountId)
            .NotEmpty().WithMessage("Choose the account this jar's money is held in.");
    }
}
