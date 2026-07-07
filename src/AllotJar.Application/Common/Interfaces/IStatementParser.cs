using AllotJar.Application.Imports.Models;

namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Parses a bank statement document into a normalized <see cref="ParsedStatement"/>.
/// Implemented in Infrastructure as a format adapter (CAMT.053 today, others later).
/// </summary>
public interface IStatementParser
{
    /// <summary>The document format this parser handles; used to select it for a given import.</summary>
    StatementFormat Format { get; }

    /// <summary>
    /// Cheap content sniff: does this look like a document this parser handles? Used to route a
    /// "generic" upload to the right adapter, so the same file always takes the same code path —
    /// and therefore always produces the same payees and idempotency references.
    /// </summary>
    bool CanParse(string content);

    /// <summary>Parse statement content. Throws <see cref="Exceptions.StatementParseException"/> on malformed input.</summary>
    ParsedStatement Parse(string content);
}
