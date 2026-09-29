using System.Reflection;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// The single EF Core context. It inherits the full ASP.NET Core Identity schema
/// (AspNetUsers, AspNetRoles, ...) via <see cref="IdentityDbContext{TUser}"/> and
/// adds the budgeting tables. It also implements <see cref="IApplicationDbContext"/>
/// so the Application layer can depend on the abstraction, not this concrete type.
/// <para>
/// Private accounts (rules 31–33) are enforced here, once, for every handler: when the context
/// serves a signed-in login, query filters hide the accounts private to another login and the
/// transactions only those accounts can see, and <see cref="SaveChangesAsync(bool, CancellationToken)"/>
/// refuses any write that would touch them. A context with no signed-in login (background work,
/// tests, design time) sees everything.
/// </para>
/// </summary>
public class ApplicationDbContext : IdentityDbContext<ApplicationUser>, IApplicationDbContext
{
    private readonly ICurrentUser? _currentUser;

    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
        : base(options)
    {
    }

    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options, ICurrentUser currentUser)
        : base(options)
    {
        _currentUser = currentUser;
    }

    /// <summary>
    /// The login whose view this context reads: accounts private to anyone else are filtered out.
    /// Null when no login is signed in, which filters nothing.
    /// </summary>
    public string? ViewerId => _currentUser?.UserId;

    public DbSet<BudgetMonth> BudgetMonths => Set<BudgetMonth>();
    public DbSet<BudgetCategory> BudgetCategories => Set<BudgetCategory>();
    public DbSet<BudgetItem> BudgetItems => Set<BudgetItem>();
    public DbSet<Transaction> Transactions => Set<Transaction>();
    public DbSet<TransactionSplit> TransactionSplits => Set<TransactionSplit>();
    public DbSet<Account> Accounts => Set<Account>();
    public DbSet<AccountHolder> AccountHolders => Set<AccountHolder>();
    public DbSet<AccountPrivacy> AccountPrivacies => Set<AccountPrivacy>();
    public DbSet<Jar> Jars => Set<Jar>();
    public DbSet<JarAllocation> JarAllocations => Set<JarAllocation>();
    public DbSet<JarAllocationPosting> JarAllocationPostings => Set<JarAllocationPosting>();
    public DbSet<JarCycle> JarCycles => Set<JarCycle>();
    public DbSet<JarRevision> JarRevisions => Set<JarRevision>();
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

        // Private accounts (P53): another login's private account is not there at all.
        builder.Entity<Account>().HasQueryFilter(a =>
            ViewerId == null
            || !AccountPrivacies.Any(p => p.AccountId == a.Id && p.UserId != ViewerId));

        // A transaction is visible when any account it moves money in is visible (a transfer
        // with a shared account shows on that account, P57), when it has no account, or when its
        // holder put it on a household budget line (P56). Only money that stays entirely inside
        // another login's private accounts, off the budget, is hidden.
        builder.Entity<Transaction>().HasQueryFilter(t =>
            ViewerId == null
            || !AccountPrivacies.Any(p => p.AccountId == t.AccountId && p.UserId != ViewerId)
            || (t.TransferAccountId != null
                && !AccountPrivacies.Any(p => p.AccountId == t.TransferAccountId && p.UserId != ViewerId))
            || t.BudgetItemId != null
            || t.Splits.Any(s => s.BudgetItemId != null));
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        GuardPrivateAccountsAsync(CancellationToken.None).GetAwaiter().GetResult();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        await GuardPrivateAccountsAsync(cancellationToken);
        return await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }

    // What the login that cannot see one side of a transfer may still record: the bank leg of the
    // side it can see (P57), so importing a joint statement can confirm a receipt from a private account.
    private static readonly HashSet<string> SourceLegFields = new(StringComparer.Ordinal)
    {
        nameof(Transaction.DepartedOn), nameof(Transaction.BankReference), nameof(Transaction.Date),
    };
    private static readonly HashSet<string> ReceiptLegFields = new(StringComparer.Ordinal)
    {
        nameof(Transaction.ReceivedOn), nameof(Transaction.ReceiptBankReference),
    };

    /// <summary>
    /// The write side of the query filters: a login can neither change nor create anything in an
    /// account private to another login — not its row, holders or privacy, not a transaction or jar
    /// entry in it — even with the id in hand. The one exception is the visible side's bank leg of
    /// a transfer between a shared and a private account.
    /// </summary>
    private async Task GuardPrivateAccountsAsync(CancellationToken cancellationToken)
    {
        var viewer = ViewerId;
        if (viewer is null)
        {
            return;
        }

        var entries = ChangeTracker.Entries()
            .Where(e => e.State is EntityState.Added or EntityState.Modified or EntityState.Deleted)
            .ToList();
        if (entries.Count == 0)
        {
            return;
        }

        foreach (var privacy in entries.Where(e => e.Entity is AccountPrivacy))
        {
            // Only the login a privacy row names may create, change or remove it.
            var owner = privacy.State == EntityState.Added
                ? ((AccountPrivacy)privacy.Entity).UserId
                : (string?)privacy.OriginalValues[nameof(AccountPrivacy.UserId)];
            var now = ((AccountPrivacy)privacy.Entity).UserId;
            if (owner != viewer || (privacy.State == EntityState.Modified && now != viewer))
            {
                throw PrivateAccountWrite();
            }
        }

        // A slice moves money in its transaction's accounts, so a split edit is checked against them.
        var slices = await SliceAccountsAsync(entries, cancellationToken);
        IEnumerable<Guid> Touches(EntityEntry entry) => entry.Entity is TransactionSplit
            ? Ids(entry, nameof(TransactionSplit.TransactionId)).SelectMany(id => slices.GetValueOrDefault(id, []))
            : AccountIds(entry);

        var touched = new HashSet<Guid>();
        foreach (var entry in entries)
        {
            foreach (var id in Touches(entry))
            {
                touched.Add(id);
            }
        }
        if (touched.Count == 0)
        {
            return;
        }

        var hidden = (await AccountPrivacies.AsNoTracking()
                .Where(p => touched.Contains(p.AccountId) && p.UserId != viewer)
                .Select(p => p.AccountId)
                .ToListAsync(cancellationToken))
            .ToHashSet();
        if (hidden.Count == 0)
        {
            return;
        }

        foreach (var entry in entries)
        {
            if (!Touches(entry).Any(hidden.Contains))
            {
                continue;
            }
            if (entry.Entity is Transaction && entry.State == EntityState.Modified && IsVisibleLegOnly(entry, hidden))
            {
                continue;
            }
            throw PrivateAccountWrite();
        }
    }

    private async Task<Dictionary<Guid, Guid[]>> SliceAccountsAsync(List<EntityEntry> entries, CancellationToken cancellationToken)
    {
        var parents = entries.Where(e => e.Entity is TransactionSplit)
            .SelectMany(e => Ids(e, nameof(TransactionSplit.TransactionId)))
            .ToHashSet();
        var accounts = new Dictionary<Guid, Guid[]>();
        if (parents.Count == 0)
        {
            return accounts;
        }
        foreach (var tracked in ChangeTracker.Entries<Transaction>().Where(t => parents.Contains(t.Entity.Id)))
        {
            accounts[tracked.Entity.Id] = AccountIds(tracked).ToArray();
        }
        var unloaded = parents.Where(id => !accounts.ContainsKey(id)).ToList();
        if (unloaded.Count > 0)
        {
            var rows = await Transactions.IgnoreQueryFilters().AsNoTracking()
                .Where(t => unloaded.Contains(t.Id))
                .Select(t => new { t.Id, t.AccountId, t.TransferAccountId })
                .ToListAsync(cancellationToken);
            foreach (var row in rows)
            {
                accounts[row.Id] = new[] { row.AccountId, row.TransferAccountId }.OfType<Guid>().ToArray();
            }
        }
        return accounts;
    }

    private static bool IsVisibleLegOnly(EntityEntry entry, HashSet<Guid> hidden)
    {
        var sourceHidden = Ids(entry, nameof(Transaction.AccountId)).Any(hidden.Contains);
        var receiptHidden = Ids(entry, nameof(Transaction.TransferAccountId)).Any(hidden.Contains);
        if (sourceHidden == receiptHidden)
        {
            return false;
        }
        var allowed = sourceHidden ? ReceiptLegFields : SourceLegFields;
        return entry.Properties.Where(p => p.IsModified).All(p => allowed.Contains(p.Metadata.Name));
    }

    // Every account an entry reads or writes money in, before and after the change.
    private static IEnumerable<Guid> AccountIds(EntityEntry entry) => entry.Entity switch
    {
        Account => Ids(entry, nameof(Account.Id)),
        AccountHolder => Ids(entry, nameof(AccountHolder.AccountId)),
        Transaction => Ids(entry, nameof(Transaction.AccountId)).Concat(Ids(entry, nameof(Transaction.TransferAccountId))),
        JarAllocation => Ids(entry, nameof(JarAllocation.AccountId)),
        Jar => Ids(entry, nameof(Jar.FundingAccountId)),
        _ => Enumerable.Empty<Guid>(),
    };

    private static IEnumerable<Guid> Ids(EntityEntry entry, string property)
    {
        var current = entry.State == EntityState.Deleted ? null : entry.CurrentValues[property];
        var original = entry.State == EntityState.Added ? null : entry.OriginalValues[property];
        if (current is Guid c)
        {
            yield return c;
        }
        if (original is Guid o)
        {
            yield return o;
        }
    }

    private static ForbiddenAccessException PrivateAccountWrite() =>
        new("This belongs to a private account. Only the login it is private to can change it.");
}
