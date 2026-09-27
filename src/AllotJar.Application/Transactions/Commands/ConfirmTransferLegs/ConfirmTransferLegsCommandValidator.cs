using FluentValidation;
using AllotJar.Application.Jars;

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
        RuleFor(x => x.JarAllocations).JarAllocationsWellFormed();
        RuleFor(x => x.FromJarId)
            .Must((x, jar) => jar is null || x.DepartedOn is not null)
            .WithMessage("Supply the departure date to say which jar the money left.");
        RuleFor(x => x.JarAllocations)
            .Must((x, list) => list is null || x.ReceivedOn is not null)
            .WithMessage("Confirm the receipt date to divide the money among jars.");
        RuleFor(x => x.ReceiptBankReference).MaximumLength(140);
    }
}
