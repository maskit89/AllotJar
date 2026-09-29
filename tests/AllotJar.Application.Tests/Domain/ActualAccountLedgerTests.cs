using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;
using FluentAssertions;

namespace AllotJar.Application.Tests.Domain;

public class ActualAccountLedgerTests
{
    private static readonly DateOnly OpeningDate = new(2026, 9, 1);
    private static Account Account() => new()
    {
        OwnerId = "household", Name = "Savings", Type = AccountType.Savings,
        OpeningBalance = 600m, Currency = CurrencyCode.Eur,
    };

    private static Transaction Movement(Account account, TransactionType type, decimal amount, DateOnly date) => new()
    {
        OwnerId = account.OwnerId, AccountId = account.Id, Type = type,
        Amount = amount, Date = date, Currency = account.Currency,
    };

    [Fact]
    public void OpeningIsAtStartOfDate_EarlierHistoryDoesNotCountAgain_AndLaterMonthsDoNotLeak()
    {
        var account = Account();
        var transactions = new[]
        {
            Movement(account, TransactionType.Income, 400m, new(2026, 8, 31)),
            Movement(account, TransactionType.Income, 100m, OpeningDate),
            Movement(account, TransactionType.Expense, 25m, new(2026, 9, 30)),
            Movement(account, TransactionType.Income, 300m, new(2026, 10, 1)),
        };

        ActualAccountLedger.Calculate(account, OpeningDate, new(2026, 9, 30), transactions)
            .Balance.Should().Be(675m);
        ActualAccountLedger.Calculate(account, OpeningDate, new(2026, 10, 1), transactions)
            .Balance.Should().Be(975m);
    }

    [Fact]
    public void BeforeOpening_IsUnavailable_NotZeroOrAReverseCalculatedBalance()
    {
        var account = Account();
        var result = ActualAccountLedger.Calculate(account, OpeningDate, OpeningDate.AddDays(-1),
            [Movement(account, TransactionType.Income, 400m, OpeningDate.AddDays(-1))]);

        result.IsAvailable.Should().BeFalse();
        result.Balance.Should().BeNull();
    }

    [Fact]
    public void UsesAuthoritativeAccountAmount_WithoutConvertingOrSummingBudgetSplits()
    {
        var account = Account();
        var transaction = Movement(account, TransactionType.Expense, 1.2345m, OpeningDate);
        transaction.FxPending = true; // This concerns the budget-currency amount, not the known account charge.
        transaction.Splits.Add(new TransactionSplit { Amount = 0.5m });
        transaction.Splits.Add(new TransactionSplit { Amount = 0.7345m });

        ActualAccountLedger.Calculate(account, OpeningDate, OpeningDate, [transaction])
            .Balance.Should().Be(598.7655m);
    }

    [Fact]
    public void BackdatedCorrectionChangesLaterBalances_ButNotEarlierSnapshots()
    {
        var account = Account();
        var transaction = Movement(account, TransactionType.Expense, 50m, new(2026, 9, 10));
        transaction.Amount = 70m;

        ActualAccountLedger.Calculate(account, OpeningDate, new(2026, 9, 9), [transaction])
            .Balance.Should().Be(600m);
        ActualAccountLedger.Calculate(account, OpeningDate, new(2026, 9, 30), [transaction])
            .Balance.Should().Be(530m);
    }

    [Fact]
    public void UnrelatedAccountsAndOtherOwnersCannotAffectTheBalance()
    {
        var account = Account();
        var unrelated = Movement(Account(), TransactionType.Income, 100m, OpeningDate);
        var foreign = Movement(account, TransactionType.Income, 200m, OpeningDate);
        foreign.OwnerId = "another-household";

        ActualAccountLedger.Calculate(account, OpeningDate, OpeningDate, [unrelated, foreign])
            .Balance.Should().Be(600m);
    }

    [Fact]
    public void TransferUsesEachAccountsOwnOpeningCutoff()
    {
        var source = Account();
        var destination = Account();
        destination.OpeningBalance = 150m; // Already includes the earlier transfer.
        var transfer = Movement(source, TransactionType.Transfer, 50m, OpeningDate);
        transfer.TransferAccountId = destination.Id;
        var dates = new Dictionary<Guid, TransferPostingDates>
        {
            [transfer.Id] = new(OpeningDate, OpeningDate),
        };

        ActualAccountLedger.Calculate(source, OpeningDate, OpeningDate.AddDays(2), [transfer], dates)
            .Balance.Should().Be(550m);
        ActualAccountLedger.Calculate(destination, OpeningDate.AddDays(1), OpeningDate.AddDays(2), [transfer], dates)
            .Balance.Should().Be(150m);
    }

    [Fact]
    public void DuplicateTransactionIdentityIsRejected_InsteadOfDoubleCounting()
    {
        var account = Account();
        var transaction = Movement(account, TransactionType.Income, 10m, OpeningDate);
        var act = () => ActualAccountLedger.Calculate(account, OpeningDate, OpeningDate, [transaction, transaction]);
        act.Should().Throw<InvalidOperationException>().WithMessage("*twice*");
    }

    [Fact]
    public void ForeignCurrencyCannotBecomeAnAssumedOneToOneAmount()
    {
        var account = Account();
        var transaction = Movement(account, TransactionType.Expense, 10m, OpeningDate);
        transaction.Currency = CurrencyCode.From("GBP");
        var act = () => ActualAccountLedger.Calculate(account, OpeningDate, OpeningDate, [transaction]);
        act.Should().Throw<InvalidOperationException>().WithMessage("*account currency*");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-10)]
    public void InvalidSignedTransactionMagnitudeIsRejected(decimal amount)
    {
        var account = Account();
        var transaction = Movement(account, TransactionType.Expense, amount, OpeningDate);
        var act = () => ActualAccountLedger.Calculate(account, OpeningDate, OpeningDate, [transaction]);
        act.Should().Throw<InvalidOperationException>().WithMessage("*positive*");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TransferRequiresADistinctDestination(bool selfTransfer)
    {
        var account = Account();
        var transaction = Movement(account, TransactionType.Transfer, 10m, OpeningDate);
        transaction.TransferAccountId = selfTransfer ? account.Id : null;
        var act = () => ActualAccountLedger.Calculate(account, OpeningDate, OpeningDate, [transaction]);
        act.Should().Throw<InvalidOperationException>().WithMessage("*distinct accounts*");
    }
}
