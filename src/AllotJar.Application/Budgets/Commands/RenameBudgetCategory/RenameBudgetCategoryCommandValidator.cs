using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.RenameBudgetCategory;

public class RenameBudgetCategoryCommandValidator : AbstractValidator<RenameBudgetCategoryCommand>
{
    public RenameBudgetCategoryCommandValidator()
    {
        RuleFor(x => x.CategoryId)
            .NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A category group needs a name.")
            .MaximumLength(120);
    }
}
