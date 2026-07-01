using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Allocation.Commands.AllocateIncome;

public class AllocateIncomeCommandHandler : IRequestHandler<AllocateIncomeCommand, AllocationResultDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public AllocateIncomeCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<AllocationResultDto> Handle(AllocateIncomeCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var plan = await AllocationPlanner.PlanAsync(
            _db, userId, request.Year, request.Month, request.ProfileId, cancellationToken);

        var profile = plan.Profile
            ?? throw new NotFoundException("There is no allocation profile to run.");

        if (profile.SourceAccountId is not Guid sourceId)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["SourceAccountId"] = new[] { "Set a source account on the allocation profile before committing." },
            });
        }

        var source = await _db.Accounts.FirstOrDefaultAsync(a => a.Id == sourceId, cancellationToken)
            ?? throw new NotFoundException($"Source account {sourceId} was not found.");
        if (source.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Idempotent: drop this month's prior allocation transfers, then recreate.
        var prefix = $"alloc:{request.Year}-{request.Month}:";
        var prior = await _db.Transactions
            .Where(t => t.OwnerId == userId && t.BankReference != null && t.BankReference.StartsWith(prefix))
            .ToListAsync(cancellationToken);
        _db.Transactions.RemoveRange(prior);

        var date = new DateOnly(request.Year, request.Month, 1);
        var created = 0;
        foreach (var m in plan.Result.Members)
        {
            if (m.Residual <= 0m || m.SavingsAccountId is not Guid savingsId)
            {
                continue;
            }

            _db.Transactions.Add(new Transaction
            {
                OwnerId = userId,
                Date = date,
                Payee = $"Income allocation — {m.Name}",
                Amount = m.Residual,
                Currency = CurrencyCode.Eur,
                ExchangeRate = 1m,
                Type = TransactionType.Transfer,
                AccountId = sourceId,
                TransferAccountId = savingsId,
                BankReference = prefix + m.MemberId,
            });
            created++;
        }

        await _db.SaveChangesAsync(cancellationToken);

        return plan.Result.ToDto(plan.EnvelopesTotal, plan.JarsTotal, created);
    }
}
