# Subsystem map: Bank statement import

Ground-truth feature inventory for QA test design. All paths relative to repo root `<local>\Documents\Projects\ZeroBudget`. Verified against current code 2026-07-15.

---

## 1. Screens & routes

| Surface | Path / condition | Notes |
|---|---|---|
| Import page (SPA) | `/import` | Registered only when `features.camtImport` is true (`client/src/App.tsx:161-170`), wrapped in `RequireAuth`. When the flag is off the route does not exist, so the `*` catch-all (`App.tsx:179`) redirects to `/`. |
| Entry point | "Import" button on the Transactions page | `client/src/pages/TransactionsPage.tsx:654-662` — rendered only when `features.camtImport && canWrite`. Links to `/import`. |
| Back link | "← Back to transactions" at the top of ImportPage | `client/src/pages/ImportPage.tsx:460-463`. |
| Page phases | `upload` → `review` → `done` (single page, internal state `Phase`, `ImportPage.tsx:26,185`) | Review has two sub-variants: an "all caught up" card when the preview yields 0 new rows, and the full review UI otherwise. |
| Role gate (client) | `canWrite` = role ≤ Admin (`client/src/auth/AuthContext.tsx:366`) | Page is still reachable by Limited/Read-only, but renders only an info card (see §5). Header/subtitle always render. |
| Role gate (server) | MediatR `AuthorizationBehaviour` (`src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`) | All three import requests end in "Command" and carry no `[AllowLimited]`, so Limited and Read-only get **403** "Your access level ({role}) does not permit this action." — even for **preview**. Owner/Admin pass. |
| Feature gate (server) | `[FeatureGate(nameof(FeatureFlags.CamtImport))]` on the whole controller (`src/AllotJar.Api/Controllers/ImportController.cs:20`) | Flag off ⇒ **404** on every import endpoint (`src/AllotJar.Api/Features/FeatureGateAttribute.cs`). `CamtImport` defaults **true** (`src/AllotJar.Api/Features/FeatureFlags.cs:19`); despite the name it gates ALL import formats. Client default also true (`client/src/features/FeatureContext.tsx:13`). |
| Page shell | `AppShell active="transactions" maxWidth="5xl"` (`ImportPage.tsx:458`) | Import lives under the Transactions nav item; there is no dedicated nav entry. |

Page title: "Import transactions"; subtitle: "Upload a bank export, review and categorise the new transactions, then import. Re-importing the same file won't create duplicates." (`ImportPage.tsx:464-467`).

---

## 2. Every UI control & user action (exact labels)

### Upload phase (`ImportPage.tsx:478-546`)

- **"File format"** select (`#import-format`), options (`ImportPage.tsx:28-47`):
  - "Bank CSV (auto-detect)" (default; wire `GenericCsv`; accept `.csv,text/csv`) — hint: "Most banks' CSV export. Known formats (like the HSBC transaction history) are recognised automatically; otherwise you'll confirm which columns are the date, amount and description."
  - "HSBC transaction history (CSV)" (wire `HsbcCsv`) — hint: "The Date, Details, Amount export from HSBC personal banking."
  - "CAMT.053 statement (XML)" (wire `Camt053`; accept `.xml,text/xml,application/xml`) — hint: "An ISO 20022 SEPA bank-to-customer statement."
  - Changing format clears the chosen file AND remounts the file input via `key={format}` so the browser clears the stale filename (`ImportPage.tsx:490-494,513`).
- **"Statement file"** file input (`#import-file`).
- **"Add to account (optional)"** select (`#import-account`), default option "Don't link to an account", then all accounts from `GET /accounts`. Hint: "Stamps each transaction onto this account so its balance reflects the import." Account is applied only at **commit** (never sent to preview).
- **Submit button**: "Review transactions" → busy "Reading…". Disabled while `!file || busy` (`ImportPage.tsx:540`).

### Review phase — summary strip (`ImportPage.tsx:573-606`)

- Line: "**{newCount}** new transaction(s) to review — {skippedDuplicates} already imported (skipped) — {n} possible duplicate(s) unticked (tick to include). Categorise them (split a row, or mark a transfer), untick any you don't want, then import."
- Possible-dup explainer: "A row is flagged as a possible duplicate when an existing transaction has the same amount and a similar payee within a few days — tick it to import anyway (e.g. two genuine identical purchases)."
- Sniff notice (generic uploads routed to a dedicated parser): "We recognised this file as an HSBC transaction history export / a CAMT.053 statement and read it with the dedicated importer, so payees and duplicate detection stay consistent." (labels at `ImportPage.tsx:50-53`; shown only when `format === 'generic'` and `detectedFormat` ∈ {HsbcCsv, Camt053}).
- Account readout: "Importing into **{account name}**."
- Amber warning when no account chosen but some rows look like transfers: "Some rows look like transfers between your accounts. Re-import with an account selected (on the previous step) to record them as transfers."

### Review phase — Column mapping card (generic CSV only; `ImportPage.tsx:609-792`)

Rendered only when `format === 'generic' && layout && mapping` (i.e. the server returned a `CsvLayout`; a generic upload sniffed as HSBC/CAMT gets **no** mapping card).

- Heading "Column mapping"; copy "We guessed how to read your file. If the preview below looks off, fix a column and re-scan." Plus, when a date format is pinned: "We read your dates as **{label}** — change the date format below if that's wrong."
- **Sample table**: up to 5 sample rows exactly as split server-side (`GenericCsvImporter.Detect` returns first 5 of the first 30 data rows, `GenericCsvImporter.cs:67`). Column headers are the CSV header names or "Column N".
- Selects (all options are the column names): **"Date column"**, **"Amount column (signed)"**, **"Description column"**, **"Currency column"** (extra first option: "Use {fallbackCurrency} for every row" = no currency column; `fallbackCurrency` = the chosen import account's currency, else the household's `budgetCurrency` — W08), **"Date format"** (19 options: "Auto-detect" + 18 fixed formats mirroring the server list, `ImportPage.tsx:61-80` — YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, MM/DD/YYYY, DD.MM.YYYY, D/M/YYYY, M/D/YYYY, DD-MM-YYYY, YYYYMMDD, DD MON YYYY, MON D, YYYY, DD/MM/YY, MM/DD/YY, D/M/YY, M/D/YY, DD.MM.YY, DD-MM-YY), **"Number format"** ("Auto-detect" / "1,234.56" / "1.234,56").
- **"First row is a header"** checkbox.
- **"Column separator"** select: "Comma ," / "Semicolon ;" / "Tab" / "Pipe |".
- **Re-scan button**: label toggles — clean: "Re-scan with this mapping" (secondary variant); dirty: "Apply changes & re-scan" (primary); busy: "Re-scanning…".
- Dirty hint next to the button: "Re-scan to apply your changes before importing."

### Review phase — bulk actions (`ImportPage.tsx:795-823`)

- **"Member"** select ("No member" + household members) + **"Apply to included"** button (disabled when no members). Applies to included, non-split, non-transfer rows only (`ImportPage.tsx:332-334`).
- **"Category (expenses)"** select ("Unassigned" + expense/savings groups) + **"Apply to expenses"** button (disabled when no expense groups). Applies to included, non-split, non-transfer **debit** rows only (`ImportPage.tsx:335-339`).

### Review phase — transactions table (`ImportPage.tsx:825-1137`)

- Header checkbox aria-label **"Include all rows"** — ticks/unticks every row (including possible-duplicates).
- Columns: (include) / Date / Payee / Amount / Category / Member.
- Per row:
  - Include checkbox, aria "Include {payee} on {date}". Excluded rows fade (`opacity-50`) **except** flagged-unticked possible duplicates, which get an amber tint instead (AA contrast).
  - Payee cell badges (block spans): "Possibly already imported" (when `possibleDuplicate`), "Looks like a transfer" (when `likelyTransfer && !isTransfer`).
  - Amount: `+`/`−` (U+2212) prefix + `formatMoney`; credits emerald.
  - Category cell, three modes:
    - Plain: category select (aria "Category for {payee} on {date}"; first option "Unassigned"; income rows get Income groups, debits get Expense+Savings groups via `buildItemOptions`, `client/src/lib/transactions.ts:16-31`), **"Split"** link-button, **"Transfer"** link-button (only when `canTransfer` = an import account is selected AND at least one other account exists, `ImportPage.tsx:238`). Both disabled when the row is unticked.
    - Transfer: Badge "Transfer", direction word "from" (credit) / "to" (debit), account select "Choose account…" listing `otherAccounts` (aria "Transfer account for {payee} on {date}"), **"Undo"** link.
    - Split: Badge "Split · {n}" (violet when valid, amber when not), **"Edit"/"Close"** link toggling the editor, plus a truncated line summary of the split's category names ("… · …", "Unassigned" for unset).
  - Member cell: transfer → "—"; split → "Per line"; else member select "No member" + members (aria "Member for {payee} on {date}"; disabled when unticked or no members).
- **Split editor** (inline expanded row, `ImportPage.tsx:1002-1131`):
  - Header: "Splitting "{payee}"" + total amount; progress bar; status text: "Fully allocated" / "{money} left" / "{money} over".
  - Per line: category select (aria "Split line {i} category for {payee}"), amount text input (`inputMode="decimal"`, placeholder "0,00", aria "Split line {i} amount for {payee}"), member select (only when household has members), remove button "✕" (aria "Remove split line {i} for {payee}"; only rendered when >2 lines).
  - Footer: "+ Add line", "Clear split" (reverts row to plain), "Done" (disabled until the split is valid).
  - Starting a split seeds 2 lines: line 1 inherits the row's current category+member with blank amount; line 2 blank (`ImportPage.tsx:351-366`). Starting a transfer clears any split; starting a split is only offered on plain rows.
- Blocking messages under the table:
  - "Finish the highlighted rows first — splits must add up, and transfers need an account." (any included row with an invalid split or a transfer without counterparty, `ImportPage.tsx:240-248,1139-1143`).
  - "You've changed the column mapping. Re-scan to apply it — otherwise the import would use the previous reading of your file." (mapping dirty, `ImportPage.tsx:1144-1149`).
- **Commit button**: "Import {includedCount} transaction(s)" → busy "Importing…". Disabled while `busy || includedCount === 0 || reviewIncomplete || mappingDirty` (`ImportPage.tsx:1152`). `onCommit` also independently guards `items.length === 0 || mappingDirty` (`ImportPage.tsx:428`).
- **"Choose a different file"** ghost button → full reset to upload phase.

### "You're all caught up" card (review phase, 0 new rows; `ImportPage.tsx:549-571`)

- Heading "You're all caught up"; body "Every transaction in this file is already in AllotJar — all {skippedDuplicates} were skipped as duplicates. Nothing new to import." (the "— all N were skipped" clause only when skipped > 0).
- Buttons: "Import another file" (reset), link "View transactions →".

### Done phase (`ImportPage.tsx:1162-1194`)

- Heading "Import complete"; body "{imported} transaction(s) added, {skippedDuplicates} skipped." (skipped clause only when > 0).
- Stat tiles: **Imported** (server count), **Skipped** (server count), **Money in**, **Money out** (client-side sums, see §6), **Transfers** (server count).
- "Import another file" button.

### Error surface

- `ErrorBanner` at the top for any failed preview/re-scan/commit; message = ProblemDetails `title` ?? 400-body `error` ?? "Something went wrong. Please check the file and try again." (`ImportPage.tsx:110-113`).

### Analytics

- `import_previewed` on successful preview and `import_committed` on successful commit, each with a bucketed row count only (`ImportPage.tsx:298,434`; event names `client/src/analytics/events.ts:37-39`; `import_started` exists in the catalog but is not emitted by ImportPage).

---

## 3. API endpoints

All on `ImportController` (`src/AllotJar.Api/Controllers/ImportController.cs`): route prefix `api/Import`, `[Authorize]` (valid JWT), `[FeatureGate(CamtImport)]` (404 when flag off). Role enforcement happens in the MediatR pipeline (Admin+ for all four; 403 otherwise — see §1).

| Verb+Route | Body | Used by UI? | Behaviour |
|---|---|---|---|
| `POST /api/import/camt053` | multipart: `file`, form `accountId?` (Guid) | **No** (API-only legacy one-shot) | Parses CAMT.053 and **immediately persists** all new entries; marks rows in another currency than the budget currency as waiting (`ForeignAmounts.MarkWaiting`, W08; no rate is looked up) + AutoCategorizer.ApplyAsync (returns `autoCategorized` count). 10 MB `RequestSizeLimit`. Dedup is per-request memory only — no race recovery here (a concurrent duplicate insert 500s, deferred item). |
| `POST /api/import/hsbc-csv` | multipart: `file`, form `accountId?` | **No** (API-only one-shot) | Same as above with the HSBC parser; file read as UTF-8 to preserve masked-card `•` bullets. |
| `POST /api/import/preview` | multipart: `file`, form `format` (`Camt053`/`HsbcCsv`/`GenericCsv`), form `mapping?` (JSON string of `CsvMapping`, camelCase accepted), form `defaultCurrency?` | **Yes** (`previewImport`, `client/src/lib/api.ts:171-184`) | Read-only. Parses, drops already-imported references, computes possible-duplicate hints + category suggestions. Returns `ImportPreviewResult`. 10 MB cap. |
| `POST /api/import/commit` | JSON `CommitImportCommand { accountId?: Guid, items: CommitImportItem[] }` | **Yes** (`commitImport`, `api.ts:187-193`) | Persists reviewed rows; idempotent by `BankReference`; validates ownership of accountId, every budgetItemId/memberId (incl. split slices) and transferAccountId; unique-index race recovery (§6/§7). Returns `ImportStatementResult`. No explicit size limit attribute. |

Wire DTOs: `ImportPreviewResult` / `ImportCandidate` (`src/AllotJar.Application/Imports/Models/ImportPreview.cs`), `CommitImportItem` / `CommitImportSplit` (`.../CommitImport/CommitImportCommand.cs`), `ImportStatementResult` (`.../ImportStatement/ImportStatementCommand.cs:17-25` — `totalEntries, imported, skippedDuplicates, credits, debits, iban, autoCategorized, transfers`). Commit always returns `Iban: null, AutoCategorized: 0`.

---

## 4. Validation rules & exact error messages

### Server — controller level (HTTP 400, `{ error: ... }`)

- "No file was uploaded." — null/empty file on camt053, hsbc-csv, preview (`ImportController.cs:47,70,100`).
- "The column mapping was not valid." — `mapping` form field fails JSON deserialization (`ImportController.cs:117`).

### Server — FluentValidation (HTTP 400 via `ExceptionHandlingMiddleware`, body `{status, title: "Validation failed", errors: {...}}`)

- `PreviewImportCommandValidator` / `ImportStatementCommandValidator`: Content NotEmpty — "The statement file is empty."
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
- Split validity (`splitInfo`, `ImportPage.tsx:153-163`): ≥2 lines, every line has a category and a parseable amount > 0 (`parseMinor`), and remaining-to-allocate exactly 0 minor units.
- Mapping dirty = deep JSON inequality between the editable `mapping` and the `scannedMapping` that produced the current rows (`ImportPage.tsx:231-234`).

---

## 5. State variants

- **Feature flag off** (`Features:CamtImport=false` in config): SPA route unregistered → `/import` redirects to `/`; Transactions-page Import button hidden; all 4 endpoints 404.
- **Role variants**: Read-only/Limited — client shows card: "Importing statements is available to admins and the household owner. You can still add transactions by hand on the Transactions page." (`ImportPage.tsx:471-476`); server 403s even preview. Admin/Owner — full flow. Role is resolved per request from the **active household** membership (`src/AllotJar.Api/Middleware/HouseholdResolutionMiddleware.cs`), so imports land in the active household's OwnerId, not necessarily the login's own.
- **Reference-data fetch failures**: `/accounts`, `/budget/current`, `/members` are fetched in parallel and each failure is swallowed to null (`ImportPage.tsx:210-225`) — page still works: no accounts ⇒ no account select options + transfers impossible; no month ⇒ category selects offer only "Unassigned"; no members ⇒ member selects disabled and bulk-member button disabled.
- **Solo vs shared household**: no `isShared` gating on this page; member selects always render (members are budget "people", min 1 via OwnerMemberSeeder). Household-size only affects the member option lists.
- **Loading**: buttons swap to "Reading…" / "Re-scanning…" / "Importing…"; no skeletons.
- **Empty/duplicate file**: preview with 0 new rows → "You're all caught up" card (never an empty grid).
- **Possible duplicates**: arrive unticked with amber tint + badge; user opt-in per row or via "Include all rows".
- **Generic upload sniffed as HSBC/CAMT**: no mapping card; sniff notice shown; `detectedFormat` ≠ GenericCsv. Once a user-confirmed `mapping` accompanies the preview request the sniff is **skipped** (stays generic, `PreviewImportCommandHandler.cs:49-74`).
- **No account selected**: transfers cannot be marked (button hidden); likely-transfer rows show only the amber note advising re-import with an account.
- **Only one account exists**: `canTransfer` false (needs an *other* account).
- **Mixed-currency file**: rows keep their own currency; success sums are grouped per currency and joined with " + " (`ImportPage.tsx:140-150,1176-1179`).
- **Dirty mapping**: Import disabled + warning; re-scan button turns primary "Apply changes & re-scan".
- **Re-scan**: per-row include/category/member/split/transfer choices carried forward for rows whose `reference` is unchanged; changed rows arrive fresh (`applyPreview` prior-map, `ImportPage.tsx:250-285`).
- **Archived/deleted referents**: accounts have no archived state (nothing filtered in the accounts query); category options come from the **current month** only — a suggestion pointing at a line not in the current month falls back to name-match then "Unassigned" (`resolveSuggestion`, `ImportPage.tsx:116-127`). Server-side, commit re-validates every referenced id against the owner and 403s on any mismatch (deleted ⇒ not found ⇒ 403 for items/members, 404 for the account).
- **Concurrent commit** (double-click, second device, second household login): unique index + recovery — the losing rows flip from imported to skipped, remainder saves; response counts reflect the post-recovery truth (`CommitImportCommandHandler.cs:168-219`).
- **Session expiry mid-flow**: standard 401→silent-refresh interceptor path; review state is client-memory only — a hard reload loses the parsed preview (no persistence).

---

## 6. Computed/derived values & money rules

### Client money handling

- Minor units factor **10_000** (4 dp, matching server decimal(18,4)) — `client/src/lib/money.ts:14`. Wire amounts are decimal numbers; `fromAmount` = `Math.round(amount*10000)`, `toAmount` = `minor/10000`.
- **Success-card sums** (`moneyByCurrency`, `ImportPage.tsx:140-150`): over rows still in state, `include && !isTransfer && isCredit` → Money in; `include && !isTransfer && !isCredit` → Money out; accumulated in minor units per currency; zero groups render as `formatMoney(0, budgetCurrency)`. These are **amounts**, not counts (PR #160 fix); Transfers tile stays the server count. Note: sums are computed from the reviewed rows, not the server result, so rows skipped by a commit-race are still included in the sums (accepted).
- **Split remaining**: `remainingMinor = fromAmount(row.amount) − Σ parseMinor(line.amount)` (unparseable lines count 0); progress % clamped 0–100; over-allocation shows rose "X over".
- Split slices are converted back to decimals with `toAmount(parseMinor(...))` before POST (`ImportPage.tsx:417-421`).

### Server-side derivations

- **BankReference composition (GOLDEN INVARIANT — never change; PR #154):**
  - HSBC (`HsbcCsvStatementParser.cs:145-150`): signature `"{postingDate:yyyy-MM-dd}|{purchaseDate:yyyy-MM-dd}|{last4}|{signedAmount:0.00}|{DESCRIPTION.ToUpperInvariant()}"` → `hsbc:{first-128-bits-SHA256-lowercase-hex}#{occurrenceIndex}`. Occurrence index counts identical signatures within one file (0-based) so N genuinely identical charges all import while re-imports no-op.
  - Generic CSV (`GenericCsvImporter.cs:117-129`): signature `"{date:yyyy-MM-dd}|{signed:0.####}|{RAW normalized description UPPER}"` → `csv:{hash}#{index}`. Signature uses the **raw** (whitespace-normalized) description cell; the display payee may be the HSBC-cleaned merchant (`TryCleanDetails`) but the reference never changes with it.
  - CAMT (`Camt053StatementParser.cs:144-180`): entry `AcctSvcrRef`, else any `EndToEndId` (literal `NOTPROVIDED` ⇒ null reference ⇒ row always imports, never dedups). References ≤140 chars stay **raw**; >140 fold to `prefix~{32-hex-SHA256-head}`. Repeats of the same reference within one statement get `#N` suffix (first occurrence stays raw), suffixed values re-folded to fit 140.
  - Golden tests pin exact strings: `tests/AllotJar.Application.Tests/Imports/HsbcCsvStatementParserTests.cs` (`Parse_References_AreStableAcrossReleases`) and `GenericCsvImporterTests.cs:196-197` (e.g. `csv:8babbc80a18fc258834cd1bbd3e3c7fb#0` / `#1`).
- **Dedup**: preview and commit both load ALL of the owner's non-null BankReferences and skip matches (Ordinal in-memory compare). DB backstop: unique filtered index `(OwnerId, BankReference) WHERE [BankReference] IS NOT NULL` (`src/AllotJar.Infrastructure/Persistence/Configurations/TransactionConfiguration.cs:73-75`); column max length 140 (`:44-45`). The SQL index compares with the column's **case-insensitive** collation while the in-memory skip is Ordinal — the race-recovery path deliberately matches OrdinalIgnoreCase (`CommitImportCommandHandler.cs:190-193`).
- **Concurrent-commit race recovery** (`CommitImportCommandHandler.cs:168-219`): on `DbUpdateException` whose inner message contains `IX_Transactions_OwnerId_BankReference` (≤3 retries): re-read taken refs, remove collided Added entities, decrement imported/credit/debit/transfer counters, increment skipped, save remainder (or finish clean if everything collided). Non-matching DbUpdateException rethrows. Integration-tested only on real SQL Server (`tests/AllotJar.IntegrationTests/UniqueBankReferenceTests.cs` — deterministic race via a trap `IIdentityService` whose `GetPreferredCurrencyAsync` — read for the budget currency between the dedup snapshot and the save — inserts the rival row; W08 replaced the old trap rate provider); EF InMemory does not enforce unique indexes.
- **Preview counts** (`PreviewImportCommandHandler.cs:129-137`): `TotalEntries` = parsed rows; `NewCount` = after reference-dedup; `SkippedDuplicates` = total − new; `Credits`/`Debits` = direction counts of the NEW rows.
- **Possible-duplicate hint** (`PreviewImportCommandHandler.cs:19,147-204`): window **±4 days** (covers purchase-vs-posting drift without flagging weekly recurrences), same exact decimal Amount, direction compatible (existing Transfer matches either; Income⇔credit; else debit), currency equal (OrdinalIgnoreCase), payee match = normalized equality **or containment either way** (raw bank blob contains clean merchant). Hint only — UI unticks those rows.
- **Category suggestions**: `AutoCategorizer.BuildSuggestionsAsync` (`src/AllotJar.Application/Transactions/AutoCategorizer.cs:63-90`) — most recent categorized transaction per normalized payee (trim/lower/collapse whitespace) wins; preview returns id+name; commit path does **not** auto-categorize (user's explicit choices only; one-shot endpoints DO run `AutoCategorizer.ApplyAsync`).
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
- **CAMT parsing rules**: local-name navigation (any camt.053.001.xx namespace); per-entry tolerance (bad entry dropped, never aborts the file); skips entries missing amount/currency/`CdtDbtInd` or a parseable `BookgDt`/`ValDt` (never fabricates dates); 0.00 skipped; payee = Dbtr name for credits / Cdtr for debits, fallback joined `Ustrd` remittance; IBAN surfaced only by the one-shot endpoint result. Sniff: content starts with `<` (after BOM/whitespace) and contains "camt.053" (CI) or "BkToCstmrStmt".
- **Sniff routing order**: registration order Camt053 then HsbcCsv (`src/AllotJar.Infrastructure/DependencyInjection.cs:39-40`); `PreviewImportCommandHandler` tries `CanParse` in that order for a mapping-less GenericCsv upload.

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **BankReference composition is a golden invariant** (PR #154): the exact `hsbc:`/`csv:` signature fields, hash (SHA-256 first 128 bits, lowercase hex) and `#occurrence` suffix must NEVER change — production dedup bakes them in. Golden tests pin literal strings.
2. **Same file ⇒ same code path** (PR #154): a "generic" upload with no confirmed mapping is sniffed against dedicated parsers first, so HSBC files uploaded via the default dropdown option get `hsbc:` refs and clean payees, not `csv:` refs. Once the user confirms a mapping, sniffing is skipped forever for that flow. Regression risk: payee/date/reference drift between import paths re-duplicating statements.
3. **Unique filtered index + race recovery** (PR #159): `(OwnerId, BankReference)` unique where not null; concurrent commits recover by skipping collided rows (matched by index NAME in the exception message; recovery ref-match is OrdinalIgnoreCase to agree with the CI collation). Migration `20260707211100_UniqueOwnerBankReference` pre-deleted surplus dups. **Not enforceable/testable on EF InMemory** — only in `tests/AllotJar.IntegrationTests` (real SQL container). The one-shot `/camt053` + `/hsbc-csv` endpoints have NO recovery — a concurrent race there 500s instead of double-inserting (accepted, deferred).
4. **Mapping dirty-state blocks stale-parse import** (PR #160): editing any mapping field disables Import, adds the warning, and turns the re-scan button primary; `onCommit` re-guards `mappingDirty` in case a future path bypasses the disabled button. Test both the visible gate and the guard.
5. **Re-scan carry-over** (PR #160): per-row edits survive a re-scan only for rows whose reference is unchanged (reference encodes date+amount+description — a mapping change that alters any of these intentionally drops the row's edits).
6. **Success sums are money, not counts** (PR #160): "Money in/out" sum the reviewed included amounts in minor units grouped per currency; only "Transfers" is a count.
7. **Date-format pinning** (PR #159): auto-detection is file-relative (an overlapping re-export can resolve ambiguous dd/MM vs MM/dd differently), so the applied format is echoed, shown ("We read your dates as …") and pinned into the mapping for re-scans/re-imports. The client's `DATE_FORMAT_OPTIONS` must mirror the server's `DateFormats` list or a pinned format renders as a blank select.
8. **Parser tolerances** (PR #159): leading BOM stripped by all three parsers (incl. CAMT's non-whitespace U+FEFF before `<`); bare-CR line endings; trailing-sign amounts; parenthesized negatives; 2-digit-year formats appended AFTER 4-digit peers (length-strict, cannot flip an existing file's resolution); HSBC unquoted-comma merchant stitching only as a fallback after column 3; 0.00 rows skipped everywhere (zero amounts are rejected app-wide); CAMT repeated refs get `#N` occurrence suffixes (first stays raw); no fabricated booking dates.
9. **Possible-duplicate window is ±4 days by design** — wide enough for purchase-vs-posting drift, deliberately narrower than 7 so weekly recurring charges don't false-flag. Flagged rows are default-**unticked** and amber-tinted (not opacity-faded — AA contrast).
10. **Dark mode remaps the whole slate scale** in `client/src/index.css` — do NOT add `dark:` overrides raising slate numbers in the mapping/sample/review tables (they invert to near-white; caught in PR #160 review). e2e mock gotcha: `client/e2e/mocks.ts importPreview()` must include `layout` + `sampleRows` or a11y CI never renders the mapping panel.
11. **Legacy reference schemes in prod**: `xlsx:MM:AccountName:rowid` rows exist from the one-off Excel seeder (`tools/ZeroBudget.Importer/`) and are invisible to `hsbc:`/`csv:` dedup — content-level possible-duplicate hints are the only guard against re-importing a seeded period (historical 39-pair overlap cleaned by hand; `docs/ops/import-duplicate-cleanup.sql`).
12. **Preview is not account-scoped**: dedup and duplicate hints run per-owner across all accounts; the target account is chosen at upload but only applied at commit. Changing the import account mid-review requires starting over (deferred I3 item).
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
- `src/AllotJar.Application/Imports/Commands/ImportStatement/{ImportStatementCommand,ImportStatementCommandHandler,ImportStatementCommandValidator}.cs`
- `src/AllotJar.Application/Imports/Models/{ImportPreview,CsvMapping,StatementFormat,ParsedStatement}.cs`
- `src/AllotJar.Application/Imports/TransferHeuristic.cs`
- `src/AllotJar.Application/Transactions/{AutoCategorizer,ForeignAmounts}.cs`, `src/AllotJar.Application/Budgets/BudgetCurrency.cs`
- `src/AllotJar.Application/Common/Interfaces/{IStatementParser,ICsvImporter}.cs`
- `src/AllotJar.Application/Common/Exceptions/StatementParseException.cs`
- `src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`
- `src/AllotJar.Infrastructure/Statements/{GenericCsvImporter,HsbcCsvStatementParser,Camt053StatementParser}.cs`
- `src/AllotJar.Infrastructure/Persistence/Configurations/TransactionConfiguration.cs` (BankReference 140 + unique filtered index)
- `src/AllotJar.Infrastructure/DependencyInjection.cs` (parser registration order)

Client:
- `client/src/pages/ImportPage.tsx` (whole page)
- `client/src/pages/TransactionsPage.tsx:640-670` (entry link)
- `client/src/App.tsx` (route + flag gating)
- `client/src/lib/api.ts:151-193` (`previewImport`, `commitImport`)
- `client/src/lib/money.ts` (FACTOR/fromAmount/toAmount/parseMinor/sumMinor/formatMoney)
- `client/src/lib/transactions.ts:16-41` (`buildItemOptions`)
- `client/src/types.ts:114-207` (import wire types)
- `client/src/auth/AuthContext.tsx` (canWrite/canEnterData), `client/src/features/FeatureContext.tsx` (camtImport default)
- `client/src/analytics/events.ts:36-39`

Tests (for invariants):
- `tests/AllotJar.Application.Tests/Imports/{HsbcCsvStatementParserTests,GenericCsvImporterTests,ImportPreviewCommitTests,ImportStatementHandlerTests,ImportStatementHandlerIsolationTests}.cs`
- `tests/AllotJar.IntegrationTests/UniqueBankReferenceTests.cs` (index enforcement + deterministic race recovery)
- `tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs` (`An_imported_row_in_another_currency_waits_and_nothing_converts_it`, `Without_a_budget_month_the_owners_currency_decides_what_waits_not_EUR`, `A_transfer_never_waits`, `A_statement_imported_onto_an_account_kept_in_another_currency_waits_and_can_be_confirmed`)
- `client/src/pages/ImportPage.test.tsx` ("generic CSV: rows without a currency are read in the chosen import account’s currency")

Memory notes consulted (claims re-verified against code): `import-coherence-audit-2026-07.md`, `import-consistency-fix.md`.
