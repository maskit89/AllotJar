using System.Text.RegularExpressions;

namespace AllotJar.Infrastructure.Logging;

/// <summary>
/// Masks email addresses in text bound for a log: <c>chris@example.com</c> becomes
/// <c>c***@example.com</c>. The first character and the domain stay, which is enough to tell which
/// message or provider a line is about without the log holding anyone's address. Letters in any
/// script count (<c>josé@example.com</c>), and so does a local part starting with <c>_ - + .</c>.
/// A URL-encoded address (<c>chris%40example.com</c>) is masked the same way; when an encoded
/// character runs into it (<c>%3Cchris%40example.com</c>), the mask starts after it.
/// Masking an already masked address leaves it as it is.
/// </summary>
public static partial class EmailMask
{
    [GeneratedRegex(
        @"(?<![\p{L}\p{N}._%+-])(?<local>[\p{L}\p{N}._%+-]+?)(?<at>@|%40)(?<domain>[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex Address();

    [GeneratedRegex("^(?:%[0-9A-F]{2})+", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex LeadingEncoded();

    /// <summary>True when <paramref name="text"/> holds something that looks like an email address.</summary>
    public static bool HasAddress(string? text) =>
        !string.IsNullOrEmpty(text)
        && (text.Contains('@') || text.Contains("%40", StringComparison.Ordinal))
        && Address().IsMatch(text);

    /// <summary><paramref name="text"/> with every email address in it masked.</summary>
    public static string Mask(string text) =>
        HasAddress(text) ? Address().Replace(text, MaskOne) : text;

    private static string MaskOne(Match m)
    {
        var local = m.Groups["local"].Value;
        // Encoded characters running into the address (%3C for "<") are not part of it: keep them
        // and mask what follows, so the one character shown is the address's own. Only leading
        // ones: an encoded "+" inside the address (chris%2Btest) must not widen what is shown.
        var keep = LeadingEncoded().Match(local).Length;
        var shown = keep < local.Length ? local[..(keep + 1)] : local;
        return $"{shown}***{m.Groups["at"].Value}{m.Groups["domain"].Value}";
    }
}
