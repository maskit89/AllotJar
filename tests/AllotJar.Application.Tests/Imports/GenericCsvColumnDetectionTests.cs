using System.Text.Json;
using AllotJar.Application.Imports.Models;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Separate Debit and Credit columns, and finding the columns of a bank CSV by the names banks
/// use, below any lines the bank prints above the table (27 Oct 2026).
/// </summary>
public class GenericCsvColumnDetectionTests
{
    private readonly GenericCsvImporter _importer = new();

    // APS-style: a preamble, then Date, Value Date, Description, Debit, Credit, Balance.
    private const string DebitCreditCsv =
        "APS Bank plc\n" +
        "Account,Current account\n" +
        "From,01/09/2026\n" +
        "To,30/09/2026\n" +
        "\n" +
        "Date,Value Date,Description,Debit,Credit,Balance\n" +
        "01/09/2026,02/09/2026,POS LIDL QORMI,23.40,,1976.60\n" +
        "02/09/2026,02/09/2026,SALARY ACME LTD,,\"2,100.00\",4076.60\n" +
        "05/09/2026,05/09/2026,ATM WITHDRAWAL,50.00,,4026.60\n";

    [Fact]
    public void Detect_finds_the_header_below_the_banks_preamble_and_picks_debit_and_credit()
    {
        var layout = _importer.Detect(DebitCreditCsv);
        var m = layout.Suggested;

        Assert.Equal(',', m.Delimiter);
        Assert.True(m.HasHeader);
        Assert.Equal(4, m.SkipRows);
        Assert.Equal(0, m.DateColumn); // the booking date, not the value date
        Assert.Equal(2, m.DescriptionColumn);
        Assert.Equal(3, m.DebitColumn);
        Assert.Equal(4, m.CreditColumn);
        Assert.True(m.SplitAmounts);
        Assert.Null(m.CurrencyColumn);
        Assert.Equal(new[] { "Date", "Value Date", "Description", "Debit", "Credit", "Balance" }, layout.Columns);
        Assert.Equal("01/09/2026", layout.SampleRows[0][0]);
    }

    [Fact]
    public void Parse_reads_money_out_from_debit_and_money_in_from_credit()
    {
        var mapping = _importer.Detect(DebitCreditCsv).Suggested with { DefaultCurrency = "EUR" };
        var entries = _importer.Parse(DebitCreditCsv, mapping).Entries;

        Assert.Equal(3, entries.Count);
        Assert.Equal((23.40m, false, "POS LIDL QORMI"), (entries[0].Amount, entries[0].IsCredit, entries[0].Payee));
        Assert.Equal((2100.00m, true), (entries[1].Amount, entries[1].IsCredit));
        Assert.Equal((50.00m, false), (entries[2].Amount, entries[2].IsCredit));
        Assert.Equal(new DateOnly(2026, 9, 1), entries[0].BookingDate);
    }

    [Fact]
    public void Parse_gives_a_split_row_the_reference_the_same_row_gets_from_a_signed_column()
    {
        const string signed =
            "Date,Description,Amount\n" +
            "01/09/2026,POS LIDL QORMI,-23.40\n";
        var fromSigned = _importer.Parse(signed, _importer.Detect(signed).Suggested).Entries[0];
        var fromSplit = _importer.Parse(DebitCreditCsv, _importer.Detect(DebitCreditCsv).Suggested).Entries[0];

        Assert.Equal(fromSigned.Reference, fromSplit.Reference);
    }

    [Fact]
    public void Parse_ignores_a_minus_sign_the_bank_prints_in_the_debit_column()
    {
        const string csv =
            "Date,Details,Money out,Money in\n" +
            "2026-09-01,TESCO,-12.00,\n" +
            "2026-09-02,REFUND,,5.00\n";
        var mapping = _importer.Detect(csv).Suggested;
        var entries = _importer.Parse(csv, mapping).Entries;

        Assert.Equal((2, 3), (mapping.DebitColumn, mapping.CreditColumn));
        Assert.Equal((12.00m, false), (entries[0].Amount, entries[0].IsCredit));
        Assert.Equal((5.00m, true), (entries[1].Amount, entries[1].IsCredit));
    }

    [Fact]
    public void Detect_never_takes_the_balance_or_the_value_date_for_the_amount()
    {
        const string csv =
            "Value Date,Balance,Narrative,Transaction Amount\n" +
            "2026-09-01,100.00,COFFEE,-3.50\n" +
            "2026-09-02,96.50,BREAD,-2.00\n";
        var m = _importer.Detect(csv).Suggested;

        Assert.Equal(0, m.DateColumn); // only a value date: still the date
        Assert.Equal(3, m.AmountColumn);
        Assert.Equal(2, m.DescriptionColumn);
        Assert.False(m.SplitAmounts);
    }

    [Fact]
    public void Detect_matches_header_words_whole_so_in_does_not_match_description()
    {
        const string csv =
            "Posting Date;Transaction Description;Paid out;Paid in;Currency\n" +
            "01.09.2026;SPAR;10,50;;EUR\n" +
            "02.09.2026;INTEREST;;0,12;EUR\n";
        var m = _importer.Detect(csv).Suggested;

        Assert.Equal(';', m.Delimiter);
        Assert.Equal(1, m.DescriptionColumn);
        Assert.Equal((2, 3), (m.DebitColumn, m.CreditColumn));
        Assert.Equal(4, m.CurrencyColumn);

        var entries = _importer.Parse(csv, m).Entries;
        Assert.Equal((10.50m, false), (entries[0].Amount, entries[0].IsCredit));
        Assert.Equal((0.12m, true), (entries[1].Amount, entries[1].IsCredit));
    }

    [Fact]
    public void Detect_without_a_header_finds_two_number_columns_that_each_row_fills_one_of()
    {
        const string csv =
            "01/09/2026,POS LIDL QORMI,23.40,,1976.60\n" +
            "02/09/2026,SALARY ACME LTD,,2100.00,4076.60\n" +
            "05/09/2026,ATM WITHDRAWAL,50.00,,4026.60\n";
        var m = _importer.Detect(csv).Suggested;

        Assert.False(m.HasHeader);
        Assert.Equal((2, 3), (m.DebitColumn, m.CreditColumn));
        Assert.Equal(1, m.DescriptionColumn);
    }

    [Fact]
    public void Detect_picks_the_semicolon_when_amounts_use_a_decimal_comma()
    {
        const string csv =
            "Datum;Omschrijving;Bedrag\n" +
            "01-09-2026;ALBERT HEIJN;-12,50\n" +
            "02-09-2026;SALARIS;2500,00\n";
        var m = _importer.Detect(csv).Suggested;

        Assert.Equal(';', m.Delimiter);
        Assert.Equal(0, m.DateColumn);
        Assert.Equal(2, m.AmountColumn);
        Assert.Equal(1, m.DescriptionColumn);
    }

    [Fact]
    public void Detect_reads_maltese_headers()
    {
        const string csv =
            "Data,Deskrizzjoni,Debitu,Kreditu,Bilanċ\n" +
            "01/09/2026,PIZZERIA,12.00,,88.00\n" +
            "02/09/2026,PAGA,,900.00,988.00\n";
        var m = _importer.Detect(csv).Suggested;

        Assert.Equal(0, m.DateColumn);
        Assert.Equal(1, m.DescriptionColumn);
        Assert.Equal((2, 3), (m.DebitColumn, m.CreditColumn));
    }

    [Fact]
    public void A_mapping_sent_without_the_new_fields_reads_one_signed_column_from_the_first_line()
    {
        var mapping = new CsvMapping(',', true, 0, 2, 1, null, null, CsvDecimalStyle.Auto, "EUR");
        Assert.False(mapping.SplitAmounts);
        Assert.Equal(0, mapping.SkipRows);

        var entries = _importer.Parse("Date,Description,Amount\n2026-09-01,TESCO,-1.00\n", mapping).Entries;
        Assert.Equal((1.00m, false), (entries[0].Amount, entries[0].IsCredit));
    }

    [Fact]
    public void The_mapping_travels_as_json_with_and_without_the_new_fields()
    {
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var old = JsonSerializer.Deserialize<CsvMapping>(
            """{"delimiter":",","hasHeader":true,"dateColumn":0,"amountColumn":2,"descriptionColumn":1,"currencyColumn":null,"dateFormat":null,"decimalStyle":0,"defaultCurrency":"EUR"}""", web)!;
        Assert.Equal((null, null, 0), (old.DebitColumn, old.CreditColumn, old.SkipRows));

        var split = _importer.Detect(DebitCreditCsv).Suggested;
        var json = JsonSerializer.Serialize(split, web);
        Assert.DoesNotContain("splitAmounts", json);
        Assert.Equal(split, JsonSerializer.Deserialize<CsvMapping>(json, web));
    }
}
