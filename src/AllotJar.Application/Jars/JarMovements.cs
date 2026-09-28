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
    /// dismissed) and clears any earlier answer.
    /// </summary>
    public static async Task ApplyIncomingAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Account account, DateOnly date,
        decimal amount, IReadOnlyList<JarAllocationInput>? inputs, string errorKey, CancellationToken cancellationToken)
    {
        var postings = new List<JarAllocationPosting>();
        if (inputs is { Count: > 0 })
        {
            var jars = await OwnJarsAsync(db, ownerId, account, inputs.Select(i => i.JarId), errorKey, cancellationToken);
            var named = 0m;
            foreach (var group in inputs.Where(i => i.Amount != 0m).GroupBy(i => i.JarId))
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
            if (named > amount)
            {
                throw Validation(errorKey,
                    $"The jar amounts total {named:0.##} but only {amount:0.##} {account.Currency.Value} reached {account.Name}.");
            }
            if (postings.Count > 0 && amount - named > 0m)
            {
                postings.Add(new JarAllocationPosting { JarId = null, Amount = amount - named });
            }
        }
        await ReplaceAsync(db, ownerId, transaction, account.Id, date, postings, cancellationToken);
    }

    /// <summary>
    /// Stores where an expense leaving <paramref name="account"/> comes from: each slice (or the
    /// whole line) on a jar of this account draws from that jar; everything else draws from
    /// <paramref name="paidFromJarId"/>, or from unallocated when null. Reads the transaction's
    /// current line and slices, so callers set those first.
    /// </summary>
    /// <param name="slices">The transaction's slices when they are not yet on its collection (a split being written); null reads <c>transaction.Splits</c>.</param>
    public static async Task ApplyOutgoingAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Account account,
        Guid? paidFromJarId, string errorKey, CancellationToken cancellationToken,
        IReadOnlyCollection<TransactionSplit>? slices = null)
    {
        slices ??= transaction.Splits.ToList();
        // Portions keyed by jar; Guid.Empty is the portion on no jar line (unallocated by default).
        var portions = new Dictionary<Guid, decimal>();
        if (slices.Count > 0)
        {
            var lineIds = slices.Where(s => s.BudgetItemId is not null).Select(s => s.BudgetItemId!.Value).Distinct().ToList();
            var lineJars = await LineJarsAsync(db, lineIds, account.Id, cancellationToken);
            foreach (var slice in slices)
            {
                var jarId = slice.BudgetItemId is Guid lineId && lineJars.TryGetValue(lineId, out var j) ? j : Guid.Empty;
                portions[jarId] = portions.GetValueOrDefault(jarId) + slice.Amount;
            }
        }
        else if (transaction.BudgetItemId is Guid lineId)
        {
            var lineJars = await LineJarsAsync(db, new[] { lineId }, account.Id, cancellationToken);
            portions[lineJars.TryGetValue(lineId, out var j) ? j : Guid.Empty] = transaction.Amount;
        }
        else
        {
            portions[Guid.Empty] = transaction.Amount;
        }

        var unlined = portions.GetValueOrDefault(Guid.Empty);
        var postings = new List<JarAllocationPosting>();
        if (paidFromJarId is Guid fromId)
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
        await ReplaceAsync(db, ownerId, transaction, account.Id, transaction.Date, postings, cancellationToken);
    }

    /// <summary>
    /// Rule 80, before <paramref name="jar"/> is re-designated to another account: every payment
    /// its budget lines drew from its current account (rule 79) is written down as a stored
    /// operation on that account, exactly as the reader derives it today. The derivation looks the
    /// jar up in its current account, so once the jar names another one those payments would fall
    /// to unallocated and the account's history would change though no money moved. Legs that
    /// already carry a stored answer are left alone. The caller saves.
    /// </summary>
    public static async Task KeepLineAttributionAsync(IApplicationDbContext db, string ownerId, Jar jar, CancellationToken cancellationToken)
    {
        var account = await db.Accounts.AsNoTracking().FirstOrDefaultAsync(a => a.Id == jar.FundingAccountId, cancellationToken);
        if (account is null)
        {
            return;
        }
        var payments = await db.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == ownerId && t.Type == TransactionType.Expense && t.AccountId == account.Id
                        && !t.JarAllocations.Any(a => a.AccountId == account.Id)
                        && ((t.BudgetItem != null && t.BudgetItem.SavingsId == jar.Id)
                            || t.Splits.Any(s => s.BudgetItem != null && s.BudgetItem.SavingsId == jar.Id)))
            .ToListAsync(cancellationToken);
        if (payments.Count == 0)
        {
            return;
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
    }

    /// <summary>Drops the stored split of one leg, so the reader falls back to its derived attribution.</summary>
    public static Task ClearAsync(IApplicationDbContext db, Transaction transaction, Guid accountId, CancellationToken cancellationToken) =>
        ReplaceAsync(db, transaction.OwnerId, transaction, accountId, transaction.Date, new List<JarAllocationPosting>(), cancellationToken);

    /// <summary>True when the account backs at least one jar (the prompts only apply there).</summary>
    public static Task<bool> BacksJarsAsync(IApplicationDbContext db, string ownerId, Guid accountId, CancellationToken cancellationToken) =>
        db.Jars.AnyAsync(j => j.OwnerId == ownerId && j.FundingAccountId == accountId && !j.IsArchived, cancellationToken);

    private static async Task ReplaceAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Guid accountId, DateOnly date,
        List<JarAllocationPosting> postings, CancellationToken cancellationToken)
    {
        var existing = await db.JarAllocations
            .Include(a => a.Postings)
            .FirstOrDefaultAsync(a => a.TransactionId == transaction.Id && a.AccountId == accountId, cancellationToken);
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

    /// <summary>Budget line → jar, for lines that are a jar's savings line held in this account (rule 79).</summary>
    private static async Task<Dictionary<Guid, Guid>> LineJarsAsync(
        IApplicationDbContext db, IReadOnlyCollection<Guid> lineIds, Guid accountId, CancellationToken cancellationToken)
    {
        if (lineIds.Count == 0)
        {
            return new Dictionary<Guid, Guid>();
        }
        return await db.BudgetItems
            .AsNoTracking()
            .Where(i => lineIds.Contains(i.Id) && i.SavingsId != null && i.Jar != null && i.Jar.FundingAccountId == accountId)
            .Select(i => new { i.Id, JarId = i.SavingsId!.Value })
            .ToDictionaryAsync(x => x.Id, x => x.JarId, cancellationToken);
    }

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
