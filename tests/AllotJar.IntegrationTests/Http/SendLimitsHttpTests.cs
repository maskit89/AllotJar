using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Api.Controllers;
using AllotJar.Api.Services;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Email;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The limits on emails AllotJar sends for someone (audit A06-001, security review #6): invites
/// need the inviter's own confirmed email and stop at a daily allowance per household, the
/// inviter's name can't carry a link, and password links stop after a few per login.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class SendLimitsHttpTests
{
    private readonly HttpApiFixture _fixture;

    public SendLimitsHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    private static async Task<(string Token, string Email)> RegisterAsync(HttpClient client, string firstName = "Lim")
    {
        var email = $"lim-{Guid.NewGuid():N}"[..16] + "@limits.test";
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email, password = HttpApiFixture.StrongPassword(), firstName, lastName = "Its",
            preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK, await register.Content.ReadAsStringAsync());
        return ((await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!, email);
    }

    private static Task<HttpResponseMessage> LinkInviteAsync(HttpClient client, string token, string email) =>
        HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/access/invite", token, new
        {
            email, role = (int)HouseholdRole.Admin, method = 1, tempPassword = (string?)null,
            displayName = "Guest", memberId = (Guid?)null,
        });

    private static string NewAddress() => $"to-{Guid.NewGuid():N}"[..15] + "@limits.test";

    [Fact]
    public async Task An_owner_whose_email_is_not_confirmed_cannot_invite()
    {
        using var client = _fixture.CreateClient();
        var (token, email) = await RegisterAsync(client);
        var to = NewAddress();

        var refused = await LinkInviteAsync(client, token, to);
        refused.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await refused.Content.ReadAsStringAsync()).Should().Contain("Confirm your own email");
        _fixture.Services.GetRequiredService<DevEmailSink>().ForRecipient(to).Should().BeEmpty();

        await _fixture.ConfirmEmailAsync(email);
        (await LinkInviteAsync(client, token, to)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_household_stops_at_its_daily_invite_emails_and_send_again_counts_too()
    {
        // A host with the allowance at 2 (the shared fixture lifts it for the rest of the suite).
        using var client = _fixture.CreateClient(b => b.UseSetting("Limits:InviteEmailsPerDay", "2"));
        var (token, email) = await RegisterAsync(client);
        await _fixture.ConfirmEmailAsync(email);

        var first = await LinkInviteAsync(client, token, NewAddress());
        first.StatusCode.Should().Be(HttpStatusCode.OK, await first.Content.ReadAsStringAsync());
        (await LinkInviteAsync(client, token, NewAddress())).StatusCode.Should().Be(HttpStatusCode.OK);

        var third = await LinkInviteAsync(client, token, NewAddress());
        third.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        (await third.Content.ReadAsStringAsync()).Should().Contain("most invite emails allowed for today");

        var membershipId = (await HttpApiFixture.ReadJsonAsync(first)).RootElement
            .GetProperty("membership").GetProperty("id").GetGuid();
        var resend = await HttpApiFixture.SendAsync(client, HttpMethod.Post, $"/api/access/members/{membershipId}/resend", token);
        resend.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        (await resend.Content.ReadAsStringAsync()).Should().Contain("most invite emails allowed for today");
    }

    [Fact]
    public async Task The_invite_email_never_carries_a_link_in_the_inviters_name()
    {
        using var client = _fixture.CreateClient();
        var (token, email) = await RegisterAsync(client);
        await _fixture.ConfirmEmailAsync(email);
        var renamed = await HttpApiFixture.SendAsync(client, HttpMethod.Put, "/api/auth/preferences", token,
            new { firstName = "Your bank: verify at evil.example", lastName = "today", preferredCurrency = "EUR", numberFormat = (string?)null });
        renamed.StatusCode.Should().Be(HttpStatusCode.OK, await renamed.Content.ReadAsStringAsync());

        var to = NewAddress();
        (await LinkInviteAsync(client, token, to)).StatusCode.Should().Be(HttpStatusCode.OK);

        var sent = _fixture.Services.GetRequiredService<DevEmailSink>().ForRecipient(to).Should().ContainSingle().Subject;
        sent.TextBody.Should().StartWith("Someone invited you");
        sent.TextBody.Should().NotContain("evil.example");
        sent.HtmlBody.Should().NotContain("evil.example");
    }

    [Theory]
    [InlineData("Ada Lovelace", "Ada Lovelace")]
    [InlineData("J. R. Hartley", "J. R. Hartley")]
    [InlineData("Visit www.example", "Someone")]
    [InlineData("go to http://x", "Someone")]
    [InlineData("example.com refunds", "Someone")]
    [InlineData("pay@example", "Someone")]
    [InlineData("a/b", "Someone")]
    [InlineData("evil\uFF0Ecom", "Someone")] // a full-width dot normalises to "."
    [InlineData("evil . com", "Someone")]
    [InlineData("evil[.]com", "Someone")]
    [InlineData("evil dot com", "Someone")]
    [InlineData("Call 0800 123 456", "Someone")]
    [InlineData("Zo\u00EB O\u2019Brien-Smith", "Zo\u00EB O\u2019Brien-Smith")]
    [InlineData("Ren\u00E9e", "Ren\u00E9e")]
    [InlineData("J.R. Smith", "J.R. Smith")]
    [InlineData("Dot Cotton", "Dot Cotton")]
    [InlineData("Gal\u00B7la", "Gal\u00B7la")]
    [InlineData("\u30B8\u30E7\u30F3\u30FB\u30B9\u30DF\u30B9", "\u30B8\u30E7\u30F3\u30FB\u30B9\u30DF\u30B9")]
    [InlineData("\u0645\u06CC\u200C\u0631\u0648\u0645", "\u0645\u06CC\u200C\u0631\u0648\u0645")]
    [InlineData("evil.Com", "Someone")]
    [InlineData("Bartholomew Montgomery-Fitzwilliam Smythe the Third", "Bartholomew Montgomery-Fitzwilliam Smyth…")]
    public void The_inviters_name_is_cut_short_and_dropped_when_it_looks_like_a_link(string displayName, string expected)
    {
        var me = new AllotJar.Infrastructure.Identity.ApplicationUser { DisplayName = displayName, Email = "owner@limits.test" };
        HouseholdAccessController.InviterName(me).Should().Be(expected);
    }

    [Fact]
    public void A_long_name_is_never_cut_through_a_character()
    {
        // 39 letters, then a q with a combining acute (no precomposed form) across positions 39 and 40.
        var name = new string('a', 39) + "q\u0301 tail";
        var me = new AllotJar.Infrastructure.Identity.ApplicationUser { DisplayName = name, Email = "owner@limits.test" };
        HouseholdAccessController.InviterName(me).Should().Be(new string('a', 39) + "\u2026");
    }

    [Fact]
    public void Without_a_display_name_the_inviter_is_named_by_their_own_email()
    {
        var me = new AllotJar.Infrastructure.Identity.ApplicationUser { DisplayName = null, Email = "owner@limits.test" };
        HouseholdAccessController.InviterName(me).Should().Be("owner@limits.test");
    }

    [Fact]
    public async Task Password_links_stop_after_three_to_one_login_in_fifteen_minutes()
    {
        using var client = _fixture.CreateClient();
        var (token, email) = await RegisterAsync(client);

        for (var i = 0; i < 3; i++)
        {
            (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/password-link", token))
                .StatusCode.Should().Be(HttpStatusCode.NoContent);
        }
        var fourth = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/password-link", token);
        fourth.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        (await fourth.Content.ReadAsStringAsync()).Should().Contain(PasswordLinkAllowance.Refused);

        // Forgot-password answers as always (it never reveals anything) but sends nothing more.
        (await client.PostAsJsonAsync("/api/auth/forgot-password", new { email }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        await Task.Delay(500); // the forgot-password send runs off the request path
        _fixture.Services.GetRequiredService<DevEmailSink>().ForRecipient(email)
            .Count(m => m.TextBody.Contains("/reset-password?")).Should().Be(3);
    }
}
