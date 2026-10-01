using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Commands.MarkJarCyclePaid;

public class MarkJarCyclePaidCommandHandler : IRequestHandler<MarkJarCyclePaidCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public MarkJarCyclePaidCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(MarkJarCyclePaidCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var jar = await _db.Jars.FirstOrDefaultAsync(j => j.Id == request.JarId, cancellationToken)
            ?? throw new NotFoundException($"Jar {request.JarId} was not found.");
        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        if (jar.Kind != JarKind.Recurring)
        {
            throw JarAccounts.Validation("Deadline", $"{jar.Name} is a goal, not a recurring jar; it has no cycles to mark paid.");
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        // A funded cycle whose deadline has arrived rolls forward first (rule 21), so the open
        // cycle is the one the user sees.
        await JarCycles.SettleAsync(_db, userId, today, cancellationToken, jar.Id);

        var payment = await _db.Transactions.FirstOrDefaultAsync(t => t.Id == request.PaymentTransactionId, cancellationToken)
            ?? throw new NotFoundException($"Transaction {request.PaymentTransactionId} was not found.");
        if (payment.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        if (payment.Type != TransactionType.Expense || payment.IsRefund)
        {
            throw JarAccounts.Validation("PaymentTransactionId", "Choose the payment that settled the bill — money out, not income, a transfer or a refund.");
        }
        // A transfer's fee is changed only through its transfer and goes with it, so it can't be
        // the payment a cycle keeps (#301 review P3-2).
        if (payment.FeeForTransferId is not null)
        {
            throw JarAccounts.Validation("PaymentTransactionId", "That is a transfer's fee, not the bill's payment. Choose the payment that settled the bill.");
        }
        if (payment.Date > today)
        {
            throw JarAccounts.Validation("PaymentTransactionId", "That payment is dated in the future.");
        }
        // A payment still waiting for its budget-currency amount counts nowhere yet (rule 44), so
        // it can't settle a cycle: the cycle would record its foreign figure as budget money.
        if (payment.FxPending)
        {
            throw JarAccounts.Validation("PaymentTransactionId",
                $"That payment is in {payment.Currency.Value} and is waiting for its amount in the budget currency. Enter that amount on Transactions first.");
        }
        var alreadyFulfilled = await _db.JarCycles
            .Include(c => c.Jar)
            .FirstOrDefaultAsync(c => c.PaymentTransactionId == payment.Id, cancellationToken);
        if (alreadyFulfilled is not null)
        {
            throw JarAccounts.Validation("PaymentTransactionId",
                $"That payment already fulfilled {alreadyFulfilled.Jar.Name}'s cycle due {alreadyFulfilled.Deadline:d MMM yyyy}. A payment settles one cycle.");
        }

        if (jar.CycleDeadline == request.Deadline)
        {
            await JarCycles.CloseOpenCycleAsync(_db, userId, jar, JarCycleOutcome.Paid, payment, today, cancellationToken);
        }
        else
        {
            var cycle = await _db.JarCycles
                .FirstOrDefaultAsync(c => c.JarId == jar.Id && c.Deadline == request.Deadline, cancellationToken)
                ?? throw JarAccounts.Validation("Deadline",
                    $"{jar.Name} has no cycle due {request.Deadline:d MMM yyyy}. Its current cycle is due {jar.CycleDeadline:d MMM yyyy}.");
            if (cycle.PaymentTransactionId is not null)
            {
                throw JarAccounts.Validation("Deadline", $"The cycle due {cycle.Deadline:d MMM yyyy} is already marked paid.");
            }
            JarCycles.Link(cycle, payment);
            // The bill left the jar: the next cycle's plan starts from what is actually left now,
            // this month included (rules 19, 23; P37), as it does when the open cycle is marked
            // paid. A cycle that rolled forward Funded had replanted from before the payment (SC-P2-2).
            if (JarSchedule.IsPlanning(jar))
            {
                await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken);
            }
        }

        await _db.SaveChangesAsync(cancellationToken);
        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }
}
