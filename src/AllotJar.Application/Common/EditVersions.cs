using AllotJar.Application.Common.Exceptions;
using AllotJar.Domain.Common;

namespace AllotJar.Application.Common;

/// <summary>
/// The row version an edit form loads with a record and sends back with its save (D11).
/// </summary>
public static class EditVersions
{
    /// <summary>
    /// The version a DTO carries: the row version as base64, or null where the store keeps none
    /// (the in-memory test store), which the save then reads as "no check".
    /// </summary>
    public static string? Of(IVersioned record) =>
        record.Version is { Length: > 0 } version ? Convert.ToBase64String(version) : null;

    /// <summary>The refusal of a <c>version</c> that is not one a DTO carried (#308 review P3-2).</summary>
    public const string Malformed = "This version is not one the app gave out. Reload and try again.";

    /// <summary>
    /// Refuses the save when <paramref name="record"/>, as tracked for this save, is no longer the
    /// version the form loaded. Call it on the tracked entity that is actually saved, after any
    /// reload under a ledger lock. Its version is then the original value EF checks in the UPDATE,
    /// so a change committed between this read and the save is refused too (DbUpdateConcurrencyException).
    /// A missing <paramref name="version"/> is no check: a request from a client loaded before the
    /// deploy that added versions is still accepted. One that is not base64 of a row version's
    /// length was never a version at all: a 400 (<see cref="ValidationException"/>), not a conflict.
    /// </summary>
    public static void Ensure(IVersioned record, string? version)
    {
        if (version is null || record.Version is not { Length: > 0 } current)
        {
            return;
        }
        // Room for one byte more than a row version, so a longer value is told from a match.
        Span<byte> sent = stackalloc byte[current.Length + 1];
        if (!Convert.TryFromBase64String(version, sent, out var written) || written != current.Length)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Version"] = new[] { Malformed },
            });
        }
        if (!sent[..written].SequenceEqual(current))
        {
            throw new EditConflictException();
        }
    }
}
