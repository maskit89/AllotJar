using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Infrastructure.Email;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// Email verification at registration + the safe reclaim of an unverified account (catalog
/// REG-086..REG-090), end-to-end over real HTTP. The verification/reclaim emails are captured by
/// <see cref="DevEmailSink"/> (the fixture runs the logging sender), and sends are dispatched off
/// the request path — so the mailbox is polled, not read once.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class EmailVerificationFlowTests
{
    private readonly HttpApiFixture _fixture;

    public EmailVerificationFlowTests(HttpApiFixture fixture) => _fixture = fixture;

    private DevEmailSink Sink => _fixture.Services.GetRequiredService<DevEmailSink>();

    // REG-086 — a fresh registration is signed in but UNVERIFIED, and a confirmation email lands;
    // clicking its link flips /auth/me emailConfirmed to true.
    [Fact]
    public async Task Registration_is_unverified_until_the_emailed_link_is_confirmed()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"verify-{run}@httpsweep.test";

        var register = await RegisterAsync(client, email);
        register.StatusCode.Should().Be(HttpStatusCode.OK);
        var token = (await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;

        // Signed in, but unverified.
        var me = await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token));
        me.RootElement.GetProperty("emailConfirmed").GetBoolean().Should().BeFalse();

        // The confirmation email arrives; follow its link.
        var (linkEmail, linkToken) = await WaitForConfirmLinkAsync(email);
        linkEmail.Should().Be(email);
        var confirm = await client.PostAsJsonAsync("/api/auth/confirm-email",
            new { email = linkEmail, token = linkToken }, HttpApiFixture.Json);
        confirm.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Now verified.
        var meAfter = await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token));
        meAfter.RootElement.GetProperty("emailConfirmed").GetBoolean().Should().BeTrue();
    }

    // REG-087 — a garbage/foreign confirm token is a generic 400; a second confirm of an
    // already-verified email is an idempotent 204 (no state leak).
    [Fact]
    public async Task Confirm_email_rejects_bad_tokens_and_is_idempotent()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"confirm-{run}@httpsweep.test";
        await RegisterAsync(client, email);

        var bad = await client.PostAsJsonAsync("/api/auth/confirm-email",
            new { email, token = "not-a-real-token" }, HttpApiFixture.Json);
        bad.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await bad.Content.ReadAsStringAsync()).Should().Contain("invalid or has expired");

        var unknown = await client.PostAsJsonAsync("/api/auth/confirm-email",
            new { email = $"nobody-{run}@httpsweep.test", token = "x" }, HttpApiFixture.Json);
        unknown.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // Same generic body as the bad-token case — an unknown email must not be distinguishable
        // from a known email with a bad token (no existence oracle on this endpoint).
        (await unknown.Content.ReadAsStringAsync()).Should().Contain("invalid or has expired");

        var (_, goodToken) = await WaitForConfirmLinkAsync(email);
        (await client.PostAsJsonAsync("/api/auth/confirm-email",
            new { email, token = goodToken }, HttpApiFixture.Json)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        // Second confirm of an already-verified account is a clean 204, not an error.
        (await client.PostAsJsonAsync("/api/auth/confirm-email",
            new { email, token = goodToken }, HttpApiFixture.Json)).StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    // REG-088 — SAFE RECLAIM: registering an email that already has an UNVERIFIED account returns a
    // neutral verification-pending response (NO session) and emails a RESET link; redeeming it takes
    // the account over — old password dead, email now confirmed, and the pre-existing session revoked.
    [Fact]
    public async Task Registering_an_unverified_email_emails_a_claim_link_that_takes_the_account_over()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"reclaim-{run}@httpsweep.test";
        var squatterPassword = $"Aa1x{Guid.NewGuid():N}";

        // "Attacker" pre-registers the email (unverified) and holds a session.
        var squat = await RegisterAsync(client, email, squatterPassword);
        var squatterToken = (await HttpApiFixture.ReadJsonAsync(squat)).RootElement.GetProperty("token").GetString()!;
        // Drain the squatter's own verification email so the reclaim poll can't pick it up.
        await WaitForConfirmLinkAsync(email);

        // The true owner tries to register the SAME email → neutral pending response, NO session.
        var ownerPassword = $"Aa1x{Guid.NewGuid():N}";
        var reg = await RegisterAsync(client, email, ownerPassword);
        reg.StatusCode.Should().Be(HttpStatusCode.OK);
        var regBody = await HttpApiFixture.ReadJsonAsync(reg);
        regBody.RootElement.GetProperty("verificationPending").GetBoolean().Should().BeTrue();
        regBody.RootElement.TryGetProperty("token", out _).Should().BeFalse("no session for an unproven claim");

        // A reset (claim) link was emailed; redeem it as the true owner.
        var (_, resetToken) = await WaitForResetLinkAsync(email);
        var reset = await client.PostAsJsonAsync("/api/auth/reset-password",
            new { email, token = resetToken, newPassword = ownerPassword }, HttpApiFixture.Json);
        reset.StatusCode.Should().Be(HttpStatusCode.OK);
        var ownerToken = (await HttpApiFixture.ReadJsonAsync(reset)).RootElement.GetProperty("token").GetString()!;

        // The squatter is out: their session is revoked and their password no longer works.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", squatterToken))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await client.PostAsJsonAsync("/api/auth/login", new { email, password = squatterPassword }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // The owner is in, and the account is now VERIFIED (redeeming the link proved control).
        var me = await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", ownerToken));
        me.RootElement.GetProperty("emailConfirmed").GetBoolean().Should().BeTrue();
    }

    // REG-089 — a VERIFIED existing email still returns the honest "already exists" (no reclaim):
    // once confirmed, the account genuinely belongs to someone.
    [Fact]
    public async Task Registering_a_verified_email_still_says_already_exists()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"taken-{run}@httpsweep.test";

        await RegisterAsync(client, email);
        var (_, confirmToken) = await WaitForConfirmLinkAsync(email);
        (await client.PostAsJsonAsync("/api/auth/confirm-email", new { email, token = confirmToken }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);

        var again = await RegisterAsync(client, email);
        again.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await again.Content.ReadAsStringAsync()).Should().Contain("already exists");
    }

    // REG-090 — resend-verification dispatches a genuinely NEW confirmation email for an unverified
    // caller, and is a no-op 204 (sending nothing) once verified — never a different response that
    // would leak confirmation state. The DevEmailSink never dequeues, so a rising message count is
    // the proof a real send happened: polling for "any confirm link" would pass even if the endpoint
    // silently no-op'd, because the registration email is still sitting in the sink.
    [Fact]
    public async Task Resend_verification_resends_while_unverified_and_noops_once_verified()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"resend-{run}@httpsweep.test";
        var token = (await HttpApiFixture.ReadJsonAsync(await RegisterAsync(client, email)))
            .RootElement.GetProperty("token").GetString()!;

        // Registration sent exactly one confirmation email; wait for it to land.
        await WaitForConfirmCountAsync(email, 1);

        // Resend while unverified must produce a SECOND email — the only way the never-dequeuing
        // sink reaches a count of 2. A silently-no-op'ing endpoint would still 204 but leave it at 1.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/resend-verification", token))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        await WaitForConfirmCountAsync(email, 2);

        // Confirm with the freshest token; then a resend on a VERIFIED account is a no-op 204 that
        // sends nothing (count stays 2) — same 204 shape as the unverified case, so no state leak.
        var (_, resent) = await WaitForConfirmLinkAsync(email);
        (await client.PostAsJsonAsync("/api/auth/confirm-email", new { email, token = resent }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/resend-verification", token))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        // A verified account's resend starts no send at all; give any (erroneous) async dispatch a
        // moment to land, then assert the count never rose past 2.
        await Task.Delay(300);
        ConfirmEmailCount(email).Should().Be(2);
    }

    // ----- helpers -------------------------------------------------------------------------------

    private static Task<HttpResponseMessage> RegisterAsync(HttpClient client, string email, string? password = null) =>
        client.PostAsJsonAsync("/api/auth/register", new
        {
            email,
            password = password ?? $"Aa1x{Guid.NewGuid():N}",
            firstName = "Ver",
            lastName = "Ify",
            preferredCurrency = "EUR",
            numberFormat = (string?)null,
            acceptedTerms = true,
            includeSampleData = false,
        }, HttpApiFixture.Json);

    private int ConfirmEmailCount(string email) =>
        Sink.ForRecipient(email).Count(m => m.TextBody.Contains("/confirm-email?"));

    private async Task WaitForConfirmCountAsync(string email, int expected)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (ConfirmEmailCount(email) >= expected)
            {
                return;
            }

            await Task.Delay(50);
        }

        throw new InvalidOperationException(
            $"Expected at least {expected} confirmation emails for {email}, saw {ConfirmEmailCount(email)}.");
    }

    private Task<(string Email, string Token)> WaitForConfirmLinkAsync(string email) =>
        WaitForLinkAsync(email, "/confirm-email?");

    private Task<(string Email, string Token)> WaitForResetLinkAsync(string email) =>
        WaitForLinkAsync(email, "/reset-password?");

    private async Task<(string Email, string Token)> WaitForLinkAsync(string email, string pathMarker)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var message = Sink.ForRecipient(email)
                .FirstOrDefault(m => m.TextBody.Contains(pathMarker));
            if (message is not null)
            {
                var url = message.TextBody.Split('\n').Select(l => l.Trim())
                    .Single(l => l.StartsWith("http") && l.Contains(pathMarker));
                var query = url[(url.IndexOf('?') + 1)..];
                var parts = query.Split('&').Select(p => p.Split('=', 2))
                    .ToDictionary(p => p[0], p => Uri.UnescapeDataString(p[1]));
                return (parts["email"], parts["token"]);
            }
            await Task.Delay(50);
        }

        throw new InvalidOperationException($"No email containing '{pathMarker}' for {email}.");
    }
}
