using FluentValidation;
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
        RuleFor(x => x.Type)
            .IsInEnum()
            .Must(t => t != TransactionType.Transfer)
            .WithMessage("Use the transfer action to move money between accounts.");
    }
}
