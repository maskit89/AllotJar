using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Common;
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
    DbSet<PersonLogin> PersonLogins { get; }
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
    /// An edit form's save of <paramref name="record"/> (D11): refuses it (<see cref="Exceptions.EditConflictException"/>)
    /// when the tracked record is no longer the <paramref name="version"/> the form loaded, and makes
    /// the record's version move with this save even when only the rows under it change (a profile's
    /// rules, an income's jar split), so the next stale form is refused too. Call it on the tracked
    /// entity that is actually saved. A null version (a client from before the deploy) is no check.
    /// </summary>
    void ExpectVersion(IVersioned record, string? version);

    /// <summary>
    /// Makes <paramref name="record"/>'s version move with this save, as <see cref="ExpectVersion"/>
    /// does, without checking it: for a one-click action that may rewrite only the rows under a
    /// transaction (its slices or jar postings), so an edit form loaded before it is refused
    /// (#308 review P2-1). Only the user's own transaction commands call it, never a settle,
    /// backfill or allocation run, so a page load never makes an open form stale.
    /// </summary>
    void TouchVersion(IVersioned record);

    /// <summary>
    /// Forgets every entity this context tracks, unsaved changes included, so the next read comes
    /// from the database. For a read that wrote on the side (a cycle settled on a page load) and
    /// lost to a concurrent write: what it meant to save is dropped rather than tried again.
    /// </summary>
    void DiscardChanges();

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
