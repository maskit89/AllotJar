using FluentValidation;
using AllotJar.Application.Jars;

namespace AllotJar.Application.Transactions.Commands.UpdateTransfer;

public class UpdateTransferCommandValidator : AbstractValidator<UpdateTransferCommand>
{
    private const decimal MaxAmount = 99_999_999_999_999.9999m;

    public UpdateTransferCommandValidator()
    {
        RuleFor(x => x.Amount)
            .GreaterThan(0m).WithMessage("A transfer amount must be greater than zero.")
            .LessThanOrEqualTo(MaxAmount).WithMessage("Transfer amount is out of range.");

        RuleFor(x => x.FromAccountId).NotEmpty();
        RuleFor(x => x.ToAccountId).NotEmpty();
        RuleFor(x => x.ToAccountId)
            .NotEqual(x => x.FromAccountId)
            .WithMessage("Choose two different accounts for a transfer.");

        RuleFor(x => x.DepartedOn)
            .NotNull()
            .When(x => x.ReceivedOn is null)
            .WithMessage("A transfer needs its departure date, its receipt date, or both.");

        RuleFor(x => x.ReturnedOn)
            .Must((x, returned) => x.DepartedOn is DateOnly departed && returned >= departed)
            .When(x => x.ReturnedOn.HasValue)
            .WithMessage("A transfer can only come back on or after the day it left.");
        RuleFor(x => x.ReturnedOn)
            .Null()
            .When(x => x.ReceivedOn.HasValue)
            .WithMessage("A transfer that was received can't also have been sent back. Clear the receipt date first.");

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
