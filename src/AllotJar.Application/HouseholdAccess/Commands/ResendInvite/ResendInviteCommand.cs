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
/// Where the email goes, and for a link invite a fresh one-time token, not saved yet: once its email
/// went out, <see cref="CommitResentInviteCommand"/> makes it the invite's link (the earlier one then
/// stops working, since only a hash is kept). A null <see cref="InviteToken"/> means the login's
/// "choose your password" link.
/// </summary>
public record ResendInviteResult(string Email, string? InviteToken);

/// <summary>
/// "Send again", second step (PR #307 review P3-2): the fresh link's email went out, so it replaces
/// the pending invite's link and runs for another 7 days. A send that failed never gets here, so the
/// link the invitee may already hold keeps working. Owner-only.
/// </summary>
[OwnerOnly]
public record CommitResentInviteCommand(Guid MembershipId, string InviteToken) : IRequest;
