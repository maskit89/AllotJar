namespace AllotJar.Application.Imports.Models;

/// <summary>
/// The bank-statement document format an import is requested in. Each value maps to
/// exactly one <see cref="Common.Interfaces.IStatementParser"/> implementation.
/// </summary>
public enum StatementFormat
{
    /// <summary>ISO 20022 CAMT.053 "Bank to Customer Statement" XML (SEPA).</summary>
    Camt053 = 0,

    /// <summary>HSBC personal-banking "transaction history" CSV (Date, Details, Amount).</summary>
    HsbcCsv = 1,

    /// <summary>
    /// A generic bank-CSV export with a user-confirmed column mapping (date, signed amount,
    /// description, optional currency). For banks without a dedicated adapter — see
    /// <see cref="Common.Interfaces.ICsvImporter"/> and <see cref="CsvMapping"/>.
    /// </summary>
    GenericCsv = 2,
}
