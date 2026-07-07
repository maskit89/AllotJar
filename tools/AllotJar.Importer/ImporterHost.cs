using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Application;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Importer;

/// <summary>
/// Minimal composition root for the importer. It wires just enough of the app's
/// Application + persistence layers to send MediatR commands against the real database:
/// the EF Core context, the <see cref="IApplicationDbContext"/> abstraction, MediatR/
/// validators, and a mutable <see cref="ICurrentUser"/> so every command runs as the
/// household owner. It deliberately skips Identity, JWT and HTTP wiring (and their
/// fail-fast key checks) — the importer authenticates by impersonation, not a token.
/// </summary>
internal static class ImporterHost
{
    /// <summary>The dev database the app itself uses (auto-migrated on app startup).</summary>
    public const string DefaultConnection =
        @"Server=(localdb)\MSSQLLocalDB;Database=ZeroBudget;Trusted_Connection=True;MultipleActiveResultSets=true;TrustServerCertificate=True";

    public static ServiceProvider Build(string connectionString)
    {
        var services = new ServiceCollection();

        services.AddDbContext<ApplicationDbContext>(options =>
            options.UseSqlServer(connectionString,
                sql => sql.MigrationsAssembly(typeof(ApplicationDbContext).Assembly.FullName)));

        services.AddScoped<IApplicationDbContext>(sp => sp.GetRequiredService<ApplicationDbContext>());

        // One impersonated caller for the whole run, resolved from the owner's email.
        services.AddSingleton<ImporterCurrentUser>();
        services.AddScoped<ICurrentUser>(sp => sp.GetRequiredService<ImporterCurrentUser>());

        services.AddApplication();

        return services.BuildServiceProvider();
    }
}

/// <summary>
/// A settable <see cref="ICurrentUser"/>: the importer looks the household owner up by
/// email once, sets <see cref="UserId"/>, and every command thereafter runs as that user.
/// </summary>
internal sealed class ImporterCurrentUser : ICurrentUser
{
    public string? UserId { get; set; }
}
