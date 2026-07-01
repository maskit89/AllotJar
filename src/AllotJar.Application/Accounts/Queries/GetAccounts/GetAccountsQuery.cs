using MediatR;
using AllotJar.Application.Accounts.Dtos;

namespace AllotJar.Application.Accounts.Queries.GetAccounts;

/// <summary>Lists the user's accounts with their derived current balances.</summary>
public record GetAccountsQuery : IRequest<IReadOnlyList<AccountDto>>;
