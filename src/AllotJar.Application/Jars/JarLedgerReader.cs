using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>
/// One jar-backed account's actual-money position as of a date (rules 1–6, 70): the account
/// balance read through <see cref="ActualAccountLedger"/>, each jar's allocated balance and the
/// unallocated remainder, from the stored <see cref="JarAllocation"/> operations plus the
/// budget-line attribution derived for every other movement (rule 79). Null balances mean
/// unavailable (no opening date, or as-of before it; rule 67), never zero.
/// </summary>
public sealed record JarLedgerView(
    DateOnly AsOf,
    Account Account,
    SavingsLedgerBalance Ledger,
    bool OpeningDateMissing,
    int UnreconciledAllocations)
{
    public bool IsAvailable => Ledger.IsAvailable;
    public decimal? AccountBalance => Ledger.AccountBalance;
    public decimal? Unallocated => Ledger.Unallocated;
    public IReadOnlyDictionary<Guid, decimal> JarBalances => Ledger.JarBalances ?? new Dictionary<Guid, decimal>();
    public decimal PositiveAllocations => Ledger.PositiveAllocations;
    public bool HasBackingDeficit => Ledger.HasBackingDeficit;
    public bool RequiresReview => Ledger.RequiresReview;
}

/// <summary>Every jar-backed account of one owner as of a date, with a per-jar balance lookup.</summary>
public sealed record JarLedgerSnapshot(
    DateOnly AsOf,
    IReadOnlyDictionary<Guid, JarLedgerView> Accounts,
    IReadOnlyDictionary<Guid, Jar> Jars,
    bool IsComplete = true)
{
    /// <summary>
    /// The jar's balance as of the date: what its allocations put in its designated account plus
    /// what they left in any account it was designated to before (rule 80 — the history stays in
    /// the old account's ledger, so a date before the change reads the balance it held there
    /// then, and from the day it left the account's Departure operation makes its postings there
    /// sum to zero, <see cref="JarDepartures"/>). Every reader and zero check reads this one
    /// figure, so a snapshot restricted to some accounts throws rather than answer. Null when its designated
    /// account has no opening date, or had not opened on the date and no other account's ledger
    /// carries the jar on it (rule 67); an account not yet open on the date held nothing of it.
    /// </summary>
    public decimal? BalanceOf(Guid jarId)
    {
        if (!IsComplete)
        {
            throw new InvalidOperationException("A jar's balance is read from every account that may carry it: read the ledger without accountIds.");
        }
        if (!Jars.TryGetValue(jarId, out var jar) || !Accounts.TryGetValue(jar.FundingAccountId, out var view) || view.OpeningDateMissing)
        {
            return null;
        }
        var held = Accounts.Values.Where(a => a.IsAvailable && a.JarBalances.ContainsKey(jarId)).ToList();
        if (held.Count == 0)
        {
            return null;
        }
        return held.Sum(a => a.JarBalances[jarId]);
    }

    public JarLedgerView? AccountOf(Guid jarId) =>
        Jars.TryGetValue(jarId, out var jar) && Accounts.TryGetValue(jar.FundingAccountId, out var view) ? view : null;
}

/// <summary>
/// The single read path for jar money. Every jar, budget-grid, reconciliation and month-seeding
/// reader goes through here so nothing re-derives a jar balance from plans or raw sums.
/// </summary>
public static class JarLedgerReader
{
    /// <param name="accountIds">Restrict to these accounts; null reads every account that backs a jar.</param>
    public static async Task<JarLedgerSnapshot> ReadAsync(
        IApplicationDbContext db,
        string ownerId,
        DateOnly asOf,
        CancellationToken cancellationToken,
        IReadOnlyCollection<Guid>? accountIds = null)
    {
        // Archived jars still own money and stay in every ledger (rule 26 makes them zero).
        var jars = await db.Jars
            .AsNoTracking()
            .Where(j => j.OwnerId == ownerId)
            .ToListAsync(cancellationToken);
        var jarsById = jars.ToDictionary(j => j.Id);

        // Every account that holds a jar, plus any that still carries allocation history from a
        // jar since re-designated elsewhere (rule 80): its ledger stays readable.
        var backedIds = jars.Select(j => j.FundingAccountId).Distinct().ToHashSet();
        backedIds.UnionWith(await db.JarAllocations
            .AsNoTracking()
            .Where(a => a.OwnerId == ownerId)
            .Select(a => a.AccountId)
            .Distinct()
            .ToListAsync(cancellationToken));
        if (accountIds is not null)
        {
            backedIds.IntersectWith(accountIds);
        }
        var views = new Dictionary<Guid, JarLedgerView>();
        if (backedIds.Count == 0)
        {
            return new JarLedgerSnapshot(asOf, views, jarsById, accountIds is null);
        }

        var accounts = await db.Accounts
            .AsNoTracking()
            .Where(a => a.OwnerId == ownerId && backedIds.Contains(a.Id))
            .ToListAsync(cancellationToken);
        var ids = accounts.Select(a => a.Id).ToList();

        var transactions = await db.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == ownerId
                        && ((t.AccountId != null && ids.Contains(t.AccountId.Value))
                            || (t.Type == TransactionType.Transfer
                                && t.TransferAccountId != null
                                && ids.Contains(t.TransferAccountId.Value))))
            .ToListAsync(cancellationToken);
        var readable = transactions
            .Where(t => t.Type != TransactionType.Transfer
                        || (t.AccountId is not null && t.TransferAccountId is not null))
            .ToList();
        var postingDates = TransferLedger.PostingDates(readable);
        var byId = readable.ToDictionary(t => t.Id);

        var lineJars = await LineJarsAsync(db, ownerId, cancellationToken);

        var stored = await db.JarAllocations
            .AsNoTracking()
            .Include(a => a.Postings)
            .Where(a => a.OwnerId == ownerId && ids.Contains(a.AccountId))
            .ToListAsync(cancellationToken);

        foreach (var account in accounts)
        {
            if (account.OpeningDate is not DateOnly openingDate)
            {
                views[account.Id] = new JarLedgerView(asOf, account, new SavingsLedgerBalance(asOf, null, null, null), true, 0);
                continue;
            }
            if (asOf < openingDate)
            {
                views[account.Id] = new JarLedgerView(asOf, account, new SavingsLedgerBalance(asOf, null, null, null), false, 0);
                continue;
            }

            var entries = ActualAccountLedger.Entries(account, openingDate, asOf, readable, postingDates);
            var operations = new List<JarLedgerOperation>();
            var attributed = new HashSet<Guid>();
            var unreconciled = 0;

            foreach (var op in stored.Where(a => a.AccountId == account.Id))
            {
                if (op.TransactionId is Guid transactionId)
                {
                    // The transaction's own posting date and amount govern; a stored operation
                    // that no longer matches its transaction is set aside (counted for review)
                    // and the movement falls back to its budget-line attribution.
                    if (!entries.Movements.TryGetValue(transactionId, out var movement))
                    {
                        continue;
                    }
                    if (op.Postings.Sum(p => p.Amount) != movement.Amount || !attributed.Add(transactionId))
                    {
                        unreconciled++;
                        continue;
                    }
                    operations.Add(new JarLedgerOperation(op.Id, op.OwnerId, op.AccountId, movement.Date, transactionId,
                        op.Postings.Select(p => new JarLedgerPosting(p.JarId, p.Amount)).ToList()));
                }
                else
                {
                    if (op.Date < openingDate || op.Date > asOf)
                    {
                        continue;
                    }
                    operations.Add(new JarLedgerOperation(op.Id, op.OwnerId, op.AccountId, op.Date, null,
                        op.Postings.Select(p => new JarLedgerPosting(p.JarId, p.Amount)).ToList()));
                }
            }

            foreach (var (transactionId, movement) in entries.Movements)
            {
                if (attributed.Contains(transactionId))
                {
                    continue;
                }
                operations.Add(new JarLedgerOperation(
                    Guid.NewGuid(), ownerId, account.Id, movement.Date, transactionId,
                    Derive(byId[transactionId], account, movement.Amount, lineJars, jarsById)));
            }

            var ledger = ActualSavingsLedger.Calculate(account, openingDate, asOf, jars, readable, operations, postingDates);
            views[account.Id] = new JarLedgerView(asOf, account, ledger, false, unreconciled);
        }

        return new JarLedgerSnapshot(asOf, views, jarsById, accountIds is null);
    }

    /// <summary>Budget line → jar, for the derived attribution of expenses (rule 79).</summary>
    internal static async Task<Dictionary<Guid, Guid>> LineJarsAsync(IApplicationDbContext db, string ownerId, CancellationToken cancellationToken) =>
        (await db.BudgetItems
            .AsNoTracking()
            .Join(db.BudgetCategories, i => i.BudgetCategoryId, c => c.Id, (i, c) => new { i, c })
            .Join(db.BudgetMonths, x => x.c.BudgetMonthId, m => m.Id, (x, m) => new { x.i, m })
            .Where(x => x.m.OwnerId == ownerId && x.i.SavingsId != null)
            .Select(x => new { x.i.Id, SavingsId = x.i.SavingsId!.Value })
            .ToListAsync(cancellationToken))
        .ToDictionary(x => x.Id, x => x.SavingsId);

    /// <summary>
    /// Rule 79: an expense from a jar-backed account draws from the jar its budget line (or each
    /// split slice's line) names, otherwise from unallocated. Incoming money and transfer legs
    /// without a stored allocation are unallocated (rule 78 stores the user's answer).
    /// <paramref name="movement"/> is the leg's signed amount (an expense is negative).
    /// </summary>
    internal static IReadOnlyList<JarLedgerPosting> Derive(
        Transaction transaction, Account account, decimal movement,
        IReadOnlyDictionary<Guid, Guid> lineJars, IReadOnlyDictionary<Guid, Jar> jars)
    {
        if (transaction.Type != TransactionType.Expense || transaction.AccountId != account.Id)
        {
            return new[] { new JarLedgerPosting(null, movement) };
        }

        Guid? JarFor(Guid? budgetItemId) =>
            budgetItemId is Guid itemId
            && lineJars.TryGetValue(itemId, out var jarId)
            && jars.TryGetValue(jarId, out var jar)
            && jar.FundingAccountId == account.Id
                ? jarId
                : null;

        if (transaction.Splits.Count > 0)
        {
            var postings = transaction.Splits
                .GroupBy(s => JarFor(s.BudgetItemId))
                .Select(g => new JarLedgerPosting(g.Key, -g.Sum(s => s.Amount)))
                .ToList();
            // Slices sum to the parent by invariant; guard the ledger's exact-conservation check
            // against any historical drift by settling the difference on unallocated.
            var drift = movement - postings.Sum(p => p.Amount);
            if (drift != 0m)
            {
                postings.Add(new JarLedgerPosting(null, drift));
            }
            return postings;
        }

        return new[] { new JarLedgerPosting(JarFor(transaction.BudgetItemId), movement) };
    }

    /// <summary>The candidate ledger after applying zero-sum <paramref name="postings"/> to <paramref name="view"/>, for rule 68/70 checks before persisting.</summary>
    public static SavingsLedgerBalance Apply(JarLedgerView view, IReadOnlyList<JarLedgerPosting> postings)
    {
        if (!view.IsAvailable || view.Ledger.JarBalances is null || view.Ledger.Unallocated is null)
        {
            throw new InvalidOperationException("The account balance is unavailable for this date.");
        }
        var jars = new Dictionary<Guid, decimal>(view.Ledger.JarBalances);
        var unallocated = view.Ledger.Unallocated.Value;
        foreach (var posting in postings)
        {
            if (posting.JarId is Guid jarId)
            {
                jars[jarId] = jars.GetValueOrDefault(jarId) + posting.Amount;
            }
            else
            {
                unallocated += posting.Amount;
            }
        }
        return new SavingsLedgerBalance(view.AsOf, view.AccountBalance, jars, unallocated)
        {
            PendingTransferReceipts = view.Ledger.PendingTransferReceipts,
        };
    }
}
