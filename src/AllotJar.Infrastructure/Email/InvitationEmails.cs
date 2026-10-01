using System.Net;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// The two emails an invitation sends to the invited address ("Email first", review P2-1 of #298):
/// a one-time invite link, and, for a login created with a temporary password, the link to choose
/// the login's own password. Only the mailbox's owner sees either link, so whoever invites a person
/// never knows the password that person ends up with (P59). Like the reset email, the text body
/// keeps each link alone on its own line, which the tests and journeys read.
/// </summary>
public static class InvitationEmails
{
    public const int InviteLinkLifetimeDays = 7;

    public static EmailMessage InviteLink(string toEmail, string inviterName, string link)
    {
        const string subject = "You're invited to a household on AllotJar";

        var text =
            $"{inviterName} invited you to share their household budget on AllotJar.\n\n" +
            $"Open this link to accept (it works once and is valid for {InviteLinkLifetimeDays} days):\n" +
            $"{link}\n\n" +
            "If you already have an AllotJar account, sign in with it when the link asks. Otherwise you choose your password there.\n\n" +
            "If you weren't expecting this, you can ignore this email.\n\n" +
            "— AllotJar · Every euro has a job.";

        var encodedLink = WebUtility.HtmlEncode(link);
        var encodedInviter = WebUtility.HtmlEncode(inviterName);
        var body =
            Heading("You're invited") +
            Paragraph($"<strong>{encodedInviter}</strong> invited you to share their household budget on AllotJar.") +
            EmailLayout.Button(encodedLink, "Accept the invite") +
            Note($"The link works once and is valid for {InviteLinkLifetimeDays} days. If the button doesn't work, copy and paste this address into your browser:<br>" +
                 $"<a href=\"{encodedLink}\" style=\"color:{EmailLayout.Green};word-break:break-all\" class=\"aj-jar\">{encodedLink}</a>") +
            Note("If you weren't expecting this, you can ignore this email.");

        return new EmailMessage(toEmail, subject, text, EmailLayout.Wrap(
            title: subject,
            preheader: $"{inviterName} invited you to their household on AllotJar.",
            bodyHtml: body,
            footerReasonHtml: $"You're receiving this one-off email because {encodedInviter} invited <strong>{WebUtility.HtmlEncode(toEmail)}</strong> on AllotJar."));
    }

    public static EmailMessage ChooseYourPassword(string toEmail, string link)
    {
        const string subject = "Choose your AllotJar password";

        var text =
            "A login was set up for you on AllotJar with a temporary password.\n\n" +
            $"Open this link to choose your own password (valid for {PasswordResetEmail.LinkLifetimeHours} hours; " +
            "signing in with the temporary password lets you send a fresh one):\n" +
            $"{link}\n\n" +
            "Until you do, the login can't see anything, so the accounts you keep private stay yours alone.\n\n" +
            "— AllotJar · Every euro has a job.";

        var encodedLink = WebUtility.HtmlEncode(link);
        var body =
            Heading("Choose your own password") +
            Paragraph("A login was set up for you on AllotJar with a temporary password. Choose one only you know " +
                      "before you start: until you do, the login can't see anything.") +
            EmailLayout.Button(encodedLink, "Choose my password") +
            Note($"This link is valid for {PasswordResetEmail.LinkLifetimeHours} hours; signing in with the temporary password lets you send a fresh one. " +
                 "If the button doesn't work, copy and paste this address into your browser:<br>" +
                 $"<a href=\"{encodedLink}\" style=\"color:{EmailLayout.Green};word-break:break-all\" class=\"aj-jar\">{encodedLink}</a>");

        return new EmailMessage(toEmail, subject, text, EmailLayout.Wrap(
            title: subject,
            preheader: "Choose your own password to start using AllotJar.",
            bodyHtml: body,
            footerReasonHtml: $"You're receiving this email because a login was created for <strong>{WebUtility.HtmlEncode(toEmail)}</strong> on AllotJar."));
    }

    private static string Heading(string text) =>
        $"<h1 style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:28px;color:{EmailLayout.Ink}\" class=\"aj-ink\">{text}</h1>";

    private static string Paragraph(string html) =>
        $"<p style=\"margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:{EmailLayout.Ink}\" class=\"aj-ink\">{html}</p>";

    private static string Note(string html) =>
        $"<p style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:{EmailLayout.Muted}\" class=\"aj-muted\">{html}</p>";
}
