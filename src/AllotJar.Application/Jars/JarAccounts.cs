using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>Shared checks for the account a jar's money lives in (rules 2, 63, 73, 75).</summary>
public static class JarAccounts
{
    public static async Task<Account> LoadDesignatedAsync(
        IApplicationDbContext db, string userId, Guid accountId, string errorKey, CancellationToken cancellationToken,
        IIdentityService? identity = null)
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
        // A jar is budget money (rule 63): an account kept in another currency, which new accounts
        // can no longer be, cannot back one without converting its money.
        var budgetCurrency = await BudgetCurrency.ResolveAsync(db, identity, userId, cancellationToken);
        if (account.Currency != budgetCurrency)
        {
            throw Validation(errorKey,
                $"{account.Name} is in {account.Currency.Value}, but the budget is in {budgetCurrency.Value}. " +
                $"Choose an account in {budgetCurrency.Value}.");
        }
        return account;
    }

    /// <summary>The error key that tells the client to show the rule 34 warning before sharing.</summary>
    public const string AccountPrivateKey = "accountPrivate";

    /// <summary>
    /// Rules 33/34 (P55): a jar is part of the household's budget, so the account it lives in must be
    /// visible to the household. When the caller picked their own private account, the first attempt
    /// is refused with <see cref="AccountPrivateKey"/> so the client can warn what would become
    /// visible; with <paramref name="shareAccount"/> (the user chose "Share the account and
    /// continue") the account is shared. Money never moves here.
    /// </summary>
    public static async Task EnsureVisibleForJarAsync(
        IApplicationDbContext db, Account account, bool shareAccount, CancellationToken cancellationToken)
    {
        var privacy = await db.AccountPrivacies.FirstOrDefaultAsync(p => p.AccountId == account.Id, cancellationToken);
        if (privacy is null)
        {
            return;
        }
        if (!shareAccount)
        {
            throw PrivateAccountWarning(account.Name);
        }
        db.AccountPrivacies.Remove(privacy);
    }

    /// <summary>The rule 34 warning for a jar about to land on the caller's private account.</summary>
    public static ValidationException PrivateAccountWarning(string accountName) => Validation(AccountPrivateKey,
        $"'{accountName}' is private. A jar is part of the household budget, so the account it lives in " +
        $"is visible to everyone: sharing this jar shows the household '{accountName}', its balance and " +
        "all its transactions. Share the account, or pick another account for the jar.");

    public static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
