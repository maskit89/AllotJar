using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.UpdateTransfer;

/// <summary>
/// Corrects a recorded transfer in place (O1 answer 3): its accounts, amount, bank dates, note,
/// explicit fee and jar answers, replacing what was stored. A leg a bank statement has confirmed
/// (it carries that bank's reference) keeps the bank's account, date and amount. A transfer that
/// departed and was never received can be marked <paramref name="ReturnedOn"/>: the source bank
/// sent the money back (O1 answer 4). Every account the edit touches stays at or above zero on
/// every date (rule 74). As with other edits, a jar answer left out returns that leg to its
/// default (P7).
/// </summary>
[AllowLimited]
public record UpdateTransferCommand(
    Guid TransactionId,
    Guid FromAccountId,
    Guid ToAccountId,
    decimal Amount,
    DateOnly? DepartedOn,
    DateOnly? ReceivedOn,
    DateOnly? ReturnedOn = null,
    string? Payee = null,
    decimal? Fee = null,
    Guid? FeeBudgetItemId = null,
    bool AcknowledgeCrossMonth = false,
    Guid? FromJarId = null,
    IReadOnlyList<JarAllocationInput>? JarAllocations = null) : IRequest<TransactionDto>;
