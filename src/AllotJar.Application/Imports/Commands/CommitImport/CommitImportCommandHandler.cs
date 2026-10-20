using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Budgets;
using AllotJar.Application.Jars;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Common;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Imports.Commands.CommitImport;

public class CommitImportCommandHandler : IRequestHandler<CommitImportCommand, ImportStatementResult>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    public CommitImportCommandHandler(
        IApplicationDbContext db,
        ICurrentUser currentUser,
        IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<ImportStatementResult> Handle(CommitImportCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Validate every foreign key the caller is asking us to attach belongs to them —
        // both whole-row assignments and any per-slice split attributions.
        var importAccount = await LoadOwnedAccountAsync(request.AccountId, userId, cancellationToken);
        await EnsureAllOwnedAsync(
            _db.BudgetItems.Where(i => i.BudgetCategory.BudgetMonth.OwnerId == userId),
            request.Items.SelectMany(BudgetItemIds), cancellationToken);
        await EnsureAllOwnedAsync(
            _db.HouseholdMembers.Where(m => m.OwnerId == userId),
            request.Items.SelectMany(MemberIds), cancellationToken);
        var counterpartyAccounts = await LoadOwnedAccountsAsync(
            request.Items.Select(i => i.TransferAccountId), userId, cancellationToken);

        // A transfer moves money between the import account and a counterparty, so we must know
        // which account the statement belongs to.
        if (request.AccountId is null && request.Items.Any(i => i.TransferAccountId is not null))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["AccountId"] = new[] { "Choose the account this import belongs to before marking rows as transfers." },
            });
        }
        if (request.AccountId is null && request.Items.Any(i => i.MatchTransferId is not null))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["AccountId"] = new[] { "Choose the account this import belongs to before confirming a recorded transfer." },
            });
        }

        // Serialise against every other writer of the accounts this import can move money in:
        // the statement account, the counterparties of new transfers, and both sides of every
        // transfer a row confirms a leg of. A second commit of the same statement (a double
        // submit, another device) then waits here and reads the first one's rows as already
        // imported, and an edit of a transfer being matched can't interleave with the match
        // (#279 P3-2). Taken before anything below is read, so nothing is judged on a stale read.
        var targetIds = request.Items.Select(i => i.MatchTransferId).Concat(request.Items.Select(i => i.ReturnOfTransferId))
            .Where(id => id.HasValue).Select(id => id!.Value).Distinct().ToList();
        var targetSides = targetIds.Count == 0
            ? new List<Guid?>()
            : (await _db.Transactions.IgnoreQueryFilters().AsNoTracking()
                .Where(t => targetIds.Contains(t.Id) && t.OwnerId == userId)
                .Select(t => new { t.AccountId, t.TransferAccountId })
                .ToListAsync(cancellationToken))
                .SelectMany(t => new[] { t.AccountId, t.TransferAccountId }).ToList();
        var lockedAccountIds = new[] { request.AccountId }
            .Concat(counterpartyAccounts.Keys.Select(id => (Guid?)id))
            .Concat(targetSides)
            .Where(id => id.HasValue).Select(id => id!.Value).Distinct().ToList();
        await using var write = lockedAccountIds.Count == 0
            ? null
            : await _db.BeginLedgerWriteAsync(lockedAccountIds, cancellationToken);

        // Transfers the user chose to confirm the other side of. Loaded tracked: matching writes
        // the statement's date and reference onto the open leg instead of inserting a row.
        var matchTargets = await LoadMatchTargetsAsync(
            request.Items.Select(i => i.MatchTransferId).Concat(request.Items.Select(i => i.ReturnOfTransferId)),
            userId, cancellationToken);
        if (request.AccountId is null && request.Items.Any(i => i.ReturnOfTransferId is not null))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["AccountId"] = new[] { "Choose the account this import belongs to before confirming a returned transfer." },
            });
        }

        // Whole-row assignments run through the same invariant every other write path uses
        // (direction↔kind, month coherence with the acknowledge escape) — batch-loaded here so a
        // large statement validates in one query instead of one per row. Ownership was proven
        // above; EnsureWholeLineAssignable re-checks it as defence in depth.
        var wholeLineIds = request.Items
            .Where(i => i.TransferAccountId is null && i.Splits is not { Count: > 0 })
            .Where(i => i.BudgetItemId.HasValue)
            .Select(i => i.BudgetItemId!.Value)
            .Distinct()
            .ToList();
        var wholeLines = await _db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Include(i => i.Jar)
                .ThenInclude(j => j!.FundingAccount)
            .Where(i => wholeLineIds.Contains(i.Id))
            .ToDictionaryAsync(i => i.Id, cancellationToken);
        // The departures of those lines' jars that the statement account may not hold on a row's
        // date: a row from an account the jar has left, dated while it held it there, goes on
        // the jar's line (R2-D1).
        var stretches = await JarStretches.LoadAsync(_db,
            wholeLines.Values.Where(i => i.Jar is not null && (i.Jar.FundingAccountId != request.AccountId || i.Jar.FundingAccountSince is not null))
                .Select(i => i.Jar!.Id),
            cancellationToken);
        // Every line a row names (whole or a slice) that is a jar's savings line: the jar's account
        // and the day it moved there. A payment on one the statement account didn't hold on its
        // date is written through JarMovements, which keeps it on the jar when that account held it
        // then; the reader derives only the jar's own account's payments (rule 79).
        var allLineIds = request.Items.SelectMany(BudgetItemIds).Where(id => id is not null).Select(id => id!.Value).Distinct().ToList();
        var jarHomes = await _db.BudgetItems
            .AsNoTracking()
            .Where(i => allLineIds.Contains(i.Id) && i.SavingsId != null && i.Jar != null)
            .Select(i => new { i.Id, i.Jar!.FundingAccountId, i.Jar.FundingAccountSince })
            .ToDictionaryAsync(i => i.Id, i => (i.FundingAccountId, i.FundingAccountSince), cancellationToken);
        bool DrawsFromLeftJar(CommitImportItem row) =>
            importAccount is not null
            && BudgetItemIds(row).Any(id => id is Guid lineId && jarHomes.TryGetValue(lineId, out var home)
                                            && !JarLedgerReader.HeldOn(home.FundingAccountId, home.FundingAccountSince, importAccount.Id, row.Date));

        // Idempotency: never re-create a row this STATEMENT ACCOUNT already knows (double-submit,
        // overlap, retry). The shared definition covers the leg this account's statement carries:
        // its own rows and outgoing transfers by BankReference, incoming transfers by
        // ReceiptBankReference. A bank reference reused on a DIFFERENT statement account remains
        // a genuinely distinct transaction, not a duplicate.
        var accountId = request.AccountId;
        var known = await StatementReferences.KnownAsync(_db, userId, accountId, cancellationToken);

        int imported = 0, skipped = 0, credits = 0, debits = 0, transfers = 0, matched = 0, pendingReview = 0, returned = 0;
        var created = new List<Transaction>();
        var fees = new List<Transaction>();
        // The rows skipped as duplicates, by the reference the request sent (a created row may
        // carry a derived reference), so the screen can leave them out of its money totals.
        var skippedReferences = new List<string>();
        var sentReference = new Dictionary<Transaction, string>(ReferenceEqualityComparer.Instance);
        // The same rows by their position in the request: references need not be unique (TX-P3-5).
        var skippedIndexes = new List<int>();
        var sentIndex = new Dictionary<Transaction, int>(ReferenceEqualityComparer.Instance);
        var rowIndex = request.Items
            .Select((item, index) => (item, index))
            .ToDictionary(x => x.item, x => x.index, ReferenceEqualityComparer.Instance);
        // The legs rows of this import confirm: a transfer's departure and its return can be on
        // one statement (a bounced transfer), but no leg is confirmed twice.
        var matchedIds = new HashSet<(Guid TransferId, TransferLeg Leg)>();
        var held = new List<ImportHeldRow>();
        // What this import's rows drew from archived jars so far (his 1 Oct answer "Refuse").
        var archivedDrawn = new Dictionary<Guid, decimal>();
        var anyArchived = await _db.Jars.AnyAsync(j => j.OwnerId == userId && j.IsArchived, cancellationToken);
        // What the rows accepted so far do to the statement account's jars, for the rule 68 check
        // of a transfer from a jar: nothing is saved until the end, so the ledger read from the
        // database does not see them. A transfer a row confirmed a leg of is left out of that
        // ledger, so the money it already read for that leg isn't counted a second time.
        var earlierChanges = new List<JarLedgerChange>();
        var confirmedTransferIds = new List<Guid>();
        Dictionary<Guid, Guid>? lineJars = null;
        Dictionary<Guid, Jar>? jarsById = null;
        async Task RecordChangeAsync(
            DateOnly date, decimal amount, bool isCredit, Guid? fromJar, IReadOnlyList<JarAllocationInput>? intoJars, Transaction? payment = null)
        {
            if (importAccount is null)
            {
                return;
            }
            var postings = new List<JarLedgerPosting>();
            if (isCredit)
            {
                var intoJarsTotal = 0m;
                foreach (var allocation in intoJars ?? Array.Empty<JarAllocationInput>())
                {
                    postings.Add(new JarLedgerPosting(allocation.JarId, allocation.Amount));
                    intoJarsTotal += allocation.Amount;
                }
                postings.Add(new JarLedgerPosting(null, amount - intoJarsTotal));
            }
            else if (payment is { Type: TransactionType.Expense })
            {
                // Rule 79, as the ledger reads the payment back: the jar its line (or each slice's
                // line) names while the account holds it; the rest from the jar the row names, or
                // unallocated.
                lineJars ??= await JarLedgerReader.LineJarsAsync(_db, userId, cancellationToken);
                jarsById ??= await _db.Jars.AsNoTracking().Where(j => j.OwnerId == userId).ToDictionaryAsync(j => j.Id, cancellationToken);
                postings.AddRange(JarLedgerReader.Derive(payment, importAccount, -amount, lineJars, jarsById)
                    .Select(p => p.JarId is null ? p with { JarId = fromJar } : p));
            }
            else
            {
                postings.Add(new JarLedgerPosting(fromJar, -amount));
            }
            earlierChanges.Add(new JarLedgerChange(date, isCredit ? amount : -amount, postings));
        }
        // A returned transfer's money back in the statement account, as the ledger will read it
        // once saved: the return leg into unallocated funds on its date, then the jars its return
        // operations refill. Recorded for a transfer the stored ledger is read without (a row
        // confirmed its departure) or whose return a row only now confirms, so a later row taking
        // from the refilled jar is judged with the money back (#297 review R3-P3-1).
        var returnChanges = new Dictionary<Guid, List<JarLedgerChange>>();
        async Task RecordReturnAsync(Transaction transfer)
        {
            if (returnChanges.Remove(transfer.Id, out var stale))
            {
                earlierChanges.RemoveAll(c => stale.Any(x => ReferenceEquals(x, c)));
            }
            if (importAccount is null || transfer.ReturnedOn is not DateOnly returnedOn || transfer.AccountId != importAccount.Id)
            {
                return;
            }
            var changes = new List<JarLedgerChange>
            {
                new(returnedOn, transfer.Amount, new[] { new JarLedgerPosting(null, transfer.Amount) }),
            };
            changes.AddRange((await TransferReturns.OperationsAsync(_db, transfer.Id, cancellationToken))
                // As the reader counts them: one dated after the return is set aside.
                .Where(op => op.AccountId == importAccount.Id && op.Date <= returnedOn)
                .Select(op => new JarLedgerChange(op.Date, 0m,
                    op.Postings.Select(p => new JarLedgerPosting(p.JarId, p.Amount)).ToList())));
            returnChanges[transfer.Id] = changes;
            earlierChanges.AddRange(changes);
        }

        // Rule 74/11: the statement account is evaluated row by row in date order, against its
        // stored money plus the rows accepted so far. A row that would take it below zero on any
        // date is held (reported, not posted) and the later rows are judged without it. The
        // candidate state carries the tracked match targets, since matching posts their open leg.
        // A match or a return can also move the OTHER account's leg; that account joins the same
        // running state the first time, so two rows of one import are judged together there too.
        var candidate = new List<Transaction>();
        var inCandidate = new HashSet<Guid>();
        var loadedAccounts = new HashSet<Guid>();
        async Task LoadIntoCandidateAsync(Account account)
        {
            if (!loadedAccounts.Add(account.Id))
            {
                return;
            }
            var storedRows = await _db.Transactions
                .AsNoTracking()
                .Where(t => t.OwnerId == account.OwnerId
                            && (t.AccountId == account.Id
                                || (t.Type == TransactionType.Transfer && t.TransferAccountId == account.Id)))
                .ToListAsync(cancellationToken);
            foreach (var row in storedRows.Where(t => inCandidate.Add(t.Id)))
            {
                candidate.Add(row);
            }
        }
        void AddToCandidate(Transaction row)
        {
            if (inCandidate.Add(row.Id))
            {
                candidate.Add(row);
            }
        }
        // The tracked match targets and their fees stand in for their stored rows.
        foreach (var target in matchTargets.Values)
        {
            AddToCandidate(target);
            if (target.Fee is not null)
            {
                AddToCandidate(target.Fee);
            }
        }
        if (importAccount is not null)
        {
            await LoadIntoCandidateAsync(importAccount);
        }
        // An account's state with the rows accepted so far, plus tentative rows in place of the
        // one with <paramref name="replacing"/>'s id (a fee about to change).
        string? ShortfallIn(Account account, Guid? replacing, params Transaction[] tentative) =>
            AccountBalanceGuard.FirstShortfall(
                new[] { account },
                candidate.Where(t => t.Id != replacing).Concat(tentative).ToList());
        string? Shortfall(Guid? replacing, params Transaction[] tentative) =>
            importAccount is null ? null : ShortfallIn(importAccount, replacing, tentative);
        async Task<string?> OtherShortfallAsync(Account account, Guid? replacing, params Transaction[] tentative)
        {
            await LoadIntoCandidateAsync(account);
            return ShortfallIn(account, replacing, tentative);
        }

        // Rule 74/11 judges each day on its closing balance, so a day's money in is taken before
        // its money out: a payment is never held only because the file lists it before that
        // day's deposit.
        var ordered = request.Items
            .Select((item, index) => (item, index))
            .OrderBy(x => x.item.Date)
            .ThenBy(x => x.item.IsCredit ? 0 : 1)
            .ThenBy(x => x.index)
            .Select(x => x.item);

        foreach (var item in ordered)
        {
            // A reference this account already recorded for the same entry is a duplicate; one
            // recorded for an entry with different details (a reused reference) is imported under
            // a derived reference unique to this entry (O1 answer 2).
            var resolution = known.Resolve(item.Reference, item.Date, item.Amount, item.IsCredit);
            if (resolution.Duplicate
                || (resolution.Reference is string taken && !known.Add(taken, item.Date, item.Amount, item.IsCredit)))
            {
                skipped++;
                skippedReferences.Add(item.Reference);
                skippedIndexes.Add(rowIndex[item]);
                continue;
            }
            var reference = resolution.Reference;

            // The bank sent a transfer back: the credit confirms its return to this account, and
            // the destination never receives it (O1 answer 4).
            if (item.ReturnOfTransferId is Guid returnId)
            {
                var target = ConfirmReturn(item, returnId, importAccount!, matchTargets, matchedIds);
                var returnBasis = await TransferReturns.BasisAsync(_db, target, cancellationToken);
                var (previousReturned, previousReturnReference, previousReceived) = (target.ReturnedOn, target.ReturnBankReference, target.ReceivedOn);
                target.ReturnedOn = item.Date;
                target.ReturnBankReference = reference;
                // An arrival only the app recorded ("Move money" guesses the departure day) never
                // happened: the money came back instead, so the destination loses it (rule 74 there too).
                target.ReceivedOn = null;
                var returnShortfall = Shortfall(null)
                    ?? (previousReceived is not null
                        ? await OtherShortfallAsync(target.TransferAccount!, null)
                        : null);
                if (returnShortfall is not null)
                {
                    (target.ReturnedOn, target.ReturnBankReference, target.ReceivedOn) = (previousReturned, previousReturnReference, previousReceived);
                    matchedIds.Remove((returnId, TransferLeg.Return));
                    known.Remove(reference);
                    held.Add(new ImportHeldRow(item.Reference, Index: rowIndex[item], Message: returnShortfall));
                    continue;
                }
                if (target.TransferAccountId is Guid neverReached)
                {
                    await JarMovements.ClearAsync(_db, target, neverReached, cancellationToken);
                }
                // The jars the money left get it back, as they stand now (P72); a return already
                // marked by hand keeps the decision it was recorded with and takes the bank's date.
                await TransferReturns.SyncAsync(_db, target, importAccount!.Id, returnBasis, cancellationToken);
                if (previousReturned is null || confirmedTransferIds.Contains(target.Id))
                {
                    await RecordReturnAsync(target);
                }
                returned++;
                continue;
            }

            // Transfer rows move money between accounts — no budget line, member or split. A match
            // may leave the counterparty to the transfer it names: its other side can be private
            // to another login, whose id this login never receives (P57).
            var matchedCounterparty = item.TransferAccountId is null && item.MatchTransferId is Guid namedMatch
                                      && matchTargets.TryGetValue(namedMatch, out var namedTarget)
                ? item.IsCredit ? namedTarget.AccountId : namedTarget.TransferAccountId
                : null;
            if ((item.TransferAccountId ?? matchedCounterparty) is Guid counterparty)
            {
                var importAccountId = request.AccountId!.Value; // guaranteed by the pre-loop check
                if (counterparty == importAccountId)
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["Items"] = new[]
                        {
                            $"The transfer '{item.Payee}' must move to a different account from the one being imported.",
                        },
                    });
                }

                // Both transfer legs move the raw amount, so — exactly like /transfer — the two
                // accounts must share a currency and the row must be in it, or the currency-blind
                // balances silently change net worth.
                // Null only for a matched side hidden from this login; the match checks its currency.
                var counterpartyAccount = counterpartyAccounts.GetValueOrDefault(counterparty)
                    ?? (item.IsCredit ? matchTargets[item.MatchTransferId!.Value].Account : matchTargets[item.MatchTransferId!.Value].TransferAccount);
                if (importAccount!.Currency != counterpartyAccount?.Currency && counterpartyAccount is not null)
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["Items"] = new[]
                        {
                            $"The transfer '{item.Payee}' moves between a {importAccount.Currency.Value} and a " +
                            $"{counterpartyAccount.Currency.Value} account. Both accounts must use the same currency.",
                        },
                    });
                }
                TransactionInvariants.EnsureAccountCurrency(importAccount!, CurrencyCode.From(item.Currency), "Items");

                // The user picked a recorded transfer this row is the other side of: attach this
                // statement's leg to it and apply no second balance movement (rules 8/50/51). A leg
                // recorded in the app takes the bank's date (rule 69). A difference between what
                // left and what arrived is the fee the user accepted (O1 answer 5).
                if (item.MatchTransferId is Guid matchId)
                {
                    var (target, newFee) = ConfirmMatch(item, matchId, importAccountId, counterparty, matchTargets, matchedIds);
                    var returnBasis = await TransferReturns.BasisAsync(_db, target, cancellationToken);
                    var before = (target.DepartedOn, target.ReceivedOn, target.BankReference, target.ReceiptBankReference, target.Date, target.Amount);
                    var oldFee = target.Fee;
                    if (item.IsCredit)
                    {
                        target.ReceivedOn = item.Date;
                        target.ReceiptBankReference = reference;
                        target.ReceiptKnownBySourceReference = false;
                        target.Amount = item.Amount;
                    }
                    else
                    {
                        target.DepartedOn = item.Date;
                        target.BankReference = reference;
                        target.Date = item.Date;
                    }
                    // Rule 69: the bank's date can pass the other leg's date that only the app
                    // recorded ("Move money" guesses the arrival on the departure day). That leg
                    // moves with it, so the money is never in both accounts at once — unless that
                    // side is private to another login, which only its holder changes (P57).
                    var otherLegAccount = OtherLegToFollow(target, item.IsCredit, item.Date);
                    if (otherLegAccount is not null)
                    {
                        if (item.IsCredit)
                        {
                            target.DepartedOn = item.Date;
                            target.Date = item.Date;
                        }
                        else
                        {
                            target.ReceivedOn = item.Date;
                        }
                    }
                    // The fee follows the departure; judged here on its new amount and date.
                    var tentativeFee = newFee is decimal f || oldFee is not null
                        ? new Transaction
                        {
                            Id = oldFee?.Id ?? Guid.NewGuid(), OwnerId = userId, Type = TransactionType.Expense,
                            AccountId = target.AccountId, Amount = newFee ?? oldFee!.Amount, Currency = target.Currency,
                            Date = target.DepartedOn ?? item.Date,
                        }
                        : null;
                    var matchShortfall = (tentativeFee is null ? Shortfall(null) : Shortfall(oldFee?.Id, tentativeFee))
                        ?? (otherLegAccount is null
                            ? null
                            : tentativeFee is null
                                ? await OtherShortfallAsync(otherLegAccount, null)
                                : await OtherShortfallAsync(otherLegAccount, oldFee?.Id, tentativeFee));
                    // Rule 68: a departure from a jar takes at most what the jar holds, as the
                    // transfer form's does; a departure the app already recorded from the same jar
                    // is compared with what it took.
                    if (matchShortfall is null && !item.IsCredit && item.PaidFromJarId is Guid matchJar)
                    {
                        var previousDraw = before.DepartedOn is DateOnly previousDeparture
                                           && await DepartureJarAsync(target.Id, target.AccountId!.Value, cancellationToken) == matchJar
                            ? (before.Amount, previousDeparture, target.ReturnedOn)
                            : ((decimal, DateOnly, DateOnly?)?)null;
                        matchShortfall = await JarHistoryChecks.TransferDrawRefusalAsync(
                            _db, userId, target, importAccount, matchJar, cancellationToken, previousDraw, earlierChanges, confirmedTransferIds);
                    }
                    if (matchShortfall is not null)
                    {
                        (target.DepartedOn, target.ReceivedOn, target.BankReference, target.ReceiptBankReference, target.Date, target.Amount) = before;
                        matchedIds.Remove((matchId, item.IsCredit ? TransferLeg.Receipt : TransferLeg.Departure));
                        known.Remove(reference);
                        held.Add(new ImportHeldRow(item.Reference, Index: rowIndex[item], Message: matchShortfall));
                        continue;
                    }

                    // Null only for a source hidden from this login, which a match never changes.
                    var sourceAccount = item.IsCredit ? counterpartyAccount : importAccount;
                    // Where the money left from: the row's answer on a debit; on a credit, the jar
                    // the departure already names, kept when a fee changes the transfer's amount.
                    var fromJar = item.IsCredit
                        ? await DepartureJarAsync(target.Id, target.AccountId!.Value, cancellationToken)
                        : item.PaidFromJarId;
                    if (newFee is decimal fee)
                    {
                        var feeRow = await TransferFees.ApplyAsync(
                            _db, _identity, userId, target, sourceAccount!, fee, item.FeeBudgetItemId, item.AcknowledgeCrossMonth, fromJar,
                            "Items", new List<Guid>(), cancellationToken);
                        if (oldFee is null && feeRow is not null)
                        {
                            fees.Add(feeRow);
                            AddToCandidate(feeRow);
                        }
                    }
                    else
                    {
                        await TransferFees.FollowDepartureAsync(_db, userId, target, item.AcknowledgeCrossMonth, "Items", cancellationToken);
                    }

                    if (item.IsCredit)
                    {
                        if (item.JarAllocations is { Count: > 0 } || target.Amount != before.Amount)
                        {
                            await JarMovements.ApplyIncomingAsync(
                                _db, userId, target, importAccount, item.Date, target.Amount, item.JarAllocations, "Items", cancellationToken,
                                postsNow: before.ReceivedOn is null);
                        }
                        else if (target.ReceivedOn is DateOnly received && received != before.ReceivedOn && target.DepartedOn is not null)
                        {
                            // The answer kept from before the statement, on the bank's date.
                            await JarMovements.FollowReceiptAsync(_db, target, importAccount.Id, received, cancellationToken);
                        }
                        if (target.Amount != before.Amount && target.DepartedOn is not null)
                        {
                            await JarMovements.ApplyOutgoingAsync(_db, userId, target, sourceAccount!, fromJar, "Items", cancellationToken);
                        }
                    }
                    else if (item.PaidFromJarId is not null)
                    {
                        await JarMovements.ApplyOutgoingAsync(_db, userId, target, importAccount, item.PaidFromJarId, "Items", cancellationToken);
                    }
                    // A receipt held for its departure posts now, keeping the answer it was imported with.
                    if (!item.IsCredit && before.DepartedOn is null && target.ReceivedOn is DateOnly heldReceipt && target.TransferAccountId is Guid heldIn)
                    {
                        await JarMovements.FollowReceiptAsync(_db, target, heldIn, heldReceipt, cancellationToken);
                    }
                    // Otherwise the departure keeps its jar answer, and its draws follow a date
                    // the statement moved, as the fee's do.
                    if (target.DepartedOn is DateOnly departed && departed != before.DepartedOn && target.AccountId is Guid departedFrom
                        && !(item.IsCredit ? target.Amount != before.Amount : item.PaidFromJarId is not null))
                    {
                        await JarMovements.FollowDateAsync(_db, userId, target, departedFrom, departed, cancellationToken);
                    }
                    // A returned transfer's jars follow a departure now drawn from other jars (rule 90).
                    if (target.ReturnedOn is not null && target.AccountId is Guid returnSource)
                    {
                        await TransferReturns.SyncAsync(_db, target, returnSource, returnBasis, cancellationToken);
                    }
                    // The leg as it now stands, with the jar answer it keeps when the row gives none.
                    var keptAnswer = item.IsCredit
                        ? item.JarAllocations ?? await ReceiptJarsAsync(target.Id, importAccount.Id, cancellationToken)
                        : null;
                    var keptJar = item.IsCredit ? null : item.PaidFromJarId ?? await DepartureJarAsync(target.Id, importAccount.Id, cancellationToken);
                    await RecordChangeAsync(item.Date, item.Amount, item.IsCredit, keptJar, keptAnswer);
                    confirmedTransferIds.Add(target.Id);
                    if (!item.IsCredit)
                    {
                        // The stored ledger is now read without this transfer, its return included.
                        await RecordReturnAsync(target);
                    }
                    matched++;
                    transfers++;
                    continue;
                }

                // A credit moved money INTO the import account (from the counterparty); a debit, OUT.
                // Each statement proves only its own bank's leg: a debit is a confirmed departure
                // (receipt unknown, money in transit — rule 71); a credit is a receipt whose
                // departure is unknown, held for review with no posted effect (rule 72).
                var (source, dest) = item.IsCredit
                    ? (counterparty, importAccountId)
                    : (importAccountId, counterparty);
                // A debit may be split into the transfer and its explicit fee (O1 answer 5): what
                // arrives is the row less the fee.
                var rowFee = !item.IsCredit && item.Fee is > 0m ? item.Fee.Value : 0m;
                var transfer = new Transaction
                {
                    OwnerId = userId,
                    Amount = item.Amount - rowFee,
                    Currency = CurrencyCode.From(item.Currency),
                    Type = TransactionType.Transfer,
                    Date = item.Date,
                    Payee = Truncate(CardNumberMask.Mask(item.Payee)!, 200),
                    AccountId = source,
                    TransferAccountId = dest,
                    DepartedOn = item.IsCredit ? null : item.Date,
                    ReceivedOn = item.IsCredit ? item.Date : null,
                    BankReference = item.IsCredit ? null : reference,
                    ReceiptBankReference = item.IsCredit ? reference : null,
                };
                var newTransferFee = rowFee > 0m
                    ? new Transaction
                    {
                        OwnerId = userId, Type = TransactionType.Expense, AccountId = source, Amount = rowFee,
                        Currency = transfer.Currency, Date = item.Date,
                    }
                    : null;
                if (!item.IsCredit
                    && (newTransferFee is null ? Shortfall(null, transfer) : Shortfall(null, transfer, newTransferFee)) is string transferShortfall)
                {
                    known.Remove(reference);
                    held.Add(new ImportHeldRow(item.Reference, Index: rowIndex[item], Message: transferShortfall));
                    continue;
                }
                // Rule 68, as the transfer form checks it: counting the rows accepted above.
                if (!item.IsCredit && item.PaidFromJarId is Guid drawJar
                    && await JarHistoryChecks.TransferDrawRefusalAsync(
                        _db, userId, transfer, importAccount, drawJar, cancellationToken,
                        earlier: earlierChanges, alsoExclude: confirmedTransferIds) is string drawRefusal)
                {
                    known.Remove(reference);
                    held.Add(new ImportHeldRow(item.Reference, Index: rowIndex[item], Message: drawRefusal));
                    continue;
                }
                _db.Transactions.Add(transfer);
                created.Add(transfer);
                sentReference[transfer] = item.Reference;
                sentIndex[transfer] = rowIndex[item];
                AddToCandidate(transfer);
                if (rowFee > 0m)
                {
                    var feeRow = await TransferFees.ApplyAsync(
                        _db, _identity, userId, transfer, importAccount, rowFee, item.FeeBudgetItemId, item.AcknowledgeCrossMonth,
                        item.PaidFromJarId, "Items", new List<Guid>(), cancellationToken);
                    fees.Add(feeRow!);
                    AddToCandidate(feeRow!);
                }
                if (item.IsCredit)
                {
                    if (item.JarAllocations is { Count: > 0 })
                    {
                        await JarMovements.ApplyIncomingAsync(
                            _db, userId, transfer, importAccount, item.Date, item.Amount, item.JarAllocations, "Items", cancellationToken);
                    }
                }
                else if (item.PaidFromJarId is not null)
                {
                    await JarMovements.ApplyOutgoingAsync(_db, userId, transfer, importAccount, item.PaidFromJarId, "Items", cancellationToken);
                }
                if (!item.IsCredit)
                {
                    // A receipt waits for its departure (rule 72) and moves no money yet.
                    await RecordChangeAsync(item.Date, item.Amount, isCredit: false, item.PaidFromJarId, null);
                }
                imported++;
                transfers++;
                if (item.IsCredit) pendingReview++;
                continue;
            }

            var isSplit = item.Splits is { Count: > 0 };
            var type = item.IsCredit ? TransactionType.Income : TransactionType.Expense;

            // An imported row pinned to the import account must be in that account's currency —
            // the same rule manual entry enforces (account balances sum raw amounts, no FX).
            TransactionInvariants.EnsureAccountCurrency(importAccount, CurrencyCode.From(item.Currency), "Items");

            // The whole-row assignment runs the shared invariant: direction↔kind, and month
            // coherence unless this row explicitly acknowledges budgeting to another month.
            if (!isSplit && item.BudgetItemId is Guid lineId)
            {
                TransactionInvariants.EnsureWholeLineAssignable(
                    wholeLines[lineId], userId, type, item.Date, item.AcknowledgeCrossMonth, "Items", request.AccountId, stretches);
            }

            var transaction = new Transaction
            {
                OwnerId = userId,
                Amount = item.Amount,
                Currency = CurrencyCode.From(item.Currency),
                Type = type,
                Date = item.Date,
                Payee = Truncate(CardNumberMask.Mask(item.Payee)!, 200),
                BankReference = reference,
                AccountId = request.AccountId,
                // A split transaction carries no whole-row line/member — the slices do.
                BudgetItemId = isSplit ? null : item.BudgetItemId,
                MemberId = isSplit ? null : item.MemberId,
            };

            if (isSplit)
            {
                // The same slice guard every split path uses: sum-to-parent, ownership,
                // direction, month coherence (with the acknowledge escape), member ownership.
                var slices = item.Splits!
                    .Select(s => new SplitAllocationInput(s.BudgetItemId, s.Amount, s.MemberId))
                    .ToList();
                await TransactionInvariants.ValidateSlicesAsync(
                    _db, userId, type, item.Amount, slices,
                    item.Date, item.AcknowledgeCrossMonth,
                    errorKey: "Items", cancellationToken, request.AccountId);

                foreach (var slice in item.Splits!)
                {
                    transaction.Splits.Add(new TransactionSplit
                    {
                        BudgetItemId = slice.BudgetItemId,
                        MemberId = slice.MemberId,
                        Amount = slice.Amount,
                    });
                }
            }

            if (!item.IsCredit && Shortfall(null, transaction) is string rowShortfall)
            {
                known.Remove(reference);
                held.Add(new ImportHeldRow(item.Reference, Index: rowIndex[item], Message: rowShortfall));
                continue;
            }
            // A row on an archived jar's line is refused like the same payment typed in the form,
            // and held with the reason rather than failing the import.
            if (!item.IsCredit && importAccount is not null && anyArchived
                && await JarMovements.ArchivedLineRefusalAsync(_db, userId, transaction, importAccount, archivedDrawn, cancellationToken) is string archivedRefusal)
            {
                known.Remove(reference);
                held.Add(new ImportHeldRow(item.Reference, Index: rowIndex[item], Message: archivedRefusal));
                continue;
            }

            _db.Transactions.Add(transaction);
            created.Add(transaction);
            sentReference[transaction] = item.Reference;
            sentIndex[transaction] = rowIndex[item];
            AddToCandidate(transaction);

            if (importAccount is not null)
            {
                if (item.IsCredit && item.JarAllocations is { Count: > 0 })
                {
                    await JarMovements.ApplyIncomingAsync(
                        _db, userId, transaction, importAccount, item.Date, item.Amount, item.JarAllocations, "Items", cancellationToken);
                }
                else if (!item.IsCredit && (item.PaidFromJarId is not null || DrawsFromLeftJar(item)))
                {
                    await JarMovements.ApplyOutgoingAsync(_db, userId, transaction, importAccount, item.PaidFromJarId, "Items", cancellationToken);
                }
            }

            await RecordChangeAsync(item.Date, item.Amount, item.IsCredit, item.PaidFromJarId, item.JarAllocations, transaction);
            imported++;
            if (item.IsCredit) credits++; else debits++;
        }

        if (created.Count > 0 || matched > 0 || returned > 0)
        {
            // A row in another currency waits for its budget-currency amount (rules 42/44); a
            // transfer's fee row does so in TransferFees.
            ForeignAmounts.MarkWaiting(
                created, await BudgetCurrency.ResolveAsync(_db, _identity, userId, cancellationToken));

            // The dedup snapshot above is per-request memory; a CONCURRENT commit (double-click,
            // second device, another login in the household) can insert the same references after
            // we read it. The unique reference indexes turn that race into a DbUpdateException
            // here — recover by dropping the collided rows and saving the rest.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    await _db.SaveChangesAsync(cancellationToken);
                    break;
                }
                catch (DbUpdateException ex) when (attempt < 3 && IsReferenceCollision(ex))
                {
                    var collided = await FindCollidedAsync(userId, created, cancellationToken);
                    if (collided.Count == 0)
                    {
                        throw; // not actually our collision — surface the real error
                    }

                    foreach (var row in collided)
                    {
                        if (row.Fee is Transaction collidedFee)
                        {
                            _db.JarAllocations.RemoveRange(collidedFee.JarAllocations);
                            _db.Transactions.Remove(collidedFee);
                        }
                        _db.JarAllocations.RemoveRange(row.JarAllocations); // Added entities: Remove detaches them
                        _db.Transactions.Remove(row); // an Added entity: Remove detaches it
                        created.Remove(row);
                        imported--;
                        skipped++;
                        skippedReferences.Add(sentReference.TryGetValue(row, out var sent) ? sent : row.BankReference ?? string.Empty);
                        if (sentIndex.TryGetValue(row, out var sentAt))
                        {
                            skippedIndexes.Add(sentAt);
                        }
                        if (row.Type == TransactionType.Transfer)
                        {
                            transfers--;
                            if (row.DepartedOn is null) pendingReview--;
                        }
                        else if (row.Type == TransactionType.Income) credits--;
                        else debits--;
                    }

                    if (created.Count == 0 && matched == 0 && returned == 0)
                    {
                        break; // everything we had was already imported by the other commit
                    }
                }
            }
        }
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return new ImportStatementResult(
            TotalEntries: request.Items.Count,
            Imported: imported,
            SkippedDuplicates: skipped,
            Credits: credits,
            Debits: debits,
            Iban: null,
            AutoCategorized: 0,
            Transfers: transfers,
            MatchedTransfers: matched,
            PendingReviewTransfers: pendingReview,
            Held: held,
            Returned: returned,
            AwaitingAmount: created.Concat(fees).Count(t => t.FxPending),
            SkippedReferences: skippedReferences,
            SkippedIndexes: skippedIndexes);
    }

    /// <summary>
    /// The user-selected transfer must genuinely be the other side of this row: same two
    /// accounts in this row's direction, same currency, its leg for the statement account open
    /// to a statement (unknown, or recorded in the app without that bank's reference), and the
    /// amounts agreeing, or differing by a fee the row states explicitly (O1 answer 5). Anything
    /// else is a mismatch to surface, never something to guess past. Returns the transfer and
    /// its new fee when the match changes it.
    /// </summary>
    private static (Transaction Target, decimal? NewFee) ConfirmMatch(
        CommitImportItem item, Guid matchId, Guid importAccountId, Guid counterparty,
        IReadOnlyDictionary<Guid, Transaction> targets, HashSet<(Guid, TransferLeg)> matchedIds)
    {
        if (!targets.TryGetValue(matchId, out var target))
        {
            throw new NotFoundException($"Transfer {matchId} was not found.");
        }
        var errors = new List<string>();
        var (expectedSource, expectedDest) = item.IsCredit
            ? (counterparty, importAccountId)
            : (importAccountId, counterparty);
        if (target.AccountId != expectedSource || target.TransferAccountId != expectedDest)
        {
            errors.Add("it moves between different accounts");
        }
        decimal? newFee = null;
        var candidate = target.AccountId is null || target.TransferAccountId is null
            ? null
            : StatementReferences.CandidateFor(target, importAccountId, item.IsCredit, item.Amount, item.Currency, item.Date, null);
        if (!StatementReferences.IsOpenFor(target, importAccountId, item.IsCredit))
        {
            errors.Add(item.IsCredit
                ? target.ReturnedOn is not null ? "it was sent back, so it has no receipt" : "its receipt is already confirmed by a statement"
                : "its departure is already confirmed by a statement");
        }
        else if (candidate is null || candidate.Kind != TransferMatchKinds.Match)
        {
            var fee = target.Fee?.Amount ?? 0m;
            errors.Add(!string.Equals(target.Currency.Value, item.Currency, StringComparison.OrdinalIgnoreCase)
                ? $"it is in {target.Currency.Value}, not {item.Currency}"
                : item.IsCredit
                    ? target.Amount < item.Amount
                        ? $"{target.Amount:0.####} {target.Currency.Value} was sent, less than the {item.Amount:0.####} received"
                        : $"{target.Amount:0.####} {target.Currency.Value} was sent and {item.Amount:0.####} arrived, too large a difference to be a fee"
                    : target.Amount + fee > item.Amount
                        ? $"its amount is {target.Currency.Value} {target.Amount + fee:0.####}, more than the {item.Currency} {item.Amount:0.####} that left"
                        : $"its amount is {target.Currency.Value} {target.Amount:0.####} and {item.Amount:0.####} left, too large a difference to be a fee");
        }
        else if (candidate.Fee is decimal fee)
        {
            // The difference is a fee only when the user says so, with the exact figure.
            if (item.Fee != fee)
            {
                errors.Add($"what left and what arrived differ by {fee:0.####} {target.Currency.Value}; confirm that fee to match it");
            }
            newFee = fee;
        }
        else if (item.Fee is > 0m && item.Fee != target.Fee?.Amount)
        {
            errors.Add("the amounts already agree, so there is no fee to record");
        }
        if (!matchedIds.Add((matchId, item.IsCredit ? TransferLeg.Receipt : TransferLeg.Departure)))
        {
            errors.Add(item.IsCredit
                ? "another row in this import already confirms its receipt"
                : "another row in this import already confirms its departure");
        }
        if (errors.Count > 0)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Items"] = new[]
                {
                    $"'{item.Payee}' can't confirm the selected transfer: {string.Join("; ", errors)}.",
                },
            });
        }
        return (target, newFee);
    }

    /// <summary>
    /// The user-selected transfer must genuinely be coming back to this account: it left this
    /// account, no statement confirmed its receipt or a return yet, and the amount, currency
    /// and date (not before it left) agree.
    /// </summary>
    private static Transaction ConfirmReturn(
        CommitImportItem item, Guid transferId, Account importAccount,
        IReadOnlyDictionary<Guid, Transaction> targets, HashSet<(Guid, TransferLeg)> matchedIds)
    {
        if (!targets.TryGetValue(transferId, out var target))
        {
            throw new NotFoundException($"Transfer {transferId} was not found.");
        }
        var candidate = target.AccountId is null || target.TransferAccountId is null
            ? null
            : StatementReferences.CandidateFor(target, importAccount.Id, true, item.Amount, item.Currency, item.Date, null);
        string? error = !StatementReferences.IsReturnableTo(target, importAccount.Id)
            ? target.AccountId != importAccount.Id ? "it did not leave this account"
                : target.DepartedOn is null ? "its departure is not known yet"
                : target.ReceiptBankReference is not null ? "its receipt is confirmed by a statement"
                : "its return is already confirmed by a statement"
            : target.TransferAccount is null
                ? "it went to a private account, so only that account's holder can record it coming back"
            : candidate is not { Kind: TransferMatchKinds.Return }
                ? item.Date < target.DepartedOn!.Value
                    ? "the money can't come back before it left"
                    : $"its amount is {target.Currency.Value} {target.Amount:0.####}, not {item.Currency} {item.Amount:0.####}"
                : !matchedIds.Add((transferId, TransferLeg.Return)) ? "another row in this import already confirms it" : null;
        if (error is not null)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Items"] = new[] { $"'{item.Payee}' can't confirm the selected transfer came back: {error}." },
            });
        }
        return target;
    }

    /// <summary>
    /// The account of <paramref name="target"/>'s other leg when the statement's date for this
    /// leg passes it and that leg is only app-recorded (no bank reference) and visible to this
    /// login: a later departure than the recorded arrival, or an earlier arrival than the recorded
    /// departure. Null when nothing needs to follow.
    /// </summary>
    private static Account? OtherLegToFollow(Transaction target, bool isCredit, DateOnly bankDate) =>
        isCredit
            ? target.DepartedOn is DateOnly departed && bankDate < departed && target.BankReference is null ? target.Account : null
            : target.ReceivedOn is DateOnly received && received < bankDate && target.ReceiptBankReference is null ? target.TransferAccount : null;

    /// <summary>The jar a transfer's departure is recorded as drawing from on the source account, if any.</summary>
    /// <summary>The jar answer a transfer's receipt into <paramref name="accountId"/> is stored with, if any.</summary>
    private async Task<IReadOnlyList<JarAllocationInput>> ReceiptJarsAsync(Guid transferId, Guid accountId, CancellationToken cancellationToken) =>
        (await _db.JarAllocations.AsNoTracking()
            .Where(a => a.TransactionId == transferId && a.AccountId == accountId)
            .SelectMany(a => a.Postings)
            .Where(p => p.JarId != null && p.Amount > 0)
            .Select(p => new { JarId = p.JarId!.Value, p.Amount })
            .ToListAsync(cancellationToken))
        .Select(p => new JarAllocationInput(p.JarId, p.Amount))
        .ToList();

    private async Task<Guid?> DepartureJarAsync(Guid transferId, Guid sourceId, CancellationToken cancellationToken) =>
        await _db.JarAllocationPostings
            .AsNoTracking()
            .Where(p => p.JarAllocation.TransactionId == transferId && p.JarAllocation.AccountId == sourceId
                        && p.JarId != null && p.Amount < 0m)
            .Select(p => p.JarId)
            .FirstOrDefaultAsync(cancellationToken);

    /// <summary>
    /// True when the save failed on one of the unique statement-reference indexes. Matched by index
    /// name in the provider's message so the Application layer needs no SqlClient reference.
    /// </summary>
    private static bool IsReferenceCollision(DbUpdateException ex) =>
        ex.InnerException?.Message.Contains("IX_Transactions_OwnerId_AccountId_BankReference", StringComparison.Ordinal) == true
        || ex.InnerException?.Message.Contains("IX_Transactions_OwnerId_TransferAccountId_ReceiptBankReference", StringComparison.Ordinal) == true
        || ex.InnerException?.Message.Contains("IX_Transactions_OwnerId_AccountId_ReturnBankReference", StringComparison.Ordinal) == true;

    /// <summary>
    /// The created rows whose statement reference another commit persisted first. Each row is
    /// checked on the leg it carries the reference on — a source/outgoing reference against
    /// its AccountId, a receipt reference against its TransferAccountId — exactly the pairs the
    /// failed insert tried.
    /// </summary>
    private async Task<List<Transaction>> FindCollidedAsync(
        string userId, IReadOnlyList<Transaction> created, CancellationToken cancellationToken)
    {
        var collided = new List<Transaction>();

        var sourceRefs = created.Where(t => t.BankReference != null).GroupBy(t => t.AccountId).ToList();
        foreach (var group in sourceRefs)
        {
            var rowAccountId = group.Key;
            var refs = group.Select(t => t.BankReference!).ToList();
            var taken = await _db.Transactions
                .AsNoTracking()
                .Where(t => t.OwnerId == userId && t.AccountId == rowAccountId
                            && t.BankReference != null && refs.Contains(t.BankReference))
                .Select(t => t.BankReference!)
                .ToListAsync(cancellationToken);
            // Case-insensitive: the DB index compares with the column's CI collation, so
            // a case-variant reference blocks the insert — the recovery match must agree
            // or it would rethrow instead of skipping.
            var takenSet = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
            collided.AddRange(group.Where(t => takenSet.Contains(t.BankReference!)));
        }

        var receiptRefs = created.Where(t => t.ReceiptBankReference != null).GroupBy(t => t.TransferAccountId).ToList();
        foreach (var group in receiptRefs)
        {
            var rowAccountId = group.Key;
            var refs = group.Select(t => t.ReceiptBankReference!).ToList();
            var taken = await _db.Transactions
                .AsNoTracking()
                .Where(t => t.OwnerId == userId && t.TransferAccountId == rowAccountId
                            && t.ReceiptBankReference != null && refs.Contains(t.ReceiptBankReference))
                .Select(t => t.ReceiptBankReference!)
                .ToListAsync(cancellationToken);
            var takenSet = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
            collided.AddRange(group.Where(t => takenSet.Contains(t.ReceiptBankReference!) && !collided.Contains(t)));
        }

        return collided;
    }

    /// <summary>The import account, owned by the user — or null when no account was chosen.</summary>
    private async Task<Account?> LoadOwnedAccountAsync(Guid? accountId, string userId, CancellationToken ct)
    {
        if (accountId is not Guid id)
        {
            return null;
        }
        var account = await _db.Accounts.FirstOrDefaultAsync(a => a.Id == id, ct)
            ?? throw new NotFoundException($"Account {id} was not found.");
        if (account.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        return account;
    }

    /// <summary>
    /// Loads the requested (transfer counterparty) accounts, requiring every one to exist and be
    /// owned by the user — the entities are needed for the same-currency transfer checks.
    /// </summary>
    private async Task<Dictionary<Guid, Account>> LoadOwnedAccountsAsync(
        IEnumerable<Guid?> requestedIds, string userId, CancellationToken ct)
    {
        var ids = requestedIds.Where(x => x.HasValue).Select(x => x!.Value).Distinct().ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<Guid, Account>();
        }
        var accounts = await _db.Accounts
            .Where(a => a.OwnerId == userId && ids.Contains(a.Id))
            .ToDictionaryAsync(a => a.Id, ct);
        if (accounts.Count != ids.Count)
        {
            throw new ForbiddenAccessException();
        }
        return accounts;
    }

    /// <summary>Loads the user-selected match targets, tracked, requiring each to be an owned transfer.</summary>
    private async Task<Dictionary<Guid, Transaction>> LoadMatchTargetsAsync(
        IEnumerable<Guid?> requestedIds, string userId, CancellationToken ct)
    {
        var ids = requestedIds.Where(x => x.HasValue).Select(x => x!.Value).Distinct().ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<Guid, Transaction>();
        }
        // Both sides through the privacy filter: a side private to another login loads as null (P57).
        var transfers = await _db.Transactions
            .Include(t => t.Fee)
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .Where(t => ids.Contains(t.Id))
            .ToListAsync(ct);
        foreach (var id in ids)
        {
            var transfer = transfers.FirstOrDefault(t => t.Id == id)
                ?? throw new NotFoundException($"Transfer {id} was not found.");
            if (transfer.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
            if (transfer.Type != TransactionType.Transfer)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["Items"] = new[] { "Only a recorded transfer can be confirmed from a statement row." },
                });
            }
        }
        return transfers.ToDictionary(t => t.Id);
    }

    /// <summary>
    /// Verify that every distinct, non-null id requested exists within <paramref name="ownedSource"/>
    /// (already filtered to the current user). Throws <see cref="ForbiddenAccessException"/> otherwise.
    /// </summary>
    private static async Task EnsureAllOwnedAsync<T>(
        IQueryable<T> ownedSource,
        IEnumerable<Guid?> requestedIds,
        CancellationToken ct) where T : BaseEntity
    {
        var ids = requestedIds.Where(x => x.HasValue).Select(x => x!.Value).Distinct().ToList();
        if (ids.Count == 0)
        {
            return;
        }
        var found = await ownedSource
            .Where(e => ids.Contains(e.Id))
            .Select(e => e.Id)
            .ToListAsync(ct);
        if (found.Count != ids.Count)
        {
            throw new ForbiddenAccessException();
        }
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];

    /// <summary>Every budget line a row references — its whole-row assignment plus any split slices.</summary>
    private static IEnumerable<Guid?> BudgetItemIds(CommitImportItem item)
    {
        yield return item.BudgetItemId;
        yield return item.FeeBudgetItemId;
        if (item.Splits is not null)
        {
            foreach (var slice in item.Splits)
            {
                yield return slice.BudgetItemId;
            }
        }
    }

    /// <summary>Every member a row references — its whole-row attribution plus any split slices.</summary>
    private static IEnumerable<Guid?> MemberIds(CommitImportItem item)
    {
        yield return item.MemberId;
        if (item.Splits is not null)
        {
            foreach (var slice in item.Splits)
            {
                yield return slice.MemberId;
            }
        }
    }
}

/// <summary>The leg of a transfer an import row confirms.</summary>
internal enum TransferLeg
{
    Departure,
    Receipt,
    Return,
}
