using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Transactions;

namespace AllotJar.Application.Imports.Commands.PreviewImport;

public class PreviewImportCommandHandler : IRequestHandler<PreviewImportCommand, ImportPreviewResult>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IReadOnlyCollection<IStatementParser> _parsers;

    public PreviewImportCommandHandler(
        IApplicationDbContext db,
        ICurrentUser currentUser,
        IEnumerable<IStatementParser> parsers)
    {
        _db = db;
        _currentUser = currentUser;
        _parsers = parsers.ToList();
    }

    public async Task<ImportPreviewResult> Handle(PreviewImportCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var parser = _parsers.FirstOrDefault(p => p.Format == request.Format)
            ?? throw new NotFoundException($"No statement parser is registered for format '{request.Format}'.");
        var statement = parser.Parse(request.Content);

        // Drop rows we've already imported (idempotency mirrors the commit step).
        var existing = await _db.Transactions
            .Where(t => t.OwnerId == userId && t.BankReference != null)
            .Select(t => t.BankReference!)
            .ToListAsync(cancellationToken);
        var already = new HashSet<string>(existing, StringComparer.Ordinal);

        var fresh = statement.Entries
            .Where(e => e.Reference is null || !already.Contains(e.Reference))
            .ToList();
        var skipped = statement.Entries.Count - fresh.Count;

        // Suggest a budget line per row from the user's past categorisations (no writes).
        var suggestions = await AutoCategorizer.BuildSuggestionsAsync(
            _db, userId, new HashSet<Guid>(), cancellationToken);

        var suggestedIds = suggestions.Values.ToHashSet();
        var nameById = suggestedIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await _db.BudgetItems
                .Where(i => suggestedIds.Contains(i.Id))
                .Select(i => new { i.Id, i.Name })
                .ToDictionaryAsync(x => x.Id, x => x.Name, cancellationToken);

        var items = fresh.Select(e =>
        {
            Guid? suggestedId = suggestions.TryGetValue(AutoCategorizer.NormalizeKey(e.Payee), out var id)
                ? id
                : null;
            var suggestedName = suggestedId is Guid sid && nameById.TryGetValue(sid, out var n) ? n : null;
            return new ImportCandidate(
                Reference: e.Reference ?? string.Empty,
                Date: e.BookingDate,
                Payee: e.Payee,
                Amount: e.Amount,
                Currency: e.Currency,
                IsCredit: e.IsCredit,
                SuggestedBudgetItemId: suggestedId,
                SuggestedBudgetItemName: suggestedName,
                LikelyTransfer: TransferHeuristic.IsLikelyTransfer(e.Payee));
        }).ToList();

        return new ImportPreviewResult(
            TotalEntries: statement.Entries.Count,
            NewCount: items.Count,
            SkippedDuplicates: skipped,
            Credits: items.Count(i => i.IsCredit),
            Debits: items.Count(i => !i.IsCredit),
            Items: items);
    }
}
