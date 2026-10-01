using FluentAssertions;
using AllotJar.Infrastructure.Email;
using Xunit;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// The invite email carries the inviter's own display name, which any registered login chooses
/// freely, to any address the inviter types (#298 review R2-P2-2).
/// </summary>
public class InvitationEmailsTests
{
    private const string Payload = "</div><a href=\"https://evil.example/login\">Confirm your bank details</a><div>";

    [Fact]
    public void The_inviter_name_is_html_encoded_everywhere_in_the_invite_email()
    {
        var message = InvitationEmails.InviteLink("victim@example.com", Payload, "https://allotjar.com/accept-invite?code=abc");

        message.HtmlBody.Should().NotContain("<a href=\"https://evil.example/login\">");
        message.HtmlBody.Should().NotContain("</div><a");
        message.HtmlBody.Should().Contain("&lt;/div&gt;&lt;a href=");
    }

    [Fact]
    public void Each_link_sits_alone_on_its_own_line_of_the_text_body()
    {
        var invite = InvitationEmails.InviteLink("sam@example.com", "Alex", "https://allotjar.com/accept-invite?code=abc");
        var password = InvitationEmails.ChooseYourPassword("sam@example.com", "https://allotjar.com/reset-password?email=sam%40example.com&token=t");

        invite.TextBody.Split('\n').Should().Contain("https://allotjar.com/accept-invite?code=abc");
        password.TextBody.Split('\n').Should().Contain("https://allotjar.com/reset-password?email=sam%40example.com&token=t");
    }
}
