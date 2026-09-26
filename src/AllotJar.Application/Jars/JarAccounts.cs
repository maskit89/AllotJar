using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>Shared checks for the account a jar's money lives in (rules 2, 73, 75).</summary>
public static class JarAccounts
{
    public static async Task<Account> LoadDesignatedAsync(
        IApplicationDbContext db, string userId, Guid accountId, string errorKey, CancellationToken cancellationToken)
    {
        var account = await db.Accounts.FirstOrDefaultAsync(a => a.Id == accountId, cancellationToken)
            ?? throw new NotFoundException($"Account {accountId} was not found.");
        if (account.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        if (account.Type == AccountType.CreditCard)
        {
            throw Validation(errorKey, "A credit card cannot hold a jar's money. Choose a current, savings or cash account.");
        }
        return account;
    }

    public static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
