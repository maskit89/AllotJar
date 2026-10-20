using System.Text;
using System.Text.RegularExpressions;

namespace AllotJar.Domain.Services;

/// <summary>
/// Keeps card numbers out of what AllotJar stores (compliance fix 12): PCI DSS stays out of scope
/// only while no payment card number is ever held. Any run of 13 to 19 digits that passes the
/// Luhn check, written together or in groups split by single spaces or hyphens, is masked to its
/// last four digits ("4111 1111 1111 1111" reads "•••• •••• •••• 1111"), as banks print them. The
/// text keeps its length and separators, so it fits wherever it fitted before. A valid IBAN is
/// left alone: its digits are a bank account, not a card, and a run inside one can pass the Luhn
/// check by chance. Masking masked text changes nothing.
/// </summary>
public static partial class CardNumberMask
{
    /// <summary>What a masked digit reads, the bullet banks print (HSBC's card column uses it too).</summary>
    public const char Bullet = '•';

    private const int MinDigits = 13;
    private const int MaxDigits = 19;
    private const int KeptDigits = 4;

    /// <summary>
    /// Digit groups joined by single spaces or hyphens, never part of a longer digit run. Only
    /// ASCII digits: a card number is printed in them.
    /// </summary>
    [GeneratedRegex(@"(?<![0-9])[0-9]+(?:[ \-][0-9]+)*(?![0-9])", RegexOptions.CultureInvariant)]
    private static partial Regex DigitRun();

    /// <summary>
    /// An IBAN as printed: country, check digits, then 11 to 30 letters and digits, written
    /// together or in groups of four. Its checksum decides (<see cref="IsIban"/>).
    /// </summary>
    [GeneratedRegex(@"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?:[A-Za-z0-9]{11,30}|(?: [A-Za-z0-9]{4}){2,7}(?: [A-Za-z0-9]{1,3})?)(?![A-Za-z0-9])", RegexOptions.CultureInvariant)]
    private static partial Regex IbanShape();

    /// <summary>True when <paramref name="text"/> holds something <see cref="Mask"/> would change.</summary>
    public static bool HasCardNumber(string? text) => !ReferenceEquals(Mask(text), text);

    /// <summary>
    /// <paramref name="text"/> with every card-like number masked to its last four digits; the
    /// same instance when there is none (and null for null).
    /// </summary>
    public static string? Mask(string? text)
    {
        if (string.IsNullOrEmpty(text) || !HasEnoughDigits(text))
        {
            return text;
        }

        var ibans = IbanSpans(text);
        StringBuilder? masked = null;
        foreach (Match run in DigitRun().Matches(text))
        {
            if (ibans.Any(s => run.Index < s.End && s.Start < run.Index + run.Length))
            {
                continue;
            }
            foreach (var (start, end) in CardSpans(text, run))
            {
                masked ??= new StringBuilder(text);
                var keep = KeptDigits;
                for (var i = end - 1; i >= start; i--)
                {
                    if (text[i] is >= '0' and <= '9')
                    {
                        if (keep > 0)
                        {
                            keep--;
                        }
                        else
                        {
                            masked[i] = Bullet;
                        }
                    }
                }
            }
        }
        return masked?.ToString() ?? text;
    }

    /// <summary>The Luhn check over <paramref name="digits"/>, all ASCII digits.</summary>
    public static bool PassesLuhn(ReadOnlySpan<char> digits)
    {
        var sum = 0;
        var doubled = false;
        for (var i = digits.Length - 1; i >= 0; i--)
        {
            var d = digits[i] - '0';
            if (doubled)
            {
                d *= 2;
                if (d > 9)
                {
                    d -= 9;
                }
            }
            sum += d;
            doubled = !doubled;
        }
        return sum % 10 == 0;
    }

    private static bool HasEnoughDigits(string text)
    {
        var count = 0;
        foreach (var c in text)
        {
            if (c is >= '0' and <= '9' && ++count >= MinDigits)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// The card numbers in one run, as text spans: the longest stretch of whole groups, leftmost
    /// first, with 13 to 19 digits that passes the Luhn check. A group is never split: a run of
    /// 20 or more digits written together is an account or reference number, not a card.
    /// </summary>
    private static List<(int Start, int End)> CardSpans(string text, Match run)
    {
        var groups = new List<(int Start, int End)>();
        var at = run.Index;
        var stop = run.Index + run.Length;
        while (at < stop)
        {
            var end = at;
            while (end < stop && text[end] is >= '0' and <= '9')
            {
                end++;
            }
            groups.Add((at, end));
            at = end + 1;
        }

        var found = new List<(int Start, int End)>();
        var first = 0;
        while (first < groups.Count)
        {
            var matched = false;
            var digits = new StringBuilder();
            var candidates = new List<(int Last, string Digits)>();
            for (var last = first; last < groups.Count; last++)
            {
                digits.Append(text, groups[last].Start, groups[last].End - groups[last].Start);
                if (digits.Length > MaxDigits)
                {
                    break;
                }
                if (digits.Length >= MinDigits)
                {
                    candidates.Add((last, digits.ToString()));
                }
            }
            for (var c = candidates.Count - 1; c >= 0; c--)
            {
                if (PassesLuhn(candidates[c].Digits))
                {
                    found.Add((groups[first].Start, groups[candidates[c].Last].End));
                    first = candidates[c].Last + 1;
                    matched = true;
                    break;
                }
            }
            if (!matched)
            {
                first++;
            }
        }
        return found;
    }

    /// <summary>The spans of the valid IBANs in <paramref name="text"/>.</summary>
    private static List<(int Start, int End)> IbanSpans(string text)
    {
        var spans = new List<(int Start, int End)>();
        foreach (Match m in IbanShape().Matches(text))
        {
            // A grouped IBAN may have swallowed a following short word ("... 3000 CARD"): try it
            // whole, then a group shorter at a time.
            var value = m.Value;
            while (true)
            {
                if (IsIban(value))
                {
                    spans.Add((m.Index, m.Index + value.Length));
                    break;
                }
                var space = value.LastIndexOf(' ');
                if (space < 0)
                {
                    break;
                }
                value = value[..space];
            }
        }
        return spans;
    }

    /// <summary>ISO 13616: 15 to 34 characters whose mod-97 checksum is 1.</summary>
    private static bool IsIban(string value)
    {
        var compact = value.Replace(" ", string.Empty).ToUpperInvariant();
        if (compact.Length is < 15 or > 34)
        {
            return false;
        }
        var rearranged = compact[4..] + compact[..4];
        var remainder = 0;
        foreach (var c in rearranged)
        {
            if (c is >= '0' and <= '9')
            {
                remainder = (remainder * 10 + (c - '0')) % 97;
            }
            else if (c is >= 'A' and <= 'Z')
            {
                remainder = (remainder * 100 + (c - 'A' + 10)) % 97;
            }
            else
            {
                return false;
            }
        }
        return remainder == 1;
    }
}
