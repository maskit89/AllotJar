# Bank import

**ID prefix:** IMP | **Scope:** The Import screen at `/import` (`client/src/pages/ImportPage.tsx`) end to end, plus the server pipeline behind it: the upload form (File format / Statement file / Add to account); server-side format **sniffing** (`PreviewImportCommandHandler` routes a "Bank CSV (auto-detect)" upload to the `Camt053`/`HsbcCsv` adapter when their `CanParse` matches, else the `GenericCsvImporter`); the generic-CSV **Columns dialog** (restyle PR 14: date/amount/description columns and the date format, with the currency column, number format, delimiter and header row under "More options", and the sample-rows table); **date-format pinning** + per-file lock; **mapping dirty-state** blocking a stale-parse import; **dedup** (the `csv:`/`hsbc:`/CAMT `BankReference` invariant, unique filtered index `IX_Transactions_OwnerId_BankReference`, `#occurrence` suffix for same-signature repeats, the `possibleDuplicate` content hint on re-import); **re-scan carry-over**; import into a chosen **account**; the review grid (include/exclude, categorise, bulk apply, split, transfer) as it gates the import; the **commit** + "Import complete" summary with real money sums; **all-caught-up**; parser robustness (BOM, bare CR, trailing/paren sign, 2-digit years, thousands separators, HSBC packed Details, quoted thousands, 0.00 skip); malformed/empty/oversized files; and the concurrent-commit race recovery. Covers `POST /import/preview` and `POST /import/commit`, both under `ImportController` (feature-gated by `FeatureFlags.CamtImport`); these are the only import endpoints since W07 removed the direct one-shot `POST /import/hsbc-csv` + `POST /import/camt053` (IMP-084..087 retired). Also covers the W07 identity rules on the review grid: reused bank references listed and flagged, recorded transfers offered as match/return candidates (with implied fees), and same-day rows judged on the day's closing balance, credits first (IMP-091..095). | **Out of scope:** Viewing/editing imported rows in the register, manual add, filter/search → `10-transactions.md`; the generic transfer entry form and transfers as ledger rows → `11-transfers.md`; account CRUD, per-account currency, derived balance and reconciliation the import feeds → `12-accounts-reconciliation.md`; budget-line/category creation that populates the category selects, and the learned payee→line auto-categoriser rules → `08-categories-budget-lines.md`; member add/archive, roles and the full `canWrite` matrix (only import-page gating appears here) → the households/people sibling; FX-rate resolution to base currency → `12-accounts-reconciliation.md`; responsive / dark-mode / a11y sweeps of the mapping + review panels (`client/e2e/mocks.ts` + `a11y.spec.ts` + `mobile-layout.spec.ts`) → the a11y/responsive sibling; session/refresh and cross-tab logout → the auth sibling (referenced only where behaviour is import-specific).

**Test data setup:** Unless a case says otherwise, assume an authenticated **Owner** (`canWrite = true`) of a **shared EUR household "Home"** with **2 active members** — *Alex* and *Robin*. `preferredCurrency = "EUR"` and budget currency **EUR** (`/auth/me` → `budgetCurrency: "EUR"`), browser locale **en-GB**, today **2026-07-15**, so `GET /budget/current` returns **July 2026** with expense lines *Groceries* + *Soap* (category *Food*) and *Fuel* (category *Transport*), plus an income line *Salary*. Two EUR accounts exist: **"Joint"** and **"Savings"**. `Features:CamtImport = true`. The SPA always imports through **preview → commit** (`previewImport` → `POST /import/preview` multipart `file,format,mapping?,defaultCurrency?`; `commitImport` → `POST /import/commit` JSON `{accountId, items}`). Money is `decimal(18,4)` server-side, integer minor units client-side; imported actuals are always transaction-derived. Idempotency keys (never change composition): generic `csv:{32-hex SHA-256 head}#{occurrence}` over `date|signed:0.####|UPPER(rawDesc)`; HSBC `hsbc:{32-hex}#{occurrence}` over `postingDate|purchaseDate|last4|signed:0.00|UPPER(desc)`; CAMT = the raw `AcctSvcrRef`/`EndToEndId` (≤140 chars, `#occurrence` on repeats). Unique filtered index `IX_Transactions_OwnerId_BankReference WHERE BankReference IS NOT NULL`; manual (reference-less) rows are exempt. Reference fixture **3-row generic CSV** (`Date,Description,Amount,Currency`): TESCO STORES −42.50, ACME SALARY 2500.00, COFFEE HOUSE −3.80 (all EUR) → Money in €2,500.00 / Money out €46.30 — the exact file the journey test drives. Exception→HTTP mapping (`ExceptionHandlingMiddleware`): `ValidationException`→400 `{title:"Validation failed", errors}`, `NotFoundException`→404, `ForbiddenAccessException`→403, `StatementParseException`→422 (title = message), controller `BadRequest({error})`→400; the client `ErrorBanner` shows `data.title ?? data.error`. Client wiring: `client/src/pages/ImportPage.test.tsx`; full-stack round-trip: `client/e2e-journey/import.spec.ts`; parsers: `tests/AllotJar.Application.Tests/Imports/{GenericCsvImporterTests,HsbcCsvStatementParserTests,Camt053StatementParserTests}.cs`; preview/commit: `ImportPreviewCommitTests.cs`; holds and transfer legs: `ImportHoldsTests.cs`, `ImportTransferLegsTests.cs`, `TransferIdentityW07Tests.cs`; DB race/index: `tests/AllotJar.IntegrationTests/UniqueBankReferenceTests.cs`.

---

## Page access, gating & format selection

### IMP-001 - Owner reaches the import page and sees the upload form
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner (`canWrite = true`); accounts "Joint" + "Savings" exist.
- **Steps:**
  1. Navigate to `/import`.
- **Expected:** The shell's h1 "Import transactions" (no subtitle, no back link — restyle PR 14). One upload card: the drop zone ("Choose a file" / "or drop it here") that is the **Statement file** input (named "Statement file: choose a file or drop it here", then "Statement file: choose a different file" once one is chosen), the **File format** pill select inside it with its (i) **About file formats** (the format's hint, then "Re-importing the same file won't create duplicates."), the **Add to account** select with its (i) **About the account**, listing "Don't link to an account", "Joint", "Savings". Submit button reads **"Review transactions"**, disabled while no file is chosen.
- **Automated:** Yes (ImportPage.test.tsx — "renders the upload form with account options")

### IMP-002 - Read-only / Limited login cannot import, is pointed at manual entry
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Login whose household role gives `canWrite = false` (Read-only or Limited).
- **Steps:**
  1. Navigate to `/import`.
- **Expected:** No upload form. A `Card`: "Importing statements is available to admins and the household owner. You can still add transactions by hand on the Transactions page." with "Transactions" linking to `/transactions`. All import phases (upload/review/done) are suppressed while `!canWrite`.
- **Automated:** No

### IMP-003 - File-format select offers exactly the three supported formats
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner on `/import`.
- **Steps:**
  1. Open the **File format** select.
- **Expected:** Three options in order: **"Bank CSV (auto-detect)"** (default, wire `GenericCsv`), **"HSBC transaction history (CSV)"** (`HsbcCsv`), **"CAMT.053 statement (XML)"** (`Camt053`). The helper text beneath updates per selection (generic: "Most banks' CSV export. Known formats (like the HSBC transaction history) are recognised automatically…").
- **Automated:** No

### IMP-004 - Accept attribute matches the selected format
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner on `/import`.
- **Steps:**
  1. With "Bank CSV (auto-detect)" selected, inspect the **Statement file** input's `accept`.
  2. Switch to "CAMT.053 statement (XML)" and inspect again.
- **Expected:** Generic/HSBC → `accept=".csv,text/csv"`; CAMT.053 → `accept=".xml,text/xml,application/xml"`. The `accept` is a browser hint only — server sniffing is authoritative (IMP-018).
- **Automated:** No

### IMP-005 - Changing format clears the previously-chosen file
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #160 / file-input `key={format}` remount clears stale filename
- **Preconditions:** Owner on `/import`.
- **Steps:**
  1. Select "Bank CSV (auto-detect)", choose a `.csv` file.
  2. Change the format select to "CAMT.053 statement (XML)".
- **Expected:** The file input remounts (`key={format}`) and the drop zone reads "Choose a file" again (no filename); `file` state is `null`, so "Review transactions" is disabled again — no ghost filename left over a dropped file.
- **Automated:** No

### IMP-006 - Import controller is gated by the CamtImport feature flag
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** `Features:CamtImport = false`.
- **Steps:**
  1. `POST /import/preview` (or `/commit`).
- **Expected:** Every `ImportController` endpoint returns **404** — the whole controller carries `[FeatureGate(nameof(FeatureFlags.CamtImport))]`, so the flag disables *all* import (generic and HSBC included, not just CAMT). Any UI import attempt surfaces the resulting error.
- **Automated:** No

### IMP-007 - Unauthenticated request is rejected and never parses
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** No valid JWT.
- **Steps:**
  1. `POST /import/preview` without an access token.
- **Expected:** **401 Unauthorized** (controller `[Authorize]`). With a token but no resolvable `OwnerId`, the handler throws `ForbiddenAccessException` → 403 and never parses the file.
- **Automated:** No

## Upload form & file selection

### IMP-008 - Submitting a valid CSV advances to the review phase
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner on `/import`, format "Bank CSV (auto-detect)".
- **Steps:**
  1. Choose the 3-row fixture CSV (TESCO −42.50, ACME SALARY 2500.00, COFFEE HOUSE −3.80, EUR).
  2. Click **"Review transactions"**.
- **Expected:** Button shows "Reading…" while busy, then phase → `review`. Text "3 new transactions to review" and the three rows appear with include checkboxes labelled "Include TESCO STORES on 2026-06-20" etc.
- **Automated:** Yes (import.spec.ts — "import a CSV end-to-end…"; ImportPage.test.tsx)

### IMP-009 - Submit disabled until a file is chosen
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Owner on `/import`.
- **Steps:**
  1. Do not choose a file; inspect the submit button.
- **Expected:** "Review transactions" is `disabled` while `!file`; it enables only once a file is selected (and shows "Reading…" `disabled` while `busy`).
- **Automated:** No

### IMP-010 - Choosing an import account stamps it on the review notice
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner on `/import`; "Joint" exists.
- **Steps:**
  1. Set **Add to account** to "Joint".
  2. Upload a CSV and go to review.
- **Expected:** The file strip above the list names the account (its type glyph + "Joint"; the sr-only sentence "Importing into Joint." is what the journeys read). The chosen `accountId` is later sent to `commit`, stamping `AccountId` on every non-transfer row and enabling per-row Transfer marking (IMP-050). The select's (i) **About the account**: "Optional. Stamps each transaction onto this account so its balance reflects the import. Pick one to record transfers between your accounts."
- **Automated:** Partial (ImportPage.test.tsx — transfer tests select "Add to account")

### IMP-011 - Import account cannot be changed mid-review (start over)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** In `review` after uploading with no account linked.
- **Steps:**
  1. Look for a control to set the account without leaving review.
- **Expected:** None exists — the account is fixed at upload time. The file strip's ✕ (**"Choose a different file"**, `reset`) returns to `upload`, where the account can be re-selected. (Deferred I3: change-account-mid-review.)
- **Automated:** No

### IMP-012 - Direct API upload with no file is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Authenticated; call the API directly.
- **Steps:**
  1. `POST /import/preview` with an empty/absent `file` part.
- **Expected:** **400** `{ "error": "No file was uploaded." }` (controller guard on `file is null || file.Length == 0`). The client never hits this — submit is disabled without a file.
- **Automated:** No

## Server format sniffing & routing

### IMP-013 - Generic upload of a true generic CSV stays on the generic path
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; a plain `Date,Description,Amount,Currency` CSV (not HSBC-shaped, not XML).
- **Steps:**
  1. Upload with format "Bank CSV (auto-detect)".
- **Expected:** No adapter sniffs true, so `GenericCsvImporter.Detect` + `Parse` run; `DetectedFormat = "GenericCsv"`, `Layout` is populated (mapping panel renders), references are `csv:…`, and no "we recognised this file as…" notice (IMP-016).
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Preview_GenericCsv_DetectsLayout_AndStampsTheDefaultCurrency"; ImportPage.test.tsx — "shows no recognised-format notice…")

### IMP-014 - Generic upload of HSBC content is routed to the HSBC parser
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #154 / same file must take one code path (payee + reference consistency)
- **Preconditions:** Owner; an HSBC transaction-history CSV (`Date,Details,Amount`, no header, packed Details) uploaded as "Bank CSV (auto-detect)".
- **Steps:**
  1. Upload and review.
- **Expected:** `HsbcCsvStatementParser.CanParse` matches (≥80% of the first 50 three-column rows fit the Details pattern), so it parses; `DetectedFormat = "HsbcCsv"`, references are `hsbc:…`, payees are the cleaned merchant, and **no** `Layout` (mapping panel hidden). Importing the same file via the explicit "HSBC transaction history (CSV)" format yields identical references/payees.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Preview_GenericUpload_OfHsbcContent_IsRoutedToTheHsbcParser", "…SkipsRowsAlreadyImportedThroughTheHsbcFormat")

### IMP-015 - Generic upload of CAMT XML is routed to the CAMT parser
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; a CAMT.053 XML file selected under "Bank CSV (auto-detect)" (wrong format on purpose).
- **Steps:**
  1. Upload and review.
- **Expected:** `Camt053StatementParser.CanParse` matches (content starts with `<` after BOM/whitespace trim and contains `camt.053` or `BkToCstmrStmt`), so it parses; `DetectedFormat = "Camt053"`, notice "We recognised this file as a CAMT.053 statement…". Registration order sniffs CAMT before HSBC.
- **Automated:** Partial (Camt053StatementParserTests.cs covers CAMT `CanParse`/Parse; ImportPreviewCommitTests.cs covers HSBC routing)

### IMP-016 - Recognised-format notice shown only for a sniffed known format
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** In review after a generic upload that sniffed as HSBC.
- **Steps:**
  1. Open the file strip's (i) **About the format** (after "Bank CSV").
- **Expected:** "We recognised this file as **an HSBC transaction history export** and read it with the dedicated importer, so payees and duplicate detection stay consistent." The (i) renders only when `format === 'generic'` and `detectedFormat ∈ {HsbcCsv, Camt053}` (`DETECTED_FORMAT_LABELS`); never when the generic path was used.
- **Automated:** Yes (ImportPage.test.tsx — "explains when a generic upload was recognised…" and "shows no recognised-format notice…")

### IMP-017 - A confirmed column mapping stays on the generic path (never re-sniffed)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #154 / never re-sniff once the user confirmed a mapping
- **Preconditions:** Owner previewing a generic CSV; a mapping was returned and edited.
- **Steps:**
  1. Re-scan (send a `mapping`).
- **Expected:** With `request.Mapping != null` the handler skips sniffing entirely and always uses `GenericCsvImporter.Parse`, even if the content would otherwise match HSBC — the user's column choices win. `DetectedFormat` stays `GenericCsv`.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Preview_ConfirmedMapping_StaysOnTheGenericPath")

### IMP-018 - HSBC parser does not hijack a wide CSV that merely embeds HSBC-like text
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A CSV with 4+ columns whose description column contains HSBC-style narratives.
- **Steps:**
  1. Upload as "Bank CSV (auto-detect)".
- **Expected:** `HsbcCsvStatementParser.CanParse` requires *exactly* 3 columns with a `dd/MM/yyyy` first column, so it returns false; the file falls through to the generic mapping UI rather than being parsed with the wrong amount column.
- **Automated:** No

## Generic-CSV Columns dialog

### IMP-019 - Detected columns are pre-filled and the sample rows are shown
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Generic CSV `Date,Description,Amount,Currency` uploaded.
- **Steps:**
  1. Click **Columns** in the file strip.
- **Expected:** The **Columns** dialog (its (i) **About the column mapping**: "We guessed how to read your file. If the rows look off, fix a column and re-scan. Rows that are the same before and after keep the categories you already gave them."). A sample table (caption "Sample of the uploaded file") with the file's column headers and up to 5 parsed rows. The **Date column** / **Date format** / **Description column** / **Amount column** (its (i): "Signed: money out is negative.") selects are pre-set from `GuessMapping` (header-name hints first: "amount" → the Amount column index); **Currency column**, **Number format**, **Column separator** and **First row is a header** sit under **More options**. The Date format select shows the pinned format (plus the sr-only "We read your dates as …" readout). **Cancel** (or Escape) closes it and drops any unapplied change.
- **Automated:** Yes (ImportPage.test.tsx — "generic CSV: shows the mapping panel…" asserts Amount column value "2")

### IMP-020 - Correcting a column and re-scanning refreshes the preview
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** In review with the Columns dialog open.
- **Steps:**
  1. In the Columns dialog, change **Description column** to a different index.
  2. Click **"Apply changes & re-scan"**.
- **Expected:** `previewImport` is re-called with the edited `mapping` and `defaultCurrency: "EUR"` (the import account's currency, else the budget currency); the dialog closes and the list re-renders from the new parse. The re-scan button label is "Re-scan" when clean, "Apply changes & re-scan" when dirty, "Re-scanning…" while busy. A failed re-scan is told inside the dialog (`role="alert"`), which stays open.
- **Automated:** Yes (ImportPage.test.tsx — "generic CSV: shows the mapping panel and re-scans with a corrected mapping"; import.spec.ts)

### IMP-021 - Currency column: "Use {currency} for every row" maps to a null column; the fallback is the import account's currency, else the budget currency
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Generic CSV without a currency column. Variant B: a legacy **GBP** account "UK Current" chosen as **Add to account** (legacy data — new accounts can only be EUR here).
- **Steps:**
  1. With no import account (or "Joint"), upload, review, open Columns → **More options** → the **Currency column** select.
  2. Variant B: choose "UK Current" in **Add to account**, upload, review, open the select.
- **Expected:** Step 1: first option "Use **EUR** for every row" (the household's `budgetCurrency`, not the login's `preferredCurrency` — W08), then each file column; the preview request carries `defaultCurrency: "EUR"`. Step 2: the option reads "Use **GBP** for every row" and the request carries `defaultCurrency: "GBP"`, so the rows match their account (a mismatch would be refused at commit). Choosing the option sets `currencyColumn = null`; the server resolves currency from `DefaultCurrency` (falling back to "EUR" if unset). A currency column is auto-selected only when ≥80% of its cells match `^[A-Za-z]{3}$`.
- **Automated:** Yes (client/src/pages/ImportPage.test.tsx — "generic CSV: rows without a currency are read in the chosen import account’s currency"; ImportPreviewCommitTests.cs — `Preview_GenericCsv_DetectsLayout_AndStampsTheDefaultCurrency`; GenericCsvImporterTests.cs — "Parse_falls_back_to_the_default_currency…")

### IMP-022 - Delimiter select re-reads a semicolon / tab / pipe file
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A semicolon-delimited European CSV.
- **Steps:**
  1. If auto-detection guessed wrong, set **Column separator** (Columns → More options) to "Semicolon ;" and re-scan.
- **Expected:** Options Comma `,` / Semicolon `;` / Tab / Pipe `|`. Auto-detection picks the delimiter with the highest count across the first 5 lines; the override forces it. Re-scanning splits rows on the chosen delimiter.
- **Automated:** No

### IMP-023 - "First row is a header" toggle changes whether row 0 is data
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A headerless CSV mis-detected as having a header (or vice-versa).
- **Steps:**
  1. Toggle **First row is a header** (Columns → More options) and re-scan.
- **Expected:** With it on, row 0 is skipped and column names come from it; with it off, row 0 is parsed as data and columns are labelled "Column 1…N". Auto-detection sets it when row 0 carries no date but a later row (within the first 10) does.
- **Automated:** Partial (GenericCsvImporterTests.cs — "Detect_guesses_columns_from_headers_and_content")

### IMP-024 - Single signed-amount column only (separate debit/credit columns unsupported)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A CSV with separate "Debit" and "Credit" columns.
- **Steps:**
  1. Upload and inspect the mapping.
- **Expected:** Only one **Amount column** (signed) can be chosen (negative = out, positive = in). Rows whose money sits in the *other* column read blank/zero in the mapped column and are skipped (0 or unparseable → dropped). Documents the deferred split-debit/credit limitation; the user must pre-combine columns externally.
- **Automated:** No

### IMP-025 - Mappings are not persisted across files or sessions
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner imported a generic CSV with a hand-corrected mapping, then starts a fresh import.
- **Steps:**
  1. Reset and upload another file of the same bank layout.
- **Expected:** The mapping is re-detected from scratch every upload — there is **no** saved-mapping store or "remember this mapping" control in the current build. The user re-confirms columns each time. (Documents absence, keeping the catalog honest.)
- **Automated:** No

## Date-format & number-format handling

### IMP-026 - Server pins the auto-detected date format and the UI reports it
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #159 / echo `ResolvedDateFormat`, pin into the mapping
- **Preconditions:** Generic CSV with ISO `yyyy-MM-dd` dates, Date format left "Auto-detect".
- **Steps:**
  1. Upload, open Columns and read the Date format.
- **Expected:** The server resolves the single best-fitting format (`ResolveDateFormat`), echoes it as `ResolvedDateFormat`, and pins it into `layout.suggested.dateFormat`. The Columns dialog's **Date format** select shows "YYYY-MM-DD" and its sr-only readout reads "We read your dates as **YYYY-MM-DD**.". Re-scans/re-imports reuse the pinned format, so ambiguous dates never flip between imports.
- **Automated:** Yes (ImportPage.test.tsx — "reports the date format it read for a generic CSV")

### IMP-027 - One date format is locked for the whole file
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #154 / per-row date resolution produced mixed dd/MM + MM/dd in one file
- **Preconditions:** A file where an ambiguous "03/04/2026" appears alongside unambiguous dd/MM dates.
- **Steps:**
  1. Parse the file (auto date format).
- **Expected:** `ResolveDateFormat` picks the single format parsing the most rows (ties → `DateFormats` order: ISO first, `dd/MM` before `MM/dd`), and every row uses it. No row is read as dd/MM while another is MM/dd, so dates *and* `csv:` references stay stable.
- **Automated:** Yes (GenericCsvImporterTests.cs — "Parse_locks_one_date_format_for_the_whole_file")

### IMP-028 - Explicit date format overrides the file scan
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A file whose dates auto-resolve incorrectly.
- **Steps:**
  1. Set **Date format** to the correct pattern (e.g. "MM/DD/YYYY") and re-scan.
- **Expected:** `mapping.DateFormat` is honoured verbatim (`TryParseExact` with that format only); the file scan is skipped. Rows that don't match the chosen format are dropped as non-transactions.
- **Automated:** Yes (GenericCsvImporterTests.cs — "Parse_an_explicit_date_format_still_wins_over_the_file_scan")

### IMP-029 - Two-digit-year dates are rescued without breaking four-digit files
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #159 / 2-digit-year formats appended AFTER 4-digit, length-strict
- **Preconditions:** A CSV whose dates are "12/03/26" (dd/MM/yy).
- **Steps:**
  1. Upload with Date format "Auto-detect".
- **Expected:** The row parses under `dd/MM/yy`. Because two-digit formats sit *after* their four-digit peers and `TryParseExact` is length-strict, a "12/03/2026" file can never resolve to a two-digit format — so no existing four-digit file's resolved format flips.
- **Automated:** No

### IMP-030 - Number format Auto-detect vs 1,234.56 vs 1.234,56
- **Priority:** P0
- **Type:** Boundary
- **Preconditions:** Generic CSV with amounts.
- **Steps:**
  1. For a dot-decimal file leave **Number format** "Auto-detect"; for a `1.234,56` file set "1.234,56"; verify parsed amounts.
- **Expected:** `decimalStyle` 0/1/2. Auto: the right-most of `.`/`,` is the decimal point; a lone separator is a decimal only with 1–2 trailing digits (so "1.234" → 1234, "1.23" → 1.23). Dot: strip commas. Comma: strip dots, comma→point. E.g. "1.234,56" (Comma) → 1234.56, "(35.00)" (Dot) → −35.00.
- **Automated:** Yes (GenericCsvImporterTests.cs — "Parse_honours_the_chosen_decimal_style" theory)

## Parser robustness

### IMP-031 - Leading UTF-8 BOM is stripped (all parsers)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #159 / a surviving BOM corrupts the first cell and its reference
- **Preconditions:** A CSV/XML whose first bytes are the UTF-8 BOM (U+FEFF).
- **Steps:**
  1. Upload the file.
- **Expected:** The BOM is trimmed before parsing — generic/HSBC `TrimStart('﻿')`, CAMT trims it before `XDocument.Parse` (which otherwise errors "invalid data at the root level") and before the `<` check in `CanParse` (U+FEFF is not whitespace). The first date column and the reference are intact.
- **Automated:** Partial (parser unit tests exercise BOM-stripped `SplitLines`/`Parse`)

### IMP-032 - Bare-CR (classic Mac) line endings are split into rows
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #159 / bare-CR files would collapse into one giant line
- **Preconditions:** A CSV whose records are separated by `\r` only.
- **Steps:**
  1. Upload the file.
- **Expected:** `NonEmptyLines`/`SplitLines` split on both `\n` and `\r`, so CRLF (empties filtered), LF, and bare-CR all yield one record per line. Rows parse normally instead of becoming a single unparseable line.
- **Automated:** No

### IMP-033 - Trailing-sign and parenthesised negatives are read as debits
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #159 / trailing-sign "35.00-" (SAP/DATEV) support
- **Preconditions:** Generic CSV with amounts "35.00-" and "(35.00)".
- **Steps:**
  1. Parse (Number format Auto or Dot).
- **Expected:** Both parse to −35.00 → `IsCredit = false`, magnitude 35.00. Leading "-35.00" also works. A stray *inner* sign ("3-5.00") is rejected (row skipped). Currency symbols/letters/spaces are dropped before parsing.
- **Automated:** Partial (GenericCsvImporterTests.cs — accounting-negative theory case)

### IMP-034 - Thousands separators are handled per number style
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Amount "1,234.56" (Dot style) and a quoted HSBC "-1,770.00".
- **Steps:**
  1. Parse the generic file; separately parse an HSBC file with a quoted thousands amount.
- **Expected:** Generic Dot: "1,234.56" → 1234.56. HSBC only quotes amounts containing thousands separators; the RFC-4180 splitter keeps `"-1,770.00"` intact and it parses to −1770.00. A naive comma split would corrupt it — it doesn't.
- **Automated:** Yes (GenericCsvImporterTests.cs decimal-style theory; HsbcCsvStatementParserTests.cs — "Parse_QuotedThousandsAmount_IsParsed")

### IMP-035 - HSBC unquoted merchant comma is stitched back, not dropped
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #159 / "PAYPAL *TEMU, INC" unquoted comma splits Details
- **Preconditions:** HSBC CSV row `date,PAYPAL *TEMU, INC …,-12.00`.
- **Steps:**
  1. Parse the file.
- **Expected:** Column 3 is tried first for the amount (preserving the reference); when the unquoted comma makes column 3 unusable but the *last* field parses as the amount, the middle fields are re-joined with commas as the Details. The row imports with the correct amount and stitched description rather than being dropped. Asterisks inside merchant names (`PAYPAL *TEMU`, `REVOLUT**0573*`) are preserved.
- **Automated:** Yes (HsbcCsvStatementParserTests.cs — "Parse_KeepsAsterisksInsideMerchantNames")

### IMP-036 - HSBC purchase date (not posting date) becomes the transaction date
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** HSBC row whose Details carry a purchase date earlier than the posting date.
- **Steps:**
  1. Parse and review.
- **Expected:** `BookingDate` = the `dd/MM/yyyy` purchase date from Details; the posting date is used only inside the signature. Credits (positive) vs debits (negative) split on the signed amount.
- **Automated:** Yes (HsbcCsvStatementParserTests.cs — "Parse_UsesPurchaseDate_NotPostingDate", "…NegativeAmount_IsDebit…", "…PositiveAmount_IsCredit")

### IMP-037 - Zero-amount rows are skipped by every parser
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** A statement containing a 0.00 line (fee reversal / informational marker).
- **Steps:**
  1. Parse the file.
- **Expected:** The 0.00 entry is dropped (generic `signed == 0m`, HSBC `signedAmount == 0m`, CAMT `amount == 0m`) rather than carried into commit where a zero-amount transaction would be rejected everywhere and fail the whole batch.
- **Automated:** Partial (CAMT/HSBC parser tests; commit validator "amount > 0")

### IMP-038 - Non-ASCII payees and card-mask bullets survive the round-trip
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A statement with an emoji/accented merchant and HSBC `•••• •••• •••• 1234` masks.
- **Steps:**
  1. Upload (HSBC/preview read the stream as UTF-8) and review.
- **Expected:** The payee retains Unicode characters; the `•` (U+2022) bullets in the mask survive so `last4` (1234) is extracted for the signature. Nothing is mojibake'd.
- **Automated:** No

## Review grid: include, categorise, bulk

### IMP-039 - Suggested category is pre-filled from past categorisations
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Prior transactions categorised the payee "AUTOMARKET" to "Groceries".
- **Steps:**
  1. Preview a file containing AUTOMARKET; inspect its Category select.
- **Expected:** The row's Category defaults to the suggested current-month line ("Groceries"). The suggestion resolves by `suggestedBudgetItemId` then by name; unknown payees default to "Unassigned". Credits offer Income lines, debits offer Expense lines.
- **Automated:** Yes (ImportPage.test.tsx — "previews, then commits with the suggested category pre-filled"; ImportPreviewCommitTests.cs — "Preview_SuggestsLine_FromPriorCategorization")

### IMP-040 - Unticking a row excludes it from the commit
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** In review with 2 rows.
- **Steps:**
  1. Untick "Include WOLT on 2026-06-15".
  2. Click "Import 1 transaction".
- **Expected:** The excluded row's text mutes and the Import button count drops to 1; the committed `items` array contains only the ticked row. `includedCount` drives the button label "Import {n} transaction(s)".
- **Automated:** Yes (ImportPage.test.tsx — "excludes unticked rows from the commit")

### IMP-041 - Include-all header checkbox toggles every row
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** In review with several rows.
- **Steps:**
  1. Click the header "Include all rows" checkbox off, then on.
- **Expected:** `setAllIncluded(false)` unticks every row (Import disabled at `includedCount === 0`); ticking it re-includes all. The header box is checked only when every row is included.
- **Automated:** No

### IMP-042 - Bulk-apply a member to included plain rows
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** In review; members Alex/Robin exist.
- **Steps:**
  1. Open the list bar's ⋯ **Bulk actions** → **"Member for included rows"**, choose "Alex" in **Member** and click **"Apply to included"**.
- **Expected:** Every included row that is *not* split and *not* a transfer gets `memberId = Alex` (the member chip shows on each). Split rows (per-line members) and transfers are untouched. The menu item is disabled when there are no members; **Cancel** applies nothing.
- **Automated:** Yes (ImportPage.test.tsx — "bulk-applies a member to the included rows")

### IMP-043 - Bulk-apply a category to included expenses only
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** In review with a mix of debits and credits.
- **Steps:**
  1. Open the list bar's ⋯ **Bulk actions** → **"Category for included expenses"**, choose an expense line in **Category** and click **"Apply to expenses"**.
- **Expected:** Only included, non-split, non-transfer, **debit** rows (`!isCredit`) receive `budgetItemId`; credits and transfers are skipped (the bulk category is an expense-line list). The menu item is disabled when there are no expense groups.
- **Automated:** No

### IMP-044 - Amount direction and colour render correctly
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** In review with one credit and one debit.
- **Steps:**
  1. Inspect the Amount column.
- **Expected:** Credits show "+€X" in the ok green; debits show "−€X" in slate (transfers and unticked rows muted). Amounts use `formatMoney(minor, currency)` with the row's own currency.
- **Automated:** No

## Row splits

### IMP-045 - Split a row across two lines and commit the slices
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** In review; an AUTOMARKET €35.00 debit.
- **Steps:**
  1. Open the row's ⋯ ("AUTOMARKET on 2026-06-17: more actions") → "Split AUTOMARKET on 2026-06-17".
  2. In the **Split** dialog: Line 1 → Groceries €20; Line 2 → Soap €15; **Done**.
  3. Import.
- **Expected:** The dialog shows the "Remaining to allocate" meter and "Fully allocated" when lines sum to 35.00; the row's split chip reads "Groceries €20 · Soap €15". The committed item has `budgetItemId: null`, `memberId: null`, and `splits: [{Groceries,20},{Soap,15}]`. The server persists a split transaction with two `TransactionSplit` slices.
- **Automated:** Yes (ImportPage.test.tsx — "splits a row across two categories and commits the slices"; ImportPreviewCommitTests.cs — "Commit_PersistsSplitRow_AcrossLines_AndTracksEachLine")

### IMP-046 - Incomplete split blocks the import
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** AUTOMARKET €35 split with only €20 allocated.
- **Steps:**
  1. Enter Line 1 = €20 (€15 left), leave the rest.
- **Expected:** The list's foot note "Finish the highlighted rows first." (a polite live region), with the rules behind its (i) **What the highlighted rows need**: "Splits must add up, transfers need an account, a fee needs a category, and jar amounts can't exceed what arrived." The dialog's Done stays disabled and its readout shows "€15.00 left"; closed (Escape), the row's split chip is bad-toned and Import is disabled (`reviewIncomplete`). `onCommit` never fires.
- **Automated:** Yes (ImportPage.test.tsx — "blocks the import while a split is incomplete")

### IMP-047 - Over-allocated split is flagged and blocked
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** AUTOMARKET €35 split.
- **Steps:**
  1. Enter Line 1 = €20, Line 2 = €20 (total €40).
- **Expected:** Remaining readout shows "€5.00 over" in the bad tone, the meter turns bad, `splitInfo.valid` is false and Import stays disabled. The client blocks before the server's "must add up to 35.0000; they add up to 40.0000" check.
- **Automated:** No

### IMP-048 - A split needs at least two lines; extra lines can be added/removed
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** A split editor open.
- **Steps:**
  1. Observe the minimum lines; add a third with "+ Add line"; remove it ("Remove split line 3 for AUTOMARKET"); try "Clear split" (the dialog's footer, or the row's ⋯).
- **Expected:** A split starts with 2 lines; the remove ✕ only appears when there are >2 lines, so it can never drop below 2. "Clear split" reverts the row to a single category (the Assign chip). Server validator rejects `Splits.Count < 2` ("A split needs at least two lines."), an empty slice line ("Choose a budget line for every split line."), and a slice amount ≤ 0 ("Each split line needs an amount greater than zero.").
- **Automated:** Yes (CommitImportCommandValidator; ImportPreviewCommitTests.cs — "Commit_RejectsSplit_ThatDoesNotSumToTheAmount", "Commit_RejectsSplitLineOwnedByAnotherUser")

### IMP-049 - Server rejects a split whose slices don't sum to the amount
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Direct commit with a split summing to less/more than the row amount (bypassing the UI gate).
- **Steps:**
  1. `POST /import/commit` with `Amount = 35`, `Splits = [{20},{10}]`.
- **Expected:** **400** "Validation failed" — handler message "The split lines for 'AUTOMARKET' must add up to 35; they add up to 30." / validator "Split lines must add up to the transaction amount." No transaction is created.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Commit_RejectsSplit_ThatDoesNotSumToTheAmount")

## Row transfers

### IMP-050 - Mark a likely-transfer row as a transfer and commit it
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Import account "Joint" selected at upload; a credit "E-BANKING PAYMENT €234.24" flagged `likelyTransfer`; "Savings" is another account.
- **Steps:**
  1. In review the row shows the "Looks like a transfer" chip.
  2. Open the row's ⋯ → "Mark E-BANKING PAYMENT on 2026-06-16 as a transfer".
  3. In the **Transfer** dialog choose "Savings" in **From** ("Transfer account for E-BANKING PAYMENT on 2026-06-16"); **Done**.
  4. Import.
- **Expected:** The row switches to the "Transfer" chip with "from Savings" (credit → "from"; debit → "to"); the chip reopens the dialog. Committed item has `budgetItemId: null, memberId: null, transferAccountId: Savings`. The server creates a `Transfer` transaction: a credit moves money **into** the import account (source = Savings, dest = Joint); a debit moves **out** (source = Joint, dest = counterparty). `TransferHeuristic` flags markers "E-BANKING PAYMENT", "INTERNAL TRANSFER", "TRANSFER TO/FROM", "OWN ACCOUNT".
- **Automated:** Yes (ImportPage.test.tsx — "marks a flagged row as a transfer…"; ImportPreviewCommitTests.cs — "Commit_Transfer_Credit_MovesMoneyIntoTheImportAccount"/"…Debit_MovesMoneyOutOf…"; "Preview_FlagsLikelyTransfers")

### IMP-051 - Transfer without a counterparty blocks the import
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** A row marked as a transfer but no account chosen.
- **Steps:**
  1. Mark the row a transfer; leave the dialog's account at "Choose account…" and close it.
- **Expected:** The row's Transfer chip and "Choose account…" turn bad-toned, `reviewIncomplete` is true, Import disabled, and the "Finish the highlighted rows first…" note shows. `onCommit` never fires. The same chip turns bad-toned (its `title` naming the reason) for a typed fee the row cannot carry, whose "+ fee" line is then hidden, and for a fee without a line; a credit's "into jars" toggle turns bad-toned while its amounts exceed the credit, open or folded (ImportPage.restyle.test.tsx, ImportPage.jars.test.tsx).
- **Automated:** Yes (ImportPage.test.tsx — "blocks import while a transfer has no counterparty chosen")

### IMP-052 - Transfer requires an import account to be chosen
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** No account selected at upload; transfer-like rows present (or a direct commit with `AccountId = null` and a `transferAccountId`).
- **Steps:**
  1. Review without an account; then attempt a direct commit with a transfer item and no account.
- **Expected:** With no import account **Mark as transfer** is absent from every row's ⋯ (`canTransfer = !!accountId && otherAccounts.length > 0`), and the file strip's "No account" carries a warn (i) **About the account**: "Some rows look like transfers between your accounts. Re-import with an account selected to record them as transfers." A direct commit fails **400** "Choose the account this import belongs to before marking rows as transfers."
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Commit_Transfer_RequiresAnImportAccount"; CommitImportCommandValidator)

### IMP-053 - Transfer counterparty must differ from the import account
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Import account "Joint"; direct commit with `transferAccountId = Joint`.
- **Steps:**
  1. Commit.
- **Expected:** **400** "The transfer '{payee}' must move to a different account from the one being imported." The UI only offers *other* accounts (`otherAccounts`) in the counterparty select, so this is reachable only via the API.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Commit_Transfer_RejectsSameAccountOnBothLegs")

### IMP-054 - Transfer cannot also be split
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Direct commit item with both `TransferAccountId` and `Splits`.
- **Steps:**
  1. Commit.
- **Expected:** **400** "A transfer can't also be split." (validator, when `TransferAccountId != null`). In the UI, starting a transfer clears `splits` and vice-versa, so the two modes are mutually exclusive there.
- **Automated:** No

### IMP-055 - Undo returns a transfer row to a normal categorised row
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** A row marked as a transfer.
- **Steps:**
  1. Open the row's ⋯ → "Undo transfer" (aria "Undo transfer for {payee} on {date}"; the Transfer dialog's **Undo transfer** button has the same name).
- **Expected:** `isTransfer = false`, `transferAccountId = ''`; the row shows the Assign chip again and can be categorised/split normally.
- **Automated:** No

## Dedup, idempotency & possible-duplicate hint

### IMP-056 - Re-importing the identical file skips everything (all caught up)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #159 / per-request dedup + unique index; PR #154 idempotency
- **Preconditions:** A CSV already imported once.
- **Steps:**
  1. Reset and upload the same file again; review.
- **Expected:** Every row's `csv:`/`hsbc:` reference already exists, so preview returns `NewCount = 0`, `rows.length === 0`, and the "You're all caught up" card shows "…all N were skipped as duplicates." No grid, no Import button.
- **Automated:** Yes (import.spec.ts — "…then re-import shows all-caught-up (dedup)"; ImportPage.test.tsx — "shows an all-caught-up message…")

### IMP-057 - Genuinely repeated identical charges each import once (occurrence suffix)
- **Priority:** P0
- **Type:** Boundary
- **Preconditions:** A statement with four identical charges on one day (same date/amount/description).
- **Steps:**
  1. Import the file.
- **Expected:** Each identical row gets a distinct `#occurrence` index (`csv:{hash}#0..#3` / `hsbc:{hash}#0..#3`), so all four import; re-importing the same file is a no-op. The occurrence counter is per-signature and deterministic across runs.
- **Automated:** Yes (GenericCsvImporterTests.cs — "…repeated_identical_rows_distinct_references…"; HsbcCsvStatementParserTests.cs — "Parse_FourIdenticalCharges_ProduceFourDistinctReferences", "Parse_IsDeterministic_AcrossRuns")

### IMP-058 - Reference composition is stable across releases (golden invariant)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #154 / BankReference golden invariant — never change composition
- **Preconditions:** A fixed sample statement.
- **Steps:**
  1. Parse it and compare references to the pinned golden values.
- **Expected:** Generic `csv:` and HSBC `hsbc:` references match the pinned strings exactly (SHA-256 first 128 bits over the documented signature + `#occurrence`). The generic signature keys on the **raw** description even though the displayed payee is cleaned, so earlier imports of the same file still match. Any change here needs a data migration.
- **Automated:** Yes (GenericCsvImporterTests.cs — "Parse_references_are_stable_across_releases", "…keys_references_on_the_raw_description_not_the_cleaned_payee"; HsbcCsvStatementParserTests.cs — "Parse_References_AreStableAcrossReleases")

### IMP-059 - Possible-duplicate hint unticks a content-match on re-import
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #154 / same file imported via a different format/mapping (disjoint keys)
- **Preconditions:** A transaction exists at €80.90 debit, payee "WOLT", 2026-06-15; the incoming row has a *different* reference scheme.
- **Steps:**
  1. Preview a file whose WOLT row's reference doesn't match but the content does.
- **Expected:** WOLT is flagged `possibleDuplicate` and rendered **unticked** (muted text) with the warn chip "Possible duplicate" beside the payee; the list bar's chip reads "1 unticked" (or "N already imported" when rows were skipped) and its (i) **About skipped rows** ends "1 possible duplicate unticked (tick to include)." It is excluded from the commit unless re-ticked. Match = same amount, direction-compatible, same currency (CI), payee equal-or-containment, booked within ±4 days.
- **Automated:** Yes (ImportPage.test.tsx — "unticks possible duplicates by default…"; ImportPreviewCommitTests.cs — "Preview_FlagsPossibleDuplicates…", "…MatchesWhenOnePayeeContainsTheOther")

### IMP-060 - Possible-duplicate window is ±4 days inclusive
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** An existing transaction dated 2026-06-15.
- **Steps:**
  1. Preview candidates dated 06-11 and 06-19 (4 days) vs 06-10 and 06-20 (5 days), same amount/payee/direction.
- **Expected:** The 4-day-apart rows are flagged; the 5-day-apart rows are not. The window (`PossibleDuplicateWindowDays = 4`) covers purchase-vs-posting drift without catching weekly recurring charges.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Preview_PossibleDuplicate_WindowBoundary" theory)

### IMP-061 - Possible-duplicate requires matching direction and currency
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** An existing €80.90 **credit** (Income) at "WOLT".
- **Steps:**
  1. Preview a €80.90 **debit** "WOLT" within the window; and a same-amount row in a different currency.
- **Expected:** Neither is flagged — direction must be compatible (Income↔credit, Expense↔debit, Transfer↔either) and currency must match (case-insensitive). Only genuine content matches are unticked.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Preview_PossibleDuplicate_RequiresMatchingDirectionAndCurrency")

### IMP-062 - Possible-duplicate never crosses households
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Another user has a matching transaction; the current household does not.
- **Steps:**
  1. Preview the file as the current owner.
- **Expected:** No rows are flagged — the nearby-transaction scan is filtered to `OwnerId == userId`. No cross-tenant leakage of another household's data.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Preview_PossibleDuplicate_IgnoresOtherUsersTransactions")

### IMP-063 - A ticked-back possible duplicate is imported
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A previewed row flagged `possibleDuplicate` (unticked).
- **Steps:**
  1. Re-tick "Include WOLT on 2026-06-15" and Import.
- **Expected:** The row is committed (two genuine identical purchases is a valid case). Since its *reference* is new, it inserts normally — the hint is content-level only, not a hard block.
- **Automated:** Yes (ImportPage.test.tsx — "a possible duplicate can be ticked back in and committed")

## Mapping dirty-state & re-scan carry-over

### IMP-064 - Editing the mapping blocks import until a re-scan
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #160 / "edit date format → Import → silently imports OLD parse" trap
- **Preconditions:** Generic CSV in review; the Columns dialog open.
- **Steps:**
  1. In the Columns dialog change any control (e.g. Description column) without re-scanning.
- **Expected:** `mappingDirty` (JSON-compare `mapping` vs `scannedMapping`) becomes true: the Import button is disabled, the Columns dialog's footer shows "You've changed the column mapping. Re-scan to apply it before importing.", its re-scan button reads "Apply changes & re-scan", and `onCommit` early-returns while dirty. Cancel/Escape on the dialog drops the edit and Import unblocks. No stale parse can be committed.
- **Automated:** Yes (import.spec.ts — "editing the column mapping blocks import until re-scanned"; ImportPage.test.tsx)

### IMP-065 - Re-scan carries forward per-row work for unchanged rows
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #160 / re-scan carry-over keyed on unchanged reference
- **Preconditions:** In review; the user categorised "TESCO" to Groceries, then edited the mapping.
- **Steps:**
  1. Click "Apply changes & re-scan"; the re-scan returns the same rows (references unchanged).
- **Expected:** Rows whose `reference` is unchanged keep their `include`/category/member/split/transfer choices (the reference encodes date+amount+description, so a matching row is genuinely the same transaction). TESCO's category is still Groceries and Import re-enables. Rows whose reference *changed* are treated as new and drop their prior edits.
- **Automated:** Yes (ImportPage.test.tsx — "blocks import until an edited mapping is re-scanned, keeping categorisation across the re-scan")

### IMP-066 - A clean (unedited) mapping does not block import
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Generic CSV in review; mapping untouched.
- **Steps:**
  1. Inspect the Import button and, in the Columns dialog, the re-scan button.
- **Expected:** `mappingDirty` is false: Import is enabled (given a valid list), and the Columns dialog's re-scan button reads "Re-scan" with no warning.
- **Automated:** Yes (ImportPage.test.tsx — mapping-panel test asserts the clean state before editing)

## Commit, success summary & money sums

### IMP-067 - Successful commit shows honest money sums, not counts
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #160 / Money in/out are summed amounts (minor units), not row counts
- **Preconditions:** In review; AUTOMARKET €35 + WOLT €80.90, both EUR debits.
- **Steps:**
  1. Import both.
- **Expected:** "Import complete" with the sr-only "2 transactions added." Stats: **Imported** 2, **Money in** €0.00, **Money out** €115.90 (35 + 80.90 summed from the reviewed rows in state), **Transfers** 0 (**Skipped**, **Matched**, **Pending review**, **Returned**, **Held** and the waiting-amount count show only above zero). Money is summed in minor units grouped by currency (transfers excluded from in/out; they stay a count). For the 3-row fixture: Money in €2,500.00 / Money out €46.30.
- **Automated:** Yes (ImportPage.test.tsx — "shows real money sums (not counts) on the success screen"; import.spec.ts asserts 2,500.00 in / 46.30 out)

### IMP-068 - Mixed-currency import sums each currency separately; the other-currency rows arrive waiting
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A statement with EUR and GBP debits (and no credits), imported with **no** import account (with "Joint" chosen the GBP rows are refused at commit: "…EUR…", `Commit_RejectsARowWhoseCurrencyDiffersFromTheImportAccount`).
- **Steps:**
  1. Import; read Money in / Money out.
  2. Open `/transactions`.
- **Expected:** `moneyByCurrency` groups by currency and renders Money out as "€X + £Y" (never a cross-currency sum); the empty Money in group shows the **budget currency** at 0 ("€0.00"). On Transactions the GBP rows read "GBP …" with **"Needs EUR amount"** and count in no figure until confirmed (IMP-091, TX-104); the EUR rows count at once.
- **Automated:** No

### IMP-069 - Commit stamps the chosen account on every row
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Import account "Joint" chosen; two categorised rows.
- **Steps:**
  1. Import.
- **Expected:** Each created `Transaction` has `AccountId = Joint`, so the account's derived balance reflects the import; `commit` receives `accountId = Joint` (not null).
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Commit_StampsTheChosenAccount")

### IMP-070 - Commit persists category and member and tracks the line
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Rows categorised with a member.
- **Steps:**
  1. Import.
- **Expected:** Non-split rows persist `BudgetItemId` + `MemberId`; the actual for that line reflects the new transaction (actuals are always tx-derived). No exchange rate is looked up or stored (W08); a row in another currency than the budget's is saved in its own currency, waiting (IMP-091), and does not reach the line until its amount is confirmed.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Commit_PersistsChosenCategoryAndMember_AndTracksTheLine")

### IMP-071 - Long payee is truncated; long reference is capped
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** A row whose payee exceeds 200 characters (direct commit; parsers rarely produce this).
- **Steps:**
  1. Commit.
- **Expected:** `Payee` is truncated to 200 (`Truncate(item.Payee, 200)`; column `HasMaxLength(200)`; validator caps `Payee` at 200). `BankReference` is capped at 140 — CAMT folds a >140 ref to `prefix~hash` (ISO caps refs at 35, so this essentially never fires).
- **Automated:** No

### IMP-072 - Commit rejects a budget line, member, or account owned by another household
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Direct commit referencing a `budgetItemId`/`memberId`/`transferAccountId` that belongs to a different owner.
- **Steps:**
  1. Commit.
- **Expected:** **403 Forbidden** — `EnsureAllOwnedAsync` verifies every referenced foreign key (whole-row and per-slice) exists within the caller's own data; any mismatch throws `ForbiddenAccessException`. No rows are written.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Commit_RejectsBudgetLineOwnedByAnotherUser", "…MemberOwnedByAnotherUser", "…SplitLineOwnedByAnotherUser", "Commit_Transfer_RejectsCounterpartyOwnedByAnotherUser")

### IMP-073 - Commit amount and currency are validated
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Direct commit with `Amount = 0` (or negative) and/or a 2-letter currency.
- **Steps:**
  1. Commit.
- **Expected:** **400** "Validation failed": "Every imported amount must be greater than zero." and "Currency must be a 3-letter ISO code." (`CommitImportCommandValidator`). The parsers never emit zero/negative magnitudes (they store `Math.Abs` and drop 0.00), so this guards the API surface.
- **Automated:** No

### IMP-074 - Idempotent resubmit of the same commit skips everything
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #159 / double-submit must not duplicate
- **Preconditions:** A commit already succeeded for a set of references.
- **Steps:**
  1. POST the identical commit body again.
- **Expected:** Every reference is already present; the handler's in-memory dedup skips all of them → `Imported = 0`, `SkippedDuplicates = N`. No new rows, no error.
- **Automated:** Yes (ImportPreviewCommitTests.cs — "Commit_IsIdempotent_OnResubmit"; UniqueBankReferenceTests.cs — "Sequential_resubmit_still_skips_everything…")

## Concurrency & the unique-index backstop

### IMP-075 - Database refuses a duplicate (owner, reference) pair
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #159 / unique filtered index IX_Transactions_OwnerId_BankReference
- **Preconditions:** Real SQL Server; a transaction with a given `BankReference` exists.
- **Steps:**
  1. Insert a second transaction with the same `OwnerId` + `BankReference`.
- **Expected:** The insert is rejected by the unique filtered index. The same reference under a *different* owner is allowed, and reference-less (manual) transactions are exempt (multiple NULLs allowed).
- **Automated:** Yes (UniqueBankReferenceTests.cs — "Database_refuses_a_duplicate_owner_reference_pair", "Same_reference_under_different_owners_is_allowed", "Reference_less_manual_transactions_are_exempt_from_the_index")

### IMP-076 - Concurrent commit race is recovered, not double-inserted
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #159 / per-request dedup is memory-only; DB index turns the race into a recoverable DbUpdateException
- **Preconditions:** Real SQL Server; two overlapping commits (double-click / two devices / two household logins) carrying the same references.
- **Steps:**
  1. A rival commit inserts the references between this commit's dedup snapshot and its `SaveChanges`.
- **Expected:** `SaveChanges` throws `DbUpdateException` matching the index name; the handler re-reads the taken references (case-insensitive, matching the DB collation), drops the collided Added rows (adjusting `imported`/`skipped`/`credits`/`debits`/`transfers`), and saves the rest — up to 3 attempts. Net effect: each reference persists exactly once, no duplicates, no 500. InMemory tests can't exercise this (no unique enforcement).
- **Automated:** Yes (UniqueBankReferenceTests.cs — "Commit_recovers_when_a_concurrent_commit_wins_the_race")

## All-caught-up, empty & malformed inputs

### IMP-077 - Empty (0-byte) file is rejected before parsing
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** A 0-byte file.
- **Steps:**
  1. Upload (or `POST /import/preview` with an empty part).
- **Expected:** **400** `{ "error": "No file was uploaded." }` (controller `file.Length == 0` guard). The client submit is disabled without a file, so this is an API-level path.
- **Automated:** No

### IMP-078 - Whitespace-only / no-transaction file surfaces a clear parse error
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** A non-empty file containing only blank lines, or a CSV with no parseable date/amount rows.
- **Steps:**
  1. Upload and review.
- **Expected:** A **422** (`StatementParseException`) whose message the `ErrorBanner` shows: generic → "The CSV file is empty." (no lines) or "No transactions were found — check that the date and amount columns are mapped correctly." (lines but nothing parses); HSBC → "No transactions were found — is this an HSBC transaction-history CSV (Date, Details, Amount)?"; CAMT → "No usable transactions were found in this statement." A whitespace-only content may instead hit the 400 "The statement file is empty." content rule.
- **Automated:** Yes (GenericCsvImporterTests.cs — "Parse_throws_when_nothing_usable_is_found"; HsbcCsvStatementParserTests.cs — "Parse_EmptyContent_Throws"/"Parse_NoBookableRows_Throws"; ImportPage.test.tsx — "shows the server error message when the preview fails")

### IMP-079 - Malformed CAMT XML reports an XML error, not a crash
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** A `.xml` upload that is not well-formed, or valid XML that isn't a statement.
- **Steps:**
  1. Upload as "CAMT.053 statement (XML)".
- **Expected:** Not-well-formed → **422** "The statement is not valid XML."; well-formed but no `<Stmt>` → "No <Stmt> element found — is this a CAMT.053 statement?"; empty root → "The statement document is empty." One malformed `<Ntry>` inside an otherwise-valid statement is dropped, not fatal (undateable / zero / missing-currency / missing-direction entries are skipped).
- **Automated:** Yes (Camt053StatementParserTests.cs — "Parse_MalformedXml_Throws", "Parse_NonStatementXml_Throws")

### IMP-080 - Oversized file (>10 MB) is rejected by the request-size limit
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** A statement file larger than 10 MB.
- **Steps:**
  1. `POST /import/preview` with the large file.
- **Expected:** **413 Payload Too Large** — the preview endpoint carries `[RequestSizeLimit(10 * 1024 * 1024)]`. (`/commit` has no explicit override; a pathologically huge JSON body falls back to the default limit.) HSBC `CanParse` samples only the first 50 data rows, so sniffing a large-but-in-limit file is cheap.
- **Automated:** No

### IMP-081 - Invalid column-mapping JSON is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Direct `POST /import/preview` with a non-JSON `mapping` form field.
- **Steps:**
  1. Submit `mapping = "not-json"`.
- **Expected:** **400** `{ "error": "The column mapping was not valid." }` (controller catches `JsonException`). The SPA always serialises a valid `CsvMapping`, so this is an API-level guard.
- **Automated:** No

### IMP-082 - All-caught-up card offers a clean restart
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A preview that returns zero new rows.
- **Steps:**
  1. Reach the "You're all caught up" card.
- **Expected:** Heading "You're all caught up", body "Every transaction in this file is already in AllotJar — all N were skipped as duplicates. Nothing new to import.", an "Import another file" button (`reset` → upload), and a "View transactions →" link to `/transactions`. No review list or commit button. (With no duplicates counted, the body ends "…already in AllotJar. Nothing new to import.")
- **Automated:** Yes (ImportPage.test.tsx — "shows an all-caught-up message when every row was already imported")

### IMP-083 - "Choose a different file" / "Import another file" fully resets state
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** In review or done phase.
- **Steps:**
  1. Click the file strip's ✕ "Choose a different file" (review) or "Import another file" (done).
- **Expected:** `reset()` clears file, preview, rows, layout, mapping, scannedMapping, result, error, and bulk selections and returns to `upload`. Any prior categorisation is discarded; the format select retains its value but the file input is empty.
- **Automated:** Partial (import.spec.ts clicks "Import another file" between imports)

## Direct one-shot endpoints (retired)

W07 removed `POST /import/hsbc-csv` and `POST /import/camt053` together with `ImportStatementCommand`/Handler/Validator. Imports go only through preview then commit. IDs are kept so references stay stable; parser behaviour formerly reached through these cases is covered by IMP-014/015/035/036/037/088 and the parser tests.

### IMP-084 - Retired (W07: endpoint removed) - Direct HSBC CSV endpoint imports and dedups in one shot
- **Priority:** P3 (retired)
- **Type:** Negative
- **Preconditions:** Authenticated owner.
- **Steps:**
  1. `POST /import/hsbc-csv` with an HSBC file.
- **Expected:** Retired (W07: endpoint removed). The route no longer exists (404/405); nothing is imported. HSBC files import via preview then commit (IMP-014, IMP-056, IMP-057).
- **Automated:** No

### IMP-085 - Retired (W07: endpoint removed) - Direct CAMT endpoint maps entries and stays idempotent
- **Priority:** P3 (retired)
- **Type:** Negative
- **Preconditions:** Authenticated owner.
- **Steps:**
  1. `POST /import/camt053` with a CAMT.053 file.
- **Expected:** Retired (W07: endpoint removed). CAMT entry mapping (debit → creditor payee, credit → debtor payee, `EndToEndId` fallback, foreign currency kept) is still covered at parser level and through preview.
- **Automated:** Yes (Camt053StatementParserTests.cs — "Parse_ReadsAccountAndAllEntries", "…MapsDebitEntry", "…MapsCreditEntry_UsesDebtorAsPayee", "…FallsBackToEndToEndId_AndKeepsForeignCurrency")

### IMP-086 - Retired (W07: endpoint removed) - Direct endpoint rejects an account owned by another household
- **Priority:** P3 (retired)
- **Type:** Negative
- **Preconditions:** `accountId` belongs to a different owner.
- **Steps:**
  1. `POST /import/hsbc-csv` (or `/camt053`) with that `accountId`.
- **Expected:** Retired (W07: endpoint removed). Account ownership is still enforced on preview (unknown or foreign `accountId` → 404) and commit (IMP-072).
- **Automated:** No

### IMP-087 - Retired (W07: endpoint removed) - No-file guard on the direct endpoints
- **Priority:** P3 (retired)
- **Type:** Negative
- **Preconditions:** Authenticated owner.
- **Steps:**
  1. `POST /import/hsbc-csv` (or `/camt053`) with no file.
- **Expected:** Retired (W07: endpoint removed). The no-file guard now applies to preview only (IMP-012).
- **Automated:** No

## Reference edge cases & graceful degradation

### IMP-088 - CAMT entry with no reference (or `NOTPROVIDED`) is keyed by its content
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A CAMT.053 statement whose entry has no `AcctSvcrRef` and either no `EndToEndId` or the literal `EndToEndId = NOTPROVIDED`.
- **Steps:**
  1. Import the file, then import the identical file again.
- **Expected:** The parser gives the entry a content reference, `camt:<hash of date, signed amount, currency, payee and remittance text>#N` (N counts identical entries in the file, from 0), as the CSV parsers do (TX-P2-2, fix plan C, 1 Oct 2026). The second import skips it as already imported, like its referenced siblings. Rows imported before this change were stored with `BankReference = NULL` and are offered once more on the next import of the same statement, unticked by the possible-duplicate hint (IMP-059).
- **Automated:** Yes (IImportCoverageTests IMP-088a/b, TransferImportIdentityTests)

### IMP-089 - Reference-data fetch failures degrade gracefully, import still works
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner on `/import`; one or more of `GET /accounts`, `GET /budget/current`, `GET /members` transiently fails (500/network).
- **Steps:**
  1. Load `/import` while a reference call is failing; upload a generic CSV and reach review.
- **Expected:** Each failed call is swallowed to null (`Promise.all([... .catch(() => null)])`, `ImportPage.tsx:212-221`) and defaulted — accounts → `[]` (no account options, transfers impossible, only the strip's warn (i) about re-importing with an account), month → `null` (the Assign chip's picker offers only "Unassigned"; the bulk category action disabled), members → `[]` (no Member action in the rows' ⋯; the bulk member action disabled). No error banner, no crash: the upload → preview → commit flow still completes; the commit simply carries `accountId: null` and unassigned lines.
- **Automated:** No

## Gap-fill additions

### IMP-090 - Out-of-range statement format value hits parser-not-registered (404), never a 500
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Authenticated owner; `Features:CamtImport = true`. Call `POST /import/preview` directly — the SPA only ever sends one of the three valid formats (IMP-003), so this is an API-surface path.
- **Steps:**
  1. `POST /import/preview` multipart with a valid non-empty `file` and `format=99` — a numeric value outside `StatementFormat` (`Camt053 = 0`, `HsbcCsv = 1`, `GenericCsv = 2`).
  2. Repeat with `format=-1` (a negative out-of-range value).
- **Expected:** The form value model-binds to `(StatementFormat)99` / `(StatementFormat)-1` — enum binding converts a numeric form value even when it names no member, and `PreviewImportCommandValidator` does not apply `IsInEnum` (it only asserts `Content` `NotEmpty`). This is asymmetric with `CreateJarCommandValidator` (`Kind`/`Accrual` `.IsInEnum()`) and `CreateAccountCommandValidator` (`Type` `.IsInEnum()`), which reject an out-of-range enum with **400** "Validation failed". Because `99 != GenericCsv`, `PreviewImportCommandHandler` takes the non-generic branch and `_parsers.FirstOrDefault(p => p.Format == request.Format)` matches no registered parser (only `Camt053` + `HsbcCsv` are registered as `IStatementParser`), so it throws `NotFoundException` (`PreviewImportCommandHandler.cs:77-78`) → **404** via `ExceptionHandlingMiddleware` with `title` = "No statement parser is registered for format '99'." (`'-1'` for the negative case); the client `ErrorBanner` would show that title. The negative and positive out-of-range values take the identical path. The point of the case: this unknown-format lookup must stay a **404** and never regress to a **500**. (Contrast: a non-numeric, non-name string such as `format=banana` fails model binding → automatic **400** ModelState.  `/import/commit`'s `CommitImportCommand` carries no format at all, rebuilding rows from the already-parsed preview items.)
- **Automated:** No

### IMP-091 - A row in another currency is imported as it is and waits; nothing ever converts it
- **Priority:** P0
- **Type:** Regression
- **Origin:** W08 (rules 42–44) — imports used to convert at the ECB rate (`FxRateResolver`), count unresolved rows at face value, and re-convert them later (`FxReconciliationService`); all of that is deleted.
- **Preconditions:** Budget currency EUR (July 2026 month exists); a CAMT.053 statement with two EUR entries and one GBP entry "London Cab" 45.50; no import account; any rate provider state (up or down makes no difference).
- **Steps:**
  1. Import (preview → commit); note the result.
  2. Open `/transactions` and the dashboard.
  3. Re-import the same statement; wait past any interval, restart the API.
- **Expected:** Step 1: the GBP row is stored with `amount 45.50` (never multiplied by a rate), `currency GBP`, `fxPending true`; the EUR rows count normally; the result's `awaitingAmount` is **1** (the client doesn't display it today). Step 2: the row shows "GBP 45.50" + **"Needs EUR amount"** + **Enter amount**, and is left out of every figure; the dashboard notice reads "1 transaction in another currency is waiting for its amount in EUR and isn’t counted until it’s entered. Enter it on Transactions". Step 3: the row still waits — a re-import is not a retry and no background job exists. A row committed as a transfer is never marked waiting, whatever its currency (`ForeignAmounts.MarkWaiting`).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs — `An_imported_row_in_another_currency_waits_and_nothing_converts_it`, `A_transfer_never_waits`)

### IMP-092 - Before any budget month exists, the owner's chosen currency decides which rows wait (not EUR)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A brand-new household whose owner chose **GBP** at sign-up; no budget month, no accounts yet.
- **Steps:**
  1. Import the IMP-091 statement (two EUR entries, one GBP) with no import account.
- **Expected:** The **GBP** row counts (GBP is the budget currency) and the two **EUR** rows wait with "Needs GBP amount" — the old "default EUR when no month exists" rule is gone. Creating the first month afterwards stamps it GBP (`BudgetCurrency.ResolveAsync`), and the household's currency is now locked (it holds transactions).
- **Automated:** Yes (ForeignAmountsTests — `Without_a_budget_month_the_owners_currency_decides_what_waits_not_EUR`)

### IMP-093 - A statement imported onto a legacy account kept in another currency waits, and each row can be confirmed without touching the account's money
- **Priority:** P1
- **Type:** Regression
- **Origin:** W08 adversarial review — such rows used to wait with no way to confirm them (Enter amount refused any row on an account); Christopher's "Support them" (29 Sep 2026).
- **Preconditions:** Budget currency EUR; a legacy **GBP** account "UK card" (opening £500.00, created before rule 63); a CAMT.053 statement for it with two GBP entries (every row in the account's currency — a row in another currency than the import account's is refused, CMB-006).
- **Steps:**
  1. Import the statement into UK card (preview → commit with the account); note the result.
  2. Read UK card's balance and `/transactions`.
  3. **Enter amount** on the first row (e.g. 10.00) and confirm.
- **Expected:** Step 1: both rows are stored in GBP, `fxPending true`; `awaitingAmount` equals `imported` (2). Step 2: UK card's balance moves by the rows' pound amounts at once (balances sum `amount`, waiting or not); each row reads "GBP {amount}" + "Needs EUR amount" + **Enter amount**, and counts in no budget figure. Step 3: 200 with `budgetAmount 10.00`, `fxPending false`, the GBP `amount` and `currency` unchanged; the row now counts €10.00 and shows "Counts as €10.00"; UK card's balance does not move (TX-112, ACCT-042).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs — `A_statement_imported_onto_an_account_kept_in_another_currency_waits_and_can_be_confirmed`; the balance and register are covered by TX-112's tests)

## W07: reused references, transfer candidates, fees and same-day order

### IMP-096 - A known reference with different details is listed, flagged and unticked
- **Priority:** P0
- **Type:** Regression
- **Origin:** W07 / reused bank references (O1 answer 2)
- **Preconditions:** Import account "Joint" has an entry with reference `REF-1` (10 Jul, 40.00, debit). Upload a CAMT statement to "Joint" containing `REF-1` again as 20 Jul, 55.00, debit, plus an unchanged copy of the 10 Jul entry.
- **Steps:**
  1. Preview the file with "Joint" as the account.
  2. Tick the reused row and import; then preview and import the same file again.
- **Expected:** The unchanged copy is skipped as a duplicate, but the 20 Jul row is **listed** (not skipped) with `reusedReference` = the earlier entry's date, amount and direction, and is **unticked** by default. When imported it is stored under a derived reference `REF-1~{8 hex}`, not `REF-1`. The second run skips it (the derived reference is now known), so re-imports stay idempotent and the unique index is never hit.
- **Automated:** Partial (TransferIdentityW07Tests.cs; ImportPreviewCommitTests.cs)

### IMP-097 - A transfer recorded in the app is offered as a match and the bank's date wins
- **Priority:** P0
- **Type:** Happy
- **Origin:** W07 / candidates regardless of date and reference
- **Preconditions:** A transfer Savings → Joint of 100.00 recorded in the app (manual, or from allocation) dated 3 Jul with no bank reference, its Joint leg still open. Statement for "Joint" has a 100.00 credit on 9 Jul.
- **Steps:**
  1. Preview with "Joint" as the account.
  2. On the credit row, pick the Savings → Joint transfer as the match and import.
- **Expected:** The row carries `transferMatches` with `kind = "match"`, `recordedDate = 3 Jul`, no `fee`, even though the dates differ by six days (every open leg is offered, nearest date first). A single candidate is never auto-selected. On commit no new transaction is created: the transfer's Joint leg takes the bank's reference and the receipt date becomes **9 Jul** (the bank's date replaces the recorded one). `matchedTransfers = 1`.
- **Automated:** Partial (ImportTransferLegsTests.cs; TransferIdentityW07Tests.cs)

### IMP-098 - A credit on the source account can confirm a transfer came back (return candidate)
- **Priority:** P0
- **Type:** Happy
- **Origin:** W07 / returned transfers (O1 answer 4)
- **Preconditions:** A transfer Joint → Savings of 100.00 recorded and departed 3 Jul. Statement for "Joint" has a 100.00 credit on 12 Jul.
- **Steps:**
  1. Preview with "Joint" as the account.
  2. On the credit row, choose the transfer as **returned** (`returnOfTransferId`) and import.
- **Expected:** The credit row lists the transfer with `kind = "return"`. On commit the row confirms the return only: the transfer becomes status `Returned`, nothing stays in transit, no new income or transfer row is created. The result shows `returned = 1`.
- **Automated:** Partial (TransferIdentityW07Tests.cs)

### IMP-099 - A match that implies a fee requires the fee to be accepted with a line
- **Priority:** P1
- **Type:** Boundary
- **Origin:** W07 / transfer fees (O1 answer 5)
- **Preconditions:** Transfer Joint → Savings of 100.00 recorded. Statement for "Joint" has (a) a debit of 102.50; and, as a second run, a Savings statement with (b) a credit of 98.00 for the same transfer.
- **Steps:**
  1. Preview the Joint statement; pick the transfer as the match on the 102.50 debit.
  2. Try to import without accepting the fee, then accept it, pick a budget line for the fee and import.
  3. Repeat with the Savings credit of 98.00.
- **Expected:** (a) The candidate carries `fee = 2.50` (the debit is larger than the transfer). (b) The candidate carries `fee = 2.00` (the credit is smaller). In both cases the user must accept the fee explicitly (pick the candidate in the Transfer dialog's "Already recorded?" group) and pick its budget line there (**Fee category**; echoed on commit as `fee`, `feeBudgetItemId`; the server refuses a fee without a line, "Choose the budget line the transfer's fee is spent from."); a transfer that already has a fee pre-fills that fee's line. A match is never confirmed with a fee the user has not accepted, and a fee is only proposed while it is at most 10% of what arrives (no flat minimum, "10% only" of 30 September 2026): a 1,100.00 debit is offered as the 1,000.00 transfer with a fee of 100.00 (1,100.01 is not), and a 30.00 debit is not offered as a 20.00 transfer with a fee of 10.00; such a fixed charge is entered by hand on the transfer. Candidates stay nearest date first (rule 87); an exact amount only comes first between candidates on the same date. Once accepted, the transfer is confirmed and a separate fee expense row is created on the **source** account, dated the departure, on the chosen line.
- **Automated:** Partial (TransferIdentityW07Tests.cs, TransferIdentityW07ReviewTests.cs)

### IMP-100 - Same-day rows are judged on the day's closing balance, credits first
- **Priority:** P0
- **Type:** Regression
- **Origin:** W07 / rule 74
- **Preconditions:** "Joint" balance 10.00 before 15 Jul. Statement has, on 15 Jul, a debit of 50.00 listed **before** a credit of 100.00.
- **Steps:**
  1. Import both rows.
  2. Repeat with a debit of 50.00 on 15 Jul and a credit of 30.00 on 15 Jul (closing balance −10.00).
- **Expected:** First run: both import — the day's credits are applied first, so the balance never goes below zero on 15 Jul regardless of row order. Second run: the day closes below zero, so the debit is **held** (`held` lists the reference with the reason; nothing is posted "anyway"). Holds are judged per day on the closing balance, not per row.
- **Automated:** Partial (ImportHoldsTests.cs)

## Debit and credit columns, and column detection (27 October 2026)

### IMP-101 - A bank CSV with separate Debit and Credit columns imports money out and money in
- **Priority:** P1
- **Type:** Functional
- **Origin:** Christopher, 27 Oct 2026 (APS prints Debit and Credit apart)
- **Preconditions:** A CSV with a few lines above the table (bank name, account, period), then `Date,Value Date,Description,Debit,Credit,Balance`, with each row filling either Debit or Credit.
- **Steps:**
  1. Upload it as a Bank CSV and review.
  2. Open **Columns**.
- **Expected:** The rows import without touching the mapping: a Debit is money out, a Credit is money in, the date is the booking **Date** (not the Value Date), Description is the payee and Balance is never read. **Columns** shows **Amounts: Debit and credit** with the two columns chosen. Switching **Amounts** to **One column** shows the single **Amount column** instead; switching back starts from the amount column and the one after it. A minus sign printed in the Debit column does not turn the row into money in. A row re-imported later through a signed one-column export of the same statement gets the same reference and is skipped as already imported.
- **Automated:** Yes (GenericCsvColumnDetectionTests.cs, ImportPage.test.tsx)

### IMP-102 - Columns are found by the names banks use, not the first header containing a word
- **Priority:** P2
- **Type:** Functional
- **Origin:** Christopher, 27 Oct 2026 ("make a better job at identifying the columns")
- **Preconditions:** CSVs with headers such as `Value Date,Balance,Narrative,Transaction Amount`; `Posting Date;Transaction Description;Paid out;Paid in;Currency` with decimal commas; a header-less file with two number columns where each row fills one, beside a running balance.
- **Steps:** Upload each as a Bank CSV and open **Columns**.
- **Expected:** Headers match on whole words, best name first ("in" never matches "Description"; "Balance" and "Value date" are never the amount). A semicolon file with decimal commas is read as semicolon-separated. A file with only a value date uses it as the date. Without a header, the pair of number columns is read as debit (left) and credit (right), not the balance. Maltese headers (Data, Deskrizzjoni, Debitu, Kreditu, Bilanċ) are recognised.
- **Automated:** Yes (GenericCsvColumnDetectionTests.cs)

### IMP-103 - DR/CR markers, a direction column, and lines above the table
- **Priority:** P1
- **Type:** Functional
- **Origin:** #404 review round 1 (P1-1, P2-3, P2-4)
- **Preconditions:** CSVs with (a) `23.40 DR` / `2100.00 CR` in one Amount column; (b) `Amount` plus a `Dr/Cr` (or `Debit/Credit`, or `Transaction Type` of DEBIT/CREDIT) column; (c) Debit/Credit columns where Credit is empty for the first 31 rows, or empty throughout (a card statement); (d) Excel-padded preamble lines such as `Period,01/09/2026,30/09/2026,,,` above the header.
- **Steps:** Upload each as a Bank CSV; for (d) open **Columns** › **More options**.
- **Expected:** (a) DR rows are money out and CR rows money in. (b) **Direction column** under More options is detected and sets each row's direction. (c) The pair is kept and every purchase is money out. (d) The table starts at the real header (**Skip lines** shows how many lines are skipped and can be changed). A first transaction printed without its trailing empty fields is not skipped. Text with digits ("POS 4921 LIDL") is never taken for an amount.
- **Automated:** Yes (GenericCsvColumnDetectionTests.cs, ImportPage.test.tsx)
