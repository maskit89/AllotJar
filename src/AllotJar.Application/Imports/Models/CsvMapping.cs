namespace AllotJar.Application.Imports.Models;

/// <summary>How decimals are written in the amount column of a generic CSV.</summary>
public enum CsvDecimalStyle
{
    /// <summary>Infer per value — the right-most of '.'/',' is the decimal point, the other is grouping.</summary>
    Auto = 0,

    /// <summary>Dot decimal, comma grouping — "1,234.56".</summary>
    Dot = 1,

    /// <summary>Comma decimal, dot/space grouping — "1.234,56".</summary>
    Comma = 2,
}

/// <summary>
/// Column mapping + parse hints for a generic bank-CSV import. Columns are zero-based
/// indices into each split row. This version reads a single <em>signed</em> amount column
/// (negative = money out, positive = money in).
/// </summary>
public record CsvMapping(
    char Delimiter,
    bool HasHeader,
    int DateColumn,
    int AmountColumn,
    int DescriptionColumn,
    int? CurrencyColumn,
    string? DateFormat,
    CsvDecimalStyle DecimalStyle,
    string? DefaultCurrency);

/// <summary>
/// What the layout detector inferred from an uploaded CSV, returned to the client so the
/// user can confirm or correct the mapping before importing. <see cref="Suggested"/> is the
/// mapping actually used to produce the preview rows.
/// </summary>
public record CsvLayout(
    IReadOnlyList<string> Columns,
    IReadOnlyList<IReadOnlyList<string>> SampleRows,
    CsvMapping Suggested);
