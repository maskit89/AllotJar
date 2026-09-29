using FluentValidation;
using AllotJar.Application.Jars;

namespace AllotJar.Application.Transactions.Commands.CreateTransfer;

public class CreateTransferCommandValidator : AbstractValidator<CreateTransferCommand>
{
    private const decimal MaxAmount = 99_999_999_999_999.9999m;

    public CreateTransferCommandValidator()
    {
        RuleFor(x => x.Amount)
            .GreaterThan(0m).WithMessage("A transfer amount must be greater than zero.")
            .LessThanOrEqualTo(MaxAmount).WithMessage("Transfer amount is out of range.");

        RuleFor(x => x.FromAccountId).NotEmpty();
        RuleFor(x => x.ToAccountId).NotEmpty();

        RuleFor(x => x.ToAccountId)
            .NotEqual(x => x.FromAccountId)
            .WithMessage("Choose two different accounts for a transfer.");

        // A manually entered receipt earlier than the departure is a typo far more often than a
        // value-dated credit; statement-supplied dates arrive through the import path instead.
        RuleFor(x => x.ReceivedOn)
            .GreaterThanOrEqualTo(x => x.DepartedOn)
            .When(x => x.ReceivedOn.HasValue)
            .WithMessage("The receipt date can't be before the departure date.");

        RuleFor(x => x.Fee)
            .GreaterThanOrEqualTo(0m).WithMessage("A fee can't be negative.")
            .LessThanOrEqualTo(MaxAmount).WithMessage("Fee is out of range.")
            .When(x => x.Fee.HasValue);
        RuleFor(x => x.FeeBudgetItemId)
            .Null().When(x => x.Fee is not > 0m)
            .WithMessage("Choose a line for the fee only when there is a fee.");

        RuleFor(x => x.Payee).MaximumLength(200);
        RuleFor(x => x.JarAllocations).JarAllocationsWellFormed();
    }
}
