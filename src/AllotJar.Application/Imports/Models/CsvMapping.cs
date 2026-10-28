using System.Text.Json.Serialization;

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
/// indices into each split row. Amounts come either from one <em>signed</em> column
/// (<see cref="AmountColumn"/>: negative = money out, positive = money in) or, when both
/// <see cref="DebitColumn"/> and <see cref="CreditColumn"/> are set, from a money-out and a
/// money-in column (each holding the amount without a sign), and <see cref="AmountColumn"/> is
/// then not read. <see cref="DirectionColumn"/>, with one amount column, holds a DR/CR (or
/// Debit/Credit) marker per row that sets the amount's direction. <see cref="SkipRows"/> is the number of lines above the header (or the first
/// row, without a header) that the bank prints first, such as an account name or a period.
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
    string? DefaultCurrency,
    int? DebitColumn = null,
    int? CreditColumn = null,
    int SkipRows = 0,
    int? DirectionColumn = null)
{
    /// <summary>Whether amounts come from separate money-out and money-in columns.</summary>
    [JsonIgnore]
    public bool SplitAmounts => DebitColumn is not null && CreditColumn is not null;
}

/// <summary>
/// What the layout detector inferred from an uploaded CSV, returned to the client so the
/// user can confirm or correct the mapping before importing. <see cref="Suggested"/> is the
/// mapping actually used to produce the preview rows.
/// </summary>
public record CsvLayout(
    IReadOnlyList<string> Columns,
    IReadOnlyList<IReadOnlyList<string>> SampleRows,
    CsvMapping Suggested);
