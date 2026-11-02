using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
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
public partial class Camt053StatementParser : IStatementParser
{
    public StatementFormat Format => StatementFormat.Camt053;

    /// <summary>
    /// Sniff whether the content is a CAMT.053 statement: an XML document that names the
    /// camt.053 namespace or carries the bank-to-customer-statement element. Cheap and
    /// string-based — no XML parse — so it's safe to probe arbitrary uploads with.
    /// </summary>
    public bool CanParse(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return false;
        }
        // U+FEFF is NOT whitespace, so TrimStart alone would miss a BOM'd XML file.
        var head = content.AsSpan().TrimStart('\uFEFF').TrimStart();
        return head.StartsWith("<", StringComparison.Ordinal)
            && (content.Contains("camt.053", StringComparison.OrdinalIgnoreCase)
                || content.Contains("BkToCstmrStmt", StringComparison.Ordinal));
    }

    public ParsedStatement Parse(string content)
    {
        XDocument doc;
        try
        {
            // A leading BOM char reads as "invalid data at the root level", so it is trimmed. A bank
            // statement carries no DTD: one is refused outright rather than expanded (TX-P3-2), and
            // nothing outside the document is ever resolved.
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
            using var reader = XmlReader.Create(new StringReader(content.TrimStart('\uFEFF')), settings);
            doc = XDocument.Load(reader);
        }
        catch (XmlException ex) when (ex.Message.Contains("DTD", StringComparison.OrdinalIgnoreCase))
        {
            throw new StatementParseException("The statement declares a DTD, which a bank statement never does.", ex);
        }
        catch (XmlException ex)
        {
            throw new StatementParseException("The statement is not valid XML.", ex);
        }

        var root = doc.Root
            ?? throw new StatementParseException("The statement document is empty.");

        // A file may hold several statements (one per day, or one per period): every one is read
        // (holistic review M2). They must all be for the same account, since the import books every
        // entry into the one account the user picked.
        var statements = root.DescendantsAndSelf()
            .Where(e => e.Name.LocalName == "Stmt" && !e.Ancestors().Any(a => a.Name.LocalName == "Stmt"))
            .ToList();
        if (statements.Count == 0)
        {
            throw new StatementParseException("No <Stmt> element found — is this a CAMT.053 statement?");
        }
        RefuseMixedAccounts(statements);

        // One malformed entry must not abort an otherwise-valid statement (the CSV parsers skip
        // bad rows the same way), so parse per entry and drop the ones we can't trust.
        var entries = new List<ParsedStatementEntry>();
        // Banks DO reuse references (a standing order re-using its EndToEndId, a pooled
        // AcctSvcrRef). A repeat with other details keeps the bank's reference: the import tells it
        // apart by its date, amount and direction (StatementReferences.Derive), the same way in
        // every statement that shows it, overlapping or not (TX-P2-3). Only a repeat identical in
        // those too gets an occurrence suffix, the Nth such repeat "#N".
        var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
        var contentReferences = new SignatureReferences("camt:");

        // One counter over the whole file: statements in one file cover different days, so an entry
        // is numbered exactly as it would be if its day's statement came as a file of its own.
        var notBooked = 0;
        foreach (var ntry in statements.SelectMany(s => s.Descendants().Where(e => e.Name.LocalName == "Ntry")))
        {
            if (!IsBooked(ntry))
            {
                // A pending (PDNG) or information-only (INFO) entry is not on the account yet: the
                // bank shows it booked, with its final amount and date, in a later statement.
                notBooked++;
                continue;
            }

            var entry = TryParseEntry(ntry);
            if (entry is null)
            {
                continue;
            }

            if (entry.Reference is string reference)
            {
                var identity = string.Create(CultureInfo.InvariantCulture,
                    $"{reference.ToUpperInvariant()}|{entry.BookingDate:yyyy-MM-dd}|{entry.Amount:0.####}|{(entry.IsCredit ? 'C' : 'D')}");
                var index = occurrences.TryGetValue(identity, out var seen) ? seen : 0;
                occurrences[identity] = index + 1;
                if (index > 0)
                {
                    var suffix = $"#{index}";
                    entry = entry with
                    {
                        Reference = FitWithin(reference, MaxReferenceLength - suffix.Length) + suffix,
                    };
                }
            }
            else
            {
                // No bank reference (no AcctSvcrRef, an EndToEndId of NOTPROVIDED, as many banks
                // print for card payments): a stable reference from the entry's own content, as the
                // CSV parsers make, so a re-import or an overlapping statement recognises it
                // (TX-P2-2). Identical entries are told apart by their order, "#N".
                var (contentReference, legacy) = contentReferences.Next(ContentSignature(ntry, entry));
                entry = entry with { Reference = contentReference, LegacyReference = legacy };
            }

            entries.Add(entry);
        }

        if (entries.Count == 0)
        {
            throw new StatementParseException(notBooked > 0
                ? "This statement holds only entries the bank has not booked yet. Import it again once they are booked."
                : "No usable transactions were found in this statement.");
        }

        return new ParsedStatement(entries);
    }

    /// <summary>
    /// Refuse a file whose statements name different accounts (another IBAN or account number, or
    /// another currency of a multi-currency account): its entries can't all go into one account.
    /// The identifiers are compared here and nowhere else; AllotJar keeps no bank details. A
    /// statement that names no account, or no currency, is not compared on that part.
    /// </summary>
    private static void RefuseMixedAccounts(List<XElement> statements)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var currencies = new HashSet<string>(StringComparer.Ordinal);
        foreach (var stmt in statements)
        {
            var acct = Child(stmt, "Acct");
            var idEl = Child(acct, "Id");
            var id = Value(Child(idEl, "IBAN")) ?? Value(Child(Child(idEl, "Othr"), "Id"));
            if (!string.IsNullOrWhiteSpace(id))
            {
                ids.Add(string.Concat(id.Where(c => !char.IsWhiteSpace(c))).ToUpperInvariant());
            }
            var ccy = Value(Child(acct, "Ccy"));
            if (!string.IsNullOrWhiteSpace(ccy))
            {
                currencies.Add(ccy.Trim().ToUpperInvariant());
            }
        }

        if (ids.Count > 1 || currencies.Count > 1)
        {
            throw new StatementParseException(
                "This file holds statements for more than one account. Export each account on its own and import them one at a time.");
        }
    }

    /// <summary>
    /// Whether the bank has booked the entry. <c>Sts</c> is a bare code up to camt.053.001.07 and
    /// <c>&lt;Sts&gt;&lt;Cd&gt;…&lt;/Cd&gt;&lt;/Sts&gt;</c> from .08. Only PDNG (pending) and INFO (shown for
    /// information, never booked) are left out; BOOK, FUTR, a code we don't know and a missing
    /// status import as before.
    /// </summary>
    private static bool IsBooked(XElement ntry)
    {
        var sts = Child(ntry, "Sts");
        if (sts is null)
        {
            return true;
        }
        var code = (Value(Child(sts, "Cd")) ?? (sts.HasElements ? null : sts.Value))?.Trim();
        return !(string.Equals(code, "PDNG", StringComparison.OrdinalIgnoreCase)
            || string.Equals(code, "INFO", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Parse one entry, or null when it can't be trusted: missing/invalid amount, currency or
    /// direction, an unparseable booking date (we never fabricate one), or a 0.00 amount (the app
    /// rejects zero-amount transactions everywhere, so importing one would fail the whole commit).
    /// </summary>
    private static ParsedStatementEntry? TryParseEntry(XElement ntry)
    {
        var amtEl = Child(ntry, "Amt");
        if (amtEl is null || !decimal.TryParse(amtEl.Value, NumberStyles.Number, CultureInfo.InvariantCulture, out var amount))
        {
            return null;
        }

        var currency = amtEl.Attribute("Ccy")?.Value;
        if (string.IsNullOrWhiteSpace(currency) || amount == 0m)
        {
            return null;
        }

        var indicator = Value(Child(ntry, "CdtDbtInd"));
        if (indicator is null)
        {
            return null;
        }
        var isCredit = indicator.Equals("CRDT", StringComparison.OrdinalIgnoreCase);

        var bookingDate = TryParseDate(Child(ntry, "BookgDt") ?? Child(ntry, "ValDt"));
        if (bookingDate is null)
        {
            return null;
        }

        var reference = ResolveReference(ntry);
        var payee = ResolvePayee(ntry, isCredit);

        return new ParsedStatementEntry(
            amount, currency.Trim().ToUpperInvariant(), isCredit, bookingDate.Value, payee, reference);
    }

    /// <summary>The BankReference column holds at most 140 chars (TransactionConfiguration).</summary>
    private const int MaxReferenceLength = 140;

    /// <summary>
    /// Entry-level AcctSvcrRef, else any EndToEndId in the entry details. References at or under
    /// the storage cap are returned RAW — anything ≤140 chars imported fine before, and those
    /// references must never drift. Only a longer one (ISO 20022 caps these at 35 chars, so
    /// essentially never) is folded to a stable prefix+hash form instead of failing the import.
    /// </summary>
    private static string? ResolveReference(XElement ntry)
    {
        var acctSvcrRef = ntry.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "AcctSvcrRef")?.Value;
        if (!string.IsNullOrWhiteSpace(acctSvcrRef))
        {
            return FitWithin(acctSvcrRef.Trim(), MaxReferenceLength);
        }

        var endToEnd = ntry.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "EndToEndId")?.Value;
        return string.IsNullOrWhiteSpace(endToEnd) || endToEnd.Trim() == "NOTPROVIDED"
            ? null
            : FitWithin(endToEnd.Trim(), MaxReferenceLength);
    }

    /// <summary>
    /// What identifies an entry that carries no bank reference: its date, signed amount, currency,
    /// counterparty and remittance text, as printed. Prefixed so it can never equal a bank's own
    /// reference in <see cref="Parse"/>'s occurrence count.
    /// </summary>
    private static string ContentSignature(XElement ntry, ParsedStatementEntry entry)
    {
        var remittance = string.Join(" ", ntry.Descendants()
            .Where(e => e.Name.LocalName is "Ustrd" or "AddtlNtryInf")
            .Select(e => e.Value.Trim())
            .Where(v => v.Length > 0));
        var signed = entry.IsCredit ? entry.Amount : -entry.Amount;
        return string.Create(CultureInfo.InvariantCulture,
            $"camt|{entry.BookingDate:yyyy-MM-dd}|{signed:0.####}|{entry.Currency}|{entry.Payee.ToUpperInvariant()}|{remittance.ToUpperInvariant()}");
    }

    /// <summary>Deterministic fold: unchanged when it fits, else prefix + '~' + 32-hex SHA-256 head.</summary>
    private static string FitWithin(string reference, int max)
    {
        if (reference.Length <= max)
        {
            return reference;
        }

        var hash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(reference)), 0, 16).ToLowerInvariant();
        return $"{reference[..(max - hash.Length - 1)]}~{hash}";
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

    /// <summary>
    /// The entry's booking date, or null when the statement doesn't carry a parseable one.
    /// Never fabricates a date — an entry with no date is dropped by the caller rather than
    /// silently booked "today" (which would also break idempotent re-imports for null-reference
    /// entries, since each re-import would mint a different date).
    /// </summary>
    private static DateOnly? TryParseDate(XElement? dateContainer)
    {
        if (dateContainer is null)
        {
            return null;
        }

        var dt = Value(Child(dateContainer, "Dt"))?.Trim();
        if (dt is not null && DateOnly.TryParse(dt, CultureInfo.InvariantCulture, out var date))
        {
            return date;
        }
        // An xs:date may carry a time zone ("2026-10-01+02:00", "2026-10-01Z"): the day is the
        // day the bank wrote.
        if (dt is not null && DateWithZone().IsMatch(dt)
            && DateOnly.TryParseExact(dt.AsSpan(0, 10), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date))
        {
            return date;
        }

        // A date-time is booked on the calendar day the bank wrote, never moved to UTC or to the
        // server's clock (holistic review M1): "2026-10-01T00:15:00+02:00" is 1 October, not
        // 30 September. AssumeUniversal only stops a time with no offset from being read in the
        // server's zone; DateTime is then the clock time as written either way.
        var dtTm = Value(Child(dateContainer, "DtTm"))?.Trim();
        if (dtTm is not null && DateTimeOffset.TryParse(dtTm, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dto))
        {
            return DateOnly.FromDateTime(dto.DateTime);
        }

        return null;
    }

    // --- local-name navigation helpers --------------------------------------
    private static XElement? Child(XElement? parent, string localName) =>
        parent?.Elements().FirstOrDefault(e => e.Name.LocalName == localName);

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})$", RegexOptions.CultureInvariant)]
    private static partial Regex DateWithZone();

    private static string? Value(XElement? element) =>
        element is null ? null : element.Value;
}
