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

        // Load every target savings account up front to validate ownership and currency. An
        // allocation transfer, like any transfer, must stay in one currency (the source's), or the
        // currency-blind account balances drift. (Previously the transfer was hardcoded to EUR and
        // the destination account was never re-validated.)
        var savingsIds = plan.Result.Members
            .Where(m => m.Residual > 0m && m.SavingsAccountId is Guid)
            .Select(m => m.SavingsAccountId!.Value)
            .Distinct()
            .ToList();
        var savingsAccounts = await _db.Accounts
            .Where(a => savingsIds.Contains(a.Id) && a.OwnerId == userId)
            .ToDictionaryAsync(a => a.Id, cancellationToken);

        var date = new DateOnly(request.Year, request.Month, 1);
        var created = 0;
        foreach (var m in plan.Result.Members)
        {
            if (m.Residual <= 0m || m.SavingsAccountId is not Guid savingsId)
            {
                continue;
            }
            if (!savingsAccounts.TryGetValue(savingsId, out var savings))
            {
                throw new NotFoundException($"Savings account {savingsId} was not found.");
            }
            if (savings.Currency != source.Currency)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["Allocation"] = new[]
                    {
                        $"{m.Name}'s savings account is in {savings.Currency.Value} but the source account is in " +
                        $"{source.Currency.Value}. Allocation transfers must stay in one currency.",
                    },
                });
            }

            _db.Transactions.Add(new Transaction
            {
                OwnerId = userId,
                Date = date,
                Payee = $"Income allocation — {m.Name}",
                Amount = m.Residual,
                // Stamp the source account's currency (both legs share it, guarded above), not EUR.
                Currency = source.Currency,
                ExchangeRate = 1m,
                Type = TransactionType.Transfer,
                AccountId = sourceId,
                TransferAccountId = savingsId,
                BankReference = prefix + m.MemberId,
            });
            created++;
        }

        await _db.SaveChangesAsync(cancellationToken);

        return plan.Result.ToDto(
            plan.EnvelopesTotal, plan.JarsTotal, created,
            unattributedIncome: plan.UnattributedIncome, incomeFromBudget: plan.IncomeFromBudget);
    }
}
