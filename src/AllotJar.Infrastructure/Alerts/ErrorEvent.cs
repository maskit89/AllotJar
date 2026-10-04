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
    string? ExceptionDetail)
{
    /// <summary>
    /// What makes two errors "the same" for the cooldown: where it was logged, the message as
    /// written in code (not with the values filled in) and the exception type. The formatted
    /// message is the fallback for a logger that passed a plain string.
    /// </summary>
    public string Key => $"{Category}|{Template ?? Message}|{ExceptionType}";

    /// <summary>How many times this same error arrived in the batch being emailed.</summary>
    public int Occurrences { get; init; } = 1;
}
