using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Commands.UpdateAccount;

/// <summary>
/// Edits an account's name, type, opening balance and opening date. Currency is immutable
/// (changing it would silently reinterpret the transaction history). Returns the updated
/// account with its recalculated balance as of today.
/// </summary>
public record UpdateAccountCommand(
    Guid Id,
    string Name,
    AccountType Type,
    decimal OpeningBalance,
    DateOnly? OpeningDate) : IRequest<AccountDto>;
