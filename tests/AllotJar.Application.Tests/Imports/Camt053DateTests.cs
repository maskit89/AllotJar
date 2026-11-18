using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Infrastructure.Statements;
using Microsoft.EntityFrameworkCore;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Which day a camt.053 entry is booked on. No Maltese bank sends camt.053 files, so these are
/// synthetic statements written from the ISO 20022 message definitions: <c>BookgDt</c> and
/// <c>ValDt</c> are a DateAndDateTime2Choice, either <c>Dt</c> (ISODate, xs:date, which may carry a
/// time zone) or <c>DtTm</c> (ISODateTime, xs:dateTime, with or without an offset). <c>Sts</c> is a
/// bare code up to .001.07 and <c>&lt;Sts&gt;&lt;Cd&gt;</c> from .001.08. Every account, name and
/// amount is made up; no real bank file is used.
/// </summary>
public class Camt053DateTests
{
    private readonly Camt053StatementParser _camt = new();

    // camt.053.001.02 (still the most common version in Europe): bare Sts, BookgDt and ValDt as Dt.
    // A card payment made on the last evening of September is booked on 1 October and valued on
    // 30 September; a salary is booked on 30 October and valued on 2 November.
    private const string Version02 = """
        <?xml version="1.0" encoding="UTF-8"?>
        <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <BkToCstmrStmt>
            <GrpHdr><MsgId>SYNTH-02-0001</MsgId><CreDtTm>2026-11-01T06:00:00+01:00</CreDtTm></GrpHdr>
            <Stmt>
              <Id>SYNTH-02-STMT-10</Id>
              <ElctrncSeqNb>10</ElctrncSeqNb>
              <CreDtTm>2026-11-01T06:00:00+01:00</CreDtTm>
              <FrToDt><FrDtTm>2026-10-01T00:00:00+02:00</FrDtTm><ToDtTm>2026-10-31T23:59:59+01:00</ToDtTm></FrToDt>
              <Acct><Id><IBAN>MT00SYNT00000000000000000000000</IBAN></Id><Ccy>EUR</Ccy></Acct>
              <Ntry>
                <Amt Ccy="EUR">23.40</Amt>
                <CdtDbtInd>DBIT</CdtDbtInd>
                <Sts>BOOK</Sts>
                <BookgDt><Dt>2026-10-01</Dt></BookgDt>
                <ValDt><Dt>2026-09-30</Dt></ValDt>
                <AcctSvcrRef>SYN-CARD-0001</AcctSvcrRef>
                <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn></BkTxCd>
                <NtryDtls><TxDtls>
                  <RltdPties><Cdtr><Nm>Corner Grocer</Nm></Cdtr></RltdPties>
                </TxDtls></NtryDtls>
              </Ntry>
              <Ntry>
                <Amt Ccy="EUR">2100.00</Amt>
                <CdtDbtInd>CRDT</CdtDbtInd>
                <Sts>BOOK</Sts>
                <BookgDt><Dt>2026-10-30</Dt></BookgDt>
                <ValDt><Dt>2026-11-02</Dt></ValDt>
                <AcctSvcrRef>SYN-SAL-0001</AcctSvcrRef>
                <NtryDtls><TxDtls>
                  <RltdPties><Dbtr><Nm>Example Employer Ltd</Nm></Dbtr></RltdPties>
                </TxDtls></NtryDtls>
              </Ntry>
            </Stmt>
          </BkToCstmrStmt>
        </Document>
        """;

    // camt.053.001.08: Sts as a code, dates as DtTm with offsets near midnight, one entry with only
    // a value date, and one card payment with no bank reference (its reference holds the date).
    private const string Version08 = """
        <?xml version="1.0" encoding="UTF-8"?>
        <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
          <BkToCstmrStmt>
            <GrpHdr><MsgId>SYNTH-08-0001</MsgId><CreDtTm>2026-11-01T06:00:00Z</CreDtTm></GrpHdr>
            <Stmt>
              <Id>SYNTH-08-STMT-10</Id>
              <CreDtTm>2026-11-01T06:00:00Z</CreDtTm>
              <Acct><Id><IBAN>MT00SYNT00000000000000000000000</IBAN></Id><Ccy>EUR</Ccy></Acct>
              <Ntry>
                <Amt Ccy="EUR">8.50</Amt>
                <CdtDbtInd>DBIT</CdtDbtInd>
                <Sts><Cd>BOOK</Cd></Sts>
                <BookgDt><DtTm>2026-10-01T00:15:00+02:00</DtTm></BookgDt>
                <ValDt><DtTm>2026-09-30T22:15:00Z</DtTm></ValDt>
                <AcctSvcrRef>SYN-08-A</AcctSvcrRef>
                <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Night Kiosk</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
              </Ntry>
              <Ntry>
                <Amt Ccy="EUR">61.00</Amt>
                <CdtDbtInd>DBIT</CdtDbtInd>
                <Sts><Cd>BOOK</Cd></Sts>
                <BookgDt><DtTm>2026-10-31T23:59:59.999+01:00</DtTm></BookgDt>
                <AcctSvcrRef>SYN-08-B</AcctSvcrRef>
                <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Fuel Station</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
              </Ntry>
              <Ntry>
                <Amt Ccy="EUR">15.00</Amt>
                <CdtDbtInd>CRDT</CdtDbtInd>
                <Sts><Cd>BOOK</Cd></Sts>
                <ValDt><Dt>2026-10-15</Dt></ValDt>
                <AcctSvcrRef>SYN-08-C</AcctSvcrRef>
                <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>A Friend</Nm></Dbtr></RltdPties></TxDtls></NtryDtls>
              </Ntry>
              <Ntry>
                <Amt Ccy="EUR">4.20</Amt>
                <CdtDbtInd>DBIT</CdtDbtInd>
                <Sts><Cd>BOOK</Cd></Sts>
                <BookgDt><DtTm>2026-10-25T02:30:00</DtTm></BookgDt>
                <NtryDtls><TxDtls>
                  <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
                  <RmtInf><Ustrd>Card payment Coffee Bar</Ustrd></RmtInf>
                </TxDtls></NtryDtls>
              </Ntry>
            </Stmt>
          </BkToCstmrStmt>
        </Document>
        """;

    private static string OneEntry(string dates, string reference = "SYN-1") => $"""
        <?xml version="1.0" encoding="UTF-8"?>
        <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
          <BkToCstmrStmt><Stmt>
            <Id>SYNTH</Id>
            <Acct><Id><IBAN>MT00SYNT00000000000000000000000</IBAN></Id><Ccy>EUR</Ccy></Acct>
            <Ntry>
              <Amt Ccy="EUR">12.00</Amt>
              <CdtDbtInd>DBIT</CdtDbtInd>
              <Sts><Cd>BOOK</Cd></Sts>
              {dates}
              <AcctSvcrRef>{reference}</AcctSvcrRef>
              <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Shop</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
            </Ntry>
          </Stmt></BkToCstmrStmt>
        </Document>
        """;

    private DateOnly BookedOn(string dates) => Assert.Single(_camt.Parse(OneEntry(dates)).Entries).BookingDate;

    // --- Booking date, not value date --------------------------------------------------------

    [Fact]
    public void Version02_books_on_the_booking_date_even_when_the_value_date_is_in_another_month()
    {
        var entries = _camt.Parse(Version02).Entries;

        Assert.Equal(new DateOnly(2026, 10, 1), entries.Single(e => e.Reference == "SYN-CARD-0001").BookingDate);
        Assert.Equal(new DateOnly(2026, 10, 30), entries.Single(e => e.Reference == "SYN-SAL-0001").BookingDate);
    }

    [Fact]
    public void Version08_date_times_keep_the_bank_s_day_and_a_value_date_is_used_only_when_there_is_no_booking_date()
    {
        var statement = _camt.Parse(Version08);

        Assert.Equal(0, statement.UnreadLines);
        Assert.Equal(
            new[]
            {
                new DateOnly(2026, 10, 1),  // 00:15+02:00 is 30 Sep in UTC; its ValDt is 30 Sep too
                new DateOnly(2026, 10, 31), // last moment of October stays in October
                new DateOnly(2026, 10, 15), // no BookgDt: the value date
                new DateOnly(2026, 10, 25), // Malta's clocks go back that night; no offset written
            },
            statement.Entries.Select(e => e.BookingDate));
    }

    [Theory]
    [InlineData("<BookgDt><Dt>2026-10-01</Dt></BookgDt><ValDt><Dt>2026-09-28</Dt></ValDt>", 2026, 10, 1)]
    [InlineData("<ValDt><Dt>2026-09-28</Dt></ValDt><BookgDt><Dt>2026-10-01</Dt></BookgDt>", 2026, 10, 1)] // order doesn't matter
    [InlineData("<BookgDt><DtTm>2026-10-01T08:00:00+02:00</DtTm></BookgDt><ValDt><Dt>2026-10-03</Dt></ValDt>", 2026, 10, 1)]
    [InlineData("<BookgDt><Dt>2026-10-01</Dt></BookgDt><ValDt><DtTm>2026-11-01T00:00:00+01:00</DtTm></ValDt>", 2026, 10, 1)]
    [InlineData("<ValDt><DtTm>2026-10-01T00:30:00+02:00</DtTm></ValDt>", 2026, 10, 1)]
    public void Booking_date_wins_over_value_date(string dates, int year, int month, int day) =>
        Assert.Equal(new DateOnly(year, month, day), BookedOn(dates));

    // --- Date-times near midnight --------------------------------------------------------------

    [Theory]
    [InlineData("2026-10-01T00:00:00+14:00", 2026, 10, 1)]          // furthest ahead of UTC
    [InlineData("2026-09-30T23:59:59-12:00", 2026, 9, 30)]          // furthest behind UTC
    [InlineData("2026-10-01T00:00:00Z", 2026, 10, 1)]
    [InlineData("2026-09-30T23:59:59.9999999Z", 2026, 9, 30)]
    [InlineData("2026-10-01T00:00:00", 2026, 10, 1)]                // no offset: as written
    [InlineData("2026-09-30T23:59:59", 2026, 9, 30)]
    [InlineData("2026-10-01T00:00:00-00:00", 2026, 10, 1)]
    [InlineData("2026-12-31T23:30:00-01:00", 2026, 12, 31)]         // year end stays in the old year
    [InlineData("2027-01-01T00:10:00+01:00", 2027, 1, 1)]           // and New Year in the new one
    [InlineData("2028-02-29T23:59:59+01:00", 2028, 2, 29)]          // leap day
    [InlineData("2026-03-29T02:30:00+01:00", 2026, 3, 29)]          // clocks go forward in Malta
    [InlineData("2026-10-25T02:30:00+02:00", 2026, 10, 25)]         // clocks go back: 02:30 twice
    [InlineData("2026-10-25T02:30:00+01:00", 2026, 10, 25)]
    [InlineData("2026-10-01T00:15:00+0200", 2026, 10, 1)]           // offset without a colon
    [InlineData("2026-10-01T00:15+02:00", 2026, 10, 1)]             // no seconds
    [InlineData("  2026-10-01T00:15:00+02:00\n", 2026, 10, 1)]      // whitespace around it
    [InlineData("2026-10-01 00:15:00+02:00", 2026, 10, 1)]          // a space for the T
    [InlineData("2026-10-01", 2026, 10, 1)]                         // a date where a date-time belongs
    public void Date_time_books_on_the_day_written_whatever_the_offset(string dtTm, int year, int month, int day) =>
        Assert.Equal(new DateOnly(year, month, day), BookedOn($"<BookgDt><DtTm>{dtTm}</DtTm></BookgDt>"));

    [Theory]
    [InlineData("2026-10-01T00:15:00+02:00")]
    [InlineData("2026-10-01T23:45:00-11:00")]
    [InlineData("2026-10-01T09:00:00Z")]
    [InlineData("2026-10-01T09:00:00")]
    public void An_entry_without_a_bank_reference_has_one_reference_for_its_day_whatever_the_time(string dtTm)
    {
        // The content reference holds the day, so a re-import (or the same entry written with
        // another time by the bank's next export) is still recognised.
        static string Card(string date) => $"""
            <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>
              <Id>S</Id><Acct><Id><IBAN>MT00SYNT00000000000000000000000</IBAN></Id><Ccy>EUR</Ccy></Acct>
              <Ntry><Amt Ccy="EUR">4.20</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
                <BookgDt>{date}</BookgDt>
                <NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
                  <RmtInf><Ustrd>Card payment Coffee Bar</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
            </Stmt></BkToCstmrStmt></Document>
            """;

        var withDate = Assert.Single(_camt.Parse(Card("<Dt>2026-10-01</Dt>")).Entries);
        var withTime = Assert.Single(_camt.Parse(Card($"<DtTm>{dtTm}</DtTm>")).Entries);

        Assert.Equal(withDate.Reference, withTime.Reference);
    }

    // --- Dates as xs:date ---------------------------------------------------------------------

    [Theory]
    [InlineData("2026-10-01")]
    [InlineData("2026-10-01Z")]
    [InlineData("2026-10-01+14:00")]
    [InlineData("2026-10-01-12:00")]
    [InlineData("\n  2026-10-01  \n")]
    [InlineData("2026-10-01T00:00:00")]          // a date-time where the date belongs
    [InlineData("2026-10-01T00:15:00+02:00")]
    public void Date_keeps_its_day_with_or_without_a_time_zone(string dt) =>
        Assert.Equal(new DateOnly(2026, 10, 1), BookedOn($"<BookgDt><Dt>{dt}</Dt></BookgDt>"));

    // --- Dates that are not ISO 20022 are not guessed ----------------------------------------

    [Theory]
    [InlineData("<Dt>01/10/2026</Dt>")]                  // read month first, this was 10 January
    [InlineData("<Dt>01.10.2026</Dt>")]                  // this too
    [InlineData("<Dt>10/01/2026</Dt>")]
    [InlineData("<Dt>2026-10-1</Dt>")]
    [InlineData("<Dt>2026/10/01</Dt>")]
    [InlineData("<Dt>20261001</Dt>")]
    [InlineData("<Dt>1 Oct 2026</Dt>")]
    [InlineData("<Dt>2026-02-30</Dt>")]                  // no such day
    [InlineData("<Dt></Dt>")]
    [InlineData("<Dt>2026-10-01+99:99</Dt>")]          // no such time zone
    [InlineData("<Dt>2026-10-01T24:00:00</Dt>")]
    [InlineData("<DtTm>01/10/2026 00:15:00</DtTm>")]
    [InlineData("<DtTm>Thu, 01 Oct 2026 00:15:00 GMT</DtTm>")]
    [InlineData("<DtTm>2026-10-01T24:00:00</DtTm>")]
    [InlineData("<DtTm>2026-10-01T23:60:00Z</DtTm>")]
    [InlineData("<DtTm>2026-10-01T12:00:00+15:00</DtTm>")] // no such offset
    public void A_date_not_written_the_ISO_way_is_counted_as_not_read_instead_of_guessed(string date)
    {
        var xml = OneEntry($"<BookgDt>{date}</BookgDt>", "BAD").Replace(
            "</Stmt>",
            """
            <Ntry><Amt Ccy="EUR">1.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
              <BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>OK</AcctSvcrRef></Ntry>
            </Stmt>
            """);

        var statement = _camt.Parse(xml);

        Assert.Equal("OK", Assert.Single(statement.Entries).Reference);
        Assert.Equal(1, statement.UnreadLines);
    }

    [Fact]
    public void A_bad_booking_date_is_not_replaced_by_the_value_date()
    {
        // The value date can be in another month: the entry is shown as not read instead.
        var xml = OneEntry("<BookgDt><Dt>01/10/2026</Dt></BookgDt><ValDt><Dt>2026-09-30</Dt></ValDt>", "BAD")
            .Replace("</Stmt>", """
                <Ntry><Amt Ccy="EUR">1.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
                  <BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>OK</AcctSvcrRef></Ntry>
                </Stmt>
                """);

        var statement = _camt.Parse(xml);

        Assert.Equal("OK", Assert.Single(statement.Entries).Reference);
        Assert.Equal(1, statement.UnreadLines);
    }

    // --- Statement periods -------------------------------------------------------------------

    private static string PeriodStmt(string from, string to, string reference, params (string Ref, string Day, string Amount)[] entries) =>
        $"""
        <Stmt><Id>{reference}</Id>
          <FrToDt><FrDtTm>{from}</FrDtTm><ToDtTm>{to}</ToDtTm></FrToDt>
          <Acct><Id><IBAN>MT00SYNT00000000000000000000000</IBAN></Id><Ccy>EUR</Ccy></Acct>
          {string.Concat(entries.Select(e => $"""
            <Ntry><Amt Ccy="EUR">{e.Amount}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
              <BookgDt><Dt>{e.Day}</Dt></BookgDt><AcctSvcrRef>{e.Ref}</AcctSvcrRef></Ntry>
            """))}
        </Stmt>
        """;

    private static string Statements(params string[] stmts) =>
        "<Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt>"
        + string.Concat(stmts)
        + "</BkToCstmrStmt></Document>";

    [Fact]
    public void Periods_written_day_first_are_compared_by_their_booking_days()
    {
        // Day first these are 1 to 10 January and 2 to 5 March. Read month first they were 1 January
        // to 1 October and 3 February to 3 May, which overlap, and the good file was refused. A
        // period that isn't ISO is compared by the days its entries are booked on instead.
        var xml = Statements(
            PeriodStmt("01/01/2026 00:00:00", "10/01/2026 23:59:59", "A", ("A", "2026-01-05", "5.00")),
            PeriodStmt("02/03/2026 00:00:00", "05/03/2026 23:59:59", "B", ("B", "2026-03-03", "5.00")));

        Assert.Equal(new[] { "A", "B" }, _camt.Parse(xml).Entries.Select(e => e.Reference));
    }

    [Fact]
    public void Overlapping_periods_written_day_first_are_still_refused()
    {
        // 1 to 10 October and 5 to 12 October both hold the payment of 7 October: imported from
        // both, it would be booked twice.
        var xml = Statements(
            PeriodStmt("01/10/2026 00:00:00", "10/10/2026 23:59:59", "A",
                ("R1", "2026-10-01", "5.00"), ("R2", "2026-10-07", "9.00")),
            PeriodStmt("05/10/2026 00:00:00", "12/10/2026 23:59:59", "B",
                ("R2", "2026-10-07", "9.00"), ("R3", "2026-10-11", "3.00")));

        var ex = Assert.Throws<StatementParseException>(() => _camt.Parse(xml));
        Assert.Contains("overlapping periods", ex.Message);
    }

    [Fact]
    public void A_period_written_day_first_is_compared_with_an_ISO_one_by_booking_days()
    {
        var xml = Statements(
            PeriodStmt("2026-10-01T00:00:00+02:00", "2026-10-11T00:00:00+02:00", "A",
                ("R1", "2026-10-01", "5.00"), ("R2", "2026-10-07", "9.00")),
            PeriodStmt("05/10/2026 00:00:00", "12/10/2026 23:59:59", "B",
                ("R2", "2026-10-07", "9.00"), ("R3", "2026-10-11", "3.00")));

        Assert.Throws<StatementParseException>(() => _camt.Parse(xml));
    }

    [Fact]
    public void Daily_statements_with_periods_written_day_first_are_read()
    {
        var xml = Statements(
            PeriodStmt("01/10/2026 00:00:00", "02/10/2026 00:00:00", "A", ("R1", "2026-10-01", "5.00")),
            PeriodStmt("02/10/2026 00:00:00", "03/10/2026 00:00:00", "B", ("R2", "2026-10-02", "9.00")),
            PeriodStmt("2026-10-03T00:00:00+02:00", "2026-10-04T00:00:00+02:00", "C", ("R3", "2026-10-03", "3.00")));

        Assert.Equal(new[] { "R1", "R2", "R3" }, _camt.Parse(xml).Entries.Select(e => e.Reference));
    }

    [Fact]
    public void A_date_that_does_not_exist_falls_back_to_the_date_time_beside_it()
    {
        // Dt and DtTm are a choice, so a bank never sends both; when one does, an unreadable Dt
        // (ISO or not) is passed over the same way.
        Assert.Equal(new DateOnly(2026, 3, 1),
            BookedOn("<BookgDt><Dt>2026-02-30</Dt><DtTm>2026-03-01T10:00:00</DtTm></BookgDt>"));
        Assert.Equal(new DateOnly(2026, 3, 1),
            BookedOn("<BookgDt><Dt>30/02/2026</Dt><DtTm>2026-03-01T10:00:00</DtTm></BookgDt>"));
    }

    // --- Through preview and commit ----------------------------------------------------------

    [Fact]
    public async Task A_payment_just_after_midnight_on_the_first_is_saved_in_the_new_month()
    {
        await using var db = NewContext();
        var preview = await new PreviewImportCommandHandler(db, new CurrentUserStub("user-1"),
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() },
                new GenericCsvImporter())
            .Handle(new PreviewImportCommand(Version08, StatementFormat.Camt053), CancellationToken.None);

        Assert.Equal(new DateOnly(2026, 10, 1), preview.Items.Single(i => i.Reference == "SYN-08-A").Date);

        await new CommitImportCommandHandler(db, new CurrentUserStub("user-1")).Handle(
            new CommitImportCommand(null, preview.Items.Select(c => new CommitImportItem(
                c.Reference, c.Date, c.Payee, c.Amount, c.Currency, c.IsCredit, null, null)).ToList()),
            CancellationToken.None);

        var saved = await db.Transactions.SingleAsync(t => t.Payee == "Night Kiosk");
        Assert.Equal(new DateOnly(2026, 10, 1), saved.Date);
        Assert.Equal(new DateOnly(2026, 10, 31), (await db.Transactions.SingleAsync(t => t.Payee == "Fuel Station")).Date);
    }
}
