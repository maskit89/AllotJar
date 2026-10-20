using System.Text;
using System.Text.RegularExpressions;

namespace AllotJar.Domain.Services;

/// <summary>
/// Keeps card numbers out of what AllotJar stores (compliance fix 12): PCI DSS stays out of scope
/// only while no payment card number is ever held. A card number is a run of 13 to 19 digits that
/// starts with a card scheme's issuer prefix, has a length that scheme issues, and passes the Luhn
/// check (<see cref="IsCardNumber"/>). It is masked to its last four digits ("4111 1111 1111 1111"
/// reads "•••• •••• •••• 1111"), as banks print them. The digits may be written together, or in
/// groups split by up to two spaces (any kind), hyphens or dots; a stretch of a longer run counts
/// only when it is grouped the way cards are printed (fours, or Amex's 4-6-5), so a date or an
/// amount next to a reference is never read into one. The text keeps its length and separators.
/// A valid IBAN is left alone: its digits are a bank account, and a run inside one can pass the
/// checks by chance. Masking masked text changes nothing.
/// </summary>
public static partial class CardNumberMask
{
    /// <summary>What a masked digit reads, the bullet banks print (HSBC's card column uses it too).</summary>
    public const char Bullet = '•';

    private const int MinDigits = 13;
    private const int MaxDigits = 19;
    private const int KeptDigits = 4;

    /// <summary>
    /// Digit groups joined by one or two spaces (a no-break space too), hyphens or dots, never part
    /// of a longer digit run. Only ASCII digits: a card number is printed in them.
    /// </summary>
    [GeneratedRegex(@"(?<![0-9])[0-9]+(?:[\s\-.]{1,2}[0-9]+)*(?![0-9])", RegexOptions.CultureInvariant)]
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
    /// <paramref name="text"/> with every card number masked to its last four digits; the same
    /// instance when there is none (and null for null).
    /// </summary>
    public static string? Mask(string? text)
    {
        if (string.IsNullOrEmpty(text) || !HasEnoughDigits(text))
        {
            return text;
        }

        // A valid IBAN's characters are taken out of the search, and only those: a card printed
        // next to one is still found.
        var search = WithoutIbans(text);
        StringBuilder? masked = null;
        foreach (Match run in DigitRun().Matches(search))
        {
            foreach (var (start, end) in CardSpans(search, run))
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

    /// <summary>
    /// Whether <paramref name="digits"/> (ASCII digits only) is a card number: a scheme's issuer
    /// prefix, a length that scheme issues, and the Luhn check.
    /// </summary>
    public static bool IsCardNumber(ReadOnlySpan<char> digits) =>
        digits.Length is >= MinDigits and <= MaxDigits
        && digits.IndexOfAnyExceptInRange('0', '9') < 0
        && FitsAScheme(digits)
        && PassesLuhn(digits);

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

    /// <summary>
    /// The issuer prefixes and lengths of the card schemes (ISO/IEC 7812 issuer identification
    /// numbers as the schemes publish them): Visa, Mastercard, American Express, Discover, Diners
    /// Club, JCB, UnionPay, Maestro and Mir. Any other number is not a payment card.
    /// </summary>
    private static bool FitsAScheme(ReadOnlySpan<char> d)
    {
        var length = d.Length;
        var p2 = int.Parse(d[..2]);
        var p3 = int.Parse(d[..3]);
        var p4 = int.Parse(d[..4]);
        var p6 = int.Parse(d[..6]);

        return (d[0] == '4' && length is 13 or 16 or 19)                                     // Visa
               || ((p2 is >= 51 and <= 55 || p4 is >= 2221 and <= 2720) && length == 16)     // Mastercard
               || (p2 is 34 or 37 && length == 15)                                           // American Express
               || ((p4 == 6011 || p2 == 65 || p3 is >= 644 and <= 649 || p6 is >= 622126 and <= 622925)
                   && length is >= 16 and <= 19)                                             // Discover
               || ((p3 is >= 300 and <= 305 || p2 is 36 or 38 or 39) && length is >= 14 and <= 19) // Diners Club
               || (p4 is >= 3528 and <= 3589 && length is >= 16 and <= 19)                   // JCB
               || (p2 == 62 && length is >= 16 and <= 19)                                    // UnionPay
               || ((p2 is 50 or 56 or 57 or 58 || p4 is 6304 or 6759 or 6761 or 6762 or 6763)
                   && length is >= 13 and <= 19)                                             // Maestro
               || (p4 is >= 2200 and <= 2204 && length is >= 16 and <= 19);                 // Mir
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
    /// The card numbers in one run, as text spans, leftmost first and longest first: a single
    /// group, the whole run, or a stretch of whole groups printed the way cards are (fours with a
    /// shorter last group, or Amex and Diners' 4-6-5 and 4-6-4). A group is never split.
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
            at = end;
            while (at < stop && text[at] is < '0' or > '9')
            {
                at++;
            }
        }

        var found = new List<(int Start, int End)>();
        var first = 0;
        while (first < groups.Count)
        {
            var next = first + 1;
            var digits = new StringBuilder();
            var candidates = new List<(int Last, string Digits)>();
            for (var last = first; last < groups.Count; last++)
            {
                digits.Append(text, groups[last].Start, groups[last].End - groups[last].Start);
                if (digits.Length > MaxDigits)
                {
                    break;
                }
                if (digits.Length >= MinDigits
                    && (last == first || (first == 0 && last == groups.Count - 1) || PrintedLikeACard(groups, first, last)))
                {
                    candidates.Add((last, digits.ToString()));
                }
            }
            for (var c = candidates.Count - 1; c >= 0; c--)
            {
                if (IsCardNumber(candidates[c].Digits))
                {
                    found.Add((groups[first].Start, groups[candidates[c].Last].End));
                    next = candidates[c].Last + 1;
                    break;
                }
            }
            first = next;
        }
        return found;
    }

    /// <summary>Groups of four with a last group of one to four, or 4-6-5 / 4-6-4.</summary>
    private static bool PrintedLikeACard(List<(int Start, int End)> groups, int first, int last)
    {
        int Length(int g) => groups[g].End - groups[g].Start;
        if (last - first == 2 && Length(first) == 4 && Length(first + 1) == 6 && Length(last) is 4 or 5)
        {
            return true;
        }
        for (var g = first; g < last; g++)
        {
            if (Length(g) != 4)
            {
                return false;
            }
        }
        return Length(last) is >= 1 and <= 4;
    }

    /// <summary><paramref name="text"/> with each valid IBAN's characters replaced by a letter.</summary>
    private static string WithoutIbans(string text)
    {
        StringBuilder? copy = null;
        foreach (Match m in IbanShape().Matches(text))
        {
            // A grouped IBAN may have swallowed a following short word ("... 3000 CARD"): try it
            // whole, then a group shorter at a time.
            var value = m.Value;
            while (true)
            {
                if (IsIban(value))
                {
                    copy ??= new StringBuilder(text);
                    for (var i = m.Index; i < m.Index + value.Length; i++)
                    {
                        copy[i] = 'X';
                    }
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
        return copy?.ToString() ?? text;
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
