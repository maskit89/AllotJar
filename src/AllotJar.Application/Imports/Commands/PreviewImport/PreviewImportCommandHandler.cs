using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Transactions;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Imports.Commands.PreviewImport;

public class PreviewImportCommandHandler : IRequestHandler<PreviewImportCommand, ImportPreviewResult>
{
    /// <summary>
    /// How many days apart a candidate and an existing transaction may book and still count as
    /// the same purchase for the possible-duplicate hint. Covers the purchase-date vs
    /// posting-date drift between statement formats (a card purchase typically posts 1–3 days
    /// later) without flagging genuinely-recurring charges (weekly/monthly repeats sit further apart).
    /// </summary>
    private const int PossibleDuplicateWindowDays = 4;

    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IReadOnlyCollection<IStatementParser> _parsers;
    private readonly ICsvImporter _csv;

    public PreviewImportCommandHandler(
        IApplicationDbContext db,
        ICurrentUser currentUser,
        IEnumerable<IStatementParser> parsers,
        ICsvImporter csv)
    {
        _db = db;
        _currentUser = currentUser;
        _parsers = parsers.ToList();
        _csv = csv;
    }

    public async Task<ImportPreviewResult> Handle(PreviewImportCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // The statement account (when chosen) must be the caller's — the dedup filter below is
        // scoped to it, and a foreign id must fail loudly rather than silently previewing an
        // unfiltered view.
        if (request.AccountId is Guid requestedAccountId)
        {
            var owned = await _db.Accounts
                .AnyAsync(a => a.Id == requestedAccountId && a.OwnerId == userId, cancellationToken);
            if (!owned)
            {
                throw new NotFoundException($"Account {requestedAccountId} was not found.");
            }
        }

        // Route the upload to a parser. A "generic" first upload is sniffed against the dedicated
        // adapters first: the same file must always take the same code path, otherwise the payee
        // text and the idempotency references drift between imports and re-imports duplicate.
        ParsedStatement statement;
        CsvLayout? layout = null;
        var detectedFormat = request.Format;
        if (request.Format == StatementFormat.GenericCsv)
        {
            var sniffed = request.Mapping is null
                ? _parsers.FirstOrDefault(p => p.CanParse(request.Content))
                : null; // the user already confirmed a column mapping — stay generic
            if (sniffed is not null)
            {
                statement = sniffed.Parse(request.Content);
                detectedFormat = sniffed.Format;
            }
            else
            {
                var detected = _csv.Detect(request.Content);
                var defaultCurrency = request.Mapping?.DefaultCurrency ?? request.DefaultCurrency;
                var mapping = (request.Mapping ?? detected.Suggested) with { DefaultCurrency = defaultCurrency };
                statement = _csv.Parse(request.Content, mapping);
                // Pin the date format that was ACTUALLY applied into the echoed mapping. Auto-detection
                // is file-relative (an overlapping re-export can resolve ambiguous dates differently),
                // so the UI must be able to show it — and re-scans/re-imports should reuse it.
                if (mapping.DateFormat is null && statement.ResolvedDateFormat is not null)
                {
                    mapping = mapping with { DateFormat = statement.ResolvedDateFormat };
                }
                layout = detected with { Suggested = mapping };
            }
        }
        else
        {
            var parser = _parsers.FirstOrDefault(p => p.Format == request.Format)
                ?? throw new NotFoundException($"No statement parser is registered for format '{request.Format}'.");
            statement = parser.Parse(request.Content);
        }

        // Drop rows we've already imported. The filter is the COMMIT's dedup exactly (shared
        // StatementReferences): scoped to the statement account and to the leg that account's
        // statement carries, case-insensitive to agree with the unique indexes' CI collation.
        var accountId = request.AccountId;
        var already = await StatementReferences.KnownAsync(_db, userId, accountId, cancellationToken);

        var fresh = statement.Entries
            .Where(e => e.Reference is null || !already.Contains(e.Reference))
            .ToList();
        var skipped = statement.Entries.Count - fresh.Count;

        // Content-level duplicate hints for the rows whose reference did NOT match (e.g. the same
        // statement previously imported through a different format or column mapping).
        var possibleDuplicates = await FindPossibleDuplicatesAsync(userId, fresh, cancellationToken);

        // Recorded transfers whose other side this statement could confirm (rules 50/51/72). The
        // user chooses; the amount agreeing is a reason to SHOW a candidate, never to match it.
        var openLegs = accountId is Guid statementAccountId
            ? await StatementReferences.OpenTransferLegsAsync(_db, userId, statementAccountId, cancellationToken)
            : new List<Domain.Entities.Transaction>();

        // Suggest a budget line per row from the user's past categorisations — same direction,
        // dated on or before the row, resolved to the ROW'S OWN month (no writes) — so the
        // preview shows exactly what a commit would assign, never a prior month's line and
        // never an expense line for a credit.
        var requests = fresh
            .Select(e => (e.Payee, Type: e.IsCredit ? TransactionType.Income : TransactionType.Expense, e.BookingDate))
            .ToList();
        var suggestions = await AutoCategorizer.ResolveLinesAsync(
            _db, userId, new HashSet<Guid>(), requests, cancellationToken);

        var suggestedIds = suggestions.Values.ToHashSet();
        var nameById = suggestedIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await _db.BudgetItems
                .Where(i => suggestedIds.Contains(i.Id))
                .Select(i => new { i.Id, i.Name })
                .ToDictionaryAsync(x => x.Id, x => x.Name, cancellationToken);

        var items = fresh.Select((e, index) =>
        {
            Guid? suggestedId = suggestions.TryGetValue(
                (AutoCategorizer.NormalizeKey(e.Payee),
                 e.IsCredit ? TransactionType.Income : TransactionType.Expense,
                 e.BookingDate), out var id)
                ? id
                : null;
            var suggestedName = suggestedId is Guid sid && nameById.TryGetValue(sid, out var n) ? n : null;
            var matches = accountId is Guid statementAccount
                ? openLegs
                    .Where(t => StatementReferences.IsOpenFor(t, statementAccount, e.IsCredit)
                                && t.Amount == e.Amount
                                && string.Equals(t.Currency.Value, e.Currency, StringComparison.OrdinalIgnoreCase))
                    .OrderBy(t => Math.Abs((t.DepartedOn ?? t.ReceivedOn ?? e.BookingDate).DayNumber - e.BookingDate.DayNumber))
                    .Select(t =>
                    {
                        var counterparty = e.IsCredit ? t.Account! : t.TransferAccount!;
                        return new TransferMatchCandidate(
                            t.Id, counterparty.Id, counterparty.Name, t.Amount, t.Currency.Value,
                            t.DepartedOn, t.ReceivedOn, t.Payee);
                    })
                    .ToList()
                : [];
            return new ImportCandidate(
                Reference: e.Reference ?? string.Empty,
                Date: e.BookingDate,
                Payee: e.Payee,
                Amount: e.Amount,
                Currency: e.Currency,
                IsCredit: e.IsCredit,
                SuggestedBudgetItemId: suggestedId,
                SuggestedBudgetItemName: suggestedName,
                LikelyTransfer: TransferHeuristic.IsLikelyTransfer(e.Payee) || matches.Count > 0,
                PossibleDuplicate: possibleDuplicates.Contains(index),
                TransferMatches: matches);
        }).ToList();

        return new ImportPreviewResult(
            TotalEntries: statement.Entries.Count,
            NewCount: items.Count,
            SkippedDuplicates: skipped,
            Credits: items.Count(i => i.IsCredit),
            Debits: items.Count(i => !i.IsCredit),
            Items: items,
            Layout: layout,
            DetectedFormat: detectedFormat.ToString());
    }

    /// <summary>
    /// Indexes (into <paramref name="fresh"/>) of candidates that look like a transaction the user
    /// already has: same amount, compatible direction, booked within
    /// <see cref="PossibleDuplicateWindowDays"/> days, and a matching payee (equal after
    /// normalization, or one containing the other — a raw bank blob contains the clean merchant).
    /// A hint only: the UI unticks these by default and lets the user decide.
    /// </summary>
    private async Task<HashSet<int>> FindPossibleDuplicatesAsync(
        string userId, IReadOnlyList<ParsedStatementEntry> fresh, CancellationToken cancellationToken)
    {
        var flagged = new HashSet<int>();
        if (fresh.Count == 0)
        {
            return flagged;
        }

        var from = fresh.Min(e => e.BookingDate).AddDays(-PossibleDuplicateWindowDays);
        var to = fresh.Max(e => e.BookingDate).AddDays(PossibleDuplicateWindowDays);
        var nearby = await _db.Transactions
            .Where(t => t.OwnerId == userId && t.Date >= from && t.Date <= to)
            .Select(t => new { t.Date, t.Amount, t.Type, t.Payee, t.Currency })
            .ToListAsync(cancellationToken);
        if (nearby.Count == 0)
        {
            return flagged;
        }

        var byAmount = nearby
            .GroupBy(t => t.Amount)
            .ToDictionary(g => g.Key, g => g.ToList());

        for (var i = 0; i < fresh.Count; i++)
        {
            var e = fresh[i];
            var candidateKey = AutoCategorizer.NormalizeKey(e.Payee);
            if (candidateKey.Length == 0 || !byAmount.TryGetValue(e.Amount, out var sameAmount))
            {
                continue;
            }

            var isDuplicate = sameAmount.Any(t =>
                Math.Abs(t.Date.DayNumber - e.BookingDate.DayNumber) <= PossibleDuplicateWindowDays
                && DirectionMatches(t.Type, e.IsCredit)
                && string.Equals(t.Currency.Value, e.Currency, StringComparison.OrdinalIgnoreCase)
                && PayeesMatch(candidateKey, AutoCategorizer.NormalizeKey(t.Payee)));
            if (isDuplicate)
            {
                flagged.Add(i);
            }
        }

        return flagged;
    }

    /// <summary>A credit could already exist as Income, a debit as Expense; a Transfer books either way.</summary>
    private static bool DirectionMatches(TransactionType existing, bool isCredit) => existing switch
    {
        TransactionType.Transfer => true,
        TransactionType.Income => isCredit,
        _ => !isCredit,
    };

    private static bool PayeesMatch(string a, string b) =>
        a.Length > 0 && b.Length > 0
        && (a.Contains(b, StringComparison.Ordinal) || b.Contains(a, StringComparison.Ordinal));
}
