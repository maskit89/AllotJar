using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Entries dated after today that a jar's zero balance today does not see (app-2026-09-30 review
/// JL-P2-1, JL-P2-2): a payment on the jar's savings line dated later draws from the jar on its
/// date (rule 79) without storing an operation, so archiving the jar (rule 26) or moving it to
/// another account (P51) waits until it has been paid or changed. And the import's running
/// account of earlier rows counts a transfer's return (#297 review R3-P3-1).
/// </summary>
public class JarFutureEntriesTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Jan1 = new(2026, 1, 1);
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static DateOnly Tomorrow => Today.AddDays(1);

    private static Jar SeedGoal(ApplicationDbContext db, Account account, string name)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m,
            TargetDate = new DateOnly(Today.Year + 1, 7, 1), Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>A Savings budget line for the jar in the month of <paramref name="inMonth"/>.</summary>
    private static BudgetItem SeedJarLine(ApplicationDbContext db, Jar jar, DateOnly inMonth)
    {
        var line = new BudgetItem { Name = jar.Name, PlannedAmount = 100m, SavingsId = jar.Id };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = inMonth.Year, Month = inMonth.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();
        return line;
    }

    private static string Message(ValidationException ex, string key) => string.Join(" ", ex.Errors[key]);

    [Fact]
    public async Task Archiving_a_jar_with_a_later_payment_on_its_line_is_refused_and_names_the_payment()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Jan1);
        var holiday = SeedGoal(db, a, "Holiday");
        var line = SeedJarLine(db, holiday, Tomorrow);
        LedgerFixtures.Expense(db, Owner, a.Id, 100m, Tomorrow, line.Id);

        var act = () => new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), Ct);

        var ex = (await act.Should().ThrowAsync<ValidationException>()).Which;
        Message(ex, "Id").Should().Contain("haven't reached the account yet").And.Contain($"{Tomorrow:d MMM yyyy}");
        (await db.Jars.AsNoTracking().SingleAsync(j => j.Id == holiday.Id)).IsArchived.Should().BeFalse();
        (await JarLedgerReader.ReadAsync(db, Owner, Tomorrow, Ct)).BalanceOf(holiday.Id).Should().Be(-100m);
    }

    [Fact]
    public async Task Archiving_a_jar_with_a_payment_on_its_line_dated_today_still_reads_today()
    {
        // Today's payment is in today's balance: the jar is overdrawn, and that refusal stands.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Jan1);
        var holiday = SeedGoal(db, a, "Holiday");
        var line = SeedJarLine(db, holiday, Today);
        LedgerFixtures.Expense(db, Owner, a.Id, 100m, Today, line.Id);

        var act = () => new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), Ct);

        Message((await act.Should().ThrowAsync<ValidationException>()).Which, "Id").Should().Contain("100 overdrawn");
    }

    [Fact]
    public async Task Moving_a_jar_with_a_later_payment_on_its_line_in_the_old_account_is_refused()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Jan1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Jan1, order: 1);
        var holiday = SeedGoal(db, a, "Holiday");
        var line = SeedJarLine(db, holiday, Tomorrow);
        LedgerFixtures.Expense(db, Owner, a.Id, 100m, Tomorrow, line.Id);

        var act = () => new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            holiday.Id, "Holiday", JarKind.Goal, 1200m, holiday.TargetDate, AccrualMethod.TargetByDate, b.Id), Ct);

        var ex = (await act.Should().ThrowAsync<ValidationException>()).Which;
        Message(ex, "FundingAccountId").Should().Contain($"an entry dated {Tomorrow:d MMM yyyy}");
        var jar = await db.Jars.AsNoTracking().SingleAsync(j => j.Id == holiday.Id);
        jar.FundingAccountId.Should().Be(a.Id);
        (await db.JarAllocations.CountAsync(x => x.Kind == JarAllocationKind.Departure)).Should().Be(0);
        (await JarLedgerReader.ReadAsync(db, Owner, Tomorrow, Ct)).BalanceOf(holiday.Id).Should().Be(-100m);
    }

    [Fact]
    public async Task Moving_a_jar_is_not_held_by_a_later_payment_on_its_line_from_another_account()
    {
        // Only the account the jar leaves matters: a payment from B on the line is not the jar's.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Jan1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Jan1, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 300m, Jan1, order: 2);
        var holiday = SeedGoal(db, a, "Holiday");
        var line = SeedJarLine(db, holiday, Tomorrow);
        LedgerFixtures.Expense(db, Owner, c.Id, 100m, Tomorrow, line.Id);

        await new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            holiday.Id, "Holiday", JarKind.Goal, 1200m, holiday.TargetDate, AccrualMethod.TargetByDate, b.Id), Ct);

        (await db.Jars.AsNoTracking().SingleAsync(j => j.Id == holiday.Id)).FundingAccountId.Should().Be(b.Id);
    }

    // --- The import counts a transfer's return (#297 review R3-P3-1) -----------------------------

    private static async Task<(Account A, Account B, Jar Holiday, Guid TransferId)> SeedTransferFromHolidayAsync(
        ApplicationDbContext db, DateOnly? returnedOn)
    {
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Jan1);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Jan1, order: 1);
        var holiday = SeedGoal(db, a, "Holiday");
        var repairs = SeedGoal(db, a, "Repairs");
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 100m, Jan1);
        LedgerFixtures.Allocate(db, Owner, a.Id, repairs.Id, 900m, Jan1);
        var t = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(new DateOnly(2026, 1, 10), 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        if (returnedOn is DateOnly returned)
        {
            await new UpdateTransferCommandHandler(db, User).Handle(
                new UpdateTransferCommand(t.Id, a.Id, b.Id, 100m, new DateOnly(2026, 1, 10), null, returned, FromJarId: holiday.Id), Ct);
        }
        return (a, b, holiday, t.Id);
    }

    [Fact]
    public async Task A_statement_confirming_a_departure_that_came_back_lets_a_later_row_take_the_returned_money()
    {
        await using var db = NewContext();
        var (a, b, holiday, transferId) = await SeedTransferFromHolidayAsync(db, new DateOnly(2026, 1, 12));

        var result = await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem("OUT-1", new DateOnly(2026, 1, 10), "To B", 100m, "EUR", false, null, null,
                TransferAccountId: b.Id, MatchTransferId: transferId, PaidFromJarId: holiday.Id),
            new CommitImportItem("TRF-2", new DateOnly(2026, 1, 15), "To B", 100m, "EUR", false, null, null,
                TransferAccountId: b.Id, PaidFromJarId: holiday.Id),
        }), Ct);

        result.Held.Should().BeEmpty("the 100 came back to Holiday on 12 Jan, so it can give 100 on 15 Jan");
        (await JarLedgerReader.ReadAsync(db, Owner, new DateOnly(2026, 1, 15), Ct)).BalanceOf(holiday.Id).Should().Be(0m);
    }

    [Fact]
    public async Task A_statement_with_a_return_row_lets_a_later_row_take_the_returned_money()
    {
        await using var db = NewContext();
        var (a, b, holiday, transferId) = await SeedTransferFromHolidayAsync(db, returnedOn: null);

        var result = await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem("RET-1", new DateOnly(2026, 1, 12), "Returned", 100m, "EUR", true, null, null,
                ReturnOfTransferId: transferId),
            new CommitImportItem("TRF-2", new DateOnly(2026, 1, 15), "To B", 100m, "EUR", false, null, null,
                TransferAccountId: b.Id, PaidFromJarId: holiday.Id),
        }), Ct);

        result.Held.Should().BeEmpty("the return on 12 Jan gives Holiday its 100 back before the 15 Jan transfer");
        (await JarLedgerReader.ReadAsync(db, Owner, new DateOnly(2026, 1, 15), Ct)).BalanceOf(holiday.Id).Should().Be(0m);
    }

    [Fact]
    public async Task A_later_row_still_cannot_take_more_than_the_return_gave_back()
    {
        // The return refills Holiday with 100; a 150 transfer from it on 15 Jan is still held.
        await using var db = NewContext();
        var (a, b, holiday, transferId) = await SeedTransferFromHolidayAsync(db, returnedOn: null);

        var result = await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem("RET-1", new DateOnly(2026, 1, 12), "Returned", 100m, "EUR", true, null, null,
                ReturnOfTransferId: transferId),
            new CommitImportItem("TRF-2", new DateOnly(2026, 1, 15), "To B", 150m, "EUR", false, null, null,
                TransferAccountId: b.Id, PaidFromJarId: holiday.Id),
        }), Ct);

        result.Held.Should().ContainSingle().Which.Message.Should().Contain("Holiday holds 100 on 2026-01-15");
    }
}
