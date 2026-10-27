using FluentAssertions;
using AllotJar.Application.Jars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// F3 (#297 P3-2): the history checks read an account on every date through
/// <see cref="JarLedgerSource.Viewer"/>, which walks the ledger once instead of rebuilding it
/// from the opening for each date. It must give exactly what <see cref="JarLedgerSource.ViewAt"/>
/// gives, on every date, for a ledger with every kind of operation in it.
/// </summary>
public class JarLedgerViewerTests
{
    private const string Owner = "user-1";
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Opening = LedgerFixtures.DefaultOpening;

    [Fact]
    public async Task The_viewer_gives_the_same_view_as_a_fresh_read_on_every_date()
    {
        await using var db = NewContext();
        var (savings, current) = Seed(db);

        var source = await JarLedgerReader.LoadAsync(db, Owner, Ct);
        foreach (var account in new[] { savings, current })
        {
            var viewAt = source.Viewer(account.Id);
            for (var date = Opening.AddDays(-3); date <= Opening.AddDays(130); date = date.AddDays(1))
            {
                Show(viewAt(date)).Should().Be(Show(source.ViewAt(account.Id, date)), $"{account.Name} on {date}");
            }
        }
    }

    [Fact]
    public async Task A_viewer_taken_after_the_opening_changes_reads_the_new_opening()
    {
        await using var db = NewContext();
        var (savings, _) = Seed(db);
        var source = await JarLedgerReader.LoadAsync(db, Owner, Ct);
        var before = source.Viewer(savings.Id);
        var date = Opening.AddDays(40);
        before(date);
        var was = before(date)!.AccountBalance;

        source.ViewAt(savings.Id, Opening)!.Account.OpeningBalance -= 100m;
        var after = source.Viewer(savings.Id);
        after(date);

        after(date)!.AccountBalance.Should().Be(was - 100m);
        Show(after(date)).Should().Be(Show(source.ViewAt(savings.Id, date)));
    }

    private static string Show(JarLedgerView? view) => view is null
        ? "none"
        : $"{view.AsOf} balance={view.Ledger.AccountBalance} unallocated={view.Ledger.Unallocated} "
          + $"jars=[{string.Join(", ", view.Ledger.JarBalances?.Select(kv => $"{kv.Key}:{kv.Value}") ?? Array.Empty<string>())}] "
          + $"pending=[{string.Join(", ", view.Ledger.PendingTransferReceipts)}] unreconciled={view.UnreconciledAllocations} "
          + $"carried=[{string.Join(", ", view.CarriedJars.Order())}] missing={view.OpeningDateMissing}";

    /// <summary>
    /// A savings account with two jars and a current account with one: daily spending, pay, jar
    /// payments, reallocations, transfers received the same day, later or never, a returned
    /// transfer with its jar share put back, a stored allocation that no longer matches its
    /// transaction, and a jar that moved here from the current account.
    /// </summary>
    private static (Account Savings, Account Current) Seed(ApplicationDbContext db)
    {
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 1000m);
        var current = LedgerFixtures.SeedAccount(db, Owner, "Current", 500m, type: AccountType.Current, order: 1);
        Jar NewJar(string name, Account account)
        {
            var jar = new Jar
            {
                OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 900m, Accrual = AccrualMethod.FixedMonthly,
                MonthlyContribution = 50m, FundingAccountId = account.Id,
            };
            db.Jars.Add(jar);
            db.SaveChanges();
            return jar;
        }
        var holiday = NewJar("Holiday", savings);
        var car = NewJar("Car", savings);
        var buffer = NewJar("Buffer", current);

        var holidayLine = new BudgetItem { Name = "Holiday", SavingsId = holiday.Id };
        var bufferLine = new BudgetItem { Name = "Buffer", SavingsId = buffer.Id };
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = Opening.Year, Month = Opening.Month, BaseCurrency = CurrencyCode.Eur,
            Categories =
            {
                new BudgetCategory { Name = "Savings", Kind = CategoryKind.Savings, Items = { holidayLine, bufferLine } },
                new BudgetCategory { Name = "Household", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = { groceries } },
            },
        });
        db.SaveChanges();

        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 300m, Opening);
        LedgerFixtures.Allocate(db, Owner, savings.Id, car.Id, 200m, Opening.AddDays(2));
        LedgerFixtures.Allocate(db, Owner, current.Id, buffer.Id, 100m, Opening);

        var rng = new Random(297);
        for (var day = 0; day < 120; day++)
        {
            var date = Opening.AddDays(day);
            if (day % 30 == 0)
            {
                LedgerFixtures.Income(db, Owner, current.Id, 2000m, date);
                LedgerFixtures.Income(db, Owner, savings.Id, 50m, date, holidayLine.Id);
            }
            if (rng.NextDouble() < 0.8)
            {
                LedgerFixtures.Expense(db, Owner, current.Id, Math.Round(5m + (decimal)rng.NextDouble() * 30m, 2), date, groceries.Id);
            }
            if (day % 9 == 4)
            {
                LedgerFixtures.Expense(db, Owner, savings.Id, 20m, date, holidayLine.Id);
                LedgerFixtures.Expense(db, Owner, current.Id, 7m, date, bufferLine.Id);
            }
            if (day % 17 == 5)
            {
                LedgerFixtures.Allocate(db, Owner, savings.Id, car.Id, 15m, date, JarAllocationKind.Reallocation);
            }
        }

        Transaction Transfer(decimal amount, DateOnly? departed, DateOnly? received, DateOnly? returned = null)
        {
            var transfer = new Transaction
            {
                OwnerId = Owner, Type = TransactionType.Transfer, AccountId = current.Id, TransferAccountId = savings.Id,
                Amount = amount, Currency = CurrencyCode.Eur, Payee = "Transfer",
                Date = departed ?? received ?? Opening, DepartedOn = departed, ReceivedOn = received, ReturnedOn = returned,
            };
            db.Transactions.Add(transfer);
            db.SaveChanges();
            return transfer;
        }
        // Received the same day, with its arrival put into a jar.
        var same = Transfer(300m, Opening.AddDays(10), Opening.AddDays(10));
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = savings.Id, Kind = JarAllocationKind.Movement, Date = Opening.AddDays(10),
            TransactionId = same.Id, CreatedUtc = DateTime.UtcNow,
            Postings = { new() { JarId = holiday.Id, Amount = 200m }, new() { JarId = null, Amount = 100m } },
        });
        // Received three days later; a receipt only (no departure yet); a returned transfer.
        Transfer(150m, Opening.AddDays(20), Opening.AddDays(23));
        Transfer(80m, null, Opening.AddDays(45));
        var returned = Transfer(60m, Opening.AddDays(50), null, Opening.AddDays(56));
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = current.Id, Kind = JarAllocationKind.Return, Date = Opening.AddDays(57),
            ReturnOfTransferId = returned.Id, CreatedUtc = DateTime.UtcNow,
            Postings = { new() { JarId = buffer.Id, Amount = 30m }, new() { JarId = null, Amount = -30m } },
        });
        // A stored allocation whose transaction's amount was changed since: set aside, for review.
        var changed = LedgerFixtures.Expense(db, Owner, savings.Id, 40m, Opening.AddDays(70));
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = savings.Id, Kind = JarAllocationKind.Movement, Date = Opening.AddDays(70),
            TransactionId = changed.Id, CreatedUtc = DateTime.UtcNow,
            Postings = { new() { JarId = car.Id, Amount = -35m } },
        });
        // Buffer leaves the current account at zero and moves here (rule 80): its departure there,
        // then money for it here.
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = savings.Id, Kind = JarAllocationKind.Reallocation, Date = Opening.AddDays(90),
            CreatedUtc = DateTime.UtcNow,
            Postings = { new() { JarId = buffer.Id, Amount = 25m }, new() { JarId = null, Amount = -25m } },
        });
        db.SaveChanges();
        return (savings, current);
    }
}
