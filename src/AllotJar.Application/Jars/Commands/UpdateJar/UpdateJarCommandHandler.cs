using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

public class UpdateJarCommandHandler
    : IRequestHandler<UpdateJarCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpdateJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(
        UpdateJarCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var fund = await _db.Jars
            .FirstOrDefaultAsync(f => f.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Sinking fund {request.Id} was not found.");

        if (fund.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        fund.Name = request.Name.Trim();
        fund.Kind = request.Kind;
        fund.TargetAmount = request.TargetAmount;
        fund.TargetDate = request.TargetDate;
        fund.CoverStart = request.CoverStart;
        fund.CoverEnd = request.CoverEnd;
        fund.Accrual = request.Accrual;
        // Recurring jars carry their cycle length (yearly unless told otherwise);
        // Goals are one-and-done and never roll.
        fund.RecurMonths = request.Kind == JarKind.Recurring ? request.RecurMonths ?? 12 : null;
        fund.OpeningBalance = request.OpeningBalance;
        fund.OpeningAsOf = request.OpeningAsOf;
        fund.FundingAccountId = request.FundingAccountId;

        await _db.SaveChangesAsync(cancellationToken);

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var tracked = await JarBalances.ComputeAsync(_db, userId, cancellationToken);
        var balance = fund.OpeningBalance + tracked.GetValueOrDefault(fund.Id);
        var required = JarAccrualCalculator.RequiredMonthlyContribution(fund, asOf, balance);
        return fund.ToDto(balance, required, asOf);
    }
}
