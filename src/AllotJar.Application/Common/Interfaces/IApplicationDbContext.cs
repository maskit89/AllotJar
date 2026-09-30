using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Abstraction over the persistence store, exposed to the Application layer so
/// handlers never depend on the concrete EF Core / SQL Server implementation
/// that lives in Infrastructure.
/// </summary>
public interface IApplicationDbContext
{
    DbSet<BudgetMonth> BudgetMonths { get; }
    DbSet<BudgetCategory> BudgetCategories { get; }
    DbSet<BudgetItem> BudgetItems { get; }
    DbSet<Transaction> Transactions { get; }
    DbSet<TransactionSplit> TransactionSplits { get; }
    DbSet<Account> Accounts { get; }
    DbSet<AccountHolder> AccountHolders { get; }
    DbSet<AccountPrivacy> AccountPrivacies { get; }
    DbSet<Jar> Jars { get; }
    DbSet<JarAllocation> JarAllocations { get; }
    DbSet<JarAllocationPosting> JarAllocationPostings { get; }
    DbSet<JarCycle> JarCycles { get; }
    DbSet<JarRevision> JarRevisions { get; }
    DbSet<JarArchivePeriod> JarArchivePeriods { get; }
    DbSet<HouseholdMember> HouseholdMembers { get; }
    DbSet<HouseholdMembership> HouseholdMemberships { get; }
    DbSet<AllocationProfile> AllocationProfiles { get; }
    DbSet<AllocationRule> AllocationRules { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Lets this context's next saves remove <paramref name="accountId"/> and the rows that move
    /// money in it although it is private to another login: the owner-side erase of an account
    /// nobody can reach (P59). Only <c>EraseUnreachableAccount</c> calls this, after proving
    /// that no login in the household can see the account.
    /// </summary>
    void AllowErasing(Guid accountId);

    /// <summary>
    /// Begins a serialised write on <paramref name="accountId"/>'s ledger (see <see cref="ILedgerWrite"/>).
    /// Read the account's position only after this returns; commit after SaveChanges.
    /// </summary>
    Task<ILedgerWrite?> BeginLedgerWriteAsync(Guid accountId, CancellationToken cancellationToken = default);

    /// <summary>
    /// One serialised write on several accounts' ledgers, locked in a fixed order (by id) so two
    /// writers touching the same accounts can't deadlock.
    /// </summary>
    Task<ILedgerWrite?> BeginLedgerWriteAsync(IEnumerable<Guid> accountIds, CancellationToken cancellationToken = default);
}
