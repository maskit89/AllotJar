using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions;

/// <summary>
/// A transfer's explicit fee (O1 answer 5): what left the source account beyond what arrived,
/// supplied by the user, never inferred (rule 44). It is one expense row on the source account,
/// dated the departure, on the budget line the user picks (or none: uncategorised spending), and
/// linked to the transfer. The source is debited the transfer's amount plus the fee; the
/// destination receives the transfer's amount. The row counts in budgets and reports like any
/// payment and is changed only through its transfer.
/// </summary>
public static class TransferFees
{
    /// <summary>
    /// Writes <paramref name="transfer"/>'s fee: creates, updates or (for a null or zero
    /// <paramref name="fee"/>) removes the fee row. The transfer's <see cref="Transaction.Fee"/>
    /// must be loaded. A fee needs the departure date. The fee draws from
    /// <paramref name="paidFromJarId"/> on a jar-backed source unless its line is a jar's line.
    /// Returns the fee row after the change (null when there is none) so the caller can include
    /// it in its rule 74 check; a removed row's id is added to <paramref name="removedIds"/>.
    /// </summary>
    public static async Task<Transaction?> ApplyAsync(
        IApplicationDbContext db, string ownerId, Transaction transfer, Account source,
        decimal? fee, Guid? lineId, bool acknowledgeCrossMonth, Guid? paidFromJarId,
        string errorKey, ICollection<Guid> removedIds, CancellationToken cancellationToken)
    {
        if (fee is not > 0m)
        {
            if (transfer.Fee is Transaction old)
            {
                await JarMovements.ClearAsync(db, old, source.Id, cancellationToken);
                db.Transactions.Remove(old);
                removedIds.Add(old.Id);
                transfer.Fee = null;
            }
            return null;
        }
        if (transfer.DepartedOn is not DateOnly departedOn)
        {
            throw Validation(errorKey, "Add the departure date before recording a fee: the fee leaves the account when the money does.");
        }

        BudgetItem? line = null;
        if (lineId is Guid id)
        {
            line = await TransactionInvariants.ValidateWholeLineAsync(
                db, ownerId, TransactionType.Expense, id, departedOn, acknowledgeCrossMonth, errorKey, cancellationToken, source.Id);
        }

        var row = transfer.Fee;
        if (row is null)
        {
            row = new Transaction
            {
                OwnerId = ownerId,
                Type = TransactionType.Expense,
                FeeForTransfer = transfer,
            };
            transfer.Fee = row;
            db.Transactions.Add(row);
        }
        else if (row.AccountId != source.Id)
        {
            // The transfer now leaves another account: the fee's stored jar answer belonged to the old one.
            await JarMovements.ClearAsync(db, row, row.AccountId!.Value, cancellationToken);
        }
        // A fee is spending: on an account kept in another currency it waits for its amount in
        // the budget currency, like any new entry there (rules 42/44), until the user confirms it;
        // a confirmed figure stands while the fee's amount and currency do.
        var budgetCurrency = await BudgetCurrency.ResolveAsync(db, null, ownerId, cancellationToken);
        if (transfer.Currency == budgetCurrency)
        {
            row.FxPending = false;
            row.BudgetAmount = null;
        }
        else if (row.Amount != fee.Value || row.Currency != transfer.Currency)
        {
            row.FxPending = true;
            row.BudgetAmount = null;
        }
        row.AccountId = source.Id;
        row.Account = source;
        row.Amount = fee.Value;
        row.Currency = transfer.Currency;
        row.Date = departedOn;
        row.Payee = PayeeFor(transfer);
        row.BudgetItemId = line?.Id;
        row.BudgetItem = line;
        row.MemberId = null;

        var drawsFromLineJar = line?.SavingsId is not null;
        await JarMovements.ApplyOutgoingAsync(
            db, ownerId, row, source, drawsFromLineJar ? null : paidFromJarId, errorKey, cancellationToken);
        return row;
    }

    /// <summary>The fee row follows its transfer's departure date (a statement supplied the bank's date).</summary>
    public static void FollowDeparture(Transaction transfer)
    {
        if (transfer.Fee is Transaction row && transfer.DepartedOn is DateOnly departedOn)
        {
            row.Date = departedOn;
        }
    }

    /// <summary>The refusal for a direct change to a fee row: it is edited through its transfer.</summary>
    public static ValidationException ChangedDirectly(string errorKey) =>
        Validation(errorKey, "This is a transfer's fee. Edit the transfer to change or remove it.");

    private static string PayeeFor(Transaction transfer)
    {
        var payee = $"Fee: {transfer.Payee}";
        return payee.Length <= 200 ? payee : payee[..200];
    }

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
