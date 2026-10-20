using System.Globalization;
using System.Text;

namespace AllotJar.Application.Export;

/// <summary>
/// A small RFC 4180 writer for the export's tables: comma separated, CRLF lines, fields quoted when
/// they hold a comma, a quote or a line break. Numbers and dates are written the same way in every
/// locale (a dot for decimals, ISO dates). Text that a spreadsheet would run as a formula (it starts
/// with = + - @, a tab or a carriage return; a payee comes from a bank statement) gets a leading
/// apostrophe, so opening the file in Excel never runs anything.
/// </summary>
public sealed class Csv
{
    private readonly StringBuilder _text = new();

    public Csv(params string[] header) => Row(header);

    public Csv Row(params object?[] fields)
    {
        for (var i = 0; i < fields.Length; i++)
        {
            if (i > 0)
            {
                _text.Append(',');
            }
            _text.Append(Field(fields[i]));
        }
        _text.Append("\r\n");
        return this;
    }

    public override string ToString() => _text.ToString();

    public static string Field(object? value) => value switch
    {
        null => string.Empty,
        string s => Quote(Defuse(s)),
        bool b => b ? "true" : "false",
        decimal d => d.ToString(CultureInfo.InvariantCulture),
        int n => n.ToString(CultureInfo.InvariantCulture),
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTime time => DateTime.SpecifyKind(time, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
        Guid id => id.ToString("D"),
        Enum e => e.ToString(),
        IFormattable f => Quote(f.ToString(null, CultureInfo.InvariantCulture)),
        _ => Quote(Defuse(value.ToString() ?? string.Empty)),
    };

    private static string Defuse(string s) =>
        s.Length > 0 && s[0] is '=' or '+' or '-' or '@' or '\t' or '\r' ? "'" + s : s;

    private static string Quote(string s) =>
        s.IndexOfAny([',', '"', '\r', '\n']) >= 0 ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;
}
