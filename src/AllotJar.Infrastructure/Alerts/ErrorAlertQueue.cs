using System.Threading.Channels;

namespace AllotJar.Infrastructure.Alerts;

/// <summary>
/// The hand-off between the logger (any thread, must never block or throw) and the mailer. Also
/// carries the re-entrancy guard: while the mailer is sending, anything the email provider logs
/// is dropped here, so a failing provider cannot alert about itself for ever.
/// </summary>
public sealed class ErrorAlertQueue
{
    /// <summary>A flood beyond this is dropped unseen; the throttle would have suppressed it anyway.</summary>
    public const int Capacity = 200;

    private static readonly AsyncLocal<bool> Suppressed = new();

    private readonly Channel<ErrorEvent> _channel = Channel.CreateBounded<ErrorEvent>(
        new BoundedChannelOptions(Capacity)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
        });

    public ChannelReader<ErrorEvent> Reader => _channel.Reader;

    public bool IsSuppressed => Suppressed.Value;

    /// <summary>Queues an event unless the current flow is the mailer's own send.</summary>
    public bool TryEnqueue(ErrorEvent e) => !Suppressed.Value && _channel.Writer.TryWrite(e);

    /// <summary>Marks the current async flow as the mailer's: its log entries are not alerts.</summary>
    public IDisposable Suppress()
    {
        Suppressed.Value = true;
        return new Restore();
    }

    private sealed class Restore : IDisposable
    {
        public void Dispose() => Suppressed.Value = false;
    }
}
