using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// The one-time codes that stand in for a passkey when the device holding it is lost (fix 14). A
/// login gets <see cref="Count"/> when it adds its first passkey and sees them once; only their
/// SHA-256 hashes are kept, in the login's Identity token row. Identity's own recovery codes are
/// stored as typed, so these are kept separately.
/// </summary>
public sealed class RecoveryCodes
{
    public const int Count = 10;

    private const string TokenProvider = "AllotJar";
    private const string TokenName = "RecoveryCodeHashes";

    // No 0/o, 1/i/l: a code copied by hand off paper must read back the same.
    private const string Alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    private const int HalfLength = 5;

    private readonly UserManager<ApplicationUser> _users;

    public RecoveryCodes(UserManager<ApplicationUser> users) => _users = users;

    /// <summary>Makes a fresh set, voiding any the login held, and returns them to show once.</summary>
    public async Task<IReadOnlyList<string>> ReplaceAsync(ApplicationUser user)
    {
        var codes = Enumerable.Range(0, Count).Select(_ => Generate()).ToList();
        var result = await _users.SetAuthenticationTokenAsync(
            user, TokenProvider, TokenName, string.Join(';', codes.Select(Hash)));
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(
                "Saving recovery codes failed: " + string.Join("; ", result.Errors.Select(e => e.Code)));
        }
        return codes;
    }

    public async Task<int> CountAsync(ApplicationUser user) => (await HashesAsync(user)).Count;

    /// <summary>
    /// Uses up one code. False when it is not one of the login's, or when another request saved the
    /// login first (the concurrency stamp refuses the second save), so a code works once only.
    /// </summary>
    public async Task<bool> RedeemAsync(ApplicationUser user, string? code)
    {
        var normalized = Normalize(code);
        if (normalized.Length != HalfLength * 2)
        {
            return false;
        }

        var hashes = await HashesAsync(user);
        var hash = Hash(normalized);
        var match = hashes.FirstOrDefault(h =>
            CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(h), Encoding.ASCII.GetBytes(hash)));
        if (match is null)
        {
            return false;
        }

        hashes.Remove(match);
        var result = await _users.SetAuthenticationTokenAsync(user, TokenProvider, TokenName, string.Join(';', hashes));
        return result.Succeeded;
    }

    /// <summary>Removes the login's codes (its last passkey went).</summary>
    public async Task ClearAsync(ApplicationUser user) =>
        await _users.RemoveAuthenticationTokenAsync(user, TokenProvider, TokenName);

    private async Task<List<string>> HashesAsync(ApplicationUser user)
    {
        var stored = await _users.GetAuthenticationTokenAsync(user, TokenProvider, TokenName);
        return string.IsNullOrEmpty(stored)
            ? []
            : stored.Split(';', StringSplitOptions.RemoveEmptyEntries).ToList();
    }

    /// <summary>"abcde-fghjk": two groups so it reads off a screen or a printout in one glance.</summary>
    private static string Generate()
    {
        var chars = new char[HalfLength * 2];
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        }
        return $"{new string(chars, 0, HalfLength)}-{new string(chars, HalfLength, HalfLength)}";
    }

    /// <summary>Typed codes may come in capitals, with spaces, or without the dash.</summary>
    private static string Normalize(string? code) =>
        new((code ?? string.Empty).Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    private static string Hash(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(code))));
}
