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
            CoverStart = request.CoverStart,
            CoverEnd = request.CoverEnd,
            Accrual = request.Accrual,
            // Recurring jars carry their cycle length (yearly unless told otherwise);
            // Goals are one-and-done and never roll.
            RecurMonths = request.Kind == JarKind.Recurring ? request.RecurMonths ?? 12 : null,
            FundingAccountId = account.Id,
        };
        _db.Jars.Add(jar);

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
            await PlantLinesAsync(userId, jar, today, allocated, cancellationToken);
            await _db.SaveChangesAsync(cancellationToken);
            if (write is not null)
            {
                await write.CommitAsync(cancellationToken);
            }
        }
        else
        {
            await PlantLinesAsync(userId, jar, today, 0m, cancellationToken);
            await _db.SaveChangesAsync(cancellationToken);
        }

        // Report the figures the Jars page will derive from the rows just written, so the
        // card doesn't change on the next load.
        var result = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken, new[] { account.Id });
        return jar.ToDto(result);
    }

    /// <summary>
    /// Land the jar's contribution line in every already-created month from the current one
    /// forward, so it starts filling without a manual Budget-page step (months created later
    /// get their line from month creation). Past months are history and stay untouched. Each
    /// month's planned amount is recomputed with the earlier plantings folded in — the same
    /// figure month creation would have seeded had the months been created after the jar.
    /// </summary>
    private async Task PlantLinesAsync(string userId, Jar jar, DateOnly asOf, decimal balance, CancellationToken cancellationToken)
    {
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
                jar, new DateOnly(month.Year, month.Month, 1), balance + planted);
            SavingsLines.AppendJarLine(_db, month, jar, monthPlanned);
            planted += monthPlanned;
        }
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
