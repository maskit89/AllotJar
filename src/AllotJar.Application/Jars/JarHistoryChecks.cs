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
        DateOnly? until = null)
    {
        var dates = source.OperationDatesAfter(account.Id, from).Where(d => until is not DateOnly end || d < end);
        foreach (var date in includeFrom ? dates.Prepend(from) : dates)
        {
            if (source.ViewAt(account.Id, date) is not { IsAvailable: true } view)
            {
                continue;
            }
            var held = sourceJarId is Guid jarId ? view.JarBalances.GetValueOrDefault(jarId) : view.Unallocated!.Value;
            if (amount > Math.Max(0m, held))
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
        string errorKey, CancellationToken cancellationToken)
    {
        if (transfer.DepartedOn is not DateOnly departed)
        {
            return;
        }
        var name = await db.Jars.AsNoTracking().Where(j => j.Id == fromJarId).Select(j => j.Name).FirstOrDefaultAsync(cancellationToken)
            ?? "The jar";
        var source = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken, new[] { account.Id },
            includeUnbacked: true, excludeTransactionIds: new[] { transfer.Id });
        if (FirstRefusal(source, account, departed, includeFrom: true, fromJarId, name, transfer.Amount, -transfer.Amount,
                new[] { new JarLedgerPosting(fromJarId, -transfer.Amount) }, until: transfer.ReturnedOn) is { } refusal)
        {
            throw JarAccounts.Validation(errorKey, refusal);
        }
    }

    /// <summary>How far the positive jars exceed the account's money (rule 70), or 0.</summary>
    private static decimal Excess(SavingsLedgerBalance ledger) =>
        Math.Max(0m, ledger.PositiveAllocations - (ledger.AccountBalance ?? 0m));
}
