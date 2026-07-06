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

    public CreateBudgetMonthCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
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
        var activeJars = (await _db.Jars
            .AsNoTracking()
            .Where(f => f.OwnerId == userId && !f.IsArchived)
            .ToListAsync(cancellationToken))
            .ToDictionary(f => f.Id);

        var seededFunds = activeJars.Values
            .Where(f => f.TargetAmount > 0m && f.Accrual != AccrualMethod.ProportionalPool)
            .ToDictionary(f => f.Id);

        var fundTrackedBalances = activeJars.Count > 0
            ? await JarBalances.ComputeAsync(_db, userId, cancellationToken)
            : new Dictionary<Guid, decimal>();

        var seedAsOf = new DateOnly(request.Year, request.Month, 1);

        var budget = new BudgetMonth
        {
            OwnerId = userId,
            Year = request.Year,
            Month = request.Month,
            BaseCurrency = previous?.BaseCurrency ?? CurrencyCode.Eur,
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
            budget.Categories = template.Groups
                .Select(g =>
                {
                    var order = orderByKind.TryGetValue(g.Kind, out var n) ? n : 0;
                    orderByKind[g.Kind] = order + 1;
                    return new BudgetCategory
                    {
                        Name = g.Name,
                        Kind = g.Kind,
                        DisplayOrder = order,
                        Items = g.Lines
                            .Select((line, li) => new BudgetItem
                            {
                                Name = line,
                                PlannedAmount = 0m,
                                DisplayOrder = li,
                                // A template savings line is backed by a real jar —
                                // SavingsId is an enforced FK to Jars.Id, and the jar
                                // is what makes the line's balance roll over.
                                SavingsId = g.Kind == CategoryKind.Savings
                                    ? CreateJarFor(line, userId)
                                    : null,
                            })
                            .ToList(),
                    };
                })
                .ToList();
        }
        else if (request.CopyFromPrevious && previous is not null)
        {
            // Copy the structure and planned amounts; actuals start fresh.
            budget.Categories = previous.Categories
                .OrderBy(c => c.DisplayOrder)
                .Select(c => new BudgetCategory
                {
                    Name = c.Name,
                    Kind = c.Kind,
                    DisplayOrder = c.DisplayOrder,
                    Items = c.Items
                        .OrderBy(i => i.DisplayOrder)
                        .Select(i => new BudgetItem
                        {
                            Name = i.Name,
                            // Fund lines with a configured target are seeded at the
                            // calculated required contribution; everything else copies.
                            PlannedAmount = i.SavingsId is { } fid && seededFunds.TryGetValue(fid, out var fund)
                                ? JarAccrualCalculator.RequiredMonthlyContribution(
                                    fund, seedAsOf, fund.OpeningBalance + fundTrackedBalances.GetValueOrDefault(fid))
                                : i.PlannedAmount,
                            DisplayOrder = i.DisplayOrder,
                            // Keep the fund's identity so its balance rolls over.
                            SavingsId = i.SavingsId,
                            // Bills recur, so the due day carries; paid resets (new month).
                            DueDay = i.DueDay,
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

        EnsureJarLines(budget, activeJars.Values, fundTrackedBalances, seedAsOf);

        _db.BudgetMonths.Add(budget);
        await _db.SaveChangesAsync(cancellationToken);

        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == budget.Id, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }

    /// <summary>A new jar backing a template savings line; returns its id for the line's FK.</summary>
    private Guid CreateJarFor(string lineName, string userId)
    {
        var jar = Jar.ForSavingsLine(userId, lineName);
        _db.Jars.Add(jar);
        return jar.Id;
    }

    /// <summary>
    /// Appends a contribution line for every active jar the new month doesn't already
    /// carry (copied months carry last month's lines; template/blank months carry none),
    /// so what the Jars page promises — "we work out what to set aside each month" —
    /// actually lands in the budget. Lines join the first Savings group, which is
    /// created when the month has none.
    /// </summary>
    private static void EnsureJarLines(
        BudgetMonth budget,
        IEnumerable<Jar> activeJars,
        IReadOnlyDictionary<Guid, decimal> trackedBalances,
        DateOnly seedAsOf)
    {
        var represented = budget.Categories
            .SelectMany(c => c.Items)
            .Where(i => i.SavingsId is not null)
            .Select(i => i.SavingsId!.Value)
            .ToHashSet();

        var missing = activeJars
            .Where(f => !represented.Contains(f.Id))
            .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (missing.Count == 0)
        {
            return;
        }

        var savings = budget.Categories
            .Where(c => c.Kind == CategoryKind.Savings)
            .OrderBy(c => c.DisplayOrder)
            .FirstOrDefault();
        if (savings is null)
        {
            savings = new BudgetCategory
            {
                Name = "Savings",
                Kind = CategoryKind.Savings,
                // Display order is contiguous per kind, and this is the first Savings group.
                DisplayOrder = 0,
            };
            budget.Categories.Add(savings);
        }

        var nextOrder = savings.Items.Count == 0 ? 0 : savings.Items.Max(i => i.DisplayOrder) + 1;
        foreach (var jar in missing)
        {
            savings.Items.Add(new BudgetItem
            {
                Name = jar.Name,
                PlannedAmount = JarAccrualCalculator.RequiredMonthlyContribution(
                    jar, seedAsOf, jar.OpeningBalance + trackedBalances.GetValueOrDefault(jar.Id)),
                DisplayOrder = nextOrder++,
                SavingsId = jar.Id,
            });
        }
    }
}
