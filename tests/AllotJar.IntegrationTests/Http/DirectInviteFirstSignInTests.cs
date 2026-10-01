using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// S-P2-3 (end-to-end check, 30 Sep 2026) and review P2-1 of #298, "Email first": P59 keeps a
/// private account to the one login that made it private, but an invite used to let whoever sent
/// it know the password that login ends up with. A direct-invite login now chooses its own password
/// only through a link emailed to its address, and can do nothing else until then; an invite link
/// travels only by email. Choosing the password ends every session opened with the temporary one.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class DirectInviteFirstSignInTests
{
    private readonly HttpApiFixture _fixture;

    public DirectInviteFirstSignInTests(HttpApiFixture fixture) => _fixture = fixture;

    private string OwnerToken => _fixture.TokenFor(HouseholdRole.Owner);

    private async Task<Guid> AddPersonAsync(HttpClient client, string name)
    {
        var person = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/members", OwnerToken,
            new { name, netMonthlyIncome = 1000m, personalSavingsAccountId = (Guid?)null });
        person.StatusCode.Should().Be(HttpStatusCode.Created, await person.Content.ReadAsStringAsync());
        return (await HttpApiFixture.ReadJsonAsync(person)).RootElement.GetProperty("id").GetGuid();
    }

    private async Task<(string Email, string TempPassword, Guid Person)> DirectInviteAsync(HttpClient client)
    {
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"sam-{run}@firstsignin.test";
        var tempPassword = HttpApiFixture.StrongPassword();
        var personId = await AddPersonAsync(client, $"Sam {run}");

        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", OwnerToken,
            new { email, role = (int)HouseholdRole.Admin, method = 0, tempPassword, displayName = "Sam", memberId = personId });
        invite.StatusCode.Should().Be(HttpStatusCode.OK, await invite.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(invite)).RootElement.GetProperty("emailSent").GetBoolean()
            .Should().BeTrue("the Development mailbox accepted the set-password email");
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
    public async Task A_direct_invite_login_can_do_nothing_until_its_holder_chooses_a_password_from_the_emailed_link()
    {
        using var client = _fixture.CreateClient();
        var (email, tempPassword, _) = await DirectInviteAsync(client);
        var samToken = await TokenAsync(await LoginAsync(client, email, tempPassword));

        (await MustChangePasswordAsync(client, samToken)).Should().BeTrue("/auth/me tells the app to ask for the emailed link");

        var accounts = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", samToken);
        accounts.StatusCode.Should().Be(HttpStatusCode.Forbidden, "nothing else answers until the password is the login's own");
        (await HttpApiFixture.ReadJsonAsync(accounts)).RootElement.GetProperty("code").GetString()
            .Should().Be("password_change_required");
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", samToken,
                new { name = "Sam private", type = 0, currency = "EUR", openingBalance = 10m, openingDate = "2026-01-01" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Review P3-1: whoever holds the temporary password can't accept the terms for the holder.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/consent", samToken))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Knowing the temporary password is not enough to choose the next one.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/change-password", samToken,
                new { currentPassword = tempPassword, newPassword = HttpApiFixture.StrongPassword() }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // The invite emailed the invited address a link to choose a password.
        var link = await _fixture.WaitForEmailLinkAsync(email, "/reset-password?");
        var newToken = await TokenAsync(await HttpApiFixture.ResetFromLinkAsync(client, link, HttpApiFixture.StrongPassword()));

        (await MustChangePasswordAsync(client, newToken)).Should().BeFalse();
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", newToken))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/consent", newToken))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    /// <summary>
    /// The review's probes, inverted: the owner signing in as Sam first and choosing Sam's password
    /// for them (P2-1), or simply reusing the temporary one, never reaches Sam's private account.
    /// </summary>
    [Fact]
    public async Task The_owner_who_set_the_temporary_password_cannot_choose_the_members_password_or_read_their_private_account()
    {
        using var client = _fixture.CreateClient();
        var (email, tempPassword, person) = await DirectInviteAsync(client);

        // The owner signs in as Sam with the password they chose, before Sam ever does, and tries
        // to pick the password they would then hand to Sam.
        var ownerAsSam = await TokenAsync(await LoginAsync(client, email, tempPassword));
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/change-password", ownerAsSam,
                new { currentPassword = tempPassword, newPassword = HttpApiFixture.StrongPassword() }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await MustChangePasswordAsync(client, ownerAsSam)).Should().BeTrue("Sam will still be asked");
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", ownerAsSam))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Sam chooses a password from the email and adds a personal account (private by default, P54).
        var link = await _fixture.WaitForEmailLinkAsync(email, "/reset-password?");
        var samToken = await TokenAsync(await HttpApiFixture.ResetFromLinkAsync(client, link, HttpApiFixture.StrongPassword()));
        var created = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", samToken,
            new { name = "Sam private", type = 0, currency = "EUR", openingBalance = 10m, openingDate = "2026-01-01", holderIds = new[] { person } });
        created.StatusCode.Should().Be(HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var samAccount = (await HttpApiFixture.ReadJsonAsync(created)).RootElement.GetProperty("id").GetGuid();

        // The owner's session as Sam ended with the reset, and the temporary password is dead.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", ownerAsSam))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await LoginAsync(client, email, tempPassword)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var ownerView = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", OwnerToken);
        (await ownerView.Content.ReadAsStringAsync()).Should().NotContain(samAccount.ToString(), "P53");
        var samView = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", samToken);
        (await samView.Content.ReadAsStringAsync()).Should().Contain(samAccount.ToString());
    }

    [Fact]
    public async Task An_invite_link_is_emailed_to_the_invited_address_and_never_returned_to_the_inviter()
    {
        using var client = _fixture.CreateClient();
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"robin-{run}@firstsignin.test";

        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", OwnerToken,
            new { email, role = (int)HouseholdRole.Limited, method = 1, tempPassword = (string?)null, displayName = "Robin", memberId = (Guid?)null });
        invite.StatusCode.Should().Be(HttpStatusCode.OK, await invite.Content.ReadAsStringAsync());
        var body = await invite.Content.ReadAsStringAsync();
        body.Should().NotContainAny("inviteToken", "accept-invite");

        var link = await _fixture.WaitForEmailLinkAsync(email, "/accept-invite?code=");
        var code = Uri.UnescapeDataString(link[(link.IndexOf("code=", StringComparison.Ordinal) + 5)..]);
        var accepted = await client.PostAsJsonAsync("/api/auth/accept-invite",
            new { token = code, password = HttpApiFixture.StrongPassword(), displayName = "Robin", acceptedTerms = true }, HttpApiFixture.Json);
        var robinToken = await TokenAsync(accepted);
        (await MustChangePasswordAsync(client, robinToken)).Should().BeFalse("the password came from the mailbox's owner");
    }

    [Fact]
    public async Task A_login_that_chose_its_own_password_is_never_asked()
    {
        using var client = _fixture.CreateClient();
        (await MustChangePasswordAsync(client, OwnerToken)).Should().BeFalse("a registered login set its own password");
    }

    /// <summary>A provider that rejects every send, like an unverified sending domain or a timeout.</summary>
    private sealed class RejectingEmailSender : IEmailSender
    {
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) =>
            throw new HttpRequestException("The provider rejected the send.");
    }

    [Fact]
    public async Task When_the_provider_rejects_the_email_the_invite_says_so_and_the_login_can_ask_again()
    {
        using var client = _fixture.CreateClient(b =>
            b.ConfigureTestServices(s => s.AddSingleton<IEmailSender, RejectingEmailSender>()));
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"lost-{run}@firstsignin.test";
        var tempPassword = HttpApiFixture.StrongPassword();
        var personId = await AddPersonAsync(client, $"Lost {run}");

        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", OwnerToken,
            new { email, role = (int)HouseholdRole.Admin, method = 0, tempPassword, displayName = "Lost", memberId = personId });
        invite.StatusCode.Should().Be(HttpStatusCode.OK, await invite.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(invite)).RootElement.GetProperty("emailSent").GetBoolean()
            .Should().BeFalse("the owner must not be told a link was emailed when the provider refused it");

        var lostToken = await TokenAsync(await LoginAsync(client, email, tempPassword));
        var again = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/password-link", lostToken);
        again.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, "the prompt must not claim a new link was sent");

        // Once email works again, the same login gets its link from the same endpoint.
        var linkAgain = await HttpApiFixture.SendAsync(_fixture.CreateClient(), HttpMethod.Post, "/api/auth/password-link", lostToken);
        linkAgain.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await _fixture.WaitForEmailLinkAsync(email, "/reset-password?")).Should().Contain("/reset-password?");
    }

    [Fact]
    public async Task Outside_development_an_invite_is_refused_while_email_only_goes_to_the_log()
    {
        // Staging with no provider configured resolves the logging fallback: nothing is delivered.
        using var client = _fixture.CreateClient(b => b.UseEnvironment("Staging"));
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"nomail-{run}@firstsignin.test";

        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", OwnerToken,
            new { email, role = (int)HouseholdRole.Admin, method = 1, tempPassword = (string?)null, displayName = "No mail", memberId = (Guid?)null });

        invite.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await HttpApiFixture.ReadJsonAsync(invite)).RootElement.GetProperty("error").GetString()
            .Should().Contain("Email isn't set up on this server");

        var members = await HttpApiFixture.SendAsync(_fixture.CreateClient(), HttpMethod.Get, "/api/access/members", OwnerToken);
        (await members.Content.ReadAsStringAsync()).Should().NotContain(email, "nothing was created");
    }
}
