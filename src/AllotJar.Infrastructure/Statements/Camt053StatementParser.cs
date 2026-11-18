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
        statements = WithoutRepeats(statements);
        RefuseOverlaps(statements);

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
        var unread = 0;
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
                // Counted, as the CSV importer counts its unread lines, unless it is a 0.00 entry
                // (the app has no zero-amount transactions; nothing is lost).
                if (!IsZeroAmount(ntry))
                {
                    unread++;
                }
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

        return new ParsedStatement(entries) { UnreadLines = unread, PendingEntries = notBooked };
    }

    private static bool IsZeroAmount(XElement ntry) =>
        decimal.TryParse(Value(Child(ntry, "Amt")), NumberStyles.Number, CultureInfo.InvariantCulture, out var amount)
        && amount == 0m;

    /// <summary>
    /// The statements without one that repeats an earlier one entry for entry (the same statement
    /// twice, or an original with its COPY or DUPL): its entries would otherwise import twice,
    /// since a repeat in one file is numbered as a second occurrence.
    /// </summary>
    private static List<XElement> WithoutRepeats(List<XElement> statements)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return statements.Where(stmt =>
        {
            var entries = stmt.Descendants().Where(e => e.Name.LocalName == "Ntry").ToList();
            return entries.Count == 0
                || seen.Add(string.Join("\n", entries.Select(e => e.ToString(SaveOptions.DisableFormatting))));
        }).ToList();
    }

    /// <summary>
    /// Refuse a file whose statements cover overlapping periods (<c>FrToDt</c>): an entry in the
    /// overlap could be in both and import twice. Periods that only touch (one ends as the next
    /// starts) do not overlap. A period written the ISO way is compared as written. One that is
    /// there but not ISO ("01/10/2026", which could be read month first) is compared by the first
    /// and last booking day of the statement's own entries instead, days that share one day
    /// overlapping. A statement without a period is not compared.
    /// </summary>
    private static void RefuseOverlaps(List<XElement> statements)
    {
        var instants = new List<(DateTimeOffset From, DateTimeOffset To)>();
        var days = new List<(DateOnly First, DateOnly Last, bool Iso)>();
        foreach (var stmt in statements)
        {
            var period = Child(stmt, "FrToDt");
            if (period is null)
            {
                continue;
            }

            DateTimeOffset from = default, to = default;
            var iso = TryParseInstant(Value(Child(period, "FrDtTm")), out from)
                && TryParseInstant(Value(Child(period, "ToDtTm")), out to);
            if (iso)
            {
                if (instants.Any(p => from < p.To && p.From < to))
                {
                    RefuseOverlap();
                }
                instants.Add((from, to));
            }

            // Two ISO periods were compared above; a period that isn't ISO is compared by booking
            // days with every other statement that has a period.
            if (BookingDays(stmt) is var (first, last))
            {
                if (days.Any(d => (!iso || !d.Iso) && first <= d.Last && d.First <= last))
                {
                    RefuseOverlap();
                }
                days.Add((first, last, iso));
            }
        }

        // Only an ISO date-time is compared: "01/10/2026" could be read month first.
        static bool TryParseInstant(string? text, out DateTimeOffset instant)
        {
            instant = default;
            text = text?.Trim();
            return text is not null && IsoDateTime().IsMatch(text)
                && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out instant);
        }

        static (DateOnly First, DateOnly Last)? BookingDays(XElement stmt)
        {
            var booked = stmt.Descendants()
                .Where(e => e.Name.LocalName == "Ntry" && IsBooked(e))
                .Select(e => TryParseDate(Child(e, "BookgDt") ?? Child(e, "ValDt")))
                .OfType<DateOnly>()
                .ToList();
            return booked.Count == 0 ? null : (booked.Min(), booked.Max());
        }

        static void RefuseOverlap() => throw new StatementParseException(
            "This file holds statements for overlapping periods. Export each period once and import it again.");
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

        // An ISODate (xs:date) may carry a time zone ("2026-10-01+02:00", "2026-10-01Z"): the day
        // is the day the bank wrote. A date-time written where the date belongs is read as one.
        var dt = Value(Child(dateContainer, "Dt"))?.Trim();
        if (dt is not null && IsoDate().IsMatch(dt) && HasRealZone(dt) && DayAsWritten(dt) is DateOnly date)
        {
            return date;
        }
        if (dt is not null && IsIsoDateTime(dt))
        {
            return DayAsWritten(dt);
        }

        // An ISODateTime is booked on the calendar day the bank wrote, never moved to UTC or to
        // the server's clock (holistic review M1): "2026-10-01T00:15:00+02:00" is 1 October, not
        // 30 September. The time and offset are only checked to be real ones.
        var dtTm = Value(Child(dateContainer, "DtTm"))?.Trim();
        if (dtTm is not null && IsIsoDateTime(dtTm))
        {
            return DayAsWritten(dtTm);
        }

        return null;
    }

    /// <summary>An ISO date-time whose time and offset are real ones (not 24:00 or +15:00).</summary>
    private static bool IsIsoDateTime(string text) =>
        IsoDateTime().IsMatch(text)
        && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _);

    /// <summary>An ISO date's time zone, when it has one, is a real offset (not +99:99).</summary>
    private static bool HasRealZone(string isoDate) =>
        isoDate.Length == 10 || isoDate[10] == 'Z' || IsIsoDateTime($"{isoDate[..10]}T00:00:00{isoDate[10..]}");

    /// <summary>
    /// The yyyy-MM-dd day at the start of an ISO date or date-time, or null for one that doesn't
    /// exist (30 February). Only the ISO 20022 form is read: a bank that writes "01/10/2026" or
    /// "01.10.2026" instead would otherwise be read month first, as 10 January, and the entry
    /// would land silently in the wrong month. Such an entry is counted as not read instead.
    /// </summary>
    private static DateOnly? DayAsWritten(string iso) =>
        DateOnly.TryParseExact(iso.AsSpan(0, 10), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
            ? day
            : null;

    // --- local-name navigation helpers --------------------------------------
    private static XElement? Child(XElement? parent, string localName) =>
        parent?.Elements().FirstOrDefault(e => e.Name.LocalName == localName);

    /// <summary>ISODate: yyyy-MM-dd, with an optional time zone.</summary>
    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}(Z|[+-][0-9]{2}:[0-9]{2})?$", RegexOptions.CultureInvariant)]
    private static partial Regex IsoDate();

    /// <summary>
    /// ISODateTime: yyyy-MM-ddThh:mm:ss, optional fraction and time zone. A space for the T, no
    /// seconds, no colon in the offset, or no time at all are taken too: none of them makes the
    /// day ambiguous.
    /// </summary>
    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$", RegexOptions.CultureInvariant)]
    private static partial Regex IsoDateTime();

    private static string? Value(XElement? element) =>
        element is null ? null : element.Value;
}
