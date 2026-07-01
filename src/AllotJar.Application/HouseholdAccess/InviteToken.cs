using System.Security.Cryptography;
using System.Text;

namespace AllotJar.Application.HouseholdAccess;

/// <summary>
/// One-time invite tokens for link invites. The raw token is shown to the owner once and only
/// its SHA-256 hash is stored, so a leaked database row cannot be used to redeem an invite.
/// </summary>
public static class InviteToken
{
    /// <summary>A new URL-safe random token (256 bits of entropy).</summary>
    public static string Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    /// <summary>Hex SHA-256 of a token, as stored in <c>HouseholdMembership.InviteTokenHash</c>.</summary>
    public static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}
