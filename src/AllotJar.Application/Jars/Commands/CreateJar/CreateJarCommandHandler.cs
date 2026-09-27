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

        var account = await JarAccounts.LoadDesignatedAsync(_db, userId, request.FundingAccountId, "FundingAccountId", cancellationToken);
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        var jar = new Jar
        {
            OwnerId = userId,
            Name = request.Name.Trim(),
            Kind = request.Kind,
            TargetAmount = request.TargetAmount,
            TargetDate = request.TargetDate,
            Accrual = request.Accrual,
            // A deadline plan has no fixed amount and a fixed monthly plan no deadline-month
            // opt-in; the validator has already refused the combinations that don't make sense.
            MonthlyContribution = request.Accrual == AccrualMethod.FixedMonthly ? request.MonthlyContribution : null,
            IncludeDeadlineMonth = request.Accrual == AccrualMethod.TargetByDate && request.IncludeDeadlineMonth,
            // Recurring jars carry their cycle length (yearly unless told otherwise);
            // Goals are one-and-done and never roll.
            RecurMonths = request.Kind == JarKind.Recurring ? request.RecurMonths ?? 12 : null,
            // A Recurring jar's first cycle is due on the date given (W03); it advances as
            // cycles close. Goals have no cycle.
            CycleDeadline = request.Kind == JarKind.Recurring ? request.TargetDate : null,
            FundingAccountId = account.Id,
        };

        // Rule 77: "already set aside" divides money that is in the account on the chosen date;
        // it must be covered by the account's unallocated funds as of that date (rule 68) and
        // leave every positive jar backed (rule 70). Serialised per account so two setups cannot
        // both claim the same unallocated money.
        var allocated = 0m;
        if (request.InitialAllocation > 0m)
        {
            var date = request.InitialAllocationDate ?? today;
            if (date > today)
            {
                throw JarAccounts.Validation("InitialAllocationDate", "Money already set aside cannot be dated in the future.");
            }
            if (account.OpeningDate is DateOnly opening && date < opening)
            {
                throw JarAccounts.Validation("InitialAllocationDate",
                    $"{account.Name} opens on {opening:yyyy-MM-dd}; money cannot be set aside before that.");
            }

            await using var write = await _db.BeginLedgerWriteAsync(account.Id, cancellationToken);
            var snapshot = await JarLedgerReader.ReadAsync(_db, userId, date, cancellationToken, new[] { account.Id });
            if (!snapshot.Accounts.TryGetValue(account.Id, out var view) || !view.IsAvailable)
            {
                // The account backs no jar yet or its balance is unavailable: read it directly.
                view = await ReadFreshAsync(userId, account, date, cancellationToken)
                    ?? throw JarAccounts.Validation("InitialAllocationDate",
                        $"{account.Name}'s balance is not available on {date:yyyy-MM-dd}.");
            }
            var postings = new List<JarLedgerPosting>
            {
                new(jar.Id, request.InitialAllocation),
                new(null, -request.InitialAllocation),
            };
            try
            {
                JarReallocationRules.Validate(view.Ledger, null, request.InitialAllocation, requiresBankTransfer: false);
                JarReallocationRules.ValidateResult(JarLedgerReader.Apply(view, postings));
            }
            catch (InvalidOperationException ex)
            {
                throw JarAccounts.Validation("InitialAllocation",
                    $"{account.Name} has {view.Unallocated:0.##} unallocated on {date:yyyy-MM-dd}. {ex.Message}");
            }

            // The jar is staged only once its allocation passed: a context reused after a refusal
            // must never persist a jar without the money it claimed.
            _db.Jars.Add(jar);
            _db.JarAllocations.Add(new JarAllocation
            {
                OwnerId = userId,
                AccountId = account.Id,
                Kind = JarAllocationKind.InitialAllocation,
                Date = date,
                CreatedUtc = DateTime.UtcNow,
                Postings = postings.Select(p => new JarAllocationPosting { JarId = p.JarId, Amount = p.Amount }).ToList(),
            });
            allocated = request.InitialAllocation;
            await JarPlanner.ReplantAsync(_db, userId, jar, today, allocated, cancellationToken);
            await _db.SaveChangesAsync(cancellationToken);
            if (write is not null)
            {
                await write.CommitAsync(cancellationToken);
            }
        }
        else
        {
            _db.Jars.Add(jar);
            await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken);
            await _db.SaveChangesAsync(cancellationToken);
        }

        // Report the figures the Jars page will derive from the rows just written, so the
        // card doesn't change on the next load.
        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }

    /// <summary>An account that backs no jar yet has no snapshot entry; read its money alone.</summary>
    private async Task<JarLedgerView?> ReadFreshAsync(string userId, Account account, DateOnly date, CancellationToken cancellationToken)
    {
        if (account.OpeningDate is not DateOnly opening || date < opening)
        {
            return null;
        }
        var ledger = await Accounts.AccountLedgerReader.ReadAsync(_db, userId, new[] { account }, date, cancellationToken);
        var view = ledger[account.Id];
        if (view.Balance is not decimal balance)
        {
            return null;
        }
        // No jar yet means every movement is unallocated: the whole balance is free.
        return new JarLedgerView(date, account,
            new SavingsLedgerBalance(date, balance, new Dictionary<Guid, decimal>(), balance)
            {
                PendingTransferReceipts = view.PendingReceipts,
            }, false, 0);
    }
}
