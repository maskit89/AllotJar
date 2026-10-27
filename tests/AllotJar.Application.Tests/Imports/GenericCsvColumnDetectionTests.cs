using System.Text;
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

    // --- Review round 1 of #404 -----------------------------------------------------------------

    private (CsvMapping Mapping, IReadOnlyList<ParsedStatementEntry> Entries) Read(string csv)
    {
        var m = _importer.Detect(csv).Suggested with { DefaultCurrency = "EUR" };
        return (m, _importer.Parse(csv, m).Entries);
    }

    [Theory]
    [InlineData("SHOP")]
    [InlineData("POS 4921 LIDL QORMI")]
    public void A_debit_credit_file_with_no_credit_for_weeks_keeps_its_pair(string payee)
    {
        var sb = new StringBuilder("Date,Description,Debit,Credit,Balance\n");
        for (var i = 1; i <= 31; i++) sb.Append($"{i:00}/08/2026,{payee},10.00,,{5000 - 10 * i}.00\n");
        sb.Append("01/09/2026,SALARY,,2000.00,6690.00\n");
        var (m, entries) = Read(sb.ToString());

        Assert.Equal((2, 3), (m.DebitColumn, m.CreditColumn));
        Assert.Equal(32, entries.Count);
        Assert.All(entries.Take(31), e => Assert.Equal((10.00m, false), (e.Amount, e.IsCredit)));
        Assert.Equal((2000.00m, true), (entries[31].Amount, entries[31].IsCredit));
    }

    [Fact]
    public void A_card_statement_with_an_empty_credit_column_imports_purchases_as_money_out()
    {
        var (m, entries) = Read("Date,Description,Debit,Credit\n01/09/2026,AMAZON,25.00,\n02/09/2026,LIDL,40.00,\n03/09/2026,SHELL,60.00,\n");

        Assert.Equal((2, 3), (m.DebitColumn, m.CreditColumn));
        Assert.All(entries, e => Assert.False(e.IsCredit));
    }

    [Fact]
    public void A_column_named_debit_is_never_read_as_a_signed_amount()
    {
        // Only a Debit header and text in the next column: no pair, and Debit is not the amount.
        var m = _importer.Detect("Date,Description,Debit,Note\n01/09/2026,LIDL,23.40,x\n02/09/2026,ATM,50.00,y\n").Suggested;
        Assert.NotEqual(2, m.AmountColumn);
    }

    [Fact]
    public void Dashes_in_debit_and_credit_are_empty_cells()
    {
        var (m, entries) = Read("Date,Description,Debit,Credit,Balance\n01/09/2026,LIDL,23.40,-,976.60\n02/09/2026,SALARY,-,2100.00,3076.60\n03/09/2026,ATM,50.00,-,3026.60\n");

        Assert.Equal((2, 3), (m.DebitColumn, m.CreditColumn));
        Assert.Equal(new[] { false, true, false }, entries.Select(e => e.IsCredit));
    }

    [Fact]
    public void Text_with_digits_is_not_an_amount_and_a_cheque_number_column_is_not_a_pair()
    {
        var sb = new StringBuilder();
        for (var i = 1; i <= 10; i++) sb.Append($"{i:00}/09/2026,PAYEE {i},{(i == 5 ? "100234" : "")},-{i}.50,{1000 - i}.00\n");
        sb.Append("11/09/2026,SALARY,,2000.00,3000.00\n");
        var (m, entries) = Read(sb.ToString());

        Assert.False(m.SplitAmounts);
        Assert.Equal(3, m.AmountColumn);
        Assert.Equal(1, m.DescriptionColumn);
        Assert.Equal((5.50m, false), (entries[4].Amount, entries[4].IsCredit));
        Assert.Equal((2000.00m, true), (entries[10].Amount, entries[10].IsCredit));
    }

    [Fact]
    public void A_signed_amount_beside_a_sparse_fee_column_stays_one_signed_column()
    {
        var sb = new StringBuilder();
        for (var i = 1; i <= 10; i++) sb.Append($"{i:00}/09/2026,PAYEE {i},{(i == 4 ? "" : "-")}{i}.50,{(i == 3 ? "0.50" : "")},EUR\n");
        var (m, entries) = Read(sb.ToString());

        Assert.False(m.SplitAmounts);
        Assert.Equal(2, m.AmountColumn);
        Assert.True(entries[3].IsCredit);
        Assert.Equal(3.50m, entries[2].Amount);
    }

    [Theory]
    // Credit printed before debit: the balance shows which is which, oldest or newest first.
    [InlineData("01/09/2026,LIDL,,23.40,976.60\n02/09/2026,SALARY,2100.00,,3076.60\n03/09/2026,ATM,,50.00,3026.60\n")]
    [InlineData("03/09/2026,ATM,,50.00,3026.60\n02/09/2026,SALARY,2100.00,,3076.60\n01/09/2026,LIDL,,23.40,976.60\n")]
    public void Without_a_header_the_running_balance_decides_which_column_is_money_out(string csv)
    {
        var (m, entries) = Read(csv);

        Assert.Equal((3, 2), (m.DebitColumn, m.CreditColumn));
        Assert.True(entries.Single(e => e.Payee == "SALARY").IsCredit);
        Assert.False(entries.Single(e => e.Payee == "LIDL").IsCredit);
    }

    [Fact]
    public void A_first_row_printed_without_its_trailing_empty_fields_is_not_skipped()
    {
        var (m, entries) = Read("Date,Description,Debit,Credit\n01/09/2026,LIDL,23.40\n02/09/2026,ATM,50.00\n03/09/2026,SALARY,,2100.00\n");

        Assert.Equal((0, true), (m.SkipRows, m.HasHeader));
        Assert.Equal(3, entries.Count);
        Assert.Equal("LIDL", entries[0].Payee);
    }

    [Fact]
    public void A_narrow_first_row_keeps_the_header_and_a_typographic_minus_is_money_out()
    {
        var (m, entries) = Read("Date,Description,Amount,Note\n01/09/2026,LIDL,−23.40\n02/09/2026,SALARY,\"€2,100.00\",x\n03/09/2026,ATM,(50.00),y\n");

        Assert.Equal((0, true), (m.SkipRows, m.HasHeader));
        Assert.Equal((23.40m, false), (entries[0].Amount, entries[0].IsCredit));
        Assert.True(entries[1].IsCredit);
        Assert.False(entries[2].IsCredit);
    }

    [Fact]
    public void An_excel_padded_preamble_line_with_dates_is_not_the_table()
    {
        var (m, entries) = Read("Account,40012345678,,,,\nPeriod,01/09/2026,30/09/2026,,,\nDate,Value Date,Description,Debit,Credit,Balance\n01/09/2026,02/09/2026,LIDL,23.40,,976.60\n02/09/2026,02/09/2026,SALARY,,2100.00,3076.60\n");

        Assert.Equal((2, true), (m.SkipRows, m.HasHeader));
        Assert.Equal((0, 3, 4), (m.DateColumn, m.DebitColumn, m.CreditColumn));
        Assert.Equal(new[] { (23.40m, false), (2100.00m, true) }, entries.Select(e => (e.Amount, e.IsCredit)));
    }

    [Fact]
    public void Dr_and_cr_markers_on_amounts_set_the_direction()
    {
        var (_, entries) = Read("Date,Description,Amount\n01/09/2026,LIDL,23.40 DR\n02/09/2026,SALARY,2100.00 CR\n03/09/2026,ATM,50.00DR\n04/09/2026,FEE,DR 1.00\n");

        Assert.Equal(new[] { false, true, false, false }, entries.Select(e => e.IsCredit));
        Assert.Equal(23.40m, entries[0].Amount);
    }

    [Theory]
    [InlineData("Date,Description,Amount,Dr/Cr\n01/09/2026,LIDL,23.40,DR\n02/09/2026,SALARY,2100.00,CR\n03/09/2026,ATM,50.00,DR\n")]
    [InlineData("Date,Description,Amount,Debit/Credit\n01/09/2026,LIDL,23.40,Debit\n02/09/2026,SALARY,2100.00,Credit\n03/09/2026,ATM,50.00,Debit\n")]
    [InlineData("Date,Description,Transaction Type,Amount\n01/09/2026,LIDL,DEBIT,23.40\n02/09/2026,SALARY,CREDIT,2100.00\n03/09/2026,ATM,DEBIT,50.00\n")]
    public void An_amount_with_a_debit_credit_marker_column_takes_its_direction(string csv)
    {
        var (m, entries) = Read(csv);

        Assert.NotNull(m.DirectionColumn);
        Assert.False(m.SplitAmounts);
        Assert.Equal(new[] { false, true, false }, entries.Select(e => e.IsCredit));
    }

    [Fact]
    public void Headers_found_by_name_in_common_layouts()
    {
        Assert.Equal((3, 4), Pair("Date,Type,Description,Paid out,Paid in,Balance\n01/09/2026,POS,LIDL,23.40,,976.60\n02/09/2026,BGC,SALARY,,2100.00,3076.60\n"));
        Assert.Equal((2, 3), Pair("Date,Payment Details,Withdrawals,Deposits,Balance\n01/09/2026,LIDL,23.40,,976.60\n02/09/2026,SALARY,,2100.00,3076.60\n"));
        var m = _importer.Detect("Date,Details,Amt (EUR),Running Balance\n01/09/2026,LIDL,-23.40,976.60\n02/09/2026,SALARY,2100.00,3076.60\n").Suggested;
        Assert.Equal((2, 1), (m.AmountColumn, m.DescriptionColumn));

        (int?, int?) Pair(string csv)
        {
            var s = _importer.Detect(csv).Suggested;
            return (s.DebitColumn, s.CreditColumn);
        }
    }

    [Fact]
    public void A_balance_that_does_not_add_up_leaves_money_out_on_the_left()
    {
        var sb = new StringBuilder();
        for (var i = 1; i <= 9; i++) sb.Append($"{i:00}/09/2026,\"POS {1000 + i} SHOP\",{i}.00,,{900 - i}.00\n");
        sb.Append("10/09/2026,\"SALARY 2026\",,2000.00,2855.00\n");
        var (m, entries) = Read(sb.ToString());

        Assert.Equal((2, 3), (m.DebitColumn, m.CreditColumn));
        Assert.Equal(9, entries.Count(e => !e.IsCredit));
    }

    // --- Review round 2 of #404 -----------------------------------------------------------------

    [Fact]
    public void A_summary_block_above_the_table_is_not_its_header()
    {
        var (m, entries) = Read(
            "Statement Date,Payment Due Date,Minimum Payment,Total Amount\n" +
            "Statement,30 Sep,25.00,523.40\n" +
            "Date,Description,Amount,Balance\n" +
            "01/09/2026,AMAZON,-25.00,25.00\n02/09/2026,LIDL,-40.00,65.00\n03/09/2026,REFUND,5.00,60.00\n");

        Assert.Equal((2, true, 2), (m.SkipRows, m.HasHeader, m.AmountColumn));
        Assert.Equal(new[] { false, false, true }, entries.Select(e => e.IsCredit));
    }

    [Fact]
    public void A_summary_block_with_a_date_in_it_is_not_the_table()
    {
        var (m, entries) = Read(
            "Card,Statement date,Total amount\n" +
            "****1234,30/09/2026,523.40\n" +
            "Date,Description,Debit,Credit\n" +
            "01/09/2026,AMAZON,25.00,\n02/09/2026,LIDL,40.00,\n03/09/2026,REFUND,,5.00\n");

        Assert.Equal((2, 2, 3), (m.SkipRows, m.DebitColumn, m.CreditColumn));
        Assert.Equal(new[] { (25.00m, false), (40.00m, false), (5.00m, true) }, entries.Select(e => (e.Amount, e.IsCredit)));
    }

    [Fact]
    public void One_text_cell_in_debit_keeps_the_pair_and_a_reference_column_is_never_the_amount()
    {
        var (m, entries) = Read(
            "Date,Ref,Description,Debit,Credit,Balance\n" +
            "01/09/2026,100231,LIDL,23.40,,976.60\n02/09/2026,100232,SALARY,,2100.00,3076.60\n" +
            "03/09/2026,100233,CARD HOLD,PENDING,,3076.60\n04/09/2026,100234,ATM,50.00,,3026.60\n");

        Assert.Equal((3, 4), (m.DebitColumn, m.CreditColumn));
        Assert.Equal(new[] { (23.40m, false), (2100.00m, true), (50.00m, false) }, entries.Select(e => (e.Amount, e.IsCredit)));

        // With no Debit/Credit headers at all, Ref is still not taken for the amount.
        var plain = _importer.Detect("Date,Ref,Description,Value\n01/09/2026,100231,LIDL,-23.40\n02/09/2026,100232,SALARY,2100.00\n").Suggested;
        Assert.Equal(3, plain.AmountColumn);
    }

    [Fact]
    public void With_a_header_a_direction_column_must_be_named_for_it()
    {
        // A status column coded C/D (Cleared/Declined) is not a direction.
        var m = _importer.Detect("Date,Description,Amount,Status\n01/09/2026,LIDL,-23.40,C\n02/09/2026,SALARY,2100.00,D\n03/09/2026,ATM,-50.00,C\n").Suggested;
        Assert.Null(m.DirectionColumn);
    }
}
