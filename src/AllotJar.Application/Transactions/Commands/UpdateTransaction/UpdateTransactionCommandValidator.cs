using FluentValidation;
using AllotJar.Application.Jars;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.UpdateTransaction;

public class UpdateTransactionCommandValidator : AbstractValidator<UpdateTransactionCommand>
{
    public UpdateTransactionCommandValidator()
    {
        RuleFor(x => x.TransactionId)
            .NotEmpty();

        RuleFor(x => x.Amount)
            .GreaterThan(0m)
            .WithMessage("Enter an amount greater than zero.")
            .LessThanOrEqualTo(99_999_999_999_999.9999m)
            .WithMessage("Amount exceeds the supported range.");

        RuleFor(x => x.Payee)
            .MaximumLength(200);

        // A transfer is created and edited only through the two-account transfer flow.
        // Rejecting Transfer here stops an edit from turning a plain row into a
        // destination-less transfer; the handler also clears any stale counterparty
        // link when a real transfer is edited into an income/expense.
        RuleFor(x => x.JarAllocations).JarAllocationsWellFormed();
        RuleFor(x => x.JarAllocations)
            .Must((x, list) => list is not { Count: > 0 } || (x.AccountId is not null && x.Type == TransactionType.Income))
            .WithMessage("Only income recorded on an account can be divided among jars.");
        RuleFor(x => x.PaidFromJarId)
            .Must((x, jar) => jar is null || (x.AccountId is not null && x.Type == TransactionType.Expense))
            .WithMessage("Only an expense recorded on an account can be paid from a jar.");

        RuleFor(x => x.Type)
            .IsInEnum()
            .Must(t => t != TransactionType.Transfer)
            .WithMessage("Use the transfer action to move money between accounts.");
    }
}
