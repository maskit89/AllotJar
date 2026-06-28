using MediatR;
using ZeroBudget.Application.Common.Exceptions;
using ZeroBudget.Application.Common.Interfaces;
using ZeroBudget.Application.Jars.Dtos;
using ZeroBudget.Domain.Entities;
using ZeroBudget.Domain.Services;

namespace ZeroBudget.Application.Jars.Commands.CreateJar;

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
            RecurAnnually = request.RecurAnnually,
            OpeningBalance = request.OpeningBalance,
            OpeningAsOf = request.OpeningAsOf,
            FundingAccountId = request.FundingAccountId,
        };

        _db.Jars.Add(fund);
        await _db.SaveChangesAsync(cancellationToken);

        // A brand-new fund has no contribution lines yet, so its balance is its opening.
        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var balance = fund.OpeningBalance;
        var required = JarAccrualCalculator.RequiredMonthlyContribution(fund, asOf, balance);
        return fund.ToDto(balance, required, asOf);
    }
}
