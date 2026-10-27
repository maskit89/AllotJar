using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Reports;

/// <summary>
/// The one place a month's report figures are derived (rules 37–39, 41), shared by the trends,
/// the annual overview and the month breakdown so they can never disagree. Line-derived figures
/// come from <see cref="BudgetActuals"/> (planned, actual net of assigned refunds); the
/// transaction-derived layer — uncategorised income and spending, refunds not on a line — is
/// read by the transaction's own date so nothing a report shows depends on the user having
/// categorised it yet. Rows still waiting for a budget-currency amount are left out and counted, exactly as the budget does.
/// </summary>
public static class ReportFigures
{
    public const string UncategorisedName = "Uncategorised";

    /// <param name="budget">The month's budget with categories and items loaded (no tracking), or null when the month has none.</param>
    public static async Task<MonthReportDto> ForMonthAsync(
        IApplicationDbContext db,
        string userId,
        int year,
        int month,
        BudgetMonth? budget,
        CancellationToken cancellationToken) =>
        (await ForMonthsAsync(db, userId, new[] { (year, month, budget) }, cancellationToken))[0];

    /// <summary>
    /// The figures of several months (a year, the trends' window), each exactly as
    /// <see cref="ForMonthAsync"/> gives it, read in a fixed number of queries instead of a few per
    /// month: the rows are read once for the span and shared out by their own date.
    /// </summary>
    public static async Task<List<MonthReportDto>> ForMonthsAsync(
        IApplicationDbContext db,
        string userId,
        IReadOnlyList<(int Year, int Month, BudgetMonth? Budget)> months,
        CancellationToken cancellationToken)
    {
        if (months.Count == 0)
        {
            return new List<MonthReportDto>();
        }

        // No report shows a jar line's balance, so the jar ledger is not read (RP-P3-3).
        var budgets = months.Where(m => m.Budget is not null).Select(m => m.Budget!).ToList();
        await BudgetActuals.ApplyAsync(db, userId, budgets, cancellationToken, savingsBalances: false);
        var unbudgeted = months.Where(m => m.Budget is null).Select(m => (m.Year, m.Month)).ToList();
        var waiting = await BudgetActuals.FxPendingCountsAsync(db, userId, unbudgeted, cancellationToken);

        var (spanStart, spanEnd) = BudgetActuals.Span(months.Select(m => (m.Year, m.Month)).ToList());

        // Whole rows of the months that no line carries (a split row's slices carry its
        // attribution, so it is not "loose" itself), by their own date.
        var loose = (await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == userId
                        && !t.FxPending
                        && t.Type != TransactionType.Transfer
                        // A transfer's shared side kept after its other account was erased is
                        // still a transfer to the household (P59 "Keep shared").
                        && !t.CounterpartyErased
                        && t.Date >= spanStart
                        && t.Date <= spanEnd
                        && t.BudgetItemId == null
                        && !t.Splits.Any()
                        // P56: a private account's money off the budget is nobody's household total.
                        && !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId))
            .Select(t => new LooseRow(t.Date, t.Type, t.RefundOfTransactionId != null, t.BudgetAmount ?? t.Amount))
            .ToListAsync(cancellationToken))
            .ToLookup(t => (t.Date.Year, t.Date.Month));

        // Slices whose line was removed (the FK sets them null) are uncategorised too.
        var looseSlices = (await (
            from s in db.TransactionSplits
            join t in db.Transactions on s.TransactionId equals t.Id
            where t.OwnerId == userId
                  && !t.FxPending
                  && t.Type != TransactionType.Transfer
                  && !t.CounterpartyErased
                  && s.BudgetItemId == null
                  && t.Date >= spanStart
                  && t.Date <= spanEnd
                  && !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId)
            select new LooseSlice(s.TransactionId, t.Date, t.Type, s.BudgetAmount ?? s.Amount))
            .ToListAsync(cancellationToken))
            .ToLookup(s => (s.Date.Year, s.Date.Month));

        return months
            .Select(m => Figures(m.Year, m.Month, m.Budget,
                m.Budget?.FxPendingCount ?? waiting.GetValueOrDefault((m.Year, m.Month)),
                loose[(m.Year, m.Month)].ToList(), looseSlices[(m.Year, m.Month)].ToList()))
            .ToList();
    }

    private sealed record LooseRow(DateOnly Date, TransactionType Type, bool IsRefund, decimal Base);

    private sealed record LooseSlice(Guid TransactionId, DateOnly Date, TransactionType Type, decimal Base);

    /// <param name="budget">The month's budget with its actuals applied, or null when the month has none.</param>
    private static MonthReportDto Figures(
        int year,
        int month,
        BudgetMonth? budget,
        int fxPendingCount,
        List<LooseRow> loose,
        List<LooseSlice> looseSlices)
    {
        var dto = new MonthReportDto
        {
            Year = year,
            Month = month,
            Key = $"{year:D4}-{month:D2}",
            HasBudget = budget is not null,
            BaseCurrency = budget?.BaseCurrency.Value,
            FxPendingCount = fxPendingCount,
        };

        var incomeOnLines = 0m;
        if (budget is not null)
        {
            dto.IncomeBudgeted = budget.TotalIncome;
            dto.Planned = budget.TotalPlanned;
            incomeOnLines = budget.Categories
                .Where(c => c.Kind == CategoryKind.Income)
                .Sum(c => c.TotalActual);

            var index = 0;
            foreach (var category in budget.Categories.Where(c => c.Kind != CategoryKind.Income).OrderBy(c => c.DisplayOrder))
            {
                var refunds = category.Items.Sum(i => i.RefundedAmount);
                var net = category.TotalActual;
                dto.Categories.Add(new MonthReportCategoryDto
                {
                    Id = category.Id,
                    Name = category.Name,
                    Kind = category.Kind.ToString(),
                    Index = index++,
                    Spent = net + refunds,
                    Refunds = refunds,
                    Net = net,
                });
            }
        }

        var incomeLoose = loose.Where(t => t.Type == TransactionType.Income && !t.IsRefund).Sum(t => t.Base)
                          + looseSlices.Where(s => s.Type == TransactionType.Income).Sum(s => s.Base);
        var expenseLoose = loose.Where(t => t.Type == TransactionType.Expense).Sum(t => t.Base)
                           + looseSlices.Where(s => s.Type == TransactionType.Expense).Sum(s => s.Base);
        var refundsLoose = loose.Where(t => t.IsRefund).Sum(t => t.Base);
        // "Review N transactions" counts every transaction the row's money comes from: a split whose
        // slice is on no line is one more to review, however many of its slices are loose.
        var uncategorisedCount = loose.Count(t => t.Type == TransactionType.Expense || t.IsRefund)
                                 + looseSlices.Where(s => s.Type == TransactionType.Expense).Select(s => s.TransactionId).Distinct().Count();

        dto.IncomeUncategorised = incomeLoose;
        dto.IncomeReceived = incomeOnLines + incomeLoose;
        dto.Variance = dto.IncomeReceived - dto.IncomeBudgeted;
        dto.SpentCategorised = dto.Categories.Sum(c => c.Net);
        dto.SpentUncategorised = expenseLoose - refundsLoose;
        dto.Refunds = dto.Categories.Sum(c => c.Refunds) + refundsLoose;
        dto.Spent = dto.SpentCategorised + dto.SpentUncategorised;
        dto.UncategorisedCount = uncategorisedCount;
        dto.UncategorisedIncomeCount = loose.Count(t => t.Type == TransactionType.Income && !t.IsRefund)
                                       + looseSlices.Where(s => s.Type == TransactionType.Income).Select(s => s.TransactionId).Distinct().Count();

        if (expenseLoose != 0m || refundsLoose != 0m)
        {
            dto.Categories.Add(new MonthReportCategoryDto
            {
                Id = null,
                Name = UncategorisedName,
                Kind = UncategorisedName,
                Index = -1,
                Spent = expenseLoose,
                Refunds = refundsLoose,
                Net = expenseLoose - refundsLoose,
                IsUncategorised = true,
                Count = uncategorisedCount,
            });
        }

        return dto;
    }
}
