using Microsoft.Extensions.Diagnostics.HealthChecks;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Services;

/// <summary>
/// Asks SQL Server whether it answers, for <c>/health/ready</c>. Separate from <c>/health</c>, which
/// the deploy polls as a liveness probe and which must not fail because the database is down.
/// </summary>
public sealed class DatabaseHealthCheck : IHealthCheck
{
    public const string Tag = "ready";

    private readonly ApplicationDbContext _db;

    public DatabaseHealthCheck(ApplicationDbContext db) => _db = db;

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        try
        {
            return await _db.Database.CanConnectAsync(ct)
                ? HealthCheckResult.Healthy("The database answers.")
                : HealthCheckResult.Unhealthy("The database does not answer.");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("The database does not answer.", ex);
        }
    }
}
