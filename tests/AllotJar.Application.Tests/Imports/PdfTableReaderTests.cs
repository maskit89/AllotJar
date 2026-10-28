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
