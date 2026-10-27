using AllotJar.Application.Common.Exceptions;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

public class Camt053StatementParserTests
{
    private readonly Camt053StatementParser _parser = new();

    [Fact]
    public void Parse_ReadsAllEntries()
    {
        var statement = _parser.Parse(Camt053Samples.ThreeEntries);

        Assert.Equal(3, statement.Entries.Count);
    }

    [Fact]
    public void Parse_MapsDebitEntry()
    {
        var rent = _parser.Parse(Camt053Samples.ThreeEntries).Entries[0];

        Assert.Equal(1100.00m, rent.Amount);
        Assert.Equal("EUR", rent.Currency);
        Assert.False(rent.IsCredit); // DBIT
        Assert.Equal(new DateOnly(2026, 6, 1), rent.BookingDate);
        Assert.Equal("Landlord GmbH", rent.Payee); // creditor for a debit
        Assert.Equal("REF-RENT-001", rent.Reference);
    }

    [Fact]
    public void Parse_MapsCreditEntry_UsesDebtorAsPayee()
    {
        var salary = _parser.Parse(Camt053Samples.ThreeEntries).Entries[1];

        Assert.Equal(3000.00m, salary.Amount);
        Assert.True(salary.IsCredit); // CRDT
        Assert.Equal("ACME Payroll", salary.Payee); // debtor for a credit
        Assert.Equal("REF-SALARY-001", salary.Reference);
    }

    [Fact]
    public void Parse_FallsBackToEndToEndId_AndKeepsForeignCurrency()
    {
        var taxi = _parser.Parse(Camt053Samples.ThreeEntries).Entries[2];

        Assert.Equal(45.50m, taxi.Amount);
        Assert.Equal("GBP", taxi.Currency);
        Assert.Equal("London Cab", taxi.Payee);
        Assert.Equal("E2E-TAXI-9", taxi.Reference); // no AcctSvcrRef -> EndToEndId
    }

    [Fact]
    public void Parse_MalformedXml_Throws()
    {
        Assert.Throws<StatementParseException>(() => _parser.Parse("<not-closed>"));
    }

    [Fact]
    public void Parse_NonStatementXml_Throws()
    {
        Assert.Throws<StatementParseException>(() => _parser.Parse("<Document><Foo/></Document>"));
    }
}
