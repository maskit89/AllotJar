using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Budgets.Templates;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Budgets.Commands.CreateBudgetMonth;

public class CreateBudgetMonthCommandHandler : IRequestHandler<CreateBudgetMonthCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    // identity stays optional (DI supplies it in production) so the many handler tests that
    // don't care about currency keep constructing the handler with two arguments — without it
    // a first month falls back to the EUR default, exactly the pre-existing test behaviour.
    public CreateBudgetMonthCommandHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<BudgetMonthDto> Handle(CreateBudgetMonthCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var alreadyExists = await _db.BudgetMonths
            .AnyAsync(m => m.OwnerId == userId && m.Year == request.Year && m.Month == request.Month,
                cancellationToken);
        if (alreadyExists)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.Month)] = new[] { $"A budget for {request.Year:D4}-{request.Month:D2} already exists." },
            });
        }

        // The most recent month strictly before the requested one — the copy source
        // and the currency to inherit.
        var previous = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == userId
                        && (m.Year < request.Year || (m.Year == request.Year && m.Month < request.Month)))
            .OrderByDescending(m => m.Year)
                .ThenByDescending(m => m.Month)
            .FirstOrDefaultAsync(cancellationToken);

        // Every active jar takes part in month creation: funds with a configured target
        // get this month's required contribution seeded from the accrual calculator
        // (ProportionalPool funds wait for the pool — allocation engine, a later slice —
        // and copy flat); and any jar without a line in the new month gets one appended,
        // so a jar created on the Jars page starts filling without a manual budget step.
        // Recurrence is applied virtually per seed month by the calculator — the stored
        // date is an anchor and never rewritten here, so seeding a month is deterministic
        // regardless of creation order.
        var allJars = await _db.Jars
            .AsNoTracking()
            .Where(f => f.OwnerId == userId)
            .ToListAsync(cancellationToken);
        var activeJars = allJars.Where(f => !f.IsArchived).ToDictionary(f => f.Id);
        // A copy drops lines backed by an archived jar (below). Key that on the archived
        // ids specifically: a line whose SavingsId has no jar row (dangling) is still
        // copied — production enforces the FK, so "absent" only happens in tests and must
        // not be treated as "archived".
        var archivedJarIds = allJars.Where(f => f.IsArchived).Select(f => f.Id).ToHashSet();

        // Income attribution rolls forward, but not to archived people — their lines copy
        // as whole-household (null) rather than crediting someone who left.
        var archivedMemberIds = (await _db.HouseholdMembers
                .AsNoTracking()
                .Where(m => m.OwnerId == userId && m.IsArchived)
                .Select(m => m.Id)
                .ToListAsync(cancellationToken))
            .ToHashSet();

        // One eligibility rule for accrual seeding, shared by the copy path and the
        // appended-lines step below.
        static bool IsSeedable(Jar f) => f.TargetAmount > 0m && f.Accrual != AccrualMethod.ProportionalPool;
        bool NeedsSeed(BudgetItem i) =>
            i.SavingsId is { } fid && activeJars.TryGetValue(fid, out var f) && IsSeedable(f);

        // Cross-history balances are only needed when a fund line is actually being
        // seeded or appended — computed at most once, on first use.
        // Balances as-of this month: only contributions/spend in months strictly before
        // the one being created count, so back-filling an earlier month (via ‹) doesn't
        // let a later month's savings leak into the seed and zero out the contribution.
        Dictionary<Guid, decimal>? tracked = null;
        async Task<Dictionary<Guid, decimal>> BalancesAsync() =>
            tracked ??= await JarBalances.ComputeAsync(_db, userId, cancellationToken, (request.Year, request.Month));

        var seedAsOf = new DateOnly(request.Year, request.Month, 1);

        // A later month inherits its predecessor's base. The FIRST month adopts the creating
        // login's preferred currency instead of assuming EUR: the account form defaults to that
        // same preference, so a hardcoded EUR base would make every account-attached transaction
        // fail the account-currency invariant for a non-EUR household.
        var baseCurrency = previous?.BaseCurrency
            ?? (_identity is not null && _currentUser.UserId is string loginId
                ? await _identity.GetPreferredCurrencyAsync(loginId)
                : null)
            ?? CurrencyCode.Eur;

        var budget = new BudgetMonth
        {
            OwnerId = userId,
            Year = request.Year,
            Month = request.Month,
            BaseCurrency = baseCurrency,
        };

        var template = BudgetTemplates.Find(request.TemplateKey);
        if (!string.IsNullOrWhiteSpace(request.TemplateKey) && template is null)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.TemplateKey)] = new[] { $"Unknown budget template '{request.TemplateKey}'." },
            });
        }

        if (template is not null)
        {
            // Start from a quick-start template: groups + named lines, each at 0 planned.
            var orderByKind = new Dictionary<CategoryKind, int>();
            foreach (var g in template.Groups)
            {
                var order = orderByKind.TryGetValue(g.Kind, out var n) ? n : 0;
                orderByKind[g.Kind] = order + 1;
                var category = new BudgetCategory { Name = g.Name, Kind = g.Kind, DisplayOrder = order };
                var li = 0;
                foreach (var line in g.Lines)
                {
                    category.Items.Add(new BudgetItem
                    {
                        Name = line,
                        PlannedAmount = 0m,
                        DisplayOrder = li++,
                        // A template savings line is backed by a real jar — SavingsId is
                        // an enforced FK to Jars.Id, and the jar is what makes the
                        // line's balance roll over.
                        SavingsId = g.Kind == CategoryKind.Savings
                            ? SavingsLines.AddBackingJar(_db, userId, line).Id
                            : null,
                    });
                }
                budget.Categories.Add(category);
            }
        }
        else if (request.CopyFromPrevious && previous is not null)
        {
            // Balances are needed to re-seed the copied fund lines at this month's
            // required amount; skip the cross-history scan when none qualifies.
            var balances = previous.Categories.SelectMany(c => c.Items).Any(NeedsSeed)
                ? await BalancesAsync()
                : new Dictionary<Guid, decimal>();

            // Copy the structure and planned amounts; actuals start fresh.
            budget.Categories = previous.Categories
                .OrderBy(c => c.DisplayOrder)
                .Select(c => new BudgetCategory
                {
                    Name = c.Name,
                    Kind = c.Kind,
                    DisplayOrder = c.DisplayOrder,
                    // Carry the allocation-exclusion flag; dropping it silently folds an
                    // excluded category (e.g. Personal Savings) back into the shared
                    // obligation total and corrupts every copied month's member split.
                    ExcludeFromAllocation = c.ExcludeFromAllocation,
                    Items = c.Items
                        // Don't roll a line that funds an archived jar forward — archiving
                        // must stop future contributions. (Non-savings lines have no
                        // SavingsId and stay; a dangling SavingsId also stays.)
                        .Where(i => i.SavingsId is not { } sid || !archivedJarIds.Contains(sid))
                        .OrderBy(i => i.DisplayOrder)
                        .Select(i => new BudgetItem
                        {
                            Name = i.Name,
                            // Fund lines with a configured target are seeded at the
                            // calculated required contribution; everything else copies.
                            PlannedAmount = NeedsSeed(i)
                                ? JarAccrualCalculator.RequiredMonthlyContribution(
                                    activeJars[i.SavingsId!.Value], seedAsOf,
                                    activeJars[i.SavingsId!.Value].OpeningBalance
                                        + balances.GetValueOrDefault(i.SavingsId!.Value))
                                : i.PlannedAmount,
                            DisplayOrder = i.DisplayOrder,
                            // Keep the fund's identity so its balance rolls over.
                            SavingsId = i.SavingsId,
                            // Bills recur, so the due day carries; paid resets (new month).
                            DueDay = i.DueDay,
                            // Who earns an income line carries too — losing it here would
                            // silently revert the engine to static incomes every rollover.
                            MemberId = i.MemberId is { } mid && archivedMemberIds.Contains(mid)
                                ? null
                                : i.MemberId,
                        })
                        .ToList(),
                })
                .ToList();
        }
        else
        {
            // A blank budget still keeps the Income group at the top.
            budget.Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
            };
        }

        // Any active jar the new month doesn't already carry gets its line appended
        // (copied months carry last month's lines; template/blank months carry none),
        // so what the Jars page promises — "we work out what to set aside each month" —
        // actually lands in the budget.
        var represented = budget.Categories
            .SelectMany(c => c.Items)
            .Where(i => i.SavingsId is not null)
            .Select(i => i.SavingsId!.Value)
            .ToHashSet();
        var missing = activeJars.Values
            .Where(f => !represented.Contains(f.Id))
            .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (missing.Count > 0)
        {
            var balances = await BalancesAsync();
            foreach (var jar in missing)
            {
                SavingsLines.AppendJarLine(_db, budget, jar,
                    JarAccrualCalculator.RequiredMonthlyContribution(
                        jar, seedAsOf, jar.OpeningBalance + balances.GetValueOrDefault(jar.Id)));
            }
        }

        _db.BudgetMonths.Add(budget);
        try
        {
            await _db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            // A concurrent request (double-click, StrictMode double-fire, two logins in
            // the same household) can insert this month between the AnyAsync pre-check
            // and here, tripping the unique (OwnerId, Year, Month) index. Surface the
            // same friendly 400 as the pre-check instead of a raw 500.
            var raced = await _db.BudgetMonths.AnyAsync(
                m => m.OwnerId == userId && m.Year == request.Year && m.Month == request.Month,
                cancellationToken);
            if (raced)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    [nameof(request.Month)] = new[] { $"A budget for {request.Year:D4}-{request.Month:D2} already exists." },
                });
            }
            throw;
        }

        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == budget.Id, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
