using System.Net;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>What changed about a login's two-factor sign-in, for the notice emailed to it.</summary>
public enum PasskeyNotice
{
    Added,
    Removed,
    RecoveryCodeUsed,
    RecoveryCodesReplaced,
}

/// <summary>
/// The notice a login gets whenever its passkeys or recovery codes change or a code is used, so a
/// change it didn't make doesn't go unseen (fix 14). No links: it tells the owner what to do, and a
/// security email that asks to be clicked is what phishing looks like.
/// </summary>
public static class PasskeyNoticeEmail
{
    public static EmailMessage Build(string toEmail, PasskeyNotice notice, string? device)
    {
        var (subject, heading, what) = notice switch
        {
            PasskeyNotice.Added => ("A passkey was added to your AllotJar account", "Passkey added",
                "A passkey was added to your AllotJar account"),
            PasskeyNotice.Removed => ("A passkey was removed from your AllotJar account", "Passkey removed",
                "A passkey was removed from your AllotJar account"),
            PasskeyNotice.RecoveryCodeUsed => ("A recovery code was used to sign in to AllotJar", "Recovery code used",
                "One of your recovery codes was used to sign in to your AllotJar account"),
            _ => ("New recovery codes for your AllotJar account", "New recovery codes",
                "New recovery codes were made for your AllotJar account, and the old ones no longer work"),
        };
        var from = string.IsNullOrWhiteSpace(device) ? string.Empty : $" from {device}";
        const string ifNotYou =
            "If this wasn't you, sign in, check your passkeys and devices in Account settings, change your password, " +
            "and write to privacy@allotjar.com.";

        var text =
            $"{what}{from}.\n\n" +
            "If this was you, there's nothing to do.\n\n" +
            $"{ifNotYou}\n\n" +
            "— AllotJar · Every euro has a job.";

        var encodedTo = WebUtility.HtmlEncode(toEmail);
        var body =
            $"<h1 style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:28px;color:{EmailLayout.Ink}\" class=\"aj-ink\">{WebUtility.HtmlEncode(heading)}</h1>" +
            $"<p style=\"margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:{EmailLayout.Ink}\" class=\"aj-ink\">" +
            $"{WebUtility.HtmlEncode(what + from)}. If this was you, there's nothing to do.</p>" +
            $"<p style=\"margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:{EmailLayout.Muted}\" class=\"aj-muted\">" +
            $"{WebUtility.HtmlEncode(ifNotYou)}</p>";

        var html = EmailLayout.Wrap(
            title: subject,
            preheader: $"{what}.",
            bodyHtml: body,
            footerReasonHtml:
                $"You're receiving this one-off email because the sign-in settings changed for <strong>{encodedTo}</strong> on AllotJar.");

        return new EmailMessage(toEmail, subject, text, html);
    }
}
