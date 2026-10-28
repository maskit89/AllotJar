namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Reads the transaction table out of a text PDF statement, in memory, as CSV text for the
/// generic bank-CSV import (<see cref="ICsvImporter"/>): the user then confirms its columns as for
/// any CSV. The PDF is never stored.
/// </summary>
public interface IPdfTableReader
{
    /// <summary>Whether the bytes are a PDF document.</summary>
    bool IsPdf(ReadOnlySpan<byte> content);

    /// <summary>
    /// The PDF's lines as CSV rows, one cell per column of its transaction table. Throws
    /// <see cref="Exceptions.StatementParseException"/> for a PDF with no text (a scan), a
    /// password-protected one, or one too long to be a statement.
    /// </summary>
    string ReadAsCsv(byte[] pdf, CancellationToken cancellationToken);
}
