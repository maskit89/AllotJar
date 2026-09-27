using MediatR;
using AllotJar.Application.Accounts.Dtos;

namespace AllotJar.Application.Accounts.Queries.GetAccountReconciliation;

/// <summary>Per-account reconciliation: actual balance as of <paramref name="AsOf"/> (today by default) vs the sinking funds it backs, and the float.</summary>
public record GetAccountReconciliationQuery(DateOnly? AsOf = null) : IRequest<IReadOnlyList<AccountReconciliationDto>>;
