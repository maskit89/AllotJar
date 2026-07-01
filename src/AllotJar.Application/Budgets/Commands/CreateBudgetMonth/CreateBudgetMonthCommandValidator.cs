using FluentValidation;

namespace AllotJar.Application.Budgets.Commands.CreateBudgetMonth;

public class CreateBudgetMonthCommandValidator : AbstractValidator<CreateBudgetMonthCommand>
{
    public CreateBudgetMonthCommandValidator()
    {
        RuleFor(x => x.Year)
            .InclusiveBetween(2000, 2100);

        RuleFor(x => x.Month)
            .InclusiveBetween(1, 12);
    }
}
