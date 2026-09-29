using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

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

        // The validator enforces both; a bypassing caller must still not turn a plan into money.
        if (!request.ConfirmedCompleted || request.DepartedOn is not DateOnly departedOn)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["ConfirmedCompleted"] = new[]
                {
                    "Confirm that you've completed these transfers, and the date the money left the source account, before recording them.",
                },
            });
        }

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

        // The residual is expressed in this month's budget currency. Matching the two
        // account currencies alone is insufficient: copying a EUR residual to GBP
        // accounts would silently invent a 1:1 conversion. Check before touching any
        // previous allocation so a rejected retry leaves existing transfers intact.
        var month = await _db.BudgetMonths
            .AsNoTracking()
            .FirstOrDefaultAsync(m => m.OwnerId == userId
                                     && m.Year == request.Year && m.Month == request.Month,
                cancellationToken)
            ?? throw new NotFoundException($"No budget exists for {request.Year}-{request.Month:00}.");
        if (source.Currency != month.BaseCurrency)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["SourceAccountId"] = new[]
                {
                    $"The source account is in {source.Currency.Value}, but this budget is in " +
                    $"{month.BaseCurrency.Value}. Choose an account in the budget currency.",
                },
            });
        }

        // This month's previously recorded allocation transfers, keyed by member. A re-run is
        // reconciled against them rather than blindly replaced: a recorded bank transfer is
        // evidence, not a plan line.
        var prefix = $"alloc:{request.Year}-{request.Month}:";
        var prior = (await _db.Transactions
                .Where(t => t.OwnerId == userId && t.BankReference != null && t.BankReference.StartsWith(prefix))
                .ToListAsync(cancellationToken))
            .ToDictionary(t => t.BankReference!, StringComparer.OrdinalIgnoreCase);

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

        var created = 0;
        var added = new List<Transaction>();
        var removed = new List<Guid>();
        // Each member's transfer, new or retained, for the jar prompt's answer below.
        var transfersByMember = new Dictionary<Guid, (Transaction Transfer, Account Savings)>();
        // Prior transfers left exactly as recorded because this run produced the same movement.
        var retained = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Serialise against the source account's other writers for the rule 74 check below.
        await using var write = await _db.BeginLedgerWriteAsync(sourceId, cancellationToken);
        foreach (var m in plan.Result.Members)
        {
            if (m.Residual <= 0m || m.SavingsAccountId is not Guid savingsId)
            {
                continue;
            }
            if (!savingsAccounts.TryGetValue(savingsId, out var savings))
            {
                // P53: another login's private account is not there for this caller to pay into.
                if (await _db.AccountPrivacies.AnyAsync(p => p.AccountId == savingsId, cancellationToken))
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["Allocation"] = new[]
                        {
                            $"{m.Name}'s savings account is private, so only {m.Name} can record a transfer into it. " +
                            $"Point {m.Name}'s savings at a shared account on the People page, or leave it empty.",
                        },
                    });
                }
                throw new NotFoundException($"Savings account {savingsId} was not found.");
            }
            // A member whose savings account IS the allocation source would get a no-op
            // self-transfer: zero balance effect, yet counted and reported as a created
            // transfer. Reject it — the profile/member editors also refuse to save this
            // combination, but the data may predate those guards.
            if (savingsId == sourceId)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["Allocation"] = new[]
                    {
                        $"{m.Name}'s savings account is the allocation source account. Pick a different " +
                        "source account, or point the member's savings at another account.",
                    },
                });
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

            var reference = prefix + m.MemberId;
            if (prior.TryGetValue(reference, out var existing))
            {
                // Unchanged movement: keep the recorded legs, including a receipt confirmed since.
                if (existing.Amount == m.Residual && existing.AccountId == sourceId && existing.TransferAccountId == savingsId)
                {
                    retained.Add(reference);
                    transfersByMember[m.MemberId] = (existing, savings);
                    continue;
                }
                // A changed movement can only replace an in-transit transfer. Once its receipt is
                // confirmed it is bank history; the user removes it explicitly on the register.
                if (existing.ReceivedOn is not null)
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["Allocation"] = new[]
                        {
                            $"{m.Name}'s allocation transfer for this month is already confirmed as received " +
                            $"({existing.Amount:0.####} on {existing.ReceivedOn:yyyy-MM-dd}). Delete it on the Transactions page before re-running.",
                        },
                    });
                }
            }

            var transfer = new Transaction
            {
                OwnerId = userId,
                Date = departedOn,
                DepartedOn = departedOn,
                ReceivedOn = request.ReceivedOn,
                Payee = $"Income allocation — {m.Name}",
                Amount = m.Residual,
                // Stamp the source account's currency (both legs share it, guarded above), not EUR.
                Currency = source.Currency,
                ExchangeRate = 1m,
                Type = TransactionType.Transfer,
                AccountId = sourceId,
                TransferAccountId = savingsId,
                BankReference = reference,
            };
            _db.Transactions.Add(transfer);
            added.Add(transfer);
            transfersByMember[m.MemberId] = (transfer, savings);
            created++;
        }

        // Every prior row not retained is superseded: the member's movement changed (its
        // replacement was added above) or the member has no surplus this time. Only an
        // in-transit row may be dropped; a confirmed receipt is bank history.
        foreach (var (reference, stale) in prior)
        {
            if (retained.Contains(reference))
            {
                continue;
            }
            if (stale.ReceivedOn is not null)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["Allocation"] = new[]
                    {
                        $"The allocation transfer '{stale.Payee}' for this month is already confirmed as received. " +
                        "Delete it on the Transactions page before re-running.",
                    },
                });
            }
            _db.Transactions.Remove(stale);
            removed.Add(stale.Id);
        }

        // Rule 74: the source must stay at or above zero on every date with this month's
        // transfers recorded (superseded in-transit rows no longer count).
        await AccountBalanceGuard.EnsureNonNegativeAsync(_db, new[] { source }, added, removed, "Allocation", cancellationToken);

        // Rule 78: divide each member's receipt among their savings account's jars as answered.
        if (request.JarAllocations is { Count: > 0 })
        {
            foreach (var group in request.JarAllocations.GroupBy(a => a.MemberId))
            {
                if (!transfersByMember.TryGetValue(group.Key, out var target))
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["JarAllocations"] = new[] { "Jar amounts were given for a member with no allocation transfer this month." },
                    });
                }
                await JarMovements.ApplyIncomingAsync(
                    _db, userId, target.Transfer, target.Savings, target.Transfer.ReceivedOn ?? departedOn, target.Transfer.Amount,
                    group.Select(a => new JarAllocationInput(a.JarId, a.Amount)).ToList(), "JarAllocations", cancellationToken);
            }
        }

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return plan.Result.ToDto(
            plan.EnvelopesTotal, plan.JarsTotal, created,
            unattributedIncome: plan.UnattributedIncome, incomeFromBudget: plan.IncomeFromBudget,
            transfersRetained: retained.Count);
    }
}
