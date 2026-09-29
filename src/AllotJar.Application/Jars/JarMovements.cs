using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>Money arriving in an account, put into one of that account's jars (rule 78). Whatever is not named stays unallocated.</summary>
public sealed record JarAllocationInput(Guid JarId, decimal Amount);

/// <summary>
/// Writes the stored jar split of one account leg of a transaction (<see cref="JarAllocationKind.Movement"/>).
/// Incoming money (rule 78): the user's answer to "how much goes to each jar?", the remainder
/// unallocated. Outgoing money (rule 79): jar-line portions draw from their jars, and the rest
/// from the jar the user named, or unallocated. A leg whose attribution equals what the reader
/// derives on its own stores nothing, so the ledger stays the single source of truth.
/// The transaction may be unsaved; the row follows it into the same SaveChanges.
/// </summary>
public static class JarMovements
{
    /// <summary>
    /// Stores how <paramref name="amount"/> reaching <paramref name="account"/> is divided among its
    /// jars. An empty or null <paramref name="inputs"/> leaves it all unallocated (the prompt was
    /// dismissed) and clears any earlier answer, except the shares of jars that have since left
    /// the account (rule 80), which stay as recorded and are reduced only when the amount can no
    /// longer hold them.
    /// </summary>
    public static async Task ApplyIncomingAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Account account, DateOnly date,
        decimal amount, IReadOnlyList<JarAllocationInput>? inputs, string errorKey, CancellationToken cancellationToken)
    {
        var existing = await FindAsync(db, transaction.Id, account.Id, cancellationToken);
        // Shares this leg put into jars that have since left the account (rule 80): history kept
        // there, which the prompt can no longer answer for, so they stay as recorded — reduced
        // only when the corrected amount can no longer hold them.
        var kept = await KeptIncomingAsync(db, ownerId, existing, account.Id, date, cancellationToken);
        kept = ScaleToFit(kept, amount);
        var postings = kept.Where(k => k.Value != 0m).Select(k => new JarAllocationPosting { JarId = k.Key, Amount = k.Value }).ToList();
        var named = kept.Values.Sum();
        // An answer naming a kept jar is the stored share echoed back by the edit form.
        var answers = inputs?.Where(i => !kept.ContainsKey(i.JarId)).ToList();
        if (answers is { Count: > 0 })
        {
            var jars = await OwnJarsAsync(db, ownerId, account, answers.Select(i => i.JarId), errorKey, cancellationToken);
            foreach (var group in answers.Where(i => i.Amount != 0m).GroupBy(i => i.JarId))
            {
                var jar = jars[group.Key];
                var jarAmount = group.Sum(i => i.Amount);
                if (jarAmount < 0m)
                {
                    throw Validation(errorKey, $"The amount for {jar.Name} must be zero or more.");
                }
                if (jar.IsArchived)
                {
                    throw Validation(errorKey, $"{jar.Name} is archived. Restore it before putting money into it.");
                }
                named += jarAmount;
                postings.Add(new JarAllocationPosting { JarId = jar.Id, Amount = jarAmount });
            }
        }
        if (named > amount)
        {
            var keptNote = kept.Values.Sum() is var k and > 0m
                ? $" ({k:0.##} of it stays in jars that have since moved to another account)"
                : string.Empty;
            throw Validation(errorKey,
                $"The jar amounts total {named:0.##} but only {amount:0.##} {account.Currency.Value} reached {account.Name}{keptNote}.");
        }
        if (postings.Count > 0 && amount - named > 0m)
        {
            postings.Add(new JarAllocationPosting { JarId = null, Amount = amount - named });
        }
        await ReplaceAsync(db, ownerId, transaction, account.Id, date, postings, cancellationToken, existing);
    }

    /// <summary>The incoming shares <paramref name="existing"/> gave jars designated elsewhere now; refused when the leg would be dated after such a jar left.</summary>
    private static async Task<Dictionary<Guid, decimal>> KeptIncomingAsync(
        IApplicationDbContext db, string ownerId, JarAllocation? existing, Guid accountId, DateOnly date, CancellationToken cancellationToken)
    {
        var shares = existing?.Postings.Where(p => p.JarId is not null && p.Amount > 0m)
            .GroupBy(p => p.JarId!.Value).ToDictionary(g => g.Key, g => g.Sum(p => p.Amount)) ?? new Dictionary<Guid, decimal>();
        if (shares.Count == 0)
        {
            return shares;
        }
        var ids = shares.Keys.ToList();
        var departed = await db.Jars.AsNoTracking().Where(j => ids.Contains(j.Id) && j.FundingAccountId != accountId).ToListAsync(cancellationToken);
        var kept = new Dictionary<Guid, decimal>();
        foreach (var jar in departed)
        {
            if (await JarDepartures.CoveringAsync(db, ownerId, jar.Id, accountId, date, cancellationToken) is null)
            {
                var left = await JarDepartures.LastAsync(db, jar.Id, accountId, cancellationToken);
                throw JarDepartures.DatedAfterDeparture(jar.Name, left);
            }
            kept[jar.Id] = shares[jar.Id];
        }
        return kept;
    }

    /// <summary>
    /// Kept shares unchanged when they fit in <paramref name="amount"/>; otherwise each is reduced
    /// in proportion so they total exactly <paramref name="amount"/> (cents by largest remainder,
    /// ties by jar id), never below zero.
    /// </summary>
    internal static Dictionary<Guid, decimal> ScaleToFit(Dictionary<Guid, decimal> shares, decimal amount)
    {
        var total = shares.Values.Sum();
        if (total <= amount || total == 0m)
        {
            return shares;
        }
        var cents = (long)decimal.Round(amount * 100m, 0, MidpointRounding.ToZero);
        var exact = shares.OrderBy(s => s.Key).Select(s => (s.Key, Raw: s.Value * 100m * amount / total)).ToList();
        var floors = exact.Select(e => (e.Key, Cents: (long)decimal.Floor(e.Raw), Rem: e.Raw - decimal.Floor(e.Raw))).ToList();
        var left = cents - floors.Sum(f => f.Cents);
        var result = floors.ToDictionary(f => f.Key, f => f.Cents);
        foreach (var f in floors.OrderByDescending(f => f.Rem).ThenBy(f => f.Key).Take((int)left))
        {
            result[f.Key]++;
        }
        return result.ToDictionary(r => r.Key, r => r.Value / 100m);
    }

    /// <summary>
    /// Stores where an expense leaving <paramref name="account"/> comes from: each slice (or the
    /// whole line) on a jar of this account draws from that jar; everything else draws from
    /// <paramref name="paidFromJarId"/>, or from unallocated when null. Reads the transaction's
    /// current line and slices, so callers set those first. A line whose jar has since left this
    /// account (rule 80) still draws from that jar when the leg's stored operation says it did:
    /// the reader can no longer derive that on its own, so the attribution is written down again.
    /// With <paramref name="keepDepartedDraw"/> (an edit that gave no jar answer) a draw from the
    /// named jar that has since left the account is kept too. A leg drawing from a departed jar
    /// can't be dated after the day the jar left.
    /// </summary>
    /// <param name="slices">The transaction's slices when they are not yet on its collection (a split being written); null reads <c>transaction.Splits</c>.</param>
    public static async Task ApplyOutgoingAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Account account,
        Guid? paidFromJarId, string errorKey, CancellationToken cancellationToken,
        IReadOnlyCollection<TransactionSplit>? slices = null, bool keepDepartedDraw = false)
    {
        slices ??= transaction.Splits.ToList();
        var existing = await FindAsync(db, transaction.Id, account.Id, cancellationToken);
        // Jars this leg is recorded as drawing from although they are held elsewhere now: history
        // kept when the jar changed account (KeepLineAttributionAsync).
        var heldThen = existing?.Postings.Where(p => p.JarId is not null).Select(p => p.JarId!.Value).ToHashSet() ?? new HashSet<Guid>();
        var keepsHistory = false;
        var keptJars = new HashSet<Guid>();
        Guid JarFor(Guid? lineId, IReadOnlyDictionary<Guid, (Guid JarId, Guid AccountId, DateOnly? Since)> lineJars)
        {
            if (lineId is not Guid id || !lineJars.TryGetValue(id, out var line))
            {
                return Guid.Empty;
            }
            if (JarLedgerReader.HeldOn(line.AccountId, line.Since, account.Id, transaction.Date))
            {
                return line.JarId;
            }
            if (heldThen.Contains(line.JarId))
            {
                keepsHistory = true;
                keptJars.Add(line.JarId);
                return line.JarId;
            }
            return Guid.Empty;
        }

        // Portions keyed by jar; Guid.Empty is the portion on no jar line (unallocated by default).
        var portions = new Dictionary<Guid, decimal>();
        if (slices.Count > 0)
        {
            var lineIds = slices.Where(s => s.BudgetItemId is not null).Select(s => s.BudgetItemId!.Value).Distinct().ToList();
            var lineJars = await LineJarsAsync(db, lineIds, cancellationToken);
            foreach (var slice in slices)
            {
                var jarId = JarFor(slice.BudgetItemId, lineJars);
                portions[jarId] = portions.GetValueOrDefault(jarId) + slice.Amount;
            }
        }
        else if (transaction.BudgetItemId is Guid lineId)
        {
            var lineJars = await LineJarsAsync(db, new[] { lineId }, cancellationToken);
            portions[JarFor(lineId, lineJars)] = transaction.Amount;
        }
        else
        {
            portions[Guid.Empty] = transaction.Amount;
        }

        var unlined = portions.GetValueOrDefault(Guid.Empty);
        // The jar the rest of the payment was drawn from ("which jar?", rule 79) when that jar has
        // since left this account: kept while the edit names it again or leaves the answer out.
        var departedHeld = heldThen.Count == 0 ? new List<Guid>() : await db.Jars.AsNoTracking()
            .Where(j => heldThen.Contains(j.Id) && j.FundingAccountId != account.Id).Select(j => j.Id).ToListAsync(cancellationToken);
        var keptFrom = departedHeld.Where(j => !portions.ContainsKey(j)).Select(j => (Guid?)j).FirstOrDefault();
        var keepsFrom = keepDepartedDraw && keptFrom is Guid k && unlined != 0m && (paidFromJarId is null || paidFromJarId == k);
        if (keepsFrom)
        {
            keptJars.Add(keptFrom!.Value);
        }

        // A kept share is history from the stretch the jar was held here: the leg can't move past the day it left.
        foreach (var keptJar in keptJars)
        {
            if (await JarDepartures.CoveringAsync(db, ownerId, keptJar, account.Id, transaction.Date, cancellationToken) is null)
            {
                var name = await db.Jars.AsNoTracking().Where(j => j.Id == keptJar).Select(j => j.Name).FirstAsync(cancellationToken);
                throw JarDepartures.DatedAfterDeparture(name, await JarDepartures.LastAsync(db, keptJar, account.Id, cancellationToken));
            }
        }

        var postings = new List<JarAllocationPosting>();
        if (keepsFrom)
        {
            portions.Remove(Guid.Empty);
            portions[keptFrom!.Value] = portions.GetValueOrDefault(keptFrom.Value) + unlined;
            postings.AddRange(portions.Where(p => p.Value != 0m).Select(p => new JarAllocationPosting { JarId = p.Key, Amount = -p.Value }));
        }
        else if (paidFromJarId is null && keepsHistory)
        {
            postings.AddRange(portions.Where(p => p.Value != 0m)
                .Select(p => new JarAllocationPosting { JarId = p.Key == Guid.Empty ? null : p.Key, Amount = -p.Value }));
        }
        else if (paidFromJarId is Guid fromId)
        {
            if (unlined == 0m)
            {
                throw Validation(errorKey, "This payment is already on a jar's line; it draws from that jar.");
            }
            var jar = (await OwnJarsAsync(db, ownerId, account, new[] { fromId }, errorKey, cancellationToken))[fromId];
            if (jar.IsArchived)
            {
                throw Validation(errorKey, $"{jar.Name} is archived and holds nothing.");
            }
            portions.Remove(Guid.Empty);
            portions[fromId] = portions.GetValueOrDefault(fromId) + unlined;
            postings.AddRange(portions.Select(p => new JarAllocationPosting { JarId = p.Key, Amount = -p.Value }));
        }
        await ReplaceAsync(db, ownerId, transaction, account.Id, transaction.Date, postings, cancellationToken, existing);
    }

    /// <summary>
    /// Rule 80, before <paramref name="jar"/> is re-designated to another account: every payment
    /// its budget lines drew from its current account (rule 79) is written down as a stored
    /// operation on that account, exactly as the reader derives it today. The derivation looks the
    /// jar up in its current account, so once the jar names another one those payments would fall
    /// to unallocated and the account's history would change though no money moved. Legs that
    /// already carry a stored answer are left alone. Only payments dated on or before
    /// <paramref name="movedOn"/> are kept: a later one was paid while the jar was held elsewhere.
    /// Returns how many were written down. The caller saves.
    /// </summary>
    public static async Task<int> KeepLineAttributionAsync(IApplicationDbContext db, string ownerId, Jar jar, DateOnly movedOn, CancellationToken cancellationToken)
    {
        var account = await db.Accounts.AsNoTracking().FirstOrDefaultAsync(a => a.Id == jar.FundingAccountId, cancellationToken);
        if (account is null)
        {
            return 0;
        }
        var payments = await db.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == ownerId && t.Type == TransactionType.Expense && t.AccountId == account.Id
                        && t.Date <= movedOn
                        && !t.JarAllocations.Any(a => a.AccountId == account.Id)
                        && ((t.BudgetItem != null && t.BudgetItem.SavingsId == jar.Id)
                            || t.Splits.Any(s => s.BudgetItem != null && s.BudgetItem.SavingsId == jar.Id)))
            .ToListAsync(cancellationToken);
        if (payments.Count == 0)
        {
            return 0;
        }
        var jars = await db.Jars.AsNoTracking().Where(j => j.OwnerId == ownerId).ToDictionaryAsync(j => j.Id, cancellationToken);
        var lineJars = await JarLedgerReader.LineJarsAsync(db, ownerId, cancellationToken);
        foreach (var payment in payments)
        {
            var postings = JarLedgerReader.Derive(payment, account, -payment.Amount, lineJars, jars);
            db.JarAllocations.Add(new JarAllocation
            {
                OwnerId = ownerId,
                AccountId = account.Id,
                Kind = JarAllocationKind.Movement,
                Date = payment.Date,
                TransactionId = payment.Id,
                CreatedUtc = DateTime.UtcNow,
                Postings = postings.Select(p => new JarAllocationPosting { JarId = p.JarId, Amount = p.Amount }).ToList(),
            });
        }
        return payments.Count;
    }

    /// <summary>Drops the stored split of one leg, so the reader falls back to its derived attribution.</summary>
    public static Task ClearAsync(IApplicationDbContext db, Transaction transaction, Guid accountId, CancellationToken cancellationToken) =>
        ReplaceAsync(db, transaction.OwnerId, transaction, accountId, transaction.Date, new List<JarAllocationPosting>(), cancellationToken);

    /// <summary>True when the account backs at least one jar (the prompts only apply there).</summary>
    public static Task<bool> BacksJarsAsync(IApplicationDbContext db, string ownerId, Guid accountId, CancellationToken cancellationToken) =>
        db.Jars.AnyAsync(j => j.OwnerId == ownerId && j.FundingAccountId == accountId && !j.IsArchived, cancellationToken);

    private static Task<JarAllocation?> FindAsync(IApplicationDbContext db, Guid transactionId, Guid accountId, CancellationToken cancellationToken) =>
        db.JarAllocations
            .Include(a => a.Postings)
            .FirstOrDefaultAsync(a => a.TransactionId == transactionId && a.AccountId == accountId, cancellationToken);

    /// <param name="existing">The leg's stored operation when the caller already loaded it; null loads it.</param>
    private static async Task ReplaceAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Guid accountId, DateOnly date,
        List<JarAllocationPosting> postings, CancellationToken cancellationToken, JarAllocation? existing = null)
    {
        existing ??= await FindAsync(db, transaction.Id, accountId, cancellationToken);
        // Rule 80: a change in the share of a jar that has left this account is settled on the
        // departure, so the account still holds nothing of the jar from the day it left.
        await JarDepartures.SettleAsync(db, ownerId, accountId,
            existing?.Date ?? date, existing?.Postings.Select(p => (p.JarId, p.Amount)).ToList() ?? new List<(Guid?, decimal)>(),
            date, postings.Select(p => (p.JarId, p.Amount)).ToList(), cancellationToken);
        if (postings.Count == 0)
        {
            if (existing is not null)
            {
                db.JarAllocations.Remove(existing);
            }
            return;
        }
        if (existing is null)
        {
            var allocation = new JarAllocation
            {
                OwnerId = ownerId,
                AccountId = accountId,
                Kind = JarAllocationKind.Movement,
                Date = date,
                Transaction = transaction,
                CreatedUtc = DateTime.UtcNow,
                Postings = postings,
            };
            transaction.JarAllocations.Add(allocation);
            db.JarAllocations.Add(allocation);
            return;
        }
        // Update in place: the (transaction, account) index is unique, so a delete-and-insert in
        // one SaveChanges would depend on statement ordering. The new postings are added through
        // the set explicitly: discovered only through the navigation, an entity whose Guid key is
        // already set would be tracked as Modified and the save would issue an UPDATE for a row
        // that was never inserted.
        db.JarAllocationPostings.RemoveRange(existing.Postings);
        existing.Postings.Clear();
        existing.Date = date;
        foreach (var posting in postings)
        {
            posting.JarAllocationId = existing.Id;
            posting.JarAllocation = existing;
            existing.Postings.Add(posting);
            db.JarAllocationPostings.Add(posting);
        }
    }

    private static async Task<Dictionary<Guid, Jar>> OwnJarsAsync(
        IApplicationDbContext db, string ownerId, Account account, IEnumerable<Guid> jarIds, string errorKey,
        CancellationToken cancellationToken)
    {
        var ids = jarIds.Distinct().ToList();
        var jars = await db.Jars.AsNoTracking().Where(j => ids.Contains(j.Id)).ToDictionaryAsync(j => j.Id, cancellationToken);
        foreach (var id in ids)
        {
            if (!jars.TryGetValue(id, out var jar))
            {
                throw new NotFoundException($"Jar {id} was not found.");
            }
            if (jar.OwnerId != ownerId)
            {
                throw new ForbiddenAccessException();
            }
            if (jar.FundingAccountId != account.Id)
            {
                throw Validation(errorKey, $"{jar.Name}'s money is not held in {account.Name}.");
            }
        }
        return jars;
    }

    /// <summary>Budget line → the jar whose savings line it is, the account that holds the jar now and the day it moved there (rule 79).</summary>
    private static async Task<Dictionary<Guid, (Guid JarId, Guid AccountId, DateOnly? Since)>> LineJarsAsync(
        IApplicationDbContext db, IReadOnlyCollection<Guid> lineIds, CancellationToken cancellationToken)
    {
        if (lineIds.Count == 0)
        {
            return new Dictionary<Guid, (Guid, Guid, DateOnly?)>();
        }
        return await db.BudgetItems
            .AsNoTracking()
            .Where(i => lineIds.Contains(i.Id) && i.SavingsId != null && i.Jar != null)
            .Select(i => new { i.Id, JarId = i.SavingsId!.Value, i.Jar!.FundingAccountId, i.Jar.FundingAccountSince })
            .ToDictionaryAsync(x => x.Id, x => (x.JarId, x.FundingAccountId, x.FundingAccountSince), cancellationToken);
    }

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
