using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Commands.ReallocateJarMoney;

public class ReallocateJarMoneyCommandHandler : IRequestHandler<ReallocateJarMoneyCommand, JarAccountLedgerDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ReallocateJarMoneyCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarAccountLedgerDto> Handle(ReallocateJarMoneyCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var account = await JarAccounts.LoadDesignatedAsync(_db, userId, request.AccountId, "AccountId", cancellationToken);
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var date = request.Date ?? today;
        if (date > today)
        {
            throw JarAccounts.Validation("Date", "Money can only be moved as of today or earlier.");
        }
        if (account.OpeningDate is DateOnly opening && date < opening)
        {
            throw JarAccounts.Validation("Date", $"{account.Name} opens on {opening:yyyy-MM-dd}; money cannot be moved before that.");
        }

        // Both sides must be this account's jars (rule 6). The destination must be active; the
        // source may be archived only in the sense that an archived jar holds nothing (rule 26).
        var source = await JarOnAccountAsync(request.SourceJarId, account.Id, userId, "SourceJarId", cancellationToken);
        var destination = await JarOnAccountAsync(request.DestinationJarId, account.Id, userId, "DestinationJarId", cancellationToken);
        foreach (var (jar, key) in new[] { (source, "SourceJarId"), (destination, "DestinationJarId") })
        {
            if (jar is not null && !JarLedgerReader.HeldOn(jar.FundingAccountId, jar.FundingAccountSince, account.Id, date))
            {
                throw JarAccounts.Validation(key, JarMovements.ArrivedLater(jar, account));
            }
        }
        if (destination is { IsArchived: true })
        {
            throw JarAccounts.Validation("DestinationJarId", $"{destination.Name} is archived. Restore it before moving money into it.");
        }

        await using var write = await _db.BeginLedgerWriteAsync(account.Id, cancellationToken);
        var ledger = await JarLedgerReader.LoadAsync(_db, userId, cancellationToken, new[] { account.Id });
        if (ledger.ViewAt(account.Id, date) is not { IsAvailable: true } view)
        {
            throw JarAccounts.Validation("Date", $"{account.Name}'s balance is not available on {date:yyyy-MM-dd}.");
        }

        var postings = new List<JarLedgerPosting>
        {
            new(request.SourceJarId, -request.Amount),
            new(request.DestinationJarId, request.Amount),
        };
        try
        {
            JarReallocationRules.Validate(view.Ledger, request.SourceJarId, request.Amount, requiresBankTransfer: false);
            JarReallocationRules.ValidateResult(JarLedgerReader.Apply(view, postings));
        }
        catch (InvalidOperationException ex)
        {
            var sourceName = source?.Name ?? "unallocated funds";
            var available = JarReallocationRules.AvailableAmountOrZero(view.Ledger, request.SourceJarId);
            throw JarAccounts.Validation("Amount",
                $"{sourceName} can give at most {available:0.##} on {date:yyyy-MM-dd}. {ex.Message}");
        }
        // A move dated in the past stays made on every later date: the source must still hold the
        // money after what it paid or moved out since, and no later day may be left unbacked.
        if (JarHistoryChecks.FirstRefusal(ledger, account, date, includeFrom: false, request.SourceJarId,
                source?.Name ?? "Unallocated funds", request.Amount, 0m, postings) is { } refusal)
        {
            throw JarAccounts.Validation("Amount", refusal);
        }

        _db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = userId,
            AccountId = account.Id,
            Kind = JarAllocationKind.Reallocation,
            Date = date,
            Note = string.IsNullOrWhiteSpace(request.Note) ? null : request.Note.Trim(),
            CreatedUtc = DateTime.UtcNow,
            Postings = postings.Select(p => new JarAllocationPosting { JarId = p.JarId, Amount = p.Amount }).ToList(),
        });
        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        var result = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken, new[] { account.Id });
        return result.Accounts[account.Id].ToDto(result);
    }

    private async Task<Jar?> JarOnAccountAsync(Guid? jarId, Guid accountId, string userId, string key, CancellationToken cancellationToken)
    {
        if (jarId is not Guid id)
        {
            return null;
        }
        var jar = await _db.Jars.AsNoTracking().FirstOrDefaultAsync(j => j.Id == id, cancellationToken)
            ?? throw new NotFoundException($"Jar {id} was not found.");
        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        if (jar.FundingAccountId != accountId)
        {
            throw JarAccounts.Validation(key,
                $"{jar.Name}'s money is held in a different account. Moving money between accounts is a bank transfer: record it on the Transactions page.");
        }
        return jar;
    }
}
