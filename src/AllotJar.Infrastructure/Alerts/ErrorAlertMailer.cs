using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Email;

namespace AllotJar.Infrastructure.Alerts;

/// <summary>
/// Drains the <see cref="ErrorAlertQueue"/> and emails what the <see cref="ErrorAlertThrottle"/>
/// lets through. After the first error of an incident it waits a few seconds for the rest, so one
/// failing request is one email. The email sender is resolved per send from a scope (it is the
/// same provider the password-reset emails use), and sends run inside the queue's suppression so
/// a provider that fails and logs the failure does not alert about itself.
/// </summary>
public sealed class ErrorAlertMailer : BackgroundService
{
    private readonly ErrorAlertQueue _queue;
    private readonly ErrorAlertThrottle _throttle;
    private readonly ErrorAlertSettings _settings;
    private readonly EmailSettings _email;
    private readonly IHostEnvironment _environment;
    private readonly IServiceScopeFactory _scopes;
    private readonly TimeProvider _clock;
    private readonly ILogger<ErrorAlertMailer> _logger;

    public ErrorAlertMailer(
        ErrorAlertQueue queue,
        ErrorAlertThrottle throttle,
        IOptions<ErrorAlertSettings> settings,
        IOptions<EmailSettings> email,
        IHostEnvironment environment,
        IServiceScopeFactory scopes,
        TimeProvider clock,
        ILogger<ErrorAlertMailer> logger)
    {
        _queue = queue;
        _throttle = throttle;
        _settings = settings.Value;
        _email = email.Value;
        _environment = environment;
        _scopes = scopes;
        _clock = clock;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var reader = _queue.Reader;
        try
        {
            while (await reader.WaitToReadAsync(stoppingToken))
            {
                var batch = new List<ErrorEvent>();
                while (reader.TryRead(out var e)) batch.Add(e);

                // Give the rest of the incident time to arrive, then take whatever else is there.
                if (_settings.BatchWindow > TimeSpan.Zero)
                {
                    await Task.Delay(_settings.BatchWindow, _clock, stoppingToken);
                    while (reader.TryRead(out var e)) batch.Add(e);
                }

                await SendAsync(_throttle.Take(batch), stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down.
        }
    }

    private async Task SendAsync(AlertDecision decision, CancellationToken ct)
    {
        if (!decision.SendsEmail) return;
        using var _ = _queue.Suppress();
        try
        {
            var message = ErrorAlertEmail.Build(
                _settings.Recipient!, _environment.EnvironmentName, _email.AppBaseUrl, decision);
            using var scope = _scopes.CreateScope();
            var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();
            await sender.SendAsync(message, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Warning, not Error: this provider's own entries are filtered out of alerts, and the
            // guard above drops anything the sender logged, but an Error here would still be a
            // confusing read in the Event Log next to the error it failed to deliver.
            _logger.LogWarning(ex, "Error alert email could not be sent ({Count} error(s) were in it).",
                decision.Events.Count);
        }
    }
}
