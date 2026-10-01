using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;

public class SyncPocketMoneyLinesCommandHandler : IRequestHandler<SyncPocketMoneyLinesCommand, BudgetMonthDto>
{
    /// <summary>The name of the category the sync creates. A flagged Expense category that holds
    /// lines linked to a person is the pocket category whatever it has been renamed to (rule 53:
    /// the link, not a name, identifies a person's line; RP-P2-2); otherwise one of this name
    /// (case-insensitive) is adopted. Its lines are linked to their person by
    /// <see cref="BudgetItem.MemberId"/>.</summary>
    public const string CategoryName = "Pocket Money";

    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public SyncPocketMoneyLinesCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(SyncPocketMoneyLinesCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Same profile selection as AllocationPlanner (name order, first).
        var profile = await _db.AllocationProfiles
            .AsNoTracking()
            .Include(p => p.Rules)
            .Where(p => p.OwnerId == userId)
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(cancellationToken);
        if (profile is null)
        {
            throw new NotFoundException("No allocation profile is set up.");
        }

        // P = 0 is allowed: a re-sync after the user drops pocket money zeroes the lines
        // rather than leaving stale planned amounts behind.
        var perMember = profile.Rules
            .FirstOrDefault(r => r.Type == AllocationRuleType.FixedPerMember)
            ?.FixedAmountPerMember ?? 0m;

        var month = await _db.BudgetMonths
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstOrDefaultAsync(
                m => m.OwnerId == userId && m.Year == request.Year && m.Month == request.Month,
                cancellationToken);
        if (month is null)
        {
            throw new NotFoundException($"No budget exists for {request.Year}-{request.Month:00}.");
        }

        var members = await _db.HouseholdMembers
            .AsNoTracking()
            .Where(m => m.OwnerId == userId && !m.IsArchived)
            .OrderBy(m => m.DisplayOrder)
                .ThenBy(m => m.Name)
            .ToListAsync(cancellationToken);

        // Find the pocket category: prefer one the sync already owns — flagged and holding a
        // person's linked line, whatever the user renamed it to (RP-P2-2), or flagged under its
        // own name — else adopt an UNFLAGGED Expense category of the same name — flagging it
        // also heals the latent double-count where pocket money was both a budget envelope AND
        // the engine's FixedPerMember deduction — else create one at the end of the expense groups.
        var expenseLines = month.Categories
            .Where(c => c.Kind == CategoryKind.Expense)
            .SelectMany(c => c.Items)
            .ToList();
        var category =
            month.Categories.FirstOrDefault(c =>
                c.Kind == CategoryKind.Expense
                && c.ExcludeFromAllocation
                && c.Items.Any(i => i.MemberId is not null))
            ?? month.Categories.FirstOrDefault(c =>
                c.Kind == CategoryKind.Expense
                && c.ExcludeFromAllocation
                && string.Equals(c.Name, CategoryName, StringComparison.OrdinalIgnoreCase))
            ?? month.Categories.FirstOrDefault(c =>
                c.Kind == CategoryKind.Expense
                && string.Equals(c.Name, CategoryName, StringComparison.OrdinalIgnoreCase));

        // New rows go through the DbSet with scalar FKs (never a tracked parent's navigation):
        // BaseEntity self-initializes Id, so a nav-discovered child looks pre-existing to EF
        // and SaveChanges issues a doomed UPDATE — the repo-wide InMemory-safe add pattern.
        if (category is null)
        {
            category = new BudgetCategory
            {
                BudgetMonthId = month.Id,
                Name = CategoryName,
                Kind = CategoryKind.Expense,
                ExcludeFromAllocation = true,
                DisplayOrder = month.Categories
                    .Where(c => c.Kind == CategoryKind.Expense)
                    .Select(c => c.DisplayOrder)
                    .DefaultIfEmpty(-1)
                    .Max() + 1,
            };
            _db.BudgetCategories.Add(category);
        }
        else
        {
            category.ExcludeFromAllocation = true;
        }

        // One line per active member, identified by the person's id (rule 53): a line the sync
        // already linked is reused whatever it is called now and whichever Expense group it sits
        // in, so neither a renamed person nor a renamed group gets a second line (RP-P2-2). A line from before the link existed is adopted by name (case-insensitive)
        // and linked. Lines linked to an archived person are theirs to keep or cancel through the
        // archive (rule 54), and unlinked lines matching nobody are left untouched — visible
        // leftovers beat silent deletion.
        var nextOrder = category.Items.Select(i => i.DisplayOrder).DefaultIfEmpty(-1).Max() + 1;
        foreach (var member in members)
        {
            var line = expenseLines.FirstOrDefault(i => i.MemberId == member.Id)
                ?? category.Items.FirstOrDefault(i =>
                    i.MemberId is null
                    && string.Equals(i.Name, member.Name, StringComparison.OrdinalIgnoreCase));
            if (line is null)
            {
                _db.BudgetItems.Add(new BudgetItem
                {
                    BudgetCategoryId = category.Id,
                    Name = member.Name,
                    PlannedAmount = perMember,
                    MemberId = member.Id,
                    DisplayOrder = nextOrder++,
                });
            }
            else
            {
                line.MemberId = member.Id;
                line.PlannedAmount = perMember;
            }
        }

        await _db.SaveChangesAsync(cancellationToken);

        var reloaded = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == month.Id, cancellationToken);
        await BudgetActuals.ApplyAsync(_db, userId, reloaded, cancellationToken);

        return reloaded.ToDto();
    }
}
