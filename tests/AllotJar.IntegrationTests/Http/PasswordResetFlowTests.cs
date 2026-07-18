using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Infrastructure.Email;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The forgot/reset-password contract end-to-end over real HTTP (catalog REG-059..REG-062):
/// forgot-password answers 204 identically for known and unknown emails (no enumeration) while
/// only the known one gets mail; the emailed link's token resets the password; the reset revokes
/// every pre-reset credential (bearer token AND refresh cookie) and signs the caller in; and the
/// reset endpoint's failure modes stay non-enumerating. The email is read from
/// <see cref="DevEmailSink"/> — with no API key configured the API "sends" via LoggingEmailSender,
/// exactly like a developer box.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class PasswordResetFlowTests
{
    private readonly HttpApiFixture _fixture;

    public PasswordResetFlowTests(HttpApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Forgot_then_reset_rotates_credentials_and_signs_in()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"reset-{run}@httpsweep.test";
        var oldPassword = $"Aa1x{Guid.NewGuid():N}";
        var newPassword = $"Aa1x{Guid.NewGuid():N}";

        // Register (empty account — the flow under test is auth, not budgets).
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email,
            password = oldPassword,
            firstName = "Reset",
            lastName = "Flow",
            preferredCurrency = "EUR",
            numberFormat = (string?)null,
            acceptedTerms = true,
            includeSampleData = false,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK);
        var preResetToken = (await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;

        // Forgot-password → 204, and the reset email lands in the dev sink.
        var forgot = await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json);
        forgot.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var sink = _fixture.Services.GetRequiredService<DevEmailSink>();
        var mail = sink.ForRecipient(email).Should().ContainSingle().Subject;
        var (linkEmail, linkToken) = ParseResetLink(mail.TextBody);
        linkEmail.Should().Be(email);

        // Redeem the link → 200 with a fresh session (token + rotated refresh cookie).
        var reset = await client.PostAsJsonAsync("/api/auth/reset-password", new
        {
            email = linkEmail,
            token = linkToken,
            newPassword,
        }, HttpApiFixture.Json);
        reset.StatusCode.Should().Be(HttpStatusCode.OK);
        var resetJson = await HttpApiFixture.ReadJsonAsync(reset);
        resetJson.RootElement.GetProperty("token").GetString().Should().NotBeNullOrEmpty();
        reset.Headers.TryGetValues("Set-Cookie", out var cookies).Should().BeTrue();
        cookies!.Should().Contain(c => c.StartsWith("zbb_rt="), "a successful reset signs this device in");

        // The old password is gone; the new one signs in.
        var oldLogin = await client.PostAsJsonAsync("/api/auth/login",
            new { email, password = oldPassword }, HttpApiFixture.Json);
        oldLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var newLogin = await client.PostAsJsonAsync("/api/auth/login",
            new { email, password = newPassword }, HttpApiFixture.Json);
        newLogin.StatusCode.Should().Be(HttpStatusCode.OK);

        // Every pre-reset access token died with the security-stamp rotation.
        var stale = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", preResetToken);
        stale.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // REG-061 — a redeemed link is dead: replaying the token is the generic invalid-link 400.
        var replay = await client.PostAsJsonAsync("/api/auth/reset-password", new
        {
            email = linkEmail,
            token = linkToken,
            newPassword = $"Aa1x{Guid.NewGuid():N}",
        }, HttpApiFixture.Json);
        replay.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await replay.Content.ReadAsStringAsync()).Should().Contain("invalid or has expired");
    }

    // REG-059 — the no-enumeration contract: an unknown email gets the same 204 as a known one,
    // and nothing is sent.
    [Fact]
    public async Task Forgot_password_for_an_unknown_email_is_an_indistinguishable_204()
    {
        using var client = _fixture.CreateClient();
        var email = $"nobody-{Guid.NewGuid():N}@httpsweep.test";

        var response = await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        _fixture.Services.GetRequiredService<DevEmailSink>().ForRecipient(email).Should().BeEmpty();
    }

    // REG-062 — reset failures don't enumerate either: unknown email and garbage token produce the
    // SAME generic invalid-link 400 (a weak password against a real token is the one helpful 400,
    // covered at the unit layer).
    [Fact]
    public async Task Reset_password_failures_are_generic_for_unknown_email_and_bad_token()
    {
        using var client = _fixture.CreateClient();

        var unknownEmail = await client.PostAsJsonAsync("/api/auth/reset-password", new
        {
            email = $"nobody-{Guid.NewGuid():N}@httpsweep.test",
            token = "irrelevant",
            newPassword = $"Aa1x{Guid.NewGuid():N}",
        }, HttpApiFixture.Json);

        var badToken = await client.PostAsJsonAsync("/api/auth/reset-password", new
        {
            email = $"owner-known@httpsweep.test", // shape-valid; existence must not matter
            token = "garbage-token",
            newPassword = $"Aa1x{Guid.NewGuid():N}",
        }, HttpApiFixture.Json);

        unknownEmail.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        badToken.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var unknownBody = await unknownEmail.Content.ReadAsStringAsync();
        var badTokenBody = await badToken.Content.ReadAsStringAsync();
        unknownBody.Should().Be(badTokenBody, "the two failure modes must be indistinguishable");
    }

    /// <summary>Pulls email + token back out of the reset link in the text body.</summary>
    private static (string Email, string Token) ParseResetLink(string textBody)
    {
        var url = textBody.Split('\n').Select(l => l.Trim())
            .Single(l => l.StartsWith("http") && l.Contains("/reset-password?"));
        var query = url[(url.IndexOf('?') + 1)..];
        var parts = query.Split('&')
            .Select(p => p.Split('=', 2))
            .ToDictionary(p => p[0], p => Uri.UnescapeDataString(p[1]));
        return (parts["email"], parts["token"]);
    }
}
