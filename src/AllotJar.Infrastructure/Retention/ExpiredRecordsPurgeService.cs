using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace AllotJar.Infrastructure.Retention;

/// <summary>
/// Runs <see cref="ExpiredRecordsPurge"/> a few minutes after the API starts and then once a day.
/// The app (and this service) starts on the API's first request and stops when IIS idles the
/// worker: AlwaysRunning restarts the process but does not boot the app. On production the
/// health-ping task (Register-HealthPingTask.ps1, every 5 minutes) keeps it up, so the daily run
/// keeps going; staging has no ping, so its purge runs only while requests keep it awake. A
/// recycle or deploy starts the clock again with a run soon after. A failed run is logged as an
/// error (which emails an alert when those are on) and the next day's run tries again.
/// </summary>
public sealed class ExpiredRecordsPurgeService : BackgroundService
{
    /// <summary>The wait after start-up: lets the app warm up and keeps short-lived test hosts out of
    /// the way.</summary>
    public static readonly TimeSpan StartDelay = TimeSpan.FromMinutes(5);

    public static readonly TimeSpan Interval = TimeSpan.FromDays(1);

    private readonly IServiceScopeFactory _scopes;
    private readonly TimeProvider _clock;
    private readonly ILogger<ExpiredRecordsPurgeService> _logger;

    public ExpiredRecordsPurgeService(
        IServiceScopeFactory scopes, TimeProvider clock, ILogger<ExpiredRecordsPurgeService> logger)
    {
        _scopes = scopes;
        _clock = clock;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartDelay, _clock, stoppingToken);
            using var timer = new PeriodicTimer(Interval, _clock);
            do
            {
                await RunOnceAsync(stoppingToken);
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down.
        }
    }

    /// <summary>One purge in its own scope. Never throws except on shutdown.</summary>
    public async Task RunOnceAsync(CancellationToken stoppingToken)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            var purge = scope.ServiceProvider.GetRequiredService<ExpiredRecordsPurge>();
            var result = await purge.RunAsync(_clock.GetUtcNow().UtcDateTime, stoppingToken);
            _logger.LogInformation(
                "Retention purge deleted {RefreshTokens} expired sign-in tokens and {Invitations} expired invitations.",
                result.RefreshTokens, result.Invitations);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Retention purge failed; it runs again in {Interval}.", Interval);
        }
    }
}
