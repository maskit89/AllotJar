using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.ReorderBudgetItems;

public class ReorderBudgetItemsCommandValidator : AbstractValidator<ReorderBudgetItemsCommand>
{
    public ReorderBudgetItemsCommandValidator()
    {
        RuleFor(x => x.CategoryId)
            .NotEmpty();

        RuleFor(x => x.OrderedItemIds)
            .NotEmpty().WithMessage("Provide the line order.");
    }
}
