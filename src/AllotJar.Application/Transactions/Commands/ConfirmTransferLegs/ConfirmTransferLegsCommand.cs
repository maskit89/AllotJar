using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;

/// <summary>
/// Supplies the bank legs a recorded transfer is still missing: the receipt date once the
/// destination bank has posted it (rule 71), or the departure date for a receipt that was
/// held for review (rule 72). Only unknown legs are filled — an already confirmed date is
/// left alone when the same value is re-sent and refused when a different one is, because
/// correcting confirmed bank history is a separate, not yet agreed workflow. Statement
/// references may be attached to the leg they belong to. Returns the updated transaction.
/// </summary>
[AllowLimited]
public record ConfirmTransferLegsCommand(
    Guid TransactionId,
    DateOnly? DepartedOn = null,
    DateOnly? ReceivedOn = null,
    string? BankReference = null,
    string? ReceiptBankReference = null) : IRequest<TransactionDto>;
