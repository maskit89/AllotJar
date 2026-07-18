using System.Net;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// The forgot-password email. Plain, self-contained markup: no external images or stylesheets
/// (mail clients block them and there's nothing to track), and the text body carries the same
/// link so it reads fine anywhere.
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
            "— AllotJar";

        var encodedLink = WebUtility.HtmlEncode(resetLink);
        var html =
            "<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;" +
            "max-width:480px;margin:0 auto;padding:24px;color:#0f172a\">" +
            "<h1 style=\"font-size:20px;margin:0 0 16px\">Allot<span style=\"color:#1f6b4d\">Jar</span></h1>" +
            "<p>We received a request to reset the password for your AllotJar account.</p>" +
            $"<p style=\"margin:24px 0\"><a href=\"{encodedLink}\" " +
            "style=\"background:#1f6b4d;color:#ffffff;text-decoration:none;padding:12px 20px;" +
            "border-radius:8px;display:inline-block;font-weight:600\">Choose a new password</a></p>" +
            $"<p style=\"color:#475569;font-size:14px\">The link is valid for {LinkLifetimeHours} hours. " +
            "If the button doesn't work, copy this address into your browser:<br>" +
            $"<a href=\"{encodedLink}\" style=\"color:#1f6b4d;word-break:break-all\">{encodedLink}</a></p>" +
            "<p style=\"color:#475569;font-size:14px\">If you didn't request this, you can safely ignore " +
            "this email — your password is unchanged.</p>" +
            "</div>";

        return new EmailMessage(toEmail, subject, text, html);
    }
}
