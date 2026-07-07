using MediatR;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;

/// <summary>
/// Redeems a one-time invite link and activates the pending membership. Two paths: a signed-in
/// user (their email must match the invite) simply joins with their existing login; otherwise a new
/// login is created from <see cref="Password"/>. Returns enough for the API to issue a JWT.
/// </summary>
public record AcceptInviteCommand(string Token, string? Password, string? DisplayName, bool AcceptedTerms = false)
    : IRequest<AcceptInviteResult>;

public record AcceptInviteResult(string UserId, string Email, HouseholdRole Role, string? DisplayName);
