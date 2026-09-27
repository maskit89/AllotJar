using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

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

        var jar = await _db.Jars
            .FirstOrDefaultAsync(f => f.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Jar {request.Id} was not found.");

        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        if (request.FundingAccountId != jar.FundingAccountId)
        {
            // Rule 80: the account can change only while the jar holds nothing; a field change
            // never moves money. Anything else goes through "Move money" (a confirmed transfer).
            var account = await JarAccounts.LoadDesignatedAsync(_db, userId, request.FundingAccountId, "FundingAccountId", cancellationToken);
            var current = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken, new[] { jar.FundingAccountId });
            var balance = current.BalanceOf(jar.Id);
            if (balance is null)
            {
                throw JarAccounts.Validation("FundingAccountId",
                    $"{jar.Name}'s balance is not available today, so its account cannot be changed.");
            }
            if (balance != 0m)
            {
                throw JarAccounts.Validation("FundingAccountId",
                    $"{jar.Name} holds {balance:0.##} in {current.AccountOf(jar.Id)?.Account.Name}. " +
                    "Move that money first (a transfer to the new account, or a reallocation to another jar), then change the account.");
            }
            jar.FundingAccountId = account.Id;
        }

        jar.Name = request.Name.Trim();
        jar.Kind = request.Kind;
        jar.TargetAmount = request.TargetAmount;
        jar.TargetDate = request.TargetDate;
        jar.CoverStart = request.CoverStart;
        jar.CoverEnd = request.CoverEnd;
        jar.Accrual = request.Accrual;
        // Recurring jars carry their cycle length; Goals never roll. Fall back to the
        // stored cycle (then yearly) when a request omits it, so an older/stale client
        // that doesn't send recurMonths can't silently reset a chosen 3/6-month cycle.
        jar.RecurMonths = request.Kind == JarKind.Recurring
            ? request.RecurMonths ?? jar.RecurMonths ?? 12
            : null;

        await _db.SaveChangesAsync(cancellationToken);

        var snapshot = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken, new[] { jar.FundingAccountId });
        return jar.ToDto(snapshot);
    }
}
