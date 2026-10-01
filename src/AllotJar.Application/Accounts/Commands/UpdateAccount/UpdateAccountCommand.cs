using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Commands.UpdateAccount;

/// <summary>
/// Edits an account's name, type, opening balance and opening date. Currency is immutable
/// (changing it would silently reinterpret the transaction history). Returns the updated
/// account with its recalculated balance as of today. <paramref name="HolderIds"/> replaces who
/// holds it (rule 30); null leaves the holders as they are. Who sees it is changed only by its
/// holder (<see cref="SetAccountSharing.SetAccountSharingCommand"/>).
/// </summary>
public record UpdateAccountCommand(
    Guid Id,
    string Name,
    AccountType Type,
    decimal OpeningBalance,
    DateOnly? OpeningDate,
    string? Iban = null,
    string? Bic = null,
    string? SortCode = null,
    string? AccountNumber = null,
    IReadOnlyList<Guid>? HolderIds = null,
    // The version the edit form loaded (D11): a save of a record changed since is refused. Null is
    // no check, for a client loaded before the deploy that added versions.
    string? Version = null) : IRequest<AccountDto>;
