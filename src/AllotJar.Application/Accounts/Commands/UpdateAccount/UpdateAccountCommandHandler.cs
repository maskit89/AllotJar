using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Accounts.Commands.UpdateAccount;

public class UpdateAccountCommandHandler : IRequestHandler<UpdateAccountCommand, AccountDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpdateAccountCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<AccountDto> Handle(UpdateAccountCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // The account's ledger lock comes first (P11): the jar and rule 74 checks below read its
        // money, and a payment or reallocation racing the edit must wait and then see it (JL-P2-6).
        await using var write = await _db.BeginLedgerWriteAsync(request.Id, cancellationToken);
        var account = await _db.Accounts
            .Include(a => a.Holders)
            .FirstOrDefaultAsync(a => a.Id == request.Id, cancellationToken);

        if (account is null)
        {
            throw new NotFoundException($"Account {request.Id} was not found.");
        }
        if (account.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        MoneyInput.EnsureAccepted((nameof(request.OpeningBalance), request.OpeningBalance, account.OpeningBalance));
        _db.ExpectVersion(account, request.Version);

        // The validators enforce both; a bypassing caller must still not create a credit-card
        // account (rule 75) or a negative opening (rule 74).
        if (request.Type == Domain.Enums.AccountType.CreditCard || request.OpeningBalance < 0m)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [request.Type == Domain.Enums.AccountType.CreditCard ? "Type" : "OpeningBalance"] = new[]
                {
                    request.Type == Domain.Enums.AccountType.CreditCard
                        ? "Credit cards are not accounts here: an account holds money, a card owes it."
                        : "The opening balance must be zero or more: an account never has a negative balance here.",
                },
            });
        }

        var openingDate = request.OpeningDate
            ?? throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.OpeningDate)] = new[] { "Enter the date the opening balance applies from." },
            });
        if (account.OpeningDate is { } previousOpening && previousOpening != openingDate)
        {
            await EnsureJarsKeepTheirMoneyAsync(account, openingDate, userId, cancellationToken);
        }
        if (request.OpeningBalance < account.OpeningBalance || account.OpeningDate != openingDate)
        {
            await EnsureJarsStayBackedAsync(account, request.OpeningBalance, openingDate, userId, cancellationToken);
        }

        account.Name = request.Name.Trim();
        account.Type = request.Type;
        account.OpeningBalance = request.OpeningBalance;
        account.OpeningDate = openingDate;

        account.Iban = BankIdentifiers.NormalizeIban(request.Iban);
        account.Bic = BankIdentifiers.NormalizeBic(request.Bic);
        account.SortCode = BankIdentifiers.NormalizeSortCode(request.SortCode);
        account.AccountNumber = BankIdentifiers.NormalizeAccountNumber(request.AccountNumber);

        if (request.HolderIds is { } holderIds)
        {
            await ReplaceHoldersAsync(account, holderIds, userId, cancellationToken);
        }

        // Rule 74 holds for the whole history: a smaller opening balance, or a later opening
        // date, must not leave any recorded payment uncovered.
        await AccountBalanceGuard.EnsureNonNegativeAsync(
            _db, new[] { account }, Array.Empty<Domain.Entities.Transaction>(), Array.Empty<Guid>(), "OpeningBalance", cancellationToken);

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(_db, userId, new[] { account }, asOf, cancellationToken);
        var dto = account.ToDto(views[account.Id]);
        await AccountSharing.DecorateAsync(_db, _currentUser, new[] { (account, dto) }, cancellationToken);
        return dto;
    }

    /// <summary>
    /// A new opening date changes which entries the account's ledger counts, and with them what its
    /// jars hold: moved later, it drops a jar's money put in before it but keeps the payments taken
    /// out after it (or the departure that settled them when the jar moved away), so the jar reads
    /// below zero (rule 2; #280 review P3-3). The opening balance is the account's money, not any
    /// jar's, so the date may move only while no jar's balance in the account changes; the jar
    /// entries in between are changed or removed first.
    /// </summary>
    private async Task EnsureJarsKeepTheirMoneyAsync(Account account, DateOnly openingDate, string ownerId, CancellationToken ct)
    {
        var source = await Jars.JarLedgerReader.LoadAsync(_db, ownerId, ct, new[] { account.Id });
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        if (!source.At(today).Accounts.TryGetValue(account.Id, out var before))
        {
            return; // The account carries no jar.
        }
        // The loaded account is an untracked copy, read again with the new date.
        before.Account.OpeningDate = openingDate;
        var after = source.At(today).Accounts[account.Id];
        var changed = before.JarBalances.Keys.Union(after.JarBalances.Keys)
            .Where(j => before.JarBalances.GetValueOrDefault(j) != after.JarBalances.GetValueOrDefault(j))
            .ToList();
        if (changed.Count == 0)
        {
            return;
        }
        var names = await _db.Jars.AsNoTracking()
            .Where(j => changed.Contains(j.Id))
            .OrderBy(j => j.Name)
            .Select(j => j.Name)
            .ToListAsync(ct);
        throw new ValidationException(new Dictionary<string, string[]>
        {
            ["OpeningDate"] = new[]
            {
                $"{string.Join(", ", names)} would change: the jar entries between the old and new opening date "
                + $"would no longer count in {account.Name}. Change or remove those entries first, or keep the opening date.",
            },
        });
    }

    /// <summary>
    /// A smaller opening balance takes money out of the account on every date, but none out of its
    /// jars: on a day the jars held more than what is left, their positive balances would exceed
    /// the account's money (rule 70) with nothing to explain it. Refused, naming the first such
    /// day, unless that day was already short by as much (a deficit a payment caused stays
    /// readable). The jars give money back to unallocated first (Jars page) if the opening was
    /// overstated.
    /// </summary>
    private async Task EnsureJarsStayBackedAsync(Account account, decimal openingBalance, DateOnly openingDate, string ownerId, CancellationToken ct)
    {
        var source = await Jars.JarLedgerReader.LoadAsync(_db, ownerId, ct, new[] { account.Id });
        var opening = source.ViewAt(account.Id, openingDate)?.Account;
        if (opening is null)
        {
            return; // The account carries no jar.
        }
        var previous = (opening.OpeningBalance, opening.OpeningDate);
        var dates = source.OperationDatesAfter(account.Id, openingDate).Prepend(openingDate).ToList();
        var beforeAt = source.Viewer(account.Id);
        var before = dates.Select(d => beforeAt(d)!).ToList();
        // The loaded account is an untracked copy, read again with the new opening.
        opening.OpeningBalance = openingBalance;
        opening.OpeningDate = openingDate;
        // Walked again from the new opening.
        var afterAt = source.Viewer(account.Id);
        try
        {
            for (var i = 0; i < dates.Count; i++)
            {
                var after = afterAt(dates[i])!;
                if (!after.IsAvailable || !before[i].IsAvailable)
                {
                    continue;
                }
                var shortBefore = Math.Max(0m, before[i].PositiveAllocations - before[i].AccountBalance!.Value);
                var shortAfter = Math.Max(0m, after.PositiveAllocations - after.AccountBalance!.Value);
                if (shortAfter > shortBefore)
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["OpeningBalance"] = new[]
                        {
                            $"On {dates[i]:yyyy-MM-dd} {account.Name} would hold {after.AccountBalance:0.##} while its jars hold "
                            + $"{after.PositiveAllocations:0.##}. Move money out of the jars to unallocated first, or keep the opening balance.",
                        },
                    });
                }
            }
        }
        finally
        {
            (opening.OpeningBalance, opening.OpeningDate) = previous;
        }
    }

    // Rule 30: the holders are who the account belongs to; its balance and history are untouched.
    private async Task ReplaceHoldersAsync(Account account, IReadOnlyList<Guid> holderIds, string ownerId, CancellationToken ct)
    {
        // Unchanged holders need no checks: the Accounts page sends them with every edit, and a
        // holder archived since (W11) must not block a rename.
        var before = account.Holders.Select(h => h.MemberId).ToHashSet();
        if (before.SetEquals(holderIds))
        {
            return;
        }
        var holders = await AccountSharing.ResolveHoldersAsync(_db, ownerId, holderIds, ct, alreadyHolding: before);

        // A private account stays personal to its holder (rule 33): sharing it comes first, so
        // nobody is added to — or left holding — an account the others can't see.
        if (await _db.AccountPrivacies.AnyAsync(p => p.AccountId == account.Id, ct)
            && (holders.Count != 1 || holders[0].Id != _currentUser.MemberId))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["HolderIds"] = new[] { "This account is private. Share it with the household before changing who holds it: only a personal account can be private." },
            });
        }

        foreach (var gone in account.Holders.Where(h => holders.All(m => m.Id != h.MemberId)).ToList())
        {
            account.Holders.Remove(gone);
        }
        foreach (var added in holders.Where(m => !before.Contains(m.Id)))
        {
            account.Holders.Add(new AccountHolder { AccountId = account.Id, MemberId = added.Id });
        }
        if (holders.Count == 1)
        {
            await AccountSharing.FlagReviewForHolderAsync(_db, _currentUser, ownerId, holders[0].Id, ct);
        }
    }
}
