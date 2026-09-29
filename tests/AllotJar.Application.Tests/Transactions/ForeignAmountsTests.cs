using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using NSubstitute;
using Xunit;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.ImportStatement;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Tests.Imports;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.ConfirmConvertedAmount;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
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

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly ICurrentUser User = new CurrentUserStub(Owner);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-w08-{Guid.NewGuid()}")
            .Options);

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
        var handler = new ImportStatementCommandHandler(db, User, new[] { new Camt053StatementParser() });

        // Two EUR entries and one GBP (London Cab, 45.50).
        var result = await handler.Handle(new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);
        result.AwaitingAmount.Should().Be(1);

        var gbp = await db.Transactions.SingleAsync(t => t.Currency == CurrencyCode.From("GBP"));
        gbp.FxPending.Should().BeTrue();
        gbp.Amount.Should().Be(45.50m, "the amount as recorded, never multiplied by a rate");
        (await db.Transactions.Where(t => t.Currency == CurrencyCode.Eur).ToListAsync())
            .Should().OnlyContain(t => !t.FxPending);

        // Re-importing the same statement is not a retry of anything: the row still waits.
        await handler.Handle(new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);
        db.ChangeTracker.Clear();
        (await db.Transactions.SingleAsync(t => t.Currency == CurrencyCode.From("GBP"))).FxPending.Should().BeTrue();
    }

    [Fact]
    public async Task Without_a_budget_month_the_owners_currency_decides_what_waits_not_EUR()
    {
        await using var db = NewContext();
        var handler = new ImportStatementCommandHandler(db, User, new[] { new Camt053StatementParser() }, Prefers("GBP"));

        await handler.Handle(new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);

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
    [InlineData("EUR", 10)]
    [InlineData("EURO", 10)]
    [InlineData("USD", 0)]
    public async Task A_suggestion_needs_another_currency_and_a_positive_amount(string currency, int amount)
    {
        await using var db = NewContext();
        SeedMonth(db);
        var rates = new FakeExchangeRateProvider(1.1m);

        var act = () => new GetConversionSuggestionQueryHandler(db, User, rates)
            .Handle(new GetConversionSuggestionQuery(currency, amount, June3), CancellationToken.None);

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
    public async Task Only_a_waiting_row_on_no_account_and_not_split_can_be_given_an_amount()
    {
        await using var db = NewContext();
        SeedMonth(db);
        var counted = new Transaction
        {
            OwnerId = Owner, Date = June3, Payee = "Grocer", Amount = 20m, Currency = CurrencyCode.Eur, Type = TransactionType.Expense,
        };
        var legacyAccount = LedgerFixtures.SeedAccount(db, Owner, "UK card", currency: "GBP");
        var onAccount = Waiting();
        onAccount.AccountId = legacyAccount.Id;
        var split = Waiting();
        split.Splits.Add(new TransactionSplit { Amount = 20m });
        split.Splits.Add(new TransactionSplit { Amount = 25.50m });
        db.Transactions.AddRange(counted, onAccount, split);
        await db.SaveChangesAsync();
        var handler = new ConfirmConvertedAmountCommandHandler(db, User);

        foreach (var (row, why) in new[] { (counted, "already counts"), (onAccount, "account's balance"), (split, "is split") })
        {
            var act = () => handler.Handle(new ConfirmConvertedAmountCommand(row.Id, 50m), CancellationToken.None);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["Amount"].Single().Should().Contain(why);
        }
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
}
