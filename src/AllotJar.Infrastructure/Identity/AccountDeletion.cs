using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// "Delete my account" (compliance fix 5). Removes a login and everything that is only its own, in
/// one transaction, so a failure leaves the account as it was:
/// <list type="bullet">
/// <item>its own household (the budget it owns): every month, line, account, transaction, jar,
/// person, allocation and access row, so the other logins in it lose access and land in a
/// household of their own;</item>
/// <item>in each household it joined (or left with private accounts still there): its private accounts, erased as the owner's erase does
/// (P59, "Keep shared"), so what the household saw stays and no one else's figure changes; then
/// its access there. The person it was linked to stays: that is the household's record;</item>
/// <item>its sign-in: the login, its Google link, its refresh tokens and every remembered link to
/// a person (<c>PersonLogins</c>).</item>
/// </list>
/// The work runs in a context with no signed-in viewer, so the privacy filters and the save guard,
/// which keep one login out of another's private accounts, don't stand in the way of erasing the
/// deleting login's own accounts or the private accounts of others in its own household.
/// </summary>
public sealed class AccountDeletion
{
    private readonly DbContextOptions<ApplicationDbContext> _options;

    public AccountDeletion(DbContextOptions<ApplicationDbContext> options)
    {
        _options = options;
    }

    /// <summary>What deleting the login takes with it, for the confirmation.</summary>
    /// <param name="OwnsHousehold">The login owns a household of its own, which goes too.</param>
    /// <param name="OthersInHousehold">Other logins with access to that household, who lose it.</param>
    /// <param name="PrivateAccountsElsewhere">The login's private accounts in other households (joined, or left).</param>
    public sealed record Preview(bool OwnsHousehold, int OthersInHousehold, int PrivateAccountsElsewhere);

    public async Task<Preview> PreviewAsync(string userId, CancellationToken ct)
    {
        await using var db = new ApplicationDbContext(_options);
        var owns = await db.HouseholdMemberships.AnyAsync(m => m.OwnerId == userId && m.UserId == userId, ct);
        var others = await db.HouseholdMemberships.CountAsync(
            m => m.OwnerId == userId && m.UserId != null && m.UserId != userId && m.Status == MembershipStatus.Active, ct);
        var privateElsewhere = await db.AccountPrivacies.CountAsync(
            p => p.UserId == userId && db.Accounts.Any(a => a.Id == p.AccountId && a.OwnerId != userId), ct);
        return new Preview(owns, others, privateElsewhere);
    }

    /// <summary>Deletes <paramref name="userId"/> and its data. A login already gone is a no-op.</summary>
    public async Task DeleteAsync(string userId, CancellationToken ct)
    {
        await using var db = new ApplicationDbContext(_options);
        await using var transaction = db.Database.IsRelational()
            ? await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct)
            : null;

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null)
        {
            return;
        }

        await LeaveJoinedHouseholdsAsync(db, userId, ct);
        var displaced = await DeleteOwnHouseholdAsync(db, userId, ct);

        db.RefreshTokens.RemoveRange(await db.RefreshTokens.Where(t => t.UserId == userId).ToListAsync(ct));
        db.PersonLogins.RemoveRange(await db.PersonLogins.Where(p => p.UserId == userId).ToListAsync(ct));
        db.UserLogins.RemoveRange(await db.UserLogins.Where(l => l.UserId == userId).ToListAsync(ct));
        db.UserClaims.RemoveRange(await db.UserClaims.Where(c => c.UserId == userId).ToListAsync(ct));
        db.UserTokens.RemoveRange(await db.UserTokens.Where(t => t.UserId == userId).ToListAsync(ct));
        db.UserRoles.RemoveRange(await db.UserRoles.Where(r => r.UserId == userId).ToListAsync(ct));
        db.Users.Remove(user);
        await db.SaveChangesAsync(ct);

        // Whoever was in the deleted household, or viewing it, lands in a household of their own,
        // as a login that leaves does (an invitee who never had one gets an empty one).
        var homeless = await db.Users
            .Where(u => displaced.Contains(u.Id) || u.ActiveOwnerId == userId)
            .ToListAsync(ct);
        foreach (var other in homeless)
        {
            if (other.ActiveOwnerId == userId)
            {
                other.ActiveOwnerId = null;
            }
            await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, other, DateTime.UtcNow, ct);
        }
        await db.SaveChangesAsync(ct);

        if (transaction is not null)
        {
            await transaction.CommitAsync(ct);
        }
    }

    /// <summary>
    /// In each household the login joined: its private accounts are erased (P59, "Keep shared"),
    /// then its access goes. Its accounts there are erased together, so a transfer between two of
    /// them goes with both.
    /// </summary>
    private static async Task LeaveJoinedHouseholdsAsync(ApplicationDbContext db, string userId, CancellationToken ct)
    {
        var memberships = await db.HouseholdMemberships
            .Where(m => m.UserId == userId && m.OwnerId != userId)
            .ToListAsync(ct);
        // A household it left earlier still holds the private accounts nobody can reach (P59)
        // until its owner erases them: those go now too.
        var leftWithAccounts = await db.Accounts
            .Where(a => a.OwnerId != userId && db.AccountPrivacies.Any(p => p.AccountId == a.Id && p.UserId == userId))
            .Select(a => a.OwnerId)
            .ToListAsync(ct);
        foreach (var ownerId in memberships.Select(m => m.OwnerId).Concat(leftWithAccounts).Distinct())
        {
            var mine = (await db.AccountPrivacies
                    .Where(p => p.UserId == userId && db.Accounts.Any(a => a.Id == p.AccountId && a.OwnerId == ownerId))
                    .Select(p => p.AccountId)
                    .ToListAsync(ct))
                .ToHashSet();
            foreach (var id in mine)
            {
                var account = await db.Accounts.FirstOrDefaultAsync(a => a.Id == id && a.OwnerId == ownerId, ct);
                if (account is not null)
                {
                    await PrivateAccountErase.EraseAsync(db, ownerId, account, mine, PrivateAccountErase.RefundedElsewhere.Keep, ct);
                }
            }
        }
        db.HouseholdMemberships.RemoveRange(memberships);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Removes every row of the household <paramref name="ownerId"/> owns. Every row is loaded and
    /// removed explicitly (not left to the database's cascades), so the restricting links between
    /// transactions, fees, refunds, jars and accounts are deleted in an order every provider
    /// accepts. Returns the other logins that had access to it.
    /// </summary>
    private static async Task<HashSet<string>> DeleteOwnHouseholdAsync(ApplicationDbContext db, string ownerId, CancellationToken ct)
    {
        var memberships = await db.HouseholdMemberships.Where(m => m.OwnerId == ownerId).ToListAsync(ct);
        var displaced = memberships
            .Where(m => m.UserId is not null && m.UserId != ownerId)
            .Select(m => m.UserId!)
            .ToHashSet();

        var transactionIds = db.Transactions.Where(t => t.OwnerId == ownerId).Select(t => t.Id);
        var jarIds = db.Jars.Where(j => j.OwnerId == ownerId).Select(j => j.Id);
        var accountIds = db.Accounts.Where(a => a.OwnerId == ownerId).Select(a => a.Id);
        var memberIds = db.HouseholdMembers.Where(m => m.OwnerId == ownerId).Select(m => m.Id);
        var allocationIds = db.JarAllocations.Where(a => a.OwnerId == ownerId).Select(a => a.Id);
        var monthIds = db.BudgetMonths.Where(m => m.OwnerId == ownerId).Select(m => m.Id);
        var categoryIds = db.BudgetCategories.Where(c => monthIds.Contains(c.BudgetMonthId)).Select(c => c.Id);
        var profileIds = db.AllocationProfiles.Where(p => p.OwnerId == ownerId).Select(p => p.Id);

        db.JarAllocationPostings.RemoveRange(await db.JarAllocationPostings.Where(p => allocationIds.Contains(p.JarAllocationId)).ToListAsync(ct));
        db.JarAllocations.RemoveRange(await db.JarAllocations.Where(a => a.OwnerId == ownerId).ToListAsync(ct));
        db.JarCycles.RemoveRange(await db.JarCycles.Where(c => c.OwnerId == ownerId).ToListAsync(ct));
        db.JarRevisions.RemoveRange(await db.JarRevisions.Where(r => jarIds.Contains(r.JarId)).ToListAsync(ct));
        db.JarArchivePeriods.RemoveRange(await db.JarArchivePeriods.Where(p => jarIds.Contains(p.JarId)).ToListAsync(ct));
        db.TransactionSplits.RemoveRange(await db.TransactionSplits.Where(s => transactionIds.Contains(s.TransactionId)).ToListAsync(ct));
        db.Transactions.RemoveRange(await db.Transactions.Where(t => t.OwnerId == ownerId).ToListAsync(ct));
        db.BudgetItems.RemoveRange(await db.BudgetItems.Where(i => categoryIds.Contains(i.BudgetCategoryId)).ToListAsync(ct));
        db.BudgetCategories.RemoveRange(await db.BudgetCategories.Where(c => monthIds.Contains(c.BudgetMonthId)).ToListAsync(ct));
        db.BudgetMonths.RemoveRange(await db.BudgetMonths.Where(m => m.OwnerId == ownerId).ToListAsync(ct));
        db.Jars.RemoveRange(await db.Jars.Where(j => j.OwnerId == ownerId).ToListAsync(ct));
        db.AccountPrivacies.RemoveRange(await db.AccountPrivacies.Where(p => accountIds.Contains(p.AccountId)).ToListAsync(ct));
        db.AccountHolders.RemoveRange(await db.AccountHolders.Where(h => accountIds.Contains(h.AccountId)).ToListAsync(ct));
        db.Accounts.RemoveRange(await db.Accounts.Where(a => a.OwnerId == ownerId).ToListAsync(ct));
        db.AllocationRules.RemoveRange(await db.AllocationRules.Where(r => profileIds.Contains(r.AllocationProfileId)).ToListAsync(ct));
        db.AllocationProfiles.RemoveRange(await db.AllocationProfiles.Where(p => p.OwnerId == ownerId).ToListAsync(ct));
        db.PersonLogins.RemoveRange(await db.PersonLogins.Where(p => memberIds.Contains(p.HouseholdMemberId)).ToListAsync(ct));
        db.HouseholdMembers.RemoveRange(await db.HouseholdMembers.Where(m => m.OwnerId == ownerId).ToListAsync(ct));
        db.HouseholdMemberships.RemoveRange(memberships);
        await db.SaveChangesAsync(ct);
        return displaced;
    }
}
