using System.Text.Json;
using Microsoft.Extensions.Logging;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Development-only stand-in that lets the test harnesses (HTTP integration + journey e2e) drive
/// the whole Google sign-in flow without Google credentials — real Google sign-in needs an
/// interactive consent screen no CI can automate. Registered ONLY when Google:UseFakeValidator is
/// set AND the host environment is Development (see AddInfrastructure) — production cannot enable
/// it through configuration alone.
///
/// A fake credential is <c>fake-google:{json}</c>, e.g.
/// <c>fake-google:{"sub":"g-123","email":"a@b.test","emailVerified":true,"name":"Ana"}</c>.
/// Anything else — including a REAL Google token — is rejected, so a harness pointed at this
/// validator can't be satisfied by accident.
/// </summary>
public class FakeGoogleIdTokenValidator : IGoogleIdTokenValidator
{
    public const string Prefix = "fake-google:";

    private readonly ILogger<FakeGoogleIdTokenValidator> _logger;

    public FakeGoogleIdTokenValidator(ILogger<FakeGoogleIdTokenValidator> logger) => _logger = logger;

    public Task<GoogleIdentity?> ValidateAsync(string idToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(idToken) || !idToken.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return Task.FromResult<GoogleIdentity?>(null);
        }

        try
        {
            using var doc = JsonDocument.Parse(idToken[Prefix.Length..]);
            var root = doc.RootElement;
            var sub = root.TryGetProperty("sub", out var s) ? s.GetString() : null;
            var email = root.TryGetProperty("email", out var e) ? e.GetString() : null;
            if (string.IsNullOrWhiteSpace(sub) || string.IsNullOrWhiteSpace(email))
            {
                return Task.FromResult<GoogleIdentity?>(null);
            }

            var identity = new GoogleIdentity(
                sub,
                email,
                !root.TryGetProperty("emailVerified", out var v) || v.GetBoolean(), // default: verified
                root.TryGetProperty("givenName", out var g) ? g.GetString() : null,
                root.TryGetProperty("familyName", out var f) ? f.GetString() : null,
                root.TryGetProperty("name", out var n) ? n.GetString() : null);
            return Task.FromResult<GoogleIdentity?>(identity);
        }
        catch (JsonException)
        {
            _logger.LogInformation("Rejected a malformed fake Google credential.");
            return Task.FromResult<GoogleIdentity?>(null);
        }
    }
}
