using FluentValidation;

namespace AllotJar.Application.Transactions.Commands.SplitTransaction;

public class SplitTransactionCommandValidator : AbstractValidator<SplitTransactionCommand>
{
    public SplitTransactionCommandValidator()
    {
        RuleFor(x => x.TransactionId)
            .NotEmpty();

        RuleFor(x => x.Allocations)
            .NotNull()
            .Must(a => a is { Count: >= 2 })
            .WithMessage("A split needs at least two lines.");

        RuleForEach(x => x.Allocations).ChildRules(a =>
        {
            a.RuleFor(x => x.BudgetItemId)
                .NotEmpty()
                .WithMessage("Choose a budget line for every split line.");

            a.RuleFor(x => x.Amount)
                .GreaterThan(0m)
                .WithMessage("Each split line needs an amount greater than zero.")
                .LessThanOrEqualTo(99_999_999_999_999.9999m)
                .WithMessage("Amount exceeds the supported range.");
        });
    }
}
