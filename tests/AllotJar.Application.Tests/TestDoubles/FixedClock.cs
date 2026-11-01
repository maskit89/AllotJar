namespace AllotJar.Application.Tests.TestDoubles;

/// <summary>A clock stopped at noon UTC on <paramref name="today"/>, for handlers that take a <see cref="TimeProvider"/>.</summary>
public sealed class FixedClock(DateOnly today) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => new(today.ToDateTime(new TimeOnly(12, 0)), TimeSpan.Zero);
}
