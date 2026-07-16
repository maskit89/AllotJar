# Accounts & reconciliation (CRUD, derived balances, per-account currency, jar reconciliation)

**ID prefix:** ACCT | **Scope:** Everything on `/accounts` (`AccountsPage`) and `/accounts/:id` (`AccountDetailPage`): account CRUD through the add modal, inline-card edit and delete-confirm modal (name, type Current/Savings/Cash/Credit card/Other, per-account currency chosen at create and **immutable after**, opening balance incl. negative); the balance hero (Total balance / Available / Owed tiles + mixed-currency footnote); each account card's per-account-currency display; the derived-balance invariant (`opening + Σincome − Σexpense − ΣtransferOut + ΣtransferIn`, never stored, no FX); the account-detail register (Date/Payee/Category/Amount rows, income `+` / expense `−` signs, name-keyed category pills, empty and not-found states); the **Jar reconciliation** panel (Balance / In jars / Float per backed account); and display-order/list ordering. Also the role gating (`canWrite` = Admin+), the `Features:Accounts` + `multiCurrency` flags, and account-command ownership scoping. | **Out of scope:** the transfer **form**, cross-currency-transfer guard, the *signed* rendering of transfer rows and the "delete-account keeps the transfer row" behaviour → **11-transfers.md** (this file cross-references it and does not re-assert it); manual income/expense create/edit/split/assign that move balances → **10-transactions.md** (referenced only as balance inputs); jar accrual, the "Held in" funding-account picker and the allocation engine that reconciliation reads → **08-jars.md / 09-allocation.md** (this file asserts only the reconciliation view); the user-profile "My account" page at `/account` (`AccountPage.tsx`, singular) → **04-account-preferences.md** (disambiguated: NOT this subsystem); silent-refresh / cross-tab-logout races on a long-lived accounts tab (#169/#171) → **03-session-auth-lifecycle.md** (one area-specific pointer case here); the full Owner/Admin/Limited/ReadOnly matrix across pages → **households & roles file** (only the account-action gating here); dark-mode / responsive / a11y sweeps → **cross-cutting file**. **Do not test for:** a per-account GET endpoint (the detail page fetches the whole `/accounts` list and finds the id client-side); a currency field on edit (there is none — immutable); a reorder UI (none exists — order is create-time only); a stored/cached balance (always derived); a delete cascade of transactions (delete unlinks, never deletes).

**Test data setup:** Local stack (API `:5099`, `ASPNETCORE_ENVIRONMENT=Development`) or beta (app.allotjar.com). Assume **today = 2026-07-16** (July 2026 = current month). Locale **en-GB comma-dot** so money renders `€1,234.56`; user `preferredCurrency` **EUR**. Feature flags default **ON** (`accounts`, `multiCurrency`). Passwords random `Aa1-<uuid>` (HIBP rejects fixed common ones). Money is integer minor units scale 4 client-side, `decimal(18,4)` server-side; opening-balance range **±99,999,999,999,999.9999**; name max **120** chars. Household **"Ledger House"** (owner **acct-owner@example.test**, role Owner) holds four accounts: **"Everyday"** (Current, EUR, opening **100.00**), **"Joint Savings"** (Savings, EUR, opening **1,000.00**), **"Visa"** (Credit card, EUR, opening **0.00**), and **"UK Holiday"** (Savings, **GBP**, opening **0.00**) for mixed-currency cases. Jars: **"Holiday"** (Held in = Joint Savings, opening 200.00, one 100.00 savings line this month) and an unbacked/other-account jar. Members of the same household: **acct-limited@example.test** (Limited) and **acct-readonly@example.test** (ReadOnly) — account CRUD is Admin+, so these rely on the pre-existing accounts. A second household (owner **acct-other@example.test**) owns account **"Foreign"** for ownership checks. Automation hints: `POST /accounts` returns **201** + `AccountDto` (`{id,name,type,currency,openingBalance,currentBalance,displayOrder}`); `PUT` returns 200 with a recomputed `currentBalance`; `DELETE` returns 204; the client never surfaces server field errors — every API failure maps to a fixed generic string.

## List, balance hero & page states

### ACCT-001 - Account list renders cards with per-account balances and a net Total-balance hero
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** acct-owner signed in; accounts "Everyday" (balance 250.00) and "Visa" (balance −75.00) exist.
- **Steps:**
  1. Navigate to `/accounts` (nav item "Accounts").
  2. Read the hero and each card.
- **Expected:**
  - One card per account; the hero eyebrow "Total balance" shows the raw net across all accounts = 250.00 + (−75.00) = **€175.00**.
  - Each card shows its balance formatted in the account's own currency; Visa's −75.00 renders in rose.
- **Automated:** Yes (client/src/pages/AccountsPage.test.tsx — "lists account cards with balances and a net total in the hero")

### ACCT-002 - Hero Available / Owed tiles split positive vs negative balances
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** acct-owner; Everyday +250.00, Joint Savings +1,000.00, Visa −75.00 (all EUR).
- **Steps:**
  1. On `/accounts`, read the two hero tiles.
- **Expected:**
  - "Available" = Σ max(0, balance) = 250.00 + 1,000.00 = **€1,250.00**.
  - "Owed" = −Σ min(0, balance), displayed positive = **€75.00** (the Visa debt shown as a positive owed amount).
  - Total balance = net = **€1,175.00**.
- **Automated:** No

### ACCT-003 - Empty state when the household has no accounts
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner in a fresh household with zero accounts (default sign-up — samples are opt-in, PR #170).
- **Steps:**
  1. Open `/accounts`.
- **Expected:**
  - EmptyState title "No accounts yet", description "Use + Add account, then tag transactions to it to track its balance."; hero shows €0.00 / €0.00 / €0.00; the Jar reconciliation card is absent.
- **Automated:** Yes (client/src/pages/AccountsPage.test.tsx — "shows an empty state when there are no accounts")

### ACCT-004 - Loading and load-error states
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** acct-owner; simulate a slow then failing `GET /accounts`.
- **Steps:**
  1. Open `/accounts` with the fetch pending, then with the fetch rejected.
- **Expected:**
  - While pending: paragraph "Loading…".
  - On failure: page-level `ErrorBanner` "Could not load your accounts."; no cards render.
- **Automated:** No

### ACCT-005 - Account card shows type badge, name, balance and opening caption in the account's currency
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** acct-owner; "Visa" (Credit card, EUR, opening 0.00, balance −75.00).
- **Steps:**
  1. Inspect the Visa card.
- **Expected:**
  - Type-hue icon tile; currency chip "EUR" (shown only when `multiCurrency`); type badge "Credit card".
  - Name "Visa"; balance **−€75.00** in rose (`text-rose-600`); caption "Opening €0.00" — both formatted with the account's own currency.
- **Automated:** Partial (client/src/pages/AccountsPage.test.tsx — asserts the "Credit card" badge and card balances; opening caption not asserted)

### ACCT-006 - Whole card links to the detail page; edit/delete controls appear only on hover/focus for writers
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner (canWrite) on `/accounts`.
- **Steps:**
  1. Tab to a card; then hover/focus it.
  2. Activate the overlay link.
- **Expected:**
  - The card carries an overlay `Link` (aria-label "View {name}") to `/accounts/{id}`; keyboard focus shows a focus ring and Enter navigates.
  - The "✎" (aria "Edit {name}", title "Edit account") and "✕" (aria "Delete {name}", title "Delete account") buttons are `opacity-0` until `group-hover` / `focus-within`, then visible — reachable by keyboard via focus-within. They render only when `canWrite`.
- **Automated:** No

## Adding an account

### ACCT-007 - Add an account end-to-end (name, type, opening) 
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** acct-owner (canWrite) on `/accounts`.
- **Steps:**
  1. Click "+ Add account" (aria-label "Add account").
  2. In the "Add an account" modal, set Name "Wallet" (aria "Account name"), Type "Cash" (aria "Account type", value 2), Opening balance "40".
  3. Click "Add account".
- **Expected:**
  - `POST /accounts` body `{name:"Wallet", type:2, currency:"EUR", openingBalance:40}` → 201 `AccountDto`.
  - The new card appears (balance €40.00 = opening, no transactions yet); analytics `account_created` fires with `{kind:"Cash"}`; the modal closes; Name/Opening reset. Type select defaults to "Current" (value 0) and lists Current / Savings / Cash / Credit card / Other.
- **Automated:** Yes (client/src/pages/AccountsPage.test.tsx — "adds an account")

### ACCT-008 - Currency select: shown only under multiCurrency, defaults to preferred, resets after add
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** acct-owner; `multiCurrency` ON; `preferredCurrency` EUR.
- **Steps:**
  1. Open the add modal; inspect "Currency" (aria "Account currency").
  2. Change it to "British pound (£)" (GBP), add an account, then re-open the modal.
- **Expected:**
  - The Currency `Select` lists the 24 `CURRENCY_OPTIONS`, defaults to EUR, with helper "An account’s currency is fixed once created."
  - The created account is GBP; on success `currency` resets to `preferredCurrency` (EUR) so the next add starts from the preference again.
- **Automated:** No

### ACCT-009 - multiCurrency OFF: no currency picker, account created in the preferred currency
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner; `multiCurrency` flag OFF; `preferredCurrency` EUR.
- **Steps:**
  1. Open the add modal.
- **Expected:**
  - No "Currency" select, no "fixed once created" helper, no currency chip on cards. The POST still sends `currency` = the state default (`preferredCurrency` EUR), so accounts are silently created in EUR.
- **Automated:** No

### ACCT-010 - Negative opening balance is accepted (credit-card debt)
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** acct-owner; add modal open; Type "Credit card".
- **Steps:**
  1. Opening balance "-250.50" (ASCII hyphen), Name "Amex", Add account.
- **Expected:**
  - `parseSignedAmount` strips the leading ASCII "-", parses 250.50, negates → POST `openingBalance:-250.5`; server `InclusiveBetween(-max,+max)` passes. Card shows opening −€250.50 and balance −€250.50 in rose.
  - (Note: only an ASCII "-" is recognised as the sign; a unicode minus "−" would fail `parseMinor` → invalid.)
- **Automated:** No

### ACCT-011 - Opening-balance parsing: empty→0, decimal, and Enter submits
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** acct-owner; add modal open with a valid Name.
- **Steps:**
  1. Leave Opening blank, Add → observe balance.
  2. Type "1234.5" in Opening and press Enter.
- **Expected:**
  - Blank Opening: `parseSignedAmount('')` → 0; account created with opening €0.00.
  - Enter in the Opening field runs `addAccount` (its `onKeyDown`), same as clicking "Add account"; opening stored 1234.50.
- **Automated:** No

### ACCT-012 - European grouping and >4-decimal opening amounts parse/round correctly
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** acct-owner; add modal open.
- **Steps:**
  1. Opening "2.500,00" → Add.
  2. Opening "10.12345" → Add.
- **Expected:**
  - "2.500,00": right-most separator is the decimal → 2500.0000; card opening €2,500.00.
  - "10.12345": `parseMinor` rounds half-up on the 5th decimal → 10.1235 (scale 4); no float drift.
- **Automated:** No

### ACCT-013 - Empty and whitespace-only names are blocked client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** acct-owner; add modal open.
- **Steps:**
  1. Leave Name empty → Add account.
  2. Set Name to "   " (spaces only) → Add account.
- **Expected:**
  - Both: `name.trim() === ''` → `ErrorBanner` "Give the account a name." inside the modal; no `POST /accounts` is sent. (Server mirror: `NotEmpty` → "An account needs a name.")
- **Automated:** No

### ACCT-014 - Invalid opening amount is blocked client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** acct-owner; add modal open with a valid Name.
- **Steps:**
  1. Opening "abc" (or "1.2.3", or "1,2,3") → Add account.
- **Expected:**
  - `parseSignedAmount` → null → `ErrorBanner` "Enter a valid opening balance."; no POST.
- **Automated:** No

### ACCT-015 - Opening balance over the supported range is a server range error surfaced generically
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** acct-owner; add modal open with a valid Name.
- **Steps:**
  1. Opening "99999999999999.9999" → Add (expect success).
  2. Opening "100000000000000" → Add.
- **Expected:**
  - Step 1: at the inclusive max → 201, account created.
  - Step 2: the client has no upper clamp, so it POSTs; server `InclusiveBetween` fails → 400 "Opening balance exceeds the supported range.", which the client shows only as the generic "Could not add that account."; no card added.
- **Automated:** No

### ACCT-016 - Very long, unicode and emoji names
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** acct-owner; add modal open.
- **Steps:**
  1. Name = 120 chars → Add (expect success); Name = 121 chars → Add.
  2. Name "Café ✈️ 貯金 😀" (≤120) → Add.
- **Expected:**
  - 120 chars accepted; 121 chars fails server `MaximumLength(120)` → generic "Could not add that account." (client has no length check).
  - Unicode/emoji name stored and rendered verbatim (trimmed) on the card.
- **Automated:** No

### ACCT-017 - Cancelling the add modal discards input; the page banner is suppressed while the modal is open
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner; a prior page-level error is showing (e.g. a failed add).
- **Steps:**
  1. Click "+ Add account" (this clears `error` first).
  2. Trigger an in-modal error (empty name → Add), then click "Cancel".
- **Expected:**
  - The in-modal `ErrorBanner` shows while the modal is open; the page-level banner is hidden (`error && !showAdd`).
  - "Cancel" closes the modal with no POST; typed values are dropped.
- **Automated:** No

### ACCT-018 - API failure while adding shows the generic error and no card
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** acct-owner; force `POST /accounts` to fail (network/500).
- **Steps:**
  1. Add a valid account; the POST rejects.
- **Expected:**
  - `catch` → "Could not add that account." in the modal banner; no optimistic card is left (the card is appended only on success).
- **Automated:** No

### ACCT-019 - Duplicate account names are allowed
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** acct-owner; an account "Everyday" already exists.
- **Steps:**
  1. Add a second account also named "Everyday".
- **Expected:**
  - 201 — there is no uniqueness rule anywhere; two "Everyday" cards coexist (distinct ids). List order then falls back to Name after DisplayOrder.
- **Automated:** No

## Editing an account

### ACCT-020 - Inline-card edit saves name, type and opening balance
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** acct-owner; "Everyday" card visible.
- **Steps:**
  1. Hover the card, click "✎" (aria "Edit Everyday").
  2. Change Name to "Main current" (aria "Name for Everyday"), Type to "Savings", Opening to "150".
  3. Click "Save" (aria "Save Everyday").
- **Expected:**
  - `PUT /accounts/{id}` body `{name:"Main current", type:1, openingBalance:150}` (no currency field) → 200 with a recomputed `currentBalance`; analytics `account_edited` fires; the card returns to view mode with the new values.
- **Automated:** No

### ACCT-021 - Currency is immutable on edit — read-only note, no currency input
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #168 / per-account currency + immutable-after-create (`UpdateAccountRequest` has no currency field)
- **Preconditions:** acct-owner; `multiCurrency` ON; editing a GBP account "UK Holiday".
- **Steps:**
  1. Enter edit mode on the card and inspect the fields.
- **Expected:**
  - The edit card shows Name / Type / Opening inputs and a read-only line "Currency **GBP** — fixed once created." — there is NO currency select. The PUT body carries no currency, so the whole register can never be silently re-denominated.
- **Automated:** No

### ACCT-022 - Opening field is pre-filled as a plain (non-localized) decimal
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner; editing an account with opening 1,234.50.
- **Steps:**
  1. Enter edit mode; read the Opening input value.
- **Expected:**
  - Value is `toEditString(fromAmount(openingBalance))` = plain "1234.5" (no thousands separators, no currency symbol), so re-saving round-trips exactly.
- **Automated:** No

### ACCT-023 - Editing to an empty name is blocked
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** acct-owner; in edit mode.
- **Steps:**
  1. Clear the Name, click "Save".
- **Expected:**
  - `eName.trim() === ''` → "Give the account a name."; no PUT. Same generic "Could not save that account." only on a real API failure.
- **Automated:** No

### ACCT-024 - Editing the opening balance recomputes the shown balance
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner; "Everyday" opening 100.00, one +500.00 income tx and one −120.00 expense tx assigned → balance 480.00.
- **Steps:**
  1. Edit Everyday's Opening to 200.00, Save.
- **Expected:**
  - The PUT re-runs the derivation server-side: balance = 200 + 500 − 120 = **€580.00**; the returned DTO's `currentBalance` updates the card. The transaction register is unchanged.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountsTests.cs — balance derived at read from opening + assigned transactions)

### ACCT-025 - Edit API failure surfaces the generic save error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** acct-owner; force `PUT /accounts/{id}` to fail.
- **Steps:**
  1. Edit and Save; the PUT rejects.
- **Expected:**
  - "Could not save that account."; the card stays in edit mode with the entered values (no optimistic overwrite).
- **Automated:** No

## Deleting an account

### ACCT-026 - Delete an account after confirming
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** acct-owner; "Everyday" exists.
- **Steps:**
  1. Hover the card, click "✕" (aria "Delete Everyday").
  2. In the "Delete Everyday?" modal, click "Delete account" (aria "Confirm delete Everyday").
- **Expected:**
  - `DELETE /accounts/{id}` → 204; the card is removed; the Jar reconciliation table refreshes (the `accounts` array identity changed).
- **Automated:** Yes (client/src/pages/AccountsPage.test.tsx — "deletes an account after confirming")

### ACCT-027 - Cancelling the delete confirmation does not delete
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner; delete-confirm modal open for "Everyday".
- **Steps:**
  1. Click "Cancel".
- **Expected:**
  - No `DELETE` is sent; the "Everyday" card remains.
- **Automated:** Yes (client/src/pages/AccountsPage.test.tsx — "does not delete when the confirmation is cancelled")

### ACCT-028 - Delete-confirm modal explains transactions are kept and shows only the name
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 / delete-account confirmation modal ("transactions are kept but become unassigned")
- **Preconditions:** acct-owner; delete-confirm modal open for a GBP account with a non-zero balance.
- **Steps:**
  1. Read the modal body.
- **Expected:**
  - Title "Delete {name}?"; body "The account is removed, but its transactions are kept — they simply become unassigned from any account. This can’t be undone."
  - The modal body does **not** display the account's currency or balance — only the name in the title. Buttons "Cancel" and "Delete account".
- **Automated:** Partial (client/src/pages/AccountsPage.test.tsx — asserts the "transactions are kept" copy)

### ACCT-029 - Deleting an account unlinks its transactions and clears transfer-in pointers; the register survives
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167/#168 / delete unlinks (never cascades); `AccountId` FK is SetNull, `TransferAccountId` is Restrict and must be cleared first
- **Preconditions:** acct-owner; "Everyday" has 3 assigned income/expense transactions and is the destination of one transfer from "Joint Savings".
- **Steps:**
  1. Delete "Everyday" via the confirm modal.
  2. Inspect the transactions register and Joint Savings.
- **Expected:**
  - The handler sets `AccountId = null` on the 3 assigned transactions and `TransferAccountId = null` on the incoming transfer **before** removing the account (Restrict FK), then deletes the account. No transaction is deleted.
  - Those 3 transactions now show as unassigned (no account); the transfer row survives with its source pointer intact. (Transfer-specific row rendering / "(removed account)" fallback → see 11-transfers.md TRF-026/TRF-031.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountsTests.cs — delete unlinks its transactions but keeps them; tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — DeleteAccount clears transfers pointing at it and keeps the transaction)

### ACCT-030 - Deleted account's stale detail URL shows the not-found state
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner; note a valid account id, then delete that account.
- **Steps:**
  1. Navigate directly to `/accounts/{deletedId}`.
- **Expected:**
  - The detail page fetches `/accounts`, fails to `find` the id → EmptyState "Account not found" / "It may have been deleted. Head back to your accounts." (No 404 route; any `:id` string is accepted client-side.)
- **Automated:** Partial (client/src/pages/AccountDetailPage.test.tsx — not-found state for unknown account id)

## Derived balance math

### ACCT-031 - Balance = opening + income − expense − transferOut + transferIn, derived at read
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** acct-owner; "Everyday" opening 100.00; assigned: +500.00 income, −120.00 expense; one transfer out of 50.00 and one transfer in of 30.00 touch it.
- **Steps:**
  1. Load `/accounts` and read Everyday's balance.
- **Expected:**
  - `AccountBalances`: 100 + 500 − 120 − 50 + 30 = **€460.00**. Income/expense legs grouped per (account,type); transfer legs matched by `AccountId` (out) and `TransferAccountId` (in). The balance is computed at read time — there is no stored field.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountsTests.cs — balance = opening + assigned transactions, derived at read, owner-scoped)

### ACCT-032 - Balance is never persisted — a transaction change moves the balance on next read
- **Priority:** P0
- **Type:** Regression
- **Origin:** Invariant — `Account.CurrentBalance` is `Ignore`d in EF; the register is the single source of truth
- **Preconditions:** acct-owner; "Everyday" balance 460.00 (per ACCT-031).
- **Steps:**
  1. On `/transactions`, delete the −120.00 expense assigned to Everyday.
  2. Return to `/accounts`.
- **Expected:**
  - Everyday now reads **€580.00** (the expense no longer subtracts). Any UI that appeared to cache a balance would be a bug — it is recomputed on every `GET /accounts`.
- **Automated:** No

### ACCT-033 - Splitting a transaction does not change which account moved — the whole amount counts
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner; a −90.00 expense assigned to "Everyday" is split across two budget lines (60 + 30).
- **Steps:**
  1. Compare Everyday's balance before and after the split.
- **Expected:**
  - Unchanged — the split allocates budget-line attribution only; `AccountBalances` counts the whole `t.Amount` (90.00) against the account, not the slices.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountsTests.cs — balance from whole assigned transactions; SplitTransactionTests covers slice attribution)

### ACCT-034 - A brand-new account's balance equals its opening balance
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** acct-owner; add modal.
- **Steps:**
  1. Create an account with opening 40.00.
- **Expected:**
  - The create handler short-circuits `currentBalance = openingBalance` (no transactions possible yet) = **€40.00**; matches the next `GET /accounts`.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountsTests.cs — create orders after existing; derivation on read)

### ACCT-035 - Cross-currency balances are raw-summed with no FX (deferred behaviour)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner; EUR accounts totalling +1,175.00 and a GBP account "UK Holiday" balance +200.00.
- **Steps:**
  1. Read the hero Total balance.
- **Expected:**
  - The hero raw-sums minor units across currencies (200 GBP added as 200 to the EUR total) → **€1,375.00**, labelled in `preferredCurrency` with the mixed-currency footnote (ACCT-037). `AccountBalances` never applies `ExchangeRate` (hardcoded 1 app-wide). This is a known deferred FX limitation — assert it does not silently start converting, but do not report it as a new bug.
- **Automated:** No

## Per-account & mixed-currency display

### ACCT-036 - Cards, opening captions and reconciliation format in each account's own currency
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 / per-account currency display (was `preferredCurrency`, mislabelled after a preference change)
- **Preconditions:** acct-owner; a GBP account "UK Holiday" (opening 0.00, balance £200.00); user `preferredCurrency` EUR.
- **Steps:**
  1. View the UK Holiday card.
  2. Change the money-display preference to a different currency and reload `/accounts`.
- **Expected:**
  - The card always formats balance and "Opening" in **GBP** (`formatMoney(minor, a.currency)`), e.g. "£200.00" — never in EUR. A preference change never relabels the account cards (only the mixed-currency hero label uses the preference).
- **Automated:** No

### ACCT-037 - Hero uses the unanimous currency when accounts agree, else preferred + a mixed-currency footnote
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner.
- **Steps:**
  1. With all accounts EUR, read the hero.
  2. Add the GBP "UK Holiday" account and re-read the hero.
- **Expected:**
  - All-EUR: hero amounts formatted in EUR (the single common currency), no footnote.
  - Mixed: hero labelled in `preferredCurrency` and a footnote pill "Totals shown in {heroCurrency}; some accounts hold another currency." appears.
- **Automated:** No

### ACCT-038 - Per-currency fraction digits (JPY renders 0 decimals)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** acct-owner; a JPY account (opening 100000, `multiCurrency` on).
- **Steps:**
  1. View the card balance.
- **Expected:**
  - `Intl.NumberFormat` currency style yields JPY's natural 0 fraction digits, e.g. "¥100,000" (no "¥100,000.00"); EUR/GBP still show 2 dp.
- **Automated:** No

## Account detail register

### ACCT-039 - Detail hero (Type + Transactions tiles) and the account-filtered register
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** acct-owner; "Everyday" with 4 transactions touching it.
- **Steps:**
  1. Click the Everyday card → `/accounts/{id}`.
- **Expected:**
  - Back link "‹ Accounts"; hero eyebrow = "Everyday", amount = current balance in the account's currency; tiles "Type" = "Current" and "Transactions" = "4".
  - Register columns Date / Payee / Category / Amount; rows = every transaction where `accountId === id` OR `transferAccountId === id`.
- **Automated:** Yes (client/src/pages/AccountDetailPage.test.tsx — balance hero + account-filtered register + "‹ Accounts" back link)

### ACCT-040 - Register signs and empty state: income "+", expense "−", each in the transaction's own currency
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** acct-owner; Everyday has a +500.00 income row and a −120.00 expense row; then a second account with no transactions.
- **Steps:**
  1. On Everyday's register, read the two Amount cells.
  2. Open the empty account's register.
- **Expected:**
  - Income shows "+€500.00" in brand-green; expense shows "−€120.00" in dark text; amounts format with `t.currency` (the row's own stamped currency).
  - Payee falls back to "—" when blank (non-transfer); Category shows a colored pill (assigned) or "—" (unassigned).
  - Empty register: single row "No transactions on this account yet."
- **Automated:** Partial (client/src/pages/AccountDetailPage.test.tsx — filtered register renders; sign/empty specifics not all asserted)

### ACCT-041 - Category pills are keyed by budget-line name with a hash fallback — non-current-month rows never render grey
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 / pills keyed by `budgetItemName` + stable name-hash fallback (were grey on non-current months)
- **Preconditions:** acct-owner; the register spans several months; `/budget/current` only knows this month's line ids; a row's line "Groceries" also exists in an older month.
- **Steps:**
  1. View a current-month assigned row and an older-month assigned row.
- **Expected:**
  - Current-month lines take their category hue from `/budget/current` keyed by name (Income → brand, Savings/Expense → indexed hues); a line not in the current month falls back to a deterministic name-hash hue — no row renders grey. Unassigned rows show "—".
- **Automated:** No

### ACCT-042 - Transfers appear in the register signed by direction
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner; a transfer Joint Savings → Everyday of 300.00.
- **Steps:**
  1. Open Everyday's register (destination) and Joint Savings' register (source).
- **Expected:**
  - The transfer appears in both (filter is `accountId === id || transferAccountId === id`); Payee falls back to "Transfer"; Category cell shows "{from} → {to}" (with "(removed account)" fallback); Amount is "+" on the destination and "−" on the source, muted slate, formatted in `t.currency`. (Full signed-transfer assertions live in 11-transfers.md TRF-025/TRF-026.)
- **Automated:** No

### ACCT-043 - The detail page is entirely read-only and ordered date-descending
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner (a writer) on an account's detail page with several dated rows.
- **Steps:**
  1. Look for any add/edit/delete/transfer control; check row order.
- **Expected:**
  - No add/edit/delete/split/assign/transfer affordances anywhere on `/accounts/:id` (register is view-only). Rows follow the server order (`GET /transactions` is date-descending), so the newest transaction sits at the top.
- **Automated:** No

## Jar reconciliation

### ACCT-044 - Reconciliation panel shows each backed account's Balance / In jars / Float
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** acct-owner; "Joint Savings" balance 1,000.00 backs jar "Holiday" (opening 200.00 + a 100.00 savings line = 300.00 tracked).
- **Steps:**
  1. On `/accounts`, scroll to the "Jar reconciliation" card.
- **Expected:**
  - Header "Jar reconciliation", sub-text "Each account’s balance against the jars it holds — the float is what’s not yet earmarked."
  - Row for Joint Savings: Balance €1,000.00, In jars €300.00, Float €700.00 (= balance − backed total). Columns Account / Balance / In jars / Float.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountReconciliationTests.cs — "Reconciles_AccountBalance_AgainstBackedJarBalances": balance 1000, backed 300, float 700, count 1)

### ACCT-045 - The reconciliation card is hidden when no jar backs any account
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner; accounts exist but no jar names any of them as its "Held in" account.
- **Steps:**
  1. Open `/accounts`.
- **Expected:**
  - No "Jar reconciliation" card at all (rendered only when `reconciliation.some(r => r.backedJarCount > 0)`).
- **Automated:** No

### ACCT-046 - Unbacked accounts are omitted from the table even though their float equals their balance
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner; "Joint Savings" backs a jar; "Everyday" backs none.
- **Steps:**
  1. Read the reconciliation table rows.
- **Expected:**
  - Only Joint Savings appears; Everyday is filtered out (`backedJarCount > 0`). At the API level, Everyday's DTO carries `backedJarCount: 0` and `float == currentBalance`.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountReconciliationTests.cs — "UnbackedAccount_HasFloatEqualToBalance": count 0, float = balance)

### ACCT-047 - Archived jars and jars whose funding account was deleted drop out of reconciliation
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-owner; "Joint Savings" backs jars "Holiday" (active) and "OldGoal" (about to archive); a third jar "Orphan" pointed at a since-deleted account.
- **Steps:**
  1. Archive "OldGoal", then reload `/accounts`.
  2. Confirm "Orphan"'s account was deleted.
- **Expected:**
  - The query filters `!f.IsArchived && f.FundingAccountId != null` and matches only to existing owned accounts. "OldGoal" no longer counts toward Joint Savings' "In jars"; "Orphan" (dangling `FundingAccountId`) simply doesn't appear against any account. The Float rises accordingly.
- **Automated:** No

### ACCT-048 - Negative float (shortfall) renders in rose
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** acct-owner; an account with balance 100.00 backs jars whose opening + tracked total is 250.00.
- **Steps:**
  1. Read that account's Float cell.
- **Expected:**
  - Float = 100 − 250 = **−€150.00**, shown in rose (`fromAmount(r.float) < 0`) — the account holds less than its jars claim.
- **Automated:** No

### ACCT-049 - Reconciliation cells format in the account's own currency
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #168 / reconciliation currency looked up client-side by `accountId` (the DTO carries no currency)
- **Preconditions:** acct-owner; a GBP account backs a jar; `preferredCurrency` EUR.
- **Steps:**
  1. Read that account's reconciliation row.
- **Expected:**
  - Balance / In jars / Float all format in **GBP** via `currencyById[r.accountId] ?? heroCurrency`, not EUR. (Deferred known limitation: the Float mixes an account-currency balance with a base-currency jar total because `JarBalances` applies `ExchangeRate` while `AccountBalances` does not — do not report as a new bug, but it must not regress further.)
- **Automated:** No

### ACCT-050 - A failed reconciliation fetch fails silently and leaves the last table
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** acct-owner; a reconciliation table is already showing; force `GET /accounts/reconciliation` to fail on the next refresh.
- **Steps:**
  1. Add or edit an account (which triggers a reconciliation re-fetch) with the endpoint failing.
- **Expected:**
  - The fetch's `.catch(() => {})` swallows the error — no error banner; the previously loaded rows remain (may be stale) and the page stays usable.
- **Automated:** No

## Display order & ordering

### ACCT-051 - New accounts get DisplayOrder max+1 (first = 0); list sorts by DisplayOrder then Name
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** acct-owner; a fresh household with zero accounts.
- **Steps:**
  1. Create "Alpha", then "Bravo", then "Charlie".
  2. Read `GET /accounts` order.
- **Expected:**
  - DisplayOrder assigned max(existing)+1: Alpha 0, Bravo 1, Charlie 2 (first is 0 via −1+1). The list (and reconciliation) sort by DisplayOrder then Name. There is no reorder UI; order is fixed at create time. Two accounts sharing a DisplayOrder tie-break on Name.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountsTests.cs — create orders after existing)

## Roles, feature flags & ownership

### ACCT-052 - Read-only and Limited members see a read-only register (no add/edit/delete)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** acct-limited (Limited) and acct-readonly (ReadOnly) each signed in on `/accounts` in the shared household.
- **Steps:**
  1. As each, inspect the page for write affordances.
- **Expected:**
  - Neither sees "+ Add account", the "✎"/"✕" buttons, the add modal or the delete modal (`canWrite` = role ≤ Admin). They still see the hero, cards and reconciliation, and can open account detail pages.
- **Automated:** Partial (client/src/pages/RoleGating.test.tsx — Limited cannot manage accounts: no "Account name" form, no "Edit <account>"; Owner has full management)

### ACCT-053 - Account create/update/delete by a Limited or Read-only login is refused server-side (403)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** acct-limited / acct-readonly with valid JWTs.
- **Steps:**
  1. As each, call `POST /api/accounts` (and `PUT`/`DELETE`) directly.
- **Expected:**
  - `AuthorizationBehaviour` requires Admin+ for `*Command` types without `[AllowLimited]`; the three account commands carry none → **403** "Your access level ({role}) does not permit this action." Nothing is created/changed. (Contrast: transfers are `[AllowLimited]` — see 11-transfers.md TRF-039.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Auth/AuthorizationBehaviourTests.cs — ReadOnly blocked from commands; Limited only AllowLimited commands)

### ACCT-054 - Accounts feature flag OFF: nav hidden, routes unregistered, API 404
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** server `Features:Accounts=false`.
- **Steps:**
  1. Sign in; look for the "Accounts" nav item; navigate to `/accounts` by URL; call `GET /api/accounts`.
- **Expected:**
  - The "Accounts" nav entry is gone (`features.accounts`); `/accounts` and `/accounts/:id` routes are unregistered so the URL falls through the `*` catch-all → redirect to `/`; the whole `AccountsController` (`[FeatureGate]`) returns a bare **404** (no body).
- **Automated:** Partial (client/src/components/AppNav.test.tsx — Accounts hidden when the flag is off)

### ACCT-055 - Feature-flag desync: client assumes all-on, server still 404s
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `GET /features` fails (so the client keeps its all-on default) while the server has `Features:Accounts=false`.
- **Steps:**
  1. Sign in; navigate to `/accounts`.
- **Expected:**
  - The client shows the Accounts page (flag defaulted on) but its `GET /accounts` returns 404 → the page lands on "Could not load your accounts." This UI/API mismatch is a known edge; the server is authoritative.
- **Automated:** No

### ACCT-056 - Acting on another household's account → 403 (existing) or 404 (unknown)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** acct-owner signed in (household "Ledger House"); acct-other owns "Foreign" in another household.
- **Steps:**
  1. `PUT /api/accounts/{ForeignId}` (and `DELETE`).
  2. `PUT /api/accounts/{randomGuid}`.
- **Expected:**
  - Foreign account exists but `account.OwnerId != userId` → **403** (`ForbiddenAccessException`). Unknown id → **404** "Account {id} was not found." All read/write handlers scope by `ICurrentUser.OwnerId`, so the foreign account never appears in this household's `GET /accounts` either.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountsTests.cs — owner-scoping)

### ACCT-057 - Server currency validation: any 3 letters pass; non-3-letter is rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** acct-owner; valid JWT.
- **Steps:**
  1. `POST /api/accounts {name, type, currency:"zzz", openingBalance:0}`.
  2. `POST /api/accounts {..., currency:"EURO"}` and again `currency:""`.
- **Expected:**
  - "zzz" passes the regex `^[A-Za-z]{3}$` (no ISO-list check by design) and is stored upper-cased "ZZZ"; `Intl.NumberFormat` renders it generically. "EURO" (4 letters) and "" fail → 400 "Currency must be a 3-letter ISO 4217 code." / "An account needs a currency." (The picker is a shortlist; the engine accepts any 3-letter code.)
- **Automated:** No

### ACCT-058 - A genuinely dead session on a long-lived accounts tab prompts a fresh sign-in
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** acct-owner with `/accounts` open; the session is then revoked server-side (logout/security-stamp rotation elsewhere).
- **Steps:**
  1. Leave `/accounts` open; on the next fetch/refresh cycle observe the outcome.
- **Expected:**
  - A truly dead session lands the login prompt (`/login?reason=expired&…`, "Your session has expired"), not a silently broken accounts view; the 30s refresh-replay grace (PR #171) must not evict a still-valid shared cookie. Full session-lifecycle assertions live in 03-session-auth-lifecycle.md — this case only guards that the accounts page participates correctly.
- **Automated:** No (session behaviour covered by client/e2e-journey/session-expiry.spec.ts, but not from the accounts tab)
