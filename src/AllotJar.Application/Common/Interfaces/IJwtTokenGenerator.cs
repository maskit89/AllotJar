namespace AllotJar.Application.Common.Interfaces;

/// <summary>Issues signed JWTs for authenticated users. Implemented in Infrastructure.</summary>
public interface IJwtTokenGenerator
{
    /// <param name="securityStamp">The user's current Identity security stamp, embedded so the
    /// token can be revoked by rotating the stamp. Null/empty issues a token without the claim.</param>
    /// <returns>The signed compact JWT and the UTC instant at which it expires.</returns>
    (string Token, DateTime ExpiresAtUtc) Generate(string userId, string email, string? securityStamp);
}
