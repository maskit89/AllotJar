using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// Boots the REAL API (<c>src/AllotJar.Api</c>, via its <c>public partial class Program</c>) in-process
/// against a dedicated throwaway SQL Server database, so tests exercise the complete HTTP pipeline:
/// routing → rate limiter → JWT authentication → authorization → household resolution → MediatR
/// role gate → handler → real relational schema. This is the only layer that can observe a
/// forgotten <c>[Authorize]</c>, a role-403, or a real 429 — the unit suite runs below the pipeline
/// and the journey e2e suite runs above it with its own live server.
///
/// Each factory instance gets its OWN database name so migrations (applied by the API on startup)
/// never race another suite's fixture: the classic FK tests use <c>AllotJar_IntegrationTests</c>,
/// the sweep/role-matrix collection uses <c>AllotJar_HttpSweep</c>, and the rate-limit tests use
/// <c>AllotJar_HttpRateLimit</c>. The server comes from <c>INTEGRATION_TEST_CONNECTION</c> (the CI
/// mssql service container) with a LocalDB fallback for a developer's Windows box — the same
/// resolution the rest of this project uses.
/// </summary>
internal sealed class ApiFactory : WebApplicationFactory<Program>
{
    /// <summary>HS256 needs >= 32 bytes; only ever signs tokens for a throwaway test DB — not a secret.</summary>
    public const string TestJwtKey = "http-harness-signing-key-not-a-secret-0123456789";

    private readonly IReadOnlyDictionary<string, string?>? _extraSettings;

    public string ConnectionString { get; }

    public ApiFactory(string databaseName, IReadOnlyDictionary<string, string?>? extraSettings = null)
    {
        ConnectionString = BuildConnectionString(databaseName);
        _extraSettings = extraSettings;
    }

    /// <summary>The suite's shared connection resolution with the database name swapped out.</summary>
    public static string BuildConnectionString(string databaseName)
    {
        var baseConnection = Environment.GetEnvironmentVariable("INTEGRATION_TEST_CONNECTION")
            ?? "Server=(localdb)\\MSSQLLocalDB;Database=AllotJar_IntegrationTests;Trusted_Connection=True;" +
               "MultipleActiveResultSets=true;TrustServerCertificate=True";
        return new SqlConnectionStringBuilder(baseConnection) { InitialCatalog = databaseName }.ConnectionString;
    }

    /// <summary>
    /// Drops this factory's database (fresh schema + data every run), retrying like
    /// <see cref="SqlServerFixture"/> because the CI mssql container accepts TCP connections a
    /// little before it can serve queries. Call BEFORE the host first starts — startup migrates.
    /// </summary>
    public async Task ResetDatabaseAsync()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseSqlServer(ConnectionString)
            .Options;

        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (true)
        {
            try
            {
                await using var db = new ApplicationDbContext(options);
                await db.Database.EnsureDeletedAsync();
                return;
            }
            catch when (DateTime.UtcNow < deadline)
            {
                await Task.Delay(2000);
            }
        }
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Development satisfies the environment checks Program has (non-Secure dev cookies, Swagger);
        // there is no test-only branch in the product code — the pipeline under test is the real one.
        builder.UseEnvironment("Development");

        // IMPORTANT: UseSetting, NOT ConfigureAppConfiguration. Program.cs reads several values
        // EAGERLY while its top-level statements run (the connection string and Jwt key inside
        // AddInfrastructure, RateLimiting:AuthPermitLimit for the limiter closure). With the
        // minimal hosting model, ConfigureAppConfiguration callbacks are appended to the app's
        // configuration only at Build() time — after those eager reads — so on a dev box the API
        // would boot against the real appsettings/user-secrets values (the developer's ZeroBudget
        // database and secret Jwt key) and sign tokens with a different key than it validates.
        // UseSetting flows through the factory into the initial host configuration, which is both
        // present from WebApplication.CreateBuilder onward and highest-precedence.
        builder.UseSetting("ConnectionStrings:DefaultConnection", ConnectionString);
        // Satisfies the >= 32-byte fail-fast in AddInfrastructure without user-secrets.
        builder.UseSetting("Jwt:Key", TestJwtKey);

        if (_extraSettings is not null)
        {
            foreach (var (key, value) in _extraSettings)
            {
                builder.UseSetting(key, value);
            }
        }

        // Keep the test output readable: the API's request/EF logging is noise here.
        builder.ConfigureLogging(logging => logging.ClearProviders());
    }
}
