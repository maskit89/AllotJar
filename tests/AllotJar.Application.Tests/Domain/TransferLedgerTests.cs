using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;
using FluentAssertions;

namespace AllotJar.Application.Tests.Domain;

public class TransferLedgerTests
{
    private static readonly DateOnly Opening = new(2026, 9, 1);
    private static readonly DateOnly Departure = new(2026, 9, 30);
    private static readonly DateOnly Receipt = new(2026, 10, 1);
    private readonly Account _source = new()
    {
        OwnerId = "household", Type = AccountType.Savings, OpeningBalance = 1000m,
    };
    private readonly Account _destination = new()
    {
        OwnerId = "household", Type = AccountType.Savings, OpeningBalance = 200m,
    };
    private readonly Guid _holiday = Guid.NewGuid();
    private readonly Guid _repairs = Guid.NewGuid();
    private readonly Guid _gift = Guid.NewGuid();

    private Transaction Transfer() => new()
    {
        OwnerId = _source.OwnerId, AccountId = _source.Id, TransferAccountId = _destination.Id,
        Type = TransactionType.Transfer, Amount = 100m,
        // Deliberately unrelated: the legacy single date must not control either bank leg.
        Date = new(2026, 12, 31),
    };

    private Dictionary<Guid, TransferPostingDates> Dates(Transaction transfer, TransferPostingDates dates) =>
        new() { [transfer.Id] = dates };

    private JarLedgerOperation Operation(Account account, Guid? transactionId, DateOnly date,
        params JarLedgerPosting[] postings) =>
        new(Guid.NewGuid(), account.OwnerId, account.Id, date, transactionId, postings);

    private (SavingsLedgerBalance Source, SavingsLedgerBalance Destination, TransferLedgerPosition Position) Snapshot(
        Transaction transfer, TransferPostingDates dates, DateOnly asOf,
        DateOnly? overrideReceiptAllocationDate = null, bool duplicateReceipt = false)
    {
        var jars = new[]
        {
            new Jar { Id = _holiday, OwnerId = _source.OwnerId, FundingAccountId = _source.Id },
            new Jar { Id = _repairs, OwnerId = _source.OwnerId, FundingAccountId = _source.Id },
            new Jar { Id = _gift, OwnerId = _destination.OwnerId, FundingAccountId = _destination.Id },
        };
        var operations = new List<JarLedgerOperation>
        {
            Operation(_source, null, Opening, new(_holiday, 600m), new(_repairs, 400m), new(null, -1000m)),
            Operation(_destination, null, Opening, new(_gift, 200m), new(null, -200m)),
            Operation(_source, transfer.Id, dates.DepartedOn, new JarLedgerPosting(_holiday, -100m)),
        };
        if (dates.ReceivedOn.HasValue || overrideReceiptAllocationDate is not null)
        {
            var receiptOperation = Operation(_destination, transfer.Id,
                overrideReceiptAllocationDate ?? dates.ReceivedOn!.Value, new JarLedgerPosting(_gift, 100m));
            operations.Add(receiptOperation);
            if (duplicateReceipt) operations.Add(receiptOperation with { Id = Guid.NewGuid() });
        }
        var postingDates = Dates(transfer, dates);
        return (
            ActualSavingsLedger.Calculate(_source, Opening, asOf, jars, [transfer], operations, postingDates),
            ActualSavingsLedger.Calculate(_destination, Opening, asOf, jars, [transfer], operations, postingDates),
            TransferLedger.Calculate(transfer, dates, asOf));
    }

    [Theory]
    [InlineData(9, 29, 1000, 200, 600, 200, 0)]
    [InlineData(9, 30, 900, 200, 500, 200, 100)]
    [InlineData(10, 1, 900, 300, 500, 300, 0)]
    public void EachBankAndJarUsesItsOwnPostingDate_AndTransitConservesTheTotal(
        int month, int day, decimal sourceBank, decimal destinationBank,
        decimal holiday, decimal gift, decimal transit)
    {
        var result = Snapshot(Transfer(), new(Departure, Receipt), new(2026, month, day));
        result.Source.AccountBalance.Should().Be(sourceBank);
        result.Destination.AccountBalance.Should().Be(destinationBank);
        result.Source.JarBalances![_holiday].Should().Be(holiday);
        result.Source.JarBalances[_repairs].Should().Be(400m);
        result.Destination.JarBalances![_gift].Should().Be(gift);
        result.Position.UnsettledAmount.Should().Be(transit);
        (result.Source.AccountBalance + result.Destination.AccountBalance + result.Position.UnsettledAmount)
            .Should().Be(1200m);
        JarReallocationRules.ValidateResult(result.Source);
        JarReallocationRules.ValidateResult(result.Destination);
    }

    [Fact]
    public void UnknownReceiptStaysInTransit_WithoutInventingADateOrFundingTheDestination()
    {
        var result = Snapshot(Transfer(), new(Departure, null), new(2027, 1, 15));
        result.Source.AccountBalance.Should().Be(900m);
        result.Destination.AccountBalance.Should().Be(200m);
        result.Destination.JarBalances![_gift].Should().Be(200m);
        result.Position.DebitedAmount.Should().Be(100m);
        result.Position.CreditedAmount.Should().Be(0m);
        result.Position.UnsettledAmount.Should().Be(100m);
    }

    [Fact]
    public void RecordingReceiptChangesArrivalAndLaterBalances_WithoutRewritingSeptember()
    {
        var transfer = Transfer();
        var pendingDates = new TransferPostingDates(Departure, null);
        var beforeConfirmation = Snapshot(transfer, pendingDates, Receipt);
        var confirmedDates = pendingDates with { ReceivedOn = Receipt };
        var atArrival = Snapshot(transfer, confirmedDates, Receipt);
        var septemberAfterConfirmation = Snapshot(transfer, confirmedDates, Departure);

        beforeConfirmation.Destination.AccountBalance.Should().Be(200m);
        atArrival.Destination.AccountBalance.Should().Be(300m);
        atArrival.Destination.JarBalances![_gift].Should().Be(300m);
        atArrival.Position.UnsettledAmount.Should().Be(0m);
        septemberAfterConfirmation.Destination.AccountBalance.Should().Be(200m);
        septemberAfterConfirmation.Destination.JarBalances![_gift].Should().Be(200m);
        septemberAfterConfirmation.Position.UnsettledAmount.Should().Be(100m);
        pendingDates.ReceivedOn.Should().BeNull();
    }

    [Fact]
    public void UnconfirmedReceiptCannotBeFundedByAddingAJarAllocation()
    {
        var act = () => Snapshot(Transfer(), new(Departure, null), Receipt,
            overrideReceiptAllocationDate: Receipt);
        act.Should().Throw<InvalidOperationException>().WithMessage("*transaction account and date*");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ReceiptAllocationMustUseTheReceivingDate_NotDepartureOrLegacyDate(bool useDeparture)
    {
        var transfer = Transfer();
        var act = () => Snapshot(transfer, new(Departure, Receipt), transfer.Date,
            overrideReceiptAllocationDate: useDeparture ? Departure : transfer.Date);
        act.Should().Throw<InvalidOperationException>().WithMessage("*transaction account and date*");
    }

    [Fact]
    public void DuplicateReceiptAllocationCannotFundTheJarTwice()
    {
        var act = () => Snapshot(Transfer(), new(Departure, Receipt), Receipt, duplicateReceipt: true);
        act.Should().Throw<InvalidOperationException>().WithMessage("*only be allocated once*");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void BothAccountsRequireExplicitPostingDates_EvenWhenLegacyDateIsPresent(bool source)
    {
        var act = () => ActualAccountLedger.Calculate(source ? _source : _destination, Opening,
            new(2027, 1, 1), [Transfer()]);
        act.Should().Throw<InvalidOperationException>().WithMessage("*explicit bank posting dates*");
    }

    [Fact]
    public void PostingDatesForAnotherTransferCannotBeUsedAsAFallback()
    {
        var act = () => ActualAccountLedger.Calculate(_source, Opening, Departure, [Transfer()],
            new Dictionary<Guid, TransferPostingDates> { [Guid.NewGuid()] = new(Departure, Receipt) });
        act.Should().Throw<InvalidOperationException>().WithMessage("*explicit bank posting dates*");
    }

    [Fact]
    public void OpeningCutoffsAreAppliedToEachBankLegIndependently()
    {
        var transfer = Transfer();
        _source.OpeningBalance = 900m; // Source opening already includes September's debit.
        var dates = Dates(transfer, new(Departure, Receipt));
        ActualAccountLedger.Calculate(_source, Receipt, Receipt, [transfer], dates)
            .Balance.Should().Be(900m);
        ActualAccountLedger.Calculate(_destination, Departure, Receipt, [transfer], dates)
            .Balance.Should().Be(300m);
    }

    [Fact]
    public void OtherOwnersTransfersDoNotRequireOrLeakPostingDetails()
    {
        var transfer = Transfer();
        transfer.OwnerId = "other-household";
        ActualAccountLedger.Calculate(_source, Opening, Receipt, [transfer])
            .Balance.Should().Be(1000m);
    }

    [Fact]
    public void TransitRetainsTheAuthoritativeAmountAndCurrency_WithoutFxOrRounding()
    {
        var transfer = Transfer();
        transfer.Currency = CurrencyCode.From("GBP");
        transfer.Amount = 1.2345m;
        transfer.ExchangeRate = 9m;
        var result = TransferLedger.Calculate(transfer, new(Departure, null), Departure);
        result.Currency.Should().Be(CurrencyCode.From("GBP"));
        result.UnsettledAmount.Should().Be(1.2345m);
    }

    [Fact]
    public void SuppliedBankDatesAreNotOverwrittenWhenTheirPostingOrderDiffers()
    {
        // Read-only reconciliation of explicit dates, not approval of a receipt-first
        // import workflow. An outstanding debit must not masquerade as extra income.
        var result = Snapshot(Transfer(), new(Receipt.AddDays(1), Receipt), Receipt);
        result.Source.AccountBalance.Should().Be(1000m);
        result.Destination.AccountBalance.Should().Be(300m);
        result.Position.UnsettledAmount.Should().Be(-100m);
        (result.Source.AccountBalance + result.Destination.AccountBalance + result.Position.UnsettledAmount)
            .Should().Be(1200m);
    }

    [Fact]
    public void OrdinaryTransactionsCannotBeTreatedAsTransfers()
    {
        var transaction = Transfer();
        transaction.Type = TransactionType.Income;
        var act = () => TransferLedger.Calculate(transaction, new(Departure, Receipt), Receipt);
        act.Should().Throw<InvalidOperationException>().WithMessage("*requires a transfer*");
    }
}
