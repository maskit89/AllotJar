using System.Text.RegularExpressions;

namespace AllotJar.Importer;

/// <summary>
/// Best-effort attribution of a fund spend to a specific sinking fund by matching the
/// transaction's payee against the fund names ("guess the jar from the shop name").
/// The ledger codes yearly spends only at category level (LIC, HLT…), so within the
/// category we pick the fund sharing the most distinctive words with the payee
/// (e.g. "GOOGLE ONE 25/02…" → the "Google One" fund). No shared word → no guess
/// (the row stays on its account only), so a wrong jar is never invented.
/// </summary>
internal static class FundMatcher
{
    // Yearly ledger code → the Yearly-Expenses category it belongs to.
    public static readonly IReadOnlyDictionary<string, string> YearlyCodeToCategory =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["MAIN"] = "Maintenance",
            ["LIC"] = "License",
            ["ACC"] = "Accessories",
            ["HLT"] = "Health",
            ["GFT"] = "Gift",
            ["LM"] = "Liz Maintenance",
        };

    // Generic words that appear in several fund names — ignored so they can't tip a match.
    private static readonly HashSet<string> Stop =
        new(StringComparer.OrdinalIgnoreCase) { "SAVINGS", "MONTHLY", "EXPENSES" };

    /// <summary>The candidate whose name shares the most distinctive words with the payee, or null.</summary>
    public static string? Best(string payee, IReadOnlyList<string> candidates)
    {
        var payeeTokens = Tokens(payee);
        if (payeeTokens.Count == 0) return null;

        string? best = null;
        int bestScore = 0, bestLen = 0;
        foreach (var candidate in candidates)
        {
            int score = 0, len = 0;
            foreach (var token in Tokens(candidate))
            {
                if (payeeTokens.Contains(token)) { score++; len += token.Length; }
            }
            if (score > 0 && (score > bestScore || (score == bestScore && len > bestLen)))
            {
                best = candidate;
                bestScore = score;
                bestLen = len;
            }
        }
        return best;
    }

    /// <summary>Distinctive uppercase word tokens (≥4 letters, not a stop-word).</summary>
    private static HashSet<string> Tokens(string text)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in Regex.Matches(text.ToUpperInvariant(), "[A-Z]{4,}"))
        {
            if (!Stop.Contains(m.Value)) set.Add(m.Value);
        }
        return set;
    }
}
