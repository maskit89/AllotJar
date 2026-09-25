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

        account.Name = request.Name.Trim();
        account.Type = request.Type;
        account.OpeningBalance = request.OpeningBalance;
        account.OpeningDate = request.OpeningDate
            ?? throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.OpeningDate)] = new[] { "Enter the date the opening balance applies from." },
            });

        await _db.SaveChangesAsync(cancellationToken);

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(_db, userId, new[] { account }, asOf, cancellationToken);
        return account.ToDto(views[account.Id]);
    }
}
