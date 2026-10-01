using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using AllotJar.Domain.Enums;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// S-P2-3 (end-to-end check, 30 Sep 2026): P59 keeps a private account to the one login that made
/// it private, but a direct invite gives the owner that login's password. A login created that way
/// now has to choose its own password before the API answers anything else, and choosing it ends
/// every session opened with the temporary one, the owner's included.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class DirectInviteFirstSignInTests
{
    private readonly HttpApiFixture _fixture;

    public DirectInviteFirstSignInTests(HttpApiFixture fixture) => _fixture = fixture;

    private string OwnerToken => _fixture.TokenFor(HouseholdRole.Owner);

    private async Task<(string Email, string TempPassword, Guid Person)> DirectInviteAsync(HttpClient client)
    {
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"sam-{run}@firstsignin.test";
        var tempPassword = HttpApiFixture.StrongPassword();

        var person = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/members", OwnerToken,
            new { name = $"Sam {run}", netMonthlyIncome = 1000m, personalSavingsAccountId = (Guid?)null });
        person.StatusCode.Should().Be(HttpStatusCode.Created, await person.Content.ReadAsStringAsync());
        var personId = (await HttpApiFixture.ReadJsonAsync(person)).RootElement.GetProperty("id").GetGuid();

        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", OwnerToken,
            new { email, role = (int)HouseholdRole.Admin, method = 0, tempPassword, displayName = "Sam", memberId = personId });
        invite.StatusCode.Should().Be(HttpStatusCode.OK, await invite.Content.ReadAsStringAsync());
        return (email, tempPassword, personId);
    }

    private static async Task<HttpResponseMessage> LoginAsync(HttpClient client, string email, string password) =>
        await client.PostAsJsonAsync("/api/auth/login", new { email, password }, HttpApiFixture.Json);

    private static async Task<string> TokenAsync(HttpResponseMessage response)
    {
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        return (await HttpApiFixture.ReadJsonAsync(response)).RootElement.GetProperty("token").GetString()!;
    }

    private static async Task<bool> MustChangePasswordAsync(HttpClient client, string token)
    {
        var me = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", token);
        me.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await HttpApiFixture.ReadJsonAsync(me)).RootElement.GetProperty("mustChangePassword").GetBoolean();
    }

    [Fact]
    public async Task A_direct_invite_login_can_do_nothing_but_choose_its_own_password_first()
    {
        using var client = _fixture.CreateClient();
        var (email, tempPassword, _) = await DirectInviteAsync(client);
        var samToken = await TokenAsync(await LoginAsync(client, email, tempPassword));

        (await MustChangePasswordAsync(client, samToken)).Should().BeTrue("/auth/me tells the app to ask for a new password");

        var accounts = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", samToken);
        accounts.StatusCode.Should().Be(HttpStatusCode.Forbidden, "nothing else answers until the password is the login's own");
        (await HttpApiFixture.ReadJsonAsync(accounts)).RootElement.GetProperty("code").GetString()
            .Should().Be("password_change_required");
        var create = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", samToken,
            new { name = "Sam private", type = 0, currency = "EUR", openingBalance = 10m, openingDate = "2026-01-01" });
        create.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Agreeing to the terms is allowed, so the two first-sign-in prompts can come in either order.
        var consent = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/consent", samToken);
        consent.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // The temporary password itself is not a new password.
        var same = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/change-password", samToken,
            new { currentPassword = tempPassword, newPassword = tempPassword });
        same.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await MustChangePasswordAsync(client, samToken)).Should().BeTrue();

        var changed = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/change-password", samToken,
            new { currentPassword = tempPassword, newPassword = HttpApiFixture.StrongPassword() });
        var newToken = await TokenAsync(changed);

        (await MustChangePasswordAsync(client, newToken)).Should().BeFalse();
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", newToken))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    /// <summary>The review's probe, inverted: it showed the owner reading the invitee's private account.</summary>
    [Fact]
    public async Task The_owner_who_set_the_temporary_password_cannot_read_the_members_private_account()
    {
        using var client = _fixture.CreateClient();
        var (email, tempPassword, person) = await DirectInviteAsync(client);

        // The owner signs in as Sam with the password they chose, before Sam ever does.
        var ownerAsSam = await TokenAsync(await LoginAsync(client, email, tempPassword));
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", ownerAsSam))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden, "that session can read nothing while the password is the owner's");

        // Sam signs in, chooses a password and adds a personal account (private by default, P54).
        var samFirst = await TokenAsync(await LoginAsync(client, email, tempPassword));
        var newPassword = HttpApiFixture.StrongPassword();
        var samToken = await TokenAsync(await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/change-password", samFirst,
            new { currentPassword = tempPassword, newPassword }));
        var created = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", samToken,
            new { name = "Sam private", type = 0, currency = "EUR", openingBalance = 10m, openingDate = "2026-01-01", holderIds = new[] { person } });
        created.StatusCode.Should().Be(HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var samAccount = (await HttpApiFixture.ReadJsonAsync(created)).RootElement.GetProperty("id").GetGuid();

        // The owner's session as Sam ended with the change, and the temporary password is dead.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", ownerAsSam))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await LoginAsync(client, email, tempPassword)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // And the owner's own login doesn't see it (P53).
        var ownerView = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", OwnerToken);
        (await ownerView.Content.ReadAsStringAsync()).Should().NotContain(samAccount.ToString());
        var samView = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", samToken);
        (await samView.Content.ReadAsStringAsync()).Should().Contain(samAccount.ToString());
    }

    [Fact]
    public async Task A_login_that_chose_its_own_password_is_never_asked()
    {
        using var client = _fixture.CreateClient();
        var token = _fixture.TokenFor(HouseholdRole.Owner);
        (await MustChangePasswordAsync(client, token)).Should().BeFalse("a registered login set its own password");
    }
}
