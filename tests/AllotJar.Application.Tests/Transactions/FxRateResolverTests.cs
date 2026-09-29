using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Tests.Imports;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Transactions;

public class FxRateResolverTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    /// <summary>Provider that runs a hook on its first call — used to interleave a concurrent
    /// mutation into the middle of a reconcile pass (after the load, before the save).</summary>
    private sealed class HookedExchangeRateProvider(decimal? rate, Func<Task> onFirstCall) : IExchangeRateProvider
    {
        private bool _fired;

        public async Task<decimal?> GetRateAsync(CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken)
        {
            if (!_fired)
            {
                _fired = true;
                await onFirstCall();
            }
            return Equals(from, to) ? 1m : rate;
        }
    }

    private static ApplicationDbContext NewContext(string? name = null) =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase(name ?? $"zbb-fx-{Guid.NewGuid()}")
            .Options);

    private static void SeedEurMonth(ApplicationDbContext db, string ownerId, int year, int month)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            BaseCurrency = CurrencyCode.Eur,
        });
        db.SaveChanges();
    }

    private static Transaction ForeignTx(string currency, DateOnly date) => new()
    {
        OwnerId = "user-1",
        Amount = 40m,
        Currency = CurrencyCode.From(currency),
        ExchangeRate = 1m,
        Type = TransactionType.Expense,
        Date = date,
    };

    [Fact]
    public async Task Apply_ConvertsForeignToBaseAndSetsRate()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var tx = ForeignTx("GBP", new DateOnly(2026, 6, 3));

        var converted = await FxRateResolver.ApplyAsync(
            db, new FakeExchangeRateProvider(1.15m), "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(1);
        tx.ExchangeRate.Should().Be(1.15m);
        tx.BaseAmount.Should().Be(46.00m); // 40 GBP * 1.15
        tx.FxPending.Should().BeFalse();
    }

    [Fact]
    public async Task Apply_SameCurrency_StaysRateOne_AndNotCounted()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var tx = new Transaction { OwnerId = "user-1", Amount = 10m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 6, 3), Type = TransactionType.Expense };

        var provider = new FakeExchangeRateProvider(1.15m);
        var converted = await FxRateResolver.ApplyAsync(db, provider, "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(0);
        tx.ExchangeRate.Should().Be(1m);
        tx.FxPending.Should().BeFalse(); // genuinely 1:1, not unresolved
        provider.Calls.Should().Be(0); // no lookup for same-currency
    }

    [Fact]
    public async Task Apply_WhenRateUnavailable_MarksFxPending_AndKeepsRateOne()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var tx = ForeignTx("GBP", new DateOnly(2026, 6, 3));

        // null = provider couldn't resolve a rate.
        var converted = await FxRateResolver.ApplyAsync(
            db, new FakeExchangeRateProvider(null), "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(0);
        tx.ExchangeRate.Should().Be(1m);   // import still completes at face value…
        tx.FxPending.Should().BeTrue();    // …but the unresolved state is explicit, not a silent 1:1
    }

    [Fact]
    public async Task Apply_LeavesStoredPendingRowsAlone_ReconcileIsItsOwnPass()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var stuck = ForeignTx("GBP", new DateOnly(2026, 6, 3));
        stuck.FxPending = true;
        db.Transactions.Add(stuck);
        await db.SaveChangesAsync();

        var fresh = ForeignTx("GBP", new DateOnly(2026, 6, 10));
        await FxRateResolver.ApplyAsync(
            db, new FakeExchangeRateProvider(1.15m), "user-1", new[] { fresh }, CancellationToken.None);

        // The incoming batch resolves; the stored pending row is ReconcilePendingAsync's job
        // (the import handlers run it separately, after their own save).
        fresh.ExchangeRate.Should().Be(1.15m);
        stuck.ExchangeRate.Should().Be(1m);
        stuck.FxPending.Should().BeTrue();
    }

    [Fact]
    public async Task Reconcile_ResolvesPersistsAndClears_APreviouslyPendingRow()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);

        // A foreign row imported earlier while the provider was down: rate 1, flagged pending.
        var stuck = ForeignTx("GBP", new DateOnly(2026, 6, 3));
        stuck.FxPending = true;
        db.Transactions.Add(stuck);
        await db.SaveChangesAsync();

        var reconciled = await FxRateResolver.ReconcilePendingAsync(
            db, new FakeExchangeRateProvider(1.15m), "user-1", CancellationToken.None);

        reconciled.Should().Be(1);
        // Reconcile saves in its own scope — prove the change reached the store, not just the tracker.
        db.ChangeTracker.Clear();
        var reloaded = await db.Transactions.SingleAsync(t => t.Id == stuck.Id);
        reloaded.ExchangeRate.Should().Be(1.15m);
        reloaded.FxPending.Should().BeFalse();
    }

    [Fact]
    public async Task Reconcile_IgnoresOtherOwnersPendingRows()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var mine = ForeignTx("GBP", new DateOnly(2026, 6, 3));
        mine.FxPending = true;
        var theirs = ForeignTx("GBP", new DateOnly(2026, 6, 3));
        theirs.OwnerId = "user-2";
        theirs.FxPending = true;
        db.Transactions.AddRange(mine, theirs);
        await db.SaveChangesAsync();

        await FxRateResolver.ReconcilePendingAsync(
            db, new FakeExchangeRateProvider(1.15m), "user-1", CancellationToken.None);

        mine.FxPending.Should().BeFalse();
        theirs.FxPending.Should().BeTrue();
        theirs.ExchangeRate.Should().Be(1m);
    }

    [Fact]
    public async Task Reconcile_WithNothingPending_MakesNoProviderCalls()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var provider = new FakeExchangeRateProvider(1.15m);

        var reconciled = await FxRateResolver.ReconcilePendingAsync(
            db, provider, "user-1", CancellationToken.None);

        reconciled.Should().Be(0);
        provider.Calls.Should().Be(0);
    }

    [Fact]
    public async Task Reconcile_SkipsARowDeletedConcurrently_AndSavesTheRest()
    {
        var store = $"zbb-fx-{Guid.NewGuid()}";
        await using var db = NewContext(store);
        SeedEurMonth(db, "user-1", 2026, 6);
        var doomed = ForeignTx("GBP", new DateOnly(2026, 6, 3));
        doomed.FxPending = true;
        var kept = ForeignTx("GBP", new DateOnly(2026, 6, 10));
        kept.FxPending = true;
        db.Transactions.AddRange(doomed, kept);
        await db.SaveChangesAsync();

        // The provider hook deletes `doomed` through a second context mid-pass — the same race
        // as another device or household member deleting a row while an import reconciles.
        // The save must skip the vanished row and still persist the surviving one.
        var provider = new HookedExchangeRateProvider(1.15m, async () =>
        {
            await using var other = NewContext(store);
            other.Transactions.Remove(await other.Transactions.SingleAsync(t => t.Id == doomed.Id));
            await other.SaveChangesAsync();
        });

        await FxRateResolver.ReconcilePendingAsync(db, provider, "user-1", CancellationToken.None);

        db.ChangeTracker.Clear();
        var rows = await db.Transactions.Where(t => t.OwnerId == "user-1").ToListAsync();
        rows.Should().HaveCount(1);
        rows[0].Id.Should().Be(kept.Id);
        rows[0].ExchangeRate.Should().Be(1.15m);
        rows[0].FxPending.Should().BeFalse();
    }

    [Fact]
    public async Task Apply_DefaultsToEur_WhenNoBudgetForThatMonth()
    {
        await using var db = NewContext();
        // No budget month seeded -> base defaults to EUR; GBP is still foreign.
        var tx = ForeignTx("GBP", new DateOnly(2026, 6, 3));

        var converted = await FxRateResolver.ApplyAsync(
            db, new FakeExchangeRateProvider(1.2m), "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(1);
        tx.ExchangeRate.Should().Be(1.2m);
    }
}
