# Subsystem map: Bank statement import

Ground-truth feature inventory for QA test design. All paths relative to repo root `<local>\Documents\Projects\ZeroBudget`. Verified against current code 2026-07-15; the client sections (§1 shell, §2, the client rows of §5–§6, §8) re-verified against the restyled page of 2026-10-12 (restyle PR 14, `client/src/pages/ImportPage.tsx`).

---

## 1. Screens & routes

| Surface | Path / condition | Notes |
|---|---|---|
| Import page (SPA) | `/import` | Registered only when `features.camtImport` is true (`client/src/App.tsx:161-170`), wrapped in `RequireAuth`. When the flag is off the route does not exist, so the `*` catch-all (`App.tsx:179`) redirects to `/`. |
| Entry point | "Import" item in the navigation (the sidebar; the phone's More sheet) | `client/src/components/navItems.ts` (`import` in `ALL`, listed by `useNavItems` only when `features.camtImport && canWrite`). Links to `/import`. The Transactions page has no Import link; its empty-state copy only names the page. |
| Page phases | `upload` → `review` → `done` (single page, internal state `Phase`) | Review has two sub-variants: an "all caught up" card when the preview yields 0 new rows, and the review list otherwise. After a commit that **held** rows (rule 74) the review stays up in held mode: only the held rows are listed, with the Held strip above them. |
| Role gate (client) | `canWrite` = role ≤ Admin (`client/src/auth/AuthContext.tsx:366`) | Page is still reachable by Limited/Read-only, but renders only an info card (see §5). Header/subtitle always render. |
| Role gate (server) | MediatR `AuthorizationBehaviour` (`src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`) | Both import requests (preview, commit) end in "Command" and carry no `[AllowLimited]`, so Limited and Read-only get **403** "Your access level ({role}) does not permit this action." — even for **preview**. Owner/Admin pass. |
| Feature gate (server) | `[FeatureGate(nameof(FeatureFlags.CamtImport))]` on the whole controller (`src/AllotJar.Api/Controllers/ImportController.cs:20`) | Flag off ⇒ **404** on every import endpoint (`src/AllotJar.Api/Features/FeatureGateAttribute.cs`). `CamtImport` defaults **true** (`src/AllotJar.Api/Features/FeatureFlags.cs:19`); despite the name it gates ALL import formats. Client default also true (`client/src/features/FeatureContext.tsx:13`). |
| Page shell | `AppShell active="import" title="Import transactions"` | The shell's h1 is the page title; there is no subtitle and no back link. The **page action** ("Import N transactions") is the shell's top-bar action on a wide screen (≥ 900 px) and a bar pinned above the tab bar (`[data-import-dock]`) on a phone/tablet — one primary button per screen. |

Page title: "Import transactions". The old subtitle is gone: "Re-importing the same file won't create duplicates." now closes the **About file formats** (i) on the upload card, and the duplicate rules sit behind the review list's **About skipped rows** (i).

---

## 2. Every UI control & user action (exact labels)

Restyle PR 14 (2026-10-12): the page follows the Transactions list style — a sage page, off-white cards, one primary green button per screen. Explanations sit behind (i) buttons (`InfoHint`: a tooltip on hover/focus, a popover on tap; Escape closes the hint alone), rarely used actions behind a row's ⋯ (`RowMenu`, a Radix menu on a wide screen; on a phone the row itself opens an `ActionSheet` named by the payee). Every editor that used to sit inline is a `Modal sheet` dialog: `role="dialog"` named by its title, a bottom sheet below 700 px, Escape closes it, focus goes to its Close button on open and back to the opener on close.

### Upload phase

One card (sr-only h2 "Upload a statement") in the wide column of the page grid (the right column stays empty, as on Dashboard).

- **Drop zone** (`[data-drop-zone]`): the **"Statement file"** file input (`#import-file`, `aria-label`, `accept` per format) covers the whole zone, so a click opens the chooser and a dropped file lands in it. Copy: "Choose a file" + "or drop it here" (the second line hidden on a phone); once chosen, the file's name + "Choose a different file". Changing the format clears the file AND remounts the input via `key={format}` so the browser forgets the stale filename.
- **"File format"** select (`#import-format`, a pill inside the zone; `<label for>` "File format"), options (`FORMATS`):
  - "Bank CSV (auto-detect)" (default; wire `GenericCsv`; accept `.csv,text/csv`)
  - "HSBC transaction history (CSV)" (wire `HsbcCsv`)
  - "CAMT.053 statement (XML)" (wire `Camt053`; accept `.xml,text/xml,application/xml`)
  - (i) **"About file formats"** beside it: the chosen format's hint ("Most banks' CSV export. Known formats (like the HSBC transaction history) are recognised automatically; otherwise you'll confirm which columns are the date, amount and description." / "The Date, Details, Amount export from HSBC personal banking." / "An ISO 20022 SEPA bank-to-customer statement.") followed by "Re-importing the same file won't create duplicates."
- **"Add to account"** select (`#import-account`, `<label for>`; the word "(optional)" is gone), default option "Don't link to an account", then every account from `GET /accounts`. (i) **"About the account"**: "Optional. Stamps each transaction onto this account so its balance reflects the import. Pick one to record transfers between your accounts." The account is applied only at **commit** (never sent to preview) — unchanged.
- **Submit**: "Review transactions" → busy "Reading…". Disabled while `!file || busy`.

### Review phase — the file strip (`section aria-label="Statement file"`)

- A file medallion (spreadsheet icon; code icon for CAMT), the file name, then "{Bank CSV | HSBC CSV | CAMT.053} · {account}".
- Sniff notice (generic uploads routed to a dedicated parser) is the (i) **"About the format"** after the format word: "We recognised this file as an HSBC transaction history export / a CAMT.053 statement and read it with the dedicated importer, so payees and duplicate detection stay consistent." (shown only when `format === 'generic'` and `detectedFormat` ∈ {HsbcCsv, Camt053}).
- The account: its type glyph + name, with the sr-only sentence **"Importing into {account name}."** (what the journeys read). When the account holds jars, (i) **"About {account}"**: "{account} holds jars: say which jars incoming money goes into and which jar a payment comes from. Leave them as they are to keep the money unallocated."
- No account: "No account", and when some rows look like transfers a warn-coloured (i) **"About the account"**: "Some rows look like transfers between your accounts. Re-import with an account selected to record them as transfers."
- **"Columns"** button (generic CSV with a server `layout` only; the label is sr-only on a phone, the icon stays; hidden in held mode) → the Columns dialog (below).
- **"Choose a different file"** (an `aria-label`led ✕ button) → full reset to the upload phase.

### Review phase — the Held strip (`[data-strip="held"]`, after a commit held rows)

`role="status"` sentence "{n} row(s) was/were held because the account would go below zero on its/their date." + (i) **"About the held rows"**: "Record the missing money first and commit again, or untick a row to discard it." then "The rest went in: {imported} transaction(s) imported[, {skipped} skipped][, {transfers} transfer(s)]."

### Review phase — the list card (`section aria-label="Transactions to import"`)

sr-only h2 **"{newCount} new transaction(s) to review"** (held mode: "Held rows"). The whole list is a `fieldset` disabled while a request is out.

- **The bar**: the **"Include all rows"** checkbox (reads mixed/indeterminate while only some rows are ticked; rows reusing a known bank reference are left to the user unless they are all there is); a chip **"{skippedDuplicates} already imported"** (or, with nothing skipped, "{n} unticked") + (i) **"About skipped rows"**: "Rows already imported are skipped, so re-importing a file never duplicates them. A possible duplicate (an existing transaction with the same amount and a similar payee within a few days) starts unticked: tick it to import it anyway." followed, when any row is flagged, by "{n} possible duplicate(s) unticked[ and {m} reusing a known bank reference unticked] (tick to include)."; and the bar's ⋯ **"Bulk actions"** menu → "Member for included rows" (disabled with no members) / "Category for included expenses" (disabled with no expense groups), each opening a dialog (below).
- **Per row** (`<li data-import-row={key}>`, inner `[data-testid="import-row"]`; an unticked row's text mutes):
  - Include checkbox, aria **"Include {payee} on {date}"** (`.im-check`: a 20 px box in a 30 px label whose 40 px hit target sits *behind* the box, so a pointer click lands on the input).
  - The payee. On a phone it is a button (`[data-row-trigger]`) that opens the row's bottom sheet (named by the payee, described by the date) holding the same actions as the ⋯.
  - **Flags** (chips) beside the payee: **"Held"** (bad) + (i) "Why {payee} was held" (the server's reason); **"Possible duplicate"** (warn); **"Same reference"** (warn) + (i) "About the bank reference of {payee}" ("An entry with this bank reference was already imported: {date} ±{money}. Tick it only if this is a different payment."); **"Looks like a transfer"**; **"Looks like a transfer coming back"** (a credit with a `return` candidate).
  - **The category cell**, three modes:
    - Plain: an `AssignChip` reading the line's name (hued like Transactions; a jar icon for a jar line) or **"Assign"** — aria **"Reassign {payee} on {date}"** / **"Assign {payee} on {date}"**, disabled while the row is unticked. Clicking it reveals the picker, a `<select aria-label="Category for {payee} on {date}">` (first option "Unassigned"; income rows get Income groups, debits Expense+Savings groups via `buildItemOptions`) that closes on a pick, on Escape or on blur, focus returning to the chip. It is a `CommitSelect` (#350 P3-1): the arrow keys move through the options without choosing, and Enter, blur or a pointer choice commits the option it rests on (Escape keeps the old one).
    - Transfer: a button (aria **"Edit transfer for {payee} on {date}"**) opening the Transfer dialog: the **"Transfer"** chip (wide screens only; the icon alone on a phone; bad-toned while no counterparty or match is chosen) + "to/from {account}" / "coming back" / "Choose account…". Beside it either the **"Already recorded?"** chip-button (candidates offered, none chosen; opens the same dialog) or, for a credit with no match, the **"Pending review"** chip + (i) "About pending review" ("Held for review until the departure date is known; nothing is posted to either account yet.").
    - Split: a chip-button (aria **"Edit split for {payee} on {date}"**; bad-toned while the split is invalid) reading the slices "{Line} {€X} · {Line} {€Y}" (`formatMoneyShort`: whole amounts drop their decimals; sr-only prefix "Split: "), opening the Split dialog.
  - **"From {jar}"** chip (a debit paying from a jar) and the **member** chip (a plain row's member), then the date (`shortDate`, e.g. "9 Oct"; a transfer's date follows "·" on a phone's second line).
  - Amount: `+`/`−` (U+2212) + `formatMoney` in the row's currency; credits in the ok green, transfers and unticked rows muted. A transfer with a valid fee shows "+ fee {money}" under it (hidden while the typed fee is invalid). A credit into a jar-backed account shows the **"Into jars"** / **"{€X} into jars"** toggle under the amount (`aria-expanded`, `aria-controls`) which turns bad-toned, with the reason as its `title`, while the amounts exceed the credit or have too many decimals, open or folded; it opens the `JarAllocationFields` panel under the row ("Put into jars in {account}", two columns, the dialog look; for a transfer not yet matched the hint "These jar amounts apply once the transfer's departure is confirmed."; `role="alert"` "{TOO_MANY_DECIMALS}" when an amount has too many decimals).
  - The row's ⋯ (`RowMenu`, aria **"{payee} on {date}: more actions"**, shown on hover/focus on a wide screen): plain row → **"Split"** (aria "Split {payee} on {date}"), **"Mark as transfer"** (aria "Mark {payee} on {date} as a transfer"; only when `canTransfer` = an import account is selected AND at least one other account exists), **"Member"** (aria "Member for {payee} on {date}"; only when the household has members), **"From jar…"** (aria "From jar for {payee} on {date}"; a debit on a non-jar line into a jar-backed account). Transfer row → **"Edit transfer"** / **"Undo transfer"** (aria "Undo transfer for {payee} on {date}"). Split row → **"Edit split"** / **"Clear split"**. Split, Mark as transfer and Member are disabled while the row is unticked. Items marked `after: 'dialog'` move focus to the trigger before opening their dialog, so closing the dialog lands back on the ⋯.
- Blocking note under the list: "Finish the highlighted rows first — splits must add up, transfers need an account, a fee needs a category, and jar amounts can't exceed what arrived." (any included row with an invalid split, a transfer without counterparty/match, a fee without a line, or jar amounts over the credit). Each such row is marked where the problem is: the split chip, the Transfer chip (also for a fee the row cannot carry or a fee without a line, the reason as the chip's `title`) or the "into jars" toggle turn bad-toned.
- **The page action** (top bar / dock): "Import {includedCount} transaction(s)" → busy "Importing…"; held mode: "Commit held rows" (or "Finish without the held rows" when every held row is unticked). Disabled while `busy || (includedCount === 0 && !heldMode) || reviewIncomplete || mappingDirty`. `onCommit` also independently guards `items.length === 0 || mappingDirty`.

### Review phase — the dialogs

Every one starts with the row summed up (`RowSummary`: the payee, "{date} · {account}", the amount) except Columns and the bulk dialogs.

- **"Transfer"** (⋯ → Mark as transfer / Edit transfer, the Transfer chip, the "Already recorded?" chip):
  - **"From"** (credit) / **"To"** (debit) select, aria **"Transfer account for {payee} on {date}"**: "Choose account…" + `otherAccounts`. Locked (disabled, a lock glyph) once a recorded transfer is chosen; when the chosen candidate's other side is private to another login it is named ("Private account"), never chosen. Absent for a return.
  - **"Already recorded?"** — a radio group, `fieldset aria-label="Match recorded transfer for {payee} on {date}"` (only when the server offered `transferMatches`): "No — record it as a new transfer" first, then one radio per candidate in the server's order (`matchLabel`: "To/From {account} · {money} · left/received {date}[ · with a fee of {money}][ · same bank reference]"; a return candidate reads "Returned: transfer to {account} on {date}"). Under it the chip "Same bank reference" and/or "Recorded in the app on {date}; the bank's date will be used." when the chosen candidate says so.
  - **"Fee (optional)"** input (aria **"Fee for {payee} on {date}"**, `inputMode="decimal"`, placeholder 0.00) for an unmatched debit; errors "The fee must be more than zero and less than the row's amount." / `TOO_MANY_DECIMALS`. **"Fee category"** select (aria **"Fee category for {payee} on {date}"**, "Choose a line…" + expense groups, the candidate's line kept selectable) whenever a fee applies (typed, or the candidate's), with (i) **"About the fee"** ("A transfer of {money} plus a fee of {money}." / "Records a fee of {money}."); "Choose the fee's category." while missing.
  - The status line: match → "Confirms the other side of the recorded transfer — no second balance movement."; return → "Records the transfer to {account} as returned: the money is back in {account} and goes back to the jars it left from."; credit, no match → (warn) "Held for review until the departure date is known; nothing is posted to either account yet."; debit → "Recorded as departed on {date}; in transit until the receipt is confirmed."
  - Footer **"Done"** (the row keeps the transfer; Escape does the same).
- **"Split"** (⋯ → Split / Edit split, the split chip): per line a category select (aria **"Split line {i} category for {payee}"**, "Choose a line…"), an amount input (aria **"Split line {i} amount for {payee}"**, placeholder "0.00"), a member select (aria **"Split line {i} member for {payee}"**; only when the household has members) and, with more than two lines, **"Remove split line {i} for {payee}"**; **"+ Add line"**; the **"Remaining to allocate"** meter with "Fully allocated" / "{money} left" / "{money} over" (bad). Footer **"Clear split"** (reverts the row to plain) and **"Done"** (disabled until the split is valid). Starting a split seeds 2 lines: line 1 inherits the row's category+member with a blank amount, line 2 blank. Starting a transfer clears any split; a split is only offered on plain rows.
- **"Member"** (⋯ → Member): **"Whose spending"** select (aria **"Member for {payee} on {date}"**; "No member" + members); **"Done"**. The choice shows on the row as the member chip.
- **"From jar"** (⋯ → From jar…): the `PaidFromJarSelect` (dialog look; aria "From jar") + (i) **"About paying from a jar"** ("Which jar in {account} does this come from? Leave it unallocated to take the money from no jar."); **"Done"**. The choice shows on the row as the "From {jar}" chip.
- **"Columns"** (the strip's Columns button; generic CSV only — a generic upload sniffed as HSBC/CAMT gets **no** Columns button), with (i) **"About the column mapping"** ("We guessed how to read your file. If the rows look off, fix a column and re-scan. Rows that are the same before and after keep the categories you already gave them."):
  - **Sample table** (`<table>`, sr-only caption **"Sample of the uploaded file"**; scrolls sideways in its own box): up to 5 rows exactly as split server-side; headers are the CSV header names or "Column N"; numeric columns right-aligned.
  - sr-only **"We read your dates as {label}."** when a date format is pinned (the Date format select shows it on screen).
  - Selects (column options are the column names): **"Date column"**, **"Date format"** (19 options: "Auto-detect" + the 18 fixed formats mirroring the server list), **"Description column"**, **"Amount column"** (+ (i) **"About the amount column"**: "Signed: money out is negative.").
  - **"More options"** (a `<details>` fold): **"Currency column"** (first option "Use {fallbackCurrency} for every row" = no currency column; `fallbackCurrency` = the import account's currency, else the household's `budgetCurrency`), **"Number format"** ("Auto-detect" / "1,234.56" / "1.234,56"), **"Column separator"** ("Comma ," / "Semicolon ;" / "Tab" / "Pipe |"), **"First row is a header"** checkbox.
  - Footer: the dirty note "You've changed the column mapping. Re-scan to apply it before importing." (while `mappingDirty`), a `role="alert"` line with a failed re-scan's message, **"Cancel"** (drops the unapplied changes — Escape and the Close button do the same; focus returns to the Columns button) and the re-scan button: clean "Re-scan", dirty "Apply changes & re-scan", busy "Re-scanning…". A successful re-scan closes the dialog.
- **"Member for included rows"** / **"Category for included expenses"** (the bar's Bulk actions): a **"Member"** select (aria "Bulk member": "No member" + members) or a **"Category"** select (aria "Bulk category": "Unassigned" + expense/savings groups), the (i) **"About the bulk member"** ("Sets whose spending every ticked row is. Split rows and transfers keep their own answers.") / **"About the bulk category"** ("Puts every ticked expense on this line. Money in, split rows and transfers keep their own lines."); footer **"Cancel"** (applies nothing) and **"Apply to included"** / **"Apply to expenses"** (disabled with nothing to choose from). Member applies to included, non-split, non-transfer rows; category to included, non-split, non-transfer **debit** rows — unchanged.
- **"Budget to a different month?"** (on Import, when a categorised row is dated outside the loaded budget month, or when the server answers with the cross-month error): "{n} transaction(s) is/are dated outside {Month YYYY} but assigned to its budget lines. Importing will count it/them toward {Month YYYY}'s budget rather than the month it was/they were spent." (or the server's sentence + "Importing will count it toward that line's month rather than the month it was spent."); **"Go back"** / **"Import anyway"**.

### "You're all caught up" card (review phase, 0 new rows)

A check medallion, heading "You're all caught up"; body "Every transaction in this file is already in AllotJar — all {skippedDuplicates} were skipped as duplicates. Nothing new to import." (the "— all N were skipped" clause only when skipped > 0). Link "View transactions →" (`/transactions`) and the primary "Import another file" (reset).

### Done phase

`section aria-labelledby` the h2 **"Import complete"** (a check medallion). sr-only sentence "{imported} transaction(s) added[, {skipped} skipped]." (what the journeys read). A `<dl>` of stats (`Stat`): **Imported**, **Skipped** (only above 0), **Money in** (ok green), **Money out** (client-side sums, see §6), **Transfers**, and only above 0: **Matched**, **Pending review**, **Returned**, **Held** (rows held at any point of this review), **"Waiting for {budget currency} amount"** with (i) **"About the rows waiting for an amount"** ("{n} row(s) is/are in another currency and is/are not counted anywhere until its/their amount in {CUR} is entered on Transactions."). One review can take several commits (held rows); the figures add them up. Primary "Import another file".

### Error surface

- `ErrorBanner` at the top for a failed preview or commit; message = ProblemDetails `title` ?? 400-body `error` ?? "Something went wrong. Please check the file and try again." A failed **re-scan** is told inside the Columns dialog (its `role="alert"` footer line), which stays open.
- A commit that held rows is not an error: the Held strip + held mode (above).

### Analytics

- `import_previewed` on successful preview and `import_committed` on successful commit, each with a bucketed row count only (event names `client/src/analytics/events.ts`; `import_started` exists in the catalog but is not emitted by ImportPage). Unchanged.

### Request parity

The restyle changed no request: the preview form (`file`, `format`, `mapping`, `defaultCurrency`, `accountId`) and every commit item (key order `reference, date, payee, amount, currency, isCredit`, then `jarAnswer`, then the kind's keys) are byte-for-byte what the previous page sent for the same choices — pinned by `client/src/pages/ImportPage.requests.test.tsx` (a Bank CSV, an HSBC file, a CAMT.053 file with jars, a split row, a transfer matched to a recorded one, a new transfer with a fee, a return, an unticked duplicate).

---

## 3. API endpoints

All on `ImportController` (`src/AllotJar.Api/Controllers/ImportController.cs`): route prefix `api/Import`, `[Authorize]` (valid JWT), `[FeatureGate(CamtImport)]` (404 when flag off). Role enforcement happens in the MediatR pipeline (Admin+ for both; 403 otherwise — see §1).

| Verb+Route | Body | Used by UI? | Behaviour |
|---|---|---|---|
| `POST /api/import/preview` | multipart: `file`, form `format` (`Camt053`/`HsbcCsv`/`GenericCsv`), form `mapping?` (JSON string of `CsvMapping`, camelCase accepted), form `defaultCurrency?`, form `accountId?` (the statement account) | **Yes** (`previewImport`, `client/src/lib/api.ts:171-184`) | Read-only. Parses, drops references the statement account already knows (a known reference whose date/amount/direction differ is listed, not dropped: see `reusedReference`), computes possible-duplicate hints + category suggestions + transfer match candidates. Returns `ImportPreviewResult`. 10 MB cap. The only way to read a statement: the old direct one-shot `/camt053` and `/hsbc-csv` endpoints were removed in W07. |
| `POST /api/import/commit` | JSON `CommitImportCommand { accountId?: Guid, items: CommitImportItem[] }` | **Yes** (`commitImport`, `api.ts:187-193`) | Persists reviewed rows; idempotent by `BankReference`; validates ownership of accountId, every budgetItemId/memberId (incl. split slices) and transferAccountId; unique-index race recovery (§6/§7). Returns `ImportStatementResult`. No explicit size limit attribute. |

Wire DTOs: `ImportPreviewResult` / `ImportCandidate` (`src/AllotJar.Application/Imports/Models/ImportPreview.cs`), `CommitImportItem` / `CommitImportSplit` (`.../CommitImport/CommitImportCommand.cs`), `ImportStatementResult` / `ImportHeldRow` (`src/AllotJar.Application/Imports/Models/ImportResult.cs` — `totalEntries, imported, skippedDuplicates, credits, debits, autoCategorized, transfers, matchedTransfers, pendingReviewTransfers, held, returned`; `returned` = rows that confirmed a transfer coming back to its source). Commit always returns `AutoCategorized: 0`.

W07 additions to the DTOs:

- **Preview candidate** (`ImportCandidate`): `transferMatches[]` — every recorded transfer whose leg on the statement account is still open, regardless of date, nearest date first, including transfers recorded in the app (manual or allocation) with no bank reference. Each carries `kind` (`match` or `return`), `fee` (a fee the match implies: the debit is larger than the transfer, or the credit smaller), `recordedDate` (the date recorded in the app, which the bank's date replaces) and `sameReference`. `reusedReference` (`{date, amount, isCredit}` of the earlier entry) is set when the bank reference is already known on this account but the date/amount/direction differ; such a row is unticked by default and stored under a derived reference `{ref}~{8 hex}` so a re-import stays idempotent.
- **Commit item** (`CommitImportItem`): `fee`, `feeBudgetItemId` (the line for the fee) and `returnOfTransferId` (the transfer a credit on its source account sends back), alongside the existing `matchTransferId`.
- **Same-day rows** are judged on the day's closing balance, credits first (rule 74), so a same-day deposit covers a same-day debit.

---

## 4. Validation rules & exact error messages

### Server — controller level (HTTP 400, `{ error: ... }`)

- "No file was uploaded." — null/empty file on preview.
- "The column mapping was not valid." — `mapping` form field fails JSON deserialization (`ImportController.cs:117`).

### Server — FluentValidation (HTTP 400 via `ExceptionHandlingMiddleware`, body `{status, title: "Validation failed", errors: {...}}`)

- `PreviewImportCommandValidator`: Content NotEmpty — "The statement file is empty."
- `CommitImportCommandValidator` (`.../CommitImport/CommitImportCommandValidator.cs`):
  - `Items` NotNull.
  - Per item: Amount > 0 — "Every imported amount must be greater than zero."; Currency NotEmpty + Length(3) — "Currency must be a 3-letter ISO code."; Payee MaxLength 200.
  - Splits (when present): ≥2 slices — "A split needs at least two lines."; exact-sum — "Split lines must add up to the transaction amount."; per slice: BudgetItemId NotEmpty — "Choose a budget line for every split line."; Amount > 0 — "Each split line needs an amount greater than zero."
  - Transfer+split mutually exclusive — "A transfer can't also be split."
  - Command-level: transfers require an account — "Choose the account this import belongs to before marking rows as transfers."

### Server — handler-thrown (via middleware, `src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs`)

- `StatementParseException` → **422** `{status, title}`:
  - Generic CSV: "The CSV file is empty." / "No transactions were found — check that the date and amount columns are mapped correctly." (`GenericCsvImporter.cs:46,134`)
  - HSBC: "The CSV file is empty." / "No transactions were found — is this an HSBC transaction-history CSV (Date, Details, Amount)?" (`HsbcCsvStatementParser.cs:88,163`)
  - CAMT: "The statement is not valid XML." / "The statement document is empty." / "No &lt;Stmt&gt; element found — is this a CAMT.053 statement?" / "No usable transactions were found in this statement." (`Camt053StatementParser.cs:49,53,56,99`)
- `ValidationException` from CommitImport handler → **400** "Validation failed" with errors:
  - `AccountId`: "Choose the account this import belongs to before marking rows as transfers." (duplicated defense at `CommitImportCommandHandler.cs:50-56`)
  - `Items`: "The transfer '{payee}' must move to a different account from the one being imported." (`CommitImportCommandHandler.cs:82-89`)
  - `Items`: "The split lines for '{payee}' must add up to {amount:0.####}; they add up to {allocated:0.####}." (`CommitImportCommandHandler.cs:136-145`)
- `NotFoundException` → **404**: "Account {id} was not found."; "No statement parser is registered for format '{format}'."
- `ForbiddenAccessException` → **403**: empty-message for foreign account/budget-item/member ownership violations; "No authenticated user on the request."; role failure "Your access level ({role}) does not permit this action."
- Unhandled → **500** "An unexpected error occurred."

### Client-side gates (no messages beyond those quoted in §2)

- Preview submit requires a file. Commit requires ≥1 included row, no invalid split, no transfer missing a counterparty, and a clean (non-dirty) mapping.
- Split validity (`splitInfo`): ≥2 lines, every line has a category and a parseable amount > 0 (`parseMinor`), and remaining-to-allocate exactly 0 minor units.
- Mapping dirty = deep JSON inequality between the editable `mapping` and the `scannedMapping` that produced the current rows.

---

## 5. State variants

- **Feature flag off** (`Features:CamtImport=false` in config): SPA route unregistered → `/import` redirects to `/`; Transactions-page Import button hidden; all 4 endpoints 404.
- **Role variants**: Read-only/Limited — client shows one card (`section aria-label="Import"`): "Importing statements is available to admins and the household owner. You can still add transactions by hand on the Transactions page." ("Transactions" a link); server 403s even preview. Admin/Owner — full flow. Role is resolved per request from the **active household** membership (`src/AllotJar.Api/Middleware/HouseholdResolutionMiddleware.cs`), so imports land in the active household's OwnerId, not necessarily the login's own.
- **Reference-data fetch failures**: `/accounts`, `/budget/current`, `/members` are fetched in parallel and each failure is swallowed to null — page still works: no accounts ⇒ no account select options + transfers impossible; no month ⇒ the Assign chip's picker offers only "Unassigned"; no members ⇒ no Member action in the rows' ⋯ and the bulk member action disabled.
- **Solo vs shared household**: no `isShared` gating on this page; the Member action and the split lines' member selects render whenever the household has members (members are budget "people", min 1 via OwnerMemberSeeder). Household-size only affects the member option lists.
- **Loading**: buttons swap to "Reading…" / "Re-scanning…" / "Importing…"; the review list is a `fieldset` disabled while a request is out; no skeletons.
- **Empty/duplicate file**: preview with 0 new rows → "You're all caught up" card (never an empty grid).
- **Possible duplicates**: arrive unticked with the warn chip "Possible duplicate" beside the payee (a known-reference repeat: "Same reference" + its (i)); the bar's chip counts them and its (i) explains; user opt-in per row or via "Include all rows".
- **Generic upload sniffed as HSBC/CAMT**: no Columns button; the sniff notice sits behind the strip's "About the format" (i); `detectedFormat` ≠ GenericCsv. Once a user-confirmed `mapping` accompanies the preview request the sniff is **skipped** (stays generic, `PreviewImportCommandHandler.cs:49-74`).
- **No account selected**: transfers cannot be marked ("Mark as transfer" absent from the rows' ⋯); likely-transfer rows keep their "Looks like a transfer" chip and the strip's warn (i) "About the account" advises re-importing with an account.
- **Only one account exists**: `canTransfer` false (needs an *other* account).
- **Mixed-currency file**: rows keep their own currency; success sums are grouped per currency and joined with " + "; the done card counts the rows waiting for their budget-currency amount.
- **Dirty mapping**: Import disabled; the Columns dialog's footer carries the warning and its re-scan button reads "Apply changes & re-scan"; Cancel/Escape drops the change and Import unblocks.
- **Re-scan**: per-row include/category/member/split/transfer/jar choices carried forward for rows whose `reference` is unchanged; changed rows arrive fresh (`applyPreview` prior-map).
- **Archived/deleted referents**: accounts have no archived state (nothing filtered in the accounts query); category options come from the **current month** only — a suggestion pointing at a line not in the current month falls back to name-match then "Unassigned" (`resolveSuggestion`). Server-side, commit re-validates every referenced id against the owner and 403s on any mismatch (deleted ⇒ not found ⇒ 403 for items/members, 404 for the account).
- **Concurrent commit** (double-click, second device, second household login): unique index + recovery — the losing rows flip from imported to skipped, remainder saves; response counts reflect the post-recovery truth (`CommitImportCommandHandler.cs:168-219`).
- **Session expiry mid-flow**: standard 401→silent-refresh interceptor path; review state is client-memory only — a hard reload loses the parsed preview (no persistence).
- **Phone (< 700 px)**: the rows' actions are a bottom sheet opened by tapping the payee; the Transfer chip gives way to its icon; the page action sits in the dock above the tab bar; every dialog is a bottom sheet. Tablet (700–899 px): the ⋯ menus, the dock.

---

## 6. Computed/derived values & money rules

### Client money handling

- Minor units factor **10_000** (4 dp, matching server decimal(18,4)) — `client/src/lib/money.ts:14`. Wire amounts are decimal numbers; `fromAmount` = `Math.round(amount*10000)`, `toAmount` = `minor/10000`.
- **Success-card sums** (`moneyByCurrency`): over the committed rows kept in state, a row the server did not skip and `!isTransfer && isCredit` → Money in; `!isTransfer && !isCredit` → Money out; accumulated in minor units per currency; zero groups render as `formatMoney(0, budgetCurrency)`. These are **amounts**, not counts (PR #160 fix); the Transfers tile stays the server count. The row chips use `formatMoneyShort` (`client/src/lib/money.ts`: a whole amount drops its decimals, "€30"; one with cents keeps them) — display only, never sent.
- **Split remaining**: `remainingMinor = fromAmount(row.amount) − Σ parseMinor(line.amount)` (unparseable lines count 0); the "Remaining to allocate" meter clamped 0–100 %; over-allocation shows "X over" in the bad tone.
- Split slices are converted back to decimals with `toAmount(parseMinor(...))` before POST.

### Server-side derivations

- **BankReference composition (GOLDEN INVARIANT — never change; PR #154):**
  - HSBC (`HsbcCsvStatementParser.cs:145-150`): signature `"{postingDate:yyyy-MM-dd}|{purchaseDate:yyyy-MM-dd}|{last4}|{signedAmount:0.00}|{DESCRIPTION.ToUpperInvariant()}"` → `hsbc:{first-128-bits-SHA256-lowercase-hex}#{occurrenceIndex}`. Occurrence index counts identical signatures within one file (0-based) so N genuinely identical charges all import while re-imports no-op.
  - Generic CSV (`GenericCsvImporter.cs:117-129`): signature `"{date:yyyy-MM-dd}|{signed:0.####}|{RAW normalized description UPPER}"` → `csv:{hash}#{index}`. Signature uses the **raw** (whitespace-normalized) description cell; the display payee may be the HSBC-cleaned merchant (`TryCleanDetails`) but the reference never changes with it.
  - CAMT (`Camt053StatementParser.cs:144-180`): entry `AcctSvcrRef`, else any `EndToEndId`; none (or literal `NOTPROVIDED`) ⇒ content reference `camt:{32-hex SHA-256 of date|signed amount|currency|payee|remittance}#N`, N counting identical entries from 0 (TX-P2-2). References ≤140 chars stay **raw**; >140 fold to `prefix~{32-hex-SHA256-head}`. A repeat of a reference with other date/amount/direction keeps the raw reference and the preview and commit store it as `StatementReferences.Derive` (`ref~hash`), the same in every statement; only a repeat identical in those too gets a `#N` suffix (TX-P2-3). Rows stored before 1 Oct 2026 as `ref#N` (the old suffix for any repeat) are still recognised by `KnownReferences.Resolve`.
  - Golden tests pin exact strings: `tests/AllotJar.Application.Tests/Imports/HsbcCsvStatementParserTests.cs` (`Parse_References_AreStableAcrossReleases`) and `GenericCsvImporterTests.cs:196-197` (e.g. `csv:8babbc80a18fc258834cd1bbd3e3c7fb#0` / `#1`).
- **Dedup**: preview and commit both load the non-null BankReferences the statement account already knows and skip matches (Ordinal in-memory compare); a known reference whose date/amount/direction differ is no longer skipped but listed as a `reusedReference` row (unticked, stored under `{ref}~{8 hex}`). DB backstop: unique filtered index `(OwnerId, BankReference) WHERE [BankReference] IS NOT NULL` (`src/AllotJar.Infrastructure/Persistence/Configurations/TransactionConfiguration.cs:73-75`); column max length 140 (`:44-45`). The SQL index compares with the column's **case-insensitive** collation while the in-memory skip is Ordinal — the race-recovery path deliberately matches OrdinalIgnoreCase (`CommitImportCommandHandler.cs:190-193`).
- **Concurrent-commit race recovery** (`CommitImportCommandHandler.cs:168-219`): on `DbUpdateException` whose inner message contains `IX_Transactions_OwnerId_BankReference` (≤3 retries): re-read taken refs, remove collided Added entities, decrement imported/credit/debit/transfer counters, increment skipped, save remainder (or finish clean if everything collided). Non-matching DbUpdateException rethrows. Integration-tested only on real SQL Server (`tests/AllotJar.IntegrationTests/UniqueBankReferenceTests.cs` — deterministic race via a trap `IIdentityService` whose `GetPreferredCurrencyAsync` — read for the budget currency between the dedup snapshot and the save — inserts the rival row; W08 replaced the old trap rate provider); EF InMemory does not enforce unique indexes.
- **Preview counts** (`PreviewImportCommandHandler.cs:129-137`): `TotalEntries` = parsed rows; `NewCount` = after reference-dedup; `SkippedDuplicates` = total − new; `Credits`/`Debits` = direction counts of the NEW rows.
- **Possible-duplicate hint** (`PreviewImportCommandHandler.cs:19,147-204`): window **±4 days** (covers purchase-vs-posting drift without flagging weekly recurrences), same exact decimal Amount, direction compatible (existing Transfer matches either; Income⇔credit; else debit), currency equal (OrdinalIgnoreCase), payee match = normalized equality **or containment either way** (raw bank blob contains clean merchant). Hint only — UI unticks those rows.
- **Category suggestions**: `AutoCategorizer.BuildSuggestionsAsync` (`src/AllotJar.Application/Transactions/AutoCategorizer.cs:63-90`) — most recent categorized transaction per normalized payee (trim/lower/collapse whitespace) wins; preview returns id+name; commit path does **not** auto-categorize (user's explicit choices only).
- **Transfer heuristic** (`src/AllotJar.Application/Imports/TransferHeuristic.cs`): payee upper-contains any of "E-BANKING PAYMENT", "INTERNAL TRANSFER", "TRANSFER TO", "TRANSFER FROM", "OWN ACCOUNT".
- **Transaction creation on commit**: Amount = the echoed positive amount; Type = Income (credit) / Expense (debit) / Transfer; Payee truncated to 200; empty reference stored as NULL (exempt from index); split rows carry no whole-row BudgetItemId/MemberId (slices do); transfer direction: credit ⇒ counterparty→importAccount, debit ⇒ importAccount→counterparty (`CommitImportCommandHandler.cs:90-106`).
- **Foreign currency** (`src/AllotJar.Application/Transactions/ForeignAmounts.cs`, W08 — replaced the deleted `FxRateResolver`; the `FxReconciliationService` background job is deleted too): one budget currency per household (`BudgetCurrency.ResolveAsync`: earliest month's `BaseCurrency`, else owner's `PreferredCurrency`, else EUR — not per-month, not EUR when there's no month). A new non-transfer row whose currency ≠ budget currency is recorded **in its own currency** and marked `FxPending` ("Needs {X} amount"); it counts in no figure until the user confirms its budget-currency amount on Transactions (Enter amount). No rate is looked up during import, nothing reconciles later, re-importing doesn't convert. Transfers never wait. Both import results carry `AwaitingAmount` (count of new waiting rows); the client does not display it today. A row whose currency differs from the chosen import account is still rejected at commit (`Commit_RejectsARowWhoseCurrencyDiffersFromTheImportAccount`), so waiting rows come from account-less imports, or from an import onto a legacy account kept in another currency (every row of it waits; IMP-093). Enter amount on such an account row stores the confirmed figure as `Transaction.BudgetAmount` and leaves the row's amount — the account's money — as it is (`A_statement_imported_onto_an_account_kept_in_another_currency_waits_and_can_be_confirmed`).
- **Generic CSV parsing rules** (`src/AllotJar.Infrastructure/Statements/GenericCsvImporter.cs`):
  - Line splitting: strip leading BOM, split on `\n` AND `\r` (CRLF/LF/bare-CR), drop blank lines; RFC-4180 quoted-field splitter parameterized by delimiter (`""` escapes).
  - Detection: delimiter = candidate (`,` `;` tab `|`) with most hits in first 5 lines; header = first row has no date while a later row does; mapping guess = header-name hints first ("date/posted/booking", "amount/value", "currency/ccy", "description/payee/memo/details/narrative/reference/name"), else content scoring (date-parse fraction, signed-amount fraction, currency-regex ≥0.8, longest average text).
  - **One date format per file**: user-pinned `dateFormat`, else `ResolveDateFormat` picks the single format parsing the most rows (ties by preference order: ISO first, dd/MM before MM/dd; 2-digit-year formats listed after 4-digit peers — TryParseExact is length-strict so they can't steal). Applied format echoed as `ResolvedDateFormat` and pinned into `layout.suggested.dateFormat` by the preview handler (`PreviewImportCommandHandler.cs:65-72`).
  - Row skip rules: unparseable date ⇒ skip (header remnant/footer); unparseable or 0.00 amount ⇒ skip.
  - Amount parsing: accounting parentheses `(35.00)`; strip currency symbols/letters/spaces; leading OR **trailing** sign (`35.00-`); stray inner sign ⇒ reject; decimal style Dot / Comma / Auto (both separators: right-most is decimal; single separator: decimal only with 1–2 trailing digits, else grouping).
  - Currency: mapped column value if 3-letter alpha (uppercased), else `DefaultCurrency` (client sends the chosen import account's currency, else the household's `budgetCurrency` — W08; was `preferredCurrency`), else "EUR".
  - Payee display: `HsbcCsvStatementParser.TryCleanDetails` applied to HSBC-style packed cells; reference stays on the raw cell.
- **HSBC parsing rules** (`src/AllotJar.Infrastructure/Statements/HsbcCsvStatementParser.cs`):
  - Data row = ≥3 comma-split fields whose first is `dd/MM/yyyy`. Amount from column 3 **first** (invariant: preserves historical references); if unusable and >3 fields with a parseable last field ⇒ stitch middle fields back (unquoted merchant comma, e.g. "PAYPAL *TEMU, INC"); else the amount embedded in Details; else skip. 0.00 rows skipped.
  - Details regex extracts description, purchase date (dd/MM/yyyy), card last-4, currency; non-matching Details keep whole text + posting date + "EUR".
  - BookingDate on the entry = **purchase date** (fallback posting date). Quoted thousands fields handled by the RFC-4180 splitter.
  - Sniff (`CanParse`): first 50 data rows, requires **exactly 3 columns** and ≥80% Details-pattern match — a wider export embedding HSBC-like text falls to the generic mapper.
- **CAMT parsing rules**: local-name navigation (any camt.053.001.xx namespace); per-entry tolerance (bad entry dropped, never aborts the file); skips entries missing amount/currency/`CdtDbtInd` or a parseable `BookgDt`/`ValDt` (never fabricates dates); 0.00 skipped; payee = Dbtr name for credits / Cdtr for debits, fallback joined `Ustrd` remittance; the statement's own IBAN is not read (AllotJar keeps no bank details). Sniff: content starts with `<` (after BOM/whitespace) and contains "camt.053" (CI) or "BkToCstmrStmt".
- **Sniff routing order**: registration order Camt053 then HsbcCsv (`src/AllotJar.Infrastructure/DependencyInjection.cs:39-40`); `PreviewImportCommandHandler` tries `CanParse` in that order for a mapping-less GenericCsv upload.

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **BankReference composition is a golden invariant** (PR #154): the exact `hsbc:`/`csv:` signature fields, hash (SHA-256 first 128 bits, lowercase hex) and `#occurrence` suffix must NEVER change — production dedup bakes them in. Golden tests pin literal strings.
2. **Same file ⇒ same code path** (PR #154): a "generic" upload with no confirmed mapping is sniffed against dedicated parsers first, so HSBC files uploaded via the default dropdown option get `hsbc:` refs and clean payees, not `csv:` refs. Once the user confirms a mapping, sniffing is skipped forever for that flow. Regression risk: payee/date/reference drift between import paths re-duplicating statements.
3. **Unique filtered index + race recovery** (PR #159): `(OwnerId, BankReference)` unique where not null; concurrent commits recover by skipping collided rows (matched by index NAME in the exception message; recovery ref-match is OrdinalIgnoreCase to agree with the CI collation). Migration `20260707211100_UniqueOwnerBankReference` pre-deleted surplus dups. **Not enforceable/testable on EF InMemory** — only in `tests/AllotJar.IntegrationTests` (real SQL container).
4. **Mapping dirty-state blocks stale-parse import** (PR #160): editing any field of the Columns dialog disables Import, adds the warning to the dialog's footer and relabels its re-scan button "Apply changes & re-scan"; `onCommit` re-guards `mappingDirty` in case a future path bypasses the disabled button. Cancel/Escape on the dialog drops the edit (back to the scanned mapping). Test both the visible gate and the guard.
5. **Re-scan carry-over** (PR #160): per-row edits survive a re-scan only for rows whose reference is unchanged (reference encodes date+amount+description — a mapping change that alters any of these intentionally drops the row's edits).
6. **Success sums are money, not counts** (PR #160): "Money in/out" sum the reviewed included amounts in minor units grouped per currency; only "Transfers" is a count.
7. **Date-format pinning** (PR #159): auto-detection is file-relative (an overlapping re-export can resolve ambiguous dd/MM vs MM/dd differently), so the applied format is echoed, shown (the Columns dialog's Date format select, plus the sr-only "We read your dates as …") and pinned into the mapping for re-scans/re-imports. The client's `DATE_FORMAT_OPTIONS` must mirror the server's `DateFormats` list or a pinned format renders as a blank select.
8. **Parser tolerances** (PR #159): leading BOM stripped by all three parsers (incl. CAMT's non-whitespace U+FEFF before `<`); bare-CR line endings; trailing-sign amounts; parenthesized negatives; 2-digit-year formats appended AFTER 4-digit peers (length-strict, cannot flip an existing file's resolution); HSBC unquoted-comma merchant stitching only as a fallback after column 3; 0.00 rows skipped everywhere (zero amounts are rejected app-wide); CAMT repeated refs: identical repeats get `#N` occurrence suffixes (first stays raw), other repeats a derived reference; no fabricated booking dates.
9. **Possible-duplicate window is ±4 days by design** — wide enough for purchase-vs-posting drift, deliberately narrower than 7 so weekly recurring charges don't false-flag. Flagged rows are default-**unticked** and carry the warn "Possible duplicate" chip (an unticked row's text mutes to slate-500, which keeps AA contrast).
10. **Dark mode remaps the whole slate scale** in `client/src/index.css` — do NOT add `dark:` overrides raising slate numbers in the Columns dialog's sample table or the review rows (they invert to near-white; caught in PR #160 review). e2e mock gotcha: `client/e2e/mocks.ts importPreview()` must include `layout` + `sampleRows` or a11y CI never renders the Columns dialog (the a11y and responsive specs open it).
11. **Legacy reference schemes in prod**: `xlsx:MM:AccountName:rowid` rows exist from the one-off Excel seeder (since removed) and are invisible to `hsbc:`/`csv:` dedup — content-level possible-duplicate hints are the only guard against re-importing a seeded period (historical 39-pair overlap cleaned by hand; `docs/ops/import-duplicate-cleanup.sql`).
12. **Preview dedup**: the target account is chosen at upload; known-reference dedup, reused-reference detection and transfer match candidates are judged against that statement account, duplicate hints still run per-owner across all accounts. Changing the import account mid-review requires starting over (deferred I3 item).
13. **Accepted behaviour change** (PR #154): true-MM/dd generic files previously parsed per-row had wrong dates baked into refs; the per-file format lock makes those rows re-appear once on the next overlapping import.
14. **CAMT null references never dedup**: entries without AcctSvcrRef/EndToEndId (or `NOTPROVIDED`) get `Reference: null` ⇒ imported on every re-upload (preview keeps them as new each time). The `ImportCandidate.Reference` is coalesced to `""` for the wire and stored as NULL at commit.
15. **Amount sign convention**: `ParsedStatementEntry.Amount` and everything downstream is positive; direction lives in `IsCredit`. Client renders `−`/`+`; server validator rejects ≤0.
16. **Recent auth-adjacent changes (PRs #169/#171)** don't change import logic, but long review sessions now survive tab restores via the refresh grace window; a genuinely-dead session mid-review loses all client-side review state on the forced re-login.

---

## 8. File index (all read)

Server:
- `src/AllotJar.Api/Controllers/ImportController.cs`
- `src/AllotJar.Api/Features/FeatureFlags.cs`, `src/AllotJar.Api/Features/FeatureGateAttribute.cs`
- `src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs`
- `src/AllotJar.Api/Middleware/HouseholdResolutionMiddleware.cs`, `src/AllotJar.Api/Services/CurrentUser.cs`
- `src/AllotJar.Application/Imports/Commands/PreviewImport/{PreviewImportCommand,PreviewImportCommandHandler,PreviewImportCommandValidator}.cs`
- `src/AllotJar.Application/Imports/Commands/CommitImport/{CommitImportCommand,CommitImportCommandHandler,CommitImportCommandValidator}.cs`
- `src/AllotJar.Application/Imports/Models/{ImportPreview,ImportResult,CsvMapping,StatementFormat,ParsedStatement}.cs`
- `src/AllotJar.Application/Imports/TransferHeuristic.cs`
- `src/AllotJar.Application/Transactions/{AutoCategorizer,ForeignAmounts}.cs`, `src/AllotJar.Application/Budgets/BudgetCurrency.cs`
- `src/AllotJar.Application/Common/Interfaces/{IStatementParser,ICsvImporter}.cs`
- `src/AllotJar.Application/Common/Exceptions/StatementParseException.cs`
- `src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`
- `src/AllotJar.Infrastructure/Statements/{GenericCsvImporter,HsbcCsvStatementParser,Camt053StatementParser}.cs`
- `src/AllotJar.Infrastructure/Persistence/Configurations/TransactionConfiguration.cs` (BankReference 140 + unique filtered index)
- `src/AllotJar.Infrastructure/DependencyInjection.cs` (parser registration order)

Client:
- `client/src/pages/ImportPage.tsx` (whole page; restyle PR 14)
- Shared pieces the page composes: `client/src/components/{AppShell,Modal,InfoHint,StatusChip,RowActions}.tsx` (`RowMenu`/`ActionSheet`), `components/transactions/TxParts.tsx` (`AssignChip`, `TxTile`), `components/accounts/AccountParts.tsx` (`AccountTypeGlyph`), `components/jars/{JarAllocationFields,PaidFromJarSelect}.tsx` (`look="dialog"`, `columns`), `components/budget/card.ts` (`DASH_CARD`); `client/src/index.css` (`.im-check`, `.dlg-sel`, `.dlg-in`)
- `client/src/components/navItems.ts` (the Import nav item: `features.camtImport && canWrite`)
- `client/src/App.tsx` (route + flag gating)
- `client/src/lib/api.ts:151-193` (`previewImport`, `commitImport`)
- `client/src/lib/money.ts` (FACTOR/fromAmount/toAmount/parseMinor/sumMinor/formatMoney/formatMoneyShort)
- `client/src/lib/transactions.ts:16-41` (`buildItemOptions`)
- `client/src/types.ts:114-207` (import wire types)
- `client/src/auth/AuthContext.tsx` (canWrite/canEnterData), `client/src/features/FeatureContext.tsx` (camtImport default)
- `client/src/analytics/events.ts:36-39`

Tests (for invariants):
- `tests/AllotJar.Application.Tests/Imports/{HsbcCsvStatementParserTests,GenericCsvImporterTests,ImportPreviewCommitTests,ImportHoldsTests,ImportTransferLegsTests,TransferIdentityW07Tests}.cs`
- `tests/AllotJar.IntegrationTests/UniqueBankReferenceTests.cs` (index enforcement + deterministic race recovery)
- `tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs` (`An_imported_row_in_another_currency_waits_and_nothing_converts_it`, `Without_a_budget_month_the_owners_currency_decides_what_waits_not_EUR`, `A_transfer_never_waits`, `A_statement_imported_onto_an_account_kept_in_another_currency_waits_and_can_be_confirmed`)
- `client/src/pages/ImportPage.test.tsx` ("generic CSV: rows without a currency are read in the chosen import account’s currency"), `ImportPage.restyle.test.tsx` (the restyled surface: drop zone, ⋯ and sheets, dialogs, Columns, keyboard, done card), `ImportPage.requests.test.tsx` (request parity, see §2), `ImportPage.{jars,rowKeys,catalog,catalog.supplemental}.test.tsx`; shared helpers `client/src/test/importReview.ts`
- `client/e2e/a11y.spec.ts` (the review list, the Columns/Split/Transfer dialogs, the include box's real click), `client/e2e/responsive-dark.spec.ts` (UX-025 dark sample table, UX-033 phone list + sample table)
- `client/e2e-journey/{import,import-lifecycle,import-transfer-legs}.spec.ts` (the Columns dialog, the category chip, the Transfer dialog helpers)

Memory notes consulted (claims re-verified against code): `import-coherence-audit-2026-07.md`, `import-consistency-fix.md`.
