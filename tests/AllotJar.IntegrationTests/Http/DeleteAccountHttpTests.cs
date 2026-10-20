using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using AllotJar.Domain.Enums;

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
}
