using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Commands.CreateAccount;

/// <summary>
/// Creates a new account for the user. The opening balance is the money held at the start of
/// <paramref name="OpeningDate"/> (rule 40); the returned balance is that amount as of today.
/// </summary>
public record CreateAccountCommand(
    string Name,
    AccountType Type,
    string Currency,
    decimal OpeningBalance,
    DateOnly? OpeningDate) : IRequest<AccountDto>;
