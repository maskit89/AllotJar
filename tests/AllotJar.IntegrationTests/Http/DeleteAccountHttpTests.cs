using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// "Delete my account" (compliance fix 5) over real HTTP: the preview, the password that guards it
/// for a login that has one, the refusal while others share the budget, and a deleted login that can
/// neither use its old token nor sign in again.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class DeleteAccountHttpTests
{
    private readonly HttpApiFixture _fixture;

    public DeleteAccountHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    private static async Task<(string Token, string Email, string Password)> RegisterAsync(HttpClient client)
    {
        var email = $"del-{Guid.NewGuid():N}"[..16] + "@delete.test";
        var password = HttpApiFixture.StrongPassword();
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email, password, firstName = "Dee", lastName = "Leat", preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK, await register.Content.ReadAsStringAsync());
        return ((await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!, email, password);
    }

    [Fact]
    public async Task A_login_deletes_itself_with_its_password_and_can_no_longer_sign_in()
    {
        using var client = _fixture.CreateClient();
        var (token, email, password) = await RegisterAsync(client);

        var preview = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/delete-preview", token);
        preview.StatusCode.Should().Be(HttpStatusCode.OK);
        var shape = (await HttpApiFixture.ReadJsonAsync(preview)).RootElement;
        shape.GetProperty("ownsHousehold").GetBoolean().Should().BeTrue();
        shape.GetProperty("othersInHousehold").GetInt32().Should().Be(0);
        shape.GetProperty("hasPassword").GetBoolean().Should().BeTrue();

        // The email alone isn't enough for a login with a password, nor is a wrong password.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { confirmEmail = email }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { password = password + "x" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.OK);

        var deleted = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { password });
        deleted.StatusCode.Should().Be(HttpStatusCode.NoContent, await deleted.Content.ReadAsStringAsync());

        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var login = await client.PostAsJsonAsync("/api/auth/login", new { email, password }, HttpApiFixture.Json);
        login.IsSuccessStatusCode.Should().BeFalse();
    }

    [Fact]
    public async Task An_owner_is_refused_while_someone_else_has_access_to_the_budget()
    {
        using var client = _fixture.CreateClient();
        var (token, _, password) = await RegisterAsync(client);
        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", token, new
        {
            email = $"other-{Guid.NewGuid():N}"[..18] + "@delete.test", role = (int)HouseholdRole.Admin, method = 0,
            tempPassword = HttpApiFixture.StrongPassword(), displayName = "Other",
        });
        invite.StatusCode.Should().Be(HttpStatusCode.OK, await invite.Content.ReadAsStringAsync());

        var preview = (await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/delete-preview", token))).RootElement;
        preview.GetProperty("othersInHousehold").GetInt32().Should().Be(1);

        var refused = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { password });
        refused.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    /// <summary>Moves the login's sign-ins half an hour back, past the window in which signing in counts as proof.</summary>
    private async Task AgeSignInsAsync(string email)
    {
        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var userId = await db.Users.Where(u => u.Email == email).Select(u => u.Id).SingleAsync();
        await db.RefreshTokens.Where(t => t.UserId == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.SessionStartedUtc, t => t.SessionStartedUtc.AddMinutes(-30)));
    }

    private static async Task<(string Token, string Email, string Credential)> GoogleOnlyAsync(HttpClient client)
    {
        var email = $"delg-{Guid.NewGuid():N}"[..16] + "@delete.test";
        var credential = "fake-google:" + JsonSerializer.Serialize(new { sub = $"g-{Guid.NewGuid():N}", email, emailVerified = true });
        return (await GoogleSignInAsync(client, credential), email, credential);
    }

    private static async Task<string> GoogleSignInAsync(HttpClient client, string credential)
    {
        var signIn = await client.PostAsJsonAsync("/api/auth/google", new { credential }, HttpApiFixture.Json);
        signIn.StatusCode.Should().Be(HttpStatusCode.OK, await signIn.Content.ReadAsStringAsync());
        return (await HttpApiFixture.ReadJsonAsync(signIn)).RootElement.GetProperty("token").GetString()!;
    }

    [Fact]
    public async Task A_google_only_login_deletes_itself_with_its_email_just_after_signing_in()
    {
        using var client = _fixture.CreateClient();
        var (token, email, _) = await GoogleOnlyAsync(client);

        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { confirmEmail = "someone@else.test" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var deleted = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { confirmEmail = email });
        deleted.StatusCode.Should().Be(HttpStatusCode.NoContent, await deleted.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_google_only_login_signed_in_long_ago_is_asked_to_sign_in_again_before_deleting()
    {
        using var client = _fixture.CreateClient();
        var (token, email, credential) = await GoogleOnlyAsync(client);
        await AgeSignInsAsync(email);

        // Typing the email proves nothing: anyone holding the session can read it (audit A07-001).
        var refused = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { confirmEmail = email });
        refused.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var kinds = (await HttpApiFixture.ReadJsonAsync(refused)).RootElement.GetProperty("proof");
        kinds.GetProperty("password").GetBoolean().Should().BeFalse();
        kinds.GetProperty("passkey").GetBoolean().Should().BeFalse();
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.OK);

        // A password offered as proof is no use to a login without one.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token,
            new { confirmEmail = email, proof = new { password = "Anything-at-all-1" } })).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Signing in again makes the sign-in recent, and the delete goes through.
        var fresh = await GoogleSignInAsync(client, credential);
        var deleted = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", fresh, new { confirmEmail = email });
        deleted.StatusCode.Should().Be(HttpStatusCode.NoContent, await deleted.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_wrong_password_on_delete_or_change_counts_toward_lockout()
    {
        using var client = _fixture.CreateClient();
        var (token, email, password) = await RegisterAsync(client);

        // Five wrong passwords, mixed between the two places that re-check it (audit A07-002).
        for (var i = 0; i < 3; i++)
        {
            (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { password = password + "x" }))
                .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }
        for (var i = 0; i < 2; i++)
        {
            (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/change-password", token,
                new { currentPassword = password + "x", newPassword = HttpApiFixture.StrongPassword() }))
                .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        // Locked: even the right password is refused now, here and at sign-in.
        var locked = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { password });
        locked.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await locked.Content.ReadAsStringAsync()).Should().Contain("locked");
        var login = await client.PostAsJsonAsync("/api/auth/login", new { email, password }, HttpApiFixture.Json);
        login.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await login.Content.ReadAsStringAsync()).Should().Contain("locked");
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_right_password_on_change_resets_the_failed_count()
    {
        using var client = _fixture.CreateClient();
        var (token, email, password) = await RegisterAsync(client);
        for (var i = 0; i < 4; i++)
        {
            (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token, new { password = password + "x" }))
                .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        var newPassword = HttpApiFixture.StrongPassword();
        var changed = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/change-password", token,
            new { currentPassword = password, newPassword });
        changed.StatusCode.Should().Be(HttpStatusCode.OK, await changed.Content.ReadAsStringAsync());

        // The count started again: one more wrong sign-in does not lock the login.
        (await client.PostAsJsonAsync("/api/auth/login", new { email, password = "Wrong-password-1" }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await client.PostAsJsonAsync("/api/auth/login", new { email, password = newPassword }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
