using FluentValidation;

namespace AllotJar.Application.Transactions.Commands.LinkRefund;

public class LinkRefundCommandValidator : AbstractValidator<LinkRefundCommand>
{
    public LinkRefundCommandValidator()
    {
        RuleFor(x => x.TransactionId).NotEmpty();
        RuleFor(x => x.RefundOfTransactionId)
            .Must((x, original) => original != x.TransactionId)
            .WithMessage("A transaction can't be a refund of itself.");
    }
}
