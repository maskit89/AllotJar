using System.Net;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// The "confirm your email" email sent at registration (and on resend). Self-contained markup, no
/// external images/trackers — same house style as <see cref="PasswordResetEmail"/>. The link
/// carries an ASP.NET Identity email-confirmation token; its lifetime is the DataProtection token
/// lifespan (2h, shared with the reset token — see DependencyInjection.cs).
/// </summary>
public static class EmailVerificationEmail
{
    public static EmailMessage Build(string toEmail, string confirmLink)
    {
        const string subject = "Confirm your AllotJar email";

        var text =
            "Welcome to AllotJar! Please confirm this is your email address.\n\n" +
            $"Open this link to confirm ({PasswordResetEmail.LinkLifetimeHours} hours):\n" +
            $"{confirmLink}\n\n" +
            "If you didn't create an AllotJar account, you can safely ignore this email.\n\n" +
            "— AllotJar";

        var encodedLink = WebUtility.HtmlEncode(confirmLink);
        var html =
            "<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;" +
            "max-width:480px;margin:0 auto;padding:24px;color:#0f172a\">" +
            "<h1 style=\"font-size:20px;margin:0 0 16px\">Allot<span style=\"color:#1f6b4d\">Jar</span></h1>" +
            "<p>Welcome to AllotJar! Please confirm this is your email address.</p>" +
            $"<p style=\"margin:24px 0\"><a href=\"{encodedLink}\" " +
            "style=\"background:#1f6b4d;color:#ffffff;text-decoration:none;padding:12px 20px;" +
            "border-radius:8px;display:inline-block;font-weight:600\">Confirm email</a></p>" +
            $"<p style=\"color:#475569;font-size:14px\">The link is valid for {PasswordResetEmail.LinkLifetimeHours} hours. " +
            "If the button doesn't work, copy this address into your browser:<br>" +
            $"<a href=\"{encodedLink}\" style=\"color:#1f6b4d;word-break:break-all\">{encodedLink}</a></p>" +
            "<p style=\"color:#475569;font-size:14px\">If you didn't create an AllotJar account, you can " +
            "safely ignore this email.</p>" +
            "</div>";

        return new EmailMessage(toEmail, subject, text, html);
    }
}
