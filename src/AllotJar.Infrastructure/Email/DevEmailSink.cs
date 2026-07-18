using System.Collections.Concurrent;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// Bounded in-memory capture of emails "sent" by <see cref="LoggingEmailSender"/>, so tests can
/// read what a real recipient would have received (the journey e2e suite fetches the reset link
/// from here via the Development-only /api/dev/emails endpoint; the HTTP integration tests resolve
/// this singleton directly). Only ever populated by the logging fallback — with a real provider
/// configured nothing is captured.
/// </summary>
public class DevEmailSink
{
    private const int Capacity = 50;
    private readonly ConcurrentQueue<EmailMessage> _messages = new();

    public void Record(EmailMessage message)
    {
        _messages.Enqueue(message);
        while (_messages.Count > Capacity && _messages.TryDequeue(out _))
        {
        }
    }

    /// <summary>Captured messages for a recipient, most recent first.</summary>
    public IReadOnlyList<EmailMessage> ForRecipient(string toEmail) =>
        _messages
            .Where(m => string.Equals(m.ToEmail, toEmail, StringComparison.OrdinalIgnoreCase))
            .Reverse()
            .ToList();
}
