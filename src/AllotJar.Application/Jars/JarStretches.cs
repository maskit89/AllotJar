using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>
/// The stretches jars spent in accounts they have since left (rule 80), as their departures
/// record them (<see cref="JarDepartures"/>). A departure closes the stretch that ends on its
/// date; that stretch began on the day of the jar's previous departure from any account (the day
/// it moved in, which belongs to both accounts), or has no recorded start when there is none.
/// Only a stretch whose account carried the jar's postings or payments has a departure, so a jar
/// that left an account with nothing in it has no recorded stretch there, and the stretch after
/// it reads as beginning too early (so does one after a move made before departures were
/// recorded, whose departure is dated on the old account's last entry). Read by the write
/// paths that accept a payment on a jar's line from an account the jar has left (R2-D1): it is
/// the old account's entry, dated while the jar was held there, and its move is re-settled.
/// </summary>
public sealed class JarStretches
{
    private readonly Dictionary<Guid, List<(Guid AccountId, DateOnly Date)>> _departures;
    private readonly Dictionary<Guid, (string Name, DateOnly? OpeningDate)> _accounts;

    private JarStretches(
        Dictionary<Guid, List<(Guid AccountId, DateOnly Date)>> departures,
        Dictionary<Guid, (string Name, DateOnly? OpeningDate)> accounts)
    {
        _departures = departures;
        _accounts = accounts;
    }

    /// <summary>No recorded stretches: every jar is held only where it is designated.</summary>
    public static readonly JarStretches None = new(new(), new());

    /// <summary>The departures of <paramref name="jarIds"/> from every account, in one query, and those accounts' names and opening dates.</summary>
    public static async Task<JarStretches> LoadAsync(IApplicationDbContext db, IEnumerable<Guid> jarIds, CancellationToken cancellationToken)
    {
        var ids = jarIds.Distinct().ToList();
        if (ids.Count == 0)
        {
            return None;
        }
        var rows = await db.JarAllocationPostings
            .AsNoTracking()
            .Where(p => p.JarId != null && ids.Contains(p.JarId.Value) && p.JarAllocation.Kind == JarAllocationKind.Departure)
            .Select(p => new { JarId = p.JarId!.Value, p.JarAllocation.AccountId, p.JarAllocation.Date, p.JarAllocation.CreatedUtc })
            .ToListAsync(cancellationToken);
        if (rows.Count == 0)
        {
            return None;
        }
        var departures = rows
            .GroupBy(r => r.JarId)
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.Date).ThenBy(r => r.CreatedUtc).Select(r => (r.AccountId, r.Date)).ToList());
        var accountIds = rows.Select(r => r.AccountId).Distinct().ToList();
        var accounts = await db.Accounts
            .AsNoTracking()
            .Where(a => accountIds.Contains(a.Id))
            .Select(a => new { a.Id, a.Name, a.OpeningDate })
            .ToDictionaryAsync(a => a.Id, a => (a.Name, a.OpeningDate), cancellationToken);
        return new JarStretches(departures, accounts);
    }

    /// <summary>
    /// The day <paramref name="jarId"/> left <paramref name="accountId"/> at the end of a stretch
    /// that held it there on <paramref name="date"/> (the move day included); null when no
    /// recorded stretch did.
    /// </summary>
    public DateOnly? LeftOn(Guid jarId, Guid accountId, DateOnly date)
    {
        if (!_departures.TryGetValue(jarId, out var departures))
        {
            return null;
        }
        var closing = departures.FindIndex(d => d.AccountId == accountId && d.Date >= date);
        if (closing < 0 || (closing > 0 && departures[closing - 1].Date > date))
        {
            return null;
        }
        return departures[closing].Date;
    }

    /// <summary>
    /// The day a recorded stretch of <paramref name="jarId"/> in <paramref name="accountId"/>
    /// began, when that stretch ends on or after <paramref name="date"/> but began after it (the
    /// jar was held in another account on that date); null otherwise.
    /// </summary>
    public DateOnly? HeldElsewhereUntil(Guid jarId, Guid accountId, DateOnly date)
    {
        if (!_departures.TryGetValue(jarId, out var departures))
        {
            return null;
        }
        var closing = departures.FindIndex(d => d.AccountId == accountId && d.Date >= date);
        return closing > 0 && departures[closing - 1].Date > date ? departures[closing - 1].Date : null;
    }

    /// <summary>
    /// The name of the account a recorded stretch held <paramref name="jarId"/> in on
    /// <paramref name="date"/>, when that stretch's start is recorded too (the jar's previous
    /// departure, on or before the date); null otherwise, or when the reader can't see it. The
    /// jar's first recorded stretch may have begun after the date, in an account it carried
    /// nothing in, so its account is not named.
    /// </summary>
    public string? HeldIn(Guid jarId, DateOnly date)
    {
        if (!_departures.TryGetValue(jarId, out var departures))
        {
            return null;
        }
        var closing = departures.FindIndex(d => d.Date >= date);
        // Every departure before the closing one is dated before the date.
        return closing > 0 && _accounts.TryGetValue(departures[closing].AccountId, out var account) ? account.Name : null;
    }

    /// <summary>Whether a recorded stretch of <paramref name="jarId"/> in any account ends on or after <paramref name="date"/>.</summary>
    public bool Covers(Guid jarId, DateOnly date) =>
        _departures.TryGetValue(jarId, out var departures) && departures.Exists(d => d.Date >= date);

    /// <summary>The account's opening date, when the account has one and the reader can see it.</summary>
    public DateOnly? OpeningDateOf(Guid accountId) =>
        _accounts.TryGetValue(accountId, out var account) ? account.OpeningDate : null;

    /// <summary>The account's name, when the reader can see it.</summary>
    public string? NameOf(Guid accountId) =>
        _accounts.TryGetValue(accountId, out var account) ? account.Name : null;
}
