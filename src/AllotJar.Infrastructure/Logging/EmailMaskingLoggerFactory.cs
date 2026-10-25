using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AllotJar.Infrastructure.Logging;

/// <summary>
/// Keeps email addresses out of every log the API writes (the Windows event log, the console, the
/// error alert emails), whoever wrote the line: our own code, a provider's rejection text echoing
/// the recipient, or a SQL error quoting a duplicate key. It wraps the logger factory rather than
/// each provider, so the per-provider filters (the event log's Warning floor) still apply.
/// </summary>
public static class EmailMaskingLogs
{
    /// <summary>
    /// Replaces the registered <see cref="ILoggerFactory"/> with one that masks addresses. Call it
    /// after logging is set up (the host does that before the app's own registrations run).
    /// </summary>
    public static IServiceCollection MaskEmailAddressesInLogs(this IServiceCollection services)
    {
        // Registered through a factory, so the wrapper can't be told apart by its descriptor; this
        // marker keeps a second call from wrapping it again.
        if (services.Any(d => d.ServiceType == typeof(EmailMaskingMarker))) return services;
        services.AddSingleton<EmailMaskingMarker>();

        var original = services.LastOrDefault(d => d.ServiceType == typeof(ILoggerFactory));
        if (original is null)
        {
            services.AddLogging();
            original = services.Last(d => d.ServiceType == typeof(ILoggerFactory));
        }
        services.Remove(original);
        services.AddSingleton<ILoggerFactory>(sp => new EmailMaskingLoggerFactory(CreateInner(sp, original)));
        return services;
    }

    private static ILoggerFactory CreateInner(IServiceProvider sp, ServiceDescriptor original)
    {
        if (original.ImplementationInstance is ILoggerFactory instance) return instance;
        if (original.ImplementationFactory is not null) return (ILoggerFactory)original.ImplementationFactory(sp);
        if (original.ImplementationType == typeof(LoggerFactory))
        {
            // The same constructor the container picks for AddLogging's registration.
            return new LoggerFactory(
                sp.GetServices<ILoggerProvider>(),
                sp.GetRequiredService<IOptionsMonitor<LoggerFilterOptions>>(),
                sp.GetService<IOptions<LoggerFactoryOptions>>(),
                sp.GetService<IExternalScopeProvider>());
        }
        return (ILoggerFactory)ActivatorUtilities.CreateInstance(sp, original.ImplementationType!);
    }

    private sealed class EmailMaskingMarker;
}

/// <summary>An <see cref="ILoggerFactory"/> whose loggers mask email addresses before any provider sees them.</summary>
public sealed class EmailMaskingLoggerFactory : ILoggerFactory
{
    private readonly ILoggerFactory _inner;

    public EmailMaskingLoggerFactory(ILoggerFactory inner) => _inner = inner;

    public ILogger CreateLogger(string categoryName) => new EmailMaskingLogger(_inner.CreateLogger(categoryName));

    public void AddProvider(ILoggerProvider provider) => _inner.AddProvider(provider);

    public void Dispose() => _inner.Dispose();
}

/// <summary>
/// Formats each entry once, and when the message, a structured value or the exception holds an
/// address, hands the providers a masked copy instead: the masked message, the values with
/// addresses masked (the template stays, so error alerts still group by it) and a
/// <see cref="MaskedException"/> standing in for the exception. A line with no address passes
/// through untouched.
/// </summary>
public sealed class EmailMaskingLogger : ILogger
{
    private readonly ILogger _inner;

    public EmailMaskingLogger(ILogger inner) => _inner = inner;

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => _inner.BeginScope(state);

    public bool IsEnabled(LogLevel logLevel) => _inner.IsEnabled(logLevel);

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!_inner.IsEnabled(logLevel)) return;

        var message = formatter(state, exception);
        var values = state as IReadOnlyList<KeyValuePair<string, object?>>;
        var maskedException = MaskedException.For(exception);
        var valuesHaveAddress = values is not null && values.Any(pair => ValueHasAddress(pair));
        if (!EmailMask.HasAddress(message) && maskedException is null && !valuesHaveAddress)
        {
            _inner.Log(logLevel, eventId, state, exception, formatter);
            return;
        }

        var masked = new MaskedState(EmailMask.Mask(message), values?.Select(MaskValue).ToArray() ?? []);
        _inner.Log(logLevel, eventId, masked, maskedException ?? exception, static (s, _) => s.Message);
    }

    private static bool ValueHasAddress(KeyValuePair<string, object?> pair) =>
        pair.Key != "{OriginalFormat}" && pair.Value switch
        {
            null => false,
            string text => EmailMask.HasAddress(text),
            // A collection's ToString() is its type name; a structured provider would write its items.
            System.Collections.IEnumerable items => items.Cast<object?>().Any(item => EmailMask.HasAddress(item?.ToString())),
            var value => EmailMask.HasAddress(value.ToString()),
        };

    private static KeyValuePair<string, object?> MaskValue(KeyValuePair<string, object?> pair) =>
        !ValueHasAddress(pair) ? pair : pair.Value switch
        {
            string text => new(pair.Key, EmailMask.Mask(text)),
            System.Collections.IEnumerable items => new(pair.Key,
                items.Cast<object?>().Select(item => item is null ? null : EmailMask.Mask(item.ToString() ?? "")).ToArray()),
            var value => new(pair.Key, EmailMask.Mask(value!.ToString()!)),
        };

    /// <summary>The masked entry: its structured values, and the masked message as its text.</summary>
    private sealed class MaskedState : IReadOnlyList<KeyValuePair<string, object?>>
    {
        private readonly KeyValuePair<string, object?>[] _values;

        public MaskedState(string message, KeyValuePair<string, object?>[] values)
        {
            Message = message;
            _values = values;
        }

        public string Message { get; }

        public KeyValuePair<string, object?> this[int index] => _values[index];

        public int Count => _values.Length;

        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() =>
            ((IEnumerable<KeyValuePair<string, object?>>)_values).GetEnumerator();

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();

        public override string ToString() => Message;
    }
}

/// <summary>
/// Stands in for a logged exception whose text holds an email address: the same stack trace and
/// type name, with every address in its message and <see cref="ToString"/> masked. Its inner
/// exceptions are stand-ins too, so code that walks them (error alerts' origin) sees only masked
/// text.
/// </summary>
public sealed class MaskedException : Exception
{
    private readonly Exception _original;
    private readonly string _text;

    private MaskedException(Exception original, MaskedException? inner)
        : base(EmailMask.Mask(original.Message), inner)
    {
        _original = original;
        _text = EmailMask.Mask(original.ToString());
        Source = original.Source;
        HResult = original.HResult;
    }

    /// <summary>The logged exception's type.</summary>
    public Type OriginalType => _original.GetType();

    /// <summary>The type that was thrown: a stand-in's original type, else the exception's own.</summary>
    public static Type? TypeOf(Exception? exception) =>
        exception is MaskedException masked ? masked.OriginalType : exception?.GetType();

    public override string? StackTrace => _original.StackTrace;

    public override string ToString() => _text;

    /// <summary>
    /// A masked stand-in for <paramref name="exception"/>, or null when its text holds no address
    /// (the exception is then logged as it is).
    /// </summary>
    public static MaskedException? For(Exception? exception) =>
        exception is not null and not MaskedException && EmailMask.HasAddress(exception.ToString())
            ? Wrap(exception)
            : null;

    private static MaskedException Wrap(Exception exception) =>
        new(exception, exception.InnerException is null ? null : Wrap(exception.InnerException));
}
