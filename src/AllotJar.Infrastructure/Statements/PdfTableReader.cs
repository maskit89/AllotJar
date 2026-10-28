using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.DocumentLayoutAnalysis.WordExtractor;
using UglyToad.PdfPig.Exceptions;
using UglyToad.PdfPig.Filters;
using UglyToad.PdfPig.Tokens;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Rebuilds a text PDF statement's transaction table as CSV, so any bank's PDF goes through the
/// generic CSV import and its column screen. Works in memory on the uploaded bytes only.
///
/// The words on each page are grouped into lines by their baseline. The table's rows are the
/// lines whose first date sits where most dated lines have it. Its columns are the horizontal
/// bands those rows fill (an amount is always a cell of its own), plus a band for each header
/// word over no data, so a Credit column that is empty all month is kept. The header is often
/// printed over two or three lines ("Transaction" above "Date"); the lines just above the first
/// row are merged into one. Under a row, a line without an amount is the rest of its description,
/// a line of amounts only completes a row that had none, and a line with an amount but no date is
/// another transaction on the same day. Lines above the header and below the table are left out.
///
/// A PDF is a program for drawing a page, and a small file can ask for a great deal of work. Only
/// one is read at a time; each stream may inflate only so far; each page's text is measured
/// before it is drawn; and the whole read has a time limit.
/// </summary>
public sealed partial class PdfTableReader : IPdfTableReader
{
    /// <summary>A statement runs to a few pages; more is not one, and would cost memory and time.</summary>
    private const int MaxPages = 60;

    /// <summary>
    /// The drawing instructions one page may hold, with the forms it draws (an APS statement
    /// page holds about 18 KB). Each byte can draw a letter, and a letter costs about a kilobyte
    /// to read, so this bounds a page's memory to a few hundred megabytes at worst.
    /// </summary>
    private const long MaxPageWork = 256 * 1024;

    /// <summary>The drawing instructions of the whole document, counted per page drawn.</summary>
    private const long MaxDocumentWork = 4 * 1024 * 1024;

    /// <summary>Letters on one page, and in the whole document (a statement page has a few thousand).</summary>
    private const int MaxPageLetters = 25_000;
    private const int MaxDocumentLetters = 300_000;

    /// <summary>How far one stream may inflate, and all streams together (fonts and images included).</summary>
    private const long MaxStreamBytes = 32L * 1024 * 1024;
    private const long MaxDecodedBytes = 96L * 1024 * 1024;

    private static readonly TimeSpan TimeLimit = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan GateWait = TimeSpan.FromSeconds(3);

    /// <summary>One PDF at a time: the server has one CPU and 4 GB for production, staging and SQL Server.</summary>
    private static readonly SemaphoreSlim Gate = new(1, 1);

    private const string TooHeavy = "This PDF is too large to read as a statement.";

    public bool IsPdf(ReadOnlySpan<byte> content)
    {
        // "%PDF-" within the first 1 KB, as readers allow junk before it.
        var head = content[..Math.Min(content.Length, 1024)];
        return head.IndexOf("%PDF-"u8) >= 0;
    }

    public string ReadAsCsv(byte[] pdf, CancellationToken cancellationToken)
    {
        if (!Gate.Wait(GateWait, cancellationToken))
        {
            throw new StatementParseException("Another PDF is being read. Try again in a moment.");
        }
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeLimit);
            try
            {
                return Read(pdf, deadline.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new StatementParseException("This PDF took too long to read.");
            }
        }
        finally
        {
            Gate.Release();
        }
    }

    private static string Read(byte[] pdf, CancellationToken token)
    {
        var pages = new List<List<Line>>();
        var budget = new Budget(token);
        try
        {
            using var document = PdfDocument.Open(pdf, new ParsingOptions
            {
                ClipPaths = false,
                FilterProvider = new BudgetFilterProvider(budget),
            });
            if (document.NumberOfPages > MaxPages)
            {
                throw new StatementParseException($"This PDF has {document.NumberOfPages} pages, which is too long for a statement.");
            }

            var pageNodes = PageNodes(document);
            if (pageNodes.Count != document.NumberOfPages)
            {
                throw new StatementParseException("This PDF could not be read.");
            }

            var letters = 0;
            for (var i = 0; i < pageNodes.Count; i++)
            {
                token.ThrowIfCancellationRequested();
                // Measure what the page will draw before PdfPig draws it.
                budget.Work += new PageWork(document, budget).Of(pageNodes[i]);
                if (budget.Work > MaxDocumentWork)
                {
                    throw new TooHeavyException();
                }

                var page = document.GetPage(i + 1);
                letters += page.Letters.Count;
                if (page.Letters.Count > MaxPageLetters || letters > MaxDocumentLetters)
                {
                    throw new TooHeavyException();
                }
                pages.Add(Lines(page, token));
            }
        }
        catch (Exception ex) when (Find<TooHeavyException>(ex) is not null)
        {
            throw new StatementParseException(TooHeavy, ex);
        }
        catch (Exception ex) when (Find<OperationCanceledException>(ex) is OperationCanceledException canceled)
        {
            throw canceled;
        }
        catch (PdfDocumentEncryptedException ex)
        {
            throw new StatementParseException("This PDF is password-protected. Save it without a password and upload it again.", ex);
        }
        catch (Exception ex) when (ex is not StatementParseException and not OutOfMemoryException)
        {
            // A damaged or hostile file fails in many ways inside the reader; none is the user's to read.
            throw new StatementParseException("This PDF could not be read.", ex);
        }

        if (pages.All(p => p.Count == 0))
        {
            throw new StatementParseException(
                "This PDF has no text in it, so it may be a scan. Download the statement from your internet banking instead.");
        }

        var table = new Table(pages.SelectMany(p => p).Where(l => l.HasDate).ToList());
        if (!table.Found)
        {
            throw new StatementParseException("No transactions were found in this PDF.");
        }

        table.FindColumns(pages, token);
        var csv = new StringBuilder();
        foreach (var page in pages)
        {
            token.ThrowIfCancellationRequested();
            table.WritePage(csv, page);
        }
        return csv.ToString();
    }

    private static T? Find<T>(Exception? ex) where T : Exception
    {
        for (var depth = 0; ex is not null && depth < 10; depth++, ex = ex.InnerException)
        {
            if (ex is T found) return found;
            if (ex is AggregateException agg && agg.InnerExceptions.Select(Find<T>).FirstOrDefault(f => f is not null) is T inner) return inner;
        }
        return null;
    }

    // --- Limits ----------------------------------------------------------------------------------

    private sealed class TooHeavyException : Exception;

    private sealed class Budget(CancellationToken token)
    {
        public CancellationToken Token { get; } = token;
        public long Decoded { get; private set; }
        public long Work { get; set; }

        public void Add(long bytes)
        {
            Token.ThrowIfCancellationRequested();
            Decoded += bytes;
            if (bytes > MaxStreamBytes || Decoded > MaxDecodedBytes)
            {
                throw new TooHeavyException();
            }
        }
    }

    /// <summary>PdfPig's filters, each measured before it may allocate what it decodes.</summary>
    private sealed class BudgetFilterProvider(Budget budget) : IFilterProvider
    {
        private readonly IFilterProvider _inner = DefaultFilterProvider.Instance;

        public IReadOnlyList<IFilter> GetFilters(DictionaryToken dictionary) => Wrap(_inner.GetFilters(dictionary));

        public IReadOnlyList<IFilter> GetNamedFilters(IReadOnlyList<NameToken> names) => Wrap(_inner.GetNamedFilters(names));

        public IReadOnlyList<IFilter> GetAllFilters() => Wrap(_inner.GetAllFilters());

        private IReadOnlyList<IFilter> Wrap(IReadOnlyList<IFilter> filters) =>
            filters.Select(f => (IFilter)new BudgetFilter(f, budget)).ToList();
    }

    private sealed class BudgetFilter(IFilter inner, Budget budget) : IFilter
    {
        public bool IsSupported => inner.IsSupported;

        public Memory<byte> Decode(Memory<byte> input, DictionaryToken streamDictionary, IFilterProvider filterProvider, int filterIndex)
        {
            budget.Token.ThrowIfCancellationRequested();
            switch (inner)
            {
                case FlateFilter:
                    // Inflate into nothing first, to learn the size without holding it.
                    budget.Add(InflatedLength(input));
                    return inner.Decode(input, streamDictionary, filterProvider, filterIndex);
                case LzwFilter when input.Length > 256 * 1024:
                case RunLengthFilter when input.Length > 256 * 1024:
                    throw new TooHeavyException();
                default:
                    var output = inner.Decode(input, streamDictionary, filterProvider, filterIndex);
                    budget.Add(output.Length);
                    return output;
            }
        }

        private long InflatedLength(Memory<byte> input)
        {
            // PdfPig skips the two-byte zlib header and inflates the rest; so does this.
            var data = input.Length > 2 ? input[2..] : input;
            using var source = new MemoryStream(data.ToArray(), writable: false);
            using var inflate = new DeflateStream(source, CompressionMode.Decompress);
            var buffer = new byte[64 * 1024];
            long total = 0;
            try
            {
                int read;
                while ((read = inflate.Read(buffer, 0, buffer.Length)) > 0)
                {
                    total += read;
                    if (total > MaxStreamBytes)
                    {
                        throw new TooHeavyException();
                    }
                    if ((total & 0xFFFFF) < read)
                    {
                        budget.Token.ThrowIfCancellationRequested();
                    }
                }
            }
            catch (InvalidDataException)
            {
                // A damaged stream: what inflated so far is what PdfPig will get.
            }
            return total;
        }
    }

    /// <summary>The page dictionaries in page order, each with the resources it inherits.</summary>
    private static List<(DictionaryToken Page, DictionaryToken? Resources)> PageNodes(PdfDocument document)
    {
        var result = new List<(DictionaryToken, DictionaryToken?)>();
        if (Get(document, document.Structure.Catalog.CatalogDictionary, "Pages") is not DictionaryToken root)
        {
            return result;
        }
        var seen = new HashSet<DictionaryToken>(ReferenceEqualityComparer.Instance);
        Walk(root, null, 0);
        return result;

        void Walk(DictionaryToken node, DictionaryToken? inherited, int depth)
        {
            if (depth > 32 || !seen.Add(node) || seen.Count > 4 * MaxPages + 64)
            {
                throw new TooHeavyException();
            }
            var resources = Get(document, node, "Resources") as DictionaryToken ?? inherited;
            if (Get(document, node, "Kids") is ArrayToken kids)
            {
                foreach (var kid in kids.Data)
                {
                    if (Resolve(document, kid) is DictionaryToken child)
                    {
                        Walk(child, resources, depth + 1);
                    }
                }
            }
            else
            {
                result.Add((node, resources));
            }
        }
    }

    /// <summary>
    /// The drawing instructions a page holds: its content streams, plus each form it draws as
    /// many times as it draws it. Refuses a page over <see cref="MaxPageWork"/>.
    /// </summary>
    private sealed partial class PageWork(PdfDocument document, Budget budget)
    {
        private long _work;
        private readonly Dictionary<StreamToken, long> _forms = new(ReferenceEqualityComparer.Instance);

        public long Of((DictionaryToken Page, DictionaryToken? Resources) node)
        {
            var contents = Get(document, node.Page, "Contents");
            var streams = contents switch
            {
                StreamToken s => [s],
                ArrayToken a => a.Data.Select(t => Resolve(document, t)).OfType<StreamToken>().ToList(),
                _ => new List<StreamToken>(),
            };
            // A page's content may be split over several streams, and an operator over two of them.
            var text = new StringBuilder();
            foreach (var s in streams)
            {
                var bytes = Decode(s);
                Add(bytes.Length);
                text.Append(Encoding.Latin1.GetString(bytes)).Append('\n');
            }
            Draws(text.ToString(), node.Resources, 0);
            return _work;
        }

        private void Draws(string content, DictionaryToken? resources, int depth)
        {
            foreach (var group in DoOperator().Matches(content).GroupBy(m => m.Groups[1].Value))
            {
                if (Form(resources, group.Key) is not StreamToken form)
                {
                    continue; // an image, or nothing: PdfPig does not decode images for text
                }
                if (!_forms.TryGetValue(form, out var size))
                {
                    if (depth >= 4)
                    {
                        throw new TooHeavyException();
                    }
                    var before = _work;
                    var bytes = Decode(form);
                    Add(bytes.Length);
                    Draws(Encoding.Latin1.GetString(bytes), Get(document, form.StreamDictionary, "Resources") as DictionaryToken ?? resources, depth + 1);
                    size = _work - before;
                    _forms[form] = size;
                    Add(size * (group.Count() - 1));
                }
                else
                {
                    Add(size * group.Count());
                }
            }
        }

        private StreamToken? Form(DictionaryToken? resources, string name) =>
            resources is not null
            && Get(document, resources, "XObject") is DictionaryToken xobjects
            && Get(document, xobjects, name) is StreamToken stream
            && Get(document, stream.StreamDictionary, "Subtype") is NameToken { Data: "Form" }
                ? stream
                : null;

        private byte[] Decode(StreamToken stream)
        {
            var provider = new BudgetFilterProvider(budget);
            Memory<byte> data = stream.Data;
            var filters = provider.GetFilters(stream.StreamDictionary);
            for (var i = 0; i < filters.Count; i++)
            {
                data = filters[i].Decode(data, stream.StreamDictionary, provider, i);
            }
            return data.ToArray();
        }

        private void Add(long bytes)
        {
            _work += bytes;
            if (_work > MaxPageWork)
            {
                throw new TooHeavyException();
            }
        }

        // "/Logo Do": draw the named XObject.
        [GeneratedRegex(@"/([^\s/\[\]()<>{}%]+)\s*Do(?![A-Za-z])", RegexOptions.CultureInvariant)]
        private static partial Regex DoOperator();
    }

    private static IToken? Get(PdfDocument document, DictionaryToken dictionary, string key) =>
        dictionary.TryGet(NameToken.Create(key), out var token) ? Resolve(document, token) : null;

    private static IToken? Resolve(PdfDocument document, IToken? token)
    {
        for (var hops = 0; token is IndirectReferenceToken reference && hops < 8; hops++)
        {
            token = document.Structure.GetObject(reference.Data)?.Data;
        }
        return token is IndirectReferenceToken ? null : token;
    }

    // --- Lines -----------------------------------------------------------------------------------

    /// <summary>A word as printed, kept without PdfPig's letters so the page can be let go.</summary>
    private sealed record Word(string Text, double Left, double Right, double Bottom, double Top)
    {
        public double Height => Math.Max(Top - Bottom, 1);
    }

    private sealed class Line
    {
        public Line(List<Word> words)
        {
            Words = words;
            Top = words.Max(w => w.Top);
            Bottom = words.Min(w => w.Bottom);
            Height = words.Max(w => w.Height);
            for (var i = 0; i < words.Count && DateLength == 0; i++)
            {
                DateLength = DateAt(words, i);
                DateIndex = i;
            }
            if (DateLength == 0)
            {
                DateIndex = -1;
            }
        }

        public List<Word> Words { get; }
        public double Top { get; }
        public double Bottom { get; }
        public double Height { get; }
        public int DateIndex { get; }
        public int DateLength { get; }
        public bool HasDate => DateIndex >= 0;
        public double DateLeft => Words[DateIndex].Left;
        public double DateRight => Words[DateIndex + DateLength - 1].Right;
    }

    private static List<Line> Lines(Page page, CancellationToken token)
    {
        var words = page.GetWords(NearestNeighbourWordExtractor.Instance)
            .Where(w => !string.IsNullOrWhiteSpace(w.Text))
            .Select(w => new Word(Clean(w), w.BoundingBox.Left, w.BoundingBox.Right, w.BoundingBox.Bottom, w.BoundingBox.Top))
            .OrderByDescending(w => w.Bottom)
            .ThenBy(w => w.Left)
            .ToList();
        token.ThrowIfCancellationRequested();

        var lines = new List<Line>();
        var current = new List<Word>();
        double baseline = 0, height = 0;
        foreach (var word in words)
        {
            // A word on the same line sits within half a line height of its baseline.
            if (current.Count > 0 && Math.Abs(word.Bottom - baseline) > Math.Max(height, word.Height) * 0.5)
            {
                lines.Add(new Line([.. current.OrderBy(w => w.Left)]));
                current = [];
            }
            if (current.Count == 0)
            {
                (baseline, height) = (word.Bottom, word.Height);
            }
            current.Add(word);
        }
        if (current.Count > 0)
        {
            lines.Add(new Line([.. current.OrderBy(w => w.Left)]));
        }
        return lines;
    }

    // --- The table -------------------------------------------------------------------------------

    private readonly record struct Band(double Left, double Right);

    private sealed class Table
    {
        private readonly double _dateLeft;
        private readonly double _dateRight;
        private readonly double _tolerance;
        private double _rowGap;
        private List<Band> _bands = [];

        public Table(List<Line> dated)
        {
            Found = dated.Count > 0;
            if (!Found)
            {
                return;
            }
            // The table's rows have their first date at the same place; a "Statement date
            // 30/09/2026" line above the table has it elsewhere. Dates of different widths
            // ("1 Sep" and "12 Sep") line up on one edge or the other.
            _dateLeft = Mode(dated.Select(l => l.DateLeft));
            _dateRight = Mode(dated.Select(l => l.DateRight));
            _tolerance = Median(dated.Select(l => l.Height));
            _rowGap = _tolerance;
        }

        public bool Found { get; }

        public bool InTable(Line l) =>
            l.HasDate && (Math.Abs(l.DateLeft - _dateLeft) <= _tolerance || Math.Abs(l.DateRight - _dateRight) <= _tolerance);

        /// <summary>
        /// The table's columns, left to right: on each row, words close together form a cell
        /// (an amount is always a cell of its own), and cells that overlap from row to row join
        /// one band. A header word over no band starts its own, so an empty column survives.
        /// </summary>
        public void FindColumns(List<List<Line>> pages, CancellationToken token)
        {
            // The usual space between one line of the table and the next, for telling a same-day
            // row from a total further down.
            var gaps = new List<double>();
            foreach (var page in pages)
            {
                var first = page.FindIndex(InTable);
                var last = page.FindLastIndex(InTable);
                for (var i = first + 1; first >= 0 && i <= last; i++)
                {
                    gaps.Add(page[i - 1].Bottom - page[i].Top);
                }
            }
            var positive = gaps.Where(g => g > 0).ToList();
            if (positive.Count > 0)
            {
                _rowGap = Median(positive);
            }

            var cells = new List<Band>();
            foreach (var line in pages.SelectMany(p => p).Where(InTable))
            {
                cells.AddRange(Cells(line, splitAmounts: true));
            }
            token.ThrowIfCancellationRequested();

            var bands = new List<Band>();
            var members = new List<List<Band>>();
            foreach (var c in cells.OrderBy(c => c.Left))
            {
                if (bands.Count > 0 && c.Left < bands[^1].Right)
                {
                    bands[^1] = new Band(bands[^1].Left, Math.Max(bands[^1].Right, c.Right));
                    members[^1].Add(c);
                }
                else
                {
                    bands.Add(c);
                    members.Add([c]);
                }
            }
            // One long description reaching across into the next column must not join the two
            // for the whole statement: split a band where only one row covers it, between parts
            // that several rows fill.
            bands = [.. bands.SelectMany((b, i) => Split(members[i]))];

            // Header words: on each header line, the cell nearest a band keeps it; another cell
            // there that overlaps no band, or any cell far from every band, is a column of its own.
            var extra = new List<Band>();
            foreach (var page in pages)
            {
                var (start, end) = HeaderLines(page);
                for (var i = start; i < end; i++)
                {
                    var claims = Cells(page[i], splitAmounts: false)
                        .Select(c => (Cell: c, Band: Nearest(c, bands, out var distance), Distance: distance))
                        .GroupBy(x => x.Band);
                    foreach (var claim in claims)
                    {
                        var ordered = claim.OrderBy(x => x.Distance).ToList();
                        for (var k = 0; k < ordered.Count; k++)
                        {
                            var (cell, _, distance) = ordered[k];
                            if ((k > 0 && distance > 0) || distance > 3 * page[i].Height)
                            {
                                extra.Add(cell);
                            }
                        }
                    }
                }
            }
            foreach (var e in extra.OrderBy(e => e.Left))
            {
                if (!bands.Any(b => Overlap(b, e) > 0))
                {
                    bands.Add(e);
                }
            }
            _bands = [.. bands.OrderBy(b => b.Left)];
        }

        private static IEnumerable<Band> Split(List<Band> cells)
        {
            // Coverage: how many cells cover each stretch between consecutive edges.
            var edges = cells.SelectMany(c => new[] { c.Left, c.Right }).Distinct().Order().ToList();
            var stretches = edges.Zip(edges.Skip(1), (l, r) => (L: l, R: r, N: cells.Count(c => c.Left < r && c.Right > l))).ToList();
            var start = 0;
            for (var i = 0; i < stretches.Count; i++)
            {
                if (stretches[i].N > 1)
                {
                    continue;
                }
                var thin = i;
                while (thin + 1 < stretches.Count && stretches[thin + 1].N <= 1)
                {
                    thin++;
                }
                var denseBefore = stretches.Skip(start).Take(i - start).Any(x => x.N >= 2);
                var denseAfter = stretches.Skip(thin + 1).Any(x => x.N >= 2);
                if (denseBefore && denseAfter)
                {
                    var cut = (stretches[i].L + stretches[thin].R) / 2;
                    yield return new Band(stretches[start].L, cut);
                    start = thin + 1;
                    // The next part starts where it is dense again.
                    while (start < stretches.Count && stretches[start].N <= 1)
                    {
                        start++;
                    }
                    if (start < stretches.Count)
                    {
                        stretches[start] = stretches[start] with { L = Math.Max(stretches[start].L, cut) };
                    }
                }
                i = thin;
            }
            if (start < stretches.Count)
            {
                yield return new Band(stretches[start].L, stretches[^1].R);
            }
            else if (stretches.Count == 0)
            {
                yield return new Band(cells.Min(c => c.Left), cells.Max(c => c.Right));
            }
        }

        /// <summary>Header lines above the page's first row: [start, end).</summary>
        public (int Start, int End) HeaderLines(List<Line> page)
        {
            var first = page.FindIndex(InTable);
            if (first < 0)
            {
                return (0, 0);
            }
            // The header may stand a little apart from the rows (often with a rule between), but
            // its own lines sit close together. A line with a number in it is not header: it is an
            // account or period block above it.
            var start = first;
            while (start > 0
                && !page[start - 1].HasDate
                && page[start - 1].Words.Count >= 2
                && !page[start - 1].Words.Any(w => w.Text.Any(char.IsDigit))
                && page[start - 1].Bottom - page[start].Top < page[start].Height * (start == first ? 3 : 1.5))
            {
                start--;
            }
            return (start, first);
        }

        public void WritePage(StringBuilder csv, List<Line> page)
        {
            var (headerStart, first) = HeaderLines(page);
            if (first < 0)
            {
                return;
            }

            string[]? pending = null;
            var pendingHasAmount = false;
            string[]? lastRow = null;
            Line? previous = null;
            var sums = new Sums();

            if (headerStart < first)
            {
                // "Transaction" over "Date" reads "Transaction Date".
                pending = Empty();
                for (var i = headerStart; i < first; i++)
                {
                    Append(pending, Cells(page[i]));
                }
                Flush();
            }

            for (var i = first; i < page.Count; i++)
            {
                var line = page[i];
                var row = Cells(line);
                var amounts = AmountColumns(row);
                var near = previous is not null && previous.Bottom - line.Top < line.Height * 1.2;
                var sameSize = previous is not null
                    && Math.Abs(line.Height - previous.Height) <= 0.25 * Math.Max(line.Height, previous.Height);

                if (InTable(line))
                {
                    Flush();
                    pending = row;
                    pendingHasAmount = amounts.Count > 0;
                    lastRow = row;
                    sums.Add(row, amounts);
                }
                else if (pending is not null && near && !line.HasDate && amounts.Count > 0 && !pendingHasAmount
                    && row.Select((c, k) => c.Length == 0 || pending[k].Length == 0).All(x => x)
                    && amounts.Count == row.Count(c => c.Length > 0))
                {
                    // A row's amounts printed a little lower than its date (centred on two lines).
                    Append(pending, row);
                    pendingHasAmount = true;
                }
                else if (pending is not null && near && sameSize && amounts.Count == 0)
                {
                    // The rest of the description, under the row.
                    Append(pending, row);
                }
                else if (lastRow is not null && !line.HasDate && amounts.Count > 0
                    && row.Where((c, k) => c.Length > 0 && !amounts.Contains(k)).Any()
                    && previous is not null && previous.Bottom - line.Top <= _rowGap * 1.5 + 1
                    && !GenericCsvImporter.IsSummaryLine(string.Join(' ', row.Where((c, k) => !amounts.Contains(k))))
                    && !sums.IsSubtotal(row, amounts))
                {
                    // Another transaction on the same day: the bank printed the date once.
                    Flush();
                    for (var k = 0; k < row.Length; k++)
                    {
                        if (row[k].Length == 0 && GenericCsvImporter.TryParseDate(lastRow[k], null, out _))
                        {
                            row[k] = lastRow[k];
                        }
                    }
                    pending = row;
                    pendingHasAmount = true;
                    sums.Add(row, amounts);
                }
                else
                {
                    // Below the table, or between its parts: a sub-heading, a page footer, a summary.
                    Flush();
                    if (amounts.Count > 0 && !line.HasDate)
                    {
                        lastRow = null; // a subtotal or summary line ends the day's rows
                        sums = new Sums();
                    }
                }
                previous = line;
            }
            Flush();

            void Flush()
            {
                if (pending is not null)
                {
                    WriteRow(csv, pending);
                    pending = null;
                    pendingHasAmount = false;
                }
            }
        }

        /// <summary>
        /// Each column's running total of the rows since the table started or the last total
        /// line: a line whose amounts are those totals is a subtotal, whatever it is called.
        /// </summary>
        private sealed class Sums
        {
            private readonly Dictionary<int, decimal> _totals = [];
            private int _rows;

            public void Add(string[] row, List<int> amounts)
            {
                _rows++;
                foreach (var k in amounts)
                {
                    if (TryAmount(row[k], out var a))
                    {
                        _totals[k] = _totals.GetValueOrDefault(k) + a;
                    }
                }
            }

            public bool IsSubtotal(string[] row, List<int> amounts) =>
                _rows >= 2 && amounts.Count > 0
                && amounts.All(k => TryAmount(row[k], out var a) && _totals.TryGetValue(k, out var t) && t == a);

            private static bool TryAmount(string cell, out decimal amount) =>
                decimal.TryParse(cell.Replace(",", "").Replace("\u2212", "-").Trim(), System.Globalization.NumberStyles.Number,
                    System.Globalization.CultureInfo.InvariantCulture, out amount) && (amount = Math.Abs(amount)) >= 0;
        }

        private string[] Empty()
        {
            var row = new string[_bands.Count];
            Array.Fill(row, string.Empty);
            return row;
        }

        private static void Append(string[] into, string[] row)
        {
            for (var c = 0; c < into.Length; c++)
            {
                into[c] = $"{into[c]} {row[c]}".Trim();
            }
        }

        private static List<int> AmountColumns(string[] row) =>
            row.Select((c, k) => (c, k)).Where(x => x.c.Length > 0 && GenericCsvImporter.IsNumberCell(x.c)).Select(x => x.k).ToList();

        private string[] Cells(Line line)
        {
            var cells = new List<string>[_bands.Count];
            for (var i = 0; i < cells.Length; i++)
            {
                cells[i] = [];
            }
            foreach (var w in line.Words)
            {
                cells[ColumnOf(w)].Add(w.Text);
            }
            return [.. cells.Select(c => string.Join(' ', c))];
        }

        /// <summary>The band a word belongs to: the one it overlaps most, else the nearest.</summary>
        private int ColumnOf(Word w)
        {
            var best = 0;
            var bestScore = double.MinValue;
            for (var i = 0; i < _bands.Count; i++)
            {
                var overlap = Overlap(_bands[i], new Band(w.Left, w.Right));
                if (overlap > bestScore)
                {
                    (best, bestScore) = (i, overlap);
                }
            }
            return best;
        }

        /// <summary>
        /// A line's cells: words closer than a gap. With <paramref name="splitAmounts"/>, an amount
        /// (with a currency or DR/CR beside it) and a date are cells of their own, so a long
        /// description running up to the amount does not join the two columns.
        /// </summary>
        private static List<Band> Cells(Line line, bool splitAmounts)
        {
            var gap = Math.Max(line.Height * 0.9, 3.0);
            var cells = new List<Band>();
            Band? cell = null;
            var cellKind = Kind.Text;
            for (var i = 0; i < line.Words.Count; i++)
            {
                var w = line.Words[i];
                var kind = !splitAmounts ? Kind.Text
                    : line.HasDate && i >= line.DateIndex && i < line.DateIndex + line.DateLength ? Kind.Date
                    : GenericCsvImporter.IsNumberCell(w.Text) ? Kind.Amount
                    : IsMarker(w.Text) ? Kind.Marker
                    : Kind.Text;
                var joins = cell is Band c && w.Left - c.Right <= gap
                    && (kind == cellKind && kind is Kind.Text or Kind.Date
                        || kind == Kind.Marker && cellKind == Kind.Amount
                        || kind == Kind.Amount && cellKind == Kind.Marker);
                if (joins)
                {
                    cell = new Band(cell!.Value.Left, Math.Max(cell.Value.Right, w.Right));
                    cellKind = kind == Kind.Marker ? cellKind : kind;
                }
                else
                {
                    if (cell is Band done) cells.Add(done);
                    (cell, cellKind) = (new Band(w.Left, w.Right), kind);
                }
            }
            if (cell is Band last) cells.Add(last);
            return cells;
        }

        private enum Kind { Text, Date, Amount, Marker }

        private static bool IsMarker(string text) =>
            text.Trim().ToUpperInvariant() is "DR" or "CR" or "D" or "C" or "EUR" or "USD" or "GBP" or "€" or "$" or "£";

        private static int Nearest(Band cell, List<Band> bands, out double distance)
        {
            var best = -1;
            distance = double.MaxValue;
            for (var i = 0; i < bands.Count; i++)
            {
                var overlap = Overlap(bands[i], cell);
                var d = overlap > 0 ? 0 : -overlap;
                if (d < distance)
                {
                    (best, distance) = (i, d);
                }
            }
            return best;
        }

        private static double Overlap(Band a, Band b) => Math.Min(a.Right, b.Right) - Math.Max(a.Left, b.Left);

        private static double Mode(IEnumerable<double> values) =>
            values.GroupBy(v => Math.Round(v / 4)).OrderByDescending(g => g.Count()).ThenBy(g => g.Key).First().Average();

        private static double Median(IEnumerable<double> values)
        {
            var sorted = values.Order().ToList();
            return sorted.Count == 0 ? 0 : sorted[sorted.Count / 2];
        }
    }

    /// <summary>
    /// A word's text as printed. Some statement fonts (Calibri in APS's) map their "ti" and "tt"
    /// ligatures to no character, so the extractor gives U+FFFD where one stood ("Transac�on",
    /// "A�ard"). The two are told apart by width: Calibri's "tt" is about 0.63 of the font size
    /// wide, its "ti" about 0.56 (0.59 in bold).
    /// </summary>
    private static string Clean(UglyToad.PdfPig.Content.Word word)
    {
        if (!word.Text.Contains('�'))
        {
            return word.Text.Trim();
        }
        return string.Concat(word.Letters.Select(l => l.Value != "�" ? l.Value
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

    // --- Dates -----------------------------------------------------------------------------------

    private static readonly string[] Months =
        ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

    /// <summary>
    /// How many words make the date that starts at word <paramref name="i"/>, or 0: one word as
    /// the CSV import reads it ("01/09/26", "1/9/26", "2026-09-01", "01-Sep-2026"), or three
    /// ("1 Sep 2026", "Sep 1, 2026").
    /// </summary>
    private static int DateAt(List<Word> words, int i)
    {
        if (LooksLikeDate(words[i].Text))
        {
            return 1;
        }
        if (i + 2 < words.Count && IsYear(words[i + 2].Text)
            && (IsDay(words[i].Text) && IsMonth(words[i + 1].Text)
                || IsMonth(words[i].Text) && IsDay(words[i + 1].Text.TrimEnd(','))))
        {
            return 3;
        }
        return 0;
    }

    private static bool LooksLikeDate(string text)
    {
        var t = text.Trim();
        return t.Length is >= 6 and <= 11 && t.Any(char.IsDigit) && GenericCsvImporter.TryParseDate(t, null, out _);
    }

    private static bool IsDay(string t) =>
        t.Length is 1 or 2 && t.All(char.IsDigit) && int.Parse(t) is >= 1 and <= 31;

    private static bool IsMonth(string t) =>
        Months.Any(m => (t.Length == 3 || t.Length == m.Length) && m.StartsWith(t, StringComparison.OrdinalIgnoreCase));

    private static bool IsYear(string t) => t.Length is 2 or 4 && t.All(char.IsDigit);
}
