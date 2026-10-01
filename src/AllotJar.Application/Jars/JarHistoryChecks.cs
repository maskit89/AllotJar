using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>
/// Rules 68, 70 and 77 across history (the P10 principle rule 74 already follows): money taken
/// from a jar or from unallocated funds as of a past date is taken on that date and stays taken on
/// every later one. A check that reads only the chosen date lets a back-dated move claim money the
/// source has since paid or moved out, leaving it below zero and the account's positive jars
/// unbacked from that day on (app-2026-09-30 review, JL-P1-1/JL-P1-2/JL-P2-3).
/// </summary>
public static class JarHistoryChecks
{
    /// <summary>
    /// The first refusal, or null: on each date from <paramref name="from"/> (inclusive when
    /// <paramref name="includeFrom"/>, for callers that do not check that day themselves) and on
    /// every later date on which the account's ledger changes, future-dated entries included,
    /// the source must still hold <paramref name="amount"/>, and the candidate (the ledger that
    /// day plus <paramref name="postings"/> and <paramref name="accountChange"/>) must not show
    /// a backing deficit, or a larger one than the ledger already had. A deficit a payment
    /// already caused stays readable (rule 70) and does not block a move that leaves it as it is.
    /// </summary>
    /// <param name="source">The ledger loaded without the write being checked.</param>
    /// <param name="sourceJarId">The jar giving the money; null for unallocated funds.</param>
    /// <param name="until">The first day the write no longer holds (a returned transfer's money is back from its return date); null: for good.</param>
    /// <param name="alreadyTaken">What the write this one replaces took from the source on a date (an edit of the same draw): a date is refused only when the new write takes more than that too, so a correction that leaves the source no worse passes.</param>
    /// <param name="earlier">Writes not yet saved that already change the account (earlier rows of one import).</param>
    /// <param name="accountChange">What the write does to the account's money (a transfer's departure: minus its amount; a move between jars: 0).</param>
    public static string? FirstRefusal(
        JarLedgerSource source,
        Account account,
        DateOnly from,
        bool includeFrom,
        Guid? sourceJarId,
        string sourceName,
        decimal amount,
        decimal accountChange,
        IReadOnlyList<JarLedgerPosting> postings,
        DateOnly? until = null,
        Func<DateOnly, decimal>? alreadyTaken = null,
        IReadOnlyList<JarLedgerChange>? earlier = null)
    {
        var dates = source.OperationDatesAfter(account.Id, from)
            .Concat(earlier?.Select(c => c.From).Where(d => d > from) ?? Enumerable.Empty<DateOnly>())
            .Where(d => until is not DateOnly end || d < end)
            .Distinct().Order();
        foreach (var date in includeFrom ? dates.Prepend(from) : dates)
        {
            if (source.ViewAt(account.Id, date) is not { IsAvailable: true } stored)
            {
                continue;
            }
            var view = WithEarlier(stored, earlier?.Where(c => c.From <= date).ToList());
            var held = sourceJarId is Guid jarId ? view.JarBalances.GetValueOrDefault(jarId) : view.Unallocated!.Value;
            if (amount > Math.Max(0m, held) && amount > (alreadyTaken?.Invoke(date) ?? 0m))
            {
                var what = date == from ? "" : $", after what was paid or moved out of it since {from:yyyy-MM-dd}";
                return $"{sourceName} holds {Math.Max(0m, held):0.##} on {date:yyyy-MM-dd}{what}, so it cannot give {amount:0.##} "
                    + $"as of {from:yyyy-MM-dd}. Choose a later date, a smaller amount or another source.";
            }

            var moved = JarLedgerReader.Apply(view, postings);
            var candidate = new SavingsLedgerBalance(view.AsOf, view.AccountBalance + accountChange, moved.JarBalances, moved.Unallocated)
            {
                PendingTransferReceipts = view.Ledger.PendingTransferReceipts,
            };
            if (Excess(candidate) > Excess(view.Ledger))
            {
                return $"From {date:yyyy-MM-dd} {account.Name}'s jars would hold {candidate.PositiveAllocations:0.##} "
                    + $"while the account holds {candidate.AccountBalance:0.##}: positive jars must be backed by the account's money. "
                    + "Choose a later date, a smaller amount or another source.";
            }
        }
        return null;
    }

    /// <summary>
    /// Rule 68 for a transfer "from a jar" (Move money, the transfer form): the jar gives at most
    /// what it holds on the departure date and on every later date, as a reallocation does; a
    /// payment may overdraw a jar (rule 5), a move of money may not. Read without this transfer, so
    /// an edit is checked against the ledger it replaces. A transfer still waiting for its
    /// departure takes nothing yet and is checked when the departure is confirmed; a returned one
    /// holds the money only until its return (rule 90).
    /// </summary>
    public static async Task EnsureTransferDrawAsync(
        IApplicationDbContext db, string ownerId, Transaction transfer, Account account, Guid fromJarId,
        string errorKey, CancellationToken cancellationToken,
        (decimal Amount, DateOnly From, DateOnly? Until)? previous = null)
    {
        if (await TransferDrawRefusalAsync(db, ownerId, transfer, account, fromJarId, cancellationToken, previous) is { } refusal)
        {
            throw JarAccounts.Validation(errorKey, refusal);
        }
    }

    /// <summary>
    /// <see cref="EnsureTransferDrawAsync"/>'s refusal, or null, for a caller that holds the row
    /// instead of failing (the import). <paramref name="previous"/>: the draw an edit replaces,
    /// when it took from the same jar of the same account; a date is refused only when the new
    /// draw takes more than the jar holds there and more than the old one took that day.
    /// <paramref name="earlier"/>: what rows not yet saved (earlier rows of the same import) do
    /// to the account. <paramref name="alsoExclude"/>: transactions whose effect on the account
    /// <paramref name="earlier"/> already carries (a transfer an earlier row confirmed), read
    /// from there alone.
    /// </summary>
    public static async Task<string?> TransferDrawRefusalAsync(
        IApplicationDbContext db, string ownerId, Transaction transfer, Account account, Guid fromJarId,
        CancellationToken cancellationToken,
        (decimal Amount, DateOnly From, DateOnly? Until)? previous = null,
        IReadOnlyList<JarLedgerChange>? earlier = null,
        IReadOnlyCollection<Guid>? alsoExclude = null)
    {
        if (transfer.DepartedOn is not DateOnly departed)
        {
            return null;
        }
        var name = await db.Jars.AsNoTracking().Where(j => j.Id == fromJarId).Select(j => j.Name).FirstOrDefaultAsync(cancellationToken)
            ?? "The jar";
        var source = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken, new[] { account.Id },
            includeUnbacked: true, excludeTransactionIds: (alsoExclude ?? Array.Empty<Guid>()).Append(transfer.Id).ToList());
        return FirstRefusal(source, account, departed, includeFrom: true, fromJarId, name, transfer.Amount, -transfer.Amount,
            new[] { new JarLedgerPosting(fromJarId, -transfer.Amount) }, until: transfer.ReturnedOn,
            alreadyTaken: previous is { } p ? d => d >= p.From && (p.Until is not DateOnly u || d < u) ? p.Amount : 0m : null,
            earlier: earlier);
    }

    /// <summary>
    /// The ledgers of <paramref name="accounts"/> before a write that may take money out of them
    /// from under their jars, for <see cref="NewBackingDeficitAsync"/> to compare with once it is saved.
    /// </summary>
    public static Task<JarLedgerSource> BeforeWriteAsync(
        IApplicationDbContext db, string ownerId, IEnumerable<Account> accounts, CancellationToken cancellationToken) =>
        JarLedgerReader.LoadAsync(db, ownerId, cancellationToken, accounts.Select(a => a.Id).Distinct().ToList());

    /// <summary>
    /// A warning, or null, after a saved write that took money out of an account (an income
    /// deleted, lowered, re-dated or moved away; D10, review JL-P3-1): the first date from
    /// <paramref name="from"/> on which an account's positive jars exceed its money by more than
    /// they did before the write (rule 70). The write stands, since the money really is gone and
    /// the jars still say what was set aside and moved; the user is told, as a read would show it.
    /// <paramref name="done"/> opens the warning with what was done ("Saved.", "Deleted.").
    /// </summary>
    public static async Task<string?> NewBackingDeficitAsync(
        IApplicationDbContext db, string ownerId, JarLedgerSource before, IReadOnlyCollection<Account> accounts,
        DateOnly from, string done, CancellationToken cancellationToken)
    {
        var ids = accounts.Select(a => a.Id).Distinct().ToList();
        var after = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken, ids);
        foreach (var account in accounts.DistinctBy(a => a.Id))
        {
            var dates = before.OperationDatesAfter(account.Id, from)
                .Concat(after.OperationDatesAfter(account.Id, from))
                .Prepend(from)
                .Distinct().Order();
            foreach (var date in dates)
            {
                if (after.ViewAt(account.Id, date) is not { IsAvailable: true } now)
                {
                    continue;
                }
                var was = before.ViewAt(account.Id, date) is { IsAvailable: true } then ? Excess(then.Ledger) : 0m;
                var excess = Excess(now.Ledger);
                if (excess > was)
                {
                    return $"{done} From {date:yyyy-MM-dd} {account.Name}'s jars hold {now.PositiveAllocations:0.##} "
                        + $"while the account holds {now.AccountBalance ?? 0m:0.##}, so {excess:0.##} of the jars' money is not in the account. "
                        + "Move that much out of a jar, or record the money that came in.";
                }
            }
        }
        return null;
    }

    /// <summary>The stored view plus what unsaved rows already do to the account that day.</summary>
    private static JarLedgerView WithEarlier(JarLedgerView view, IReadOnlyList<JarLedgerChange>? active)
    {
        if (active is not { Count: > 0 })
        {
            return view;
        }
        var moved = JarLedgerReader.Apply(view, active.SelectMany(c => c.Postings).ToList());
        return view with
        {
            Ledger = new SavingsLedgerBalance(view.AsOf, view.AccountBalance + active.Sum(c => c.AccountChange), moved.JarBalances, moved.Unallocated)
            {
                PendingTransferReceipts = view.Ledger.PendingTransferReceipts,
            },
        };
    }

    /// <summary>How far the positive jars exceed the account's money (rule 70), or 0.</summary>
    private static decimal Excess(SavingsLedgerBalance ledger) =>
        Math.Max(0m, ledger.PositiveAllocations - (ledger.AccountBalance ?? 0m));
}

/// <summary>
/// What a write not yet saved does to an account's jar ledger from <paramref name="From"/> on:
/// its money (<paramref name="AccountChange"/>) and where in the account it lands or leaves
/// (<paramref name="Postings"/>; a null jar is unallocated money).
/// </summary>
public sealed record JarLedgerChange(DateOnly From, decimal AccountChange, IReadOnlyList<JarLedgerPosting> Postings);
