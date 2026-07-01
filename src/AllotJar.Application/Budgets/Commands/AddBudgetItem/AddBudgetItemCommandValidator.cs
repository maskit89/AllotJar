using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.AddBudgetItem;

public class AddBudgetItemCommandValidator : AbstractValidator<AddBudgetItemCommand>
{
    public AddBudgetItemCommandValidator()
    {
        RuleFor(x => x.CategoryId)
            .NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A line needs a name.")
            .MaximumLength(120);

        // You cannot plan a negative amount of money against a line.
        RuleFor(x => x.PlannedAmount)
            .GreaterThanOrEqualTo(0m)
            .WithMessage("Planned amount cannot be negative.")
            .LessThanOrEqualTo(99_999_999_999_999.9999m)
            .WithMessage("Planned amount exceeds the supported range.");
    }
}
