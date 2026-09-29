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
        CancellationToken cancellationToken)
    {
        var dto = new MonthReportDto
        {
            Year = year,
            Month = month,
            Key = $"{year:D4}-{month:D2}",
            HasBudget = budget is not null,
            BaseCurrency = budget?.BaseCurrency.Value,
        };

        var incomeOnLines = 0m;
        if (budget is not null)
        {
            await BudgetActuals.ApplyAsync(db, userId, budget, cancellationToken);
            dto.IncomeBudgeted = budget.TotalIncome;
            dto.Planned = budget.TotalPlanned;
            dto.FxPendingCount = budget.FxPendingCount;
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
        else
        {
            dto.FxPendingCount = await db.Transactions
                .Where(HouseholdMoney.Counts(db))
                .CountAsync(t => t.OwnerId == userId && t.FxPending && t.Date.Year == year && t.Date.Month == month,
                    cancellationToken);
        }

        // Whole rows of the month that no line carries (a split row's slices carry its
        // attribution, so it is not "loose" itself), by their own date.
        var loose = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == userId
                        && !t.FxPending
                        && t.Type != TransactionType.Transfer
                        && t.Date.Year == year
                        && t.Date.Month == month
                        && t.BudgetItemId == null
                        && !t.Splits.Any()
                        // P56: a private account's money off the budget is nobody's household total.
                        && !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId))
            .Select(t => new { t.Type, IsRefund = t.RefundOfTransactionId != null, Base = t.BudgetAmount ?? t.Amount })
            .ToListAsync(cancellationToken);

        // Slices whose line was removed (the FK sets them null) are uncategorised too.
        var looseSlices = await (
            from s in db.TransactionSplits
            join t in db.Transactions on s.TransactionId equals t.Id
            where t.OwnerId == userId
                  && !t.FxPending
                  && t.Type != TransactionType.Transfer
                  && s.BudgetItemId == null
                  && t.Date.Year == year
                  && t.Date.Month == month
                  && !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId)
            select new { t.Type, Base = s.BudgetAmount ?? s.Amount })
            .ToListAsync(cancellationToken);

        var incomeLoose = loose.Where(t => t.Type == TransactionType.Income && !t.IsRefund).Sum(t => t.Base)
                          + looseSlices.Where(s => s.Type == TransactionType.Income).Sum(s => s.Base);
        var expenseLoose = loose.Where(t => t.Type == TransactionType.Expense).Sum(t => t.Base)
                           + looseSlices.Where(s => s.Type == TransactionType.Expense).Sum(s => s.Base);
        var refundsLoose = loose.Where(t => t.IsRefund).Sum(t => t.Base);
        var uncategorisedCount = loose.Count(t => t.Type == TransactionType.Expense || t.IsRefund);

        dto.IncomeUncategorised = incomeLoose;
        dto.IncomeReceived = incomeOnLines + incomeLoose;
        dto.Variance = dto.IncomeReceived - dto.IncomeBudgeted;
        dto.SpentCategorised = dto.Categories.Sum(c => c.Net);
        dto.SpentUncategorised = expenseLoose - refundsLoose;
        dto.Refunds = dto.Categories.Sum(c => c.Refunds) + refundsLoose;
        dto.Spent = dto.SpentCategorised + dto.SpentUncategorised;
        dto.UncategorisedCount = uncategorisedCount;
        dto.UncategorisedIncomeCount = loose.Count(t => t.Type == TransactionType.Income && !t.IsRefund);

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
