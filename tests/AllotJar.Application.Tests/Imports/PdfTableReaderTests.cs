using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using FluentAssertions;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Infrastructure.Statements;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Core;
using UglyToad.PdfPig.Fonts.Standard14Fonts;
using UglyToad.PdfPig.Writer;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// A PDF statement's table rebuilt as CSV and read by the generic CSV import (28 Oct 2026). The
/// PDFs are built here from made-up rows; no bank's statement is used.
/// </summary>
public class PdfTableReaderTests
{
    private readonly PdfTableReader _reader = new();
    private readonly GenericCsvImporter _importer = new();

    /// <summary>A line of words, each at its own x, on one baseline.</summary>
    private sealed record Text(double Y, params (double X, string Word)[] Words);

    private static byte[] Pdf(params Text[][] pages)
    {
        var builder = new PdfDocumentBuilder();
        var font = builder.AddStandard14Font(Standard14Font.Helvetica);
        foreach (var lines in pages)
        {
            var page = builder.AddPage(PageSize.A4);
            foreach (var line in lines)
            {
                foreach (var (x, word) in line.Words)
                {
                    page.AddText(word, 9, new PdfPoint(x, line.Y), font);
                }
            }
        }
        return builder.Build();
    }

    // A card statement: a date above the table that is not a row, a header over two lines, a
    // second description line under one row, and the amount in the account's currency.
    private static readonly Text[] CardStatement =
    [
        new(800, (40, "Example Bank")),
        new(785, (350, "Statement date"), (430, "30/09/2026")),
        new(700, (40, "Transaction"), (110, "Posting"), (420, "Amount")),
        new(689, (40, "Date"), (110, "Date"), (200, "Detail"), (420, "in EUR")),
        new(670, (40, "01/09/26"), (110, "02/09/26"), (200, "Cafe Roma Valletta"), (420, "-12.50")),
        new(655, (40, "03/09/26"), (110, "04/09/26"), (200, "Online Shop"), (420, "-40.00")),
        new(644, (200, "Order for groceries")),
        new(625, (40, "15/09/26"), (110, "15/09/26"), (200, "Payment received"), (420, "500.00")),
        new(560, (40, "Page 1 of 1")),
    ];

    [Fact]
    public void A_card_statement_reads_as_a_table_with_one_header_and_its_rows()
    {
        var csv = _reader.ReadAsCsv(Pdf(CardStatement), default);

        var lines = csv.TrimEnd('\n').Split('\n');
        lines.Should().Contain("Transaction Date,Posting Date,Detail,Amount in EUR");
        lines.Should().Contain("01/09/26,02/09/26,Cafe Roma Valletta,-12.50");
        // The second description line joins its row.
        lines.Should().Contain("03/09/26,04/09/26,Online Shop Order for groceries,-40.00");
        lines.Should().Contain("15/09/26,15/09/26,Payment received,500.00");
    }

    [Fact]
    public void A_card_statement_imports_through_the_column_detection()
    {
        var csv = _reader.ReadAsCsv(Pdf(CardStatement), default);

        var layout = _importer.Detect(csv);
        var m = layout.Suggested;
        layout.Columns[m.DateColumn].Should().Be("Transaction Date");
        layout.Columns[m.AmountColumn].Should().Be("Amount in EUR");
        layout.Columns[m.DescriptionColumn].Should().Be("Detail");

        var entries = _importer.Parse(csv, m with { DefaultCurrency = "EUR" }).Entries;
        entries.Should().HaveCount(3);
        entries.Select(e => (e.BookingDate, e.IsCredit, e.Amount)).Should().Equal(
            (new DateOnly(2026, 9, 1), false, 12.50m),
            (new DateOnly(2026, 9, 3), false, 40.00m),
            (new DateOnly(2026, 9, 15), true, 500.00m));
    }

    [Fact]
    public void Debit_and_credit_columns_on_two_pages_with_the_header_repeated_import_as_one_table()
    {
        Text Header(double y) => new(y, (40, "Date"), (110, "Description"), (330, "Debit"), (400, "Credit"), (470, "Balance"));
        var pdf = Pdf(
            [
                new(800, (40, "Current account")),
                Header(700),
                new(685, (40, "1 Sep 2026"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
                new(670, (40, "2 Sep 2026"), (110, "Salary"), (400, "2,100.00"), (470, "3,076.60")),
            ],
            [
                Header(700),
                new(685, (40, "5 Sep 2026"), (110, "Cash withdrawal"), (330, "50.00"), (470, "3,026.60")),
            ]);

        var csv = _reader.ReadAsCsv(pdf, default);
        var layout = _importer.Detect(csv);
        var m = layout.Suggested;
        layout.Columns[m.DebitColumn!.Value].Should().Be("Debit");
        layout.Columns[m.CreditColumn!.Value].Should().Be("Credit");

        var entries = _importer.Parse(csv, m with { DefaultCurrency = "EUR" }).Entries;
        entries.Select(e => (e.BookingDate, e.IsCredit, e.Amount, e.Payee)).Should().Equal(
            (new DateOnly(2026, 9, 1), false, 23.40m, "Supermarket"),
            (new DateOnly(2026, 9, 2), true, 2100.00m, "Salary"),
            (new DateOnly(2026, 9, 5), false, 50.00m, "Cash withdrawal"));
    }

    private static Text Header(double y) => new(y, (40, "Date"), (110, "Description"), (330, "Debit"), (400, "Credit"), (470, "Balance"));

    private IReadOnlyList<(DateOnly Date, bool In, decimal Amount, string Payee)> Import(byte[] pdf)
    {
        var csv = _reader.ReadAsCsv(pdf, default);
        var m = _importer.Detect(csv).Suggested;
        return _importer.Parse(csv, m with { DefaultCurrency = "EUR" }).Entries
            .Select(e => (e.BookingDate, e.IsCredit, e.Amount, e.Payee)).ToList();
    }

    [Fact]
    public void A_statement_with_no_money_in_keeps_its_empty_credit_column()
    {
        // Review #405 P1-2: no row fills Credit, so its column comes from the header alone.
        var entries = Import(Pdf([
            Header(700),
            new(685, (40, "01/09/2026"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
            new(670, (40, "02/09/2026"), (110, "Amazon"), (330, "40.00"), (470, "936.60")),
            new(655, (40, "03/09/2026"), (110, "Hotel Roma"), (330, "100.00"), (470, "836.60")),
        ]));

        entries.Should().HaveCount(3).And.OnlyContain(e => !e.In);
        entries.Sum(e => e.Amount).Should().Be(163.40m);
    }

    [Fact]
    public void Rows_under_a_date_printed_once_per_day_take_that_date()
    {
        // Review #405 P1-3 (A1).
        var entries = Import(Pdf([
            Header(700),
            new(685, (40, "01/09/2026"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
            new(670, (110, "Pharmacy"), (330, "12.00"), (470, "964.60")),
            new(655, (110, "Coffee"), (330, "3.20"), (470, "961.40")),
            new(640, (40, "02/09/2026"), (110, "Salary"), (400, "2,100.00"), (470, "3,061.40")),
            new(580, (110, "Total"), (330, "38.60"), (400, "2,100.00")),
        ]));

        entries.Should().Equal(
            (new DateOnly(2026, 9, 1), false, 23.40m, "Supermarket"),
            (new DateOnly(2026, 9, 1), false, 12.00m, "Pharmacy"),
            (new DateOnly(2026, 9, 1), false, 3.20m, "Coffee"),
            (new DateOnly(2026, 9, 2), true, 2100.00m, "Salary"));
    }

    [Fact]
    public void Amounts_printed_lower_than_the_rows_date_join_that_row()
    {
        // Review #405 P1-3 (A2): a two-line description with the amounts centred between the lines.
        var entries = Import(Pdf([
            Header(700),
            new(685, (40, "01/09/2026"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
            new(670, (40, "02/09/2026"), (110, "Standing order to")),
            new(665, (330, "500.00"), (470, "476.60")),
            new(660, (110, "J Borg rent")),
            new(645, (40, "03/09/2026"), (110, "Salary"), (400, "2,100.00"), (470, "2,576.60")),
        ]));

        entries.Should().Contain((new DateOnly(2026, 9, 2), false, 500.00m, "Standing order to J Borg rent"));
        entries.Should().HaveCount(3);
    }

    [Fact]
    public void A_description_running_up_to_the_amount_does_not_join_the_two_columns()
    {
        // Review #405 P2-1 (A3b).
        var builder = new PdfDocumentBuilder();
        var font = builder.AddStandard14Font(Standard14Font.Helvetica);
        var page = builder.AddPage(PageSize.A4);
        void T(double x, double y, string w) => page.AddText(w, 9, new PdfPoint(x, y), font);
        foreach (var (x, w) in new[] { (40.0, "Date"), (110, "Description"), (330, "Debit"), (400, "Credit"), (470, "Balance") }) T(x, 700, w);
        T(40, 685, "01/09/2026"); T(110, 685, "Supermarket"); T(335, 685, "23.40"); T(470, 685, "976.60");
        T(40, 670, "02/09/2026");
        var letters = page.AddText("AMAZON MKTPLACE PMTS AMZN.COM/BILL LU", 9, new PdfPoint(110, 670), font);
        T(letters[^1].BoundingBox.Right + 5, 670, "40.00"); T(470, 670, "936.60");
        T(40, 655, "03/09/2026"); T(110, 655, "Salary"); T(400, 655, "2,100.00"); T(470, 655, "3,036.60");

        var entries = Import(builder.Build());

        entries.Should().Equal(
            (new DateOnly(2026, 9, 1), false, 23.40m, "Supermarket"),
            (new DateOnly(2026, 9, 2), false, 40.00m, "AMAZON MKTPLACE PMTS AMZN.COM/BILL LU"),
            (new DateOnly(2026, 9, 3), true, 2100.00m, "Salary"));
    }

    [Fact]
    public void The_summary_under_the_table_is_not_imported()
    {
        // Review #405 P2-2 (A5).
        var entries = Import(Pdf(
            CardStatement[..^1],
            [
                new(700, (40, "Transaction"), (110, "Posting"), (420, "Amount")),
                new(689, (40, "Date"), (110, "Date"), (200, "Detail"), (420, "in EUR")),
                new(670, (40, "20/09/26"), (110, "21/09/26"), (200, "Bookshop"), (420, "-8.00")),
                new(600, (40, "30/09/26"), (200, "Closing balance"), (420, "-447.50")),
                new(585, (40, "15/10/26"), (200, "Minimum payment due"), (420, "25.00")),
                new(560, (40, "Page 2 of 2")),
            ]));

        entries.Select(e => e.Payee).Should().Equal("Cafe Roma Valletta", "Online Shop Order for groceries", "Payment received", "Bookshop");
    }

    private static Text[] Table(params Text[] after) =>
    [
        Header(700),
        new(685, (40, "01/09/2026"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
        new(670, (40, "02/09/2026"), (110, "Salary"), (400, "2,100.00"), (470, "3,076.60")),
        new(655, (40, "03/09/2026"), (110, "Cash"), (330, "50.00"), (470, "3,026.60")),
        .. after,
    ];

    [Theory]
    [InlineData(null, "Total")]
    [InlineData(null, "Totals")]
    [InlineData("30/09/2026", "Total for the period")]
    [InlineData(null, "Carried forward")]
    public void A_total_line_under_the_rows_is_not_a_transaction(string? date, string label)
    {
        // Review #405 round 2 (R1, R1b, R1c).
        var words = new List<(double, string)>();
        if (date is not null) words.Add((40, date));
        words.AddRange([(110, label), (330, "73.40"), (400, "2,100.00")]);

        var entries = Import(Pdf(Table(new Text(640, [.. words]))));

        entries.Select(e => e.Payee).Should().Equal("Supermarket", "Salary", "Cash");
    }

    [Fact]
    public void Card_subtotals_are_not_transactions()
    {
        // Review #405 round 2 (R1d): a sub-total per card holder and the total due.
        var entries = Import(Pdf([
            new Text(700, (40, "Date"), (110, "Description"), (420, "Amount")),
            new(685, (40, "01/09/2026"), (110, "Cafe"), (420, "-12.50")),
            new(670, (40, "03/09/2026"), (110, "Shop"), (420, "-40.00")),
            new(655, (110, "Sub-total for J Borg"), (420, "-52.50")),
            new(640, (40, "04/09/2026"), (110, "Bakery"), (420, "-3.00")),
            new(625, (110, "Total amount due"), (420, "-55.50")),
        ]));

        entries.Select(e => e.Payee).Should().Equal("Cafe", "Shop", "Bakery");
        entries.Sum(e => e.Amount).Should().Be(55.50m);
    }

    [Fact]
    public void A_line_whose_amount_is_the_sum_of_the_rows_above_is_a_subtotal()
    {
        var entries = Import(Pdf([
            new Text(700, (40, "Date"), (110, "Description"), (420, "Amount")),
            new(685, (40, "01/09/2026"), (110, "Cafe"), (420, "-12.50")),
            new(670, (40, "03/09/2026"), (110, "Shop"), (420, "-40.00")),
            new(655, (110, "J Borg"), (420, "-52.50")),
        ]));

        entries.Select(e => e.Payee).Should().Equal("Cafe", "Shop");
    }

    [Fact]
    public void A_same_day_payment_equal_to_the_rows_above_is_shown_as_not_read()
    {
        // Review #405 round 3 (R7): taken for a subtotal, but counted, never lost unseen.
        var csv = _reader.ReadAsCsv(Pdf([
            new Text(700, (40, "Date"), (110, "Description"), (420, "Amount")),
            new(685, (40, "01/09/2026"), (110, "Coffee"), (420, "-2.50")),
            new(670, (110, "Coffee"), (420, "-2.50")),
            new(655, (110, "Lunch"), (420, "-5.00")),
        ]), default);
        var m = _importer.Detect(csv).Suggested;
        var parsed = _importer.Parse(csv, m with { DefaultCurrency = "EUR" });

        parsed.Entries.Should().HaveCount(2);
        parsed.UnreadLines.Should().Be(1);
    }

    [Fact]
    public void An_undated_amount_line_further_under_the_table_is_shown_as_not_read()
    {
        // Review #405 round 3 (R9).
        var csv = _reader.ReadAsCsv(Pdf(Table(new Text(620, (110, "Card fee"), (330, "2.00")))), default);
        var m = _importer.Detect(csv).Suggested;

        _importer.Parse(csv, m with { DefaultCurrency = "EUR" }).UnreadLines.Should().Be(1);
    }

    [Fact]
    public void A_payment_described_as_a_minimum_payment_is_imported()
    {
        // Review #405 round 2 (R4).
        var entries = Import(Pdf([
            new Text(700, (40, "Date"), (110, "Description"), (420, "Amount")),
            new(685, (40, "01/09/2026"), (110, "Cafe"), (420, "-12.50")),
            new(670, (40, "15/09/2026"), (110, "Minimum payment direct debit"), (420, "25.00")),
        ]));

        entries.Should().Contain((new DateOnly(2026, 9, 15), true, 25.00m, "Minimum payment direct debit"));
    }

    [Fact]
    public void Dates_as_banks_print_them_are_found_wherever_they_line_up()
    {
        // Review #405 A8 and P3-1: right-aligned "1 Sep 2026", and d/M/yy.
        Import(Pdf([
            Header(700),
            new(685, (44, "1"), (52, "Sep"), (70, "2026"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
            new(670, (39, "12"), (52, "Sep"), (70, "2026"), (110, "Salary"), (400, "2,100.00"), (470, "3,076.60")),
        ])).Select(e => e.Date).Should().Equal(new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 12));

        Import(Pdf([
            Header(700),
            new(685, (40, "1/9/26"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
            new(670, (40, "12/9/26"), (110, "Cash"), (330, "50.00"), (470, "926.60")),
        ])).Select(e => e.Date).Should().Equal(new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 12));
    }

    [Fact]
    public void An_account_block_close_above_the_header_is_not_header()
    {
        // Review #405 P3-2 (A10).
        var csv = _reader.ReadAsCsv(Pdf([
            new(722, (40, "Account"), (110, "40012345678"), (330, "Period"), (400, "01/09/2026"), (470, "30/09/2026")),
            new(711, (40, "IBAN"), (110, "MT00XXXX0000000000000000000"), (330, "Opening"), (470, "1,000.00")),
            Header(700),
            new(685, (40, "01/09/2026"), (110, "Supermarket"), (330, "23.40"), (470, "976.60")),
            new(670, (40, "02/09/2026"), (110, "Salary"), (400, "2,100.00"), (470, "3,076.60")),
        ]), default);

        _importer.Detect(csv).Columns.Should().Equal("Date", "Description", "Debit", "Credit", "Balance");
    }

    // --- Heavy PDFs (review #405 P1-1) ---------------------------------------------------------

    private static byte[] Raw(params string[] objects) => RawBytes([.. objects.Select(Encoding.Latin1.GetBytes)]);

    private static byte[] RawBytes(params byte[][] objects)
    {
        var ms = new MemoryStream();
        void W(string s) => ms.Write(Encoding.Latin1.GetBytes(s));
        W("%PDF-1.7\n");
        var offsets = new List<long>();
        for (var i = 0; i < objects.Length; i++)
        {
            offsets.Add(ms.Position);
            W($"{i + 1} 0 obj\n");
            ms.Write(objects[i]);
            W("\nendobj\n");
        }
        var xref = ms.Position;
        W($"xref\n0 {objects.Length + 1}\n0000000000 65535 f \n");
        foreach (var o in offsets) W($"{o:D10} 00000 n \n");
        W($"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return ms.ToArray();
    }

    private static byte[] Flate(byte[] data)
    {
        var compressed = new MemoryStream();
        using (var z = new ZLibStream(compressed, CompressionLevel.SmallestSize, true)) z.Write(data);
        var body = compressed.ToArray();
        return [.. Encoding.Latin1.GetBytes($"<< /Length {body.Length} /Filter /FlateDecode >>\nstream\n"), .. body, .. Encoding.Latin1.GetBytes("\nendstream")];
    }

    private static string ManyLetters(int operators)
    {
        var sb = new StringBuilder("BT /F1 9 Tf 40 780 Td ");
        for (var i = 0; i < operators; i++) sb.Append(i % 50 == 0 ? "0 -10 Td (01/09/2026 Shop 12.50) Tj " : "(AB) Tj ");
        return sb.Append("ET").ToString();
    }

    private const string Catalog = "<< /Type /Catalog /Pages 2 0 R >>";
    private const string Helvetica = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    private static string PageOf(int contents) =>
        $"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents {contents} 0 R >>";

    private void RefusedQuickly(byte[] pdf)
    {
        var watch = Stopwatch.StartNew();
        var act = () => _reader.ReadAsCsv(pdf, default);
        act.Should().Throw<StatementParseException>().WithMessage("This PDF is too large to read as a statement.");
        watch.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public void A_page_with_a_huge_amount_of_text_is_refused_before_it_is_drawn()
    {
        var content = Flate(Encoding.Latin1.GetBytes(ManyLetters(300_000)));
        RefusedQuickly(RawBytes(
            Encoding.Latin1.GetBytes(Catalog),
            Encoding.Latin1.GetBytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
            Encoding.Latin1.GetBytes(PageOf(5)),
            Encoding.Latin1.GetBytes(Helvetica),
            content));
    }

    [Fact]
    public void Pages_sharing_one_heavy_stream_are_counted_per_page()
    {
        // Each of 40 pages draws the same 100 KB stream: small on disk, 4 MB of drawing.
        var objects = new List<byte[]>
        {
            Encoding.Latin1.GetBytes(Catalog),
            Encoding.Latin1.GetBytes($"<< /Type /Pages /Kids [{string.Join(" ", Enumerable.Range(6, 40).Select(i => $"{i} 0 R"))}] /Count 40 >>"),
            Encoding.Latin1.GetBytes("<< >>"),
            Encoding.Latin1.GetBytes(Helvetica),
            Flate(Encoding.Latin1.GetBytes(ManyLetters(12_000))),
        };
        objects.AddRange(Enumerable.Range(0, 40).Select(_ => Encoding.Latin1.GetBytes(PageOf(5))));

        RefusedQuickly(RawBytes([.. objects]));
    }

    [Fact]
    public void A_stream_that_inflates_beyond_reason_is_refused()
    {
        RefusedQuickly(RawBytes(
            Encoding.Latin1.GetBytes(Catalog),
            Encoding.Latin1.GetBytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
            Encoding.Latin1.GetBytes(PageOf(5)),
            Encoding.Latin1.GetBytes(Helvetica),
            Flate(Enumerable.Repeat((byte)' ', 40_000_000).ToArray())));
    }

    [Fact]
    public void A_page_drawing_a_form_many_times_is_counted_for_each_time()
    {
        var form = Encoding.Latin1.GetBytes("BT /F1 9 Tf 40 700 Td " + string.Concat(Enumerable.Repeat("(ABCDEFGH) Tj ", 500)) + "ET");
        RefusedQuickly(RawBytes(
            Encoding.Latin1.GetBytes(Catalog),
            Encoding.Latin1.GetBytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
            Encoding.Latin1.GetBytes("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /X1 6 0 R >> >> /Contents 5 0 R >>"),
            Encoding.Latin1.GetBytes(Helvetica),
            Flate(Encoding.Latin1.GetBytes(string.Concat(Enumerable.Repeat("/X1 Do ", 2000)))),
            [.. Encoding.Latin1.GetBytes($"<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Length {form.Length} >>\nstream\n"), .. form, .. Encoding.Latin1.GetBytes("\nendstream")]));
    }

    [Fact]
    public void An_ordinary_statement_page_reads_well_within_the_limits()
    {
        var csv = _reader.ReadAsCsv(Raw(
            Catalog,
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            PageOf(5),
            Helvetica,
            "<< /Length 80 >>\nstream\nBT /F1 9 Tf 40 700 Td (01/09/2026) Tj 100 0 Td (Shop) Tj 200 0 Td (12.50) Tj ET\nendstream"), default);

        csv.Should().Be("01/09/2026,Shop,12.50\n");
    }

    [Fact]
    public void A_pdf_without_text_is_refused_as_a_scan()
    {
        var builder = new PdfDocumentBuilder();
        builder.AddPage(PageSize.A4);

        var act = () => _reader.ReadAsCsv(builder.Build(), default);

        act.Should().Throw<StatementParseException>().WithMessage("*no text in it, so it may be a scan*");
    }

    [Fact]
    public void A_pdf_without_dates_has_no_transactions()
    {
        var act = () => _reader.ReadAsCsv(Pdf([new Text(700, (40, "Thank"), (80, "you"))]), default);

        act.Should().Throw<StatementParseException>().WithMessage("No transactions were found in this PDF.");
    }

    [Fact]
    public void A_password_protected_pdf_is_refused_with_what_to_do()
    {
        var act = () => _reader.ReadAsCsv(Convert.FromBase64String(EncryptedBlankPdf), default);

        act.Should().Throw<StatementParseException>().WithMessage("This PDF is password-protected*");
    }

    [Fact]
    public void A_damaged_pdf_is_refused_without_the_readers_error()
    {
        var act = () => _reader.ReadAsCsv(Encoding.ASCII.GetBytes("%PDF-1.7\nnot really a pdf"), default);

        act.Should().Throw<StatementParseException>().WithMessage("This PDF could not be read.");
    }

    [Fact]
    public void A_pdf_too_long_for_a_statement_is_refused()
    {
        var pages = Enumerable.Range(0, 61).Select(_ => new[] { new Text(700, (40, "01/09/2026")) }).ToArray();

        var act = () => _reader.ReadAsCsv(Pdf(pages), default);

        act.Should().Throw<StatementParseException>().WithMessage("This PDF has 61 pages*");
    }

    [Theory]
    [InlineData("%PDF-1.7\n", true)]
    [InlineData("\r\n%PDF-1.4", true)]
    [InlineData("Date,Amount\n01/09/2026,1.00", false)]
    [InlineData("<?xml version=\"1.0\"?><Document/>", false)]
    public void IsPdf_looks_for_the_pdf_marker_near_the_start(string start, bool expected)
    {
        _reader.IsPdf(Encoding.ASCII.GetBytes(start)).Should().Be(expected);
    }

    // A blank page saved with a user password ("secret"), RC4 128-bit, made with pypdf.
    private const string EncryptedBlankPdf =
        "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDJhYzZmYzAyMzk+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8MGRiNTg1NWZjNTMyNjU2OWU3NjU5MDZjYWY2NGU0NDI5YTRjMjBkNmU5OTZmZGVmOTYzZTliNTA4MGY5ZTA4Mz4KL1UgPGI1YzFlM2U1NjVmZWUzNmM2YzNmYTNkMjkxNjdmNzVjMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IDwzNTM5NjMzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjYzNTYxNjY2MTY1NjYzMTMxPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK";
}
