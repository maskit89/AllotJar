using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using FluentAssertions;

namespace AllotJar.Application.Tests.Domain;

public class JarReallocationRulesTests
{
    private static readonly DateOnly Date = new(2026, 9, 23);
    private readonly Account _account = new() { OwnerId = "household", Type = AccountType.Savings, OpeningBalance = 500m };
    private readonly Guid _holiday = Guid.NewGuid();
    private readonly Guid _repairs = Guid.NewGuid();

    private SavingsLedgerBalance Balance(decimal holiday = 100m, decimal repairs = 400m,
        Transaction? payment = null, Guid? chargedJar = null)
    {
        var jars = new[]
        {
            new Jar { Id = _holiday, OwnerId = _account.OwnerId, FundingAccountId = _account.Id },
            new Jar { Id = _repairs, OwnerId = _account.OwnerId, FundingAccountId = _account.Id },
        };
        var operations = new List<JarLedgerOperation>
        {
            new(Guid.NewGuid(), _account.OwnerId, _account.Id, Date, null,
                [new(_holiday, holiday), new(_repairs, repairs), new(null, -(holiday + repairs))]),
        };
        if (payment is not null)
            operations.Add(new(Guid.NewGuid(), _account.OwnerId, _account.Id, Date, payment.Id,
                [new(chargedJar, -payment.Amount)]));

        return ActualSavingsLedger.Calculate(_account, Date, Date, jars,
            payment is null ? [] : [payment], operations);
    }

    private Transaction Payment(decimal amount) => new()
    {
        OwnerId = _account.OwnerId, AccountId = _account.Id, Date = Date,
        Type = TransactionType.Expense, Amount = amount,
    };

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void HolidayWith100_CannotGive150_EvenThoughTheAccountHas500(bool bankTransfer)
    {
        var balance = Balance();
        JarReallocationRules.AvailableAmount(balance, _holiday, bankTransfer).Should().Be(100m);
        var act = () => JarReallocationRules.Validate(balance, _holiday, 150m, bankTransfer);

        act.Should().Throw<InvalidOperationException>().WithMessage("*another source*");
        balance.JarBalances![_holiday].Should().Be(100m);
        balance.JarBalances[_repairs].Should().Be(400m);
        balance.AccountBalance.Should().Be(500m);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExactAvailableSourceAmountIsAllowed_WithoutMovingMoneyDuringValidation(bool bankTransfer)
    {
        var balance = Balance();
        var act = () => JarReallocationRules.Validate(balance, _holiday, 100m, bankTransfer);
        act.Should().NotThrow();
        balance.JarBalances![_holiday].Should().Be(100m);
        balance.AccountBalance.Should().Be(500m);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-10)]
    public void ZeroOrNegativeSourceCannotFundAReallocation(decimal sourceAmount)
    {
        var balance = Balance(holiday: 0m,
            payment: sourceAmount < 0 ? Payment(-sourceAmount) : null, chargedJar: _holiday);
        JarReallocationRules.AvailableAmount(balance, _holiday, false).Should().Be(0m);
        var act = () => JarReallocationRules.Validate(balance, _holiday, 0.0001m, false);
        act.Should().Throw<InvalidOperationException>();
        balance.JarBalances![_holiday].Should().Be(sourceAmount);
    }

    [Fact]
    public void ActualSpendingCanStillMakeAJarNegative_ButThatJarCannotThenReallocateMoney()
    {
        var balance = Balance(payment: Payment(150m), chargedJar: _holiday);
        balance.AccountBalance.Should().Be(350m);
        balance.JarBalances![_holiday].Should().Be(-50m);
        var act = () => JarReallocationRules.Validate(balance, _holiday, 1m, false);
        act.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void CrossAccountMoveAlsoRequiresActualBankFunds_WithoutClampingSignedJarBalances()
    {
        // Repairs spent 450 after being allocated 400: bank has 50, Holiday still
        // shows 100, Repairs shows -50. A bank transfer can move at most 50.
        var balance = Balance(payment: Payment(450m), chargedJar: _repairs);
        JarReallocationRules.AvailableAmount(balance, _holiday, true).Should().Be(50m);
        var rejected = () => JarReallocationRules.Validate(balance, _holiday, 75m, true);
        rejected.Should().Throw<InvalidOperationException>();
        var allowed = () => JarReallocationRules.Validate(balance, _holiday, 50m, true);
        allowed.Should().NotThrow();
        balance.JarBalances![_holiday].Should().Be(100m);
        balance.JarBalances[_repairs].Should().Be(-50m);
    }

    [Fact]
    public void SameAccountReallocationCanCoverAnOverspentJar_WithoutDebitingTheBankAgain()
    {
        var balance = Balance(payment: Payment(450m), chargedJar: _repairs);
        JarReallocationRules.AvailableAmount(balance, _holiday, false).Should().Be(100m);
        var act = () => JarReallocationRules.Validate(balance, _holiday, 100m, false);
        act.Should().NotThrow();
        balance.AccountBalance.Should().Be(50m);
    }

    [Fact]
    public void UnallocatedMoneyCanBeSelectedExplicitly_ButOtherJarsAreNotBorrowedFrom()
    {
        var balance = Balance(holiday: 100m, repairs: 300m);
        JarReallocationRules.AvailableAmount(balance, null, false).Should().Be(100m);
        var act = () => JarReallocationRules.Validate(balance, null, 100.0001m, false);
        act.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void PrecisionIsPreserved_WithoutRoundingUpTheAvailableMoney()
    {
        var balance = Balance(holiday: 0.0001m, repairs: 0m);
        JarReallocationRules.AvailableAmount(balance, _holiday, false).Should().Be(0.0001m);
        var allowed = () => JarReallocationRules.Validate(balance, _holiday, 0.0001m, false);
        allowed.Should().NotThrow();
        var rejected = () => JarReallocationRules.Validate(balance, _holiday, 0.0002m, false);
        rejected.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void UnknownSourceJarIsRejected_RatherThanFallingBackToAccountMoney()
    {
        var act = () => JarReallocationRules.Validate(Balance(), Guid.NewGuid(), 10m, false);
        act.Should().Throw<InvalidOperationException>().WithMessage("*not part of this account*");
    }

    [Fact]
    public void BeforeOpeningSourceIsUnavailable_RatherThanZero()
    {
        var balance = ActualSavingsLedger.Calculate(_account, Date, Date.AddDays(-1), [], [], []);
        var act = () => JarReallocationRules.AvailableAmount(balance, null, false);
        act.Should().Throw<InvalidOperationException>().WithMessage("*unavailable*");
    }

    [Fact]
    public void AnAccountDeficitMustBeReconciled_EvenIfASourceJarShowsMoney()
    {
        var balance = Balance(payment: Payment(550m), chargedJar: _repairs);
        var act = () => JarReallocationRules.Validate(balance, _holiday, 10m, false);
        act.Should().Throw<InvalidOperationException>().WithMessage("*account deficit*");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void NonPositiveRequestsAreRejected(decimal amount)
    {
        var act = () => JarReallocationRules.Validate(Balance(), _holiday, amount, false);
        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
