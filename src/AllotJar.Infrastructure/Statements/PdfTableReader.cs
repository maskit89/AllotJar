using System.Text;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.DocumentLayoutAnalysis.WordExtractor;
using UglyToad.PdfPig.Exceptions;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Rebuilds a text PDF statement's transaction table as CSV, so any bank's PDF goes through the
/// generic CSV import and its column screen. Works in memory on the uploaded bytes only.
///
/// The words on each page are grouped into lines by their baseline. The table's columns are the
/// horizontal bands its dated lines fill: on those lines, words close together form a cell, and
/// cells that overlap from line to line make one column. Every line is then written with each
/// word in the column under it. The header is often printed over two or three lines
/// ("Transaction" above "Date"); the lines just above the first dated line are merged into one.
/// A line under a dated line with only text in it (a second description line) joins the row
/// above.
/// </summary>
public sealed class PdfTableReader : IPdfTableReader
{
    /// <summary>A statement runs to a few pages; more is not one, and would cost memory and time.</summary>
    private const int MaxPages = 60;

    public bool IsPdf(ReadOnlySpan<byte> content)
    {
        // "%PDF-" within the first 1 KB, as readers allow junk before it.
        var head = content[..Math.Min(content.Length, 1024)];
        return head.IndexOf("%PDF-"u8) >= 0;
    }

    public string ReadAsCsv(byte[] pdf, CancellationToken cancellationToken)
    {
        var pages = new List<List<Line>>();
        try
        {
            using var document = PdfDocument.Open(pdf, new ParsingOptions { ClipPaths = false });
            if (document.NumberOfPages > MaxPages)
            {
                throw new StatementParseException($"This PDF has {document.NumberOfPages} pages, which is too long for a statement.");
            }
            foreach (var page in document.GetPages())
            {
                cancellationToken.ThrowIfCancellationRequested();
                pages.Add(Lines(page));
            }
        }
        catch (PdfDocumentEncryptedException ex)
        {
            throw new StatementParseException("This PDF is password-protected. Save it without a password and upload it again.", ex);
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not StatementParseException)
        {
            // A damaged or hostile file fails in many ways inside the reader; none is the user's to read.
            throw new StatementParseException("This PDF could not be read.", ex);
        }

        if (pages.All(p => p.Count == 0))
        {
            throw new StatementParseException(
                "This PDF has no text in it, so it may be a scan. Download the statement from your internet banking instead.");
        }

        // The table's rows have their first date at the same place; a "Statement date 30/09/2026"
        // line above the table has it elsewhere and must not shape the columns.
        var dated = pages.SelectMany(p => p).Where(l => l.HasDate).ToList();
        if (dated.Count == 0)
        {
            throw new StatementParseException("No transactions were found in this PDF.");
        }
        var dateAt = dated.GroupBy(l => Math.Round(FirstDate(l).BoundingBox.Left / 4))
            .OrderByDescending(g => g.Count()).First().Key;
        bool InTable(Line l) => l.HasDate && Math.Round(FirstDate(l).BoundingBox.Left / 4) == dateAt;
        var columns = Columns(dated.Where(InTable).ToList());

        var csv = new StringBuilder();
        foreach (var page in pages)
        {
            WritePage(csv, page, columns, InTable);
        }
        return csv.ToString();
    }

    // --- Lines ---------------------------------------------------------------------------------

    private sealed record Line(double Top, double Bottom, double Height, List<Word> Words)
    {
        /// <summary>Where the line's first date starts, or -1.</summary>
        public int DateIndex { get; } = Enumerable.Range(0, Words.Count).FirstOrDefault(i => DateStartsAt(Words, i), -1);

        public bool HasDate => DateIndex >= 0;
    }

    private static Word FirstDate(Line line) => line.Words[line.DateIndex];

    private static List<Line> Lines(Page page)
    {
        var words = page.GetWords(NearestNeighbourWordExtractor.Instance)
            .Where(w => !string.IsNullOrWhiteSpace(w.Text))
            .OrderByDescending(w => w.BoundingBox.Bottom)
            .ThenBy(w => w.BoundingBox.Left)
            .ToList();
        var lines = new List<Line>();
        var current = new List<Word>();
        double baseline = 0, height = 0;
        foreach (var word in words)
        {
            var h = Math.Max(word.BoundingBox.Height, 1);
            // A word on the same line sits within half a line height of its baseline.
            if (current.Count > 0 && Math.Abs(word.BoundingBox.Bottom - baseline) > Math.Max(height, h) * 0.5)
            {
                lines.Add(Close(current));
                current = [];
            }
            if (current.Count == 0)
            {
                (baseline, height) = (word.BoundingBox.Bottom, h);
            }
            current.Add(word);
        }
        if (current.Count > 0)
        {
            lines.Add(Close(current));
        }
        return lines;

        static Line Close(List<Word> words)
        {
            var sorted = words.OrderBy(w => w.BoundingBox.Left).ToList();
            return new Line(
                sorted.Max(w => w.BoundingBox.Top),
                sorted.Min(w => w.BoundingBox.Bottom),
                sorted.Max(w => w.BoundingBox.Height),
                sorted);
        }
    }

    // --- Columns -------------------------------------------------------------------------------

    private readonly record struct Band(double Left, double Right);

    /// <summary>
    /// The table's columns, left to right: on each dated line, words closer than a gap form a
    /// cell, and cells that overlap from line to line join one band.
    /// </summary>
    private static List<Band> Columns(List<Line> dated)
    {
        var cells = new List<Band>();
        foreach (var line in dated)
        {
            var gap = Math.Max(line.Height * 0.9, 3.0);
            Band? cell = null;
            foreach (var w in line.Words)
            {
                var (l, r) = (w.BoundingBox.Left, w.BoundingBox.Right);
                if (cell is Band c && l - c.Right <= gap)
                {
                    cell = new Band(c.Left, Math.Max(c.Right, r));
                }
                else
                {
                    if (cell is Band done) cells.Add(done);
                    cell = new Band(l, r);
                }
            }
            if (cell is Band last) cells.Add(last);
        }

        var bands = new List<Band>();
        foreach (var c in cells.OrderBy(c => c.Left))
        {
            if (bands.Count > 0 && c.Left <= bands[^1].Right)
            {
                bands[^1] = new Band(bands[^1].Left, Math.Max(bands[^1].Right, c.Right));
            }
            else
            {
                bands.Add(c);
            }
        }
        return bands;
    }

    /// <summary>The band a word belongs to: the one it overlaps most, else the nearest.</summary>
    private static int ColumnOf(Word w, List<Band> bands)
    {
        var (l, r) = (w.BoundingBox.Left, w.BoundingBox.Right);
        var best = 0;
        var bestScore = double.MinValue;
        for (var i = 0; i < bands.Count; i++)
        {
            var overlap = Math.Min(r, bands[i].Right) - Math.Max(l, bands[i].Left);
            if (overlap > bestScore)
            {
                (best, bestScore) = (i, overlap);
            }
        }
        return best;
    }

    // --- Writing -------------------------------------------------------------------------------

    private static void WritePage(StringBuilder csv, List<Line> lines, List<Band> bands, Func<Line, bool> inTable)
    {
        var rows = lines.Select(l => Cells(l, bands)).ToList();
        var firstDated = lines.FindIndex(l => inTable(l));

        // The header printed over several lines just above the first dated line, merged per column.
        // It may stand a little apart from the rows (often with a rule between), but its own lines
        // sit close together.
        var headerStart = firstDated;
        while (headerStart > 0
            && !lines[headerStart - 1].HasDate
            && lines[headerStart - 1].Words.Count >= 2
            && lines[headerStart - 1].Bottom - lines[headerStart].Top
                < lines[headerStart].Height * (headerStart == firstDated ? 3 : 1.5))
        {
            headerStart--;
        }

        string[]? pending = null;
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (i >= headerStart && i < firstDated)
            {
                // "Transaction" over "Date" reads "Transaction Date".
                if (i == headerStart)
                {
                    Flush();
                    pending = new string[bands.Count];
                    Array.Fill(pending, string.Empty);
                }
                for (var c = 0; c < bands.Count; c++)
                {
                    pending![c] = $"{pending[c]} {row[c]}".Trim();
                }
                continue;
            }

            // A text-only line right under a transaction is the rest of its description.
            if (firstDated >= 0 && i > firstDated && pending is not null && !lines[i].HasDate
                && row.All(c => !c.Any(char.IsDigit))
                && lines[i - 1].Bottom - lines[i].Top < lines[i].Height * 1.2)
            {
                for (var c = 0; c < bands.Count; c++)
                {
                    pending[c] = $"{pending[c]} {row[c]}".Trim();
                }
                continue;
            }

            Flush();
            pending = row;
        }
        Flush();

        void Flush()
        {
            if (pending is not null)
            {
                WriteRow(csv, pending);
                pending = null;
            }
        }
    }

    private static string[] Cells(Line line, List<Band> bands)
    {
        var cells = new List<string>[bands.Count];
        for (var i = 0; i < bands.Count; i++)
        {
            cells[i] = [];
        }
        foreach (var w in line.Words)
        {
            cells[ColumnOf(w, bands)].Add(Clean(w));
        }
        return cells.Select(c => string.Join(' ', c)).ToArray();
    }

    /// <summary>
    /// A word's text as printed. Some statement fonts (Calibri in APS's) map their "ti" and "tt"
    /// ligatures to no character, so the extractor gives U+FFFD where one stood ("Transac\uFFFDon",
    /// "A\uFFFDard"). The two are told apart by width: Calibri's "tt" is about 0.63 of the font size
    /// wide, its "ti" about 0.56 (0.59 in bold).
    /// </summary>
    private static string Clean(Word word)
    {
        if (!word.Text.Contains('\uFFFD'))
        {
            return word.Text.Trim();
        }
        return string.Concat(word.Letters.Select(l => l.Value != "\uFFFD" ? l.Value
            : l.PointSize > 0 && l.Width / l.PointSize >= 0.61 ? "tt"
            : "ti")).Trim();
    }

    private static void WriteRow(StringBuilder csv, string[] cells)
    {
        if (cells.All(c => c.Length == 0))
        {
            return;
        }
        csv.AppendJoin(',', cells.Select(Quote)).Append('\n');
    }

    private static string Quote(string cell) =>
        cell.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? $"\"{cell.Replace("\"", "\"\"")}\"" : cell;

    private static readonly string[] Months =
        ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

    /// <summary>
    /// Whether a date starts at word <paramref name="i"/>, as statements print one: one word
    /// (dd/MM/yy(yy), dd.MM.yyyy, yyyy-MM-dd, dd-MM-yyyy, dd-MMM-yyyy) or three ("1 Sep 2026").
    /// </summary>
    private static bool DateStartsAt(List<Word> words, int i)
    {
        if (LooksLikeDate(words[i].Text))
        {
            return true;
        }
        return i + 2 < words.Count
            && IsDay(words[i].Text) && IsMonth(words[i + 1].Text) && IsYear(words[i + 2].Text);
    }

    private static bool LooksLikeDate(string text)
    {
        var t = text.Trim();
        if (t.Length is < 8 or > 11)
        {
            return false;
        }
        var parts = t.Split('/', '.', '-');
        if (parts.Length != 3)
        {
            return false;
        }
        if (IsDay(parts[0]) && IsMonth(parts[1]) && IsYear(parts[2]))
        {
            return true;
        }
        return parts.All(p => p.Length > 0 && p.All(char.IsDigit))
            && (parts[0].Length == 4 || parts[2].Length is 2 or 4);
    }

    private static bool IsDay(string t) =>
        t.Length is 1 or 2 && t.All(char.IsDigit) && int.Parse(t) is >= 1 and <= 31;

    private static bool IsMonth(string t) =>
        Months.Any(m => (t.Length == 3 || t.Length == m.Length) && m.StartsWith(t, StringComparison.OrdinalIgnoreCase));

    private static bool IsYear(string t) => t.Length is 2 or 4 && t.All(char.IsDigit);
}
