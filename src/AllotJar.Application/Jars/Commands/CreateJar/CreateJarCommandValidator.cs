using FluentValidation;

namespace AllotJar.Application.Jars.Commands.CreateJar;

public class CreateJarCommandValidator : AbstractValidator<CreateJarCommand>
{
    public CreateJarCommandValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A jar needs a name.")
            .MaximumLength(120);

        this.JarDefinition();

        // Rule 73: no jar without the account that holds its money.
        RuleFor(x => x.FundingAccountId)
            .NotEmpty().WithMessage("Choose the account this jar's money is held in.");

        // Rule 77: money already in the account, divided into the jar — never negative.
        RuleFor(x => x.InitialAllocation)
            .InclusiveBetween(0m, JarDefinitionRules.MaxAmount)
            .WithMessage("The amount already set aside must be zero or more.");
    }
}
