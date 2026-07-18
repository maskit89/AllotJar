namespace AllotJar.Infrastructure.Email;

/// <summary>
/// Bound from the "Email" configuration section. With no <see cref="ApiKey"/> the app falls back
/// to <see cref="LoggingEmailSender"/> (dev/CI-friendly: no credentials, emails land in the log +
/// in-memory sink). Set the key via user-secrets or the Email__ApiKey environment variable —
/// never commit it.
/// </summary>
public class EmailSettings
{
    public const string SectionName = "Email";

    /// <summary>Resend API key. Absent ⇒ the logging fallback sender is used.</summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// The From header, "Name &lt;address&gt;" form. The address's domain must be verified with
    /// the provider (DNS DKIM/SPF records) or sends are rejected.
    /// </summary>
    public string FromAddress { get; set; } = "AllotJar <no-reply@allotjar.com>";

    /// <summary>
    /// Absolute origin used to build links in emails (e.g. the password-reset URL). Deliberately
    /// config-only — deriving it from the request's Host header would let a spoofed header inject
    /// an attacker-controlled link into a legitimate reset email.
    /// </summary>
    public string AppBaseUrl { get; set; } = "https://www.allotjar.com";

    /// <summary>
    /// Log full message bodies from the fallback sender. Development-only convenience (the reset
    /// link is in the body); keep OFF elsewhere so tokens never reach persisted logs.
    /// </summary>
    public bool LogBodies { get; set; }
}
