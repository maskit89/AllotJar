using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.UpdateBudgetItem;

public class UpdateBudgetItemCommandValidator : AbstractValidator<UpdateBudgetItemCommand>
{
    public UpdateBudgetItemCommandValidator()
    {
        RuleFor(x => x.BudgetItemId)
            .NotEmpty();

        // You cannot plan a negative amount of money against a line.
        RuleFor(x => x.PlannedAmount)
            .GreaterThanOrEqualTo(0m)
            .WithMessage("Planned amount cannot be negative.")
            .LessThanOrEqualTo(99_999_999_999_999.9999m)
            .WithMessage("Planned amount exceeds the supported range.");

        RuleFor(x => x.Name)
            .MaximumLength(120)
            .When(x => x.Name is not null);
    }
}
