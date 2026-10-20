using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// "Delete my account" (compliance fix 5) over real HTTP: the preview, the typed email that guards
/// it, and a deleted login that can neither use its old token nor sign in again.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class DeleteAccountHttpTests
{
    private readonly HttpApiFixture _fixture;

    public DeleteAccountHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task A_login_deletes_itself_after_typing_its_email_and_can_no_longer_sign_in()
    {
        using var client = _fixture.CreateClient();
        var email = $"del-{Guid.NewGuid():N}"[..16] + "@delete.test";
        var password = HttpApiFixture.StrongPassword();
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email, password, firstName = "Dee", lastName = "Leat", preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK, await register.Content.ReadAsStringAsync());
        var token = (await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;

        var preview = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/delete-preview", token);
        preview.StatusCode.Should().Be(HttpStatusCode.OK);
        var shape = (await HttpApiFixture.ReadJsonAsync(preview)).RootElement;
        shape.GetProperty("ownsHousehold").GetBoolean().Should().BeTrue();
        shape.GetProperty("othersInHousehold").GetInt32().Should().Be(0);

        var wrong = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token,
            new { confirmEmail = "someone@else.test" });
        wrong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.OK);

        var deleted = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/delete-account", token,
            new { confirmEmail = $"  {email.ToUpperInvariant()} " });
        deleted.StatusCode.Should().Be(HttpStatusCode.NoContent, await deleted.Content.ReadAsStringAsync());

        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var login = await client.PostAsJsonAsync("/api/auth/login", new { email, password }, HttpApiFixture.Json);
        login.IsSuccessStatusCode.Should().BeFalse();
    }
}
