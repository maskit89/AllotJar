using AllotJar.Infrastructure.Statements;
using Xunit;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Input-tolerance and reference-stability guards added by the 2026-07 import audit: real-world
/// files (trailing-sign amounts, 2-digit years, BOMs, bare-CR endings, unquoted merchant commas,
/// reused CAMT references, zero-amount markers) must import correctly — or be skipped cleanly —
/// instead of silently dropping rows, fabricating data, or failing whole files.
/// </summary>
public class ParserToleranceTests
{
    private const char Bom = '\uFEFF';

    // --- Generic CSV importer -------------------------------------------------

    private readonly GenericCsvImporter _csv = new();

    private static string GenericCsv(params string[] rows) =>
        "Date,Description,Amount\n" + string.Join("\n", rows) + "\n";

    [Fact]
    public void Generic_trailing_sign_negatives_parse_as_debits()
    {
        // SAP/DATEV-style exports put the minus AFTER the amount.
        var csv = GenericCsv("2026-06-20,COFFEE HOUSE,35.00-", "2026-06-21,REFUND SHOP,12.50");
        var mapping = _csv.Detect(csv).Suggested with { DefaultCurrency = "EUR" };

        var statement = _csv.Parse(csv, mapping);

        Assert.Equal(2, statement.Entries.Count);
        Assert.Equal(35.00m, statement.Entries[0].Amount);
        Assert.False(statement.Entries[0].IsCredit);
        Assert.True(statement.Entries[1].IsCredit);
    }

    [Fact]
    public void Generic_trailing_sign_works_with_comma_decimals()
    {
        var csv = GenericCsv("2026-06-20,MOEBELHAUS,\"1.234,56-\"");
        var mapping = _csv.Detect(csv).Suggested with { DefaultCurrency = "EUR" };

        var statement = _csv.Parse(csv, mapping);

        Assert.Equal(1234.56m, statement.Entries[0].Amount);
        Assert.False(statement.Entries[0].IsCredit);
    }

    [Fact]
    public void Generic_two_digit_years_parse_instead_of_failing_the_file()
    {
        var csv = GenericCsv("12/03/26,LOCAL SHOP,-9.99");
        var mapping = _csv.Detect(csv).Suggested with { DefaultCurrency = "EUR" };

        var statement = _csv.Parse(csv, mapping);

        Assert.Equal(new DateOnly(2026, 3, 12), statement.Entries[0].BookingDate);
    }

    [Fact]
    public void Generic_bare_CR_line_endings_yield_the_same_rows_and_references_as_LF()
    {
        var lf = GenericCsv("2026-06-20,TESCO,-42.50", "2026-06-21,SALARY,2500.00");
        var cr = lf.Replace("\n", "\r");
        var mapping = _csv.Detect(lf).Suggested with { DefaultCurrency = "EUR" };

        var fromLf = _csv.Parse(lf, mapping);
        var fromCr = _csv.Parse(cr, mapping);

        Assert.Equal(fromLf.Entries.Count, fromCr.Entries.Count);
        Assert.Equal(
            fromLf.Entries.Select(e => e.Reference),
            fromCr.Entries.Select(e => e.Reference)); // dedup references must not shift
    }

    [Fact]
    public void Generic_leading_BOM_does_not_corrupt_the_first_row_or_its_reference()
    {
        var plain = GenericCsv("2026-06-20,TESCO,-42.50");
        var bommed = Bom + plain;
        var mapping = _csv.Detect(plain).Suggested with { DefaultCurrency = "EUR" };

        var fromPlain = _csv.Parse(plain, mapping);
        var fromBom = _csv.Parse(bommed, mapping);

        Assert.Equal(fromPlain.Entries[0].Reference, fromBom.Entries[0].Reference);
    }

    [Fact]
    public void Generic_echoes_the_date_format_it_actually_applied()
    {
        var csv = GenericCsv("2026-06-20,TESCO,-42.50");
        var auto = _csv.Detect(csv).Suggested with { DefaultCurrency = "EUR" }; // DateFormat null

        var statement = _csv.Parse(csv, auto);

        Assert.Equal("yyyy-MM-dd", statement.ResolvedDateFormat);
    }

    // --- HSBC CSV parser --------------------------------------------------------

    private readonly HsbcCsvStatementParser _hsbc = new();

    private const string Mask = "•••• •••• •••• 1234";

    private static string HsbcRow(string date, string desc, string amount) =>
        $"{date},{desc} {date} {Mask} {amount} EUR,{amount}";

    [Fact]
    public void Hsbc_unquoted_comma_inside_the_merchant_name_no_longer_drops_the_row()
    {
        // "PAYPAL *TEMU, INC" — HSBC doesn't quote merchant commas, so the row splits into 4 fields.
        var line = $"10/06/2026,PAYPAL *TEMU, INC 09/06/2026 {Mask} -5.00 EUR,-5.00";
        var csv = line + "\n" + HsbcRow("11/06/2026", "GROCER", "-20.00") + "\n";

        var statement = _hsbc.Parse(csv);

        Assert.Equal(2, statement.Entries.Count);
        var stitched = statement.Entries[0];
        Assert.Equal(5.00m, stitched.Amount);
        Assert.False(stitched.IsCredit);
        Assert.Contains("TEMU, INC", stitched.Payee);
    }

    [Fact]
    public void Hsbc_zero_amount_rows_are_skipped_instead_of_poisoning_the_commit()
    {
        var csv = HsbcRow("10/06/2026", "INFO MARKER", "0.00") + "\n"
            + HsbcRow("11/06/2026", "GROCER", "-20.00") + "\n";

        var statement = _hsbc.Parse(csv);

        Assert.Single(statement.Entries);
        Assert.Equal("GROCER", statement.Entries[0].Payee);
    }

    [Fact]
    public void Hsbc_BOM_and_bare_CR_variants_produce_identical_references()
    {
        var plain = HsbcRow("10/06/2026", "GROCER", "-20.00") + "\n";
        var variants = new[] { Bom + plain, plain.Replace("\n", "\r") };

        var expected = _hsbc.Parse(plain).Entries[0].Reference;
        foreach (var variant in variants)
        {
            Assert.Equal(expected, _hsbc.Parse(variant).Entries[0].Reference);
        }
    }

    // --- CAMT.053 parser ---------------------------------------------------------

    private readonly Camt053StatementParser _camt = new();

    private static string CamtEntry(
        string? amount = "10.00", string? ccy = "EUR", string? indicator = "DBIT",
        string? date = "2026-06-01", string? reference = "REF-1")
    {
        var amt = amount is null ? "" : $"<Amt{(ccy is null ? "" : $" Ccy=\"{ccy}\"")}>{amount}</Amt>";
        var ind = indicator is null ? "" : $"<CdtDbtInd>{indicator}</CdtDbtInd>";
        var dt = date is null ? "" : $"<BookgDt><Dt>{date}</Dt></BookgDt>";
        var refEl = reference is null ? "" : $"<AcctSvcrRef>{reference}</AcctSvcrRef>";
        return $"<Ntry>{amt}{ind}{dt}<NtryDtls><TxDtls><Refs>{refEl}</Refs>" +
               "<RltdPties><Cdtr><Nm>SHOP</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>";
    }

    private static string CamtDoc(params string[] entries) =>
        "<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>MT84MALT011000012345MTLCAST001S</IBAN></Id></Acct>"
        + string.Join("", entries) + "</Stmt></BkToCstmrStmt></Document>";

    [Fact]
    public void Camt_repeated_references_get_occurrence_suffixes_so_no_entry_is_silently_dropped()
    {
        // A standing order reusing its EndToEndId / a pooled AcctSvcrRef: same ref, two entries.
        var doc = CamtDoc(
            CamtEntry(amount: "100.00", reference: "MANDATE-77"),
            CamtEntry(amount: "100.00", reference: "MANDATE-77"),
            CamtEntry(amount: "9.99", reference: "OTHER"));

        var statement = _camt.Parse(doc);

        Assert.Equal(3, statement.Entries.Count);
        Assert.Equal("MANDATE-77", statement.Entries[0].Reference);   // first keeps the raw ref
        Assert.Equal("MANDATE-77#1", statement.Entries[1].Reference); // repeat is disambiguated
        Assert.Equal("OTHER", statement.Entries[2].Reference);
    }

    [Fact]
    public void Camt_entry_without_a_date_is_skipped_never_booked_today()
    {
        var doc = CamtDoc(
            CamtEntry(date: null, reference: "NO-DATE"),
            CamtEntry(reference: "GOOD"));

        var statement = _camt.Parse(doc);

        Assert.Single(statement.Entries);
        Assert.Equal("GOOD", statement.Entries[0].Reference);
    }

    [Fact]
    public void Camt_a_malformed_entry_is_skipped_without_failing_the_statement()
    {
        var doc = CamtDoc(
            CamtEntry(amount: null, reference: "NO-AMT"),      // missing <Amt>
            CamtEntry(ccy: null, reference: "NO-CCY"),         // missing currency
            CamtEntry(indicator: null, reference: "NO-IND"),   // missing direction
            CamtEntry(reference: "GOOD"));

        var statement = _camt.Parse(doc);

        Assert.Single(statement.Entries);
        Assert.Equal("GOOD", statement.Entries[0].Reference);
    }

    [Fact]
    public void Camt_zero_amount_entries_are_skipped()
    {
        var doc = CamtDoc(CamtEntry(amount: "0.00", reference: "ZERO"), CamtEntry(reference: "GOOD"));

        var statement = _camt.Parse(doc);

        Assert.Single(statement.Entries);
        Assert.Equal("GOOD", statement.Entries[0].Reference);
    }

    [Fact]
    public void Camt_BOM_prefixed_xml_still_sniffs_and_parses()
    {
        var doc = Bom + CamtDoc(CamtEntry());

        Assert.True(_camt.CanParse(doc));
        Assert.Single(_camt.Parse(doc).Entries);
    }

    [Fact]
    public void Camt_overlong_references_are_folded_deterministically_under_the_storage_cap()
    {
        var longRef = new string('R', 200);
        var doc = CamtDoc(CamtEntry(reference: longRef));

        var first = _camt.Parse(doc).Entries[0].Reference!;
        var again = _camt.Parse(doc).Entries[0].Reference!;

        Assert.True(first.Length <= 140);
        Assert.Equal(first, again); // idempotency: the fold must be stable across re-imports

        var different = CamtDoc(CamtEntry(reference: new string('R', 199) + "X"));
        Assert.NotEqual(first, _camt.Parse(different).Entries[0].Reference);
    }
}
