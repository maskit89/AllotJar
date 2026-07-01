using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Builds HS256-signed JWTs containing the user's id (sub / NameIdentifier) and email.
/// The API later reads NameIdentifier back off the principal to scope data access.
/// </summary>
public class JwtTokenGenerator : IJwtTokenGenerator
{
    /// <summary>Claim carrying the user's Identity security stamp, checked on every request so a
    /// rotated stamp (password change / sign-out-everywhere) revokes previously-issued tokens.</summary>
    public const string SecurityStampClaimType = "sstamp";

    private readonly JwtSettings _settings;

    public JwtTokenGenerator(IOptions<JwtSettings> settings)
    {
        _settings = settings.Value;
    }

    public (string Token, DateTime ExpiresAtUtc) Generate(string userId, string email, string? securityStamp)
    {
        var expires = DateTime.UtcNow.AddMinutes(_settings.ExpiryMinutes);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId),
            new(ClaimTypes.NameIdentifier, userId),
            new(JwtRegisteredClaimNames.Email, email),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString())
        };
        if (!string.IsNullOrEmpty(securityStamp))
        {
            claims.Add(new Claim(SecurityStampClaimType, securityStamp));
        }

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_settings.Key));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: _settings.Issuer,
            audience: _settings.Audience,
            claims: claims,
            expires: expires,
            signingCredentials: creds);

        var encoded = new JwtSecurityTokenHandler().WriteToken(token);
        return (encoded, expires);
    }
}
