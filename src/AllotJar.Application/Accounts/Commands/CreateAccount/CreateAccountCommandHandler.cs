using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Accounts.Commands.CreateAccount;

public class CreateAccountCommandHandler : IRequestHandler<CreateAccountCommand, AccountDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public CreateAccountCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<AccountDto> Handle(CreateAccountCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

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
            Currency = CurrencyCode.From(request.Currency),
            OpeningBalance = request.OpeningBalance,
            // The validator guarantees a date; a defensive throw keeps a bypassing caller from
            // persisting an account whose balance could never be calculated.
            OpeningDate = request.OpeningDate
                ?? throw new ValidationException(new Dictionary<string, string[]>
                {
                    [nameof(request.OpeningDate)] = new[] { "Enter the date the opening balance applies from." },
                }),
            DisplayOrder = nextOrder + 1,
        };

        _db.Accounts.Add(account);
        await _db.SaveChangesAsync(cancellationToken);

        // Read back through the ledger so a future-dated opening reports "unavailable" today
        // rather than pretending the money is already there.
        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(_db, userId, new[] { account }, asOf, cancellationToken);
        return account.ToDto(views[account.Id]);
    }
}
