using MediatR;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Auth.Commands.Login;

/// <summary>Validates credentials and, on success, mints a JWT for the household login.</summary>
public record LoginCommand(string Email, string Password) : IRequest<LoginResult>;

/// <summary>The coarse login outcome. Token + identity fields are populated only on
/// <see cref="LoginOutcome.Success"/>; the controller maps the outcome to an HTTP status.</summary>
public enum LoginOutcome
{
    Success,
    InvalidCredentials,
    LockedOut,
}

public record LoginResult(
    LoginOutcome Outcome,
    string? Token = null,
    DateTime ExpiresAtUtc = default,
    string? UserId = null,
    string? Email = null,
    HouseholdRole Role = HouseholdRole.Owner,
    string? DisplayName = null);
