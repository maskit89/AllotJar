using FluentAssertions;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// <see cref="AllotJar.Application.Common.Interfaces.IStatementParser.CanParse"/> is what routes a
/// "generic" upload to the right dedicated adapter, so the same file always takes the same code
/// path (same payees, same idempotency references). These tests pin the sniffing behaviour.
/// </summary>
public class StatementSniffTests
{
    private const string PlainGenericCsv =
        "Date,Description,Amount\n" +
        "2026-06-20,TESCO STORES,-42.50\n" +
        "2026-06-21,SALARY ACME,2500.00\n";

    // dd/MM/yyyy dates like HSBC's, but a plain description column — must NOT sniff as HSBC.
    private const string GenericCsvWithUkDates =
        "20/06/2026,TESCO STORES,-42.50\n" +
        "21/06/2026,SALARY ACME,2500.00\n";

    [Fact]
    public void Hsbc_CanParse_RecognisesTheTransactionHistoryShape()
    {
        var parser = new HsbcCsvStatementParser();

        parser.CanParse(HsbcCsvSamples.Mixed).Should().BeTrue();
        parser.CanParse(HsbcCsvSamples.FourIdenticalCharges).Should().BeTrue();
    }

    [Fact]
    public void Hsbc_CanParse_RejectsGenericCsvs_EvenWithUkStyleDates()
    {
        var parser = new HsbcCsvStatementParser();

        parser.CanParse(PlainGenericCsv).Should().BeFalse();
        parser.CanParse(GenericCsvWithUkDates).Should().BeFalse();
        parser.CanParse("").Should().BeFalse();
        parser.CanParse(Camt053Samples.ThreeEntries).Should().BeFalse();
    }

    [Fact]
    public void Camt_CanParse_RecognisesCamt053Xml_AndRejectsCsv()
    {
        var parser = new Camt053StatementParser();

        parser.CanParse(Camt053Samples.ThreeEntries).Should().BeTrue();
        parser.CanParse(PlainGenericCsv).Should().BeFalse();
        parser.CanParse(HsbcCsvSamples.Mixed).Should().BeFalse();
        parser.CanParse("").Should().BeFalse();
    }
}
