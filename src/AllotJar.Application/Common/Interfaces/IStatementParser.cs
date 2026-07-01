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

    /// <summary>Parse statement content. Throws <see cref="Exceptions.StatementParseException"/> on malformed input.</summary>
    ParsedStatement Parse(string content);
}
