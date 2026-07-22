using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Imports.Models;
using AllotJar.Infrastructure.Statements;
using Xunit;

namespace AllotJar.Application.Tests.Imports;

public class GenericCsvImporterTests
{
    private readonly GenericCsvImporter _importer = new();

    private const string CommaCsv =
        "Date,Description,Amount,Currency\n" +
        "2026-06-20,TESCO STORES,-42.50,GBP\n" +
        "2026-06-20,TESCO STORES,-42.50,GBP\n" +          // exact duplicate row
        "2026-06-21,SALARY ACME,\"2,500.00\",GBP\n";       // credit with grouped thousands

    [Fact]
    public void Detect_guesses_columns_from_headers_and_content()
    {
        var layout = _importer.Detect(CommaCsv);
        var m = layout.Suggested;

        Assert.Equal(',', m.Delimiter);
        Assert.True(m.HasHeader);
        Assert.Equal(0, m.DateColumn);
        Assert.Equal(2, m.AmountColumn);
        Assert.Equal(1, m.DescriptionColumn);
        Assert.Equal(3, m.CurrencyColumn);
        Assert.Equal(new[] { "Date", "Description", "Amount", "Currency" }, layout.Columns);
        Assert.NotEmpty(layout.SampleRows);
    }

    [Fact]
    public void Parse_reads_signed_amounts_dates_and_currency()
    {
        var mapping = _importer.Detect(CommaCsv).Suggested with { DefaultCurrency = "GBP" };
        var statement = _importer.Parse(CommaCsv, mapping);

        Assert.Equal(3, statement.Entries.Count);

        var debit = statement.Entries[0];
        Assert.Equal(42.50m, debit.Amount);
        Assert.False(debit.IsCredit);
        Assert.Equal("GBP", debit.Currency);
        Assert.Equal("TESCO STORES", debit.Payee);
        Assert.Equal(new DateOnly(2026, 6, 20), debit.BookingDate);

        var credit = statement.Entries[2];
        Assert.Equal(2500.00m, credit.Amount);
        Assert.True(credit.IsCredit);
    }

    [Fact]
    public void Parse_gives_repeated_identical_rows_distinct_references_but_is_otherwise_idempotent()
    {
        var mapping = _importer.Detect(CommaCsv).Suggested with { DefaultCurrency = "GBP" };
        var first = _importer.Parse(CommaCsv, mapping);
        var again = _importer.Parse(CommaCsv, mapping);

        // The two identical TESCO rows get distinct references (both import)...
        Assert.NotEqual(first.Entries[0].Reference, first.Entries[1].Reference);
        // ...but re-parsing the same file yields the same references (a re-import is a no-op).
        Assert.Equal(
            first.Entries.Select(e => e.Reference),
            again.Entries.Select(e => e.Reference));
    }

    [Fact]
    public void Parse_falls_back_to_the_default_currency_when_there_is_no_currency_column()
    {
        const string euCsv =
            "Datum;Betrag;Beschreibung\n" +
            "20.06.2026;-1.234,56;MIETE\n" +
            "21.06.2026;2.000,00;GEHALT\n";

        var mapping = _importer.Detect(euCsv).Suggested with { DefaultCurrency = "EUR" };

        Assert.Equal(';', mapping.Delimiter);
        Assert.Null(mapping.CurrencyColumn);

        var statement = _importer.Parse(euCsv, mapping);
        Assert.Equal(2, statement.Entries.Count);
        Assert.All(statement.Entries, e => Assert.Equal("EUR", e.Currency));

        // "-1.234,56" (comma decimal, dot grouping) -> 1234.56 out.
        Assert.Equal(1234.56m, statement.Entries[0].Amount);
        Assert.False(statement.Entries[0].IsCredit);
        Assert.Equal(new DateOnly(2026, 6, 20), statement.Entries[0].BookingDate);
    }

    [Theory]
    [InlineData("-42.50", CsvDecimalStyle.Dot, -42.50)]
    [InlineData("1,234.56", CsvDecimalStyle.Dot, 1234.56)]
    [InlineData("1.234,56", CsvDecimalStyle.Comma, 1234.56)]
    [InlineData("(35.00)", CsvDecimalStyle.Dot, -35.00)] // accounting-style negative
    public void Parse_honours_the_chosen_decimal_style(string amountCell, CsvDecimalStyle style, double expected)
    {
        // Always quote the amount so an embedded comma (grouping or comma-decimal) can't split the row.
        var csv = $"2026-06-20,PAYEE,\"{amountCell}\"\n";
        var mapping = new CsvMapping(',', HasHeader: false, DateColumn: 0, AmountColumn: 2,
            DescriptionColumn: 1, CurrencyColumn: null, DateFormat: null, DecimalStyle: style, DefaultCurrency: "USD");

        var statement = _importer.Parse(csv, mapping);
        var entry = statement.Entries.Single();
        var signed = entry.IsCredit ? entry.Amount : -entry.Amount;
        Assert.Equal((decimal)expected, signed);
    }

    [Fact]
    public void Parse_locks_one_date_format_for_the_whole_file()
    {
        // "06/01/2026" is ambiguous (6 Jan dd/MM or 1 Jun MM/dd) but "06/15/2026" only parses as
        // MM/dd — so the WHOLE file must be read as MM/dd. Per-row trying would split the file
        // across two calendars (and destabilise the idempotency references).
        const string usCsv =
            "06/01/2026,COFFEE SHOP,-3.50\n" +
            "06/15/2026,FUEL STATION,-50.00\n";
        var mapping = new CsvMapping(',', HasHeader: false, DateColumn: 0, AmountColumn: 2,
            DescriptionColumn: 1, CurrencyColumn: null, DateFormat: null, DecimalStyle: CsvDecimalStyle.Auto, DefaultCurrency: "USD");

        var statement = _importer.Parse(usCsv, mapping);

        Assert.Equal(2, statement.Entries.Count);
        Assert.Equal(new DateOnly(2026, 6, 1), statement.Entries[0].BookingDate);
        Assert.Equal(new DateOnly(2026, 6, 15), statement.Entries[1].BookingDate);

        // And the choice is deterministic: re-parsing yields identical references.
        var again = _importer.Parse(usCsv, mapping);
        Assert.Equal(
            statement.Entries.Select(e => e.Reference),
            again.Entries.Select(e => e.Reference));
    }

    [Fact]
    public void Parse_an_explicit_date_format_still_wins_over_the_file_scan()
    {
        const string csv = "06/01/2026,COFFEE SHOP,-3.50\n";
        var mapping = new CsvMapping(',', HasHeader: false, DateColumn: 0, AmountColumn: 2,
            DescriptionColumn: 1, CurrencyColumn: null, DateFormat: "dd/MM/yyyy", DecimalStyle: CsvDecimalStyle.Auto, DefaultCurrency: "EUR");

        var statement = _importer.Parse(csv, mapping);

        Assert.Equal(new DateOnly(2026, 1, 6), statement.Entries.Single().BookingDate);
    }

    [Fact]
    public void Parse_cleans_hsbc_style_description_blobs_into_the_merchant_name()
    {
        // A generic export whose description cell carries HSBC's packed Details shape — the payee
        // shown to the user is just the merchant, not the date/card-mask/amount noise.
        const string csv =
            "19/06/2026,AUTOMARKET SER STATION  * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR,-35.00\n" +
            "20/06/2026,PLAIN DESCRIPTION,-12.00\n";
        var mapping = new CsvMapping(',', HasHeader: false, DateColumn: 0, AmountColumn: 2,
            DescriptionColumn: 1, CurrencyColumn: null, DateFormat: null, DecimalStyle: CsvDecimalStyle.Auto, DefaultCurrency: "EUR");

        var statement = _importer.Parse(csv, mapping);

        Assert.Equal("AUTOMARKET SER STATION", statement.Entries[0].Payee);
        Assert.Equal("PLAIN DESCRIPTION", statement.Entries[1].Payee); // untouched
    }

    [Fact]
    public void Parse_keys_references_on_the_raw_description_not_the_cleaned_payee()
    {
        // Two same-day, same-amount rows whose raw cells differ only in the packed tail: they
        // clean to the SAME payee but must keep DISTINCT first-occurrence references — proof the
        // idempotency signature reads the raw cell (backwards-compatible with earlier imports).
        const string csv =
            "19/06/2026,MERCHANT A * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR,-35.00\n" +
            "19/06/2026,MERCHANT A * 18/06/2026 •••• •••• •••• 9999 -35.00 EUR,-35.00\n";
        var mapping = new CsvMapping(',', HasHeader: false, DateColumn: 0, AmountColumn: 2,
            DescriptionColumn: 1, CurrencyColumn: null, DateFormat: null, DecimalStyle: CsvDecimalStyle.Auto, DefaultCurrency: "EUR");

        var statement = _importer.Parse(csv, mapping);

        Assert.Equal("MERCHANT A", statement.Entries[0].Payee);
        Assert.Equal("MERCHANT A", statement.Entries[1].Payee);
        Assert.NotEqual(statement.Entries[0].Reference, statement.Entries[1].Reference);
        Assert.All(statement.Entries, e => Assert.EndsWith("#0", e.Reference)); // distinct signatures, not #0/#1
    }

    [Fact]
    public void Parse_references_are_stable_across_releases()
    {
        // GOLDEN VALUES: production BankReferences bake in exactly this signature composition
        // (date|signed amount|UPPER raw description, SHA-256/128, per-signature occurrence).
        // If this test breaks, a re-import of any previously-imported file will DUPLICATE every
        // transaction — do not update the expected strings without a data-migration plan.
        var mapping = _importer.Detect(CommaCsv).Suggested with { DefaultCurrency = "GBP" };
        var statement = _importer.Parse(CommaCsv, mapping);

        // SHA-256("2026-06-20|-42.5|TESCO STORES"), first 128 bits; the identical second row
        // shares the signature and takes occurrence #1.
        Assert.Equal("csv:8babbc80a18fc258834cd1bbd3e3c7fb#0", statement.Entries[0].Reference);
        Assert.Equal("csv:8babbc80a18fc258834cd1bbd3e3c7fb#1", statement.Entries[1].Reference);
    }

    [Fact]
    public void Parse_throws_when_nothing_usable_is_found()
    {
        const string junk = "just,some,headers\nand,no,dates\n";
        var mapping = new CsvMapping(',', HasHeader: true, DateColumn: 0, AmountColumn: 1,
            DescriptionColumn: 2, CurrencyColumn: null, DateFormat: null, DecimalStyle: CsvDecimalStyle.Auto, DefaultCurrency: "EUR");

        Assert.Throws<StatementParseException>(() => _importer.Parse(junk, mapping));
    }
}
