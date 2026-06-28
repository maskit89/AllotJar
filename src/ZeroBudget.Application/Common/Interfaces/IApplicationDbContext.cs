using Microsoft.EntityFrameworkCore;
using ZeroBudget.Domain.Entities;

namespace ZeroBudget.Application.Common.Interfaces;

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
    DbSet<Jar> Jars { get; }
    DbSet<HouseholdMember> HouseholdMembers { get; }
    DbSet<HouseholdMembership> HouseholdMemberships { get; }
    DbSet<AllocationProfile> AllocationProfiles { get; }
    DbSet<AllocationRule> AllocationRules { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
