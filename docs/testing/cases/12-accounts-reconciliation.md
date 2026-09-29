# Accounts & reconciliation

**ID prefix:** ACCT | **Scope:** Everything on the two accounts screens and the money math behind them: the accounts list at `/accounts` (`AccountsPage`) — the **Total balance / Available / Owed** hero with its mixed-currency footnote, the account-card grid (type hue icon, currency chip, type badge, per-account balance and "Opening …" caption, overlay link to detail), the **Add an account** modal (Name, Currency select gated on `multiCurrency`, Type, Opening balance) and its client + server validation, the inline **edit** card (currency immutable), the **Delete {name}?** confirmation modal and what happens to a deleted account's linked transactions/transfers, ordering by `DisplayOrder` then `Name`; the derived-balance formula (`opening + income − expense − transferOut + transferIn`, always computed at read, never stored); the account-detail register at `/accounts/:id` (`AccountDetailPage`) — balance hero, filtered Date/Payee/Category/Amount rows, direction-signed amounts, "(removed account)" transfer fallback, name-keyed category pills, per-transaction currency, not-found state; and the **Jar reconciliation** panel (Account/Balance/In jars/Float, backed-jar float math, archived-jar exclusion). | **Out of scope:** The dedicated transfer entry flow, its form/validation and the register's generic transfer rendering → `11-transfers.md`; whole-transaction assignment to an account, splits, income/expense entry and the main register → `10-transactions.md`; the profile / "My account" page at `/account` (singular — a different subsystem) → `04-account-preferences.md`; jar CRUD, the "Held in" funding-account select, accrual and the allocation engine that produces member savings transfers → the jars/allocation sibling file; `preferredCurrency` / `numberFormat` preference sources → `04-account-preferences.md`; the full role matrix, cross-tab logout, silent-refresh internals → the session & roles sibling files (only account-page `canWrite` gating and the account commands' 403s appear here); responsive / dark-mode / a11y sweeps live in their own files (referenced only where behaviour is account-specific).

**Test data setup:** Unless a case says otherwise, assume an authenticated **Owner** (`canWrite = true`) of a **shared EUR household "Home"** with **2 members** *Alex* and *Robin*. The app-wide viewed month is **July 2026**; `GET /budget/current` returns month **2026-07** (`BaseCurrency = EUR`). The `accounts` and `multiCurrency` feature flags are **on**. Three accounts exist unless stated: EUR **Joint** (opening 1,250.00), EUR **Rainy Day** (opening 500.00), and GBP **UK Pot** (opening 200.00 — present only for multi-currency cases). Money is `decimal(18,4)` server-side and integer minor units at scale 4 (`FACTOR = 10_000`) client-side; account balances and reconciliation totals are always transaction-derived at read time. The Add/Edit opening field is parsed by `parseSignedAmount` (empty → 0; one optional leading "−"; the rest via `parseMinor`, which strips spaces/apostrophes, treats the right-most of a mixed ",/." pair as the decimal separator, rounds HALF-UP beyond 4 dp, and rejects `''` after the sign / whitespace / `abc` / `1.2.3` / `1,2,3` → null). The client never surfaces server field errors on this page — each API failure maps to a fixed generic string. "Solo variant" = the same Owner in a 1-member household (no behavioural difference on these pages; role is what matters). Client wiring is exercised by `client/src/pages/AccountsPage.test.tsx` and `client/src/pages/AccountDetailPage.test.tsx`; backend behaviour by `tests/AllotJar.Application.Tests/Application/AccountsTests.cs`, `AccountReconciliationTests.cs`, and (for transfer/delete interplay) `tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs`.

---

## Account list & balance hero (AccountsPage)

### ACCT-001 - List accounts with per-account balances and the net hero
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner of "Home"; three accounts Joint (1,250.00), Rainy Day (500.00), UK Pot (£200.00), no transactions yet.
- **Steps:**
  1. Navigate to `/accounts`.
  2. Read the hero and each account card.
- **Expected:** Hero eyebrow "Total balance"; because currencies are mixed the amount is the raw cross-currency sum labelled in `preferredCurrency` (EUR) = **1,950.00**, tiles "Available" **1,950.00** and "Owed" **0.00**. Each card shows its name, balance formatted **in the account's own currency** (Joint €1,250.00, Rainy Day €500.00, UK Pot £200.00), and caption "Opening {same amount}". Section header "Your accounts" with a "+ Add account" button (Owner is `canWrite`).
- **Automated:** Yes (AccountsPage.test.tsx — account cards with balances + net-total hero)

### ACCT-002 - Negative-balance account colours the card and feeds the Owed tile
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; single EUR CreditCard account "Visa" with opening −450.00 (all EUR so the hero is unanimous).
- **Steps:**
  1. Open `/accounts`.
- **Expected:** The "Visa" balance renders in rose (`text-rose-600`). Hero (unanimous EUR): Total balance **−450.00**, Available **0.00** (sum of `max(0, balance)`), Owed **450.00** (displayed as the negated sum of `min(0, balance)`). No mixed-currency footnote.
- **Automated:** No

### ACCT-003 - Empty state when the household has no accounts
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Brand-new opt-out account (PR #170 default = empty); zero accounts.
- **Steps:**
  1. Open `/accounts`.
- **Expected:** `EmptyState` titled "No accounts yet", description "Use + Add account, then tag transactions to it to track its balance." Hero shows 0.00 across Total/Available/Owed in `preferredCurrency`. The "Jar reconciliation" card is absent. Owner still sees "+ Add account".
- **Automated:** Yes (AccountsPage.test.tsx — empty state)

### ACCT-004 - Unanimous currency labels the hero in that currency (no footnote)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with two EUR accounts only (delete UK Pot): Joint (1,250.00), Rainy Day (500.00).
- **Steps:**
  1. Open `/accounts`.
- **Expected:** `currencies.length === 1`, so `heroCurrency` = EUR; hero Total balance **€1,750.00**; no mixed-currency footnote pill. A later `preferredCurrency` preference change must **not** relabel these EUR cards or the hero (per-account cells always use `a.currency`).
- **Automated:** No

### ACCT-005 - Mixed currencies show the raw sum plus a footnote pill
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner with EUR Joint (1,250.00) and GBP UK Pot (£200.00).
- **Steps:**
  1. Open `/accounts`.
- **Expected:** `mixedCurrencies` true; hero amount = raw `1,250 + 200 = 1,450.00` labelled in `preferredCurrency` (EUR), with the footnote pill "Totals shown in EUR; some accounts hold another currency." Each card still formats in its own currency (€ vs £). (Known deferred limitation: no FX conversion — `ExchangeRate` is 1 app-wide.)
- **Automated:** No

### ACCT-006 - Load failure shows the accounts error banner
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `GET /accounts` returns a 500.
- **Steps:**
  1. Open `/accounts`.
- **Expected:** After "Loading…" clears, a page-level `ErrorBanner` reads "Could not load your accounts." No cards render. (The separate reconciliation fetch failure is silent — no banner.)
- **Automated:** No

### ACCT-007 - Ordering is DisplayOrder then Name; duplicate names allowed
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; create accounts in this order: "Joint", then a second "Joint", then "Aaa".
- **Steps:**
  1. Open `/accounts` and read the card order.
- **Expected:** Cards list by `DisplayOrder` (creation order → 0,1,2) then `Name`, so "Joint", "Joint", "Aaa" (creation order wins; there is no reorder UI). Two accounts named "Joint" coexist — no uniqueness rule anywhere; both render with distinct ids and independent balances.
- **Automated:** Partial (AccountsTests.cs — create orders after existing; duplicate-name allowance is not asserted)

### ACCT-008 - Card chrome: type badge, currency chip, hue tile, overlay link to detail
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; Savings account "Rainy Day" (EUR), `multiCurrency` on.
- **Steps:**
  1. Open `/accounts`; inspect the Rainy Day card and click it.
- **Expected:** Card shows the type-hue icon tile (Savings → emerald), a currency chip "EUR" (only because `multiCurrency`), a type badge "Savings" (from `ACCOUNT_TYPE_LABELS`, fallback "Other"). The whole card is an overlay `Link` (aria-label "View Rainy Day") to `/accounts/{id}`; clicking anywhere on it navigates to the detail page.
- **Automated:** No

## Adding an account

### ACCT-009 - Add a Current EUR account end to end
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; `multiCurrency` on; `preferredCurrency` EUR.
- **Steps:**
  1. Click "+ Add account" (aria-label "Add account"). Modal "Add an account" opens.
  2. Type "Everyday" into Name (placeholder "e.g. Everyday current").
  3. Leave Currency at EUR (default = `preferredCurrency`), Type at Current, Opening balance "1000".
  4. Click "Add account".
- **Expected:** One `POST /accounts` with `{ name: "Everyday", type: 0, currency: "EUR", openingBalance: 1000 }`. A 201 `AccountDto` is appended to the grid; `DisplayOrder` = max existing + 1. The new card's balance = opening (no transactions yet) = €1,000.00. `account_created` is tracked with `kind: "Current"`; the modal closes and Name/Opening reset, Currency resets to `preferredCurrency`.
- **Automated:** Yes (AccountsPage.test.tsx — add account via POST /accounts)

### ACCT-010 - Add accounts of every type
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner.
- **Steps:**
  1. Add one account per Type option: Current, Savings, Cash, Credit card, Other (aria-label "Account type").
- **Expected:** Each POST carries the numeric type 0–4 respectively; each card's type badge reads the matching `ACCOUNT_TYPE_LABELS` string ("Current" / "Savings" / "Cash" / "Credit card" / "Other") and the hue tile follows `hueForAccountType` (Savings emerald, Cash amber, CreditCard rose, Current indigo, Other teal). `account_created` `kind` mirrors the label.
- **Automated:** No

### ACCT-011 - Negative opening balance is refused (rule 74; superseded — credit cards are not accounts, rule 75)
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Owner; adding a "Credit card" account.
- **Steps:**
  1. In the Add modal set Name "Visa", Type "Credit card", Opening balance "-450".
  2. Click "Add account".
- **Expected:** `parseSignedAmount("-450")` → −450; POST body `openingBalance: -450`. Server validator `InclusiveBetween(−max, +max)` passes (negative openings are valid). The card balance shows −€450.00 in rose and feeds the hero "Owed" tile.
- **Automated:** No

### ACCT-012 - Opening balance 0 and empty both mean zero
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; adding an account.
- **Steps:**
  1. Add once with Opening balance left blank.
  2. Add again with Opening balance "0".
- **Expected:** Both produce `openingBalance: 0` (`parseSignedAmount('')` → 0). Cards show €0.00. No validation error in either case.
- **Automated:** No

### ACCT-013 - Empty name is rejected client-side before any request
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; Add modal open.
- **Steps:**
  1. Leave Name empty, set Opening "100", click "Add account".
- **Expected:** No `POST /accounts` fires; the modal's `ErrorBanner` shows "Give the account a name." (The page-level banner stays suppressed while the modal is open — `error && !showAdd`.)
- **Automated:** No

### ACCT-014 - Invalid opening amount is rejected client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; Add modal, Name "Test".
- **Steps:**
  1. Enter Opening "abc" → Add. 2. Retry with "1.2.3". 3. Retry with "1,2,3".
- **Expected:** Each `parseSignedAmount` returns null (magnitude unparseable) → error "Enter a valid opening balance."; no POST fires in any case.
- **Automated:** No

### ACCT-015 - Many-decimal opening rounds half-up to 4 dp; European grouping tolerated
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; Add modal.
- **Steps:**
  1. Add with Opening "1234.56785" (5+ decimals).
  2. Add another with Opening "1.234,50" (dot-grouping, comma-decimal).
- **Expected:** Case 1: `parseMinor` keeps 4 dp and rounds half-up on the 5th digit (…6785 → minor 12345679 → €1,234.5679). Case 2: right-most separator (",") is the decimal, "." is grouping → 1234.50 → €1,234.50. Both POST the rounded wire decimal.
- **Automated:** No

### ACCT-016 - Opening beyond the supported range fails server validation
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; Add modal.
- **Steps:**
  1. Enter Opening "100000000000000" (> 99,999,999,999,999.9999) → Add.
- **Expected:** `parseSignedAmount` parses it (client range-agnostic), so a `POST /accounts` fires; the server `CreateAccountCommandValidator` returns 400 `{ errors: { OpeningBalance: ["Opening balance exceeds the supported range."] } }`. The client surfaces only the generic "Could not add that account." (server field text is not shown).
- **Automated:** No

### ACCT-017 - Name longer than 120 characters fails server validation
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Owner; Add modal.
- **Steps:**
  1. Enter a 121-character Name, Opening "0", Add.
- **Expected:** Client passes (non-empty), POST fires; server `MaximumLength(120)` → 400. Client shows "Could not add that account."
- **Automated:** No

### ACCT-018 - Currency select: shown only with multiCurrency, defaults to preferred, resets after add
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; `multiCurrency` on; `preferredCurrency` EUR.
- **Steps:**
  1. Open the Add modal; inspect the Currency select (aria-label "Account currency") and helper text.
  2. Change it to GBP and add an account; reopen the modal.
- **Expected:** The Currency `Select` lists the `CURRENCY_OPTIONS` shortlist (24 codes, EUR→TRY) and defaults to EUR; helper text "An account's currency is fixed once created." The added account is created with `currency: "GBP"`. On the next open the select is back to EUR (reset to `preferredCurrency` after a successful add).
- **Automated:** No

### ACCT-019 - With multiCurrency off, no currency picker; account uses preferred currency
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; `multiCurrency` flag **off**; `preferredCurrency` EUR.
- **Steps:**
  1. Open the Add modal.
  2. Add an account "Everyday".
- **Expected:** No Currency select is rendered and no "fixed once created" helper. The POST still carries `currency: "EUR"` (state default = `preferredCurrency`), so the account is silently created in EUR. Card currency chips and reconciliation currency labels are hidden while the flag is off, but per-account formatting still uses `a.currency`.
- **Automated:** No

### ACCT-020 - Enter submits; Cancel closes without a request; page banner stays hidden while modal open
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; Add modal open with a valid Name and Opening.
- **Steps:**
  1. Focus Opening balance and press Enter.
  2. In a fresh open, click "Cancel".
- **Expected:** Enter runs `addAccount` (the input's `onKeyDown`), identical to clicking "Add account". "Cancel" (ghost) closes the modal with no `POST`. Any prior page-level error is hidden while the modal is open and its copy renders inside the modal instead.
- **Automated:** No

### ACCT-021 - Whitespace-only name rejected; unicode/emoji name accepted
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Owner; Add modal.
- **Steps:**
  1. Enter Name "   " (spaces only), Opening "0" → Add.
  2. Retry with Name "🏦 Ünïçödé Jar" → Add.
- **Expected:** Case 1: `name.trim() === ''` → "Give the account a name.", no POST. Case 2: passes; POST sends the trimmed unicode/emoji name; the card renders it verbatim (server trims and stores, MaxLength 120 counts characters).
- **Automated:** No

### ACCT-022 - Currency validator accepts any 3 letters; non-3-letter rejected at the API
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; `multiCurrency` on (picker offers only real codes) — this case probes the API contract.
- **Steps:**
  1. Add an account choosing a currency from the picker (all valid 3-letter codes).
  2. (API-level) `POST /accounts` with `currency: "ZZZ"`, then with `currency: "EU"`.
- **Expected:** The picker only ever sends valid codes. At the API, "ZZZ" **passes** (`^[A-Za-z]{3}$` — no ISO list check; stored upper-cased; `Intl.NumberFormat` later renders unknown codes generically); "EU" fails with 400 `{ errors: { Currency: ["Currency must be a 3-letter ISO 4217 code."] } }`. Empty currency → "An account needs a currency."
- **Automated:** No

## Editing an account

### ACCT-023 - Edit name, type, opening balance and opening date
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; account "Rainy Day" (Savings, opening 500.00 on 2026-01-01) with some transactions.
- **Steps:**
  1. Hover/focus the card and click "✎" (aria "Edit Rainy Day"). The inline edit card replaces it (name, type, opening balance, opening date — aria "Opening date for Rainy Day").
  2. Change Name to "Emergency", Type to "Current", Opening balance to "750".
  3. Click "Save" (aria "Save Emergency").
- **Expected:** One `PUT /accounts/{id}` with `{ name: "Emergency", type: 0, openingBalance: 750, openingDate: "2026-01-01" }` (**no currency field** in the body). The 200 `AccountDto` returns a **recomputed** balance as of today (`750 + net of the account's legs dated from the opening date`); the card updates in place and `account_edited` is tracked. Saving without an opening date is blocked client-side ("Enter the date the opening balance applies from.") and server-side (400). A legacy account with no opening date shows **Not available** with "Set an opening date to calculate the balance." and is left out of the hero total (rules 40/67).
- **Automated:** Yes (client/src/pages/AccountsPage.catalog.test.tsx — ACCT-023; AccountsPage.test.tsx — legacy account without an opening date; tests/AllotJar.Application.Tests/Application/AccountLedgerActivationTests.cs)

### ACCT-024 - Currency is immutable on edit (no input; read-only note)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 / per-account currency + immutable-currency UX
- **Preconditions:** Owner; `multiCurrency` on; GBP account "UK Pot".
- **Steps:**
  1. Open the inline edit card for "UK Pot".
- **Expected:** There is **no** currency input — only a read-only note "Currency GBP — fixed once created." The `PUT` request shape carries no currency field, so the account's currency can never change after create. A regression that let currency change would silently reinterpret the whole register.
- **Automated:** No

### ACCT-025 - Opening field pre-fills as a plain (non-localized) decimal
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner in a de-DE number-format locale; account with opening 1,234.50.
- **Steps:**
  1. Open the inline edit card and read the Opening balance input.
- **Expected:** Value is `toEditString(fromAmount(openingBalance))` = a plain "1234.5"-style string (dot decimal, no grouping) regardless of the display locale, so it round-trips through `parseSignedAmount` on save.
- **Automated:** No

### ACCT-026 - Edit to empty name blocked before request
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; inline edit card open.
- **Steps:**
  1. Clear the Name field, click "Save".
- **Expected:** No `PUT` fires; error "Give the account a name." Same guard applies to an invalid opening ("Enter a valid opening balance.").
- **Automated:** No

### ACCT-027 - Edit save API failure shows the save error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; inline edit; `PUT /accounts/{id}` returns 500.
- **Steps:**
  1. Change the name and click "Save".
- **Expected:** The card stays in edit mode; error "Could not save that account." (generic; server field errors not surfaced). The saving spinner clears (`savingId` reset).
- **Automated:** No

### ACCT-028 - Cancel edit reverts to the card with no request
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; inline edit card open with unsaved changes.
- **Steps:**
  1. Click "Cancel" (aria "Cancel edit").
- **Expected:** No `PUT` fires; the card returns to its non-edit form showing the unchanged persisted values.
- **Automated:** No

## Deleting an account & linked-transaction handling

### ACCT-029 - Delete an account via the confirmation modal
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; account "Rainy Day".
- **Steps:**
  1. Hover/focus the card, click "✕" (aria "Delete Rainy Day").
  2. In the modal titled "Delete Rainy Day?" read the body, then click "Delete account" (aria "Confirm delete Rainy Day").
- **Expected:** Body reads "The account is removed, but its transactions are kept — they simply become unassigned from any account. This can't be undone." A `DELETE /accounts/{id}` fires (204); the card is removed from the grid and the reconciliation panel re-fetches (the `accounts` array identity changed).
- **Automated:** Yes (AccountsPage.test.tsx — delete only after "Confirm delete <name>", DELETE /accounts/{id})

### ACCT-030 - Cancel in the delete modal does not delete
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; delete modal open for "Rainy Day".
- **Steps:**
  1. Click "Cancel".
- **Expected:** The modal closes; **no** `DELETE` fires; the card remains.
- **Automated:** Yes (AccountsPage.test.tsx — cancelled confirm does not delete)

### ACCT-031 - Deleting an account unlinks its transactions but keeps them
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167/#168 / delete unlinks, never cascades (register is the source of truth)
- **Preconditions:** Owner; account "Joint" with 3 assigned expense/income transactions.
- **Steps:**
  1. Delete "Joint" and confirm.
  2. Open `/transactions` and inspect those three rows.
- **Expected:** The handler explicitly sets `AccountId = null` on every transaction assigned to the account **before** removing it, so all three transactions survive as **unassigned** (no account tag) — none are deleted. The account's balance simply disappears from the hero/list.
- **Automated:** Yes (AccountsTests.cs — delete unlinks its transactions but keeps them)

### ACCT-032 - Deleting a destination account clears transfers pointing into it (no cascade/failure)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167/#168 / TransferAccountId FK is Restrict — must be nulled, never cascade-deleted
- **Preconditions:** Owner; a transfer of €200 from Joint → Rainy Day exists.
- **Steps:**
  1. Delete "Rainy Day" (the transfer's destination) and confirm.
  2. Inspect the transfer row on `/transactions` and Joint's detail register.
- **Expected:** The handler sets `TransferAccountId = null` on transfers-in before removing the account (the FK is Restrict, so an un-nulled reference would block or corrupt the delete). The transfer transaction survives; its counterparty now renders "(removed account)". The delete does **not** fail and does **not** delete the transfer row.
- **Automated:** Yes (TransfersTests.cs — DeleteAccount clears transfers pointing at it and keeps the transaction)

### ACCT-033 - Delete modal shows only the name, never currency or balance
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; GBP account "UK Pot" with balance £200.00.
- **Steps:**
  1. Open the delete modal for "UK Pot".
- **Expected:** The title reads "Delete UK Pot?" and the body is the fixed unassign copy — the modal deliberately does **not** display the account's currency or balance (only the name in the title). This is intentional; a QA regression would be adding balance/currency text here.
- **Automated:** No

### ACCT-034 - Delete API failure shows the delete error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `DELETE /accounts/{id}` returns 500.
- **Steps:**
  1. Confirm delete on an account.
- **Expected:** The card stays; page error "Could not delete that account."; the saving state clears.
- **Automated:** No

### ACCT-035 - Visiting a deleted account's stale URL shows the not-found state
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; an account was just deleted; its `/accounts/{id}` URL is still open in another tab.
- **Steps:**
  1. Reload the stale `/accounts/{id}`.
- **Expected:** `AccountDetailPage` fetches the full list, fails to `find` the id, and renders the "Account not found" state: title "Account not found", description "It may have been deleted. Head back to your accounts." with the "‹ Accounts" back link. No 404 route — this is an in-page empty state.
- **Automated:** Yes (AccountDetailPage.test.tsx — not-found state for unknown account id)

### ACCT-036 - Delete button is disabled while that account is saving
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Owner; a delete is in flight for account X (slow network).
- **Steps:**
  1. While the `DELETE` is pending, observe the "Delete account" button and the card's "✕".
- **Expected:** Both are `disabled` while `savingId === {that id}` (prevents a double-submit); they re-enable when the request settles.
- **Automated:** No

## Derived balance math (money integrity)

### ACCT-037 - Balance is always derived, never stored
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167/#168 audit / `Ignore(a => a.CurrentBalance)` — no persisted balance to drift
- **Preconditions:** Owner; account "Joint" opening 1,250.00 with: +€3,000 income, −€800 expense, −€200 transfer-out, +€150 transfer-in assigned to it.
- **Steps:**
  1. Open `/accounts` (or the account detail) and read Joint's balance.
- **Expected:** `CurrentBalance = OpeningBalance + Σincome − Σexpense − ΣtransferOut + ΣtransferIn` = `1250 + 3000 − 800 − 200 + 150 = €3,400.00`, computed by `AccountBalances.ApplyAsync` at read time. The value is never stored on the entity (EF `Ignore`); any cached balance would be a bug.
- **Automated:** Yes (AccountsTests.cs — balance = opening + assigned transactions, derived at read)

### ACCT-038 - Adding an income or expense transaction moves the card balance
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; account "Joint" balance €1,250.00 (opening only).
- **Steps:**
  1. On `/transactions` add a €300 expense assigned to Joint, then a €500 income assigned to Joint.
  2. Return to `/accounts`.
- **Expected:** Joint's derived balance recomputes to `1250 − 300 + 500 = €1,450.00`. The hero net updates accordingly.
- **Automated:** Partial (AccountsTests.cs covers the derivation; the round-trip through the transactions UI is not asserted here)

### ACCT-039 - A transfer debits the source and credits the destination
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; EUR Joint (1,250.00) and Rainy Day (500.00).
- **Steps:**
  1. Record a €200 transfer Joint → Rainy Day.
  2. Read both balances on `/accounts`.
- **Expected:** Joint = `1250 − 200 = €1,050.00` (transfer-out subtracted via `AccountId` match), Rainy Day = `500 + 200 = €700.00` (transfer-in added via `TransferAccountId` match). Net worth unchanged.
- **Automated:** Yes (TransfersTests.cs — moves balance source→destination)

### ACCT-040 - Splitting a transaction does not change the account balance
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; a €120 expense assigned to Joint, later split across two budget lines (€70 / €50).
- **Steps:**
  1. Split the transaction, then read Joint's balance.
- **Expected:** The whole €120 still moves the account (split slices are budget-line attribution only). Joint's balance is unchanged by the split — `AccountBalances` sums the transaction's whole `Amount`, not its slices.
- **Automated:** No

### ACCT-041 - A newly created account's balance equals its opening balance
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; adding "Everyday" opening 1,000.00.
- **Steps:**
  1. Create the account; read its card immediately.
- **Expected:** The create handler short-circuits `CurrentBalance = OpeningBalance` (no transactions possible yet), so the card shows exactly €1,000.00 and equals the next `GET /accounts`.
- **Automated:** Partial (AccountsTests.cs — derivation with no transactions equals opening)

### ACCT-042 - Cross-currency totals are a raw sum (no FX) — a deferred limitation
- **Priority:** P2
- **Type:** Regression
- **Origin:** months-accounts-coherence audit / deferred FX — `ExchangeRate` hardcoded 1, raw cross-currency sums
- **Preconditions:** Owner; EUR Joint (€1,250.00) and GBP UK Pot (£200.00).
- **Steps:**
  1. Read the hero on `/accounts`.
- **Expected:** The hero Total balance is the **raw numeric sum** `1450.00` labelled EUR with the mixed-currency footnote — `AccountBalances` sums `t.Amount` verbatim and never applies `ExchangeRate`. This is a known, intentionally-deferred limitation (guarded by the footnote), not a bug to file; the regression is any silent removal of the footnote or an unannounced FX change.
- **Automated:** No

## Account detail register (AccountDetailPage)

### ACCT-043 - Detail hero and account-filtered register
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; account "Joint" (Current, EUR) with several assigned transactions and one transfer-in.
- **Steps:**
  1. Click the Joint card → `/accounts/{id}`.
- **Expected:** Back link "‹ Accounts". Hero eyebrow = "Joint", amount = current balance in EUR, tiles "Type" = "Current" and "Transactions" = the filtered row count. The register table (columns Date / Payee / Category / Amount, min-width 520 px, horizontally scrollable) lists the account's rows newest-first (server order date-descending).
- **Automated:** Yes (AccountDetailPage.test.tsx — balance hero + account-filtered register + "‹ Accounts" back link)

### ACCT-044 - Register includes transfers into the account, not only its own rows
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; a transfer of €200 from Rainy Day → Joint (Joint is the destination).
- **Steps:**
  1. Open Joint's detail register.
- **Expected:** The transfer row appears because the filter is `t.accountId === id || t.transferAccountId === id`. Its Payee falls back to "Transfer" (blank note), and it counts toward the "Transactions" tile.
- **Automated:** No

### ACCT-045 - Amount signs are direction-aware
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; Joint has an income (+), an expense (−), a transfer-out (Joint = source) and a transfer-in (Joint = destination).
- **Steps:**
  1. Read the Amount column on Joint's register.
- **Expected:** Income "+{amount}" (brand-green text), expense "−{amount}" (dark), transfer "−" when `t.accountId === id` (Joint is source) and "+" when it is the destination (transfer amounts render slate/muted). The sign is computed per row, independent of stored sign.
- **Automated:** No

### ACCT-046 - Transfer category cell shows "{from} → {to}" with a removed-account fallback
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #168 / "(removed account)" fallback on the single-account register
- **Preconditions:** Owner; a transfer Joint → Rainy Day; then a second transfer whose counterparty account was later deleted.
- **Steps:**
  1. Open Joint's register and read the Category cell of both transfer rows.
- **Expected:** First row: "Joint → Rainy Day". Second row (counterparty deleted → `transferAccountName` null): "Joint → (removed account)"; if the source is the removed side it renders "(removed account) → {name}". Never a blank cell.
- **Automated:** No

### ACCT-047 - Category pills key by name with a hash fallback (non-current-month rows not grey)
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #168 / category pills keyed by budget-line NAME with a deterministic name-hash fallback
- **Preconditions:** Owner; Joint has assigned expenses in a **prior** month whose lines are not in `/budget/current`.
- **Steps:**
  1. Open Joint's register spanning multiple months.
- **Expected:** Each assigned row shows a coloured pill with the budget-line name. Rows whose line **is** in the current month use that line's hue (Income → brand, Savings/Expense → indexed hue); rows from other months fall back to a stable name-hash hue — none render grey. Unassigned rows show "—".
- **Automated:** No

### ACCT-048 - Each amount is formatted in the transaction's own stamped currency
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; GBP account "UK Pot" with a transaction whose `t.currency` differs from the account (deferred display-only mismatch).
- **Steps:**
  1. Open UK Pot's register and read the Amount cells.
- **Expected:** Each row formats with `t.currency` (the transaction's own stamped currency), **not** the account currency (`formatMoney(fromAmount(t.amount), t.currency)`). This can surface a currency mismatch for manually-entered transactions (currency stamped from the month base) — a known deferred display-only issue; the balance itself is not corrupted.
- **Automated:** No

### ACCT-049 - Empty register message
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; a brand-new account with no transactions.
- **Steps:**
  1. Open its detail page.
- **Expected:** The register body shows a single centered row "No transactions on this account yet."; the "Transactions" tile reads 0.
- **Automated:** No

### ACCT-050 - Unknown account id renders the not-found state
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; navigate to `/accounts/does-not-exist`.
- **Steps:**
  1. Load the URL directly.
- **Expected:** After loading, `find` returns null → "Account not found" empty state (title + "It may have been deleted. Head back to your accounts.") with the "‹ Accounts" back link. Any `:id` string is accepted client-side (there is no per-account GET endpoint; the page filters the full list).
- **Automated:** Yes (AccountDetailPage.test.tsx — not-found state for unknown account id)

### ACCT-051 - Detail page is read-only and tolerates side-fetch failures
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; on an account detail page where `GET /transactions` and/or `GET /budget/current` fail.
- **Steps:**
  1. Load the detail page.
- **Expected:** The page has **no** add/edit/delete/transfer affordances (entirely read-only). The transactions and budget fetches are `.catch(() => null)`-tolerant: a failure leaves an empty register / no pill hues but never breaks the hero or the page. Only a failed `GET /accounts` (via the `Promise.all` reject) trips the not-found state.
- **Automated:** No

## Jar reconciliation view

### ACCT-052 - Reconciliation table appears when an account backs a jar
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; jar "Emergency Fund" with "Held in" = Joint (opening €400, tracked balance €200); Joint balance €1,050.00.
- **Steps:**
  1. Open `/accounts` and scroll to the "Jar reconciliation" card.
- **Expected:** The card renders (because `reconciliation.some(r => r.backedJarCount > 0)`), header "Jar reconciliation" + sub-text "Each account's balance against the jars it holds — the float is what's not yet earmarked." Columns Account / Balance / In jars / Float. Joint row: Balance €1,050.00, In jars = `opening + tracked` = €600.00, Float = `1050 − 600 = €450.00`. Only rows with `backedJarCount > 0` show.
- **Automated:** Yes (AccountReconciliationTests.cs — account balance vs backed-jar balances)

### ACCT-053 - Reconciliation card hidden when no account backs any jar
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; accounts exist but no jar names any of them as "Held in".
- **Steps:**
  1. Open `/accounts`.
- **Expected:** The "Jar reconciliation" card is entirely absent (`reconciliation.every(r => r.backedJarCount === 0)`). For an unbacked account, `Float === CurrentBalance` server-side, but it simply isn't shown.
- **Automated:** Yes (AccountReconciliationTests.cs — unbacked account float = balance)

### ACCT-054 - Negative float renders in rose
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; a jar with In-jars total €1,200 backed by account "Rainy Day" whose balance is €700.00.
- **Steps:**
  1. Open the reconciliation table.
- **Expected:** Float = `700 − 1200 = −€500.00`, rendered in rose (`text-rose-600`) — a shortfall (the account holds less than its earmarked jars). Positive float is slate.
- **Automated:** No

### ACCT-055 - Archived jars and jars on a deleted funding account drop out of reconciliation
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; account Joint backs jar A (active) and jar B (archived); a jar C's funding account was deleted.
- **Steps:**
  1. Open the reconciliation table.
- **Expected:** Only jar A counts toward Joint's "In jars"/`backedJarCount`. The query filters `!IsArchived && FundingAccountId != null`, so archived jar B is excluded; jar C's dangling `FundingAccountId` no longer matches any existing account and silently drops out.
- **Automated:** No

### ACCT-056 - Reconciliation cells use each account's own currency; refetch is fire-and-forget
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; a GBP account "UK Pot" that backs a jar, plus an EUR backed account.
- **Steps:**
  1. Open `/accounts`; then add/edit/delete any account and observe the table.
- **Expected:** Each money cell formats in the account's own currency looked up client-side (`currencyById[r.accountId] ?? heroCurrency` — the DTO carries no currency). The reconciliation effect re-fetches whenever the `accounts` array changes (initial load + after any add/edit/delete). A reconciliation fetch failure is swallowed silently (`.catch(() => {})`) — the table just keeps its previous rows, no error banner. (Deferred: Float mixes account-currency balance with base-currency jar totals.)
- **Automated:** No

## Roles, feature flags & long-session behaviour

### ACCT-057 - Limited / Read-only members get a read-only register
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A Limited (role 2) and a Read-only (role 3) member of "Home".
- **Steps:**
  1. Each opens `/accounts`.
- **Expected:** Both see the hero, cards and reconciliation but **no** "+ Add account" button, **no** "✎"/"✕" affordances, and neither the Add nor the Delete modal can open (`canWrite = role <= Admin` is false). The detail page is likewise read-only for everyone.
- **Automated:** Yes (RoleGating.test.tsx — Limited cannot manage accounts: no "Account name" form, no "Edit <account>")

### ACCT-058 - Account create/update/delete are Admin+; Limited/Read-only get 403
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** A Limited or Read-only login (with the UI bypassed, e.g. a direct API call).
- **Steps:**
  1. Call `POST /accounts`, `PUT /accounts/{id}`, `DELETE /accounts/{id}`.
- **Expected:** Each returns 403 "Your access level ({role}) does not permit this action." — the three account commands carry no `[AllowLimited]`, so the MediatR `AuthorizationBehaviour` requires Admin+. (Queries `GET /accounts` and `/accounts/reconciliation` are readable by every role, incl. Read-only. Note: transfers are `[AllowLimited]`, so Limited *can* transfer — see `11-transfers.md`.)
- **Automated:** Yes (AuthorizationBehaviourTests.cs — commands require Admin+, ReadOnly none, Limited only AllowLimited; RoleGating.test.tsx for the client)

### ACCT-059 - Accounts feature flag off hides nav, routes and returns 404
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `Features:Accounts=false` server config (and the client `/features` reflects it).
- **Steps:**
  1. Sign in; inspect the nav and try `/accounts` directly.
- **Expected:** The "Accounts" nav item is gone; the `/accounts` and `/accounts/:id` routes are unregistered so the URL falls through the `*` catch-all → redirect to `/`; the whole `AccountsController` returns bare 404 (no body) via `[FeatureGate]`. Edge: if the client `/features` fetch fails, the client assumes all-on and shows the pages while the server still 404s the API calls (they surface as "Could not load your accounts.").
- **Automated:** Partial (AppNav.test.tsx — Accounts hidden when the flag is off; the route redirect and API 404 are not unit-covered)

### ACCT-060 - A dead session on a long-lived accounts tab lands the login prompt, not a broken view
- **Priority:** P3
- **Type:** Regression
- **Origin:** PR #169 / genuinely-dead sessions prompt a fresh sign-in (cross-tab logout + focus revalidation)
- **Preconditions:** Owner with `/accounts` open in a tab; the session is then genuinely killed (e.g. logout in another tab / server-side revoke), distinct from the PR #171 refresh-replay grace window which must NOT evict the session.
- **Steps:**
  1. Leave `/accounts` open; sign out in another tab (or revoke server-side); refocus the accounts tab or trigger its next fetch.
- **Expected:** The dead session is detected (cross-tab broadcast via `authChannel` / focus revalidation) and the app redirects to `/login?reason=expired…` with "Your session has expired" — the user does **not** see a silently-broken accounts view with a stale hero. A grace-window 401 (a just-rotated cookie, PR #171) must **not** trigger this. (Full session behaviour lives in the session sibling file; only the accounts-tab manifestation is noted here.)
- **Automated:** Partial (AuthContext.test.tsx — cross-tab sign-out + focus-revalidation prompt; not exercised specifically on the accounts route)

## Jar ledger reconciliation and account rules (rules 70, 74–76)

### ACCT-061 - Reconciliation shows In jars / Unallocated from the ledger and flags a backing deficit
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Savings 1,000 holding Holiday 400 and Car 300 (unallocated 300); Current 500 holding Repairs 400 and Holiday2 −50 after an overdrawing payment (balance 350).
- **Steps:**
  1. Open `/accounts` and read the "Jar reconciliation" card.
- **Expected:** Savings row: Balance €1,000.00, In jars €700.00, Unallocated €300.00. Current row: Balance €350.00, In jars €350.00 (signed), Unallocated €0.00 and a "Jars exceed account money" badge (`hasBackingDeficit`, positive jars 400 > 350). Column "Float" is now "Unallocated". ACCT-052/054/055 read the same figures from the ledger; a negative unallocated never occurs (it reads as the deficit flag instead).
- **Automated:** Yes (AccountReconciliationTests; AccountsPage tests)

### ACCT-062 - Credit card is not an account type; opening balances are never negative
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner.
- **Steps:**
  1. Open "Add an account" and inspect the Type select. 2. `POST /accounts` with `type: 3` (CreditCard). 3. `POST /accounts` with `openingBalance: -10`.
- **Expected:** 1: Current, Savings, Cash, Other only. 2: 400 "Credit cards are not accounts here: an account holds money, a card owes it." 3: 400 "The opening balance must be zero or more …" (rule 74).
- **Automated:** Yes (account validator tests; AccountsPage tests)

### ACCT-063 - Optional bank identifiers are stored, normalised and format-checked
- **Priority:** P2
- **Type:** Happy / Negative
- **Preconditions:** Owner.
- **Steps:**
  1. Add "Main" with IBAN "de89 3704 0044 0532 0130 00", BIC "cobadeffxxx", Sort code "12-34-56", Account number "12345678". 2. Add "Piggy bank" with all four blank. 3. Add with IBAN "hello".
- **Expected:** 1: stored as `DE89370400440532013000`, `COBADEFFXXX`, `123456`, `12345678` and shown on the detail page. 2: accepted — identifiers are never required (rule 76). 3: 400 "Enter a valid IBAN …".
- **Automated:** Yes (BankIdentifiers/validator tests; AccountsPage tests)

### ACCT-064 - An account holding jars cannot be deleted
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Savings holds Holiday.
- **Steps:**
  1. Delete Savings.
- **Expected:** 400 "'Savings' holds the money of 1 jar. Move those jars to another account (or archive them) before deleting the account." The database backs this up with a Restrict foreign key.
- **Automated:** Yes (DeleteAccount tests; JarLedgerSqlTests)

## Joint and private accounts (rules 30–34; W13, HANDOVER P52–P60)

Fixture W13: one household. Chris (budget owner, login), Sam (Admin login, linked to the person Sam), Kid (a person with no login). Line "Groceries" in this month.

### ACCT-065 - A joint account has one balance and one history for every holder
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Fixture W13.
- **Steps:**
  1. As Chris, add "Joint" held by Chris and Sam, opening 1,000. 2. Record a 40 expense on it. 3. Sign in as Sam and open Accounts and Transactions.
- **Expected:** One account "Joint", **Joint** badge, "Held by Chris and Sam", balance 960 for both logins; the expense appears once. No per-holder copies or shares (rule 30, P52).
- **Automated:** Yes (JointAccountsW13Tests — `AJointAccount_HasOneBalanceAndHistory_ThatEveryHolderSees_Rule30`; AccountsPage tests)

### ACCT-066 - An account you add for yourself starts private; one added for you starts shared and asks you to review
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Fixture W13.
- **Steps:**
  1. As Sam, **Add account** "Sam's current", tick **Held by Sam** only. 2. Note the **Keep it private** box, save. 3. As Chris, list Accounts. 4. As Chris, add "Sam's savings" held by Sam. 5. Sign in as Sam.
- **Expected:** 2: the box is ticked by default and shows only when the account is yours alone. 3: Chris does not see "Sam's current" at all. 4: saved shared (Chris sees it). 5: Sam sees the **Review sharing** banner listing "Sam's savings" as shared (rules 31/32, P54/P58).
- **Automated:** Yes (JointAccountsW13Tests — `AnAccountTheHolderAddsForThemselves_StartsPrivate_AndOnlyTheirLoginSeesIt_Rule31`, `AnAccountSomeoneElseAddsForAPersonWithALogin_StartsShared_AndAsksThemToReview_Rules31And32`; AccountsPage tests)

### ACCT-067 - Only the holder's own login can make a personal account private
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Fixture W13; "Sam's savings" (Sam, shared), "Kid's piggy bank" (Kid), "Joint" (Chris and Sam).
- **Steps:**
  1. As Chris, `PUT /api/accounts/{samSavings}/sharing {isPrivate:true}`. 2. As Chris, the same for Kid's piggy bank. 3. As Sam, the same for Joint. 4. As Sam, the same for Sam's savings; then `{isPrivate:false}`.
- **Expected:** 1: 403 "Only Sam's own login can choose who sees this account." 2: 403 "Only Kid's own login can choose who sees this account." — Kid has no login, so the account stays visible (rule 31). 3: 403 "Only a personal account's holder can choose who sees it; joint and household accounts are visible to everyone." 4: private, then shared again; the Accounts page offers **Make private** / **Share with household** only to Sam. Adding a joint account with `isPrivate: true` is refused with "A joint account can't be private: everyone in the household sees it (rule 33)."
- **Automated:** Yes (JointAccountsW13Tests — `OnlyTheHoldersOwnLogin_CanChoosePrivacy_AndOnlyForAPersonalAccount_Rules31And33`, `TheHolderShares_ThenEveryoneSeesIt_AndCanMakeItPrivateAgain`; AccountsPage tests)

### ACCT-068 - An account a jar uses can't be private
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Fixture W13; Sam's shared "Sam's savings" holds the jar "Holiday" (also when Holiday is archived, or has jar allocation history there).
- **Steps:**
  1. As Sam, open Accounts. 2. `PUT /api/accounts/{samSavings}/sharing {isPrivate:true}`. 3. Without the jar: as Sam make the account private while Chris creates a jar on it at the same moment (two sessions).
- **Expected:** 1: the card reads "Visible to the household: a jar uses it." (the reason on hover) and offers no **Make private**. 2: 400 naming the jar and rule 33. The sharing review shows the same account with its box disabled and the reason (P55). 3: never both: each save locks the account, so whichever comes second is refused (Sam: 400 naming the jar and rule 33; a jar Sam puts on an account he has just made private elsewhere: the rule 34 warning again).
- **Automated:** Yes (JointAccountsW13Tests — `AnAccountAJarUses_CannotBeMadePrivate_AndSaysWhy_P55`, `AnAccountThatGetsAJarWhileItIsBeingMadePrivate_StaysShared_Rule33`, `AJarPutOnAnAccountThatWentPrivateMeanwhile_IsWarnedAboutAgain_Rule34`; PrivateAccountsSqlTests — `Making_an_account_private_waits_for_a_jar_being_put_on_it_and_then_refuses`; AccountsPage and SharingReviewBanner tests)

### ACCT-069 - Private money is hidden off the budget and reads "Private account" on a budget line, read-only
- **Priority:** P0
- **Type:** Happy / Negative
- **Preconditions:** Fixture W13; "Sam's current" private to Sam with a 40 expense unassigned and a 60 expense on Groceries.
- **Steps:**
  1. As Chris, open Transactions and the Budget page. 2. Try to edit, reassign, re-split or delete the 60 (UI and API). 3. As Sam, open Transactions.
- **Expected:** 1: only the 60 shows, its account "Private account" (the API carries no account id for it), counted in Groceries' Spent; the 40 is not there. 2: no edit, assign or delete controls; the API answers 403 "This belongs to a private account. Only the login it is private to can change it." and nothing changes. 3: Sam sees both under "Sam's current" and can edit them (P56).
- **Automated:** Yes (JointAccountsW13Tests — `APrivateAccountsMoney_IsHidden_UnlessItsOnABudgetLine_ThenItReadsPrivateAccount_P56`, `OthersCannotChangeOrDeleteAPrivateAccountsEntry_EvenOnTheBudget`, `OthersCannotReSplitAPrivateAccountsEntry_OnlyItsSlicesWouldChange`; PrivateAccountsSqlTests; TransactionsPage tests)

### ACCT-070 - Private money off the budget stays out of the household reports for everyone
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** As ACCT-069.
- **Steps:**
  1. As Chris, open Reports for this month and People. 2. As Sam, the same.
- **Expected:** Both logins read the same figures: the 60 on Groceries counts, the 40 is in neither the Uncategorised figure nor Sam's spending (P56).
- **Automated:** Yes (JointAccountsW13Tests — `PrivateMoneyOffTheBudget_StaysOutOfTheHouseholdReports_ForEveryone_P56`; PrivateAccountsSqlTests)

### ACCT-071 - A private↔shared transfer shows on the shared side; the shared leg can be confirmed
- **Priority:** P1
- **Type:** Happy / Negative
- **Preconditions:** Fixture W13; a 100 transfer from Sam's private "Sam's current" to "Joint", in transit.
- **Steps:**
  1. As Chris, open Transactions and Joint. 2. Confirm the receipt into Joint. 3. Try to record the departure date or delete the transfer. 4. The other way: a 50 transfer from Joint to "Sam's current" whose receipt Sam recorded first (Pending review); as Chris, **Add departure date**.
- **Expected:** 1: the transfer shows with the other side "Private account"; Joint's balance counts it once received. 2: allowed. 3: 403; only Sam records the private side's leg or changes the transfer (P57). 4: the row offers **Add departure date** (the departure is Joint's leg) and the date saves; a private→shared row waiting for its departure offers nothing.
- **Automated:** Yes (JointAccountsW13Tests — `ATransferFromAPrivateAccount_ShowsOnTheSharedSide_WhoseReceiptTheOthersCanConfirm_P57`; PrivateAccountsSqlTests; TransactionsPage tests)

### ACCT-072 - A new login reviews its person's accounts; nothing changes until it answers
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture W13 with Kid given a login later: Kid holds "Kid's piggy bank" (shared) and holds the account backing "Holiday".
- **Steps:**
  1. Link Kid's new login to the person Kid (accept the invite, or **Link** on People). 2. Sign in as Kid: **Review sharing**. 3. Tick "Keep Kid's piggy bank private", **Save choices**. 4. Sign in again.
- **Expected:** 2: every account Kid holds, as it is now (shared); the jar's account is disabled with its reason. Until step 3 nothing changes. 3: the piggy bank is private to Kid; the banner goes and does not return (rule 32, P58).
- **Automated:** Yes (JointAccountsW13Tests — `LinkingALoginToAPersonWhoHoldsAccounts_AsksForAReview_WithoutChangingAnything_Rule32`; SharingReviewBanner tests)

### ACCT-073 - Privacy stays with the login that chose it until that login leaves; then the person's next login takes it over
- **Priority:** P1
- **Type:** Negative / Happy
- **Preconditions:** Fixture W13; "Sam's current" private to Sam's login.
- **Steps:**
  1. On People, unlink Sam's login and link the person Sam to Chris's login. 2. As Chris and as Sam's login, list Accounts. 3. Remove Sam's login from the household (**Revoke**). 4. As Chris, list Accounts. 5. Invite a new login for the person Sam (or link an existing login to Sam), sign in as it.
- **Expected:** 2: Chris does not see it; Sam's login still does, wherever it is linked. 4: still hidden from everyone. 5: the new login sees "Sam's current" as private to it and gets the **Review sharing** prompt; Chris still doesn't see it. Removing Sam's login after another login was linked to Sam hands it over the same way (P59).
- **Automated:** Yes (JointAccountsW13Tests — `PrivacyStaysWithTheLoginThatChoseIt_WhileItIsInTheHousehold_ARelinkNeverRevealsIt_P59`, `ARemovedLoginsPrivateAccount_PassesToThePersonsNextLogin_WithAReview_P59`, `APrivateAccount_PassesToThePersonsLinkedLogin_WhenTheLoginThatChoseItIsRemoved_P59`)

### ACCT-074 - A private account's holders can't change until it is shared
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Fixture W13; "Sam's current" private to Sam.
- **Steps:**
  1. As Sam, edit it and add Chris as a holder.
- **Expected:** 400 "This account is private. Share it with the household before changing who holds it…"; keeping Sam as the only holder saves (P52).
- **Automated:** Yes (JointAccountsW13Tests — `APrivateAccountsHolders_CannotChange_UntilItIsShared`)

### ACCT-075 - A private account with money off the budget can't be deleted
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture W13; "Sam's current" private to Sam with one unassigned 40 expense.
- **Steps:**
  1. As Sam, delete "Sam's current". 2. Put the 40 on Groceries and delete again.
- **Expected:** 1: 400 "'Sam's current' is private and still has 1 transaction off the budget. Deleting the account would show them to the whole household…"; nothing changes. 2: deleted; the 40 stays on Groceries with no account (P60).
- **Automated:** Yes (JointAccountsW13Tests — `DeletingAPrivateAccount_WithMoneyOffTheBudget_IsRefused_SoItNeverSurfacesUnlinked`)

### ACCT-076 - A private entry left off the budget is never put on a line automatically
- **Priority:** P0
- **Type:** Negative
- **Origin:** Adversarial review of PR #277 (P1-1): auto-categorising put such an entry on a line from the payee's history, which showed it to everyone.
- **Preconditions:** Fixture W13; "Joint" has "Pharmacy, 20" on Groceries; "Sam's current" private to Sam.
- **Steps:**
  1. As Sam, add "Pharmacy, 85" to "Sam's current" with no line. 2. As Sam, import a statement into "Sam's current" whose payees the household has put on lines before. 3. As Chris, open Transactions.
- **Expected:** 1 and 2: the entries stay unassigned (the import reports none auto-categorised). 3: none of them shows. Sam can still put them on a line himself (P56).
- **Automated:** Yes (JointAccountsW13Tests — `APrivateEntryLeftOffTheBudget_IsNeverAutoCategorisedOntoALine_P56`, `AStatementImportedIntoAPrivateAccount_IsNeverAutoCategorised_P56`)

### ACCT-077 - A refund in a private account still counts against its purchase
- **Priority:** P1
- **Type:** Negative
- **Origin:** Adversarial review of PR #277 (P2-1): the refund cap counted only the refunds the caller could see.
- **Preconditions:** Fixture W13; a 100 purchase in "Joint" on Groceries; Sam linked a 60 refund of it in his private "Sam's current", off the budget.
- **Steps:**
  1. As Chris, link another 60 refund to the purchase. 2. Change the purchase's amount to 50. 3. Delete the purchase.
- **Expected:** 1: 400, the refunds can't add up to more than the 100 paid; the message names no private amount. 2: 400 on Amount, without naming the refunded total. 3: 400 "This purchase has a refund linked to it in a private account. Its holder must unlink or delete it first." Nothing changes (P20, P56).
- **Automated:** Yes (JointAccountsW13Tests — `ARefundInAPrivateAccount_StillCountsAgainstThePurchase_ForEveryone_P20`)

### ACCT-078 - An account whose holder is archived can still be edited
- **Priority:** P2
- **Type:** Regression
- **Origin:** Adversarial review of PR #277 (P2-3): once a holder was archived, every save of the account was refused.
- **Preconditions:** Fixture W13; "Sam's old current" held by Sam; Sam and Kid archived on People.
- **Steps:**
  1. Rename the account, keeping Sam as its holder. 2. Add Kid as a holder.
- **Expected:** 1: saved. 2: 400 on HolderIds: "Kid is archived and can't hold an account. Restore them on the People page first."
- **Automated:** Yes (JointAccountsW13Tests — `AnAccountWithAnArchivedHolder_CanStillBeRenamed`)
