# Transfers (dedicated transfer flow, signed rows, balance-only effect, injection guard)

**ID prefix:** TRF | **Scope:** Everything about moving money between two of the household's own accounts through the ONLY supported path — the TransactionsPage add-modal "Transfer" mode (`/transactions`) that posts `POST /api/transactions/transfer` and records a SINGLE `Type=Transfer` row (`AccountId` = source, `TransferAccountId` = destination, `Currency` stamped from the source account; never `FxPending` — there is no exchange rate since W08). Covers: reaching the transfer form (the "Entry type" segmented control only exists with ≥2 accounts), the Date / Amount / From / To / Note fields and their exact aria-labels, client pre-submit validation (non-positive amount, missing source/destination, same account) and its exact strings, amount parsing/boundaries, the server `CreateTransferCommandValidator`/handler rules incl. the **cross-currency guard** (since W08 only reachable with legacy data — the app refuses to create an account in another currency than the budget's), how a transfer renders in the main register (unsigned grey, brand **Transfer** badge, `{from} → {to}` account cell, NO edit/split affordance, delete present) and in the single-account detail register (**signed by direction**, `(removed account)` fallback), the money-integrity invariant that a transfer moves BOTH account balances by the raw amount but contributes **0** to budget actuals / the hero money-in/out / allocation, deleting a transfer (immediate, un-confirmed; account-delete is refused while a transfer points at the account), and the **regression guards** that block a bare `Type=Transfer` on `POST/PUT /api/transactions` and clear a dangling counterparty when a real transfer is re-typed, plus (W07, TRF-041..045) editing a transfer in place via `PUT /api/transactions/{id}/transfer` (statement-confirmed legs keep the bank's values), marking a transfer returned, and transfer fees (a separate expense row on the source, changed only through its transfer). | **Out of scope:** manual income/expense create, inline edit, split, assign, auto-categorization, the register All/Unassigned filter and the hero money-in/out totals themselves → **transactions file** (this file only asserts transfers are excluded from them); account CRUD, the accounts hero/`Available` tile, per-account currency display rules, jar reconciliation and the account-detail page's non-transfer behavior → **accounts file**; jar accrual and the allocation engine that a transfer must NOT feed → **jars & allocation file**; marking an imported statement row as a transfer during commit (`CreateTransfer`-adjacent but a different flow) → **import file**; silent-refresh / cross-tab-logout races on a long-lived transactions tab (#169/#171) → **03-session-auth-lifecycle.md**; the full Owner/Admin/Limited/ReadOnly matrix across every page → **households & roles file** (this file covers only the transfer-action gating); dark-mode / responsive / a11y sweeps of the modal and registers → **cross-cutting file**. **Do not test for:** an edit affordance on a transfer row (there is none), a delete-confirmation dialog on the register (delete is immediate — only account delete got a modal), a two-row transfer model (it is one row carrying two bank legs — `departedOn`/`receivedOn` — and a statement reference per side), a Transfer option in the transaction **Type** select (Expense/Income only), or a Member field on the transfer form (transfers carry no member attribution).

**Test data setup:** Local stack (API :5099, `ASPNETCORE_ENVIRONMENT=Development`) or staging (staging.allotjar.com). Assumed **today = 2026-07-16** (July 2026 = current month). Locale **en-GB comma-dot** so money renders `€1,234.56`; default currency **EUR**. Feature flags default **ON** (`accounts`, `multiCurrency`). Passwords random `Aa1-<uuid>` (HIBP rejects fixed common ones). Money is integer minor units scale 4 client-side, `decimal(18,4)` server-side; max amount **99,999,999,999,999.9999**. Logins in household **"Move-It"** (owner **trf-owner@example.test**): two EUR accounts **"Current"** (type Current, opening **2,000.00**) and **"Pot"** (type Savings, opening **500.00**); one GBP account **"UK Card"** (type Credit card, currency **GBP**, opening 0.00) for cross-currency cases — **legacy data only**: since W08 `POST /api/accounts` refuses any currency but the household's budget currency (EUR here), so seed it directly in the database or use a household that held it before the `ForeignAmounts` migration. Members of the same household: **trf-limited@example.test** (role Limited) and **trf-readonly@example.test** (role ReadOnly) — note account CRUD is Admin+, so these two rely on the pre-existing accounts. **trf-solo@example.test** owns a household with **one** account ("Only") for the 1-account case and can be emptied to **zero** accounts. A second household (owner **trf-other@example.test**) owns account **"Foreign"** for cross-household ownership checks. Automation hint: the transfer POST returns **201** + the full `TransactionDto` (single row, `type: 2`); the client never surfaces server field errors — every API failure on this form maps to the fixed string **"Could not record that transfer."**

## Opening the transfer flow

### TRF-001 - Open the transfer form when the household has two or more accounts
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** trf-owner signed in on `/transactions`; accounts "Current" and "Pot" exist (≥2).
- **Steps:**
  1. Click **"+ Add transaction"** (aria-label "Add transaction").
  2. In the modal, observe the **"Entry type"** segmented control (labels **Transaction** | **Transfer**).
  3. Click **Transfer**.
- **Expected:**
  - The segmented control renders (it is gated on `accounts.length >= 2`).
  - Modal title switches from "Add a transaction" to **"Record a transfer"**.
  - Fields shown: **Date**, **Amount**, **From** (select, first option "Choose…"), **To** (select, first option "Choose…"), **Note** (placeholder "Transfer"); buttons **Cancel** and **Record transfer**. No **Type**, **Category** or **Member** field appears.
  - Any prior form error is cleared on the mode switch.
- **Automated:** Partial (client/src/pages/TransactionsPage.test.tsx — records a transfer through this form)

### TRF-002 - One account: the transfer mode is unreachable in the UI
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** trf-solo signed in with exactly one account "Only".
- **Steps:**
  1. Click **"+ Add transaction"**.
  2. Inspect the modal for an "Entry type" control.
- **Expected:**
  - No "Entry type" segmented control (gated on `accounts.length >= 2`); the modal opens directly in transaction mode titled "Add a transaction".
  - There is no way to open the transfer form; the **Account** select shows "No account" + "Only".
- **Automated:** No

### TRF-003 - Zero accounts: no transfer mode and no account select
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** trf-solo with all accounts removed (zero accounts).
- **Steps:**
  1. Click **"+ Add transaction"** and inspect the modal.
- **Expected:**
  - No "Entry type" control (transfer unreachable) and no **Account** select at all (that field renders only when `accounts.length > 0`).
  - Only Type/Date/Payee/Amount (+ Category for Expense) are shown.
- **Automated:** No

### TRF-004 - Read-only member cannot open the transfer form
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** trf-readonly signed in on `/transactions`; household has ≥2 accounts.
- **Steps:**
  1. Observe the toolbar; attempt to record a transfer.
- **Expected:**
  - No **"+ Add transaction"** button (rendered only when `canEnterData`, i.e. Limited+), so the modal and transfer form are unreachable.
  - The AppShell shows the read-only banner "You have read-only access — you can view everything but cannot make changes." Any direct `POST /api/transactions/transfer` would 403 (see TRF-039).
- **Automated:** Partial (client/src/pages/RoleGating.test.tsx — ReadOnly hides transaction-entry controls)

## Recording a transfer

### TRF-005 - Record a same-currency transfer between two accounts
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** trf-owner on `/transactions`; "Current" (EUR, balance 2,000.00) and "Pot" (EUR, balance 500.00), no other transactions.
- **Steps:**
  1. Open the transfer form (TRF-001).
  2. Amount **300.00**, From **Current**, To **Pot**, leave Note blank.
  3. Click **Record transfer**.
- **Expected:**
  - The **I've completed this transfer** checkbox (aria "Transfer completed confirmation") must be ticked, else the client blocks with "Confirm that you’ve completed this transfer before recording it." and sends nothing (rule 7).
  - `POST /api/transactions/transfer` body `{departedOn: "2026-07-16", receivedOn: null, amount: 300, fromAccountId: <Current>, toAccountId: <Pot>, payee: null}` → **201** with a single `TransactionDto` `type: 2`, `currency: "EUR"`, `fxPending: false`, `accountId` = Current, `transferAccountId` = Pot, `departedOn` = the date, `receivedOn` null, `transferStatus: "InTransit"`. Filling the optional **Transfer receipt date** sends `receivedOn` and yields `"Completed"`; a receipt before the departure is blocked client- and server-side.
  - The new row is prepended to the register with an **In transit** badge and a **Confirm receipt** action; analytics `transfer_created` fires; the modal closes.
  - On `/accounts`, Current now reads **€1,700.00** with **€300.00 in transit out**; Pot still reads **€500.00** with €300.00 in transit in until the receipt is confirmed (rules 69/71), after which Pot reads **€800.00** (net across the two €2,500.00 once both legs post).
- **Automated:** Yes (client/src/pages/TransactionsPage.test.tsx — record transfer; TransactionsPage.catalog.test.tsx — departure/receipt/confirmation contract and inline leg confirmation; tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — moves balance source→destination with an explicit receipt; Application/AccountLedgerActivationTests.cs — departure, transit and confirmed receipt on their own dates)

### TRF-006 - A custom Note becomes the transfer row's payee
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** trf-owner; transfer form open.
- **Steps:**
  1. Amount 50.00, From Current, To Pot, Note **"Rent buffer"**.
  2. Click **Record transfer**.
- **Expected:**
  - Body `payee: "Rent buffer"`; the server trims it and stores it as `Payee`.
  - The register Payee cell shows **"Rent buffer"** (not the default "Transfer"); the Category cell still shows the brand **Transfer** badge.
- **Automated:** No

### TRF-007 - Blank or whitespace-only Note defaults the payee to "Transfer"
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** trf-owner; transfer form open.
- **Steps:**
  1. Case A: leave Note empty → Record transfer.
  2. Case B: set Note to three spaces "   " → Record transfer.
- **Expected:**
  - Case A: client sends `payee: null` (`tPayee || null`); handler stores **"Transfer"**.
  - Case B: client sends `payee: "   "`; the handler's `string.IsNullOrWhiteSpace` check still stores **"Transfer"** (not the spaces).
  - Both register rows show Payee **"Transfer"**.
- **Automated:** No

### TRF-008 - Enter key in the Amount field submits the transfer
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** trf-owner; transfer form open with valid From/To chosen.
- **Steps:**
  1. Focus **Amount** (aria-label "Transfer amount"), type 25.00, press **Enter**.
- **Expected:**
  - `addTransfer` runs (the input's `onKeyDown` calls it on Enter) — same result as clicking **Record transfer**; a row is created.
- **Automated:** No

### TRF-009 - After a successful transfer the amount and note clear but From/To/Date persist
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** trf-owner; transfer form open.
- **Steps:**
  1. Record a transfer (Amount 40.00, From Current, To Pot, Note "X").
  2. Re-open the transfer form and inspect the fields.
- **Expected:**
  - On success the handler clears **Amount** and **Note** only (`setTAmount('')`, `setTPayee('')`) and closes the modal; **Date**, **From**, **To** state are retained for a quick repeat.
  - Re-opening shows From still "Current", To still "Pot", Date still 2026-07-16, Amount and Note empty.
- **Automated:** No

### TRF-010 - Transfer date defaults to today and accepts any past/future/31st date
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open.
- **Steps:**
  1. Observe the default **Date**.
  2. Set Date to **2026-01-31**, record a transfer; then set Date to a future **2027-12-25**, record another.
- **Expected:**
  - Default Date = today via `new Date().toISOString().slice(0,10)` (UTC — may read as "yesterday" late evening in UTC+ zones; known quirk).
  - The date input has no min/max clamp; the 31st and a future date are both accepted and stored verbatim as `DateOnly`. Register order is Date-desc so the future row sorts to the top.
- **Automated:** No

## Client-side amount & account validation

### TRF-011 - Zero amount is blocked client-side with no API call
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open with From/To chosen.
- **Steps:**
  1. Amount **0** (or 0.00), click **Record transfer**.
- **Expected:**
  - `parseMinor("0") = 0`, `<= 0` → error banner **"Enter a valid transfer amount greater than zero."** inside the modal; no `POST /transactions/transfer` is sent.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — server validator rejects non-positive; the client short-circuit is untested)

### TRF-012 - Negative, empty, and whitespace-only amounts are all blocked client-side
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open with From/To chosen.
- **Steps:**
  1. Amount **-50** → Record transfer.
  2. Amount empty → Record transfer.
  3. Amount **"   "** (spaces only) → Record transfer.
- **Expected:**
  - All three: `parseMinor` returns `null` (negatives rejected; empty/whitespace strip to "") → same error **"Enter a valid transfer amount greater than zero."**; no API call for any.
- **Automated:** No

### TRF-013 - Missing source or destination is blocked
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** trf-owner; transfer form open; a valid Amount entered.
- **Steps:**
  1. Leave **From** on "Choose…" (or **To** on "Choose…"), click **Record transfer**.
- **Expected:**
  - Client error **"Choose both a source and a destination account."** (checked after the amount check, before the same-account check); no API call.
- **Automated:** No

### TRF-014 - Same source and destination account is blocked client-side
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** trf-owner; transfer form open; valid Amount.
- **Steps:**
  1. Set **From = Current** and **To = Current**, click **Record transfer**.
- **Expected:**
  - Client error **"A transfer needs two different accounts."** (`tFrom === tTo`); no `POST /transactions/transfer` is sent (belt-and-braces against the server rule in TRF-035).
- **Automated:** Yes (client/src/pages/TransactionsPage.test.tsx — same-account transfer blocked client-side without an API call)

### TRF-015 - A rejected transfer surfaces the generic error and adds no row
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** trf-owner; transfer form open; force the POST to fail (e.g. server 400 from an out-of-range amount, or offline). The cross-currency 400 used to be the natural trigger; since W08 no household can create an account in another currency (TRF-021), so use the over-max amount or a network drop.
- **Steps:**
  1. Enter values that pass client checks but fail the server (see TRF-018 over-max, or a network drop), click **Record transfer**.
- **Expected:**
  - The `catch` shows the server's own 400 field message(s) when there are any (`serverErrors`), else the fixed string **"Could not record that transfer."** (network drop / 5xx), in the modal banner; the modal stays open; the row is only ever prepended on success, so no phantom/optimistic row is left behind and no balance moves.
- **Automated:** No

## Amount parsing & boundaries

### TRF-016 - European and dot decimal formats both parse to the same amount
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open; From Current, To Pot.
- **Steps:**
  1. Amount **"2.500,00"** → Record transfer.
  2. Amount **"1,234.56"** → Record transfer.
- **Expected:**
  - `parseMinor` treats the right-most of "," / "." as the decimal separator and strips the other as grouping: "2.500,00" → 2500.0000, "1,234.56" → 1234.5600. Both transfers post the parsed decimal; the rows format back as €2,500.00 and €1,234.56.
- **Automated:** No

### TRF-017 - More than four decimal places rounds half-up to 4 dp
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open.
- **Steps:**
  1. Amount **"10.12345"** → Record transfer.
- **Expected:**
  - `parseMinor` rounds HALF-UP on the 5th decimal → 10.1235 (minor 101235); the POST sends `amount: 10.1235`. (Money is scale-4 throughout; no float drift.)
- **Automated:** No

### TRF-018 - Amount at the max boundary is accepted; over the max is a server range error
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open; From Current, To Pot.
- **Steps:**
  1. Amount **99,999,999,999,999.9999** → Record transfer (expect success).
  2. Amount **100,000,000,000,000** → Record transfer.
- **Expected:**
  - Step 1: within `LessThanOrEqualTo(99_999_999_999_999.9999)` → 201.
  - Step 2: the client has no upper bound, so it POSTs; server validator returns 400 **"Transfer amount is out of range."**, which the client shows only as the generic **"Could not record that transfer."**; no row, no balance change.
- **Automated:** No

### TRF-019 - Note longer than 200 characters is rejected by the server
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open; valid amount/accounts.
- **Steps:**
  1. Paste a 201-character Note, click **Record transfer**.
- **Expected:**
  - The client has no note-length check, so it POSTs; `CreateTransferCommandValidator` `Payee.MaximumLength(200)` → 400; client shows **"Could not record that transfer."**; no row created.
- **Automated:** No

### TRF-020 - Unicode / emoji note is preserved on the row
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** trf-owner; transfer form open.
- **Steps:**
  1. Note **"café ✈️ 送金"** (≤200 chars), Amount 10.00, From Current, To Pot → Record transfer.
- **Expected:**
  - Stored and rendered verbatim (trimmed) as the Payee cell "café ✈️ 送金"; the Transfer badge and `{from} → {to}` cell are unaffected.
- **Automated:** No

## Cross-currency transfer guard

### TRF-021 - No cross-currency transfer can exist: an account in another currency is refused, and the transfer guard still holds for legacy data
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 / cross-currency transfer used to silently change net worth (£100 credited for €100 debited); W08 (rule 63) — every account is now in the budget currency, so the transfer guard is only reachable with legacy data
- **Preconditions:** trf-owner (EUR budget) with two EUR accounts, e.g. "Euro Main" and "Euro Pot" (opening 100.00 each), no transactions; for step 3 a legacy GBP "UK Card" (see Test data setup).
- **Steps:**
  1. Open **+ Add account** on `/accounts`: confirm there is no currency picker (the form says "The account holds EUR, your budget currency.").
  2. `POST /api/accounts` directly with `{name: "Dollar Stash", type: 0, currency: "USD", openingBalance: 100, openingDate: "2026-01-01"}`.
  3. (Legacy data only) open the transfer form, Amount 100.00, From **Current** (EUR), To **UK Card** (GBP), tick the completed confirmation, Record transfer.
  4. Revisit `/accounts` and both EUR accounts' detail pages.
- **Expected:**
  - Step 2: **400**, `Currency` → **"This budget is in EUR, so its accounts are too. A bank converts payments in other currencies into EUR itself."**; no "Dollar Stash" card appears.
  - Step 3: handler throws `ValidationException` keyed `ToAccountId`: **"Both accounts must use the same currency to transfer between them."** → 400; the client shows that server message in the modal banner (`serverErrors`). (`CurrencyCode` is a record → `!=` is value equality.)
  - No transaction is created; Euro Main and Euro Pot read exactly **100.00** with "No transactions on this account yet."; UK Card is unchanged.
- **Automated:** Yes (client/e2e-journey/transfers-balances.spec.ts — "client-side transfer validation blocks bad input without an API call, and an account in another currency is refused, so no cross-currency transfer can exist" (steps 1–2, 4 on the real stack); tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs — `A_new_account_must_be_in_the_budget_currency`; tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — cross-currency transfer rejected and moves nothing (step 3))

### TRF-022 - A valid transfer is stamped in the source account's currency, not hardcoded EUR
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 / transfer currency was hardcoded EUR before the source-currency stamp
- **Preconditions:** trf-owner with two **GBP** accounts (e.g. "UK Card" and a second GBP "UK Savings") — legacy data in an EUR budget (the app no longer creates them), or a household whose budget currency is GBP.
- **Steps:**
  1. Transfer 75.00 from UK Card to UK Savings; inspect the returned DTO / register row.
- **Expected:**
  - The stored `Currency` = the source account's currency **GBP** (`from.Currency`) and the row is not `FxPending` (a transfer never waits for a budget-currency amount, even in a non-budget currency — `ForeignAmountsTests.A_transfer_never_waits`); the register formats the amount as **£75.00**, matching both accounts. No EUR mislabel.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — currency stamped from source, not hardcoded EUR)

## Signed transfer rows & display

### TRF-023 - Main register: a transfer is unsigned grey with a Transfer badge and a "from → to" cell
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** trf-owner; a Current→Pot transfer of 300.00 exists.
- **Steps:**
  1. On `/transactions`, find the transfer row.
- **Expected:**
  - Payee cell: the note, else **"Transfer"**; no **Bill** tag.
  - Category cell: brand **Transfer** `Badge` with NO assign/reassign affordance.
  - Account cell: **"Current → Pot"** (`{accountName ?? '—'} → {transferAccountName ?? '—'}`).
  - Amount cell: **no sign**, muted grey (`text-slate-500`), formatted `€300.00` in the row's own `t.currency`. (Contrast: income `+`, expense `−`.)
- **Automated:** No

### TRF-024 - Main register: no transaction edit or split affordance on a transfer row; delete is present
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** trf-owner; a transfer row exists; hover/focus the row.
- **Steps:**
  1. Reveal the row hover actions.
- **Expected:**
  - The **✎** "Edit transaction: …" and **⑂** "Split transaction: …" buttons are NOT rendered (gated `!isTransfer`). Since W07 a transfer row instead has its own **✎** "Edit transfer: {note or date}" button (see TRF-041); there is still no inline-edit or split editor path.
  - The **✕** "Delete transaction: {note or date}" button IS rendered (delete applies to all rows).
- **Automated:** No

### TRF-025 - Account detail register: a transfer is signed by direction in each account
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** trf-owner; a Current→Pot transfer of 300.00 exists.
- **Steps:**
  1. Open `/accounts/{Current}`; find the transfer row.
  2. Open `/accounts/{Pot}`; find the same transfer row.
- **Expected:**
  - The row appears in both registers (filter is `accountId === id || transferAccountId === id`).
  - On **Current** (source, `accountId === id`): amount shows **−€300.00** (muted slate), Category cell "Current → Pot".
  - On **Pot** (destination): amount shows **+€300.00**, Category cell "Current → Pot".
  - Amount formats in the transaction's `t.currency`. The detail page is read-only (no edit/delete/transfer controls).
- **Automated:** No

### TRF-026 - Deleted counterparty renders "(removed account)" on detail and "—" on the main register
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 / signed single-account rows + "(removed account)" fallback
- **Preconditions:** trf-owner; a Current→Pot transfer exists; then **Pot** (destination) is deleted (via the accounts delete-confirm modal).
- **Steps:**
  1. On `/transactions`, inspect the surviving transfer row's Account cell.
  2. On `/accounts/{Current}`, inspect the row's Category cell.
- **Expected:**
  - The transfer row survives the account delete (DeleteAccount nulls `TransferAccountId`; the row is kept).
  - Main register Account cell: **"Current → —"** (null `transferAccountName`).
  - Current's detail Category cell: **"Current → (removed account)"**; the amount still shows **−€300.00** (Current keeps its transfer-out; Pot's credit is gone with Pot).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — DeleteAccount clears the pointer and keeps the transaction; the UI fallback strings are untested)

### TRF-027 - A transfer is excluded from the register hero money-in / money-out and unassigned count
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** trf-owner; register has one Income tx (+500), one Expense tx (−120), and one Current→Pot transfer (300).
- **Steps:**
  1. On `/transactions`, read the hero and the toolbar count.
- **Expected:**
  - Hero **Money in** = +€500.00 (Income only), **Money out** = €120.00 (Expense only) — the transfer contributes to neither.
  - **Unassigned** tile counts non-transfer, non-split, unassigned rows only; the transfer is not counted (it never appears in the assign flow).
  - The "{n} transactions" count DOES include the transfer (it counts all loaded rows).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — a transfer never counts as income; the client hero totals are untested)

## Money integrity — balances vs budget & allocation

### TRF-028 - A transfer moves both balances by the raw amount and leaves budget actuals and allocation untouched
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** trf-owner; Current 2,000.00, Pot 500.00; a current-month budget with an expense line "Groceries" (planned 400.00, spent 0) and an income line.
- **Steps:**
  1. Transfer 300.00 Current→Pot.
  2. Check both account balances, the dashboard budget actuals, and the allocation preview.
- **Expected:**
  - `AccountLedgerReader`: with the receipt confirmed on the same day, Current = 2,000 − 300 = **1,700.00**; Pot = 500 + 300 = **800.00**; net across all accounts unchanged (raw `Amount`; there is no exchange rate). With the receipt still unknown, Pot stays 500.00 and the 300.00 is reported as in transit on both accounts.
  - `BudgetActuals`: no line's actual changes — the transfer is excluded (Groceries stays 0.00); the dashboard "Remaining to budget" and every line's spent are unaffected.
  - The allocation engine (income split / waterfall) is driven by budget totals, not by transfers, so its preview is unchanged. Splits would not matter here anyway — the whole amount moves the account.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — balance move + not counted as income; net/allocation invariance not asserted)

### TRF-029 - A transfer force-assigned to a budget line via API still contributes zero to actuals
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** trf-owner; an existing transfer row; an expense line "Groceries".
- **Steps:**
  1. Call `PUT /api/transactions/{transferId}/assignment {budgetItemId: <Groceries>}` (the assign endpoint has no type check).
  2. Re-read the budget actuals.
- **Expected:**
  - The assignment is accepted (200) but `BudgetActuals` groups by `(BudgetItemId, Type)` and only counts a line's own kind from Expense/Income rows — a `Type=Transfer` row contributes **0** to Groceries. The pill may show but no money lands. (This mismatched-assign quirk is owned by the transactions file; here it confirms transfers stay balance-only.)
- **Automated:** No

## Deleting a transfer

### TRF-030 - Delete a transfer immediately (no confirmation) and both balances revert
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** trf-owner; Current 1,700.00, Pot 800.00 after a 300.00 transfer.
- **Steps:**
  1. On `/transactions`, hover the transfer row and click **✕** ("Delete transaction: …").
- **Expected:**
  - `DELETE /api/transactions/{id}` → 204 with NO confirmation dialog (contrast: account delete has a modal); the row is removed from the register; analytics `transaction_deleted` fires.
  - Balances revert: Current back to **2,000.00**, Pot back to **500.00**. Any splits would cascade, but a transfer has none.
- **Automated:** Partial (client/src/pages/TransactionsPage.test.tsx — delete a transaction; transfer-specific balance revert not asserted)

### TRF-031 - Deleting either account of a transfer is refused and leaves the transfer intact
- **Priority:** P1
- **Type:** Regression
- **Origin:** Activation slice 1 (rules 51/69): a transfer is one movement with a bank leg and a statement reference on each side, so clearing a pointer would leave a half-movement the dated ledger cannot read. Supersedes the earlier "clear the pointer, keep the row" behaviour.
- **Preconditions:** trf-owner; a Current→Pot transfer exists; try to delete the **source** account "Current" (the destination behaves the same).
- **Steps:**
  1. Delete "Current" via the accounts delete-confirm modal ("Delete account").
- **Expected:**
  - `DELETE /api/accounts/{id}` → **400** with `errors.Id` = "'Current' is a side of 1 transfer. Delete or re-record those transfers before deleting the account."; the Accounts page shows that message. Both accounts, the transfer row, both pointers and both balances are unchanged.
  - Accounts with only income/expense transactions still delete as before (those transactions lose their account tag).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — DeleteAccount_IsRefused_WhileATransferPointsAtIt; TTransfersCoverageTests.cs — DeletingTheSourceAccount_IsRefused_AndLeavesTheTransferIntact)

## Type=Transfer API injection & counterparty integrity

### TRF-032 - POST /api/transactions with Type=Transfer is rejected
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 / a bare `Type=Transfer` create was a destination-less transfer that vanished money from derived balances
- **Preconditions:** trf-owner; a valid JWT; account "Current".
- **Steps:**
  1. `POST /api/transactions {date, payee:"x", amount: 100, type: 2, accountId:<Current>}`.
- **Expected:**
  - `CreateTransactionCommandValidator` `Must(t => t != Transfer)` → 400 **"Use the transfer action to move money between accounts."**; nothing is created. (The UI never sends `type: 2` — the Type select offers only Expense/Income — so this only guards direct API misuse.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/ManualTransactionTests.cs — Transfer-type validator rejection)

### TRF-033 - PUT /api/transactions/{id} with Type=Transfer is rejected
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 / editing a row into a destination-less transfer would vanish money
- **Preconditions:** trf-owner; an existing income/expense transaction.
- **Steps:**
  1. `PUT /api/transactions/{id} {date, payee, amount, type: 2}`.
- **Expected:**
  - `UpdateTransactionCommandValidator` rejects Transfer → 400 **"Use the transfer action to move money between accounts."**; the row is unchanged.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/UpdateTransactionTests.cs — validator rejects Transfer type)

### TRF-034 - Re-typing a real transfer to Expense/Income clears the dangling counterparty
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 / a stale `TransferAccountId` kept phantom-crediting the old destination
- **Preconditions:** trf-owner; a stored Current→Pot transfer row (`AccountId`=Current, `TransferAccountId`=Pot).
- **Steps:**
  1. `PUT /api/transactions/{id} {date, payee, amount, type: 1 (Income), accountId:<Current>}` (a non-transfer type, which the validator allows).
- **Expected:**
  - The update succeeds and the handler nulls `TransferAccountId` on any non-transfer edit, so the row becomes a clean Income with no phantom counterparty credit. Pot no longer receives a +transferIn from this row; balances recompute cleanly.
  - (There is no UI path to this — the register has no edit affordance on transfer rows — so this guards API-driven edits only.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/UpdateTransactionTests.cs — re-typing a transfer clears the dangling counterparty)

## API validation, roles & ownership

### TRF-035 - Server rejects a same-account transfer
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** trf-owner; account "Current".
- **Steps:**
  1. `POST /api/transactions/transfer {date, amount: 50, fromAccountId:<Current>, toAccountId:<Current>}`.
- **Expected:**
  - `CreateTransferCommandValidator` `ToAccountId.NotEqual(FromAccountId)` → 400 **"Choose two different accounts for a transfer."**; nothing created.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — validator rejects same-account)

### TRF-036 - Server rejects a non-positive transfer amount
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** trf-owner; accounts Current and Pot.
- **Steps:**
  1. `POST /api/transactions/transfer {amount: 0, ...}` and again `{amount: -5, ...}`.
- **Expected:**
  - `Amount.GreaterThan(0)` → 400 **"A transfer amount must be greater than zero."** for both; nothing created.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — validator rejects non-positive)

### TRF-037 - Unknown / missing account id → 404
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** trf-owner; account "Current" exists.
- **Steps:**
  1. `POST /api/transactions/transfer {amount:10, fromAccountId:<Current>, toAccountId:<random Guid>}`.
  2. Then send a random `fromAccountId` with a valid `toAccountId`.
- **Expected:**
  - The handler looks up `from` then `to`; a missing account → `NotFoundException` **"Account {id} was not found."** (404) — the from is checked first, then the to. Nothing is created. (Empty-Guid ids are caught earlier by the `NotEmpty` validators as 400.)
- **Automated:** No

### TRF-038 - Cross-household account id → 403 (ownership), not 404
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** trf-owner signed in (active household "Move-It"); trf-other owns account "Foreign" in another household.
- **Steps:**
  1. `POST /api/transactions/transfer {amount:10, fromAccountId:<Current>, toAccountId:<Foreign>}`.
- **Expected:**
  - Both accounts are found, but `to.OwnerId != userId` → `ForbiddenAccessException` → 403 (existence revealed, per the "cross-owner on an existing row → 403, not 404" convention). Nothing moves. The active household is `ICurrentUser.OwnerId`, so the same login acting in a different household would scope differently.
- **Automated:** No

### TRF-039 - Limited can transfer; Read-only is refused server-side
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** household with ≥2 accounts; trf-limited (role Limited) and trf-readonly (role ReadOnly).
- **Steps:**
  1. As trf-limited, record a transfer through the UI (the "+ Add transaction" button and transfer mode are available to Limited+).
  2. As trf-readonly, attempt `POST /api/transactions/transfer` directly (the UI gives no button).
- **Expected:**
  - Limited: `CreateTransferCommand` is `[AllowLimited]` → 201, the transfer is recorded (Limited cannot create accounts, but can move between existing ones).
  - ReadOnly: `AuthorizationBehaviour` → 403 **"Your access level (ReadOnly) does not permit this action."**; nothing created. (Full per-role matrix lives in the households & roles file.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AuthorizationBehaviourTests.cs — Limited runs AllowLimited commands, ReadOnly blocked; client/src/pages/RoleGating.test.tsx — UI entry gating)

### TRF-040 - Server rejects an empty or omitted account id (NotEmpty → 400, not a 404 lookup miss)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** trf-owner signed in (active household "Move-It"); account "Current" exists.
- **Steps:**
  1. `POST /api/transactions/transfer {date, amount: 10, fromAccountId: "00000000-0000-0000-0000-000000000000", toAccountId: <Current>}` (all-zero source Guid).
  2. `POST /api/transactions/transfer {date, amount: 10, toAccountId: <Current>}` — `fromAccountId` omitted, so the `CreateTransferRequest` record deserializes it to `Guid.Empty`.
- **Expected:**
  - Both requests fail `CreateTransferCommandValidator` `RuleFor(x => x.FromAccountId).NotEmpty()` (and symmetrically `.ToAccountId).NotEmpty()` for an empty destination) → **400** with the default FluentValidation message (field shown as **"From Account Id"** / **"To Account Id"** — validator carries no custom `.WithMessage` here). The client would surface only the generic **"Could not record that transfer."**
  - Validation runs in `ValidationBehaviour` **before** the handler, so the account lookups at `CreateTransferCommandHandler` never execute: an empty Guid never reaches the `NotFoundException` path that a random *non-empty* unknown id hits in TRF-037. Nothing is created; no balance moves.
- **Automated:** No

## Editing, returns and fees (W07)

### TRF-041 - Edit a transfer in place through "Edit transfer"
- **Priority:** P0
- **Type:** Happy
- **Origin:** W07 / `PUT /api/transactions/{id}/transfer`
- **Preconditions:** trf-owner; a manual 300.00 transfer Current → Pot dated 2026-07-16, no bank statement involved.
- **Steps:**
  1. Click **✎** "Edit transfer: Transfer" on the row; the modal is titled **Edit transfer**.
  2. Change the amount to 250.00, the note to "Holiday pot" and the receipt date to 2026-07-17; save.
- **Expected:** `PUT /api/transactions/{id}/transfer` (all fields replace what was stored) → **200**. The same row (same id, no second row) now shows 250.00, payee "Holiday pot", status Completed. Current is 2,000.00 − 250.00 and Pot 500.00 + 250.00 (was 300.00). Changing From/To account works too (both must share a currency; the old accounts' balances revert). A non-transfer id sent to the endpoint → **400** "Only a transfer can be edited here." Limited can edit; Read-only → **403**.
- **Automated:** Partial (TransferIdentityW07Tests.cs; TransactionsPage.catalog.test.tsx)

### TRF-042 - A leg confirmed by a bank statement keeps the bank's account, date and amount
- **Priority:** P0
- **Type:** Negative
- **Origin:** W07 / O1 answer 3
- **Preconditions:** A transfer Current → Pot whose departure was confirmed by an imported Current statement row (it carries that bank's reference), receipt not yet confirmed.
- **Steps:**
  1. Open **Edit transfer**; the departure account, departure date and amount are disabled with a statement-lock hint.
  2. Via the API, `PUT …/transfer` with a different `fromAccountId`, `departedOn` or `amount`.
  3. Edit only the receipt date and the note; save.
- **Expected:** Step 2 → **400** with "The departure is confirmed by a bank statement, so it keeps the bank's account it left / date (…) / amount (… including any fee)." per changed field. The same rule applies to the receipt (destination account, receipt date, amount) once a statement confirmed it, and to a statement-confirmed return date. Step 3 succeeds: only unconfirmed fields change.
- **Automated:** Partial (TransferIdentityW07Tests.cs)

### TRF-043 - Mark a transfer as returned: money comes back to the source, nothing stays in transit
- **Priority:** P0
- **Type:** Happy
- **Origin:** W07 / O1 answer 4
- **Preconditions:** A 300.00 transfer Current → Pot departed 2026-07-16, never received (in transit).
- **Steps:**
  1. **Edit transfer**, set **Returned on (optional)** to 2026-07-20; save.
  2. Repeat with a return date before the departure (2026-07-10).
  3. Repeat with a receipt date also filled in.
- **Expected:** Step 1: the row shows a **Returned** badge (tooltip "Sent back to Current on 20 Jul 2026"), status `Returned`; Current is back to 2,000.00, Pot unchanged at 500.00, and nothing is counted in transit. Step 2 → **400** "A transfer can only come back on or after the day it left." Step 3 → **400** "A transfer that was received can't also have been sent back. Clear the receipt date first." Clearing `returnedOn` puts the transfer back in transit.
- **Automated:** Partial (TransferLedgerTests.cs; TransferIdentityW07Tests.cs)

### TRF-044 - A transfer fee is a separate expense row on the source, on a budget line the user picks
- **Priority:** P0
- **Type:** Happy
- **Origin:** W07 / O1 answer 5
- **Preconditions:** July 2026 budget with an expense line "Bank fees". Current 2,000.00.
- **Steps:**
  1. Record a 300.00 transfer Current → Pot dated 2026-07-16 with **Transfer fee** 2.50 and **Transfer fee category** "Bank fees" (the category select appears only once a fee is entered).
  2. Edit the transfer: change the fee to 4.00; then clear the fee.
- **Expected:** `POST /api/transactions/transfer` with `fee` and `feeBudgetItemId` → 201. Two rows: the transfer (300.00, shows "+ fee 2.50" under the amount) and a separate expense row on Current, dated 2026-07-16 (the departure), payee "Fee: Transfer", tagged **Fee for transfer**, on "Bank fees". Current is debited 302.50; Pot receives 300.00; "Bank fees" actual shows 2.50 (the transfer itself still adds 0 to actuals). Step 2: the same fee row updates to 4.00, then is removed when the fee is cleared. Fee without a departure date → 400 "Add the departure date before recording a fee: the fee leaves the account when the money does." Negative fee → 400 "A fee can't be negative."; a fee line with no fee → 400 "Choose a line for the fee only when there is a fee."
- **Automated:** Partial (TransferIdentityW07Tests.cs; TransactionsPage.catalog.test.tsx)

### TRF-045 - A fee row can only be changed through its transfer
- **Priority:** P1
- **Type:** Negative
- **Origin:** W07
- **Preconditions:** The transfer with a fee from TRF-044.
- **Steps:**
  1. Look at the fee row's actions in the register.
  2. Via the API, `PUT /api/transactions/{feeId}`, `PUT /api/transactions/{feeId}/splits` and `DELETE /api/transactions/{feeId}`.
  3. Delete the transfer itself.
- **Expected:** Step 1: the fee row has no edit, split or delete buttons. Step 2: all three → **400** "This is a transfer's fee. Edit the transfer to change or remove it." and nothing changes. Step 3: deleting the transfer removes its fee row too and both balances revert (rule 74 is checked on the result).
- **Automated:** Partial (TransferIdentityW07Tests.cs)
