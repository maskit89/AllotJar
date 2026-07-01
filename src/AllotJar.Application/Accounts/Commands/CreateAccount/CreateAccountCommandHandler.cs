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
            DisplayOrder = nextOrder + 1,
        };

        _db.Accounts.Add(account);
        await _db.SaveChangesAsync(cancellationToken);

        // No transactions yet, so the current balance is just the opening balance.
        account.CurrentBalance = account.OpeningBalance;
        return account.ToDto();
    }
}
