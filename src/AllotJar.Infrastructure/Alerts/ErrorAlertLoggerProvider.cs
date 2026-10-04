using Microsoft.Extensions.Logging;

namespace AllotJar.Infrastructure.Alerts;

/// <summary>
/// A logging provider that forwards Error and Critical entries to the <see cref="ErrorAlertQueue"/>.
/// It is one more sink beside the console and Event Log providers, so nothing about what is logged
/// changes; it only adds an email. Registered only when a recipient is configured.
/// </summary>
public sealed class ErrorAlertLoggerProvider : ILoggerProvider
{
    private readonly ErrorAlertQueue _queue;
    private readonly TimeProvider _clock;

    public ErrorAlertLoggerProvider(ErrorAlertQueue queue, TimeProvider clock)
    {
        _queue = queue;
        _clock = clock;
    }

    public ILogger CreateLogger(string categoryName) => new ErrorAlertLogger(categoryName, _queue, _clock);

    public void Dispose() { }

    private sealed class ErrorAlertLogger : ILogger
    {
        private readonly string _category;
        private readonly ErrorAlertQueue _queue;
        private readonly TimeProvider _clock;

        public ErrorAlertLogger(string category, ErrorAlertQueue queue, TimeProvider clock)
        {
            _category = category;
            _queue = queue;
            _clock = clock;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) =>
            logLevel >= LogLevel.Error && logLevel != LogLevel.None
            // The alerting code's own entries are never alerts (its send failures are Warnings
            // anyway, and the guard below covers the provider's); this keeps it so by category too.
            && !_category.StartsWith("AllotJar.Infrastructure.Alerts", StringComparison.Ordinal);

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel) || _queue.IsSuppressed) return;
            // A visitor who closed the tab mid-request surfaces as an OperationCanceledException
            // through the catch-all middleware. That is not an error of the app's; HttpClient's
            // timeouts (a TaskCanceledException wrapping a TimeoutException) still are.
            if (exception is OperationCanceledException && exception.InnerException is not TimeoutException) return;
            try
            {
                _queue.TryEnqueue(ErrorEventFactory.Create(
                    _clock.GetUtcNow(), logLevel, _category, state, exception, formatter(state, exception)));
            }
            catch
            {
                // A logger that throws takes the request down with it; an alert is never worth that.
            }
        }
    }
}

/// <summary>Builds the captured event from what the logging call carried.</summary>
public static class ErrorEventFactory
{
    /// <summary>Stack traces longer than this are cut; the top frames are the useful ones.</summary>
    public const int MaxExceptionChars = 3000;

    public static ErrorEvent Create<TState>(
        DateTimeOffset at, LogLevel level, string category, TState state, Exception? exception, string message)
    {
        string? template = null;
        if (state is IReadOnlyList<KeyValuePair<string, object?>> values)
        {
            foreach (var pair in values)
            {
                if (pair.Key == "{OriginalFormat}")
                {
                    template = pair.Value?.ToString();
                    break;
                }
            }
        }

        string? exceptionType = null;
        string? detail = null;
        string? origin = null;
        if (exception is not null)
        {
            exceptionType = exception.GetType().FullName;
            var text = exception.ToString();
            detail = text.Length <= MaxExceptionChars ? text : text[..MaxExceptionChars] + "\n… (cut)";
            origin = Origin(exception);
        }

        return new ErrorEvent(at, level, category, message, template, exceptionType, detail, origin);
    }

    /// <summary>How many characters of the exception message stand in for a missing app frame.</summary>
    public const int OriginMessageChars = 60;

    /// <summary>
    /// Where in the app an exception came from: the first stack frame inside an <c>AllotJar.</c>
    /// namespace, without its file and line (which change with every edit), searched through the
    /// inner exceptions too since EF and HTTP wrap the app's. An exception with no app frame at all
    /// (thrown and caught inside a library) falls back to the start of its message, which for a
    /// library's own messages is constant enough to tell two faults apart without letting a
    /// request's ids defeat the cooldown.
    /// </summary>
    public static string? Origin(Exception exception)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            var trace = ex.StackTrace;
            if (trace is null) continue;
            foreach (var rawLine in trace.Split('\n'))
            {
                var line = rawLine.Trim();
                if (!line.StartsWith("at AllotJar.", StringComparison.Ordinal)) continue;
                var cut = line.IndexOf(" in ", StringComparison.Ordinal);
                return cut > 0 ? line[..cut] : line;
            }
        }
        var m = exception.Message;
        return m.Length <= OriginMessageChars ? m : m[..OriginMessageChars];
    }
}
