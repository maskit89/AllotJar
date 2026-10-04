namespace AllotJar.Infrastructure.Alerts;

/// <summary>
/// Decides which of a batch of errors get emailed now. Pure bookkeeping, so it is unit-tested
/// apart from the mailer: a per-error cooldown (the same error again inside the window is counted,
/// not sent), an hourly cap on emails, and a running count of what was held back, reported in
/// the next email that goes out.
/// </summary>
public sealed class ErrorAlertThrottle
{
    private static readonly TimeSpan Hour = TimeSpan.FromHours(1);

    private readonly ErrorAlertSettings _settings;
    private readonly TimeProvider _clock;
    private readonly Dictionary<string, DateTimeOffset> _lastSentByKey = new();
    private readonly Queue<DateTimeOffset> _sentInLastHour = new();
    private int _suppressed;

    public ErrorAlertThrottle(ErrorAlertSettings settings, TimeProvider clock)
    {
        _settings = settings;
        _clock = clock;
    }

    /// <summary>Errors counted but not emailed since the last email went out.</summary>
    public int Suppressed => _suppressed;

    /// <summary>
    /// Takes a batch and answers what to email: the distinct errors not in cooldown (each with how
    /// often it appeared in the batch), or nothing. Calling this counts as sending what it returns.
    /// </summary>
    public AlertDecision Take(IReadOnlyList<ErrorEvent> batch)
    {
        var now = _clock.GetUtcNow();
        while (_sentInLastHour.Count > 0 && now - _sentInLastHour.Peek() >= Hour)
        {
            _sentInLastHour.Dequeue();
        }

        var ordered = new List<ErrorEvent>();
        var byKey = new Dictionary<string, int>();
        foreach (var e in batch)
        {
            if (_lastSentByKey.TryGetValue(e.Key, out var sentAt) && now - sentAt < _settings.Cooldown)
            {
                _suppressed++;
                continue;
            }
            if (byKey.TryGetValue(e.Key, out var index))
            {
                ordered[index] = ordered[index] with { Occurrences = ordered[index].Occurrences + 1 };
                continue;
            }
            byKey[e.Key] = ordered.Count;
            ordered.Add(e);
        }

        if (ordered.Count == 0)
        {
            return AlertDecision.Nothing;
        }

        if (_sentInLastHour.Count >= _settings.MaxEmailsPerHour)
        {
            // Over the cap: these are new errors, but this hour's emails are spent. They are
            // counted so the first email after the pause says how much was missed.
            foreach (var e in ordered) _suppressed += e.Occurrences;
            return AlertDecision.Nothing;
        }

        foreach (var e in ordered) _lastSentByKey[e.Key] = now;
        _sentInLastHour.Enqueue(now);
        var suppressed = _suppressed;
        _suppressed = 0;
        var capReached = _sentInLastHour.Count >= _settings.MaxEmailsPerHour;
        return new AlertDecision(ordered, suppressed, capReached ? _sentInLastHour.Peek() + Hour : null);
    }
}

/// <summary>
/// What to email: the errors, how many earlier errors were held back since the last email, and,
/// when this email reaches the hourly cap, when alerts resume.
/// </summary>
public sealed record AlertDecision(IReadOnlyList<ErrorEvent> Events, int SuppressedBefore, DateTimeOffset? PausedUntil)
{
    public static readonly AlertDecision Nothing = new(Array.Empty<ErrorEvent>(), 0, null);

    public bool SendsEmail => Events.Count > 0;
}
