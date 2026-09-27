using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;

/// <summary>
/// Supplies the bank legs a recorded transfer is still missing: the receipt date once the
/// destination bank has posted it (rule 71), or the departure date for a receipt that was
/// held for review (rule 72). Only unknown legs are filled — an already confirmed date is
/// left alone when the same value is re-sent and refused when a different one is, because
/// correcting confirmed bank history is a separate, not yet agreed workflow. Statement
/// references may be attached to the leg they belong to. A departure supplied for a jar-backed
/// source may name the jar it leaves (<paramref name="FromJarId"/>); a receipt confirmed into a
/// jar-backed destination may be divided among its jars (<paramref name="JarAllocations"/>,
/// rule 78; null leaves any earlier answer, an empty list makes it all unallocated). Returns
/// the updated transaction.
/// </summary>
[AllowLimited]
public record ConfirmTransferLegsCommand(
    Guid TransactionId,
    DateOnly? DepartedOn = null,
    DateOnly? ReceivedOn = null,
    string? BankReference = null,
    string? ReceiptBankReference = null,
    Guid? FromJarId = null,
    IReadOnlyList<JarAllocationInput>? JarAllocations = null) : IRequest<TransactionDto>;
