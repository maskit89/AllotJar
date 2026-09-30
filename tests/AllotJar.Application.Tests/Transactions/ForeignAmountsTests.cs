using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using NSubstitute;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Budgets;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Tests.Imports;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.ConfirmConvertedAmount;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Queries.GetConversionSuggestion;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// W08 (rules 42–44, 63, 85): the budget and its accounts share one currency; a row in another
/// currency waits for its budget-currency amount and nothing converts it on its own; a suggested
/// conversion changes nothing until the user confirms an amount; the confirmed amount is the money
/// and the foreign figure is kept for reference only.
/// </summary>
public class ForeignAmountsTests
{
    private const string Owner = "user-1";
    private static readonly DateOnly June3 = new(2026, 6, 3);

    private static readonly ICurrentUser User = new CurrentUserStub(Owner);

    private static IIdentityService Prefers(string currency)
    {
        var identity = Substitute.For<IIdentityService>();
        identity.GetPreferredCurrencyAsync(Owner).Returns(CurrencyCode.From(currency));
        return identity;
    }

    private static void SeedMonth(ApplicationDbContext db, string currency = "EUR", int month = 6)
    {
        db.BudgetMonths.Add(new BudgetMonth { OwnerId = Owner, Year = 2026, Month = month, BaseCurrency = CurrencyCode.From(currency) });
        db.SaveChanges();
    }

    // A statement through the one import path: preview, then commit every new row as it is.
    private static async Task<(ImportStatementResult Result, IReadOnlyList<CommitImportItem> Items)> ImportAsync(
        ApplicationDbContext db, string content, Guid? accountId = null, IIdentityService? identity = null,
        IReadOnlyList<CommitImportItem>? items = null)
    {
        if (items is null)
        {
            var preview = await new PreviewImportCommandHandler(db, User,
                    new IStatementParser[] { new Camt053StatementParser() }, new GenericCsvImporter())
                .Handle(new PreviewImportCommand(content, StatementFormat.Camt053, AccountId: accountId), CancellationToken.None);
            items = preview.Items
                .Select(i => new CommitImportItem(i.Reference, i.Date, i.Payee, i.Amount, i.Currency, i.IsCredit, null, null))
                .ToList();
        }
        var result = await new CommitImportCommandHandler(db, User, identity)
            .Handle(new CommitImportCommand(accountId, items), CancellationToken.None);
        return (result, items);
    }

    private static Transaction Waiting(decimal amount = 45.50m, string currency = "GBP") => new()
    {
        OwnerId = Owner, Date = June3, Payee = "London Cab", Amount = amount,
        Currency = CurrencyCode.From(currency), FxPending = true, Type = TransactionType.Expense,
    };

    // ---- Budget currency --------------------------------------------------------------------

    [Fact]
    public async Task The_budget_currency_is_the_first_months_else_the_owners_choice()
    {
        await using var db = NewContext();
        (await BudgetCurrency.ResolveAsync(db, Prefers("GBP"), Owner, CancellationToken.None)).Value.Should().Be("GBP");
        (await BudgetCurrency.ResolveAsync(db, null, Owner, CancellationToken.None)).Value.Should().Be("EUR");

        SeedMonth(db, "USD", month: 8);
        SeedMonth(db, "CHF", month: 7);
        (await BudgetCurrency.ResolveAsync(db, Prefers("GBP"), Owner, CancellationToken.None)).Value
            .Should().Be("CHF", "the household's first month fixed it");
    }

    [Fact]
    public async Task The_budget_currency_is_fixed_once_the_household_holds_anything()
    {
        await using var db = NewContext();
        (await BudgetCurrency.IsFixedAsync(db, Owner, CancellationToken.None)).Should().BeFalse();

        LedgerFixtures.SeedAccount(db, Owner);
        (await BudgetCurrency.IsFixedAsync(db, Owner, CancellationToken.None)).Should().BeTrue();
        (await BudgetCurrency.IsFixedAsync(db, "someone-else", CancellationToken.None)).Should().BeFalse();
    }

    [Fact]
    public async Task A_new_account_must_be_in_the_budget_currency()
    {
        await using var db = NewContext();
        var handler = new CreateAccountCommandHandler(db, User, Prefers("GBP"));

        var foreign = () => handler.Handle(
            new CreateAccountCommand("Euro card", AccountType.Current, "EUR", 0m, new DateOnly(2026, 1, 1)), CancellationToken.None);
        (await foreign.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Should().ContainKey("Currency");

        var dto = await handler.Handle(
            new CreateAccountCommand("Current", AccountType.Current, "gbp", 0m, new DateOnly(2026, 1, 1)), CancellationToken.None);
        dto.Currency.Should().Be("GBP");
    }

    [Fact]
    public async Task A_jar_cannot_live_in_an_account_kept_in_another_currency()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var legacy = LedgerFixtures.SeedAccount(db, Owner, "UK savings", currency: "GBP");

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, AccrualMethod.TargetByDate, legacy.Id), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors["FundingAccountId"].Single().Should().Contain("budget is in EUR");
    }

    // ---- Imports never convert ----------------------------------------------------------------

    [Fact]
    public async Task An_imported_row_in_another_currency_waits_and_nothing_converts_it()
    {
        await using var db = NewContext();
        SeedMonth(db);
        // Two EUR entries and one GBP (London Cab, 45.50).
        var (result, items) = await ImportAsync(db, Camt053Samples.ThreeEntries);
        result.AwaitingAmount.Should().Be(1);

        var gbp = await db.Transactions.SingleAsync(t => t.Currency == CurrencyCode.From("GBP"));
        gbp.FxPending.Should().BeTrue();
        gbp.Amount.Should().Be(45.50m, "the amount as recorded, never multiplied by a rate");
        (await db.Transactions.Where(t => t.Currency == CurrencyCode.Eur).ToListAsync())
            .Should().OnlyContain(t => !t.FxPending);

        // Committing the same rows again is not a retry of anything: the row still waits.
        await ImportAsync(db, Camt053Samples.ThreeEntries, items: items);
        db.ChangeTracker.Clear();
        (await db.Transactions.SingleAsync(t => t.Currency == CurrencyCode.From("GBP"))).FxPending.Should().BeTrue();
    }

    [Fact]
    public async Task Without_a_budget_month_the_owners_currency_decides_what_waits_not_EUR()
    {
        await using var db = NewContext();
        await ImportAsync(db, Camt053Samples.ThreeEntries, identity: Prefers("GBP"));

        (await db.Transactions.SingleAsync(t => t.Currency == CurrencyCode.From("GBP"))).FxPending.Should().BeFalse();
        (await db.Transactions.Where(t => t.Currency == CurrencyCode.Eur).ToListAsync())
            .Should().HaveCount(2).And.OnlyContain(t => t.FxPending);
    }

    [Fact]
    public void A_transfer_never_waits()
    {
        var transfer = new Transaction { Type = TransactionType.Transfer, Currency = CurrencyCode.From("USD") };
        var expense = new Transaction { Type = TransactionType.Expense, Currency = CurrencyCode.From("USD") };

        ForeignAmounts.MarkWaiting(new[] { transfer, expense }, CurrencyCode.Eur);

        transfer.FxPending.Should().BeFalse();
        expense.FxPending.Should().BeTrue();
    }

    // ---- Suggestions ------------------------------------------------------------------------

    [Fact]
    public async Task A_suggestion_is_the_reference_rate_rounded_to_cents_and_records_nothing()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var rates = new FakeExchangeRateProvider(1.17055m);

        var suggestion = await new GetConversionSuggestionQueryHandler(db, User, rates)
            .Handle(new GetConversionSuggestionQuery("gbp", 45.50m, June3), CancellationToken.None);

        suggestion.Currency.Should().Be("GBP");
        suggestion.BudgetCurrency.Should().Be("EUR");
        suggestion.Rate.Should().Be(1.17055m);
        suggestion.SuggestedAmount.Should().Be(53.26m, "45.50 x 1.17055 = 53.260025");
        suggestion.Source.Should().Be(ForeignAmounts.SuggestionSource);
        (await db.Transactions.AnyAsync()).Should().BeFalse();
    }

    [Fact]
    public async Task No_rate_means_no_suggestion_and_the_user_types_the_amount()
    {
        await using var db = NewContext();
        SeedMonth(db);

        var suggestion = await new GetConversionSuggestionQueryHandler(db, User, new FakeExchangeRateProvider(rate: null))
            .Handle(new GetConversionSuggestionQuery("USD", 20m, June3), CancellationToken.None);

        suggestion.Rate.Should().BeNull();
        suggestion.SuggestedAmount.Should().BeNull();
    }

    [Theory]
    [InlineData("EUR", 10, 0)]
    [InlineData("EURO", 10, 0)]
    [InlineData("USD", 0, 0)]
    [InlineData("USD", 10, 1)] // tomorrow: no day's rate exists yet
    public async Task A_suggestion_needs_another_currency_a_positive_amount_and_a_day_that_has_a_rate(
        string currency, int amount, int daysFromToday)
    {
        await using var db = NewContext();
        SeedMonth(db);
        var rates = new FakeExchangeRateProvider(1.1m);
        var date = daysFromToday == 0 ? June3 : DateOnly.FromDateTime(DateTime.UtcNow).AddDays(daysFromToday);

        var act = () => new GetConversionSuggestionQueryHandler(db, User, rates)
            .Handle(new GetConversionSuggestionQuery(currency, amount, date), CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
        rates.Calls.Should().Be(0);
    }

    // ---- Confirming an amount ---------------------------------------------------------------

    [Fact]
    public async Task Confirming_makes_the_row_a_budget_currency_row_and_keeps_the_foreign_figure()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var row = Waiting();
        db.Transactions.Add(row);
        await db.SaveChangesAsync();

        var dto = await new ConfirmConvertedAmountCommandHandler(db, User)
            .Handle(new ConfirmConvertedAmountCommand(row.Id, 53.10m), CancellationToken.None);

        dto.Amount.Should().Be(53.10m, "the user's amount stands, whatever a rate would say (rule 43)");
        dto.Currency.Should().Be("EUR");
        dto.FxPending.Should().BeFalse();
        dto.OriginalAmount.Should().Be(45.50m);
        dto.OriginalCurrency.Should().Be("GBP");
    }

    [Fact]
    public async Task Only_a_waiting_row_that_is_not_split_can_be_given_an_amount()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var counted = new Transaction
        {
            OwnerId = Owner, Date = June3, Payee = "Grocer", Amount = 20m, Currency = CurrencyCode.Eur, Type = TransactionType.Expense,
        };
        var split = Waiting();
        split.Splits.Add(new TransactionSplit { Amount = 20m });
        split.Splits.Add(new TransactionSplit { Amount = 25.50m });
        db.Transactions.AddRange(counted, split);
        await db.SaveChangesAsync();
        var handler = new ConfirmConvertedAmountCommandHandler(db, User);

        foreach (var (row, why) in new[] { (counted, "already counts"), (split, "is split") })
        {
            var act = () => handler.Handle(new ConfirmConvertedAmountCommand(row.Id, 50m), CancellationToken.None);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["Amount"].Single().Should().Contain(why);
        }
    }

    // ---- An account kept in another currency (from before rule 63; "Support them") ----------

    private static async Task<decimal> SpentOnAsync(ApplicationDbContext db, Guid lineId)
    {
        var month = await db.BudgetMonths.Include(m => m.Categories).ThenInclude(c => c.Items)
            .SingleAsync(m => m.Categories.Any(c => c.Items.Any(i => i.Id == lineId)));
        await BudgetActuals.ApplyAsync(db, Owner, month, CancellationToken.None);
        return month.Categories.SelectMany(c => c.Items).Single(i => i.Id == lineId).ActualAmount;
    }

    private static BudgetItem SeedLine(ApplicationDbContext db, string name = "Travel")
    {
        var line = new BudgetItem { Name = name, PlannedAmount = 500m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Spending", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { line } } },
        });
        db.SaveChanges();
        return line;
    }

    private static async Task<decimal?> BalanceAsync(ApplicationDbContext db, Guid accountId) =>
        (await new GetAccountsQueryHandler(db, User).Handle(new GetAccountsQuery(), CancellationToken.None))
            .Single(a => a.Id == accountId).CurrentBalance;

    [Fact]
    public async Task A_waiting_row_on_an_account_kept_in_another_currency_counts_its_confirmed_figure_and_the_balance_stays()
    {
        await using var db = NewContext();
        var line = SeedLine(db);
        var gbp = LedgerFixtures.SeedAccount(db, Owner, "UK card", opening: 500m, currency: "GBP");
        var row = LedgerFixtures.Expense(db, Owner, gbp.Id, 25m, June3, line.Id, currency: "GBP");
        row.FxPending = true;
        await db.SaveChangesAsync();
        (await SpentOnAsync(db, line.Id)).Should().Be(0m, "a waiting row counts nowhere");

        var dto = await new ConfirmConvertedAmountCommandHandler(db, User)
            .Handle(new ConfirmConvertedAmountCommand(row.Id, 30m), CancellationToken.None);

        dto.Amount.Should().Be(25m, "the account's money is not restated");
        dto.Currency.Should().Be("GBP");
        dto.BudgetAmount.Should().Be(30m);
        dto.FxPending.Should().BeFalse();
        db.ChangeTracker.Clear();
        (await SpentOnAsync(db, line.Id)).Should().Be(30m, "the budget counts the confirmed figure");
        (await BalanceAsync(db, gbp.Id)).Should().Be(475m, "the account keeps its own money");
    }

    [Fact]
    public async Task A_statement_imported_onto_an_account_kept_in_another_currency_waits_and_can_be_confirmed()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var gbp = LedgerFixtures.SeedAccount(db, Owner, "UK card", opening: 500m, currency: "GBP");
        var statement = Camt053Samples.TwoEurEntries.Replace("\"EUR\"", "\"GBP\"").Replace(">EUR<", ">GBP<");

        var (result, _) = await ImportAsync(db, statement, gbp.Id);

        result.AwaitingAmount.Should().Be(result.Imported).And.BePositive();
        var first = await db.Transactions.FirstAsync(t => t.AccountId == gbp.Id);
        var dto = await new ConfirmConvertedAmountCommandHandler(db, User)
            .Handle(new ConfirmConvertedAmountCommand(first.Id, 10m), CancellationToken.None);
        dto.BudgetAmount.Should().Be(10m);
        dto.FxPending.Should().BeFalse();
    }

    [Fact]
    public async Task A_transfer_on_an_account_kept_in_another_currency_waits_once_retyped_into_an_expense()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var gbp = LedgerFixtures.SeedAccount(db, Owner, "UK card", opening: 500m, currency: "GBP");
        var gbpSavings = LedgerFixtures.SeedAccount(db, Owner, "UK savings", opening: 0m, currency: "GBP", order: 1);
        var eur = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 500m, order: 2);
        var eurSavings = LedgerFixtures.SeedAccount(db, Owner, "Savings", opening: 0m, order: 3);
        var foreign = await new CreateTransferCommandHandler(db, User)
            .Handle(new CreateTransferCommand(June3, 100m, gbp.Id, gbpSavings.Id), CancellationToken.None);
        var own = await new CreateTransferCommandHandler(db, User)
            .Handle(new CreateTransferCommand(June3, 100m, eur.Id, eurSavings.Id), CancellationToken.None);

        var handler = new UpdateTransactionCommandHandler(db, User);
        await handler.Handle(new UpdateTransactionCommand(foreign.Id, June3, "Shop", 100m, TransactionType.Expense, gbp.Id), CancellationToken.None);
        await handler.Handle(new UpdateTransactionCommand(own.Id, June3, "Shop", 100m, TransactionType.Expense, eur.Id), CancellationToken.None);

        db.ChangeTracker.Clear();
        var retyped = await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == foreign.Id);
        retyped.FxPending.Should().BeTrue("100 GBP is no budget figure until the user confirms one (M-P3-1)");
        ForeignAmounts.Counted(retyped).Should().BeNull();
        ForeignAmounts.Counted(await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == own.Id))
            .Should().Be(100m, "a transfer in the budget currency counts its amount once retyped");
    }

    [Fact]
    public async Task Changing_the_amount_of_such_a_row_makes_it_wait_for_its_new_figure_and_other_edits_keep_it()
    {
        await using var db = NewContext();
        var line = SeedLine(db);
        var gbp = LedgerFixtures.SeedAccount(db, Owner, "UK card", opening: 500m, currency: "GBP");
        var row = LedgerFixtures.Expense(db, Owner, gbp.Id, 25m, June3, line.Id, currency: "GBP");
        row.BudgetAmount = 30m; // as the migration or a confirmation leaves it
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, User);

        await handler.Handle(new UpdateTransactionCommand(row.Id, row.Date, "Train", 25m, TransactionType.Expense, gbp.Id),
            CancellationToken.None);
        db.ChangeTracker.Clear();
        var renamed = await db.Transactions.SingleAsync(t => t.Id == row.Id);
        renamed.BudgetAmount.Should().Be(30m);
        renamed.FxPending.Should().BeFalse();

        await handler.Handle(new UpdateTransactionCommand(row.Id, row.Date, "Train", 27m, TransactionType.Expense, gbp.Id),
            CancellationToken.None);
        db.ChangeTracker.Clear();
        var corrected = await db.Transactions.SingleAsync(t => t.Id == row.Id);
        corrected.Amount.Should().Be(27m);
        corrected.BudgetAmount.Should().BeNull("the old figure was for another amount");
        corrected.FxPending.Should().BeTrue("it waits for the figure of the corrected amount");
        (await SpentOnAsync(db, line.Id)).Should().Be(0m);
    }

    [Fact]
    public async Task Splitting_such_a_row_shares_its_figure_over_the_slices()
    {
        await using var db = NewContext();
        var travel = new BudgetItem { Name = "Travel", PlannedAmount = 500m };
        var food = new BudgetItem { Name = "Food", PlannedAmount = 500m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Spending", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { travel, food } } },
        });
        var gbp = LedgerFixtures.SeedAccount(db, Owner, "UK card", opening: 500m, currency: "GBP");
        var row = LedgerFixtures.Expense(db, Owner, gbp.Id, 10m, June3, currency: "GBP");
        row.BudgetAmount = 11.2346m;
        await db.SaveChangesAsync();

        await new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(row.Id, new[]
        {
            new SplitAllocationInput(travel.Id, 3.33m),
            new SplitAllocationInput(food.Id, 6.67m),
        }), CancellationToken.None);

        db.ChangeTracker.Clear();
        var slices = await db.TransactionSplits.Where(s => s.TransactionId == row.Id).OrderBy(s => s.Amount).ToListAsync();
        slices.Select(s => s.BudgetAmount).Should().Equal(3.7411m, 7.4935m);
        (await SpentOnAsync(db, travel.Id)).Should().Be(3.7411m);
        (await SpentOnAsync(db, food.Id)).Should().Be(7.4935m, "the shares add up to the row's figure");
    }

    [Fact]
    public async Task A_waiting_payment_cannot_mark_a_cycle_paid()
    {
        await using var db = NewContext();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 2000m);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 600m,
            TargetDate = today, CycleDeadline = today, Accrual = AccrualMethod.TargetByDate, RecurMonths = 12,
            FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        var payment = new Transaction
        {
            OwnerId = Owner, Date = today, Payee = "US insurer", Amount = 650m, Currency = CurrencyCode.From("USD"),
            FxPending = true, Type = TransactionType.Expense,
        };
        db.Transactions.Add(payment);
        await db.SaveChangesAsync();

        var act = () => new MarkJarCyclePaidCommandHandler(db, User)
            .Handle(new MarkJarCyclePaidCommand(jar.Id, today, payment.Id), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors["PaymentTransactionId"].Single().Should().Contain("waiting for its amount");
        (await db.JarCycles.AnyAsync(c => c.PaymentTransactionId == payment.Id)).Should().BeFalse();
    }

    [Fact]
    public async Task A_cycle_paid_from_an_account_kept_in_another_currency_records_the_payments_budget_figure()
    {
        await using var db = NewContext();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 2000m);
        var usd = LedgerFixtures.SeedAccount(db, Owner, "US card", opening: 2000m, currency: "USD", order: 1);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 600m,
            TargetDate = today, CycleDeadline = today, Accrual = AccrualMethod.TargetByDate, RecurMonths = 12,
            FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        var payment = new Transaction
        {
            OwnerId = Owner, AccountId = usd.Id, Date = today, Payee = "US insurer", Amount = 650m,
            Currency = CurrencyCode.From("USD"), BudgetAmount = 598.5m, Type = TransactionType.Expense,
        };
        db.Transactions.Add(payment);
        await db.SaveChangesAsync();

        await new MarkJarCyclePaidCommandHandler(db, User)
            .Handle(new MarkJarCyclePaidCommand(jar.Id, today, payment.Id), CancellationToken.None);

        (await db.JarCycles.SingleAsync(c => c.PaymentTransactionId == payment.Id)).PaidAmount.Should().Be(598.5m);
    }

    [Fact]
    public async Task A_purchase_and_refund_restated_at_different_rates_can_still_be_edited_but_not_pushed_further_apart()
    {
        await using var db = NewContext();
        SeedMonth(db);
        // As the migration leaves USD 100 bought at 0.92 and USD 100 refunded at 0.95.
        var purchase = new Transaction
        {
            OwnerId = Owner, Date = June3, Payee = "US shop", Amount = 92m, Currency = CurrencyCode.Eur,
            OriginalAmount = 100m, OriginalCurrency = CurrencyCode.From("USD"), Type = TransactionType.Expense,
        };
        var refund = new Transaction
        {
            OwnerId = Owner, Date = June3, Payee = "US shop refund", Amount = 95m, Currency = CurrencyCode.Eur,
            OriginalAmount = 100m, OriginalCurrency = CurrencyCode.From("USD"), Type = TransactionType.Income,
            RefundOfTransactionId = purchase.Id,
        };
        db.Transactions.AddRange(purchase, refund);
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, User);

        await handler.Handle(new UpdateTransactionCommand(purchase.Id, June3, "US shop (online)", 92m, TransactionType.Expense),
            CancellationToken.None);
        await handler.Handle(new UpdateTransactionCommand(refund.Id, June3, "Refund", 95m, TransactionType.Income),
            CancellationToken.None);
        await handler.Handle(new UpdateTransactionCommand(refund.Id, June3, "Refund", 94m, TransactionType.Income),
            CancellationToken.None);

        var lowerPurchase = () => handler.Handle(
            new UpdateTransactionCommand(purchase.Id, June3, "US shop (online)", 91m, TransactionType.Expense), CancellationToken.None);
        (await lowerPurchase.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("Amount");
        var raiseRefund = () => handler.Handle(
            new UpdateTransactionCommand(refund.Id, June3, "Refund", 94.50m, TransactionType.Income), CancellationToken.None);
        (await raiseRefund.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey(RefundRules.Key);
    }

    [Fact]
    public async Task Confirming_a_refund_of_a_purchase_that_still_waits_asks_for_the_purchases_amount_first()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var purchase = Waiting(100m, "USD");
        db.Transactions.Add(purchase);
        await db.SaveChangesAsync();
        var refund = Waiting(20m, "USD");
        refund.Type = TransactionType.Income;
        refund.RefundOfTransactionId = purchase.Id;
        db.Transactions.Add(refund);
        await db.SaveChangesAsync();

        var act = () => new ConfirmConvertedAmountCommandHandler(db, User)
            .Handle(new ConfirmConvertedAmountCommand(refund.Id, 18m), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors[RefundRules.Key].Single().Should().Contain("Enter the purchase's amount first");
    }

    [Fact]
    public async Task A_refund_is_measured_against_what_its_purchase_counts_not_its_accounts_amount()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var gbp = LedgerFixtures.SeedAccount(db, Owner, "UK card", opening: 500m, currency: "GBP");
        var purchase = LedgerFixtures.Expense(db, Owner, gbp.Id, 25m, June3, currency: "GBP");
        purchase.BudgetAmount = 30m;
        await db.SaveChangesAsync();
        var refund = Waiting(20m, "USD");
        refund.Type = TransactionType.Income;
        refund.RefundOfTransactionId = purchase.Id;
        db.Transactions.Add(refund);
        await db.SaveChangesAsync();
        var handler = new ConfirmConvertedAmountCommandHandler(db, User);

        var tooMuch = () => handler.Handle(new ConfirmConvertedAmountCommand(refund.Id, 30.01m), CancellationToken.None);
        (await tooMuch.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey(RefundRules.Key);
        (await handler.Handle(new ConfirmConvertedAmountCommand(refund.Id, 28m), CancellationToken.None)).Amount
            .Should().Be(28m, "28 is more than the account's 25 but within the 30 the purchase counts");
    }

    [Fact]
    public async Task A_confirmed_refund_must_still_fit_its_purchase()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var purchase = new Transaction
        {
            OwnerId = Owner, Date = June3, Payee = "Hotel", Amount = 100m, Currency = CurrencyCode.Eur, Type = TransactionType.Expense,
        };
        db.Transactions.Add(purchase);
        await db.SaveChangesAsync();
        var refund = Waiting(90m, "USD");
        refund.Type = TransactionType.Income;
        refund.RefundOfTransactionId = purchase.Id;
        db.Transactions.Add(refund);
        await db.SaveChangesAsync();
        var handler = new ConfirmConvertedAmountCommandHandler(db, User);

        var tooMuch = () => handler.Handle(new ConfirmConvertedAmountCommand(refund.Id, 100.01m), CancellationToken.None);
        (await tooMuch.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey(RefundRules.Key);

        var dto = await handler.Handle(new ConfirmConvertedAmountCommand(refund.Id, 82.40m), CancellationToken.None);
        dto.Amount.Should().Be(82.40m);
    }

    [Fact]
    public async Task Editing_a_waiting_rows_amount_corrects_the_foreign_figure_and_it_keeps_waiting()
    {
        // A5: the old edit cleared the flag and counted £90 as €90.
        await using var db = NewContext();
        SeedMonth(db);
        var row = Waiting(100m);
        db.Transactions.Add(row);
        await db.SaveChangesAsync();

        var dto = await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(row.Id, June3, "London Cab", 90m, TransactionType.Expense, null, null),
            CancellationToken.None);

        dto.Amount.Should().Be(90m);
        dto.Currency.Should().Be("GBP");
        dto.FxPending.Should().BeTrue();
    }

    // ---- Manual entry paid in another currency --------------------------------------------------

    [Fact]
    public async Task A_manual_entry_paid_abroad_counts_the_confirmed_amount_and_keeps_what_was_paid()
    {
        await using var db = NewContext();
        SeedMonth(db);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(June3, "Taxi", 23.40m, TransactionType.Expense, null,
                OriginalAmount: 20m, OriginalCurrency: "gbp"),
            CancellationToken.None);

        dto.Amount.Should().Be(23.40m);
        dto.Currency.Should().Be("EUR");
        dto.FxPending.Should().BeFalse();
        dto.OriginalAmount.Should().Be(20m);
        dto.OriginalCurrency.Should().Be("GBP");
    }

    [Fact]
    public async Task A_manual_entry_cannot_name_the_budget_currency_as_the_other_currency()
    {
        await using var db = NewContext();
        SeedMonth(db);

        var act = () => new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(June3, "Taxi", 23.40m, TransactionType.Expense, null,
                OriginalAmount: 23.40m, OriginalCurrency: "EUR"),
            CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("OriginalCurrency");
    }

    [Theory]
    [InlineData(20, null)]
    [InlineData(null, "GBP")]
    [InlineData(-1, "GBP")]
    [InlineData(20, "POUNDS")]
    public void The_other_currency_needs_both_a_code_and_a_positive_amount(int? amount, string? currency)
    {
        var result = new CreateTransactionCommandValidator().Validate(
            new CreateTransactionCommand(June3, "Taxi", 23.40m, TransactionType.Expense, null,
                OriginalAmount: amount, OriginalCurrency: currency));

        result.IsValid.Should().BeFalse();
    }

    // A transfer's fee is spending: between accounts kept in another currency it waits for its
    // budget-currency amount like any new entry there, and a confirmed figure stands until the
    // fee itself changes (W07 fee rows, rule 91).
    [Fact]
    public async Task A_transfer_fee_on_accounts_kept_in_another_currency_waits_for_its_amount()
    {
        await using var db = NewContext();
        var fees = SeedLine(db, "Bank fees");
        var gbp = LedgerFixtures.SeedAccount(db, Owner, "UK card", opening: 500m, currency: "GBP");
        var gbpSavings = LedgerFixtures.SeedAccount(db, Owner, "UK savings", opening: 0m, currency: "GBP", order: 1);
        var eur = LedgerFixtures.SeedAccount(db, Owner, "Joint", opening: 500m, order: 2);
        var eurSavings = LedgerFixtures.SeedAccount(db, Owner, "Savings", opening: 0m, order: 3);

        var foreign = await new AllotJar.Application.Transactions.Commands.CreateTransfer.CreateTransferCommandHandler(db, User)
            .Handle(new AllotJar.Application.Transactions.Commands.CreateTransfer.CreateTransferCommand(June3, 100m, gbp.Id, gbpSavings.Id, Fee: 2m, FeeBudgetItemId: fees.Id), CancellationToken.None);
        var home = await new AllotJar.Application.Transactions.Commands.CreateTransfer.CreateTransferCommandHandler(db, User)
            .Handle(new AllotJar.Application.Transactions.Commands.CreateTransfer.CreateTransferCommand(June3, 100m, eur.Id, eurSavings.Id, Fee: 2m, FeeBudgetItemId: fees.Id), CancellationToken.None);

        (await db.Transactions.SingleAsync(t => t.FeeForTransferId == foreign.Id)).FxPending.Should().BeTrue();
        (await db.Transactions.SingleAsync(t => t.FeeForTransferId == home.Id)).FxPending.Should().BeFalse();
        (await db.Transactions.SingleAsync(t => t.Id == foreign.Id)).FxPending.Should().BeFalse("a transfer never waits");
    }
}
