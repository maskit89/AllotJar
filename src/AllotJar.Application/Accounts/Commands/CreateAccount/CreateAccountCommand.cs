using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Commands.CreateAccount;

/// <summary>
/// Creates a new account for the user. The opening balance is the money held at the start of
/// <paramref name="OpeningDate"/> (rule 40); the returned balance is that amount as of today.
/// <paramref name="HolderIds"/> are the people who hold it (rule 30; none = the household's own).
/// <paramref name="IsPrivate"/> null follows rule 31: an account whose only holder is the caller's
/// own person starts private, any other starts shared. <paramref name="Currency"/> must be the
/// household's budget currency (rules 63/85).
/// </summary>
public record CreateAccountCommand(
    string Name,
    AccountType Type,
    string Currency,
    decimal OpeningBalance,
    DateOnly? OpeningDate,
    IReadOnlyList<Guid>? HolderIds = null,
    bool? IsPrivate = null) : IRequest<AccountDto>;
