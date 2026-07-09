using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.IntegrationTests;

/// <summary>
/// The unique (OwnerId, Year, Month) index is the real backstop against two requests
/// creating the same month (double-click, StrictMode double-fire, two logins in one
/// household). The handler's AnyAsync pre-check is per-request, so overlapping requests
/// can both pass it — only the index stops the second insert, and the handler must
/// recover by re-surfacing the same friendly 400 rather than a raw 500. The EF in-memory
/// provider enforces no unique index, so this contract is invisible to the unit suite.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class BudgetMonthConcurrencyTests
{
    private readonly SqlServerFixture _fixture;

    public BudgetMonthConcurrencyTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    [Fact]
    public async Task Concurrent_create_of_the_same_month_is_a_validation_error_not_a_500()
    {
        var owner = NewOwner();

        async Task<Exception?> TryCreate()
        {
            await using var db = _fixture.CreateContext();
            var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub(owner));
            try
            {
                await handler.Handle(
                    new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);
                return null;
            }
            catch (Exception ex)
            {
                return ex;
            }
        }

        // Race two creates of the same month on separate contexts/connections.
        var results = await Task.WhenAll(TryCreate(), TryCreate());

        // The index guarantees exactly one row landed...
        await using var verify = _fixture.CreateContext();
        (await verify.BudgetMonths.CountAsync(m => m.OwnerId == owner && m.Year == 2026 && m.Month == 7))
            .Should().Be(1);

        // ...and the loser surfaced as a friendly 400 (ValidationException), never a raw
        // 500 (DbUpdateException) — whether it lost at the pre-check or at the insert.
        var failures = results.Where(r => r is not null).ToList();
        failures.Should().ContainSingle("exactly one of the two racing creates must fail");
        failures[0].Should().BeOfType<ValidationException>(
            "the losing create must surface as a friendly 400, not a raw 500");
    }
}
