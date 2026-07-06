using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Commands.CreateJar;

public class CreateJarCommandHandler
    : IRequestHandler<CreateJarCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public CreateJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(
        CreateJarCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var fund = new Jar
        {
            OwnerId = userId,
            Name = request.Name.Trim(),
            Kind = request.Kind,
            TargetAmount = request.TargetAmount,
            TargetDate = request.TargetDate,
            CoverStart = request.CoverStart,
            CoverEnd = request.CoverEnd,
            Accrual = request.Accrual,
            // A jar's type IS its renewal bit: Recurring renews, Goal is one-and-done.
            RecurAnnually = request.Kind == JarKind.Recurring,
            OpeningBalance = request.OpeningBalance,
            OpeningAsOf = request.OpeningAsOf,
            FundingAccountId = request.FundingAccountId,
        };

        _db.Jars.Add(fund);

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var required = JarAccrualCalculator.RequiredMonthlyContribution(fund, asOf, fund.OpeningBalance);

        // Land the jar's contribution line in every already-created month from the
        // current one forward, so it starts filling without a manual Budget-page step
        // (months created later get their line from month creation). Past months are
        // history and stay untouched.
        var months = await _db.BudgetMonths
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == userId
                        && (m.Year > asOf.Year || (m.Year == asOf.Year && m.Month >= asOf.Month)))
            .ToListAsync(cancellationToken);
        foreach (var month in months)
        {
            AddContributionLine(month, fund, required);
        }

        await _db.SaveChangesAsync(cancellationToken);

        // A brand-new fund's only contributions are the lines just written (one per
        // month, each planning `required`); report the balance they produce so the
        // card matches what the budget now says.
        var balance = fund.OpeningBalance + required * months.Count;
        return fund.ToDto(balance, required, asOf);
    }

    /// <summary>
    /// Appends the jar's line to the month's first Savings group (creating the group
    /// when the month has none). Mirrors CreateBudgetMonth's EnsureJarLines. New rows
    /// go through the DbSets with explicit FKs — attaching via a tracked month's
    /// navigation collections would mark the client-keyed entities Modified, not Added.
    /// </summary>
    private void AddContributionLine(BudgetMonth month, Jar fund, decimal planned)
    {
        var savings = month.Categories
            .Where(c => c.Kind == CategoryKind.Savings)
            .OrderBy(c => c.DisplayOrder)
            .FirstOrDefault();
        var nextOrder = savings is null || savings.Items.Count == 0
            ? 0
            : savings.Items.Max(i => i.DisplayOrder) + 1;

        Guid categoryId;
        if (savings is null)
        {
            var group = new BudgetCategory
            {
                BudgetMonthId = month.Id,
                Name = "Savings",
                Kind = CategoryKind.Savings,
                // Display order is contiguous per kind, and this is the first Savings group.
                DisplayOrder = 0,
            };
            _db.BudgetCategories.Add(group);
            categoryId = group.Id;
        }
        else
        {
            categoryId = savings.Id;
        }

        _db.BudgetItems.Add(new BudgetItem
        {
            BudgetCategoryId = categoryId,
            Name = fund.Name,
            PlannedAmount = planned,
            DisplayOrder = nextOrder,
            SavingsId = fund.Id,
        });
    }
}
