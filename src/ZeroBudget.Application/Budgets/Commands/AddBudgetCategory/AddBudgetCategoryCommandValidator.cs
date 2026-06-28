using FluentValidation;
using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Application.Budgets.Commands.AddBudgetCategory;

public class AddBudgetCategoryCommandValidator : AbstractValidator<AddBudgetCategoryCommand>
{
    public AddBudgetCategoryCommandValidator()
    {
        RuleFor(x => x.BudgetMonthId)
            .NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A category group needs a name.")
            .MaximumLength(120);

        // Only expense and fund groups are user-created; the income group is seeded.
        RuleFor(x => x.Kind)
            .Must(k => k == CategoryKind.Expense || k == CategoryKind.Savings)
            .WithMessage("A group can only be an expense or a fund group.");
    }
}
