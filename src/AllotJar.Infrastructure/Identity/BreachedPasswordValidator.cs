using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Logging;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// An ASP.NET Identity password validator that rejects passwords known to have appeared in a
/// public data breach, using the Have I Been Pwned "Pwned Passwords" range API. It runs
/// automatically whenever a password is set (register, accept-invite, direct invite, change
/// password) — never on login, so existing logins are not locked out.
///
/// Privacy: uses k-anonymity — only the first 5 characters of the password's SHA-1 hash leave the
/// server (with response padding on), so the full password (or even its full hash) is never sent.
///
/// Availability: fails OPEN — if HIBP is unreachable, the password is allowed (a third-party outage
/// must not block sign-ups or password changes). The length/uniqueness validators still apply.
/// </summary>
public class BreachedPasswordValidator : IPasswordValidator<ApplicationUser>
{
    public const string HttpClientName = "hibp";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<BreachedPasswordValidator> _logger;

    public BreachedPasswordValidator(
        IHttpClientFactory httpClientFactory, ILogger<BreachedPasswordValidator> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<IdentityResult> ValidateAsync(
        UserManager<ApplicationUser> manager, ApplicationUser user, string? password)
    {
        if (string.IsNullOrEmpty(password))
        {
            // Empty/required is another validator's job; nothing to screen here.
            return IdentityResult.Success;
        }

        int breachCount;
        try
        {
            breachCount = await GetBreachCountAsync(password);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Breached-password check skipped — HaveIBeenPwned was unreachable.");
            return IdentityResult.Success; // fail open
        }

        if (breachCount > 0)
        {
            return IdentityResult.Failed(new IdentityError
            {
                Code = "PwnedPassword",
                Description = "This password has appeared in a known data breach. Please choose a different one.",
            });
        }

        return IdentityResult.Success;
    }

    /// <summary>How many times the password appears in the breach corpus (0 = not found).</summary>
    private async Task<int> GetBreachCountAsync(string password)
    {
        var sha1 = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(password)));
        var prefix = sha1[..5];
        var suffix = sha1[5..];

        var client = _httpClientFactory.CreateClient(HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Get, $"range/{prefix}");
        // Pad the response so its size can't reveal how many suffixes share the prefix.
        request.Headers.Add("Add-Padding", "true");

        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();

        // Each line is "<SUFFIX>:<count>"; padding rows have a count of 0.
        foreach (var line in body.Split('\n'))
        {
            var sep = line.IndexOf(':');
            if (sep < 0)
            {
                continue;
            }

            if (line.AsSpan(0, sep).Trim().Equals(suffix, StringComparison.OrdinalIgnoreCase))
            {
                return int.TryParse(line.AsSpan(sep + 1).Trim(), out var count) ? count : 1;
            }
        }

        return 0;
    }
}
