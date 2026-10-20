using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace AllotJar.Infrastructure.Identity;

/// <summary>What a passkey ceremony is for: each kind is accepted only where it was started.</summary>
public enum PasskeyCeremonyKind
{
    /// <summary>"Sign in with a passkey" on the sign-in page: no login known until it answers.</summary>
    SignIn,

    /// <summary>The step after a password, Google or reset sign-in for a login that has a passkey.</summary>
    SecondStep,

    /// <summary>A signed-in login adding a passkey.</summary>
    Register,

    /// <summary>A signed-in login confirming it is them before a passkey or the codes change.</summary>
    Proof,
}

/// <summary>A started ceremony: Identity's state for it (the challenge) and the login it is bound to.</summary>
public sealed record PasskeyCeremony(PasskeyCeremonyKind Kind, string? UserId, string State, DateTimeOffset ExpiresAt);

/// <summary>
/// Server-side state for passkey ceremonies between their two requests, keyed by a random id the
/// client carries. Held here rather than handed to the client so each challenge works once: a
/// finish takes its ceremony out, and a second finish with the same id finds nothing. In memory,
/// as the API runs one process; an app-pool recycle only drops ceremonies under five minutes old.
/// </summary>
public sealed class PasskeyCeremonies
{
    /// <summary>Matches the authenticator timeout the browser is given.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    /// <summary>Wrong answers a second-step ticket takes before it is dropped and sign-in starts over.</summary>
    public const int MaxFailures = 5;

    private sealed class Entry(PasskeyCeremony ceremony)
    {
        public PasskeyCeremony Ceremony { get; } = ceremony;
        public int Failures;
    }

    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;

    public PasskeyCeremonies(TimeProvider time) => _time = time;

    public string Start(PasskeyCeremonyKind kind, string? userId, string state)
    {
        Prune();
        var id = Base64Url(RandomNumberGenerator.GetBytes(32));
        _entries[id] = new Entry(new PasskeyCeremony(kind, userId, state, _time.GetUtcNow() + Lifetime));
        return id;
    }

    /// <summary>The ceremony, if it is live and of this kind; it stays until <see cref="TryTake"/>.</summary>
    public PasskeyCeremony? Find(string? id, PasskeyCeremonyKind kind)
    {
        if (string.IsNullOrEmpty(id) || !_entries.TryGetValue(id, out var entry))
        {
            return null;
        }
        if (entry.Ceremony.ExpiresAt <= _time.GetUtcNow())
        {
            _entries.TryRemove(id, out _);
            return null;
        }
        return entry.Ceremony.Kind == kind ? entry.Ceremony : null;
    }

    /// <summary>Ends the ceremony. Only one caller gets true, so two answers racing on one id can't both win.</summary>
    public bool TryTake(string id) => _entries.TryRemove(id, out _);

    /// <summary>Counts a wrong answer; at <see cref="MaxFailures"/> the ceremony ends.</summary>
    public void Fail(string id)
    {
        if (_entries.TryGetValue(id, out var entry) && Interlocked.Increment(ref entry.Failures) >= MaxFailures)
        {
            _entries.TryRemove(id, out _);
        }
    }

    private void Prune()
    {
        var now = _time.GetUtcNow();
        foreach (var (id, entry) in _entries)
        {
            if (entry.Ceremony.ExpiresAt <= now)
            {
                _entries.TryRemove(id, out _);
            }
        }
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
