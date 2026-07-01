using FluentValidation;

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

        RuleFor(x => x.Type)
            .IsInEnum();
    }
}
