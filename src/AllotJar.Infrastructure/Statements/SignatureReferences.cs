using System.Security.Cryptography;
using System.Text;
using AllotJar.Domain.Services;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// The reference a statement row without a bank reference gets: a prefix, a hash of the row's own
/// content (its signature) and "#N" for the Nth identical row ("#mN" when a card number was masked), so a re-import or an overlapping
/// statement recognises it. The hash is taken over the signature with any card number masked
/// (compliance fix 12): an unkeyed hash of the bank's text would let a card number the statement
/// printed be recovered from the stored reference by trying the few digits the masked payee
/// hides. A signature with no card number hashes exactly as before. For one that had one, the
/// reference earlier imports stored (hashed over the bank's text) comes back as
/// <see cref="Next"/>'s legacy reference, which duplicate detection checks and nothing stores.
/// </summary>
internal sealed class SignatureReferences(string prefix)
{
    private readonly Dictionary<string, int> _masked = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _raw = new(StringComparer.Ordinal);

    /// <summary>The next row's reference, and the one imports before fix 12 gave it when they differ.</summary>
    public (string Reference, string? Legacy) Next(string signature)
    {
        var masked = CardNumberMask.Mask(signature)!;
        var rawIndex = Count(_raw, signature);
        var maskedIndex = Count(_masked, masked);
        if (ReferenceEquals(masked, signature))
        {
            // As before fix 12, to the character: the occurrence counts over the bank's text.
            return ($"{prefix}{ShortHash(signature)}#{rawIndex}", null);
        }
        // "#m": a row the statement printed already masked hashes over the same text, and the two
        // must never share a reference (the second would be skipped as the first's duplicate).
        return ($"{prefix}{ShortHash(masked)}#m{maskedIndex}", $"{prefix}{ShortHash(signature)}#{rawIndex}");
    }

    private static int Count(Dictionary<string, int> occurrences, string signature)
    {
        var index = occurrences.TryGetValue(signature, out var seen) ? seen : 0;
        occurrences[signature] = index + 1;
        return index;
    }

    /// <summary>First 128 bits of SHA-256 over the signature, as 32 lowercase hex chars.</summary>
    public static string ShortHash(string signature) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature)), 0, 16).ToLowerInvariant();
}
