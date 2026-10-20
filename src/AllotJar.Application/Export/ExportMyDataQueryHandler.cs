using System.Text.Json;
using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Allocation.Queries.GetAllocationProfile;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonths;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Application.HouseholdAccess.Queries.GetMemberships;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Transactions.Queries.GetTransactions;

namespace AllotJar.Application.Export;

/// <summary>
/// Gathers the export from the same reads the screens make, so what a login downloads is what it
/// can see: another login's private account, its balance and the money only it moves are not there
/// (the context's query filters), and an entry on a budget line from such an account names it
/// "Private account" without its id (P56). The few stored details no read returns (notes, the raw
/// bank text, jar cycles and movements) are read here under the same filters, and a transaction's
/// notes and bank text are withheld whenever its money touches an account the viewer can't see.
/// Nothing is written beyond what opening the Jars page does (a cycle whose deadline has passed is
/// settled, rule 20), so no figure changes.
/// </summary>
public class ExportMyDataQueryHandler : IRequestHandler<ExportMyDataQuery, DataExport>
{
    private static readonly JsonSerializerOptions CopyOptions = new();

    private readonly ISender _mediator;
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ExportMyDataQueryHandler(ISender mediator, IApplicationDbContext db, ICurrentUser currentUser)
    {
        _mediator = mediator;
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<DataExport> Handle(ExportMyDataQuery request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var accounts = await _mediator.Send(new GetAccountsQuery(request.AsOf), cancellationToken);
        var people = await _mediator.Send(new GetHouseholdMembersQuery(IncludeArchived: true), cancellationToken);
        var access = await _mediator.Send(new GetMembershipsQuery(), cancellationToken);
        var jars = await _mediator.Send(new GetJarsQuery(IncludeArchived: true, AsOf: request.AsOf), cancellationToken);
        var transactions = await _mediator.Send(new GetTransactionsQuery(), cancellationToken);
        var allocation = await _mediator.Send(new GetAllocationProfileQuery(), cancellationToken);

        var budgets = new List<BudgetMonthDto>();
        foreach (var month in (await _mediator.Send(new GetBudgetMonthsQuery(), cancellationToken))
                     .OrderBy(m => m.Year).ThenBy(m => m.Month))
        {
            budgets.Add(await _mediator.Send(new GetBudgetMonthQuery(month.Year, month.Month), cancellationToken));
        }

        // Notes and the bank's text for each row: only where every account the money moves in is
        // one the viewer sees (the read model's own test for "Private account").
        var details = await _db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == ownerId && (t.Notes != null || t.BankEntry != null))
            .Select(t => new { t.Id, t.Notes, t.BankEntry })
            .ToDictionaryAsync(t => t.Id, cancellationToken);
        var exportedTransactions = transactions
            .Select(t =>
            {
                var row = Copy<ExportedTransaction>(t);
                if (!t.InPrivateAccount && details.TryGetValue(t.Id, out var d))
                {
                    row.Notes = d.Notes;
                    row.BankEntry = d.BankEntry;
                }
                return row;
            })
            .ToList();

        var jarNames = jars.ToDictionary(j => j.Id, j => j.Name);
        var visibleTransactions = transactions.Select(t => t.Id).ToHashSet();
        var cycles = (await _db.JarCycles
                .AsNoTracking()
                .Include(c => c.PaymentTransaction)
                .Where(c => c.OwnerId == ownerId)
                .OrderBy(c => c.Deadline)
                .ToListAsync(cancellationToken))
            .Where(c => jarNames.ContainsKey(c.JarId))
            .Select(c =>
            {
                var row = Copy<ExportedJarCycle>(c.ToDto());
                row.JarId = c.JarId;
                row.JarName = jarNames[c.JarId];
                // A payment the viewer can't see is neither named nor pointed at.
                if (row.PaymentTransactionId is Guid paid && !visibleTransactions.Contains(paid))
                {
                    row.PaymentTransactionId = null;
                    row.PaymentPayee = null;
                }
                return row;
            })
            .ToList();

        var accountNames = accounts.ToDictionary(a => a.Id, a => a.Name);
        var movements = (await _db.JarAllocations
                .AsNoTracking()
                .Include(a => a.Postings)
                .Where(a => a.OwnerId == ownerId)
                .OrderBy(a => a.Date).ThenBy(a => a.CreatedUtc)
                .ToListAsync(cancellationToken))
            .Where(a => accountNames.ContainsKey(a.AccountId))
            .SelectMany(a => a.Postings.Select(p => new ExportedJarMovement
            {
                Id = p.Id,
                Date = a.Date,
                Kind = a.Kind.ToString(),
                AccountId = a.AccountId,
                AccountName = accountNames[a.AccountId],
                JarId = p.JarId,
                JarName = p.JarId is Guid jarId && jarNames.TryGetValue(jarId, out var name) ? name : null,
                Amount = p.Amount,
                TransactionId = a.TransactionId is Guid tx && visibleTransactions.Contains(tx) ? tx : null,
                Note = a.Note,
            }))
            .ToList();

        return new DataExport
        {
            ExportedUtc = DateTime.UtcNow,
            Profile = request.Profile,
            Accounts = accounts,
            People = people,
            HouseholdAccess = access,
            Transactions = exportedTransactions,
            Budgets = budgets,
            Jars = jars,
            JarCycles = cycles,
            JarMovements = movements,
            AllocationProfile = allocation,
        };
    }

    /// <summary>The read model's row as the export's wider one, every field carried over.</summary>
    private static T Copy<T>(object source) =>
        (T)JsonSerializer.Deserialize(JsonSerializer.Serialize(source, source.GetType(), CopyOptions), typeof(T), CopyOptions)!;
}
