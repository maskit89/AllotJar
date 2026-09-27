using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.CreateTransfer;

/// <summary>
/// Records a completed bank transfer between two of the user's own accounts, after the user
/// confirms "I've completed this transfer" (rule 7). <paramref name="DepartedOn"/> is the date
/// the source bank posted the debit and is required (rule 71: departure is what the user can
/// confirm). <paramref name="ReceivedOn"/> is the destination bank's posting date when already
/// known; left null, the amount stays in transit until receipt is confirmed separately, and no
/// arrival date is ever invented. Stored as a single
/// <see cref="Domain.Enums.TransactionType.Transfer"/> transaction (source =
/// <paramref name="FromAccountId"/>, destination = <paramref name="ToAccountId"/>) that is
/// excluded from budget actuals. On jar-backed accounts, <paramref name="FromJarId"/> names
/// the jar the money leaves (unallocated when null; a cross-account "Move money" sets it, rule
/// 80) and <paramref name="JarAllocations"/> divides the receipt among the destination's jars
/// (rule 78); a receipt still in transit lands in those jars once it is confirmed. Returns the
/// created transaction.
/// </summary>
[AllowLimited]
public record CreateTransferCommand(
    DateOnly DepartedOn,
    decimal Amount,
    Guid FromAccountId,
    Guid ToAccountId,
    string? Payee = null,
    DateOnly? ReceivedOn = null,
    Guid? FromJarId = null,
    IReadOnlyList<JarAllocationInput>? JarAllocations = null) : IRequest<TransactionDto>;
