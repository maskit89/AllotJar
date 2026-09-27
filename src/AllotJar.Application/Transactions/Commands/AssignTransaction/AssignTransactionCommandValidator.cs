using FluentValidation;

namespace AllotJar.Application.Transactions.Commands.AssignTransaction;

public class AssignTransactionCommandValidator : AbstractValidator<AssignTransactionCommand>
{
    public AssignTransactionCommandValidator()
    {
        RuleFor(x => x.TransactionId).NotEmpty();
        // "Which jar does this come from?" is asked only for a payment on a line (rule 79); a
        // payment on no line draws from unallocated without a prompt.
        RuleFor(x => x.PaidFromJarId)
            .Must((x, jar) => jar is null || x.BudgetItemId is not null)
            .WithMessage("Choose a budget line before choosing the jar the payment comes from.");
    }
}
