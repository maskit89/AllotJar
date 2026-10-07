using FluentValidation;
using AllotJar.Domain.Enums;
using AllotJar.Application.Common;

namespace AllotJar.Application.Jars.Commands.CreateJar;

public class CreateJarCommandValidator : AbstractValidator<CreateJarCommand>
{
    public CreateJarCommandValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A jar needs a name.")
            .MaximumLength(120);

        this.JarDefinition();

        // A date given as just a month is the 1st of it (Jar.MonthOnly).
        RuleFor(x => x.TargetDate)
            .Must(d => d is null || d.Value.Day == 1)
            .When(x => x.MonthOnly == true && x.Accrual == AccrualMethod.TargetByDate)
            .WithMessage("A date given as just the month must be the 1st of that month.");

        // Rule 73: no jar without the account that holds its money.
        RuleFor(x => x.FundingAccountId)
            .NotEmpty().WithMessage("Choose the account this jar's money is held in.");

        // Rule 77: money already in the account, divided into the jar — never negative.
        RuleFor(x => x.InitialAllocation)
            .InclusiveBetween(0m, JarDefinitionRules.MaxAmount)
            .WithMessage("The amount already set aside must be zero or more.")
            .WholeCents();
        // A new jar's amounts are typed (D1); JarDefinition's range checks are shared with edits,
        // which may send a stored amount back as it is.
        RuleFor(x => x.TargetAmount).WholeCents();
        RuleFor(x => x.MonthlyContribution).WholeCents();
    }
}
