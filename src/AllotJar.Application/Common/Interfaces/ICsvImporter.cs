using AllotJar.Application.Imports.Models;

namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Generic bank-CSV import. Unlike a fixed <see cref="IStatementParser"/>, a generic CSV needs a
/// column mapping: <see cref="Detect"/> sniffs a best-guess layout for the user to confirm, and
/// <see cref="Parse"/> turns the file into entries using the confirmed mapping.
/// </summary>
public interface ICsvImporter
{
    /// <summary>Sniff delimiter, header and a best-guess column mapping, with a few sample rows for the UI.</summary>
    CsvLayout Detect(string content);

    /// <summary>Parse the CSV with a resolved mapping. Throws <see cref="Exceptions.StatementParseException"/> if nothing usable is found.</summary>
    ParsedStatement Parse(string content, CsvMapping mapping);
}
