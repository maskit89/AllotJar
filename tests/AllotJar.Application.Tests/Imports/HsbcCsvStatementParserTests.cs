using FluentAssertions;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Imports.Models;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

public class HsbcCsvStatementParserTests
{
    private static readonly HsbcCsvStatementParser Parser = new();

    [Fact]
    public void Format_IsHsbcCsv() => Parser.Format.Should().Be(StatementFormat.HsbcCsv);

    [Fact]
    public void Parse_SkipsBlankAndHeaderRows()
    {
        var statement = Parser.Parse(HsbcCsvSamples.Mixed);

        statement.Iban.Should().BeNull();
        statement.Entries.Should().HaveCount(6); // 8 lines minus the blank and the header
    }

    [Fact]
    public void Parse_UsesPurchaseDate_NotPostingDate()
    {
        // AUTOMARKET row: posted 19/06 but purchased 17/06 — the purchase date wins.
        var entry = Parser.Parse(HsbcCsvSamples.Mixed).Entries[0];

        entry.BookingDate.Should().Be(new DateOnly(2026, 6, 17));
        entry.Payee.Should().Be("AUTOMARKET SER STATION");
    }

    [Fact]
    public void Parse_NegativeAmount_IsDebit_WithPositiveMagnitude()
    {
        var entry = Parser.Parse(HsbcCsvSamples.Mixed).Entries[0]; // -35.00

        entry.IsCredit.Should().BeFalse();
        entry.Amount.Should().Be(35.00m); // stored as a positive magnitude
        entry.Currency.Should().Be("EUR");
    }

    [Fact]
    public void Parse_PositiveAmount_IsCredit()
    {
        var credit = Parser.Parse(HsbcCsvSamples.Mixed).Entries
            .Single(e => e.Payee == "E-BANKING PAYMENT");

        credit.IsCredit.Should().BeTrue();
        credit.Amount.Should().Be(234.24m);
    }

    [Fact]
    public void Parse_QuotedThousandsAmount_IsParsed()
    {
        var pillars = Parser.Parse(HsbcCsvSamples.Mixed).Entries
            .Single(e => e.Payee == "4 PILLARS");

        pillars.Amount.Should().Be(1770.00m);
        pillars.IsCredit.Should().BeFalse();
    }

    [Theory]
    [InlineData("PAYPAL *TEMU")]      // asterisk inside the merchant name + a separator
    [InlineData("REVOLUT**0573*")]    // doubled asterisks inside the merchant name
    public void Parse_KeepsAsterisksInsideMerchantNames(string expectedPayee)
    {
        var entries = Parser.Parse(HsbcCsvSamples.Mixed).Entries;

        entries.Should().ContainSingle(e => e.Payee == expectedPayee);
    }

    [Fact]
    public void Parse_AllReferencesArePrefixed_AndUnique()
    {
        var refs = Parser.Parse(HsbcCsvSamples.Mixed).Entries.Select(e => e.Reference).ToList();

        refs.Should().OnlyContain(r => r!.StartsWith("hsbc:"));
        refs.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Parse_IsDeterministic_AcrossRuns()
    {
        var first = Parser.Parse(HsbcCsvSamples.Mixed).Entries.Select(e => e.Reference);
        var second = Parser.Parse(HsbcCsvSamples.Mixed).Entries.Select(e => e.Reference);

        second.Should().Equal(first); // same input → same references → idempotent re-import
    }

    [Fact]
    public void Parse_FourIdenticalCharges_ProduceFourDistinctReferences()
    {
        var entries = Parser.Parse(HsbcCsvSamples.FourIdenticalCharges).Entries;

        entries.Should().HaveCount(4);
        entries.Select(e => e.Reference).Should().OnlyHaveUniqueItems(); // not collapsed to one
        entries.Should().OnlyContain(e => e.Amount == 40.00m && !e.IsCredit);
    }

    [Fact]
    public void Parse_EmptyContent_Throws() =>
        FluentActions.Invoking(() => Parser.Parse("   "))
            .Should().Throw<StatementParseException>();

    [Fact]
    public void Parse_NoBookableRows_Throws() =>
        FluentActions.Invoking(() => Parser.Parse("Date,Details,Amount"))
            .Should().Throw<StatementParseException>();
}
