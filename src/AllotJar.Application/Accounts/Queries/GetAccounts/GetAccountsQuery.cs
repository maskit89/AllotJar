using MediatR;
using AllotJar.Application.Accounts.Dtos;

namespace AllotJar.Application.Accounts.Queries.GetAccounts;

/// <summary>
/// Lists the user's accounts with their actual balances as of <paramref name="AsOf"/>
/// (today when omitted; injectable so the dated ledger is deterministic in tests).
/// </summary>
public record GetAccountsQuery(DateOnly? AsOf = null) : IRequest<IReadOnlyList<AccountDto>>;
