using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Security;

namespace AllotJar.Application.Accounts.Commands.SetAccountSharing;

/// <summary>
/// Makes a personal account private to its holder's login or shares it with the household
/// (rules 31/33, P54). Only the holder's own login may choose, whatever its household role: the
/// choice is theirs, not an administrator's. Refused for joint and household accounts and for an
/// account a jar uses (P55).
/// </summary>
[AllowAnyRole]
public record SetAccountSharingCommand(Guid AccountId, bool IsPrivate) : IRequest<AccountDto>;
