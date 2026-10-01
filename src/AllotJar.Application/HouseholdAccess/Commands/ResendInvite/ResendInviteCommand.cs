using MediatR;
using AllotJar.Application.Common.Security;

namespace AllotJar.Application.HouseholdAccess.Commands.ResendInvite;

/// <summary>
/// "Send again" on People (#298 R2-P2-1 follow-up): prepares the email a pending invite or a login
/// still waiting to choose its password needs again, so a lost email isn't a dead end. Owner-only.
/// </summary>
[OwnerOnly]
public record ResendInviteCommand(Guid MembershipId) : IRequest<ResendInviteResult>;

/// <summary>
/// Where the email goes, and for a link invite the fresh one-time token (the earlier link stops
/// working, since only a hash is kept). A null <see cref="InviteToken"/> means the login's
/// "choose your password" link.
/// </summary>
public record ResendInviteResult(string Email, string? InviteToken);
