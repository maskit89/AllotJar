using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Queries.GetJarLedger;

/// <summary>Every jar-backed account's ledger — balance, jars, unallocated — as of a date (today when omitted).</summary>
public record GetJarLedgerQuery(DateOnly? AsOf = null, Guid? AccountId = null) : IRequest<IReadOnlyList<JarAccountLedgerDto>>;
