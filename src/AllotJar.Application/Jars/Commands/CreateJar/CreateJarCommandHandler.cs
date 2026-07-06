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

        // Land the jar's contribution line in every already-created month from the
        // current one forward, so it starts filling without a manual Budget-page step
        // (months created later get their line from month creation). Past months are
        // history and stay untouched. Each month's planned amount is recomputed with
        // the earlier plantings folded in — the same figure month creation would have
        // seeded had the months been created after the jar. Only the Savings groups
        // are needed, read-only: all writes go through the DbSets in SavingsLines.
        var months = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories.Where(c => c.Kind == CategoryKind.Savings))
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == userId
                        && (m.Year > asOf.Year || (m.Year == asOf.Year && m.Month >= asOf.Month)))
            .OrderBy(m => m.Year).ThenBy(m => m.Month)
            .ToListAsync(cancellationToken);
        var planted = 0m;
        foreach (var month in months)
        {
            var monthPlanned = JarAccrualCalculator.RequiredMonthlyContribution(
                fund, new DateOnly(month.Year, month.Month, 1), fund.OpeningBalance + planted);
            SavingsLines.AppendJarLine(_db, month, fund, monthPlanned);
            planted += monthPlanned;
        }

        await _db.SaveChangesAsync(cancellationToken);

        // Report the same figures the Jars page will derive from the rows just
        // written, so the card doesn't change on the next load.
        var balance = fund.OpeningBalance + planted;
        var required = JarAccrualCalculator.RequiredMonthlyContribution(fund, asOf, balance);
        return fund.ToDto(balance, required, asOf);
    }
}
