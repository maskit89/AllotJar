using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Email;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The people and sign-in follow-ups (1 October 2026, D4, D6, D7) over real HTTP: leaving a
/// household warns about the private accounts left behind, the household switcher never shows the
/// owner's email, and "Send again" re-sends a pending invite or a login's password link, spaced out.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class PeopleFollowUpsHttpTests
{
    private readonly HttpApiFixture _fixture;

    public PeopleFollowUpsHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    private string OwnerToken => _fixture.TokenFor(HouseholdRole.Owner);

    /// <summary>A new household whose owner then cleared their name, so it has no display name.</summary>
    private static async Task<(string Token, string UserId, string Email)> RegisterNamelessOwnerAsync(HttpClient client)
    {
        var email = $"nameless-{Guid.NewGuid():N}"[..20] + "@followups.test";
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email,
            password = HttpApiFixture.StrongPassword(),
            firstName = "Olive",
            lastName = "Owner",
            preferredCurrency = "EUR",
            numberFormat = (string?)null,
            acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK, await register.Content.ReadAsStringAsync());
        var body = (await HttpApiFixture.ReadJsonAsync(register)).RootElement;
        var token = body.GetProperty("token").GetString()!;
        var cleared = await HttpApiFixture.SendAsync(client, HttpMethod.Put, "/api/auth/preferences", token,
            new { firstName = "", lastName = "", preferredCurrency = "", numberFormat = "" });
        cleared.StatusCode.Should().Be(HttpStatusCode.OK, await cleared.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(cleared)).RootElement.GetProperty("displayName").ValueKind
            .Should().Be(System.Text.Json.JsonValueKind.Null);
        return (token, body.GetProperty("userId").GetString()!, email);
    }

    private async Task<(string Token, Guid MembershipId, Guid PersonId, string Email)> DirectInviteAsync(
        HttpClient client, string ownerToken, bool choosePassword = true)
    {
        var run = Guid.NewGuid().ToString("N")[..8];
        var email = $"sam-{run}@followups.test";
        var person = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/members", ownerToken,
            new { name = $"Sam {run}", netMonthlyIncome = 1000m, personalSavingsAccountId = (Guid?)null });
        person.StatusCode.Should().Be(HttpStatusCode.Created, await person.Content.ReadAsStringAsync());
        var personId = (await HttpApiFixture.ReadJsonAsync(person)).RootElement.GetProperty("id").GetGuid();

        var tempPassword = HttpApiFixture.StrongPassword();
        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", ownerToken,
            new { email, role = (int)HouseholdRole.Admin, method = 0, tempPassword, displayName = "Sam", memberId = personId });
        invite.StatusCode.Should().Be(HttpStatusCode.OK, await invite.Content.ReadAsStringAsync());
        var membershipId = (await HttpApiFixture.ReadJsonAsync(invite)).RootElement
            .GetProperty("membership").GetProperty("id").GetGuid();
        if (!choosePassword)
        {
            return (string.Empty, membershipId, personId, email);
        }

        var link = await _fixture.WaitForEmailLinkAsync(email, "/reset-password?");
        var reset = await HttpApiFixture.ResetFromLinkAsync(client, link, HttpApiFixture.StrongPassword());
        reset.StatusCode.Should().Be(HttpStatusCode.OK, await reset.Content.ReadAsStringAsync());
        var token = (await HttpApiFixture.ReadJsonAsync(reset)).RootElement.GetProperty("token").GetString()!;
        return (token, membershipId, personId, email);
    }

    private IReadOnlyList<string> LinksTo(string email, string pathMarker) =>
        _fixture.Services.GetRequiredService<DevEmailSink>().ForRecipient(email)
            .SelectMany(m => m.TextBody.Split('\n'))
            .Select(l => l.Trim())
            .Where(l => l.StartsWith("http") && l.Contains(pathMarker))
            .Distinct()
            .ToList();

    private async Task<IReadOnlyList<string>> WaitForLinksAsync(string email, string pathMarker, int count)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var links = LinksTo(email, pathMarker);
            if (links.Count >= count)
            {
                return links;
            }
            await Task.Delay(50);
        }
        throw new InvalidOperationException($"Fewer than {count} emails to {email} with a {pathMarker} link.");
    }

    [Fact]
    public async Task A_member_leaving_with_private_accounts_is_told_how_many_and_leaves_only_once_confirmed_D4_and_the_switcher_never_shows_the_owners_email_D6()
    {
        using var client = _fixture.CreateClient();
        var (ownerToken, ownerId, ownerEmail) = await RegisterNamelessOwnerAsync(client);
        var (samToken, _, personId, _) = await DirectInviteAsync(client, ownerToken);

        // D6: the owner has no name, so the household reads "Household", never their address.
        var me = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/me", samToken);
        var meBody = await me.Content.ReadAsStringAsync();
        meBody.Should().NotContain(ownerEmail);
        var household = (await HttpApiFixture.ReadJsonAsync(me)).RootElement.GetProperty("households").EnumerateArray()
            .Single(h => h.GetProperty("ownerId").GetString() == ownerId);
        household.GetProperty("label").GetString().Should().Be("Household");

        // Nothing private yet: nothing to warn about.
        var preview = await HttpApiFixture.SendAsync(client, HttpMethod.Get, $"/api/households/leave-preview?ownerId={ownerId}", samToken);
        preview.StatusCode.Should().Be(HttpStatusCode.OK);
        (await HttpApiFixture.ReadJsonAsync(preview)).RootElement.GetProperty("privateAccounts").GetInt32().Should().Be(0);

        // Sam adds his own account (private by default, P54).
        var account = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", samToken,
            new { name = "Sam's own", type = 0, currency = "EUR", openingBalance = 5m, openingDate = "2026-01-01", holderIds = new[] { personId } });
        account.StatusCode.Should().Be(HttpStatusCode.Created, await account.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(account)).RootElement.GetProperty("isPrivate").GetBoolean().Should().BeTrue();

        preview = await HttpApiFixture.SendAsync(client, HttpMethod.Get, $"/api/households/leave-preview?ownerId={ownerId}", samToken);
        (await HttpApiFixture.ReadJsonAsync(preview)).RootElement.GetProperty("privateAccounts").GetInt32().Should().Be(1);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Get, $"/api/households/leave-preview?ownerId={ownerId}", OwnerToken))
            .StatusCode.Should().Be(HttpStatusCode.NotFound, "only a member of that household may ask");

        // Leaving without having been told is refused with the count.
        var unwarned = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/households/leave", samToken, new { ownerId });
        unwarned.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var refusal = (await HttpApiFixture.ReadJsonAsync(unwarned)).RootElement;
        refusal.GetProperty("privateAccounts").GetInt32().Should().Be(1);
        refusal.GetProperty("error").GetString().Should().Contain("1 private account").And.Contain("erase");

        var confirmed = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/households/leave", samToken,
            new { ownerId, privateAccounts = 1 });
        confirmed.StatusCode.Should().Be(HttpStatusCode.NoContent, await confirmed.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Send_again_emails_a_pending_invite_a_new_link_that_replaces_the_old_one_and_is_spaced_out_D7()
    {
        using var client = _fixture.CreateClient();
        var email = $"robin-{Guid.NewGuid():N}"[..14] + "@followups.test";
        var invite = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", OwnerToken,
            new { email, role = (int)HouseholdRole.Limited, method = 1, tempPassword = (string?)null, displayName = "Robin", memberId = (Guid?)null });
        invite.StatusCode.Should().Be(HttpStatusCode.OK, await invite.Content.ReadAsStringAsync());
        var membershipId = (await HttpApiFixture.ReadJsonAsync(invite)).RootElement
            .GetProperty("membership").GetProperty("id").GetGuid();
        var first = (await WaitForLinksAsync(email, "/accept-invite?code=", 1))[0];

        // Only the owner may send it again.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/members/{membershipId}/resend", _fixture.TokenFor(HouseholdRole.Admin)))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var again = await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/members/{membershipId}/resend", OwnerToken);
        again.StatusCode.Should().Be(HttpStatusCode.OK, await again.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(again)).RootElement.GetProperty("emailSent").GetBoolean().Should().BeTrue();
        (await again.Content.ReadAsStringAsync()).Should().NotContainAny("code", "token", "accept-invite");
        var second = (await WaitForLinksAsync(email, "/accept-invite?code=", 2)).Single(l => l != first);

        // A second press within the minute sends nothing.
        var tooSoon = await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/members/{membershipId}/resend", OwnerToken);
        tooSoon.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        await Task.Delay(200);
        LinksTo(email, "/accept-invite?code=").Should().HaveCount(2);

        static string Code(string link) => Uri.UnescapeDataString(link[(link.IndexOf("code=", StringComparison.Ordinal) + 5)..]);
        var withOld = await client.PostAsJsonAsync("/api/auth/accept-invite",
            new { token = Code(first), password = HttpApiFixture.StrongPassword(), displayName = "Robin", acceptedTerms = true }, HttpApiFixture.Json);
        withOld.StatusCode.Should().Be(HttpStatusCode.NotFound, "the earlier link stops working");
        var withNew = await client.PostAsJsonAsync("/api/auth/accept-invite",
            new { token = Code(second), password = HttpApiFixture.StrongPassword(), displayName = "Robin", acceptedTerms = true }, HttpApiFixture.Json);
        withNew.StatusCode.Should().Be(HttpStatusCode.OK, await withNew.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Send_again_emails_a_login_still_waiting_to_choose_its_password_its_link_again_D7()
    {
        using var client = _fixture.CreateClient();
        var (_, membershipId, _, email) = await DirectInviteAsync(client, OwnerToken, choosePassword: false);
        await WaitForLinksAsync(email, "/reset-password?", 1);

        var list = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/access/members", OwnerToken);
        (await HttpApiFixture.ReadJsonAsync(list)).RootElement.EnumerateArray()
            .Single(m => m.GetProperty("id").GetGuid() == membershipId)
            .GetProperty("awaitingPassword").GetBoolean().Should().BeTrue();

        var again = await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/members/{membershipId}/resend", OwnerToken);
        again.StatusCode.Should().Be(HttpStatusCode.OK, await again.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(again)).RootElement.GetProperty("emailSent").GetBoolean().Should().BeTrue();
        await WaitForLinksAsync(email, "/reset-password?", 2);
    }

    /// <summary>
    /// D5 over HTTP (PR #307 review round 1, P2-1): the owner unlinks Sam's login and links its own
    /// login to Sam; making an account of Sam's private is refused while Sam's login is in the household,
    /// "This isn't me" only releases the caller's own link, and once Sam's login leaves it no longer blocks.
    /// </summary>
    [Fact]
    public async Task Relinking_Sam_to_the_owner_never_lets_the_owner_make_Sams_account_private_until_Sams_login_leaves_D5()
    {
        using var client = _fixture.CreateClient();
        var (ownerToken, ownerId, _) = await RegisterNamelessOwnerAsync(client);
        var (samToken, samMembership, personId, _) = await DirectInviteAsync(client, ownerToken);

        var list = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/access/members", ownerToken);
        var own = (await HttpApiFixture.ReadJsonAsync(list)).RootElement.EnumerateArray()
            .Single(m => m.GetProperty("isSelf").GetBoolean()).GetProperty("id").GetGuid();
        (await HttpApiFixture.SendAsync(client, HttpMethod.Put, $"/api/access/members/{samMembership}/link", ownerToken, new { memberId = (Guid?)null }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Put, $"/api/access/members/{own}/link", ownerToken, new { memberId = personId }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        object PrivateAccount() => new { name = $"Hidden {Guid.NewGuid():N}"[..14], type = 0, currency = "EUR", openingBalance = 0m, openingDate = "2026-01-01", holderIds = new[] { personId }, isPrivate = true };
        var refused = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", ownerToken, PrivateAccount());
        refused.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await refused.Content.ReadAsStringAsync()).Should().Contain("own login can make their account private");

        // The owner can't release a link while linked, and never anyone else's.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/people/{personId}/not-me", ownerToken))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/people/{Guid.NewGuid()}/not-me", ownerToken))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        var left = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/households/leave", samToken, new { ownerId });
        left.StatusCode.Should().Be(HttpStatusCode.NoContent, await left.Content.ReadAsStringAsync());
        // Sam, now back in their own household, can't reach the person they left.
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/people/{personId}/not-me", samToken))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        var allowed = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", ownerToken, PrivateAccount());
        allowed.StatusCode.Should().Be(HttpStatusCode.Created, await allowed.Content.ReadAsStringAsync());
    }
}
