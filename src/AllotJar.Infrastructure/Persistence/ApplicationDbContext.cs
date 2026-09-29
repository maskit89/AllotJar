using System.Reflection;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage;
using AllotJar.Application.Accounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
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

    private sealed class LedgerWrite(IDbContextTransaction transaction) : ILedgerWrite
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
        using var held = HoldJarAccountsAsync(CancellationToken.None).GetAwaiter().GetResult();
        var saved = base.SaveChanges(acceptAllChangesOnSuccess);
        held?.Commit();
        return saved;
    }

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        await GuardPrivateAccountsAsync(cancellationToken);
        await using var held = await HoldJarAccountsAsync(cancellationToken);
        var saved = await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
        if (held is not null)
        {
            await held.CommitAsync(cancellationToken);
        }
        return saved;
    }

    /// <summary>
    /// Rules 33/34 when two logins act at once (P55): an account never ends up both private and
    /// behind a jar. The handlers check this before saving, but one login making an account private
    /// while another puts a jar on it would each pass its own check. So a save that puts a jar on an
    /// account (new, or moved there) or makes an account private first locks that account's row until
    /// it commits — the other writer waits — and checks again against what is committed plus this
    /// save. Returns the transaction it opened, if any, for the caller to commit after the save.
    /// </summary>
    private async Task<IDbContextTransaction?> HoldJarAccountsAsync(CancellationToken cancellationToken)
    {
        var entries = ChangeTracker.Entries().ToList();
        var contested = new SortedSet<Guid>();
        foreach (var entry in entries)
        {
            if (entry.Entity is Jar jar
                && (entry.State == EntityState.Added
                    || (entry.State == EntityState.Modified && entry.Property(nameof(Jar.FundingAccountId)).IsModified)))
            {
                contested.Add(jar.FundingAccountId);
            }
            else if (entry.Entity is AccountPrivacy privacy && entry.State == EntityState.Added)
            {
                contested.Add(privacy.AccountId);
            }
        }
        if (contested.Count == 0)
        {
            return null;
        }

        IDbContextTransaction? opened = null;
        try
        {
            if (Database.IsRelational())
            {
                if (Database.CurrentTransaction is null)
                {
                    opened = await Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, cancellationToken);
                }
                foreach (var accountId in contested)
                {
                    await Database.ExecuteSqlInterpolatedAsync(
                        $"SELECT [Id] FROM [Accounts] WITH (UPDLOCK, HOLDLOCK) WHERE [Id] = {accountId}", cancellationToken);
                }
            }
            await RecheckJarAccountsAsync(entries, contested.ToList(), cancellationToken);
            return opened;
        }
        catch
        {
            if (opened is not null)
            {
                await opened.DisposeAsync();
            }
            throw;
        }
    }

    private async Task RecheckJarAccountsAsync(List<EntityEntry> entries, List<Guid> ids, CancellationToken cancellationToken)
    {
        // Who each account ends up private to: the committed rows, then this save's changes.
        var privateTo = await AccountPrivacies.AsNoTracking()
            .Where(p => ids.Contains(p.AccountId))
            .ToDictionaryAsync(p => p.AccountId, p => p.UserId, cancellationToken);
        var madePrivate = new HashSet<Guid>();
        foreach (var entry in entries.Where(e => e.Entity is AccountPrivacy && e.State == EntityState.Deleted))
        {
            privateTo.Remove(((AccountPrivacy)entry.Entity).AccountId);
        }
        foreach (var entry in entries.Where(e => e.Entity is AccountPrivacy
                                                 && e.State is EntityState.Added or EntityState.Modified or EntityState.Unchanged))
        {
            var privacy = (AccountPrivacy)entry.Entity;
            privateTo[privacy.AccountId] = privacy.UserId;
            if (entry.State == EntityState.Added)
            {
                madePrivate.Add(privacy.AccountId);
            }
        }
        if (!ids.Any(privateTo.ContainsKey))
        {
            return;
        }

        // Which jar each account ends up behind: the committed jars not moved away or deleted in
        // this save, then the jars this save adds or moves there.
        var tracked = entries.Where(e => e.Entity is Jar).ToDictionary(e => ((Jar)e.Entity).Id);
        var jarOn = new Dictionary<Guid, string>();
        var committed = await Jars.AsNoTracking()
            .Where(j => ids.Contains(j.FundingAccountId))
            .Select(j => new { j.Id, j.FundingAccountId, j.Name })
            .ToListAsync(cancellationToken);
        foreach (var jar in committed.Where(j => !tracked.ContainsKey(j.Id)))
        {
            jarOn.TryAdd(jar.FundingAccountId, jar.Name);
        }
        foreach (var entry in tracked.Values.Where(e => e.State != EntityState.Deleted))
        {
            var jar = (Jar)entry.Entity;
            if (ids.Contains(jar.FundingAccountId))
            {
                jarOn.TryAdd(jar.FundingAccountId, jar.Name);
            }
        }
        var heldJarMoney = (await JarAllocations.AsNoTracking()
                .Where(a => ids.Contains(a.AccountId))
                .Select(a => a.AccountId)
                .Distinct()
                .ToListAsync(cancellationToken))
            .ToHashSet();

        foreach (var accountId in ids)
        {
            if (!privateTo.TryGetValue(accountId, out var login)
                || (!jarOn.ContainsKey(accountId) && !heldJarMoney.Contains(accountId)))
            {
                continue;
            }
            var name = await Accounts.IgnoreQueryFilters().AsNoTracking()
                .Where(a => a.Id == accountId)
                .Select(a => a.Name)
                .FirstOrDefaultAsync(cancellationToken) ?? string.Empty;
            if (madePrivate.Contains(accountId))
            {
                // The account got a jar while it was being made private: it stays shared (rule 33).
                throw JarAccounts.Validation("IsPrivate", jarOn.TryGetValue(accountId, out var jarName)
                    ? AccountSharing.HoldsJarReason(name, jarName)
                    : AccountSharing.HeldJarMoneyReason(name));
            }
            // The account went private while the jar was being put on it: its holder is warned as
            // usual (rule 34); anyone else can no longer see the account.
            throw login == ViewerId ? JarAccounts.PrivateAccountWarning(name) : PrivateAccountWrite();
        }
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
            // Only the login a privacy row names may create, change or remove it (P59: no one can
            // hand it to another login, whoever is linked to the account's holder).
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
