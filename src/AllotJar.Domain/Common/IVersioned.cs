namespace AllotJar.Domain.Common;

/// <summary>
/// A record an edit form loads and saves back whole (D11). <see cref="Version"/> is the store's
/// row version, changed by every write: the form sends back the one it loaded, and a save made
/// after someone else changed the record is refused instead of silently overwriting their change.
/// </summary>
public interface IVersioned
{
    /// <summary>The row version as last read; set by the store, never by the application.</summary>
    byte[] Version { get; set; }
}
