using MediatR;
using AllotJar.Application.Common.Households;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Auth.Commands.Login;

/// <summary>
/// Checks the supplied credentials via <see cref="IIdentityService"/> (which enforces lockout on
/// repeated failures) and, on success, resolves the caller's household role and issues a JWT. The
/// handler returns a coarse <see cref="LoginResult"/> rather than throwing, so the controller can
/// keep the "invalid email or password" response identical for both failure causes.
/// </summary>
public class LoginCommandHandler : IRequestHandler<LoginCommand, LoginResult>
{
    private readonly IIdentityService _identity;
    private readonly IApplicationDbContext _db;
    private readonly IJwtTokenGenerator _tokenGenerator;

    public LoginCommandHandler(
        IIdentityService identity, IApplicationDbContext db, IJwtTokenGenerator tokenGenerator)
    {
        _identity = identity;
        _db = db;
        _tokenGenerator = tokenGenerator;
    }

    public async Task<LoginResult> Handle(LoginCommand request, CancellationToken cancellationToken)
    {
        var check = await _identity.CheckCredentialsAsync(request.Email, request.Password);

        if (check.Outcome == CredentialCheckOutcome.LockedOut)
        {
            return new LoginResult(LoginOutcome.LockedOut);
        }
        if (check.Outcome != CredentialCheckOutcome.Success)
        {
            return new LoginResult(LoginOutcome.InvalidCredentials);
        }

        var role = await ActiveHouseholdSelector.ActiveRoleAsync(_db, check.UserId!, check.ActiveOwnerId, cancellationToken);

        var (token, expiresAt) = _tokenGenerator.Generate(check.UserId!, check.Email!, check.SecurityStamp);
        return new LoginResult(
            LoginOutcome.Success, token, expiresAt, check.UserId, check.Email, role, check.DisplayName);
    }
}
