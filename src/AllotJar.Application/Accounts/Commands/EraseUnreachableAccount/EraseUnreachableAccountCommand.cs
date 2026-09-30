using MediatR;
using AllotJar.Application.Common.Security;

namespace AllotJar.Application.Accounts.Commands.EraseUnreachableAccount;

/// <summary>
/// Erases for good an account private to a login no longer in the household (P59, Christopher's
/// "Add" of 30 September 2026): the account, its holders and privacy, every entry in it and every
/// transfer touching it, with their fees and jar postings. Nothing in it is shown to the caller.
/// <paramref name="ConfirmName"/> must be the account's name, typed. Owner only.
/// </summary>
[OwnerOnly]
public record EraseUnreachableAccountCommand(Guid Id, string ConfirmName) : IRequest;
