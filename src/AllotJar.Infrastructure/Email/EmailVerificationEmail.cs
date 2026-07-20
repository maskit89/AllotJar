using System.Net;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// The "confirm your email" email sent at registration (and on resend). Shares the branded
/// <see cref="EmailLayout"/> chrome with <see cref="PasswordResetEmail"/> — no external
/// images/trackers, table-based, dark-mode-aware, and the confirm link is the only "http"
/// substring in the markup (the anti-tracker tripwire the security tests pin). The link carries an
/// ASP.NET Identity email-confirmation token; its lifetime is the DataProtection token lifespan
/// (2h, shared with the reset token — see DependencyInjection.cs). The text body keeps the link
/// alone on its own line so the integration/journey tests can extract it as the single http line.
/// </summary>
public static class EmailVerificationEmail
{
    public static EmailMessage Build(string toEmail, string confirmLink)
    {
        const string subject = "Confirm your AllotJar email";

        var text =
            "Welcome to AllotJar! Please confirm this is your email address.\n\n" +
            $"Open this link to confirm (valid for {PasswordResetEmail.LinkLifetimeHours} hours):\n" +
            $"{confirmLink}\n\n" +
            "If you didn't create an AllotJar account, you can safely ignore this email.\n\n" +
            "— AllotJar · Every euro has a job.";

        var encodedLink = WebUtility.HtmlEncode(confirmLink);
        var encodedTo = WebUtility.HtmlEncode(toEmail);

        var body =
            $"<h1 style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:28px;color:{EmailLayout.Ink}\" class=\"aj-ink\">Confirm your email</h1>" +
            $"<p style=\"margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:{EmailLayout.Ink}\" class=\"aj-ink\">" +
            "Welcome to AllotJar! Please confirm this is your email address so we can keep your account secure.</p>" +
            EmailLayout.Button(encodedLink, "Confirm email") +
            $"<p style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:{EmailLayout.Muted}\" class=\"aj-muted\">" +
            $"This link is valid for {PasswordResetEmail.LinkLifetimeHours} hours. If the button doesn't work, copy and paste this address into your browser:<br>" +
            $"<a href=\"{encodedLink}\" style=\"color:{EmailLayout.Green};word-break:break-all\" class=\"aj-jar\">{encodedLink}</a></p>" +
            $"<p style=\"margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:{EmailLayout.Muted}\" class=\"aj-muted\">" +
            "If you didn't create an AllotJar account, you can safely ignore this email.</p>";

        var html = EmailLayout.Wrap(
            title: subject,
            preheader: $"Confirm your email address for AllotJar — the link is valid for {PasswordResetEmail.LinkLifetimeHours} hours.",
            bodyHtml: body,
            footerReasonHtml:
                $"You're receiving this because an AllotJar account was created with <strong>{encodedTo}</strong>. " +
                "If this wasn't you, no action is needed — you can safely ignore this email.");

        return new EmailMessage(toEmail, subject, text, html);
    }
}
