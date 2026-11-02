using AllotJar.Application.Common.Exceptions;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Holistic review of 2 Nov 2026: camt.053 dates written as date-times (M1), files with more
/// than one statement (M2), pending entries, and CSV fields with a line break inside quotes (L2).
/// Every row here is made up.
/// </summary>
public class StatementParsingReviewFixesTests
{
    private readonly Camt053StatementParser _camt = new();
    private readonly GenericCsvImporter _csv = new();

    private static string Ntry(string amount, string indicator, string bookingDate, string reference, string? status = null) =>
        $"""
        <Ntry>
          <Amt Ccy="EUR">{amount}</Amt>
          <CdtDbtInd>{indicator}</CdtDbtInd>
          {status}
          <BookgDt>{bookingDate}</BookgDt>
          <AcctSvcrRef>{reference}</AcctSvcrRef>
          <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Shop</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
        </Ntry>
        """;

    private static string Stmt(string entries, string iban = "DE89370400440532013000", string ccy = "EUR") =>
        $"""
        <Stmt>
          <Id>S</Id>
          <Acct><Id><IBAN>{iban}</IBAN></Id><Ccy>{ccy}</Ccy></Acct>
          {entries}
        </Stmt>
        """;

    private static string Document(params string[] statements) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        + "<Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt>"
        + string.Concat(statements)
        + "</BkToCstmrStmt></Document>";

    // --- M1: the bank's own calendar day ---------------------------------------------------

    [Theory]
    [InlineData("2026-10-01T00:15:00+02:00", 2026, 10, 1)] // was 30 Sep (moved to UTC)
    [InlineData("2026-09-30T22:30:00-05:00", 2026, 9, 30)] // was 1 Oct (moved to UTC)
    [InlineData("2026-10-01T18:00:00", 2026, 10, 1)]       // no offset: was read in the server's zone
    [InlineData("2026-10-01T23:59:59.123Z", 2026, 10, 1)]
    [InlineData("2026-10-31T23:30:00+01:00", 2026, 10, 31)] // month end stays in October
    public void Camt_date_time_books_on_the_day_the_bank_wrote(string dtTm, int year, int month, int day)
    {
        var xml = Document(Stmt(Ntry("12.00", "DBIT", $"<DtTm>{dtTm}</DtTm>", "R1")));

        var entry = Assert.Single(_camt.Parse(xml).Entries);

        Assert.Equal(new DateOnly(year, month, day), entry.BookingDate);
    }

    [Theory]
    [InlineData("2026-10-01+02:00")]
    [InlineData("2026-10-01Z")]
    [InlineData(" 2026-10-01 ")]
    public void Camt_date_with_a_time_zone_keeps_its_day(string dt)
    {
        var xml = Document(Stmt(Ntry("12.00", "DBIT", $"<Dt>{dt}</Dt>", "R1")));

        Assert.Equal(new DateOnly(2026, 10, 1), Assert.Single(_camt.Parse(xml).Entries).BookingDate);
    }

    [Fact]
    public void Camt_date_time_without_a_bank_reference_has_the_same_reference_on_every_clock()
    {
        // The content reference holds the date: it must not depend on the server's zone or DST.
        var ntry = """
            <Ntry>
              <Amt Ccy="EUR">9.99</Amt><CdtDbtInd>DBIT</CdtDbtInd>
              <BookgDt><DtTm>2026-10-25T01:30:00</DtTm></BookgDt>
              <NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
                <RmtInf><Ustrd>Card payment</Ustrd></RmtInf></TxDtls></NtryDtls>
            </Ntry>
            """;
        var withTime = Assert.Single(_camt.Parse(Document(Stmt(ntry))).Entries);
        var withDate = Assert.Single(_camt.Parse(Document(Stmt(ntry.Replace(
            "<DtTm>2026-10-25T01:30:00</DtTm>", "<Dt>2026-10-25</Dt>")))).Entries);

        Assert.Equal(new DateOnly(2026, 10, 25), withTime.BookingDate);
        Assert.Equal(withDate.Reference, withTime.Reference);
    }

    // --- M2: every statement in the file ---------------------------------------------------

    [Fact]
    public void Camt_reads_every_statement_in_the_file()
    {
        var xml = Document(
            Stmt(Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1")),
            Stmt(Ntry("20.00", "DBIT", "<Dt>2026-10-02</Dt>", "R2") + Ntry("30.00", "CRDT", "<Dt>2026-10-02</Dt>", "R3")),
            Stmt(Ntry("40.00", "DBIT", "<Dt>2026-10-03</Dt>", "R4")));

        var entries = _camt.Parse(xml).Entries;

        Assert.Equal(new[] { "R1", "R2", "R3", "R4" }, entries.Select(e => e.Reference));
        Assert.Equal(new[] { 10.00m, 20.00m, 30.00m, 40.00m }, entries.Select(e => e.Amount));
    }

    [Fact]
    public void Camt_same_account_written_differently_is_one_account()
    {
        var xml = Document(
            Stmt(Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1"), iban: "DE89370400440532013000"),
            Stmt(Ntry("20.00", "DBIT", "<Dt>2026-10-02</Dt>", "R2"), iban: "de89 3704 0044 0532 0130 00"));

        Assert.Equal(2, _camt.Parse(xml).Entries.Count);
    }

    [Fact]
    public void Camt_statements_with_and_without_an_account_are_read_together()
    {
        var xml = Document(
            Stmt(Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1")),
            "<Stmt><Id>S2</Id>" + Ntry("20.00", "DBIT", "<Dt>2026-10-02</Dt>", "R2") + "</Stmt>");

        Assert.Equal(2, _camt.Parse(xml).Entries.Count);
    }

    [Fact]
    public void Camt_refuses_statements_for_different_accounts()
    {
        var xml = Document(
            Stmt(Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1"), iban: "DE89370400440532013000"),
            Stmt(Ntry("20.00", "DBIT", "<Dt>2026-10-02</Dt>", "R2"), iban: "GB29NWBK60161331926819"));

        var ex = Assert.Throws<StatementParseException>(() => _camt.Parse(xml));
        Assert.Contains("more than one account", ex.Message);
    }

    [Fact]
    public void Camt_refuses_two_currencies_of_one_account()
    {
        var xml = Document(
            Stmt(Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1"), ccy: "EUR"),
            Stmt(Ntry("20.00", "DBIT", "<Dt>2026-10-02</Dt>", "R2"), ccy: "GBP"));

        Assert.Throws<StatementParseException>(() => _camt.Parse(xml));
    }

    [Fact]
    public void Camt_refuses_different_account_numbers_without_an_iban()
    {
        static string Othr(string id, string entry) =>
            $"<Stmt><Id>S</Id><Acct><Id><Othr><Id>{id}</Id></Othr></Id></Acct>{entry}</Stmt>";
        var xml = Document(
            Othr("40012345", Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1")),
            Othr("40067890", Ntry("20.00", "DBIT", "<Dt>2026-10-02</Dt>", "R2")));

        Assert.Throws<StatementParseException>(() => _camt.Parse(xml));
    }

    [Fact]
    public void Camt_one_statement_reads_as_before()
    {
        var statement = _camt.Parse(Camt053Samples.ThreeEntries);

        Assert.Equal(new[] { "REF-RENT-001", "REF-SALARY-001", "E2E-TAXI-9" }, statement.Entries.Select(e => e.Reference));
    }

    // --- Pending and information-only entries ------------------------------------------------

    [Theory]
    [InlineData("<Sts>PDNG</Sts>")]              // camt.053.001.02 to .07
    [InlineData("<Sts><Cd>PDNG</Cd></Sts>")]     // camt.053.001.08 on
    [InlineData("<Sts>INFO</Sts>")]
    [InlineData("<Sts><Cd>info</Cd></Sts>")]
    public void Camt_leaves_out_entries_the_bank_has_not_booked(string status)
    {
        var xml = Document(Stmt(
            Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "BOOKED", "<Sts>BOOK</Sts>")
            + Ntry("99.00", "DBIT", "<Dt>2026-10-02</Dt>", "PENDING", status)));

        var entry = Assert.Single(_camt.Parse(xml).Entries);

        Assert.Equal("BOOKED", entry.Reference);
    }

    [Theory]
    [InlineData("")]
    [InlineData("<Sts>BOOK</Sts>")]
    [InlineData("<Sts><Cd>BOOK</Cd></Sts>")]
    [InlineData("<Sts><Cd>FUTR</Cd></Sts>")]
    [InlineData("<Sts><Prtry>XYZ</Prtry></Sts>")]
    public void Camt_imports_booked_or_unmarked_entries(string status)
    {
        var xml = Document(Stmt(Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1", status)));

        Assert.Single(_camt.Parse(xml).Entries);
    }

    [Fact]
    public void Camt_with_only_pending_entries_says_so()
    {
        var xml = Document(Stmt(Ntry("10.00", "DBIT", "<Dt>2026-10-01</Dt>", "R1", "<Sts><Cd>PDNG</Cd></Sts>")));

        var ex = Assert.Throws<StatementParseException>(() => _camt.Parse(xml));
        Assert.Contains("not booked yet", ex.Message);
    }

    // --- L2: a line break inside a quoted CSV field ------------------------------------------

    [Theory]
    [InlineData("\n")]
    [InlineData("\r\n")]
    [InlineData("\r")]
    public void Csv_quoted_line_break_stays_in_its_row(string newline)
    {
        var csv = string.Join(newline,
            "Date,Description,Amount",
            "04/10/2026,Coffee,-3.20",
            $"05/10/2026,\"Payment{newline}ref 123\",-45.00",
            "06/10/2026,Salary,1500.00",
            "");
        var mapping = _csv.Detect(csv).Suggested;

        var statement = _csv.Parse(csv, mapping);

        Assert.Equal(0, statement.UnreadLines);
        Assert.Equal(new[] { -3.20m, -45.00m, 1500.00m }, statement.Entries.Select(e => e.IsCredit ? e.Amount : -e.Amount));
        Assert.Equal("Payment ref 123", statement.Entries[1].Payee);
        Assert.Equal(new DateOnly(2026, 10, 5), statement.Entries[1].BookingDate);
    }

    [Fact]
    public void Csv_quoted_line_break_in_a_semicolon_file_with_escaped_quotes()
    {
        var csv = "Datum;Omschrijving;Bedrag\n"
            + "05-10-2026;\"Shop \"\"Main\"\";\nStreet 1\";-45,00\n"
            + "06-10-2026;Rent;-900,00\n";
        var mapping = _csv.Detect(csv).Suggested;

        var statement = _csv.Parse(csv, mapping);

        Assert.Equal(2, statement.Entries.Count);
        Assert.Equal("Shop \"Main\"; Street 1", statement.Entries[0].Payee);
        Assert.Equal(45.00m, statement.Entries[0].Amount);
    }

    [Fact]
    public void Csv_inch_mark_does_not_join_the_rows_below_it()
    {
        // A quote in the middle of a field is not an opening quote.
        var csv = "Date,Description,Amount\n"
            + "05/10/2026,12\" pizza,-9.00\n"
            + "06/10/2026,Rent,-900.00\n"
            + "07/10/2026,Salary,1500.00\n";
        var mapping = _csv.Detect(csv).Suggested;

        var statement = _csv.Parse(csv, mapping);

        // The first row reads as before this fix (its stray quote runs to the line end); the
        // rows after it are untouched.
        Assert.Equal(new[] { -900.00m, 1500.00m },
            statement.Entries.Where(e => e.BookingDate.Day > 5).Select(e => e.IsCredit ? e.Amount : -e.Amount));
    }

    [Fact]
    public void Csv_quote_never_closed_ends_its_row_at_the_line_end()
    {
        var csv = "Date,Description,Amount\n"
            + "04/10/2026,Coffee,-3.20\n"
            + "05/10/2026,\"Broken,-45.00\n"
            + "06/10/2026,Rent,-900.00\n"
            + "07/10/2026,Salary,1500.00\n";
        var mapping = _csv.Detect(csv).Suggested;

        var statement = _csv.Parse(csv, mapping);

        Assert.Equal(new[] { 4, 6, 7 }, statement.Entries.Select(e => e.BookingDate.Day));
    }

    [Fact]
    public void Csv_quote_open_for_too_many_lines_is_a_stray()
    {
        var rows = Enumerable.Range(6, 20).Select(d => $"{d:00}/10/2026,Shop {d},-{d}.00");
        var csv = "Date,Description,Amount\n"
            + "05/10/2026,\"Broken,-45.00\n"
            + string.Join("\n", rows) + "\n"
            + "26/10/2026,closing\",-1.00\n";
        var mapping = _csv.Detect(csv).Suggested;

        var statement = _csv.Parse(csv, mapping);

        // The twenty rows after the stray quote are not swallowed into one.
        Assert.Equal(Enumerable.Range(6, 20), statement.Entries.Where(e => e.BookingDate.Day is >= 6 and <= 25).Select(e => e.BookingDate.Day));
    }
}
