using MediatR;
using AllotJar.Application.Accounts.Dtos;

namespace AllotJar.Application.Accounts.Queries.GetAccountReconciliation;

/// <summary>Per-account reconciliation: derived balance vs the sinking funds it backs, and the float.</summary>
public record GetAccountReconciliationQuery : IRequest<IReadOnlyList<AccountReconciliationDto>>;
