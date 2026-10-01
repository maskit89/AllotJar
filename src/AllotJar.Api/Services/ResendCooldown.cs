using System.Collections.Concurrent;

namespace AllotJar.Api.Services;

/// <summary>
/// Spaces out "Send again" on People: one email per invite or login a minute, on top of the auth
/// rate limit per visitor, so a held-down button can't flood someone's inbox. Kept in memory: a
/// restart only forgets who was sent to in the last minute.
/// </summary>
public sealed class ResendCooldown
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    private readonly ConcurrentDictionary<(string OwnerId, Guid MembershipId), DateTime> _lastSent = new();
    private readonly TimeProvider _clock;

    public ResendCooldown(TimeProvider clock) => _clock = clock;

    /// <summary>
    /// Claims the next send for <paramref name="membershipId"/> in <paramref name="ownerId"/>'s
    /// household: true when none was sent within the interval (and records this one), false while
    /// the last one is still too recent. Keyed by household too, so another household's id never
    /// answers "too soon".
    /// </summary>
    public bool TryClaim(string ownerId, Guid membershipId)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        foreach (var (id, at) in _lastSent)
        {
            if (now - at >= Interval)
            {
                _lastSent.TryRemove(new KeyValuePair<(string, Guid), DateTime>(id, at));
            }
        }
        return _lastSent.TryAdd((ownerId, membershipId), now);
    }

    /// <summary>Gives the claim back when nothing went out, so the owner can try again at once.</summary>
    public void Release(string ownerId, Guid membershipId) => _lastSent.TryRemove((ownerId, membershipId), out _);
}
