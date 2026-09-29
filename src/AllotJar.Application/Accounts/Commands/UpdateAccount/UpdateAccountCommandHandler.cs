using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
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

        account.Name = request.Name.Trim();
        account.Type = request.Type;
        account.OpeningBalance = request.OpeningBalance;
        account.OpeningDate = request.OpeningDate
            ?? throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.OpeningDate)] = new[] { "Enter the date the opening balance applies from." },
            });

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

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(_db, userId, new[] { account }, asOf, cancellationToken);
        var dto = account.ToDto(views[account.Id]);
        await AccountSharing.DecorateAsync(_db, _currentUser, new[] { (account, dto) }, cancellationToken);
        return dto;
    }

    // Rule 30: the holders are who the account belongs to; its balance and history are untouched.
    private async Task ReplaceHoldersAsync(Account account, IReadOnlyList<Guid> holderIds, string ownerId, CancellationToken ct)
    {
        var holders = await AccountSharing.ResolveHoldersAsync(_db, ownerId, holderIds, ct);
        var before = account.Holders.Select(h => h.MemberId).ToHashSet();
        if (before.SetEquals(holders.Select(h => h.Id)))
        {
            return;
        }

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
