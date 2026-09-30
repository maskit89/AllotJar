using MediatR;
using AllotJar.Application.Accounts.Dtos;

namespace AllotJar.Application.Accounts.Queries.GetUnreachableAccounts;

/// <summary>The accounts private to a login no longer in the household (P59). Owner only.</summary>
public record GetUnreachableAccountsQuery : IRequest<IReadOnlyList<UnreachableAccountDto>>;
