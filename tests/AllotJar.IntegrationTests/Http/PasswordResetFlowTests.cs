using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Email;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The forgot/reset-password contract end-to-end over real HTTP (catalog REG-053, REG-057, REG-058,
/// REG-060, REG-063, REG-064): forgot-password answers 204 identically for known and unknown emails
/// (no enumeration) while only the known one gets mail; the emailed link's token resets the
/// password; the reset revokes every pre-reset credential — both the bearer token AND the refresh
/// cookie — clears any lockout, and signs the caller in; and the reset endpoint's failure modes
/// stay non-enumerating. Email is read from <see cref="DevEmailSink"/>: with no API key configured
/// the API "sends" via LoggingEmailSender, exactly like a developer box. The forgot-password send
/// runs OFF the request path (constant-time no-enumeration), so the mailbox is polled, not read once.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class PasswordResetFlowTests
{
    private readonly HttpApiFixture _fixture;

    public PasswordResetFlowTests(HttpApiFixture fixture) => _fixture = fixture;

    // REG-063 — the whole happy path over real HTTP: forgot → emailed link → reset → every
    // pre-reset credential (access token AND refresh cookie) dead → this device signed in.
    [Fact]
    public async Task Forgot_then_reset_rotates_credentials_and_signs_in()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"reset-{run}@httpsweep.test";
        var oldPassword = $"Aa1x{Guid.NewGuid():N}";
        var newPassword = $"Aa1x{Guid.NewGuid():N}";

        var register = await RegisterAsync(client, email, oldPassword);
        register.StatusCode.Should().Be(HttpStatusCode.OK);
        var preResetBearer = (await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;
        // REG-057 — the refresh cookie issued at registration; the reset must kill it too.
        var preResetRefreshCookie = ExtractRefreshCookie(register);

        // Forgot-password → 204, and the reset email lands in the dev sink (asynchronously).
        var forgot = await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json);
        forgot.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var mail = await WaitForEmailAsync(email);
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

        // REG-057 — every pre-reset access token died with the security-stamp rotation...
        var staleBearer = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", preResetBearer);
        staleBearer.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // ...and every pre-reset REFRESH token was revoked (RevokeAllForUserAsync): presenting the
        // registration-time cookie to /auth/refresh no longer mints a session. A bare client (no
        // cookie jar) is used so the explicit old cookie isn't overwritten by the reset's fresh one.
        using var bareClient = _fixture.CreateClientWithoutCookies();
        using var replayRefresh = new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh");
        replayRefresh.Headers.Add("Cookie", $"zbb_rt={preResetRefreshCookie}");
        var refreshWithOldCookie = await bareClient.SendAsync(replayRefresh);
        refreshWithOldCookie.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
            "the pre-reset refresh cookie must be revoked, or a stolen cookie survives the reset");

        // REG-058 — a redeemed link is dead: replaying the token is the generic invalid-link 400.
        var replay = await client.PostAsJsonAsync("/api/auth/reset-password", new
        {
            email = linkEmail,
            token = linkToken,
            newPassword = $"Aa1x{Guid.NewGuid():N}",
        }, HttpApiFixture.Json);
        replay.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await replay.Content.ReadAsStringAsync()).Should().Contain("invalid or has expired");
    }

    // REG-064 (lockout leg) — a user who locked themselves out then reset must be able to sign in
    // with the new password immediately: the reset clears LockoutEnd + AccessFailedCount.
    [Fact]
    public async Task Reset_clears_an_active_lockout()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"locked-{run}@httpsweep.test";
        var oldPassword = $"Aa1x{Guid.NewGuid():N}";
        var newPassword = $"Aa1x{Guid.NewGuid():N}";

        (await RegisterAsync(client, email, oldPassword)).StatusCode.Should().Be(HttpStatusCode.OK);

        // Trip the 5-strike lockout with wrong-password sign-ins (the fixture's raised rate limit
        // lets this run without throttling).
        for (var i = 0; i < 5; i++)
        {
            await client.PostAsJsonAsync("/api/auth/login",
                new { email, password = $"Wrong{i}x{Guid.NewGuid():N}" }, HttpApiFixture.Json);
        }
        // Even the CORRECT old password is now refused as locked.
        var lockedLogin = await client.PostAsJsonAsync("/api/auth/login",
            new { email, password = oldPassword }, HttpApiFixture.Json);
        lockedLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await lockedLogin.Content.ReadAsStringAsync()).Should().Contain("locked");

        // Reset via the emailed link.
        (await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        var (linkEmail, linkToken) = ParseResetLink((await WaitForEmailAsync(email)).TextBody);
        (await client.PostAsJsonAsync("/api/auth/reset-password",
            new { email = linkEmail, token = linkToken, newPassword }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // The new password signs in right away — the lockout was cleared, not merely bypassed by
        // the reset's own sign-in.
        var newLogin = await client.PostAsJsonAsync("/api/auth/login",
            new { email, password = newPassword }, HttpApiFixture.Json);
        newLogin.StatusCode.Should().Be(HttpStatusCode.OK, "a successful reset must clear the lockout");
    }

    // REG-053 — the no-enumeration contract: an unknown email gets the same 204 as a known one,
    // and nothing is sent (the async dispatch returns before any send for an unknown address).
    [Fact]
    public async Task Forgot_password_for_an_unknown_email_is_an_indistinguishable_204()
    {
        using var client = _fixture.CreateClient();
        var email = $"nobody-{Guid.NewGuid():N}@httpsweep.test";

        var response = await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        // Give any (non-existent) dispatch time to run, then confirm nothing was ever captured.
        await Task.Delay(500);
        Sink.ForRecipient(email).Should().BeEmpty();
    }

    // REG-064 — reset failures don't enumerate: an unknown email and a REAL account with a dead
    // token produce the SAME generic invalid-link 400. The real-account leg genuinely reaches the
    // InvalidToken branch (registered first), so this pins both distinct branches, not one twice.
    [Fact]
    public async Task Reset_password_failures_are_generic_for_unknown_email_and_bad_token()
    {
        using var client = _fixture.CreateClient();
        var realEmail = $"realbadtoken-{Guid.NewGuid():N}@httpsweep.test";
        (await RegisterAsync(client, realEmail, $"Aa1x{Guid.NewGuid():N}"))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var unknownEmail = await client.PostAsJsonAsync("/api/auth/reset-password", new
        {
            email = $"nobody-{Guid.NewGuid():N}@httpsweep.test",
            token = "irrelevant",
            newPassword = $"Aa1x{Guid.NewGuid():N}",
        }, HttpApiFixture.Json);

        var realUserBadToken = await client.PostAsJsonAsync("/api/auth/reset-password", new
        {
            email = realEmail, // a genuinely registered account → reaches ResetPasswordAsync
            token = "garbage-token",
            newPassword = $"Aa1x{Guid.NewGuid():N}",
        }, HttpApiFixture.Json);

        unknownEmail.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        realUserBadToken.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var unknownBody = await unknownEmail.Content.ReadAsStringAsync();
        var realBadTokenBody = await realUserBadToken.Content.ReadAsStringAsync();
        realBadTokenBody.Should().Be(unknownBody,
            "the unknown-email and dead-token failures must be byte-identical, or reset becomes an enumeration oracle");
    }

    // REG-060 — the production reset-token lifespan is pinned against the REAL DI registration (not
    // just a test-local Configure), so dropping the Configure<DataProtectionTokenProviderOptions>
    // in DependencyInjection.cs (silently reverting Identity to its 24h default) fails here.
    [Fact]
    public void Reset_token_lifespan_is_two_hours_in_the_real_container()
    {
        var options = _fixture.Services
            .GetRequiredService<IOptions<DataProtectionTokenProviderOptions>>().Value;

        options.TokenLifespan.Should().Be(TimeSpan.FromHours(PasswordResetEmail.LinkLifetimeHours));
        PasswordResetEmail.LinkLifetimeHours.Should().Be(2);
    }

    // The Development mailbox the journey specs read: its serialized JSON contract (camelCase
    // `subject` + `textBody`) is pinned at a gated layer, not only via the non-required journey job.
    [Fact]
    public async Task Dev_mailbox_endpoint_returns_the_serialized_email_shape()
    {
        using var client = _fixture.CreateClient();
        var email = $"mailbox-{Guid.NewGuid():N}@httpsweep.test";
        (await RegisterAsync(client, email, $"Aa1x{Guid.NewGuid():N}")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        await WaitForEmailAsync(email); // ensure the async send has landed

        using var response = await client.GetAsync($"/api/dev/emails?to={Uri.EscapeDataString(email)}");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        doc.RootElement.ValueKind.Should().Be(JsonValueKind.Array);
        doc.RootElement.GetArrayLength().Should().BeGreaterThan(0);
        // The mailbox now also holds the registration verification email, so find the RESET one by
        // its textBody rather than assuming index 0 — the camelCase field names are what's pinned.
        var reset = doc.RootElement.EnumerateArray()
            .First(m => m.GetProperty("textBody").GetString()!.Contains("/reset-password?"));
        reset.TryGetProperty("subject", out var subject).Should().BeTrue("journey specs read camelCase `subject`");
        subject.GetString().Should().Contain("password");
    }

    // ----- helpers -------------------------------------------------------------------------------

    private DevEmailSink Sink => _fixture.Services.GetRequiredService<DevEmailSink>();

    private static Task<HttpResponseMessage> RegisterAsync(HttpClient client, string email, string password) =>
        client.PostAsJsonAsync("/api/auth/register", new
        {
            email,
            password,
            firstName = "Reset",
            lastName = "Flow",
            preferredCurrency = "EUR",
            numberFormat = (string?)null,
            acceptedTerms = true,
            includeSampleData = false,
        }, HttpApiFixture.Json);

    /// <summary>Polls the dev sink until the reset email for <paramref name="email"/> lands (the
    /// forgot-password send is dispatched off the request path, so it isn't there the instant 204
    /// returns).</summary>
    private async Task<EmailMessage> WaitForEmailAsync(string email)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            // Registration also sends a verification email now, so filter for the RESET link
            // specifically rather than grabbing whatever landed first.
            var message = Sink.ForRecipient(email).FirstOrDefault(m => m.TextBody.Contains("/reset-password?"));
            if (message is not null)
            {
                return message;
            }
            await Task.Delay(50);
        }

        throw new InvalidOperationException($"No reset email captured for {email} within the timeout.");
    }

    private static string ExtractRefreshCookie(HttpResponseMessage response)
    {
        var setCookie = response.Headers.GetValues("Set-Cookie")
            .First(c => c.StartsWith("zbb_rt=", StringComparison.Ordinal));
        return setCookie["zbb_rt=".Length..].Split(';')[0];
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
