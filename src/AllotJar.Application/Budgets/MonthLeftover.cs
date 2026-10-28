using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Budgets;

/// <summary>
/// One month's actual money as the carry-over reads it (rule 94). What it leaves over is money
/// in the household's accounts that is neither spent nor in a jar, so carried from month to month
/// it ends equal to that money:
/// <list type="bullet">
/// <item><b>Received</b> and the budget's spending are the month's own figures (rules 37–41): a row
/// on a line counts in that line's month, any other row in the month of its date.</item>
/// <item><b>Spent</b> is that spending less what jars paid: a bill paid from a jar was saved for
/// already, so it does not come out of the month's money.</item>
/// <item><b>IntoJars</b> is every other jar posting: money moved in or out, set aside when a jar
/// was made (<see cref="SetAside"/>), income or a transfer put straight into a jar. A posting that
/// belongs to a row follows the row's month, so a jar bill or payday budgeted to the next month
/// counts there; a transfer between two household accounts counts in the month it left, whenever
/// it arrives.</item>
/// <item><b>NewAccounts</b> is the money an account held when it was opened, in its opening month,
/// less what its rows dated earlier already counted (they are inside that balance).</item>
/// <item><b>PrivateTransfers</b> is money moved in from (+) or out to (−) a private account, a
/// member's private money the budget counts on a household line (it stays private), or the kept
/// side of a transfer whose other account was erased (P59).</item>
/// </list>
/// Rows still waiting for their budget-currency amount count nowhere (rule 44), as in the budget.
/// </summary>
public sealed record MonthMoney(
    decimal Received, decimal Spent, decimal IntoJars, decimal SetAside, decimal NewAccounts, decimal PrivateTransfers)
{
    public decimal LeftOver => Received - Spent - IntoJars + NewAccounts + PrivateTransfers;

    /// <summary>
    /// What the month has to give a job besides its income and plan: money that reached the
    /// accounts outside it (a new account, money from a private account), less money set aside
    /// when a jar was made, which the jar starts the month with (SC-P2-1).
    /// </summary>
    public decimal OutsidePlan => NewAccounts + PrivateTransfers - SetAside;

    public static readonly MonthMoney None = new(0m, 0m, 0m, 0m, 0m, 0m);
}

/// <summary>Every month's <see cref="MonthMoney"/>, from the household's first recorded money.</summary>
public sealed class MoneyChain
{
    private readonly IReadOnlyDictionary<(int Year, int Month), MonthMoney> _months;

    internal MoneyChain(IReadOnlyDictionary<(int Year, int Month), MonthMoney> months) => _months = months;

    public MonthMoney Of(int year, int month) => _months.GetValueOrDefault((year, month)) ?? MonthMoney.None;

    /// <summary>What every month before this one left over: the money it starts with that has no job.</summary>
    public decimal CarriedInto(int year, int month) =>
        _months.Where(e => e.Key.Year < year || (e.Key.Year == year && e.Key.Month < month)).Sum(e => e.Value.LeftOver);
}

public static class MonthLeftover
{
    /// <summary>
    /// Reads every month's money in one pass: four grouped sums for the budget's figures, the
    /// accounts' opening money, the transfers with private accounts and one walk of the jar ledger.
    /// Nothing is stored, so a back-dated correction (rule 49) moves every later carry.
    /// </summary>
    public static async Task<MoneyChain> ReadAsync(
        IApplicationDbContext db, string userId, CurrencyCode budgetCurrency, CancellationToken cancellationToken)
    {
        var months = new Dictionary<(int Year, int Month), Figures>();
        Figures At((int Year, int Month) key) =>
            months.TryGetValue(key, out var figures) ? figures : months[key] = new Figures();
        static (int Year, int Month) MonthOf(DateOnly date) => (date.Year, date.Month);

        var lines = (await (
                from i in db.BudgetItems.AsNoTracking()
                join c in db.BudgetCategories on i.BudgetCategoryId equals c.Id
                join m in db.BudgetMonths on c.BudgetMonthId equals m.Id
                where m.OwnerId == userId
                select new { i.Id, m.Year, m.Month, Income = c.Kind == CategoryKind.Income, i.SavingsId })
            .ToListAsync(cancellationToken))
            .ToDictionary(l => l.Id, l => new Line((l.Year, l.Month), l.Income, l.SavingsId));

        var privateIds = await PrivateAccountIdsAsync(db, userId, cancellationToken);

        await AddBudgetFiguresAsync(db, userId, privateIds, At, cancellationToken);

        // Money in from or out to a private account (P56/P57): the household side of the transfer,
        // on the day it posts there. A transfer still held for review has posted nowhere.
        var boundary = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == userId
                        && t.Type == TransactionType.Transfer
                        && !t.FxPending
                        && t.AccountId != null
                        && t.TransferAccountId != null
                        && t.DepartedOn != null
                        && (privateIds.Contains(t.AccountId.Value)
                            ? !privateIds.Contains(t.TransferAccountId.Value)
                            : privateIds.Contains(t.TransferAccountId.Value)))
            .ToListAsync(cancellationToken);
        foreach (var t in boundary)
        {
            foreach (var (accountId, date, amount) in Legs(t))
            {
                if (!privateIds.Contains(accountId))
                {
                    At(MonthOf(date)).PrivateTransfers += amount;
                }
            }
        }

        // The kept side of a transfer whose private account was erased (P59): a transfer from or
        // to outside the household, which the budget leaves out.
        var erased = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == userId
                        && t.CounterpartyErased
                        && t.AccountId != null
                        && !t.FxPending
                        && t.Type != TransactionType.Transfer
                        && t.BudgetItemId == null
                        && !t.Splits.Any()
                        && !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId))
            .GroupBy(t => new { t.Date.Year, t.Date.Month, t.Type })
            .Select(g => new { g.Key.Year, g.Key.Month, g.Key.Type, Total = g.Sum(t => t.BudgetAmount ?? t.Amount) })
            .ToListAsync(cancellationToken);
        foreach (var e in erased)
        {
            At((e.Year, e.Month)).PrivateTransfers += e.Type == TransactionType.Income ? e.Total : -e.Total;
        }

        await AddOpeningMoneyAsync(db, userId, budgetCurrency, privateIds, lines, At, cancellationToken);

        var ledger = await JarLedgerReader.LoadAsync(db, userId, cancellationToken);
        foreach (var posting in ledger.JarPostings())
        {
            var t = posting.Transaction;
            if (t is { FxPending: true })
            {
                continue;
            }
            if (t is not null && t.Type != TransactionType.Transfer && (t.Type == TransactionType.Expense || t.IsRefund))
            {
                // What the jar paid (a refund back into it, negative): out of the month's spending.
                At(ShareMonth(t, posting.JarId, lines)).JarPaid -= posting.Amount;
                continue;
            }
            var transfer = t is { Type: TransactionType.Transfer } ? t : posting.ReturnOf;
            var key = transfer is not null
                ? Internal(transfer, privateIds) ? MonthOf(transfer.DepartedOn ?? transfer.Date) : MonthOf(posting.Date)
                : t is not null ? ShareMonth(t, posting.JarId, lines)
                : MonthOf(posting.Date);
            var figures = At(key);
            figures.IntoJars += posting.Amount;
            if (posting.Kind == JarAllocationKind.InitialAllocation)
            {
                figures.SetAside += posting.Amount;
            }
        }

        return new MoneyChain(months.ToDictionary(e => e.Key, e => e.Value.ToMoney()));
    }

    /// <summary>
    /// Received and the budget's net spending of every month, in four grouped sums that read the
    /// rows exactly as <see cref="BudgetActuals"/> and the reports do: rows and slices on a line in
    /// the line's month, the rest (not a transfer, not private money off the budget) by their date.
    /// </summary>
    private static async Task AddBudgetFiguresAsync(
        IApplicationDbContext db, string userId, HashSet<Guid> privateIds, Func<(int Year, int Month), Figures> at,
        CancellationToken cancellationToken)
    {
        foreach (var (month, received, spent) in await OnLinesAsync(db, userId, db.Transactions, cancellationToken))
        {
            var figures = at(month);
            figures.Received += received;
            figures.Spent += spent;
        }

        // A member's private money on a household line counts in the budget (P56) but stays in the
        // private account, so for the household's money it leaves as it counts.
        if (privateIds.Count > 0)
        {
            var onPrivate = db.Transactions.Where(t => t.AccountId != null && privateIds.Contains(t.AccountId.Value));
            foreach (var (month, received, spent) in await OnLinesAsync(db, userId, onPrivate, cancellationToken))
            {
                at(month).PrivateTransfers -= received - spent;
            }
        }

        var loose = await db.Transactions
            .Where(t => t.OwnerId == userId
                        && !t.FxPending
                        && t.Type != TransactionType.Transfer
                        && !t.CounterpartyErased
                        && t.BudgetItemId == null
                        && !t.Splits.Any()
                        && !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId))
            .GroupBy(t => new { t.Date.Year, t.Date.Month, t.Type, Refund = t.RefundOfTransactionId != null })
            .Select(g => new { g.Key.Year, g.Key.Month, g.Key.Type, g.Key.Refund, Total = g.Sum(t => t.BudgetAmount ?? t.Amount) })
            .ToListAsync(cancellationToken);
        foreach (var r in loose)
        {
            var figures = at((r.Year, r.Month));
            if (r.Refund)
            {
                figures.Spent -= r.Total;
            }
            else if (r.Type == TransactionType.Income)
            {
                figures.Received += r.Total;
            }
            else if (r.Type == TransactionType.Expense)
            {
                figures.Spent += r.Total;
            }
        }

        var looseSlices = await (
                from s in db.TransactionSplits
                join t in db.Transactions on s.TransactionId equals t.Id
                where t.OwnerId == userId
                      && !t.FxPending
                      && t.Type != TransactionType.Transfer
                      && !t.CounterpartyErased
                      && s.BudgetItemId == null
                      && !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId)
                group s by new { t.Date.Year, t.Date.Month, t.Type }
                into g
                select new { g.Key.Year, g.Key.Month, g.Key.Type, Total = g.Sum(s => s.BudgetAmount ?? s.Amount) })
            .ToListAsync(cancellationToken);
        foreach (var r in looseSlices)
        {
            var figures = at((r.Year, r.Month));
            if (r.Type == TransactionType.Income)
            {
                figures.Received += r.Total;
            }
            else if (r.Type == TransactionType.Expense)
            {
                figures.Spent += r.Total;
            }
        }
    }

    /// <summary>Received and spending on lines, in each line's month, of these rows: whole rows on a line and the slices of split rows.</summary>
    private static async Task<List<((int Year, int Month) Month, decimal Received, decimal Spent)>> OnLinesAsync(
        IApplicationDbContext db, string userId, IQueryable<Transaction> rows, CancellationToken cancellationToken)
    {
        var sums = new List<((int Year, int Month) Month, decimal Received, decimal Spent)>();

        var onLines = await (
                from t in rows
                join i in db.BudgetItems on t.BudgetItemId equals (Guid?)i.Id
                join c in db.BudgetCategories on i.BudgetCategoryId equals c.Id
                join m in db.BudgetMonths on c.BudgetMonthId equals m.Id
                where t.OwnerId == userId && m.OwnerId == userId && !t.FxPending
                group t by new { m.Year, m.Month, Income = c.Kind == CategoryKind.Income, t.Type, Refund = t.RefundOfTransactionId != null }
                into g
                select new { g.Key.Year, g.Key.Month, g.Key.Income, g.Key.Type, g.Key.Refund, Total = g.Sum(t => t.BudgetAmount ?? t.Amount) })
            .ToListAsync(cancellationToken);
        foreach (var r in onLines)
        {
            sums.Add(r.Income
                ? ((r.Year, r.Month), r.Type == TransactionType.Income && !r.Refund ? r.Total : 0m, 0m)
                : ((r.Year, r.Month), 0m, r.Type == TransactionType.Expense ? r.Total : r.Refund ? -r.Total : 0m));
        }

        var slicesOnLines = await (
                from s in db.TransactionSplits
                join t in rows on s.TransactionId equals t.Id
                join i in db.BudgetItems on s.BudgetItemId equals (Guid?)i.Id
                join c in db.BudgetCategories on i.BudgetCategoryId equals c.Id
                join m in db.BudgetMonths on c.BudgetMonthId equals m.Id
                where t.OwnerId == userId && m.OwnerId == userId && !t.FxPending && t.RefundOfTransactionId == null
                group s by new { m.Year, m.Month, Income = c.Kind == CategoryKind.Income, t.Type }
                into g
                select new { g.Key.Year, g.Key.Month, g.Key.Income, g.Key.Type, Total = g.Sum(s => s.BudgetAmount ?? s.Amount) })
            .ToListAsync(cancellationToken);
        foreach (var r in slicesOnLines)
        {
            sums.Add(r.Income
                ? ((r.Year, r.Month), r.Type == TransactionType.Income ? r.Total : 0m, 0m)
                : ((r.Year, r.Month), 0m, r.Type == TransactionType.Expense ? r.Total : 0m));
        }

        return sums;
    }

    /// <summary>
    /// What each household account held when it was opened, in the budget currency, in its opening
    /// month. Its rows dated before the opening date are history the balance already includes
    /// (rule 40), yet the budget and the transfers above counted them, so what they counted comes off.
    /// </summary>
    private static async Task AddOpeningMoneyAsync(
        IApplicationDbContext db, string userId, CurrencyCode budgetCurrency, HashSet<Guid> privateIds,
        IReadOnlyDictionary<Guid, Line> lines, Func<(int Year, int Month), Figures> at, CancellationToken cancellationToken)
    {
        var accounts = (await db.Accounts
                .AsNoTracking()
                .Where(a => a.OwnerId == userId && a.OpeningDate != null)
                .Select(a => new { a.Id, a.Currency, a.OpeningBalance, OpeningDate = a.OpeningDate!.Value })
                .ToListAsync(cancellationToken))
            .Where(a => a.Currency == budgetCurrency && !privateIds.Contains(a.Id))
            .ToDictionary(a => a.Id);
        if (accounts.Count == 0)
        {
            return;
        }
        var ids = accounts.Keys.ToList();

        var opening = accounts.Values.ToDictionary(a => a.Id, a => a.OpeningBalance);

        var early = await db.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == userId
                        && !t.FxPending
                        && t.Type != TransactionType.Transfer
                        && t.AccountId != null
                        && ids.Contains(t.AccountId.Value)
                        && t.Date < t.Account!.OpeningDate)
            .ToListAsync(cancellationToken);
        foreach (var t in early)
        {
            opening[t.AccountId!.Value] -= Counted(t, lines);
        }

        var earlyLegs = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == userId
                        && t.Type == TransactionType.Transfer
                        && !t.FxPending
                        && t.AccountId != null
                        && t.TransferAccountId != null
                        && t.DepartedOn != null
                        && ((ids.Contains(t.AccountId.Value)
                             && (t.DepartedOn < t.Account!.OpeningDate || t.ReturnedOn < t.Account!.OpeningDate))
                            || (ids.Contains(t.TransferAccountId.Value) && t.ReceivedOn < t.TransferAccount!.OpeningDate)))
            .ToListAsync(cancellationToken);
        foreach (var t in earlyLegs)
        {
            foreach (var (accountId, date, amount) in Legs(t))
            {
                if (accounts.TryGetValue(accountId, out var account) && date < account.OpeningDate)
                {
                    opening[accountId] -= amount;
                }
            }
        }

        foreach (var account in accounts.Values)
        {
            at((account.OpeningDate.Year, account.OpeningDate.Month)).NewAccounts += opening[account.Id];
        }
    }

    /// <summary>What the budget's figures counted for a row on a household account (Received less spending), as <see cref="AddBudgetFiguresAsync"/> reads it; for the kept side of an erased transfer, what the private transfers counted.</summary>
    private static decimal Counted(Transaction t, IReadOnlyDictionary<Guid, Line> lines)
    {
        var amount = t.BudgetAmount ?? t.Amount;
        if (t.BudgetItemId is Guid itemId)
        {
            if (!lines.TryGetValue(itemId, out var line))
            {
                return 0m;
            }
            return line.Income
                ? t.Type == TransactionType.Income && !t.IsRefund ? amount : 0m
                : t.Type == TransactionType.Expense ? -amount : t.IsRefund ? amount : 0m;
        }
        if (t.Splits.Count > 0)
        {
            var total = 0m;
            foreach (var slice in t.Splits)
            {
                var part = slice.BudgetAmount ?? slice.Amount;
                if (slice.BudgetItemId is Guid sliceItem)
                {
                    if (t.IsRefund || !lines.TryGetValue(sliceItem, out var line))
                    {
                        continue;
                    }
                    total += line.Income
                        ? t.Type == TransactionType.Income ? part : 0m
                        : t.Type == TransactionType.Expense ? -part : 0m;
                }
                else if (!t.CounterpartyErased)
                {
                    total += t.Type == TransactionType.Income ? part : t.Type == TransactionType.Expense ? -part : 0m;
                }
            }
            return total;
        }
        if (t.CounterpartyErased)
        {
            return t.Type == TransactionType.Income ? amount : -amount;
        }
        return t.IsRefund ? amount
            : t.Type == TransactionType.Income ? amount
            : t.Type == TransactionType.Expense ? -amount
            : 0m;
    }

    /// <summary>A transfer's posted legs, signed for the account each posts on: the debit on departure, the credit back on a return, the credit on receipt.</summary>
    private static IEnumerable<(Guid AccountId, DateOnly Date, decimal Amount)> Legs(Transaction t)
    {
        if (t.AccountId is not Guid source || t.TransferAccountId is not Guid destination || t.DepartedOn is not DateOnly departed)
        {
            yield break;
        }
        var amount = t.BudgetAmount ?? t.Amount;
        yield return (source, departed, -amount);
        if (t.ReturnedOn is DateOnly returned)
        {
            yield return (source, returned, amount);
        }
        if (t.ReceivedOn is DateOnly received)
        {
            yield return (destination, received, amount);
        }
    }

    private static bool Internal(Transaction transfer, HashSet<Guid> privateIds) =>
        transfer.AccountId is Guid source && transfer.TransferAccountId is Guid destination
        && !privateIds.Contains(source) && !privateIds.Contains(destination);

    /// <summary>
    /// The month a row's share of a jar counts in: its line's month, as the budget counts the row.
    /// A split row's share follows the slices on that jar's lines, or all its slices when they
    /// agree on one month; otherwise, and for a row on no line, the month of its date.
    /// </summary>
    private static (int Year, int Month) ShareMonth(Transaction t, Guid jarId, IReadOnlyDictionary<Guid, Line> lines)
    {
        var dated = (t.Date.Year, t.Date.Month);
        (int Year, int Month)? MonthOfLine(Guid? itemId) =>
            itemId is Guid id && lines.TryGetValue(id, out var line) ? line.Month : null;

        if (t.Splits.Count == 0)
        {
            return MonthOfLine(t.BudgetItemId) ?? dated;
        }
        var onJar = t.Splits
            .Where(s => s.BudgetItemId is Guid id && lines.TryGetValue(id, out var line) && line.JarId == jarId)
            .Select(s => MonthOfLine(s.BudgetItemId)!.Value)
            .Distinct()
            .ToList();
        if (onJar.Count == 1)
        {
            return onJar[0];
        }
        var all = t.Splits.Select(s => MonthOfLine(s.BudgetItemId) ?? dated).Distinct().ToList();
        return all.Count == 1 ? all[0] : dated;
    }

    /// <summary>
    /// The household's private accounts (P53): every account of the owner with a privacy row,
    /// another login's included, read past the privacy filters as the budget currency is.
    /// </summary>
    private static async Task<HashSet<Guid>> PrivateAccountIdsAsync(
        IApplicationDbContext db, string userId, CancellationToken cancellationToken) =>
        (await db.AccountPrivacies
            .Where(p => db.Accounts.IgnoreQueryFilters().Any(a => a.Id == p.AccountId && a.OwnerId == userId))
            .Select(p => p.AccountId)
            .ToListAsync(cancellationToken))
        .ToHashSet();

    private sealed record Line((int Year, int Month) Month, bool Income, Guid? JarId);

    private sealed class Figures
    {
        public decimal Received;
        public decimal Spent;
        public decimal JarPaid;
        public decimal IntoJars;
        public decimal SetAside;
        public decimal NewAccounts;
        public decimal PrivateTransfers;

        public MonthMoney ToMoney() => new(Received, Spent - JarPaid, IntoJars, SetAside, NewAccounts, PrivateTransfers);
    }
}
