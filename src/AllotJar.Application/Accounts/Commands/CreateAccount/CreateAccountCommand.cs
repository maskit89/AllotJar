using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Commands.CreateAccount;

/// <summary>Creates a new account for the user. Returns it (balance = opening balance).</summary>
public record CreateAccountCommand(
    string Name,
    AccountType Type,
    string Currency,
    decimal OpeningBalance) : IRequest<AccountDto>;
