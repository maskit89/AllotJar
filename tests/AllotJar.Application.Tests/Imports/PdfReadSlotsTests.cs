using FluentAssertions;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Taking turns at reading PDFs (holistic review L5): one read at a time for the server's sake,
/// at most one per person, served in the order they came.
/// </summary>
public class PdfReadSlotsTests
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);

    /// <summary>A read that holds its turn until <paramref name="release"/> is set.</summary>
    private static Func<string> Holding(ManualResetEventSlim release, ManualResetEventSlim started, string result) => () =>
    {
        started.Set();
        release.Wait(Wait).Should().BeTrue();
        return result;
    };

    [Fact]
    public async Task A_second_PDF_from_the_same_person_is_refused_while_the_first_is_read()
    {
        var slots = new PdfReadSlots(Wait);
        using var release = new ManualResetEventSlim();
        using var started = new ManualResetEventSlim();
        var first = Task.Run(() => slots.RunAsync("anna", Holding(release, started, "first"), default));
        started.Wait(Wait).Should().BeTrue();

        var second = () => slots.RunAsync("anna", () => "second", default);
        await second.Should().ThrowAsync<StatementParseException>().WithMessage(PdfReadSlots.AlreadyReading);

        release.Set();
        (await first).Should().Be("first");
        // Once it has finished, the next one is read.
        (await slots.RunAsync("anna", () => "third", default)).Should().Be("third");
    }

    [Fact]
    public async Task Someone_else_waits_for_the_read_before_and_is_read_next()
    {
        var slots = new PdfReadSlots(Wait);
        using var release = new ManualResetEventSlim();
        using var started = new ManualResetEventSlim();
        var anna = Task.Run(() => slots.RunAsync("anna", Holding(release, started, "anna"), default));
        started.Wait(Wait).Should().BeTrue();

        var reading = 0;
        var ben = slots.RunAsync("ben", () => Interlocked.Increment(ref reading), default);
        await Task.Delay(100);
        ben.IsCompleted.Should().BeFalse("only one PDF is read at a time");

        release.Set();
        (await anna).Should().Be("anna");
        (await ben).Should().Be(1);
    }

    [Fact]
    public async Task Waiting_people_are_read_in_the_order_they_came()
    {
        var slots = new PdfReadSlots(Wait);
        using var release = new ManualResetEventSlim();
        using var started = new ManualResetEventSlim();
        var first = Task.Run(() => slots.RunAsync("anna", Holding(release, started, "anna"), default));
        started.Wait(Wait).Should().BeTrue();

        var order = new List<string>();
        var waiting = new List<Task<int>>();
        foreach (var person in new[] { "ben", "cara", "dan" })
        {
            waiting.Add(slots.RunAsync(person, () => { lock (order) order.Add(person); return 0; }, default));
            await Task.Delay(20);
        }

        release.Set();
        await first;
        await Task.WhenAll(waiting);
        order.Should().Equal("ben", "cara", "dan");
    }

    [Fact]
    public async Task A_full_queue_is_refused_at_once()
    {
        var slots = new PdfReadSlots(Wait);
        using var release = new ManualResetEventSlim();
        using var started = new ManualResetEventSlim();
        var first = Task.Run(() => slots.RunAsync("p0", Holding(release, started, "p0"), default));
        started.Wait(Wait).Should().BeTrue();
        var waiting = Enumerable.Range(1, PdfReadSlots.MaxWaiting)
            .Select(i => slots.RunAsync($"p{i}", () => $"p{i}", default))
            .ToList();

        var overflow = () => slots.RunAsync("late", () => "late", default);
        await overflow.Should().ThrowAsync<StatementParseException>().WithMessage(PdfReadSlots.Busy);

        release.Set();
        await first;
        (await Task.WhenAll(waiting)).Should().HaveCount(PdfReadSlots.MaxWaiting);
        // The refused request left no trace: that person can send a PDF now.
        (await slots.RunAsync("late", () => "late", default)).Should().Be("late");
    }

    [Fact]
    public async Task A_turn_that_does_not_come_in_time_is_refused_and_frees_the_person()
    {
        var slots = new PdfReadSlots(TimeSpan.FromMilliseconds(100));
        using var release = new ManualResetEventSlim();
        using var started = new ManualResetEventSlim();
        var first = Task.Run(() => slots.RunAsync("anna", Holding(release, started, "anna"), default));
        started.Wait(Wait).Should().BeTrue();

        var ben = () => slots.RunAsync("ben", () => "ben", default);
        await ben.Should().ThrowAsync<StatementParseException>().WithMessage(PdfReadSlots.Busy);

        release.Set();
        await first;
        (await slots.RunAsync("ben", () => "ben", default)).Should().Be("ben");
    }

    [Fact]
    public async Task A_failed_read_frees_the_turn_and_the_person()
    {
        var slots = new PdfReadSlots(Wait);
        var failing = () => slots.RunAsync<string>("anna", () => throw new StatementParseException("bad"), default);
        await failing.Should().ThrowAsync<StatementParseException>().WithMessage("bad");

        (await slots.RunAsync("anna", () => "ok", default)).Should().Be("ok");
    }
}
