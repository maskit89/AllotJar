using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Alerts;
using AllotJar.Infrastructure.Email;
using Xunit;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// Error alerts: every Error-level log entry is emailed to the configured recipient, batched and
/// throttled so one incident is one email and a flood is a handful, never thousands.
/// </summary>
public class ErrorAlertsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 4, 15, 0, 0, TimeSpan.Zero);

    private static ErrorEvent Error(string message, string category = "AllotJar.Api.Middleware.ExceptionHandlingMiddleware",
        string? template = null, Exception? ex = null, DateTimeOffset? at = null) =>
        new(at ?? T0, LogLevel.Error, category, message, template, ex?.GetType().FullName, ex?.ToString());

    // --- Throttle --------------------------------------------------------------------------------

    [Fact]
    public void The_same_error_again_inside_its_cooldown_is_counted_not_resent()
    {
        var clock = new StubClock(T0);
        var throttle = new ErrorAlertThrottle(new ErrorAlertSettings { Recipient = "x@y", CooldownMinutes = 15 }, clock);
        var e = Error("Unhandled exception processing /api/jars", template: "Unhandled exception processing {Path}");

        throttle.Take([e]).SendsEmail.Should().BeTrue();

        clock.Advance(TimeSpan.FromMinutes(5));
        var repeat = throttle.Take([e with { Message = "Unhandled exception processing /api/jars/1" }]);
        repeat.SendsEmail.Should().BeFalse("the template and exception are the same error");
        throttle.Suppressed.Should().Be(1);

        clock.Advance(TimeSpan.FromMinutes(11));
        var later = throttle.Take([e]);
        later.SendsEmail.Should().BeTrue("the cooldown is over");
        later.SuppressedBefore.Should().Be(1, "the held-back repeat is reported");
        throttle.Suppressed.Should().Be(0);
    }

    [Fact]
    public void A_batch_sends_each_distinct_error_once_with_how_often_it_appeared()
    {
        var throttle = new ErrorAlertThrottle(new ErrorAlertSettings { Recipient = "x@y" }, new StubClock(T0));
        var a = Error("A failed", template: "A failed");
        var b = Error("B failed", category: "Other", template: "B failed");

        var decision = throttle.Take([a, a, b, a]);

        decision.Events.Should().HaveCount(2);
        decision.Events[0].Occurrences.Should().Be(3);
        decision.Events[1].Occurrences.Should().Be(1);
        decision.PausedUntil.Should().BeNull();
    }

    [Fact]
    public void A_different_exception_type_on_the_same_message_is_a_different_error()
    {
        var throttle = new ErrorAlertThrottle(new ErrorAlertSettings { Recipient = "x@y" }, new StubClock(T0));
        var sql = Error("Unhandled exception processing /x", template: "Unhandled exception processing {Path}", ex: new InvalidOperationException("db"));
        var nre = Error("Unhandled exception processing /x", template: "Unhandled exception processing {Path}", ex: new NullReferenceException());

        throttle.Take([sql]).SendsEmail.Should().BeTrue();
        throttle.Take([nre]).SendsEmail.Should().BeTrue();
    }

    [Fact]
    public void The_hourly_cap_announces_the_pause_then_counts_until_the_hour_turns()
    {
        var clock = new StubClock(T0);
        var throttle = new ErrorAlertThrottle(
            new ErrorAlertSettings { Recipient = "x@y", MaxEmailsPerHour = 2, CooldownMinutes = 0 }, clock);

        var first = throttle.Take([Error("1", template: "1")]);
        first.PausedUntil.Should().BeNull();

        clock.Advance(TimeSpan.FromMinutes(1));
        var second = throttle.Take([Error("2", template: "2")]);
        second.SendsEmail.Should().BeTrue();
        second.PausedUntil.Should().Be(T0.AddHours(1), "the cap is reached: alerts resume an hour after the first email");

        clock.Advance(TimeSpan.FromMinutes(1));
        throttle.Take([Error("3", template: "3"), Error("4", template: "4")]).SendsEmail.Should().BeFalse();
        throttle.Suppressed.Should().Be(2);

        clock.Advance(TimeSpan.FromMinutes(58));
        var resumed = throttle.Take([Error("5", template: "5")]);
        resumed.SendsEmail.Should().BeTrue("the first email left the rolling hour");
        resumed.SuppressedBefore.Should().Be(2);
    }

    // --- Logger provider ------------------------------------------------------------------------

    [Fact]
    public void Only_error_and_critical_entries_are_queued_with_their_template_and_exception()
    {
        var queue = new ErrorAlertQueue();
        var provider = new ErrorAlertLoggerProvider(queue, new StubClock(T0));
        var logger = provider.CreateLogger("AllotJar.Api.Middleware.ExceptionHandlingMiddleware");

        logger.LogWarning("Outbound email provider: {Provider}.", "CloudflareEmailSender");
        logger.LogInformation("Database migrations applied (attempt {Attempt}).", 1);
        logger.LogError(new InvalidOperationException("boom"), "Unhandled exception processing {Path}", "/api/jars");
        logger.LogCritical("Host terminated unexpectedly");

        var events = Drain(queue);
        events.Should().HaveCount(2);
        events[0].Level.Should().Be(LogLevel.Error);
        events[0].Message.Should().Be("Unhandled exception processing /api/jars");
        events[0].Template.Should().Be("Unhandled exception processing {Path}");
        events[0].ExceptionType.Should().Be(typeof(InvalidOperationException).FullName);
        events[0].ExceptionDetail.Should().Contain("boom");
        events[0].At.Should().Be(T0);
        events[1].Level.Should().Be(LogLevel.Critical);
        events[1].Template.Should().Be("Host terminated unexpectedly");
    }

    [Fact]
    public void Entries_logged_while_an_alert_is_being_sent_are_dropped_as_are_the_alerting_codes_own()
    {
        var queue = new ErrorAlertQueue();
        var provider = new ErrorAlertLoggerProvider(queue, new StubClock(T0));
        var sender = provider.CreateLogger("AllotJar.Infrastructure.Email.CloudflareEmailSender");
        var own = provider.CreateLogger("AllotJar.Infrastructure.Alerts.ErrorAlertMailer");

        using (queue.Suppress())
        {
            sender.LogError("Cloudflare Email Service rejected an email ({Status}): {Detail}", 401, "bad token");
        }
        own.LogError("This is the mailer complaining");
        sender.LogError("Outside the send: a reset email failed");

        var events = Drain(queue);
        events.Should().ContainSingle().Which.Message.Should().Be("Outside the send: a reset email failed");
    }

    [Fact]
    public void A_request_the_visitor_abandoned_is_not_an_alert_but_a_timeout_is()
    {
        var queue = new ErrorAlertQueue();
        var logger = new ErrorAlertLoggerProvider(queue, new StubClock(T0)).CreateLogger("AllotJar.Api.Middleware.ExceptionHandlingMiddleware");

        logger.LogError(new OperationCanceledException(), "Unhandled exception processing {Path}", "/api/jars");
        logger.LogError(new TaskCanceledException("timed out", new TimeoutException()), "Unhandled exception processing {Path}", "/api/rates");

        Drain(queue).Should().ContainSingle().Which.Message.Should().Be("Unhandled exception processing /api/rates");
    }

    [Fact]
    public void A_long_stack_trace_is_cut_so_the_email_stays_readable()
    {
        var ex = new InvalidOperationException(new string('x', ErrorEventFactory.MaxExceptionChars + 500));
        var e = ErrorEventFactory.Create(T0, LogLevel.Error, "c", "plain", ex, "plain");

        e.ExceptionDetail!.Length.Should().BeLessThan(ErrorEventFactory.MaxExceptionChars + 20);
        e.ExceptionDetail.Should().EndWith("(cut)");
    }

    // --- Email ----------------------------------------------------------------------------------

    [Fact]
    public void The_email_names_the_stack_the_first_error_and_how_many_more_and_encodes_the_detail()
    {
        var ex = new InvalidOperationException("<script>alert(1)</script>");
        var decision = new AlertDecision(
            [
                Error("Unhandled exception processing /api/jars", ex: ex) with { Occurrences = 2 },
                Error("Jar-departure backfill failed; nothing was saved. Continuing startup.", category: "Program"),
            ],
            SuppressedBefore: 3,
            PausedUntil: T0.AddHours(1));

        var mail = ErrorAlertEmail.Build("chris@example.com", "Production", "https://www.allotjar.com", decision);

        mail.ToEmail.Should().Be("chris@example.com");
        mail.Subject.Should().Be("[AllotJar Production] Error: Unhandled exception processing /api/jars (+1 more)");
        mail.TextBody.Should().Contain("3 errors on https://www.allotjar.com (Production).");
        mail.TextBody.Should().Contain("3 earlier errors since the last email were not emailed");
        mail.TextBody.Should().Contain("(×2 in this batch)");
        mail.TextBody.Should().Contain("Logger: Program");
        mail.TextBody.Should().Contain("reported from 16:00 UTC");
        mail.HtmlBody.Should().NotContain("<script>");
        mail.HtmlBody.Should().Contain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    [Fact]
    public void A_long_first_line_is_cut_in_the_subject()
    {
        var decision = new AlertDecision([Error(new string('m', 200) + "\nsecond line")], 0, null);
        var mail = ErrorAlertEmail.Build("x@y", "Staging", "https://staging.allotjar.com", decision);

        mail.Subject.Should().StartWith("[AllotJar Staging] Error: " + new string('m', ErrorAlertEmail.SubjectMessageChars) + "…");
        mail.Subject.Should().NotContain("second line");
    }

    // --- Wiring ---------------------------------------------------------------------------------

    [Fact]
    public void Without_a_recipient_nothing_is_registered()
    {
        var services = new ServiceCollection().AddLogging();
        services.AddErrorAlerts(Config(("ErrorAlerts:CooldownMinutes", "5")));

        using var sp = services.BuildServiceProvider();
        sp.GetServices<ILoggerProvider>().Should().NotContain(p => p is ErrorAlertLoggerProvider);
        sp.GetServices<IHostedService>().Should().BeEmpty();
    }

    [Fact]
    public async Task An_error_logged_anywhere_is_emailed_to_the_recipient_through_the_email_sender()
    {
        var sent = new RecordingSender();
        await using var sp = BuildAlerting(sent, batchSeconds: 0);
        var mailer = sp.GetServices<IHostedService>().OfType<ErrorAlertMailer>().Single();
        await mailer.StartAsync(CancellationToken.None);

        var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("AllotJar.Api.Controllers.AuthController");
        logger.LogError(new InvalidOperationException("sign-in exploded"), "Login failed for {Email}", "a@b");

        var mail = await sent.WaitForMessages(1);
        mail[0].ToEmail.Should().Be("chris@example.com");
        mail[0].Subject.Should().Be("[AllotJar Staging] Error: Login failed for a@b");
        mail[0].TextBody.Should().Contain("sign-in exploded").And.Contain("https://staging.allotjar.com");
        await mailer.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task A_sender_that_fails_and_logs_an_error_does_not_alert_about_itself()
    {
        var sent = new RecordingSender { FailAndLogError = true };
        await using var sp = BuildAlerting(sent, batchSeconds: 0);
        sent.Logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("AllotJar.Infrastructure.Email.CloudflareEmailSender");
        var mailer = sp.GetServices<IHostedService>().OfType<ErrorAlertMailer>().Single();
        await mailer.StartAsync(CancellationToken.None);

        sp.GetRequiredService<ILoggerFactory>().CreateLogger("Program").LogError("Jar-departure backfill failed");

        await sent.WaitForAttempts(1);
        await Task.Delay(300);
        sent.Attempts.Should().Be(1, "the failure the sender logged during the send is not a new alert");
        await mailer.StopAsync(CancellationToken.None);
    }

    // --- Helpers --------------------------------------------------------------------------------

    private static ServiceProvider BuildAlerting(RecordingSender sender, int batchSeconds)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IEmailSender>(sender);
        services.AddSingleton<IHostEnvironment>(new StubEnvironment("Staging"));
        services.Configure<EmailSettings>(o => o.AppBaseUrl = "https://staging.allotjar.com");
        services.AddErrorAlerts(Config(
            ("ErrorAlerts:Recipient", "chris@example.com"),
            ("ErrorAlerts:BatchSeconds", batchSeconds.ToString())));
        return services.BuildServiceProvider();
    }

    private static IConfiguration Config(params (string Key, string Value)[] pairs) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(pairs.ToDictionary(p => p.Key, p => (string?)p.Value))
            .Build();

    private static List<ErrorEvent> Drain(ErrorAlertQueue queue)
    {
        var list = new List<ErrorEvent>();
        while (queue.Reader.TryRead(out var e)) list.Add(e);
        return list;
    }

    private sealed class StubClock(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    private sealed class StubEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "AllotJar.Api";
        public string ContentRootPath { get; set; } = "/";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class RecordingSender : IEmailSender
    {
        private readonly List<EmailMessage> _messages = new();
        public int Attempts;
        public bool FailAndLogError;
        public ILogger? Logger;

        public Task SendAsync(EmailMessage message, CancellationToken ct = default)
        {
            Interlocked.Increment(ref Attempts);
            if (FailAndLogError)
            {
                Logger?.LogError("Cloudflare Email Service rejected an email ({Status}): {Detail}", 401, "nope");
                throw new HttpRequestException("send failed");
            }
            lock (_messages) _messages.Add(message);
            return Task.CompletedTask;
        }

        public async Task<List<EmailMessage>> WaitForMessages(int count)
        {
            for (var i = 0; i < 100; i++)
            {
                lock (_messages) if (_messages.Count >= count) return _messages.ToList();
                await Task.Delay(50);
            }
            lock (_messages) return _messages.ToList();
        }

        public async Task WaitForAttempts(int count)
        {
            for (var i = 0; i < 100 && Volatile.Read(ref Attempts) < count; i++) await Task.Delay(50);
        }
    }
}
