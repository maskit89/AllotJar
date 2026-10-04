using System.Net;
using System.Text;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Alerts;

/// <summary>Renders an alert decision as the email the recipient reads.</summary>
public static class ErrorAlertEmail
{
    public const int SubjectMessageChars = 90;

    public static EmailMessage Build(
        string recipient, string environmentName, string siteUrl, AlertDecision decision)
    {
        if (!decision.SendsEmail) throw new ArgumentException("Nothing to send.", nameof(decision));

        var first = decision.Events[0];
        var others = decision.Events.Count - 1;
        var headline = OneLine(first.Message);
        if (headline.Length > SubjectMessageChars) headline = headline[..SubjectMessageChars] + "…";
        var subject = $"[AllotJar {environmentName}] {first.Level}: {headline}"
                      + (others > 0 ? $" (+{others} more)" : "");

        var text = new StringBuilder();
        var html = new StringBuilder();
        html.Append("<div style=\"font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222\">");

        var intro = $"{Plural(decision.Events.Sum(e => e.Occurrences), "error")} on {siteUrl} ({environmentName}).";
        text.AppendLine(intro).AppendLine();
        html.Append("<p>").Append(WebUtility.HtmlEncode(intro)).Append("</p>");

        if (decision.SuppressedBefore > 0)
        {
            var note = $"{Plural(decision.SuppressedBefore, "earlier error")} since the last email " +
                       "were not emailed (a repeat inside its cooldown, or the hourly cap).";
            text.AppendLine(note).AppendLine();
            html.Append("<p>").Append(WebUtility.HtmlEncode(note)).Append("</p>");
        }

        foreach (var e in decision.Events)
        {
            var when = e.At.ToString("yyyy-MM-dd HH:mm:ss 'UTC'");
            var times = e.Occurrences > 1 ? $" (×{e.Occurrences} in this batch)" : "";
            text.AppendLine($"--- {when} {e.Level}{times}");
            text.AppendLine($"Logger: {e.Category}");
            text.AppendLine(e.Message);
            if (e.ExceptionDetail is not null) text.AppendLine().AppendLine(e.ExceptionDetail);
            text.AppendLine();

            html.Append("<hr><p><b>").Append(WebUtility.HtmlEncode($"{when} {e.Level}{times}")).Append("</b><br>")
                .Append("<span style=\"color:#666\">").Append(WebUtility.HtmlEncode(e.Category)).Append("</span></p>")
                .Append("<p>").Append(WebUtility.HtmlEncode(e.Message)).Append("</p>");
            if (e.ExceptionDetail is not null)
            {
                html.Append("<pre style=\"white-space:pre-wrap;font-size:12px;background:#f6f6f6;padding:8px\">")
                    .Append(WebUtility.HtmlEncode(e.ExceptionDetail)).Append("</pre>");
            }
        }

        if (decision.PausedUntil is { } until)
        {
            var pause = $"This is the last alert email this hour. Further errors are counted and " +
                        $"reported from {until:HH:mm 'UTC'}.";
            text.AppendLine(pause);
            html.Append("<hr><p><i>").Append(WebUtility.HtmlEncode(pause)).Append("</i></p>");
        }

        var footer = "Sent by the AllotJar API's error alerts (ErrorAlerts in appsettings). " +
                     "The full entries are in the server's Application event log.";
        text.AppendLine().AppendLine(footer);
        html.Append("<p style=\"color:#888;font-size:12px\">").Append(WebUtility.HtmlEncode(footer)).Append("</p></div>");

        return new EmailMessage(recipient, subject, text.ToString(), html.ToString());
    }

    private static string OneLine(string s) => string.Join(' ', s.Split('\n', '\r')).Trim();

    private static string Plural(int n, string noun) => n == 1 ? $"1 {noun}" : $"{n} {noun}s";
}
