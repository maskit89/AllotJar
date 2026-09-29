using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Bank-import coverage (catalog prefix IMP, file docs/testing/cases/15-import.md). Automates the
/// highest-value P0/P1 (plus a few cheap P2) cases that were previously "No"/"Partial" and whose
/// behaviour lives at the parser (Infrastructure) or handler/validator (Application) layer:
///
/// * Format sniffing/routing — a CAMT.053 uploaded on the "auto-detect" dropdown is routed to the
///   CAMT parser (IMP-015); the HSBC sniffer requires EXACTLY three columns so a wider CSV that
///   merely embeds HSBC-style narratives falls through to the generic mapping UI (IMP-018); an
///   out-of-range StatementFormat is a 404 (NotFoundException), never a 500 (IMP-090).
/// * Generic-CSV parser robustness — an explicit delimiter override reads a tab/pipe/semicolon file
///   (IMP-022); a single signed-amount column drops rows whose money sits in the other column
///   (separate debit/credit unsupported, IMP-024); a four-digit-year file resolves to a four-digit
///   format and never flips to a two-digit one (IMP-029); a stray inner sign is rejected while
///   leading/trailing signs parse (IMP-033); a 0.00 row is skipped (IMP-037).
/// * HSBC parser — non-ASCII merchant names survive and the card-mask bullets feed last4 into the
///   idempotency signature (IMP-038).
/// * CAMT parser — an entry whose only reference is EndToEndId=NOTPROVIDED (or absent) gets a null
///   BankReference (IMP-088a), and such a reference-less row re-imports on every upload while a
///   referenced sibling dedups (IMP-088b, the end-to-end path prior tests left unasserted).
/// * Commit validators — a transfer can't also be split (IMP-054); amount &gt; 0 and a 3-letter
///   currency are enforced (IMP-073); a payee is capped at 200 (IMP-071). And the preview validator
///   rejects empty/whitespace content (IMP-077).
///
/// Pure UI/client cases (upload form, mapping-panel controls, dirty-mapping gate, review-grid
/// include/split/transfer editing, success-screen money sums, all-caught-up card) are deferred to
/// the Vitest layer (ImportPage.test.tsx) and the stubbed/journey Playwright specs, which already
/// assert them. The [FeatureGate] 404 (IMP-006), [Authorize] 401 (IMP-007, already automated), the
/// controller no-file / oversized-file / invalid-mapping-JSON guards (IMP-012/077/080/081/087) and
/// the real unique-index + concurrent-commit race (IMP-075/076) live at the API/HTTP or SQL-Server
/// layers, not here (the latter two are covered by tests/AllotJar.IntegrationTests).
/// </summary>
public class IImportCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-import-cov-{Guid.NewGuid()}")
            .Options);

    // Both dedicated parsers in DI registration order (CAMT before HSBC) + the generic importer,
    // so sniffing must pick the right adapter rather than the only one available.
    private static PreviewImportCommandHandler NewPreview(ApplicationDbContext db, string userId) =>
        new(db, new CurrentUserStub(userId),
            new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() },
            new GenericCsvImporter());

    private static CommitImportCommandHandler NewCommit(ApplicationDbContext db, string userId) =>
        new(db, new CurrentUserStub(userId));

    private static List<CommitImportItem> ToCommitItems(ImportPreviewResult preview) =>
        preview.Items.Select(c => new CommitImportItem(
            c.Reference, c.Date, c.Payee, c.Amount, c.Currency, c.IsCredit, null, null)).ToList();

    private static CsvMapping Mapping(char delimiter, bool hasHeader, int amountColumn,
        CsvDecimalStyle style = CsvDecimalStyle.Auto, string? dateFormat = null, string currency = "EUR") =>
        new(delimiter, hasHeader, DateColumn: 0, AmountColumn: amountColumn, DescriptionColumn: 1,
            CurrencyColumn: null, DateFormat: dateFormat, DecimalStyle: style, DefaultCurrency: currency);

    // ================= Format sniffing & routing ==============================

    // IMP-015 — A CAMT.053 XML file uploaded on the default "Bank CSV (auto-detect)" dropdown is
    // sniffed and routed to the CAMT parser: DetectedFormat=Camt053, no mapping panel, raw CAMT refs.
    [Fact]
    public async Task Preview_GenericUpload_OfCamtXml_IsRoutedToTheCamtParser()
    {
        await using var db = NewContext();
        var command = new PreviewImportCommand(Camt053Samples.ThreeEntries, StatementFormat.GenericCsv);

        var result = await NewPreview(db, "user-1").Handle(command, CancellationToken.None);

        result.DetectedFormat.Should().Be(nameof(StatementFormat.Camt053));
        result.Layout.Should().BeNull(); // a sniffed known format gets no generic column-mapping UI
        result.NewCount.Should().Be(3);
        result.Items.Should().NotContain(i => i.Reference.StartsWith("csv:"));
        result.Items.Should().Contain(i => i.Reference == "REF-RENT-001"); // the raw CAMT reference
    }

    // IMP-018 — HSBC sniffing requires EXACTLY three columns, so a wider CSV whose description column
    // merely embeds HSBC-style narratives is NOT hijacked: CanParse is false and the file falls
    // through to the generic column-mapping UI instead of being parsed with the wrong amount column.
    [Fact]
    public async Task WideCsvEmbeddingHsbcText_IsNotHijackedByTheHsbcParser()
    {
        const string wideCsv =
            "Date,Details,Amount,Balance\n" +
            "19/06/2026,AUTOMARKET SER STATION * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR,-35.00,1000.00\n" +
            "17/06/2026,PLANET PLAY 15/06/2026 •••• •••• •••• 4242 -67.75 EUR,-67.75,932.25\n";

        // The four-column shape defeats the 3-column HSBC sniffer.
        new HsbcCsvStatementParser().CanParse(wideCsv).Should().BeFalse();

        // ...so a generic upload lands on the generic path, mapping panel and all.
        await using var db = NewContext();
        var result = await NewPreview(db, "user-1").Handle(
            new PreviewImportCommand(wideCsv, StatementFormat.GenericCsv), CancellationToken.None);

        result.DetectedFormat.Should().Be(nameof(StatementFormat.GenericCsv));
        result.Layout.Should().NotBeNull();
        result.Items.Should().OnlyContain(i => i.Reference.StartsWith("csv:"));
    }

    // IMP-090 — An out-of-range StatementFormat value (99, -1) model-binds through (no IsInEnum on the
    // import validators) and the non-generic branch's parser lookup finds nothing → NotFoundException
    // → 404, never a 500. The negative and positive out-of-range values take the identical path.
    [Theory]
    [InlineData(99)]
    [InlineData(-1)]
    public async Task Preview_OutOfRangeFormat_IsAParserNotFound_Never500(int rawFormat)
    {
        await using var db = NewContext();
        var command = new PreviewImportCommand(
            "2026-06-20,TESCO,-42.50\n", (StatementFormat)rawFormat);

        var thrown = await FluentActions.Invoking(() =>
                NewPreview(db, "user-1").Handle(command, CancellationToken.None))
            .Should().ThrowAsync<NotFoundException>();
        thrown.Which.Message.Should().Contain($"format '{rawFormat}'");
    }

    // ================= Generic-CSV parser robustness ==========================

    // IMP-022 — The delimiter is honoured verbatim by Parse, so an explicit Semicolon/Tab/Pipe
    // override reads a non-comma export whose rows a naive comma split would leave in one field.
    [Theory]
    [InlineData(';')]
    [InlineData('\t')]
    [InlineData('|')]
    public void Generic_honours_an_explicit_delimiter_override(char delimiter)
    {
        var csv = $"2026-06-20{delimiter}TESCO STORES{delimiter}-42.50\n";

        var statement = new GenericCsvImporter().Parse(csv, Mapping(delimiter, hasHeader: false, amountColumn: 2));

        var entry = statement.Entries.Should().ContainSingle().Subject;
        entry.Payee.Should().Be("TESCO STORES");
        entry.Amount.Should().Be(42.50m);
        entry.IsCredit.Should().BeFalse();
    }

    // IMP-024 — Only ONE signed-amount column can be mapped (separate debit/credit is unsupported):
    // a row whose money sits in the OTHER column reads blank in the mapped column and is dropped,
    // so a Debit/Credit export imports only the rows with a value in the chosen column.
    [Fact]
    public void Generic_single_amount_column_skips_rows_whose_money_is_in_the_other_column()
    {
        const string debitCreditCsv =
            "2026-06-20,TESCO,42.50,\n" +      // amount in the Debit column (index 2)
            "2026-06-21,SALARY,,2500.00\n";    // amount in the Credit column (index 3) → blank at 2

        // Map the amount to the Debit column only.
        var statement = new GenericCsvImporter().Parse(debitCreditCsv, Mapping(',', hasHeader: false, amountColumn: 2));

        statement.Entries.Should().ContainSingle().Which.Payee.Should().Be("TESCO");
    }

    // IMP-029 — A four-digit-year file resolves to a FOUR-digit format and its rows read under it;
    // the two-digit formats sit after their four-digit peers and TryParseExact is length-strict, so
    // "12/03/2026" can never resolve to a two-digit format (which would drift an existing file's refs).
    [Fact]
    public void Generic_four_digit_year_file_never_resolves_to_a_two_digit_format()
    {
        var csv = "Date,Description,Amount\n12/03/2026,LOCAL SHOP,-9.99\n";
        var importer = new GenericCsvImporter();
        var mapping = importer.Detect(csv).Suggested with { DefaultCurrency = "EUR" }; // DateFormat null → auto

        var statement = importer.Parse(csv, mapping);

        // dd/MM before MM/dd on ties (European roots); crucially a four-digit format, not "dd/MM/yy".
        statement.ResolvedDateFormat.Should().Be("dd/MM/yyyy");
        statement.Entries[0].BookingDate.Should().Be(new DateOnly(2026, 3, 12));
    }

    // IMP-033 — Leading and trailing signs are read as debits, but a stray INNER sign ("3-5.00") is
    // not a number and the row is rejected (skipped) rather than mis-parsed.
    [Fact]
    public void Generic_rejects_a_stray_inner_sign_but_keeps_leading_and_trailing_signs()
    {
        const string csv =
            "Date,Description,Amount\n" +
            "2026-06-20,LEADING SIGN,-35.00\n" +
            "2026-06-21,TRAILING SIGN,12.50-\n" +
            "2026-06-22,INNER SIGN,3-5.00\n";
        var importer = new GenericCsvImporter();
        var mapping = importer.Detect(csv).Suggested with { DefaultCurrency = "EUR" };

        var statement = importer.Parse(csv, mapping);

        statement.Entries.Should().HaveCount(2); // the inner-sign row is dropped
        statement.Entries.Select(e => e.Payee).Should().BeEquivalentTo(new[] { "LEADING SIGN", "TRAILING SIGN" });
        statement.Entries.Should().OnlyContain(e => !e.IsCredit); // both minus-signed → debits
    }

    // IMP-037 — The generic importer drops a 0.00 row (a fee reversal / informational marker), the
    // same as the HSBC and CAMT parsers, so a zero-amount transaction never reaches — and fails — commit.
    [Fact]
    public void Generic_zero_amount_rows_are_skipped()
    {
        const string csv =
            "Date,Description,Amount\n" +
            "2026-06-20,FEE REVERSAL,0.00\n" +
            "2026-06-21,GROCERIES,-20.00\n";
        var importer = new GenericCsvImporter();
        var mapping = importer.Detect(csv).Suggested with { DefaultCurrency = "EUR" };

        var statement = importer.Parse(csv, mapping);

        statement.Entries.Should().ContainSingle().Which.Payee.Should().Be("GROCERIES");
    }

    // ================= HSBC parser edge cases =================================

    // IMP-038 — A non-ASCII merchant name survives the round-trip intact, and the "••••" card-mask
    // bullets are read for last4 — which feeds the idempotency signature, so two otherwise-identical
    // rows on different cards get DISTINCT references.
    [Fact]
    public void Hsbc_keeps_non_ascii_payees_and_extracts_last4_into_the_signature()
    {
        const string csv =
            "10/06/2026,CAFÉ RÜBEN 09/06/2026 •••• •••• •••• 1234 -8.50 EUR,-8.50\n" +
            "11/06/2026,SAME SHOP 10/06/2026 •••• •••• •••• 1234 -8.50 EUR,-8.50\n" +
            "11/06/2026,SAME SHOP 10/06/2026 •••• •••• •••• 5678 -8.50 EUR,-8.50\n";

        var entries = new HsbcCsvStatementParser().Parse(csv).Entries;

        entries.Should().Contain(e => e.Payee == "CAFÉ RÜBEN"); // accents preserved, no mojibake
        // Same date/amount/description, different card last4 → the last4 in the signature keeps them
        // distinct (both are first occurrences, so it isn't the #occurrence suffix doing the work).
        var byCard = entries.Where(e => e.Payee == "SAME SHOP").ToList();
        byCard.Should().HaveCount(2);
        byCard[0].Reference.Should().NotBe(byCard[1].Reference);
        byCard.Should().OnlyContain(e => e.Reference!.EndsWith("#0"));
    }

    // ================= CAMT reference edge cases =============================

    // IMP-088a — A CAMT entry whose only reference is EndToEndId=NOTPROVIDED resolves to a NULL
    // BankReference (exempt from the dedup index), never an empty or literal-"NOTPROVIDED" key.
    [Fact]
    public void Camt_notprovided_end_to_end_id_yields_a_null_reference()
    {
        const string xml = """
            <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
              <BkToCstmrStmt><Stmt>
                <Acct><Id><IBAN>MT84MALT011000012345MTLCAST001S</IBAN></Id></Acct>
                <Ntry>
                  <Amt Ccy="EUR">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
                  <BookgDt><Dt>2026-06-01</Dt></BookgDt>
                  <NtryDtls><TxDtls>
                    <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
                    <RltdPties><Cdtr><Nm>CORNER SHOP</Nm></Cdtr></RltdPties>
                  </TxDtls></NtryDtls>
                </Ntry>
              </Stmt></BkToCstmrStmt></Document>
            """;

        var entry = new Camt053StatementParser().Parse(xml).Entries.Should().ContainSingle().Subject;

        entry.Payee.Should().Be("CORNER SHOP");
        entry.Reference.Should().BeNull(); // null, not "" and not "NOTPROVIDED"
    }

    // IMP-088b — Because a null-reference entry carries no idempotency key, it re-imports on EVERY
    // upload (a second import creates a second transaction), while a referenced sibling in the same
    // statement dedups normally. The content-level possible-duplicate hint is the only guard here.
    [Fact]
    public async Task Camt_null_reference_entry_reimports_every_time_while_referenced_rows_dedup()
    {
        const string xml = """
            <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
              <BkToCstmrStmt><Stmt>
                <Acct><Id><IBAN>MT84MALT011000012345MTLCAST001S</IBAN></Id></Acct>
                <Ntry>
                  <Amt Ccy="EUR">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
                  <BookgDt><Dt>2026-06-01</Dt></BookgDt>
                  <NtryDtls><TxDtls>
                    <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
                    <RltdPties><Cdtr><Nm>CORNER SHOP</Nm></Cdtr></RltdPties>
                  </TxDtls></NtryDtls>
                </Ntry>
                <Ntry>
                  <Amt Ccy="EUR">99.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
                  <BookgDt><Dt>2026-06-02</Dt></BookgDt>
                  <AcctSvcrRef>REF-KEEP-1</AcctSvcrRef>
                  <NtryDtls><TxDtls>
                    <RltdPties><Cdtr><Nm>UTILITY CO</Nm></Cdtr></RltdPties>
                  </TxDtls></NtryDtls>
                </Ntry>
              </Stmt></BkToCstmrStmt></Document>
            """;

        await using var db = NewContext();
        var command = new PreviewImportCommand(xml, StatementFormat.Camt053);

        var first = await NewPreview(db, "user-1").Handle(command, CancellationToken.None);
        first.NewCount.Should().Be(2);
        await NewCommit(db, "user-1").Handle(
            new CommitImportCommand(null, ToCommitItems(first)), CancellationToken.None);

        // The referenced row persisted with its key; the null-ref row persisted with BankReference NULL.
        (await db.Transactions.CountAsync()).Should().Be(2);
        (await db.Transactions.CountAsync(t => t.BankReference == null)).Should().Be(1);

        // Re-upload the identical file: REF-KEEP-1 is recognised, but the null-ref row is new again.
        var second = await NewPreview(db, "user-1").Handle(command, CancellationToken.None);
        second.NewCount.Should().Be(1);
        second.SkippedDuplicates.Should().Be(1);
        second.Items.Should().ContainSingle().Which.Payee.Should().Be("CORNER SHOP");
    }

    // ================= Commit & preview validators ===========================

    // IMP-054 — A transfer row can't ALSO be split across budget lines; the two modes are mutually
    // exclusive, so a commit item carrying both TransferAccountId and Splits fails validation.
    [Fact]
    public void CommitValidator_RejectsATransferThatIsAlsoSplit()
    {
        var importAccount = Guid.NewGuid();
        var counterparty = Guid.NewGuid();
        var item = new CommitImportItem(
            Reference: "csv:abc#0", Date: new DateOnly(2026, 6, 20), Payee: "E-BANKING PAYMENT",
            Amount: 35m, Currency: "EUR", IsCredit: true, BudgetItemId: null, MemberId: null,
            Splits: new[]
            {
                new CommitImportSplit(Guid.NewGuid(), 20m),
                new CommitImportSplit(Guid.NewGuid(), 15m),
            },
            TransferAccountId: counterparty);

        var result = new CommitImportCommandValidator()
            .Validate(new CommitImportCommand(importAccount, new[] { item }));

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.ErrorMessage == "A transfer can't also be split.");
    }

    // IMP-073 — The commit validator guards the API surface the parsers can't reach: a non-positive
    // amount and a currency that isn't a 3-letter ISO code are both rejected with their messages.
    [Fact]
    public void CommitValidator_RejectsNonPositiveAmount_AndNonThreeLetterCurrency()
    {
        var validator = new CommitImportCommandValidator();

        CommitImportItem Item(decimal amount, string currency) => new(
            Reference: "csv:abc#0", Date: new DateOnly(2026, 6, 20), Payee: "TESCO",
            Amount: amount, Currency: currency, IsCredit: false, BudgetItemId: null, MemberId: null);

        validator.Validate(new CommitImportCommand(null, new[] { Item(0m, "EUR") }))
            .Errors.Should().Contain(e => e.ErrorMessage == "Every imported amount must be greater than zero.");

        validator.Validate(new CommitImportCommand(null, new[] { Item(10m, "EU") }))
            .Errors.Should().Contain(e => e.ErrorMessage == "Currency must be a 3-letter ISO code.");
    }

    // IMP-071 — The commit validator caps the payee at 200 characters (belt-and-suspenders alongside
    // the handler's Truncate and the column's HasMaxLength(200)); 200 is accepted, 201 rejected.
    [Fact]
    public void CommitValidator_CapsThePayeeAtTwoHundredCharacters()
    {
        var validator = new CommitImportCommandValidator();

        CommitImportCommand WithPayee(int length) => new(null, new[]
        {
            new CommitImportItem("csv:abc#0", new DateOnly(2026, 6, 20), new string('x', length),
                10m, "EUR", false, null, null),
        });

        validator.Validate(WithPayee(200)).IsValid.Should().BeTrue();

        var over = validator.Validate(WithPayee(201));
        over.IsValid.Should().BeFalse();
        over.Errors.Should().Contain(e => e.PropertyName.EndsWith("Payee"));
    }

    // IMP-077 — The preview validator rejects an empty OR whitespace-only statement file before any
    // parser runs, with "The statement file is empty." (the SPA disables submit without a file).
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void PreviewValidator_RejectsEmptyOrWhitespaceContent(string content)
    {
        var result = new PreviewImportCommandValidator()
            .Validate(new PreviewImportCommand(content, StatementFormat.GenericCsv));

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.ErrorMessage == "The statement file is empty.");
    }
}
