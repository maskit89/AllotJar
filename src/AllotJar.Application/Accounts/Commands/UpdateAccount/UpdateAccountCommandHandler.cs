using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

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

        // Rule 74 holds for the whole history: a smaller opening balance, or a later opening
        // date, must not leave any recorded payment uncovered.
        await AccountBalanceGuard.EnsureNonNegativeAsync(
            _db, new[] { account }, Array.Empty<Domain.Entities.Transaction>(), Array.Empty<Guid>(), "OpeningBalance", cancellationToken);

        await _db.SaveChangesAsync(cancellationToken);

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(_db, userId, new[] { account }, asOf, cancellationToken);
        return account.ToDto(views[account.Id]);
    }
}
