using System.Reflection;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// The single EF Core context. It inherits the full ASP.NET Core Identity schema
/// (AspNetUsers, AspNetRoles, ...) via <see cref="IdentityDbContext{TUser}"/> and
/// adds the budgeting tables. It also implements <see cref="IApplicationDbContext"/>
/// so the Application layer can depend on the abstraction, not this concrete type.
/// </summary>
public class ApplicationDbContext : IdentityDbContext<ApplicationUser>, IApplicationDbContext
{
    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
        : base(options)
    {
    }

    public DbSet<BudgetMonth> BudgetMonths => Set<BudgetMonth>();
    public DbSet<BudgetCategory> BudgetCategories => Set<BudgetCategory>();
    public DbSet<BudgetItem> BudgetItems => Set<BudgetItem>();
    public DbSet<Transaction> Transactions => Set<Transaction>();
    public DbSet<TransactionSplit> TransactionSplits => Set<TransactionSplit>();
    public DbSet<Account> Accounts => Set<Account>();
    public DbSet<Jar> Jars => Set<Jar>();
    public DbSet<JarAllocation> JarAllocations => Set<JarAllocation>();
    public DbSet<JarAllocationPosting> JarAllocationPostings => Set<JarAllocationPosting>();
    public DbSet<HouseholdMember> HouseholdMembers => Set<HouseholdMember>();
    public DbSet<HouseholdMembership> HouseholdMemberships => Set<HouseholdMembership>();
    public DbSet<AllocationProfile> AllocationProfiles => Set<AllocationProfile>();
    public DbSet<AllocationRule> AllocationRules => Set<AllocationRule>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    /// <inheritdoc />
    public async Task<ILedgerWrite?> BeginLedgerWriteAsync(Guid accountId, CancellationToken cancellationToken = default)
    {
        if (!Database.IsRelational())
        {
            return null;
        }
        var transaction = await Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, cancellationToken);
        // Hold the account row until commit: a second writer on the same account waits here and
        // then validates against the committed money, never against a stale read.
        await Database.ExecuteSqlInterpolatedAsync(
            $"SELECT [Id] FROM [Accounts] WITH (UPDLOCK, HOLDLOCK) WHERE [Id] = {accountId}", cancellationToken);
        return new LedgerWrite(transaction);
    }

    private sealed class LedgerWrite(Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction) : ILedgerWrite
    {
        public Task CommitAsync(CancellationToken cancellationToken) => transaction.CommitAsync(cancellationToken);
        public ValueTask DisposeAsync() => transaction.DisposeAsync();
    }

    protected override void OnModelCreating(ModelBuilder builder)
    {
        // Identity tables first.
        base.OnModelCreating(builder);

        // Then all IEntityTypeConfiguration<T> definitions in this assembly.
        builder.ApplyConfigurationsFromAssembly(Assembly.GetExecutingAssembly());
    }
}
