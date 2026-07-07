using System.Globalization;
using System.Xml;
using System.Xml.Linq;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Models;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Parses ISO 20022 CAMT.053 ("Bank to Customer Statement") XML. Navigation is by
/// element local name so the same code handles every camt.053.001.xx namespace
/// version without binding to a specific schema.
/// </summary>
public class Camt053StatementParser : IStatementParser
{
    public StatementFormat Format => StatementFormat.Camt053;

    public ParsedStatement Parse(string content)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(content);
        }
        catch (XmlException ex)
        {
            throw new StatementParseException("The statement is not valid XML.", ex);
        }

        var root = doc.Root
            ?? throw new StatementParseException("The statement document is empty.");

        var stmt = Descendant(root, "Stmt")
            ?? throw new StatementParseException(
                "No <Stmt> element found — is this a CAMT.053 statement?");

        var iban = Value(Descendant(stmt, "IBAN"));

        var entries = stmt
            .Descendants()
            .Where(e => e.Name.LocalName == "Ntry")
            .Select(ParseEntry)
            .ToList();

        return new ParsedStatement(iban, entries);
    }

    private static ParsedStatementEntry ParseEntry(XElement ntry)
    {
        var amtEl = Child(ntry, "Amt")
            ?? throw new StatementParseException("A statement entry is missing its <Amt>.");

        var amount = ParseDecimal(amtEl.Value);
        var currency = amtEl.Attribute("Ccy")?.Value
            ?? throw new StatementParseException("A statement entry amount is missing its currency (Ccy).");

        var indicator = Value(Child(ntry, "CdtDbtInd"))
            ?? throw new StatementParseException("A statement entry is missing <CdtDbtInd>.");
        var isCredit = indicator.Equals("CRDT", StringComparison.OrdinalIgnoreCase);

        var bookingDate = ParseDate(Child(ntry, "BookgDt") ?? Child(ntry, "ValDt"));
        var reference = ResolveReference(ntry);
        var payee = ResolvePayee(ntry, isCredit);

        return new ParsedStatementEntry(amount, currency.Trim().ToUpperInvariant(), isCredit, bookingDate, payee, reference);
    }

    /// <summary>Entry-level AcctSvcrRef, else any EndToEndId in the entry details.</summary>
    private static string? ResolveReference(XElement ntry)
    {
        var acctSvcrRef = ntry.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "AcctSvcrRef")?.Value;
        if (!string.IsNullOrWhiteSpace(acctSvcrRef))
        {
            return acctSvcrRef.Trim();
        }

        var endToEnd = ntry.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "EndToEndId")?.Value;
        return string.IsNullOrWhiteSpace(endToEnd) || endToEnd.Trim() == "NOTPROVIDED"
            ? null
            : endToEnd.Trim();
    }

    /// <summary>
    /// For a debit the payee is the creditor; for a credit it's the debtor.
    /// Falls back to unstructured remittance info, then empty.
    /// </summary>
    private static string ResolvePayee(XElement ntry, bool isCredit)
    {
        var partyTag = isCredit ? "Dbtr" : "Cdtr";
        var partyName = ntry.Descendants()
            .Where(e => e.Name.LocalName == partyTag)
            .Select(p => Value(Child(p, "Nm")))
            .FirstOrDefault(n => !string.IsNullOrWhiteSpace(n));
        if (!string.IsNullOrWhiteSpace(partyName))
        {
            return partyName!.Trim();
        }

        var remittance = ntry.Descendants()
            .Where(e => e.Name.LocalName == "Ustrd")
            .Select(e => e.Value.Trim())
            .Where(v => v.Length > 0);
        return string.Join(" ", remittance);
    }

    private static DateOnly ParseDate(XElement? dateContainer)
    {
        if (dateContainer is null)
        {
            return DateOnly.FromDateTime(DateTime.UtcNow);
        }

        var dt = Value(Child(dateContainer, "Dt"));
        if (dt is not null && DateOnly.TryParse(dt, CultureInfo.InvariantCulture, out var date))
        {
            return date;
        }

        var dtTm = Value(Child(dateContainer, "DtTm"));
        if (dtTm is not null && DateTimeOffset.TryParse(dtTm, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dto))
        {
            return DateOnly.FromDateTime(dto.UtcDateTime);
        }

        return DateOnly.FromDateTime(DateTime.UtcNow);
    }

    private static decimal ParseDecimal(string raw)
    {
        if (!decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out var value))
        {
            throw new StatementParseException($"'{raw}' is not a valid amount.");
        }
        return value;
    }

    // --- local-name navigation helpers --------------------------------------
    private static XElement? Child(XElement parent, string localName) =>
        parent.Elements().FirstOrDefault(e => e.Name.LocalName == localName);

    private static XElement? Descendant(XElement parent, string localName) =>
        parent.Descendants().FirstOrDefault(e => e.Name.LocalName == localName);

    private static string? Value(XElement? element) =>
        element is null ? null : element.Value;
}
