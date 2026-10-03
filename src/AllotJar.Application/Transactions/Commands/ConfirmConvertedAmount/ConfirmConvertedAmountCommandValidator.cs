using FluentValidation;
using AllotJar.Application.Common;

namespace AllotJar.Application.Transactions.Commands.ConfirmConvertedAmount;

public class ConfirmConvertedAmountCommandValidator : AbstractValidator<ConfirmConvertedAmountCommand>
{
    public ConfirmConvertedAmountCommandValidator()
    {
        RuleFor(x => x.Amount)
            .GreaterThan(0m)
            .WithMessage("Enter an amount greater than zero.")
            .LessThanOrEqualTo(99_999_999_999_999.9999m)
            .WithMessage("Amount exceeds the supported range.")
            .WholeCents();
    }
}
