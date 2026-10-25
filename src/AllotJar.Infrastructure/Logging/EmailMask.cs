using System.Text.RegularExpressions;

namespace AllotJar.Infrastructure.Logging;

/// <summary>
/// Masks email addresses in text bound for a log: <c>chris@example.com</c> becomes
/// <c>c***@example.com</c>. The first letter and the domain stay, which is enough to tell which
/// message or provider a line is about without the log holding anyone's address. A URL-encoded
/// address (<c>chris%40example.com</c>) is masked the same way. Masking an already masked address
/// leaves it as it is.
/// </summary>
public static partial class EmailMask
{
    [GeneratedRegex(
        @"(?<![A-Za-z0-9._%+-])([A-Za-z0-9])[A-Za-z0-9._%+-]*?(@|%40)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex Address();

    /// <summary>True when <paramref name="text"/> holds something that looks like an email address.</summary>
    public static bool HasAddress(string? text) =>
        !string.IsNullOrEmpty(text)
        && (text.Contains('@') || text.Contains("%40", StringComparison.Ordinal))
        && Address().IsMatch(text);

    /// <summary><paramref name="text"/> with every email address in it masked.</summary>
    public static string Mask(string text) =>
        HasAddress(text) ? Address().Replace(text, m => $"{m.Groups[1].Value}***{m.Groups[2].Value}{m.Groups[3].Value}") : text;
}
