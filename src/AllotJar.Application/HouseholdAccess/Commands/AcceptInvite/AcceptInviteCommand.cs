using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;

/// <summary>
/// Redeems a one-time invite link and activates the pending membership. Two paths: a signed-in
/// user (their email must match the invite) simply joins with their existing login; otherwise a new
/// login is created from <see cref="Password"/>. Returns enough for the API to issue a JWT.
/// Authorized by the invite token, NOT the caller's role in their current household, so it is
/// exempt from the role gate — a signed-in Limited/Read-only user must still be able to accept.
/// </summary>
[AllowAnyRole]
public record AcceptInviteCommand(string Token, string? Password, string? DisplayName, bool AcceptedTerms = false)
    : IRequest<AcceptInviteResult>;

/// <summary>
/// <see cref="CreatedNewLogin"/> is true only on the anonymous path, where the accept CREATED the
/// login — the API then dispatches the initial address-verification email, exactly like
/// registration does (an invite-created user is unverified and would otherwise never receive one
/// unless they found the Resend button).
/// </summary>
public record AcceptInviteResult(
    string UserId, string Email, HouseholdRole Role, string? DisplayName, bool CreatedNewLogin = false);
