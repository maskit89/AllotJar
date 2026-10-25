using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Alerts;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Logging;
using Xunit;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// No log line holds a user's email address: the Windows event log, the console and the error
/// alert emails all get c***@example.com, whoever wrote the line.
/// </summary>
public class EmailMaskingLogsTests
{
    // --- The mask ----------------------------------------------------------------------------------

    [Theory]
    [InlineData("Email to chris.muscat+test@example.com was NOT sent.", "Email to c***@example.com was NOT sent.")]
    [InlineData("a@b.co and Zed_99@mail.example.org", "a***@b.co and Z***@mail.example.org")]
    [InlineData("GET /api/x?email=chris%40example.com", "GET /api/x?email=c***%40example.com")]
    [InlineData("The duplicate key value is (chris@example.com).", "The duplicate key value is (c***@example.com).")]
    [InlineData("Already masked: c***@example.com", "Already masked: c***@example.com")]
    [InlineData("No address at AllotJar.Api.Program, x@y, 50% off", "No address at AllotJar.Api.Program, x@y, 50% off")]
    // Review P2-2: a local part may start with _ - + or . (Identity allows them), letters may be in
    // any script (invitations accept them), and an encoded delimiter may run into the address.
    [InlineData("_chris@example.com", "_***@example.com")]
    [InlineData("-chris@example.com", "-***@example.com")]
    [InlineData("+chris@example.com", "+***@example.com")]
    [InlineData(".chris@example.com", ".***@example.com")]
    [InlineData("josé@example.com", "j***@example.com")]
    [InlineData("joséphine@exämple.com", "j***@exämple.com")]
    [InlineData("to=%3Cchris%40example.com%3E", "to=%3Cc***%40example.com%3E")]
    [InlineData("email=chris%2Btest%40example.com", "email=c***%40example.com")]
    [InlineData("Masked twice: %3Cc***%40example.com", "Masked twice: %3Cc***%40example.com")]
    public void Addresses_keep_their_first_letter_and_domain(string text, string expected)
    {
        EmailMask.Mask(text).Should().Be(expected);
    }

    // --- The logging pipeline ----------------------------------------------------------------------

    [Fact]
    public void A_line_with_an_address_reaches_every_provider_masked()
    {
        var (factory, sink) = Pipeline();
        var logger = factory.CreateLogger("AllotJar.Test");

        logger.LogWarning("Email to {To} ({Subject}) was NOT sent: {Reason}.", "chris@example.com", "Reset", "no key");

        var entry = sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("Email to c***@example.com (Reset) was NOT sent: no key.");
        entry.Values.Should().Contain(new KeyValuePair<string, object?>("To", "c***@example.com"));
        entry.Values.Should().Contain(new KeyValuePair<string, object?>("Subject", "Reset"));
        entry.Values.Should().Contain(new KeyValuePair<string, object?>(
            "{OriginalFormat}", "Email to {To} ({Subject}) was NOT sent: {Reason}."), "error alerts group by the template");
    }

    [Fact]
    public void An_exception_quoting_an_address_is_logged_masked_with_its_type_and_stack()
    {
        var (factory, sink) = Pipeline();
        var logger = factory.CreateLogger("AllotJar.Test");
        var thrown = Throw(() => throw new InvalidOperationException(
            "Save failed", new InvalidOperationException("The duplicate key value is (chris@example.com).")));

        logger.LogError(thrown, "Unhandled exception processing {Path}", "/api/auth/register");

        var entry = sink.Entries.Should().ContainSingle().Subject;
        entry.Exception.Should().BeOfType<MaskedException>();
        entry.Exception!.ToString().Should().NotContain("chris@").And.Contain("c***@example.com").And.Contain(nameof(Throw));
        entry.Exception.InnerException!.Message.Should().Be("The duplicate key value is (c***@example.com).");
        entry.Exception.StackTrace.Should().Be(thrown.StackTrace);

        var alert = ErrorEventFactory.Create(DateTimeOffset.UnixEpoch, LogLevel.Error, "c", entry.Values, entry.Exception, entry.Message);
        alert.ExceptionType.Should().Be(typeof(InvalidOperationException).FullName, "the alert names what was thrown");
        alert.ExceptionDetail.Should().NotContain("chris@");
        alert.Template.Should().Be("Unhandled exception processing {Path}");
    }

    [Fact]
    public void A_line_without_an_address_passes_through_untouched()
    {
        var (factory, sink) = Pipeline();
        var thrown = Throw(() => throw new InvalidOperationException("db"));

        factory.CreateLogger("AllotJar.Test").LogError(thrown, "Jar {JarId} failed", 42);

        var entry = sink.Entries.Should().ContainSingle().Subject;
        entry.Exception.Should().BeSameAs(thrown);
        entry.Values.Should().Contain(new KeyValuePair<string, object?>("JarId", 42));
    }

    [Fact]
    public void A_collection_value_holding_addresses_is_masked_item_by_item()
    {
        // Review P3-3: a structured provider (JSON console, OpenTelemetry) would write the items.
        var (factory, sink) = Pipeline();

        factory.CreateLogger("AllotJar.Test").LogWarning("Invited {Emails}", (object)new[] { "chris@example.com", "ann@example.org" });

        var value = sink.Entries.Should().ContainSingle().Subject.Values.Single(v => v.Key == "Emails").Value;
        value.Should().BeEquivalentTo(new[] { "c***@example.com", "a***@example.org" });
    }

    [Fact]
    public void A_cancelled_request_quoting_an_address_is_still_not_an_alert()
    {
        // The alert's "visitor closed the tab" filter sees through the masked stand-in.
        var queue = new ErrorAlertQueue();
        var services = new ServiceCollection();
        services.AddLogging(b => b.AddProvider(new ErrorAlertLoggerProvider(queue, TimeProvider.System)));
        services.MaskEmailAddressesInLogs();
        var logger = services.BuildServiceProvider().GetRequiredService<ILoggerFactory>().CreateLogger("AllotJar.Test");

        logger.LogError(new OperationCanceledException("Cancelled for chris@example.com"), "Unhandled exception processing {Path}", "/x");
        queue.Reader.Count.Should().Be(0);

        logger.LogError(new InvalidOperationException("Failed for chris@example.com"), "Unhandled exception processing {Path}", "/x");
        queue.Reader.Count.Should().Be(1);
    }

    [Fact]
    public void Provider_filters_still_apply()
    {
        // The host gives the event log a Warning floor by its provider type; wrapping the factory
        // (not the providers) keeps that working.
        var (factory, sink) = Pipeline(b => b.AddFilter<CapturingProvider>(level => level >= LogLevel.Warning));
        var logger = factory.CreateLogger("AllotJar.Test");

        logger.LogInformation("Signed in {Email}", "chris@example.com");
        logger.LogWarning("Signed in {Email}", "chris@example.com");

        sink.Entries.Should().ContainSingle().Which.Level.Should().Be(LogLevel.Warning);
    }

    [Fact]
    public async Task The_fallback_email_sender_never_logs_the_recipient()
    {
        var (factory, sink) = Pipeline();
        var sender = new LoggingEmailSender(new DevEmailSink(), Options.Create(new EmailSettings()),
            factory.CreateLogger<LoggingEmailSender>());

        await sender.SendAsync(new EmailMessage("chris@example.com", "Reset your password", "body", "<p>body</p>"));

        sink.Entries.Should().ContainSingle().Which.Message.Should()
            .StartWith("Email to c***@example.com (Reset your password) was NOT sent").And.NotContain("chris@");
    }

    [Fact]
    public void Masking_twice_wraps_the_factory_once()
    {
        var services = new ServiceCollection().AddLogging();
        services.MaskEmailAddressesInLogs().MaskEmailAddressesInLogs();

        services.Count(d => d.ServiceType == typeof(ILoggerFactory)).Should().Be(1);
        using var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<ILoggerFactory>().Should().BeOfType<EmailMaskingLoggerFactory>().Subject;
        // Review P3-4: the second call must not wrap the wrapper.
        typeof(EmailMaskingLoggerFactory).GetField("_inner", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
            .GetValue(factory).Should().BeOfType<LoggerFactory>();
    }

    // --- Helpers -----------------------------------------------------------------------------------

    private static (ILoggerFactory Factory, CapturingProvider Sink) Pipeline(Action<ILoggingBuilder>? configure = null)
    {
        var sink = new CapturingProvider();
        var services = new ServiceCollection();
        services.AddLogging(b =>
        {
            b.SetMinimumLevel(LogLevel.Trace);
            b.AddProvider(sink);
            configure?.Invoke(b);
        });
        services.MaskEmailAddressesInLogs();
        return (services.BuildServiceProvider().GetRequiredService<ILoggerFactory>(), sink);
    }

    private static Exception Throw(Action action)
    {
        try { action(); }
        catch (Exception ex) { return ex; }
        throw new InvalidOperationException("Nothing was thrown.");
    }

    private sealed record Entry(LogLevel Level, string Message, IReadOnlyList<KeyValuePair<string, object?>> Values, Exception? Exception);

    private sealed class CapturingProvider : ILoggerProvider, ILogger
    {
        public List<Entry> Entries { get; } = [];

        public ILogger CreateLogger(string categoryName) => this;

        public void Dispose() { }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            Entries.Add(new Entry(logLevel, formatter(state, exception),
                state as IReadOnlyList<KeyValuePair<string, object?>> ?? [], exception));
    }
}
