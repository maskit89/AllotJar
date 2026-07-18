using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// Fallback sender when no provider API key is configured: logs the send and captures the message
/// in <see cref="DevEmailSink"/>. Bodies (which carry the reset link/token) are only logged when
/// Email:LogBodies is on — a Development convenience that must stay off in production, where an
/// unconfigured provider should be loud in the logs but never leak tokens into them.
/// </summary>
public class LoggingEmailSender : IEmailSender
{
    private readonly DevEmailSink _sink;
    private readonly EmailSettings _settings;
    private readonly ILogger<LoggingEmailSender> _logger;

    public LoggingEmailSender(DevEmailSink sink, IOptions<EmailSettings> settings, ILogger<LoggingEmailSender> logger)
    {
        _sink = sink;
        _settings = settings.Value;
        _logger = logger;
    }

    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        _sink.Record(message);
        if (_settings.LogBodies)
        {
            _logger.LogInformation(
                "Email (not sent — no provider configured) to {To}: {Subject}\n{Body}",
                message.ToEmail, message.Subject, message.TextBody);
        }
        else
        {
            // Name the actual reason: a misconfigured provider is easy to mistake for "no email
            // set up yet", and password reset silently not sending is the failure that hurts.
            var reason = _settings.DescribeMisconfiguration() ?? "outbound email is not configured";
            _logger.LogWarning(
                "Email to {To} ({Subject}) was NOT sent: {Reason}.",
                message.ToEmail, message.Subject, reason);
        }

        return Task.CompletedTask;
    }
}
