using System.Collections.Concurrent;
using AllotJar.Application.Common.Exceptions;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Takes turns at reading PDFs. One PDF is read at a time, because the server has one CPU and
/// 4 GB for production, staging and SQL Server, and a PDF can ask for a great deal of work. Each
/// person has at most one PDF in the queue or being read, so one person sending heavy PDFs over
/// and over can't keep everyone else waiting: whoever was already waiting goes next (the waiters
/// are served in the order they came). The queue is short and its waits are bounded, so the
/// uploads held in memory while they wait stay a few megabytes.
/// </summary>
public sealed class PdfReadSlots
{
    /// <summary>One PDF read at a time, plus this many waiting for their turn.</summary>
    public const int MaxWaiting = 3;

    public const string AlreadyReading = "Your other PDF is still being read. Try again when it has finished.";
    public const string Busy = "Another PDF is being read. Try again in a moment.";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ConcurrentDictionary<string, byte> _people = new(StringComparer.Ordinal);
    private readonly TimeSpan _wait;
    private int _inQueue;

    /// <param name="wait">How long a request waits for its turn: a little longer than one read may take.</param>
    public PdfReadSlots(TimeSpan wait)
    {
        _wait = wait;
    }

    /// <summary>
    /// Runs <paramref name="read"/> when it is this person's turn. Refuses at once when the person
    /// already has a PDF waiting or being read, or when the queue is full; refuses after the wait
    /// when the turn did not come in time.
    /// </summary>
    public async Task<T> RunAsync<T>(string person, Func<T> read, CancellationToken cancellationToken)
    {
        if (!_people.TryAdd(person, 0))
        {
            throw new StatementParseException(AlreadyReading);
        }
        try
        {
            if (Interlocked.Increment(ref _inQueue) > MaxWaiting + 1)
            {
                throw new StatementParseException(Busy);
            }
            try
            {
                if (!await _gate.WaitAsync(_wait, cancellationToken).ConfigureAwait(false))
                {
                    throw new StatementParseException(Busy);
                }
                try
                {
                    return read();
                }
                finally
                {
                    _gate.Release();
                }
            }
            finally
            {
                Interlocked.Decrement(ref _inQueue);
            }
        }
        finally
        {
            _people.TryRemove(person, out _);
        }
    }
}
