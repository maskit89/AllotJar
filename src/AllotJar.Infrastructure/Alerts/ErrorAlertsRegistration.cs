using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AllotJar.Infrastructure.Alerts;

public static class ErrorAlertsRegistration
{
    /// <summary>
    /// Emails every Error-level log entry to <c>ErrorAlerts:Recipient</c> when one is set; with no
    /// recipient nothing is registered. The logger provider depends only on the queue (never on a
    /// logger), so adding it to the logging pipeline creates no cycle; the mailer resolves the
    /// email sender lazily, per send.
    /// </summary>
    public static IServiceCollection AddErrorAlerts(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(ErrorAlertSettings.SectionName);
        services.Configure<ErrorAlertSettings>(section);
        var settings = section.Get<ErrorAlertSettings>() ?? new ErrorAlertSettings();
        if (!settings.Enabled) return services;

        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<ErrorAlertQueue>();
        services.AddSingleton(sp => new ErrorAlertThrottle(
            sp.GetRequiredService<IOptions<ErrorAlertSettings>>().Value, sp.GetRequiredService<TimeProvider>()));
        services.AddSingleton<ILoggerProvider, ErrorAlertLoggerProvider>();
        services.AddHostedService<ErrorAlertMailer>();
        return services;
    }
}
