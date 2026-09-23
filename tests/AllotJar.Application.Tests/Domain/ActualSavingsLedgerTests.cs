using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;
using FluentAssertions;

namespace AllotJar.Application.Tests.Domain;

public class ActualSavingsLedgerTests
{
    private static readonly DateOnly OpeningDate = new(2026, 9, 1);
    private readonly Account _account = new()
    {
        OwnerId = "household", Type = AccountType.Savings, Currency = CurrencyCode.Eur, OpeningBalance = 600m,
    };

    private Jar Jar(Account? account = null) => new()
    {
        OwnerId = _account.OwnerId, FundingAccountId = (account ?? _account).Id,
    };

    private Transaction Movement(decimal amount, TransactionType type = TransactionType.Income) => new()
    {
        OwnerId = _account.OwnerId, AccountId = _account.Id, Amount = amount,
        Type = type, Currency = _account.Currency, Date = OpeningDate,
    };

    private JarLedgerOperation Allocation(Transaction? transaction, params JarLedgerPosting[] postings) => new(
        Guid.NewGuid(), _account.OwnerId, _account.Id, transaction?.Date ?? OpeningDate, transaction?.Id, postings);

    private SavingsLedgerBalance Calculate(Jar[] jars, Transaction[] transactions, params JarLedgerOperation[] operations) =>
        ActualSavingsLedger.Calculate(_account, OpeningDate, new(2026, 9, 30), jars, transactions, operations);

    [Fact]
    public void JarDefinitionsAndLegacyOpeningAmountsDoNotCreateActualSavings()
    {
        var jar = Jar();
        jar.OpeningBalance = 600m;
        jar.TargetAmount = 1200m;
        var result = Calculate([jar], []);

        result.AccountBalance.Should().Be(600m);
        result.JarBalances![jar.Id].Should().Be(0m);
        result.Unallocated.Should().Be(600m);
    }

    [Fact]
    public void OpeningAllocationDividesExistingMoney_WithoutInventingADeposit()
    {
        var a = Jar();
        var b = Jar();
        var result = Calculate([a, b], [], Allocation(null, new JarLedgerPosting(a.Id, 300m), new JarLedgerPosting(b.Id, 200m), new JarLedgerPosting(null, -500m)));

        result.AccountBalance.Should().Be(600m);
        result.JarBalances![a.Id].Should().Be(300m);
        result.JarBalances[b.Id].Should().Be(200m);
        result.Unallocated.Should().Be(100m);
    }

    [Fact]
    public void ActualDepositCanBeSplitBetweenJarsAndExplicitUnallocatedRemainder()
    {
        var a = Jar();
        var b = Jar();
        var deposit = Movement(150.0001m);
        var result = Calculate([a, b], [deposit],
            Allocation(deposit, new JarLedgerPosting(a.Id, 100m), new JarLedgerPosting(b.Id, 40m), new JarLedgerPosting(null, 10.0001m)));

        result.AccountBalance.Should().Be(750.0001m);
        result.JarBalances![a.Id].Should().Be(100m);
        result.JarBalances[b.Id].Should().Be(40m);
        result.Unallocated.Should().Be(610.0001m);
    }

    [Fact]
    public void WithdrawalMayMakeAJarNegative_WithoutOverdrawingTheAccount()
    {
        var jar = Jar();
        var payment = Movement(75m, TransactionType.Expense);
        var result = Calculate([jar], [payment],
            Allocation(null, new JarLedgerPosting(jar.Id, 50m), new JarLedgerPosting(null, -50m)),
            Allocation(payment, new JarLedgerPosting(jar.Id, -75m)));

        result.AccountBalance.Should().Be(525m);
        result.JarBalances![jar.Id].Should().Be(-25m);
        result.Unallocated.Should().Be(550m);
        result.HasAccountDeficit.Should().BeFalse();
        (result.JarBalances.Values.Sum() + result.Unallocated).Should().Be(result.AccountBalance);
    }

    [Fact]
    public void SameAccountReallocationMovesOwnershipOnly_IncludingArchivedJars()
    {
        var a = Jar();
        var b = Jar();
        b.IsArchived = true;
        var result = Calculate([a, b], [],
            Allocation(null, new JarLedgerPosting(a.Id, 100m), new JarLedgerPosting(null, -100m)),
            Allocation(null, new JarLedgerPosting(a.Id, -40m), new JarLedgerPosting(b.Id, 40m)));

        result.AccountBalance.Should().Be(600m);
        result.JarBalances![a.Id].Should().Be(60m);
        result.JarBalances[b.Id].Should().Be(40m);
        result.Unallocated.Should().Be(500m);
    }

    [Fact]
    public void CompletedCrossAccountTransferMovesEachAccountAndJarOnce()
    {
        var destination = new Account
        {
            OwnerId = _account.OwnerId, Type = AccountType.Savings, Currency = CurrencyCode.Eur,
        };
        var a = Jar();
        var b = Jar(destination);
        var transfer = Movement(50m, TransactionType.Transfer);
        transfer.TransferAccountId = destination.Id;
        var source = Calculate([a], [transfer],
            Allocation(null, new JarLedgerPosting(a.Id, 100m), new JarLedgerPosting(null, -100m)), Allocation(transfer, new JarLedgerPosting(a.Id, -50m)));
        var incoming = new JarLedgerOperation(Guid.NewGuid(), destination.OwnerId, destination.Id,
            transfer.Date, transfer.Id, [new JarLedgerPosting(b.Id, 50m)]);
        var target = ActualSavingsLedger.Calculate(destination, OpeningDate, OpeningDate, [b], [transfer], [incoming]);

        source.AccountBalance.Should().Be(550m);
        target.AccountBalance.Should().Be(50m);
        source.JarBalances![a.Id].Should().Be(50m);
        target.JarBalances![b.Id].Should().Be(50m);
        (source.AccountBalance + target.AccountBalance).Should().Be(600m);
        (source.Unallocated + target.Unallocated).Should().Be(500m);
    }

    [Fact]
    public void AccountOverdraftRemainsVisible_ToBeRejectedByTheWritePath()
    {
        var jar = Jar();
        var payment = Movement(650m, TransactionType.Expense);
        var result = Calculate([jar], [payment], Allocation(payment, new JarLedgerPosting(jar.Id, -650m)));
        result.AccountBalance.Should().Be(-50m);
        result.HasAccountDeficit.Should().BeTrue();
    }

    [Fact]
    public void OverallocatedOpeningMoneyIsVisible_EvenWhenTheBankAccountIsPositive()
    {
        var jar = Jar();
        var result = Calculate([jar], [],
            Allocation(null, new JarLedgerPosting(jar.Id, 650m), new JarLedgerPosting(null, -650m)));

        result.AccountBalance.Should().Be(600m);
        result.Unallocated.Should().Be(-50m);
        result.HasUnallocatedDeficit.Should().BeTrue();
        result.HasAccountDeficit.Should().BeFalse();
    }

    [Fact]
    public void BeforeOpening_AllMonetaryValuesAreUnavailable()
    {
        var result = ActualSavingsLedger.Calculate(_account, OpeningDate, OpeningDate.AddDays(-1), [], [], []);
        result.IsAvailable.Should().BeFalse();
        result.AccountBalance.Should().BeNull();
        result.JarBalances.Should().BeNull();
        result.Unallocated.Should().BeNull();
    }

    [Fact]
    public void PastMonthIgnoresPreOpeningHistoryAndFutureAllocations()
    {
        var jar = Jar();
        var prior = Movement(200m);
        prior.Date = OpeningDate.AddDays(-1);
        var future = Movement(100m);
        future.Date = new(2026, 10, 1);
        var result = Calculate([jar], [prior, future],
            Allocation(prior, new JarLedgerPosting(jar.Id, 200m)), Allocation(future, new JarLedgerPosting(jar.Id, 100m)));
        result.AccountBalance.Should().Be(600m);
        result.JarBalances![jar.Id].Should().Be(0m);
        result.Unallocated.Should().Be(600m);
    }

    [Theory]
    [InlineData(TransactionType.Income)]
    [InlineData(TransactionType.Expense)]
    [InlineData(TransactionType.Transfer)]
    public void MissingAllocationsDoNotSilentlySelectAJarOrUnallocatedFunds(TransactionType type)
    {
        var transaction = Movement(10m, type);
        if (type == TransactionType.Transfer) transaction.TransferAccountId = Guid.NewGuid();
        var act = () => Calculate([], [transaction]);
        act.Should().Throw<InvalidOperationException>().WithMessage("*explicit*allocation*");
    }

    [Theory]
    [InlineData(9)]
    [InlineData(11)]
    public void TransactionAllocationsMustExactlyMatchActualAmount(decimal allocated)
    {
        var jar = Jar();
        var deposit = Movement(10m);
        var act = () => Calculate([jar], [deposit], Allocation(deposit, new JarLedgerPosting(jar.Id, allocated)));
        act.Should().Throw<InvalidOperationException>().WithMessage("*conserve*");
    }

    [Fact]
    public void CorrectTotalCannotHideAnOppositeDirectionPosting()
    {
        var jar = Jar();
        var deposit = Movement(10m);
        var act = () => Calculate([jar], [deposit], Allocation(deposit, new JarLedgerPosting(jar.Id, 20m), new JarLedgerPosting(null, -10m)));
        act.Should().Throw<InvalidOperationException>().WithMessage("*direction*");
    }

    [Fact]
    public void ReallocationCannotCreateAccountMoney()
    {
        var jar = Jar();
        var act = () => Calculate([jar], [], Allocation(null, new JarLedgerPosting(jar.Id, 10m)));
        act.Should().Throw<InvalidOperationException>().WithMessage("*zero*");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void JarMustBelongToTheOwnerAndDesignateThisAccount(bool foreignOwner)
    {
        var jar = Jar();
        if (foreignOwner) jar.OwnerId = "another-household";
        else jar.FundingAccountId = Guid.NewGuid();
        var act = () => Calculate([jar], [], Allocation(null, new JarLedgerPosting(jar.Id, 10m), new JarLedgerPosting(null, -10m)));
        act.Should().Throw<InvalidOperationException>().WithMessage("*designate this savings account*");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void DuplicateOperationOrTransactionLegCannotBeAppliedTwice(bool sameOperation)
    {
        var jar = Jar();
        var deposit = Movement(10m);
        var operation = Allocation(deposit, new JarLedgerPosting(jar.Id, 10m));
        var duplicate = sameOperation ? operation : operation with { Id = Guid.NewGuid() };
        var act = () => Calculate([jar], [deposit], operation, duplicate);
        act.Should().Throw<InvalidOperationException>();
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AllocationMustReferenceTheActualTransactionAndDate(bool wrongDate)
    {
        var deposit = Movement(10m);
        var operation = Allocation(deposit, new JarLedgerPosting(null, 10m));
        operation = wrongDate ? operation with { Date = OpeningDate.AddDays(1) }
            : operation with { TransactionId = Guid.NewGuid() };
        var act = () => Calculate([], [deposit], operation);
        act.Should().Throw<InvalidOperationException>().WithMessage("*transaction account and date*");
    }

    [Fact]
    public void NonSavingsAccountsCannotBackAJar()
    {
        _account.Type = AccountType.Current;
        var act = () => Calculate([], []);
        act.Should().Throw<InvalidOperationException>().WithMessage("*savings account*");
    }
}
