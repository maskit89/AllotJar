using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.SetBudgetItemBill;

public class SetBudgetItemBillCommandValidator : AbstractValidator<SetBudgetItemBillCommand>
{
    public SetBudgetItemBillCommandValidator()
    {
        RuleFor(x => x.BudgetItemId)
            .NotEmpty();

        // Null clears the bill; otherwise it's a day of the month.
        RuleFor(x => x.DueDay!.Value)
            .InclusiveBetween(1, 31)
            .WithMessage("A due day must be between 1 and 31.")
            .When(x => x.DueDay is not null);
    }
}
