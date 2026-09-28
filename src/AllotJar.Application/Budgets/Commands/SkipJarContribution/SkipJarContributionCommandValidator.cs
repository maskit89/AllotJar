using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.SkipJarContribution;

public class SkipJarContributionCommandValidator : AbstractValidator<SkipJarContributionCommand>
{
    public SkipJarContributionCommandValidator()
    {
        RuleFor(x => x.BudgetItemId).NotEmpty();
    }
}
