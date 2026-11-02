namespace AllotJar.Api.Services;

/// <summary>
/// At most <see cref="Limit"/> emails per key in any <see cref="Window"/>, kept in memory (a restart
/// forgets, which only ever errs towards sending). Tracks at most <see cref="MaxKeys"/> keys: past
/// that it refuses rather than grow, so a flood of addresses can't swell the 4 GB box (audit A06-001,
/// security review #6). Every claim prunes what has aged out, so the store holds only the last window.
/// </summary>
public abstract class SendAllowance
{
    private readonly Dictionary<string, Queue<DateTime>> _sent = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _gate = new();
    private readonly TimeProvider _clock;
    private DateTime _nextPrune = DateTime.MinValue;

    protected SendAllowance(TimeProvider clock, int limit, TimeSpan window, int maxKeys)
    {
        _clock = clock;
        Limit = limit;
        Window = window;
        MaxKeys = maxKeys;
    }

    public int Limit { get; }

    public TimeSpan Window { get; }

    public int MaxKeys { get; }

    /// <summary>True, and the send is counted, when <paramref name="key"/> has room in the window.</summary>
    public bool TryClaim(string key)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        lock (_gate)
        {
            if (now >= _nextPrune)
            {
                foreach (var (k, times) in _sent.ToList())
                {
                    Expire(times, now);
                    if (times.Count == 0)
                    {
                        _sent.Remove(k);
                    }
                }
                _nextPrune = now + TimeSpan.FromSeconds(30);
            }

            if (!_sent.TryGetValue(key, out var sent))
            {
                if (_sent.Count >= MaxKeys)
                {
                    return false;
                }
                sent = new Queue<DateTime>();
                _sent[key] = sent;
            }

            Expire(sent, now);
            if (sent.Count >= Limit)
            {
                return false;
            }
            sent.Enqueue(now);
            return true;
        }
    }

    /// <summary>Gives back the newest claim for <paramref name="key"/> when nothing went out.</summary>
    public void Release(string key)
    {
        lock (_gate)
        {
            if (_sent.TryGetValue(key, out var sent) && sent.Count > 0)
            {
                // Queue has no "remove last": rebuild without the newest entry (at most Limit items).
                var kept = sent.Take(sent.Count - 1).ToList();
                sent.Clear();
                foreach (var at in kept)
                {
                    sent.Enqueue(at);
                }
                if (sent.Count == 0)
                {
                    _sent.Remove(key);
                }
            }
        }
    }

    private void Expire(Queue<DateTime> sent, DateTime now)
    {
        while (sent.Count > 0 && now - sent.Peek() >= Window)
        {
            sent.Dequeue();
        }
    }
}

/// <summary>
/// Invite and "Send again" emails per household: 10 a day. An owner inviting the few people of a
/// household never meets it; an account made to send spam under AllotJar's name stops there.
/// </summary>
/// <remarks>The journeys and the shared test fixture raise it with <c>Limits:InviteEmailsPerDay</c>.</remarks>
public sealed class InviteEmailAllowance(TimeProvider clock, IConfiguration configuration)
    : SendAllowance(clock, configuration.GetValue("Limits:InviteEmailsPerDay", 10), TimeSpan.FromDays(1), maxKeys: 10_000)
{
    public const string Refused =
        "You've sent the most invite emails allowed for today. Try again tomorrow.";
}

/// <summary>
/// Password links (forgot password, the register reclaim, a direct invite's "choose your password")
/// per login: 3 in any 15 minutes. A retry or two goes through at once; nobody's inbox can be
/// flooded with them (security review #6). Keyed by login id, so only real logins are tracked.
/// </summary>
/// <remarks>The journeys raise it with <c>Limits:PasswordLinksPer15Minutes</c>.</remarks>
public sealed class PasswordLinkAllowance(TimeProvider clock, IConfiguration configuration)
    : SendAllowance(clock, configuration.GetValue("Limits:PasswordLinksPer15Minutes", 3), TimeSpan.FromMinutes(15), maxKeys: 10_000)
{
    public const string Refused =
        "We've already sent a few password links to this address. Check your inbox (and spam), or try again in 15 minutes.";
}

/// <summary>How a password-link send ended.</summary>
public enum PasswordLinkResult
{
    Sent,
    NotSent,
    TooSoon,
}
