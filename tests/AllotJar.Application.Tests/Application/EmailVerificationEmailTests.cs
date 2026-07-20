using System.Net;
using FluentAssertions;
using AllotJar.Infrastructure.Email;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The "confirm your email" template (catalog REG-091): the confirm link in both bodies, the
/// lifetime, the ignore note, and no external images/trackers — the same self-contained
/// properties pinned for the password-reset email.
/// </summary>
public class EmailVerificationEmailTests
{
    [Fact]
    public void Verification_email_is_self_contained_with_the_link_in_both_bodies()
    {
        const string link = "https://www.allotjar.com/confirm-email?email=a%40b.com&token=x%2By";

        var message = EmailVerificationEmail.Build("a@b.com", link);
        var lifetime = $"{PasswordResetEmail.LinkLifetimeHours} hours";

        message.ToEmail.Should().Be("a@b.com");
        message.Subject.Should().Contain("Confirm").And.Contain("email");

        message.TextBody.Should().Contain(link).And.Contain(lifetime).And.Contain("didn't create");
        message.HtmlBody.Should().Contain(WebUtility.HtmlEncode(link)).And.Contain(lifetime).And.Contain("didn't create");

        // No external images/trackers: the only URL in the HTML is the confirm link itself.
        message.HtmlBody.Should().NotContain("<img");
        message.HtmlBody.Replace(WebUtility.HtmlEncode(link), string.Empty).Should().NotContain("http");
    }
}
