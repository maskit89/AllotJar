namespace AllotJar.Infrastructure.Alerts;

/// <summary>
/// Bound from the "ErrorAlerts" configuration section. With a <see cref="Recipient"/> set, every
/// log entry at Error or above (an unhandled exception answered as a 500, a failed send, a failed
/// startup step that let the API continue) is emailed there through the configured outbound
/// email provider, batched and throttled so a loop of failures is one email, not a flood. No
/// recipient means the feature is off: nothing is registered and the log is unchanged.
/// </summary>
public class ErrorAlertSettings
{
    public const string SectionName = "ErrorAlerts";

    /// <summary>Who gets the emails. Empty or missing turns error alerts off.</summary>
    public string? Recipient { get; set; }

    /// <summary>
    /// How long the same error (same logger, message template and exception type) stays quiet
    /// after it was emailed. Repeats in that window are counted and reported in the next email.
    /// </summary>
    public int CooldownMinutes { get; set; } = 15;

    /// <summary>
    /// The most alert emails in any rolling hour. The email that reaches the cap says so; later
    /// errors in that hour are counted and reported when alerts resume.
    /// </summary>
    public int MaxEmailsPerHour { get; set; } = 6;

    /// <summary>
    /// How long to wait after the first error before emailing, so the other errors one incident
    /// throws (the database command and the request that failed on it, say) share one email.
    /// </summary>
    public int BatchSeconds { get; set; } = 10;

    /// <summary>
    /// When true the API logs one Error at startup so the whole path can be checked from the
    /// inbox. Turn it off again once the test email arrives; it fires on every start.
    /// </summary>
    public bool TestOnStartup { get; set; }

    public bool Enabled => !string.IsNullOrWhiteSpace(Recipient);

    public TimeSpan Cooldown => TimeSpan.FromMinutes(Math.Max(0, CooldownMinutes));
    public TimeSpan BatchWindow => TimeSpan.FromSeconds(Math.Clamp(BatchSeconds, 0, 120));
}
