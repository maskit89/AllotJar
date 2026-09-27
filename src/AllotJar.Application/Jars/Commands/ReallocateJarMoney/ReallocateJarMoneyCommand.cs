using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.ReallocateJarMoney;

/// <summary>
/// Moves money already in one account between its jars and/or its unallocated funds (rule 6):
/// the source decreases, the destination increases, the account balance is untouched. A null
/// jar id means the account's unallocated funds. The source can give at most what it holds
/// (rule 68) and the result must leave every positive jar backed (rule 70). Dated
/// <paramref name="Date"/> (today when omitted) so past-month views stay right (rule 48).
/// Cross-account moves are bank transfers and go through the transfer workflow (rule 7).
/// </summary>
public record ReallocateJarMoneyCommand(
    Guid AccountId,
    Guid? SourceJarId,
    Guid? DestinationJarId,
    decimal Amount,
    DateOnly? Date = null,
    string? Note = null) : IRequest<JarAccountLedgerDto>;
