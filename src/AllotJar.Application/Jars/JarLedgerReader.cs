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
    /// <summary>
    /// The jars this account's ledger carries on any date (a stored posting, a departure
    /// included), not only by <see cref="AsOf"/>: on a date before the jar's first posting here,
    /// an open account that held it then holds 0 of it (P2-15).
    /// </summary>
    public IReadOnlySet<Guid> CarriedJars { get; init; } = new HashSet<Guid>();

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
    /// carries the jar (rule 67); an account not yet open on the date held nothing of it. An open
    /// account whose ledger carries the jar on some date holds 0 of it before the first (P2-15).
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
        var held = Accounts.Values
            .Where(a => a.IsAvailable && (a.JarBalances.ContainsKey(jarId) || a.CarriedJars.Contains(jarId)))
            .ToList();
        if (held.Count == 0)
        {
            return null;
        }
        return held.Sum(a => a.JarBalances.GetValueOrDefault(jarId));
    }

    public JarLedgerView? AccountOf(Guid jarId) =>
        Jars.TryGetValue(jarId, out var jar) && Accounts.TryGetValue(jar.FundingAccountId, out var view) ? view : null;
}

/// <summary>
/// The single read path for jar money. Every jar, budget-grid, reconciliation and month-seeding
/// reader goes through here so nothing re-derives a jar balance from plans or raw sums. The rows
/// are loaded once (<see cref="LoadAsync"/>) and read as of any date in memory
/// (<see cref="JarLedgerSource.At"/>), so a caller that needs several dates loads the ledger once
/// (P3-6, P3-10).
/// </summary>
public static class JarLedgerReader
{
    /// <param name="accountIds">Restrict to these accounts; null reads every account that backs a jar.</param>
    public static async Task<JarLedgerSnapshot> ReadAsync(
        IApplicationDbContext db,
        string ownerId,
        DateOnly asOf,
        CancellationToken cancellationToken,
        IReadOnlyCollection<Guid>? accountIds = null) =>
        (await LoadAsync(db, ownerId, cancellationToken, accountIds)).At(asOf);

    /// <summary>Loads the owner's jar ledger rows (every date) for reading as of any date.</summary>
    /// <param name="accountIds">Restrict to these accounts; null reads every account that backs a jar.</param>
    /// <param name="includeUnbacked">Read <paramref name="accountIds"/> even when no jar uses them yet (every movement unallocated).</param>
    /// <param name="excludeTransactionIds">Read the ledger as if these transactions (and their stored jar answers) did not exist, to check an edit of them.</param>
    public static async Task<JarLedgerSource> LoadAsync(
        IApplicationDbContext db,
        string ownerId,
        CancellationToken cancellationToken,
        IReadOnlyCollection<Guid>? accountIds = null,
        bool includeUnbacked = false,
        IReadOnlyCollection<Guid>? excludeTransactionIds = null)
    {
        // Archived jars still own money and stay in every ledger (rule 26 makes them zero).
        var jars = await db.Jars
            .AsNoTracking()
            .Where(j => j.OwnerId == ownerId)
            .ToListAsync(cancellationToken);

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
            if (includeUnbacked)
            {
                backedIds.UnionWith(accountIds);
            }
            backedIds.IntersectWith(accountIds);
        }
        if (backedIds.Count == 0)
        {
            return new JarLedgerSource(ownerId, jars, new List<Account>(), new List<Transaction>(),
                new Dictionary<Guid, Guid>(), new List<JarAllocation>(), accountIds is null);
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
        if (excludeTransactionIds is { Count: > 0 })
        {
            // A stored answer on an excluded transaction is dropped with it: the reader keeps a
            // transaction-linked operation only while its transaction is read.
            transactions = transactions.Where(t => !excludeTransactionIds.Contains(t.Id)).ToList();
        }

        var lineJars = await LineJarsAsync(db, ownerId, cancellationToken);

        var stored = await db.JarAllocations
            .AsNoTracking()
            .Include(a => a.Postings)
            .Where(a => a.OwnerId == ownerId && ids.Contains(a.AccountId))
            .ToListAsync(cancellationToken);

        return new JarLedgerSource(ownerId, jars, accounts, transactions, lineJars, stored, accountIds is null);
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
    /// without a stored allocation are unallocated (rule 78 stores the user's answer). A line's
    /// jar is drawn from only while the account held it: a payment dated before the day the jar
    /// moved into the account drew from unallocated (<see cref="HeldOn"/>, P2-20).
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
            && HeldOn(jar.FundingAccountId, jar.FundingAccountSince, account.Id, transaction.Date)
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

    /// <summary>
    /// Whether a jar designated to <paramref name="designated"/> since <paramref name="since"/>
    /// (null: since it was created) was held in <paramref name="accountId"/> on
    /// <paramref name="date"/>, for a payment on its line (rule 79). The move day belongs to the
    /// new account, the only one a payment on the jar's line can be recorded from from then on
    /// (TransactionInvariants): its payments that day draw from the jar. The old account's
    /// payments up to that day were written down there at the move, and so were the new
    /// account's, which drew from its unallocated money (P2-20); one the old account made then
    /// and entered later is written down on the jar there when it is recorded (R2-D1).
    /// </summary>
    internal static bool HeldOn(Guid designated, DateOnly? since, Guid accountId, DateOnly date) =>
        designated == accountId && (since is not { } from || date >= from);

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

/// <summary>
/// One owner's jar ledger rows as loaded by <see cref="JarLedgerReader.LoadAsync"/>: read as of
/// any date without touching the database again. A write that changes the ledger needs a fresh
/// load to see it.
/// </summary>
/// <summary>One jar's share of one expense (or refund) on its date, as <see cref="JarLedgerSource.SpendingBetween"/> reads it: a positive amount paid out of the jar, or a positive amount refunded back into it.</summary>
public readonly record struct JarSpendingPosting(Guid JarId, DateOnly Date, decimal Amount, bool IsRefund);

/// <summary>One signed jar posting as <see cref="JarLedgerSource.JarPostings"/> reads it, with what it came from.</summary>
public readonly record struct JarPostingRead(
    Guid JarId, DateOnly Date, Transaction? Transaction, JarAllocationKind? Kind, Transaction? ReturnOf, decimal Amount);

public sealed class JarLedgerSource
{
    private readonly string _ownerId;
    private readonly List<Jar> _jars;
    private readonly Dictionary<Guid, Jar> _jarsById;
    private readonly List<Account> _accounts;
    private readonly List<Transaction> _readable;
    private readonly IReadOnlyDictionary<Guid, TransferPostingDates> _postingDates;
    private readonly Dictionary<Guid, Transaction> _byId;
    private readonly Dictionary<Guid, Guid> _returnLegs;
    private readonly IReadOnlyDictionary<Guid, Guid> _lineJars;
    private readonly List<JarAllocation> _stored;
    private readonly Dictionary<Guid, HashSet<Guid>> _carried;
    private readonly bool _isComplete;

    internal JarLedgerSource(
        string ownerId, List<Jar> jars, List<Account> accounts, List<Transaction> transactions,
        IReadOnlyDictionary<Guid, Guid> lineJars, List<JarAllocation> stored, bool isComplete)
    {
        _ownerId = ownerId;
        _jars = jars;
        _jarsById = jars.ToDictionary(j => j.Id);
        _accounts = accounts;
        _readable = transactions
            .Where(t => t.Type != TransactionType.Transfer
                        || (t.AccountId is not null && t.TransferAccountId is not null))
            .ToList();
        _postingDates = TransferLedger.PostingDates(_readable);
        _byId = _readable.ToDictionary(t => t.Id);
        _returnLegs = _readable
            .Where(t => t.Type == TransactionType.Transfer && t.ReturnedOn is not null)
            .ToDictionary(t => TransferLedger.ReturnLegId(t.Id), t => t.Id);
        _lineJars = lineJars;
        _stored = stored;
        _carried = stored
            .GroupBy(a => a.AccountId)
            .ToDictionary(g => g.Key, g => g.SelectMany(a => a.Postings).Where(p => p.JarId is not null).Select(p => p.JarId!.Value).ToHashSet());
        _isComplete = isComplete;
    }

    /// <summary>Every jar of the owner, archived ones included (they still own history).</summary>
    public IReadOnlyList<Jar> Jars => _jars;

    /// <summary>The currency of a loaded account, or null when it was not loaded.</summary>
    public string? AccountCurrency(Guid accountId) =>
        _accounts.FirstOrDefault(a => a.Id == accountId)?.Currency.Value;

    /// <summary>Every jar-backed account as of <paramref name="asOf"/>.</summary>
    public JarLedgerSnapshot At(DateOnly asOf)
    {
        var views = _accounts.ToDictionary(a => a.Id, a => ViewOf(a, asOf));
        return new JarLedgerSnapshot(asOf, views, _jarsById, _isComplete);
    }

    /// <summary>One loaded account as of <paramref name="asOf"/>, or null when it was not loaded.</summary>
    public JarLedgerView? ViewAt(Guid accountId, DateOnly asOf) =>
        _accounts.FirstOrDefault(a => a.Id == accountId) is { } account ? ViewOf(account, asOf) : null;

    /// <summary>
    /// <see cref="ViewAt"/> for one pass over many dates of one account, as the history checks
    /// read it on every date it has an operation. From the second date, the account's whole
    /// ledger is walked once (<see cref="AccountTimeline"/>) and each date is looked up in it,
    /// instead of the ledger being rebuilt from the opening for every date (quadratic: seconds on
    /// years of daily rows, #297 P3-2). The walk reads the loaded rows as they are when it is
    /// made: a caller that changes them (a new opening balance) takes a new viewer after.
    /// </summary>
    public Func<DateOnly, JarLedgerView?> Viewer(Guid accountId)
    {
        if (_accounts.FirstOrDefault(a => a.Id == accountId) is not { } account)
        {
            return _ => null;
        }
        var reads = 0;
        AccountTimeline? timeline = null;
        var built = false;
        return asOf =>
        {
            if (++reads < 2 || account.OpeningDate is not DateOnly openingDate || asOf < openingDate)
            {
                return ViewOf(account, asOf);
            }
            if (!built)
            {
                timeline = AccountTimeline.Build(this, account, openingDate);
                built = true;
            }
            return timeline?.ViewAt(asOf) ?? ViewOf(account, asOf);
        };
    }

    /// <summary>
    /// The ledger of one account walked once from its opening: the balances after each date that
    /// has an operation, so a view on any date is a lookup. It gives exactly what
    /// <see cref="ViewOf"/> gives. An operation counts on a date when it is dated on or before it,
    /// whichever date the ledger is read to (each operation's date is its transaction's own
    /// posting date), and every balance is a sum of the operations counted. What does depend on
    /// the date read to, a transfer still waiting for its receipt, is worked out for that date.
    /// A ledger the checks of <see cref="ActualSavingsLedger.Calculate"/> refuse has no timeline:
    /// its views are read the slow way, which refuses on the same dates as before.
    /// </summary>
    private sealed class AccountTimeline
    {
        private JarLedgerSource _source = null!;
        private Account _account = null!;
        private DateOnly _openingDate;
        private List<Guid> _designated = null!;
        private DateOnly[] _dates = null!;
        private decimal[] _balances = null!;
        private decimal[] _unallocated = null!;
        private Dictionary<Guid, decimal>[] _jars = null!;
        // Jars posted to here that do not designate the account, with where each is first posted
        // (the order Calculate adds them in): (date, position in the operations).
        private Dictionary<Guid, List<(DateOnly Date, int Position)>> _extras = null!;
        private DateOnly[] _unreconciled = null!;
        private List<Transaction> _waitingReceipts = null!;
        private HashSet<Guid> _carried = null!;

        public static AccountTimeline? Build(JarLedgerSource source, Account account, DateOnly openingDate)
        {
            var unreconciledDates = new List<DateOnly>();
            var (all, _, _) = source.OperationsOf(account, openingDate, DateOnly.MaxValue, unreconciledDates);
            var operations = all
                .Where(o => o.OwnerId == account.OwnerId && o.AccountId == account.Id && o.Date >= openingDate)
                .ToList();
            var last = operations.Count == 0 ? openingDate : operations.Max(o => o.Date);
            if (last < openingDate)
            {
                last = openingDate;
            }
            try
            {
                // The whole history passes Calculate's checks, so every date's part of it does.
                ActualSavingsLedger.Calculate(account, openingDate, last, source._jars, source._readable, operations, source._postingDates);
            }
            catch (InvalidOperationException)
            {
                return null;
            }

            var timeline = new AccountTimeline
            {
                _source = source,
                _account = account,
                _openingDate = openingDate,
                _designated = source._jars.Where(j => j.OwnerId == account.OwnerId && j.FundingAccountId == account.Id).Select(j => j.Id).ToList(),
                _extras = new(),
                _unreconciled = unreconciledDates.Order().ToArray(),
                _carried = source._carried.TryGetValue(account.Id, out var jarIds) ? jarIds : new HashSet<Guid>(),
            };
            var designated = timeline._designated.ToHashSet();
            var position = 0;
            foreach (var operation in operations)
            {
                foreach (var posting in operation.Postings)
                {
                    if (posting.JarId is Guid jarId && !designated.Contains(jarId))
                    {
                        if (!timeline._extras.TryGetValue(jarId, out var firsts))
                        {
                            timeline._extras[jarId] = firsts = new();
                        }
                        firsts.Add((operation.Date, position));
                    }
                    position++;
                }
            }

            var byDate = operations.GroupBy(o => o.Date).OrderBy(g => g.Key).ToList();
            timeline._dates = byDate.Select(g => g.Key).ToArray();
            timeline._balances = new decimal[byDate.Count];
            timeline._unallocated = new decimal[byDate.Count];
            timeline._jars = new Dictionary<Guid, decimal>[byDate.Count];
            var balance = account.OpeningBalance;
            var unallocated = account.OpeningBalance;
            var jars = new Dictionary<Guid, decimal>();
            for (var i = 0; i < byDate.Count; i++)
            {
                foreach (var posting in byDate[i].SelectMany(o => o.Postings))
                {
                    balance += posting.Amount;
                    if (posting.JarId is Guid jarId)
                    {
                        jars[jarId] = jars.GetValueOrDefault(jarId) + posting.Amount;
                    }
                    else
                    {
                        unallocated += posting.Amount;
                    }
                }
                timeline._balances[i] = balance;
                timeline._unallocated[i] = unallocated;
                timeline._jars[i] = new Dictionary<Guid, decimal>(jars);
            }

            // Only a transfer with no departure date can be waiting for its receipt.
            timeline._waitingReceipts = source._readable
                .Where(t => t.Type == TransactionType.Transfer
                            && t.OwnerId == account.OwnerId
                            && (t.AccountId == account.Id || t.TransferAccountId == account.Id)
                            && source._postingDates.TryGetValue(t.Id, out var dates)
                            && dates.DepartedOn is null)
                .ToList();
            return timeline;
        }

        public JarLedgerView ViewAt(DateOnly asOf)
        {
            var at = Array.BinarySearch(_dates, asOf);
            if (at < 0)
            {
                at = ~at - 1;
            }
            var sums = at >= 0 ? _jars[at] : new Dictionary<Guid, decimal>();

            // In Calculate's order: the jars designating the account, then the others as first posted.
            var jarBalances = _designated.ToDictionary(id => id, id => sums.GetValueOrDefault(id));
            foreach (var (jarId, _) in _extras
                         .Select(e => (e.Key, First: e.Value.Where(f => f.Date <= asOf).Select(f => f.Position).DefaultIfEmpty(-1).Min()))
                         .Where(e => e.First >= 0)
                         .OrderBy(e => e.First))
            {
                jarBalances[jarId] = sums.GetValueOrDefault(jarId);
            }

            var pending = _waitingReceipts.Count == 0
                ? (IReadOnlyList<PendingTransferReceipt>)Array.Empty<PendingTransferReceipt>()
                : ActualAccountLedger.Entries(_account, _openingDate, asOf, _waitingReceipts, _source._postingDates).PendingReceipts;
            var balance = at >= 0 ? _balances[at] : _account.OpeningBalance;
            var ledger = new SavingsLedgerBalance(asOf, balance, new System.Collections.ObjectModel.ReadOnlyDictionary<Guid, decimal>(jarBalances),
                at >= 0 ? _unallocated[at] : _account.OpeningBalance)
            {
                PendingTransferReceipts = pending,
            };
            var unreconciled = UpperBound(_unreconciled, asOf);
            return new JarLedgerView(asOf, _account, ledger, false, unreconciled) { CarriedJars = _carried };
        }

        private static int UpperBound(DateOnly[] sorted, DateOnly value)
        {
            int lo = 0, hi = sorted.Length;
            while (lo < hi)
            {
                var mid = (lo + hi) / 2;
                if (sorted[mid] <= value)
                {
                    lo = mid + 1;
                }
                else
                {
                    hi = mid;
                }
            }
            return lo;
        }
    }

    /// <summary>
    /// The dates after <paramref name="after"/>, future-dated entries included, on which the
    /// account's ledger has an operation: its balances change only on these days, so a check
    /// that must hold on every later date reads these and no others.
    /// </summary>
    public IReadOnlyList<DateOnly> OperationDatesAfter(Guid accountId, DateOnly after)
    {
        if (_accounts.FirstOrDefault(a => a.Id == accountId) is not { OpeningDate: DateOnly openingDate } account)
        {
            return Array.Empty<DateOnly>();
        }
        var (operations, _, _) = OperationsOf(account, openingDate, DateOnly.MaxValue);
        return operations.Select(o => o.Date).Where(d => d > after).Distinct().Order().ToList();
    }

    private JarLedgerView ViewOf(Account account, DateOnly asOf)
    {
        var carried = _carried.TryGetValue(account.Id, out var jarIds) ? jarIds : new HashSet<Guid>();
        if (account.OpeningDate is not DateOnly openingDate)
        {
            return new JarLedgerView(asOf, account, new SavingsLedgerBalance(asOf, null, null, null), true, 0);
        }
        if (asOf < openingDate)
        {
            return new JarLedgerView(asOf, account, new SavingsLedgerBalance(asOf, null, null, null), false, 0);
        }

        var (operations, unreconciled, _) = OperationsOf(account, openingDate, asOf);
        var ledger = ActualSavingsLedger.Calculate(account, openingDate, asOf, _jars, _readable, operations, _postingDates);
        return new JarLedgerView(asOf, account, ledger, false, unreconciled) { CarriedJars = carried };
    }

    /// <summary>
    /// What was put into each jar between <paramref name="from"/> and <paramref name="to"/>
    /// (both inclusive), in every account, from the operations the ledger reads on those dates:
    /// the money allocated or moved into the jar, net of what was moved back out of it to
    /// unallocated money or another jar in the same period (a move undone, or the jar emptied
    /// to travel between accounts, put nothing new in), plus what a receipt's or income's jar
    /// share brought in. What left the jar as spending or a transfer is never netted off: rule
    /// 14's "contributed this month" is what went in, not the change in balance, so a bill paid
    /// from the jar moves its balance and its plan but not this figure. A returned transfer's
    /// share going back to its jar (<see cref="JarAllocationKind.Return"/>) and a jar's departure
    /// from an account (rule 80, zero-sum) put nothing new in either. Nor does money set aside
    /// when the jar was created (<see cref="JarAllocationKind.InitialAllocation"/>): it was
    /// already saved, so it counts as the month's opening balance (<see cref="SetAsideBetween"/>,
    /// SC-P2-1), never as a contribution. A jar with nothing in, or less than left it by a move,
    /// is absent.
    /// </summary>
    public IReadOnlyDictionary<Guid, decimal> ContributionsBetween(DateOnly from, DateOnly to) =>
        SumPostings(from, to, kind => kind is not (JarAllocationKind.Return or JarAllocationKind.Departure or JarAllocationKind.InitialAllocation),
            (kind, amount) => kind is JarAllocationKind.Reallocation || amount > 0m);

    /// <summary>
    /// The money set aside into each jar when it was created (<see cref="JarAllocationKind.InitialAllocation"/>)
    /// between <paramref name="from"/> and <paramref name="to"/> (both inclusive). It was saved
    /// before the jar existed, so a month it falls in is planned as if the jar had entered the
    /// month holding it (rules 12, 13 and 35; SC-P2-1): the planners add it to the month's
    /// opening balance and <see cref="ContributionsBetween"/> leaves it out.
    /// </summary>
    public IReadOnlyDictionary<Guid, decimal> SetAsideBetween(DateOnly from, DateOnly to) =>
        SumPostings(from, to, kind => kind is JarAllocationKind.InitialAllocation, (_, _) => true);

    /// <summary>
    /// What each jar paid out between <paramref name="from"/> and <paramref name="to"/> (both
    /// inclusive), one posting per jar per operation: the jar's share of every expense that drew
    /// from it, by the expense's own date (a payment on its Savings line, a slice on that line, or
    /// a payment on another line answered "from this jar", rule 79, in whichever account paid it),
    /// and the share of every refund that came back into it (rule 38; a refund's jar answer, rule
    /// 78), flagged <c>IsRefund</c>. Transfers, moves between jars, income, departures and returns
    /// are not spending and are left out, and so is a row still waiting for its amount in the
    /// budget currency (<see cref="Transaction.FxPending"/>), which counts nowhere until entered;
    /// <c>Waiting</c> says how many such rows touched a jar.
    /// </summary>
    public (IReadOnlyList<JarSpendingPosting> Postings, int Waiting) SpendingBetween(DateOnly from, DateOnly to)
    {
        var postings = new List<JarSpendingPosting>();
        var waiting = new HashSet<Guid>();
        if (to < from)
        {
            return (postings, 0);
        }
        foreach (var account in _accounts)
        {
            if (account.OpeningDate is not DateOnly openingDate || to < openingDate)
            {
                continue;
            }
            var (operations, _, _) = OperationsOf(account, openingDate, to);
            foreach (var op in operations)
            {
                if (op.Date < from || op.Date < openingDate
                    || op.TransactionId is not Guid transactionId
                    || !_byId.TryGetValue(transactionId, out var transaction)
                    || transaction.Type == TransactionType.Transfer)
                {
                    continue;
                }
                var isRefund = transaction.IsRefund;
                if (transaction.Type == TransactionType.Income && !isRefund)
                {
                    continue;
                }
                foreach (var posting in op.Postings)
                {
                    if (posting.JarId is not Guid jarId || posting.Amount == 0m)
                    {
                        continue;
                    }
                    if (transaction.FxPending)
                    {
                        waiting.Add(transactionId);
                        continue;
                    }
                    // An expense's share is negative in the ledger; report it as what was paid.
                    postings.Add(new JarSpendingPosting(jarId, op.Date, isRefund ? posting.Amount : -posting.Amount, isRefund));
                }
            }
        }
        return (postings, waiting.Count);
    }

    /// <summary>
    /// Every jar posting the ledger reads, in every account, future-dated ones included: one walk
    /// over each account's operations, for a reader that sorts the postings itself (the month
    /// carry-over, <see cref="Budgets.MonthLeftover"/>). <c>Transaction</c> is the row a
    /// transaction-linked posting attributes (a returned transfer's for its return leg),
    /// <c>Kind</c> a stored operation's kind and <c>ReturnOf</c> the transfer a Return operation
    /// puts back.
    /// </summary>
    public IEnumerable<JarPostingRead> JarPostings()
    {
        var returnOf = _stored
            .Where(a => a.ReturnOfTransferId is not null)
            .ToDictionary(a => a.Id, a => a.ReturnOfTransferId!.Value);
        foreach (var account in _accounts)
        {
            if (account.OpeningDate is not DateOnly openingDate)
            {
                continue;
            }
            var (operations, _, kinds) = OperationsOf(account, openingDate, DateOnly.MaxValue);
            foreach (var op in operations)
            {
                if (op.Date < openingDate)
                {
                    continue;
                }
                var transaction = op.TransactionId is not Guid id ? null
                    : _byId.TryGetValue(id, out var row) ? row
                    : _returnLegs.TryGetValue(id, out var transferId) ? _byId[transferId]
                    : null;
                JarAllocationKind? kind = kinds.TryGetValue(op.Id, out var stored) ? stored : null;
                var returned = returnOf.TryGetValue(op.Id, out var returnedId) && _byId.TryGetValue(returnedId, out var transfer) ? transfer : null;
                foreach (var posting in op.Postings)
                {
                    if (posting.JarId is Guid jarId && posting.Amount != 0m)
                    {
                        yield return new JarPostingRead(jarId, op.Date, transaction, kind, returned, posting.Amount);
                    }
                }
            }
        }
    }

    /// <summary>The jar postings dated between <paramref name="from"/> and <paramref name="to"/> of the operations whose kind <paramref name="include"/> accepts, summed per jar where <paramref name="counts"/> says so; positive totals only.</summary>
    private IReadOnlyDictionary<Guid, decimal> SumPostings(
        DateOnly from, DateOnly to, Func<JarAllocationKind, bool> include, Func<JarAllocationKind, decimal, bool> counts)
    {
        var net = new Dictionary<Guid, decimal>();
        if (to < from)
        {
            return net;
        }
        foreach (var account in _accounts)
        {
            if (account.OpeningDate is not DateOnly openingDate || to < openingDate)
            {
                continue;
            }
            var (operations, _, kinds) = OperationsOf(account, openingDate, to);
            foreach (var op in operations)
            {
                if (op.Date < from || op.Date < openingDate)
                {
                    continue;
                }
                // A movement's jar split, or the budget-line attribution derived for it, when the
                // operation was not stored.
                var kind = kinds.TryGetValue(op.Id, out var stored) ? stored : JarAllocationKind.Movement;
                if (!include(kind))
                {
                    continue;
                }
                foreach (var posting in op.Postings)
                {
                    if (posting.JarId is not Guid jarId)
                    {
                        continue;
                    }
                    if (counts(kind, posting.Amount))
                    {
                        net[jarId] = net.GetValueOrDefault(jarId) + posting.Amount;
                    }
                }
            }
        }
        return net.Where(e => e.Value > 0m).ToDictionary(e => e.Key, e => e.Value);
    }

    /// <summary>
    /// The account's ledger operations up to <paramref name="asOf"/>: its stored allocations
    /// (each transaction's own posting date and amount govern; one that no longer matches its
    /// transaction is set aside and counted as unreconciled), the budget-line attribution of
    /// every other movement, and a returned transfer's leg as unallocated money.
    /// <c>Kinds</c> is each stored operation's <see cref="JarAllocationKind"/> by operation id
    /// (a derived operation has none), for <see cref="ContributionsBetween"/>.
    /// </summary>
    private (List<JarLedgerOperation> Operations, int Unreconciled, Dictionary<Guid, JarAllocationKind> Kinds) OperationsOf(
        Account account, DateOnly openingDate, DateOnly asOf, List<DateOnly>? unreconciledDates = null)
    {
        var entries = ActualAccountLedger.Entries(account, openingDate, asOf, _readable, _postingDates);
        var operations = new List<JarLedgerOperation>();
        var attributed = new HashSet<Guid>();
        var kinds = new Dictionary<Guid, JarAllocationKind>();
        var unreconciled = 0;

        foreach (var op in _stored.Where(a => a.AccountId == account.Id))
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
                    unreconciledDates?.Add(movement.Date);
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
                // A Return operation stands only while its transfer is still returned from this
                // account, on or after the operation's date (a share kept at the day the return
                // was marked by hand, R4-P3-1). Otherwise it is set aside, counted for review,
                // and the money the return leg brought back stays unallocated (R3-P3-1).
                if (op.ReturnOfTransferId is Guid returnOf
                    && (!_byId.TryGetValue(returnOf, out var returned)
                        || returned.ReturnedOn is not DateOnly returnedOn
                        || returned.AccountId != account.Id
                        || op.Date > returnedOn))
                {
                    unreconciled++;
                    unreconciledDates?.Add(op.Date);
                    continue;
                }
                operations.Add(new JarLedgerOperation(op.Id, op.OwnerId, op.AccountId, op.Date, null,
                    op.Postings.Select(p => new JarLedgerPosting(p.JarId, p.Amount)).ToList()));
            }
            kinds[op.Id] = op.Kind;
        }

        foreach (var (transactionId, movement) in entries.Movements)
        {
            if (attributed.Contains(transactionId) || _returnLegs.ContainsKey(transactionId))
            {
                continue;
            }
            operations.Add(new JarLedgerOperation(
                Guid.NewGuid(), _ownerId, account.Id, movement.Date, transactionId,
                JarLedgerReader.Derive(_byId[transactionId], account, movement.Amount, _lineJars, _jarsById)));
        }

        // A returned transfer's money comes back as unallocated money; its stored Return
        // operation (TransferReturns) puts each jar's share back, as decided when the return
        // was recorded.
        foreach (var (legId, movement) in entries.Movements)
        {
            if (_returnLegs.ContainsKey(legId))
            {
                operations.Add(new JarLedgerOperation(Guid.NewGuid(), _ownerId, account.Id, movement.Date, legId,
                    new[] { new JarLedgerPosting(null, movement.Amount) }));
            }
        }

        return (operations, unreconciled, kinds);
    }
}
