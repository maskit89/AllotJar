using Microsoft.EntityFrameworkCore;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Boots one throwaway SQL Server database for the whole test collection and applies
/// the EF Core migrations to it exactly once. Tests share that migrated database and
/// stay isolated by using a unique OwnerId each (every query and command is
/// owner-scoped), so the migration cost is paid a single time.
///
/// Unlike the EF in-memory provider the unit suite runs on, this exercises the real
/// relational schema — including the BudgetItems.SavingsId → Jars.Id foreign key that
/// in-memory silently ignores.
/// </summary>
public sealed class SqlServerFixture : IAsyncLifetime
{
    // Falls back to LocalDB so the suite can be run on a developer's Windows box; CI
    // points INTEGRATION_TEST_CONNECTION at the mssql service container.
    private const string DefaultLocalDb =
        "Server=(localdb)\\MSSQLLocalDB;Database=AllotJar_IntegrationTests;Trusted_Connection=True;" +
        "MultipleActiveResultSets=true;TrustServerCertificate=True";

    public string ConnectionString { get; } =
        Environment.GetEnvironmentVariable("INTEGRATION_TEST_CONNECTION") ?? DefaultLocalDb;

    public DbContextOptions<ApplicationDbContext> Options { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        Options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseSqlServer(ConnectionString)
            .Options;

        // The mssql service container accepts TCP connections a little before it can
        // serve queries, so the first bootstrap can lose a race with the server coming
        // up. Retry the whole drop-and-migrate — a connection failure throws before any
        // schema change, so retrying is safe — until it succeeds or ~90s elapse (after
        // which the real error propagates).
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (true)
        {
            try
            {
                await using var db = new ApplicationDbContext(Options);
                await db.Database.EnsureDeletedAsync();  // one throwaway database
                await db.Database.MigrateAsync();        // migrations applied once
                return;
            }
            catch when (DateTime.UtcNow < deadline)
            {
                await Task.Delay(2000);
            }
        }
    }

    /// <summary>A fresh context on the shared, already-migrated database.</summary>
    public ApplicationDbContext CreateContext() => new(Options);

    public Task DisposeAsync() => Task.CompletedTask;
}

/// <summary>Binds <see cref="SqlServerFixture"/> to the integration-test collection.</summary>
[CollectionDefinition(nameof(SqlServerCollection))]
public sealed class SqlServerCollection : ICollectionFixture<SqlServerFixture>;
