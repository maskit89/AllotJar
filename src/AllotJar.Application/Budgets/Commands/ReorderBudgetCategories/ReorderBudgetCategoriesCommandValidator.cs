using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.ReorderBudgetCategories;

public class ReorderBudgetCategoriesCommandValidator : AbstractValidator<ReorderBudgetCategoriesCommand>
{
    public ReorderBudgetCategoriesCommandValidator()
    {
        RuleFor(x => x.BudgetMonthId)
            .NotEmpty();

        RuleFor(x => x.OrderedCategoryIds)
            .NotEmpty().WithMessage("Provide the category order.");
    }
}
