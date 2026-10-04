using Microsoft.Extensions.Logging;

namespace AllotJar.Infrastructure.Alerts;

/// <summary>One log entry at Error or above, as captured for an alert email.</summary>
public sealed record ErrorEvent(
    DateTimeOffset At,
    LogLevel Level,
    string Category,
    string Message,
    string? Template,
    string? ExceptionType,
    string? ExceptionDetail,
    string? Origin = null)
{
    /// <summary>
    /// What makes two errors "the same" for the cooldown: where it was logged, the message as
    /// written in code (not with the values filled in), the exception type and where in the app
    /// the exception came from. The last matters because every 500 shares one template in the
    /// exception middleware, so without it two different bugs throwing the same type inside a
    /// quarter of an hour would collapse into one (review P2-1). The formatted message is the
    /// fallback for a logger that passed a plain string.
    /// </summary>
    public string Key => $"{Category}|{Template ?? Message}|{ExceptionType}|{Origin}";

    /// <summary>How many times this same error arrived in the batch being emailed.</summary>
    public int Occurrences { get; init; } = 1;
}
