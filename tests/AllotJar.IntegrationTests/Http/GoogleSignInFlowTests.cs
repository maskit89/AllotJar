using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The Google sign-in contract end-to-end over real HTTP (catalog REG-073..REG-078), driven
/// through the Development-only fake validator (Google:UseFakeValidator in the fixture — real
/// Google sign-in needs an interactive consent screen no harness can automate; the fake accepts
/// only <c>fake-google:{json}</c> credentials, never real tokens).
///
/// What this pins: a first Google sign-in creates a passwordless account with the full household
/// bootstrap and a working session (cookie + JWT), consent is collected after the fact
/// (NeedsConsent), the permanent Google `sub` — not the email — is the account key, a VERIFIED
/// email match auto-links to an existing password account, and the failure modes (unverified
/// email, garbage credential) are clean 401s.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class GoogleSignInFlowTests
{
    private readonly HttpApiFixture _fixture;

    public GoogleSignInFlowTests(HttpApiFixture fixture) => _fixture = fixture;

    // REG-073 — first Google sign-in: creates the passwordless account + household, issues a real
    // session (cookie + JWT), flags isNewAccount for sign_up analytics, and defers terms consent.
    [Fact]
    public async Task First_google_sign_in_creates_a_working_passwordless_account()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"google-{run}@httpsweep.test";

        var response = await PostGoogleAsync(client, Credential(sub: $"g-{run}", email: email,
            givenName: "Grete", familyName: "Google"));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await HttpApiFixture.ReadJsonAsync(response);
        body.RootElement.GetProperty("token").GetString().Should().NotBeNullOrEmpty();
        body.RootElement.GetProperty("email").GetString().Should().Be(email);
        body.RootElement.GetProperty("isNewAccount").GetBoolean().Should().BeTrue();
        var token = body.RootElement.GetProperty("token").GetString()!;

        // The session cookie rode along — Google sign-in survives a reload like any other login.
        response.Headers.TryGetValues("Set-Cookie", out var cookies).Should().BeTrue();
        cookies!.Should().Contain(c => c.StartsWith("zbb_rt="));

        // /auth/me: usable household context, consent still owed, and NO password on the account.
        var me = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token);
        me.StatusCode.Should().Be(HttpStatusCode.OK);
        var meJson = await HttpApiFixture.ReadJsonAsync(me);
        meJson.RootElement.GetProperty("needsConsent").GetBoolean().Should().BeTrue(
            "a Google-created account never saw the terms checkbox — the ConsentModal collects it");
        meJson.RootElement.GetProperty("hasPassword").GetBoolean().Should().BeFalse();
        meJson.RootElement.GetProperty("households").GetArrayLength().Should().BeGreaterThan(0,
            "the same household bootstrap as registration must have run");

        // The bootstrap made a REAL, usable household: an authorized write works immediately.
        var month = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/budget", token,
            new { year = 2026, month = 7, copyFromPrevious = false });
        month.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // REG-074 — the permanent Google sub is the account key: a repeat sign-in (even with a CHANGED
    // Google email) lands in the same account, and isNewAccount is false.
    [Fact]
    public async Task Repeat_sign_in_keys_on_the_google_sub_not_the_email()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var sub = $"g-stable-{run}";

        var first = await PostGoogleAsync(client, Credential(sub, $"before-{run}@httpsweep.test"));
        var firstJson = await HttpApiFixture.ReadJsonAsync(first);
        var userId = firstJson.RootElement.GetProperty("userId").GetString();

        // Same sub, different email — as after a Google-side address change.
        var second = await PostGoogleAsync(client, Credential(sub, $"after-{run}@httpsweep.test"));

        second.StatusCode.Should().Be(HttpStatusCode.OK);
        var secondJson = await HttpApiFixture.ReadJsonAsync(second);
        secondJson.RootElement.GetProperty("userId").GetString().Should().Be(userId);
        secondJson.RootElement.GetProperty("isNewAccount").GetBoolean().Should().BeFalse();
        // The app account's email is deliberately NOT rewritten from the token.
        secondJson.RootElement.GetProperty("email").GetString().Should().Be($"before-{run}@httpsweep.test");
    }

    // REG-075 — a VERIFIED Google email matching an existing password account auto-links: one
    // account, both sign-in methods, password intact.
    [Fact]
    public async Task Verified_email_match_auto_links_to_the_existing_password_account()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"linked-{run}@httpsweep.test";
        var password = $"Aa1x{Guid.NewGuid():N}";

        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email,
            password,
            firstName = "Link",
            lastName = "Target",
            preferredCurrency = "EUR",
            numberFormat = (string?)null,
            acceptedTerms = true,
            includeSampleData = false,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK);
        var registeredId = (await HttpApiFixture.ReadJsonAsync(register))
            .RootElement.GetProperty("userId").GetString();

        var google = await PostGoogleAsync(client, Credential($"g-link-{run}", email));

        google.StatusCode.Should().Be(HttpStatusCode.OK);
        var googleJson = await HttpApiFixture.ReadJsonAsync(google);
        googleJson.RootElement.GetProperty("userId").GetString().Should().Be(registeredId,
            "a verified email match must land in the SAME account, not fork a duplicate");
        googleJson.RootElement.GetProperty("isNewAccount").GetBoolean().Should().BeFalse();

        // PRE-HIJACKING DEFENCE: registration never verified the email, so the pre-existing
        // password (which an attacker could have set on the victim's address) must be neutralized
        // the moment Google attests ownership. The old password no longer signs in...
        var oldLogin = await client.PostAsJsonAsync("/api/auth/login",
            new { email, password }, HttpApiFixture.Json);
        oldLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
            "the pre-existing (unverified-email) password must be removed on Google auto-link");

        // ...and /auth/me reports the account as passwordless (owner can re-add via forgot-password).
        var token = googleJson.RootElement.GetProperty("token").GetString()!;
        var me = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token);
        (await HttpApiFixture.ReadJsonAsync(me)).RootElement
            .GetProperty("hasPassword").GetBoolean().Should().BeFalse();
    }

    // REG-082 — pre-hijacking + lockout-exempt together: a locked-out password account (5 failed
    // sign-ins) whose email a Google credential then verifies STILL signs in via Google (lockout
    // throttles password guessing, not a proven token), and the same sign-in neutralizes the
    // pre-existing password (revoked sessions + password removed).
    [Fact]
    public async Task Google_link_ignores_lockout_and_neutralizes_a_pre_existing_password()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"prehijack-{run}@httpsweep.test";
        var password = $"Aa1x{Guid.NewGuid():N}";

        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email,
            password,
            firstName = "Pre",
            lastName = "Hijack",
            preferredCurrency = "EUR",
            numberFormat = (string?)null,
            acceptedTerms = true,
            includeSampleData = false,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK);
        var preLinkToken = (await HttpApiFixture.ReadJsonAsync(register))
            .RootElement.GetProperty("token").GetString()!;

        // Trip the 5-strike lockout on the password account.
        for (var i = 0; i < 5; i++)
        {
            await client.PostAsJsonAsync("/api/auth/login",
                new { email, password = $"Wrong{i}x{Guid.NewGuid():N}" }, HttpApiFixture.Json);
        }
        var lockedLogin = await client.PostAsJsonAsync("/api/auth/login",
            new { email, password }, HttpApiFixture.Json);
        lockedLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await lockedLogin.Content.ReadAsStringAsync()).Should().Contain("locked");

        // Google sign-in with the verified matching email STILL works despite the lockout.
        var google = await PostGoogleAsync(client, Credential($"g-prehijack-{run}", email));
        google.StatusCode.Should().Be(HttpStatusCode.OK, "a valid Google token bypasses password lockout");

        // The pre-link session (an attacker's, in the attack) is revoked by the stamp rotation...
        var stalePreLink = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", preLinkToken);
        stalePreLink.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
            "linking Google must revoke sessions held on the pre-existing account");

        // ...and neither the old password (removed) NOR its lockout matters anymore — password
        // login is simply gone until the owner re-adds one via forgot-password.
        var oldLogin = await client.PostAsJsonAsync("/api/auth/login",
            new { email, password }, HttpApiFixture.Json);
        oldLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // REG-076 — an UNVERIFIED email must not link or create: without Google's attestation, anyone
    // able to mint an unverified Google identity claiming a victim's address could walk into the
    // victim's account.
    [Fact]
    public async Task Unverified_email_is_rejected()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];

        var response = await PostGoogleAsync(client, Credential(
            $"g-unverified-{run}", $"unverified-{run}@httpsweep.test", emailVerified: false));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await response.Content.ReadAsStringAsync()).Should().Contain("not verified");
    }

    // REG-077 — garbage/invalid credentials are a clean generic 401 (no enumeration, no 500), and
    // a REAL Google token is rejected by the fake validator (the harness can't be satisfied by
    // accident).
    [Fact]
    public async Task Invalid_credentials_are_a_clean_401()
    {
        using var client = _fixture.CreateClient();

        foreach (var credential in new[]
        {
            "not-a-google-token",
            "fake-google:not-json",
            "fake-google:{\"email\":\"missing-sub@httpsweep.test\"}",
            "eyJhbGciOiJSUzI1NiJ9.realLookingButMeaningless.signature",
        })
        {
            var response = await client.PostAsJsonAsync("/api/auth/google",
                new { credential }, HttpApiFixture.Json);
            response.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
                $"credential '{credential[..Math.Min(credential.Length, 24)]}…' must be rejected");
            (await response.Content.ReadAsStringAsync()).Should().Contain("could not be verified");
        }
    }

    // REG-078 — a Google-created account's currency/format follow the client's locale hints when
    // valid, and fall back to the defaults (never fail sign-in) when garbage.
    [Fact]
    public async Task Locale_hints_apply_to_new_accounts_and_garbage_falls_back()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];

        var good = await PostGoogleAsync(client,
            Credential($"g-locale-{run}", $"locale-{run}@httpsweep.test"),
            preferredCurrency: "GBP", numberFormat: "dot-comma");
        var goodToken = (await HttpApiFixture.ReadJsonAsync(good)).RootElement.GetProperty("token").GetString()!;
        var goodMe = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", goodToken);
        var goodJson = await HttpApiFixture.ReadJsonAsync(goodMe);
        goodJson.RootElement.GetProperty("preferredCurrency").GetString().Should().Be("GBP");
        goodJson.RootElement.GetProperty("numberFormat").GetString().Should().Be("dot-comma");

        var bad = await PostGoogleAsync(client,
            Credential($"g-badloc-{run}", $"badloc-{run}@httpsweep.test"),
            preferredCurrency: "NOTACURRENCY", numberFormat: "weird-format");
        bad.StatusCode.Should().Be(HttpStatusCode.OK, "bad locale hints must never fail sign-in");
        var badToken = (await HttpApiFixture.ReadJsonAsync(bad)).RootElement.GetProperty("token").GetString()!;
        var badMe = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", badToken);
        var badJson = await HttpApiFixture.ReadJsonAsync(badMe);
        badJson.RootElement.GetProperty("preferredCurrency").GetString().Should().Be("EUR");
        badJson.RootElement.GetProperty("numberFormat").GetString().Should().Be("comma-dot");
    }

    // ----- helpers -------------------------------------------------------------------------------

    /// <summary>A fake-validator credential (see FakeGoogleIdTokenValidator).</summary>
    private static string Credential(
        string sub, string email, bool emailVerified = true,
        string? givenName = null, string? familyName = null)
    {
        var payload = JsonSerializer.Serialize(new
        {
            sub,
            email,
            emailVerified,
            givenName,
            familyName,
        });
        return $"fake-google:{payload}";
    }

    private static Task<HttpResponseMessage> PostGoogleAsync(
        HttpClient client, string credential,
        string? preferredCurrency = null, string? numberFormat = null) =>
        client.PostAsJsonAsync("/api/auth/google",
            new { credential, preferredCurrency, numberFormat }, HttpApiFixture.Json);

    // REG-085 — a login with a password can disconnect Google: /auth/me flips hasGoogle to false,
    // and a subsequent Google sign-in re-creates the link rather than being stuck.
    [Fact]
    public async Task A_password_login_can_disconnect_and_reconnect_google()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"unlink-{run}@httpsweep.test";
        var password = $"Aa1x{Guid.NewGuid():N}";

        // A password account, then a Google auto-link — which (pre-hijacking defence) removes the
        // password, so ADD a password back via reset first would be one route; simpler: create the
        // account passwordless via Google, then set a password via reset to satisfy the guard.
        var google = await PostGoogleAsync(client, Credential($"g-unlink-{run}", email));
        google.StatusCode.Should().Be(HttpStatusCode.OK);
        var token = (await HttpApiFixture.ReadJsonAsync(google)).RootElement.GetProperty("token").GetString()!;

        // hasGoogle is true, hasPassword false — so unlink is REFUSED (would orphan the login).
        var me1 = await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token));
        me1.RootElement.GetProperty("hasGoogle").GetBoolean().Should().BeTrue();
        me1.RootElement.GetProperty("hasPassword").GetBoolean().Should().BeFalse();

        var blocked = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/google/unlink", token);
        blocked.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await blocked.Content.ReadAsStringAsync()).Should().Contain("only way you sign in");

        // Add a password via the reset flow (works on a passwordless account), then unlink is allowed.
        var resetToken = await IssueResetTokenAsync(email);
        var reset = await client.PostAsJsonAsync("/api/auth/reset-password",
            new { email, token = resetToken, newPassword = password }, HttpApiFixture.Json);
        reset.StatusCode.Should().Be(HttpStatusCode.OK);
        var tokenAfterReset = (await HttpApiFixture.ReadJsonAsync(reset)).RootElement.GetProperty("token").GetString()!;

        var unlink = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/google/unlink", tokenAfterReset);
        unlink.StatusCode.Should().Be(HttpStatusCode.OK);
        // Unlink rotates the stamp (RemoveLoginAsync), so it returns a FRESH token to keep the user
        // signed in — the pre-unlink token is now dead, the new one works.
        var tokenAfterUnlink = (await HttpApiFixture.ReadJsonAsync(unlink)).RootElement.GetProperty("token").GetString()!;
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", tokenAfterReset))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized, "the pre-unlink access token is revoked by the stamp rotation");

        var me2 = await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", tokenAfterUnlink));
        me2.RootElement.GetProperty("hasGoogle").GetBoolean().Should().BeFalse("Google was disconnected");
        me2.RootElement.GetProperty("hasPassword").GetBoolean().Should().BeTrue();

        // Signing in with Google again re-links it (verified-email match onto the now-password account).
        var reconnect = await PostGoogleAsync(client, Credential($"g-unlink2-{run}", email));
        reconnect.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    /// <summary>Runs forgot-password and reads the reset token back from the dev mailbox.</summary>
    private async Task<string> IssueResetTokenAsync(string email)
    {
        using var client = _fixture.CreateClient();
        (await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);

        var sink = _fixture.Services.GetRequiredService<AllotJar.Infrastructure.Email.DevEmailSink>();
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var messages = sink.ForRecipient(email);
            if (messages.Count > 0)
            {
                var url = messages[0].TextBody.Split('\n').Select(l => l.Trim())
                    .Single(l => l.StartsWith("http") && l.Contains("/reset-password?"));
                var query = url[(url.IndexOf('?') + 1)..];
                return query.Split('&').Select(p => p.Split('=', 2))
                    .ToDictionary(p => p[0], p => Uri.UnescapeDataString(p[1]))["token"];
            }
            await Task.Delay(50);
        }

        throw new InvalidOperationException($"No reset email for {email}.");
    }
}
