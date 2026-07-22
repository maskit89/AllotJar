using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Periodically re-attempts every pending-FX row (<c>Transaction.FxPending</c>) across all
/// owners, so an unresolved rate reconciles on its own once the provider recovers — not only
/// when that user happens to run another import. Each pass runs in a fresh DI scope; failures
/// are logged and retried on the next tick, never crashing the host. The first pass runs
/// shortly after startup (an app-pool recycle is itself a natural retry moment).
/// </summary>
public sealed class FxReconciliationService : BackgroundService
{
    // A fixed cadence, deliberately conservative: rates for a past date are immutable once the
    // provider has them, so hourly polling buys nothing over a few passes a day.
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<FxReconciliationService> _logger;

    public FxReconciliationService(IServiceScopeFactory scopeFactory, ILogger<FxReconciliationService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                await RunOnePassAsync(stoppingToken);
                await Task.Delay(Interval, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Host shutdown — normal.
        }
    }

    private async Task RunOnePassAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<IApplicationDbContext>();
            var provider = scope.ServiceProvider.GetRequiredService<IExchangeRateProvider>();

            var reconciled = await FxRateResolver.ReconcileAllPendingAsync(db, provider, cancellationToken);
            if (reconciled > 0)
            {
                _logger.LogInformation("FX reconciliation resolved {Count} pending row(s).", reconciled);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Provider outage, transient DB error — log and let the next tick retry.
            _logger.LogWarning(ex, "FX reconciliation pass failed; will retry on the next interval.");
        }
    }
}
