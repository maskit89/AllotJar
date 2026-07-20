using System.Net;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// The forgot-password email. Self-contained by design: no external images or stylesheets
/// (mail clients block them and there's nothing to track), and the text body carries the same
/// link so it reads fine anywhere. The text body must keep the reset link alone on its own line —
/// the integration tests and journey e2e extract it as the single http-starting line.
/// </summary>
public static class PasswordResetEmail
{
    /// <summary>Matches the reset token's lifetime (DataProtectionTokenProviderOptions).</summary>
    public const int LinkLifetimeHours = 2;

    public static EmailMessage Build(string toEmail, string resetLink)
    {
        const string subject = "Reset your AllotJar password";

        var text =
            $"We received a request to reset the password for your AllotJar account.\n\n" +
            $"Open this link to choose a new password (valid for {LinkLifetimeHours} hours):\n" +
            $"{resetLink}\n\n" +
            "If you didn't request this, you can safely ignore this email — your password is unchanged.\n\n" +
            $"Why did I get this? A password reset was requested for {toEmail} at allotjar.com.\n\n" +
            "— AllotJar · Every euro has a job.";

        var encodedLink = WebUtility.HtmlEncode(resetLink);
        var encodedTo = WebUtility.HtmlEncode(toEmail);

        var body =
            $"<h1 style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:28px;color:{EmailLayout.Ink}\" class=\"aj-ink\">Reset your password</h1>" +
            $"<p style=\"margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:{EmailLayout.Ink}\" class=\"aj-ink\">" +
            "We received a request to reset the password for your AllotJar account. " +
            "Click the button below to choose a new one.</p>" +
            EmailLayout.Button(encodedLink, "Choose a new password") +
            $"<p style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:{EmailLayout.Muted}\" class=\"aj-muted\">" +
            $"This link is valid for {LinkLifetimeHours} hours. If the button doesn't work, copy and paste this address into your browser:<br>" +
            $"<a href=\"{encodedLink}\" style=\"color:{EmailLayout.Green};word-break:break-all\" class=\"aj-jar\">{encodedLink}</a></p>" +
            $"<p style=\"margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:{EmailLayout.Muted}\" class=\"aj-muted\">" +
            "If you didn't request this, you can safely ignore this email — your password is unchanged.</p>";

        var html = EmailLayout.Wrap(
            title: subject,
            preheader: $"Choose a new password for your AllotJar account — the link is valid for {LinkLifetimeHours} hours.",
            bodyHtml: body,
            footerReasonHtml:
                $"You're receiving this one-off email because a password reset was requested for <strong>{encodedTo}</strong> on AllotJar. " +
                "If this wasn't you, no action is needed — your password has not changed.");

        return new EmailMessage(toEmail, subject, text, html);
    }
}
