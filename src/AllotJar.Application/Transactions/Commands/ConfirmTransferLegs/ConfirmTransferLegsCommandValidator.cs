using FluentValidation;

namespace AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;

public class ConfirmTransferLegsCommandValidator : AbstractValidator<ConfirmTransferLegsCommand>
{
    public ConfirmTransferLegsCommandValidator()
    {
        RuleFor(x => x.TransactionId).NotEmpty();

        RuleFor(x => x)
            .Must(x => x.DepartedOn.HasValue || x.ReceivedOn.HasValue
                       || !string.IsNullOrWhiteSpace(x.BankReference)
                       || !string.IsNullOrWhiteSpace(x.ReceiptBankReference))
            .WithMessage("Supply a departure date, a receipt date or a statement reference to confirm.");

        RuleFor(x => x.BankReference).MaximumLength(140);
        RuleFor(x => x.ReceiptBankReference).MaximumLength(140);
    }
}
