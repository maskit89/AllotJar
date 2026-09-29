using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Accounts.Commands.CreateAccount;

public class CreateAccountCommandHandler : IRequestHandler<CreateAccountCommand, AccountDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    public CreateAccountCommandHandler(IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<AccountDto> Handle(CreateAccountCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

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

        // Rule 63/85: every account of the budget is in the budget's one currency. An account in
        // another currency would hold money no budget figure could count without a conversion.
        var currency = CurrencyCode.From(request.Currency);
        var budgetCurrency = await BudgetCurrency.ResolveAsync(_db, _identity, userId, cancellationToken);
        if (currency != budgetCurrency)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.Currency)] = new[]
                {
                    $"This budget is in {budgetCurrency.Value}, so its accounts are too. " +
                    $"A bank converts payments in other currencies into {budgetCurrency.Value} itself.",
                },
            });
        }

        // New accounts sort after the user's existing ones.
        var nextOrder = await _db.Accounts
            .Where(a => a.OwnerId == userId)
            .Select(a => (int?)a.DisplayOrder)
            .MaxAsync(cancellationToken) ?? -1;

        var account = new Account
        {
            OwnerId = userId,
            Name = request.Name.Trim(),
            Type = request.Type,
            Currency = currency,
            OpeningBalance = request.OpeningBalance,
            // The validator guarantees a date; a defensive throw keeps a bypassing caller from
            // persisting an account whose balance could never be calculated.
            OpeningDate = request.OpeningDate
                ?? throw new ValidationException(new Dictionary<string, string[]>
                {
                    [nameof(request.OpeningDate)] = new[] { "Enter the date the opening balance applies from." },
                }),
            DisplayOrder = nextOrder + 1,
            Iban = BankIdentifiers.NormalizeIban(request.Iban),
            Bic = BankIdentifiers.NormalizeBic(request.Bic),
            SortCode = BankIdentifiers.NormalizeSortCode(request.SortCode),
            AccountNumber = BankIdentifiers.NormalizeAccountNumber(request.AccountNumber),
        };

        // Rule 30: who holds it. Rule 31 (P54): a personal account the caller adds for their own
        // person starts private until they share it; one added for someone else starts shared and
        // goes into that person's sharing review (rule 32).
        var holders = await AccountSharing.ResolveHoldersAsync(_db, userId, request.HolderIds ?? Array.Empty<Guid>(), cancellationToken);
        foreach (var holder in holders)
        {
            account.Holders.Add(new AccountHolder { AccountId = account.Id, MemberId = holder.Id });
        }
        var ownPersonal = holders.Count == 1 && holders[0].Id == _currentUser.MemberId && _currentUser.UserId is not null;
        if (request.IsPrivate ?? ownPersonal)
        {
            await AccountSharing.EnsureCanBePrivateAsync(_db, _currentUser, account, holders, "IsPrivate", cancellationToken);
            await AccountSharing.SetPrivateAsync(_db, account, _currentUser.UserId, cancellationToken);
        }
        else if (holders.Count == 1)
        {
            await AccountSharing.FlagReviewForHolderAsync(_db, _currentUser, userId, holders[0].Id, cancellationToken);
        }

        _db.Accounts.Add(account);
        await _db.SaveChangesAsync(cancellationToken);

        // Read back through the ledger so a future-dated opening reports "unavailable" today
        // rather than pretending the money is already there.
        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(_db, userId, new[] { account }, asOf, cancellationToken);
        var dto = account.ToDto(views[account.Id]);
        await AccountSharing.DecorateAsync(_db, _currentUser, new[] { (account, dto) }, cancellationToken);
        return dto;
    }
}
