using FluentValidation;

namespace AllotJar.Application.Transactions.Commands.AssignTransaction;

public class AssignTransactionCommandValidator : AbstractValidator<AssignTransactionCommand>
{
    public AssignTransactionCommandValidator()
    {
        RuleFor(x => x.TransactionId).NotEmpty();
    }
}
