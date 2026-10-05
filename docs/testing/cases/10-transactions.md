# Transactions

**ID prefix:** TX | **Scope:** Recording and managing transactions on `TransactionsPage` (`/transactions`) and the behaviour their DTOs drive: the add modal in **Transaction** mode (Type Expense/Income/Refund, Date, Payee, Amount, Account, Category, Member) and its client + server validation; the register table rendering (Date · Payee · Category · Account · Amount · row actions), hero totals (Money in / Money out / Unassigned) and the "{n} transactions" count; the **All / Unassigned** filter; whole-transaction assignment to a budget line via the inline `+ Assign` / reassign picker (and the auto-categorizer payee inheritance that runs on create-without-a-line); **split** transactions (seed, add/remove slices, remainder chip, save/unsplit, kind filtering, exact-sum rule, no double-count in actuals); inline **edit** rows; **delete** and its effect on actuals & derived balances; **refunds** (rules 38/39, W12: the Refund type linked to a purchase, the ↩ mark/unmark control and `PUT /transactions/{id}/refund`, the Refund badge and "€X refunded" tag, the netted hero and line actuals, and the guards that keep a refund and its purchase coherent); **money in another currency** (W08, rules 42–44/85: the "Needs {X} amount" waiting rows, **Enter amount** with Suggest/Confirm and its refusals, and the add form's **Paid in another currency** option). Because the transfer form and transfer rows are physically part of `TransactionsPage`, this file also covers **recording a transfer** from the add modal (mode toggle, From/To/Note fields, client validation) and how transfer rows render in this register (Transfer badge, "{from} → {to}" account cell, unsigned amount, delete-only), plus the money-integrity guards that keep `Type=Transfer` out of the generic create/update endpoints. Money is `decimal(18,4)` server-side / integer minor units (scale 4) client-side; actuals and balances are always transaction-derived at read time. | **Out of scope:** The **dedicated transfer flow's** deeper semantics — its effect on both account balances, the `AccountDetailPage` direction-signed rows, currency-stamping detail and the ownership/role gates on `POST /transactions/transfer` → `11-transfers.md` (the transfer *form* and transfer *row rendering* are documented here only because they physically share the add modal and the mixed register on `TransactionsPage`; the two files intentionally overlap on that surface and cross-reference each other); Account CRUD, the full derived-balance formula, reconciliation and per-account currency display → `12-accounts-reconciliation.md`; category/line CRUD, kinds and the SavingsId jar link → `08-categories-budget-lines.md`; the **Bill** tag's source (marking a line a bill / due days) → `09-bills.md`; the Remaining-to-budget hero, "balanced / empty / over-budgeted" states and `IsBalanced` → `06-dashboard-budget-view.md` and `07-month-lifecycle.md`; the effect of category-level `ExcludeFromAllocation` on the income-split pool and savings pooling / the allocation waterfall → `14-allocation.md` (its *non-effect* on transaction actuals is pinned here in TX-095); statement-import-created transactions, the CAMT/HSBC/generic parsers and BankReference composition → `15-import.md`; the full role/permission matrix → `25-roles-permissions.md`, and cross-tab logout / silent-refresh behaviour → `03-session-auth-lifecycle.md` (only transaction-area-specific `canEnterData`/`canWrite` gating is included here); responsive / dark-mode / a11y sweeps → `26-ux-states.md`.

**Test data setup:** Unless a case says otherwise, assume an authenticated **Owner** (`canEnterData = true`, `canWrite = true`) of a **shared EUR household "Home"** with **2 members** *Alex* and *Robin*. The app-wide viewed month is **July 2026** (`monthLabel` = "July 2026") and `GET /budget/current` returns month **2026-07** with: an **Income** group holding *Salary*; an **Expense** group *Everyday* holding *Groceries* and *Internet* (`DueDay = 20`, so *Internet* renders the **Bill** tag when assigned); and a **Savings** group *Emergency* holding one line backed by an Emergency jar. Two EUR accounts exist: **Joint** (opening 1,250.00) and **Rainy Day** (opening 500.00). "Solo variant" = the same Owner in a 1-member household (member selects hidden, transfer/account controls depend on account count). Money parsing: `parseMinor` accepts "." or "," decimals, strips spaces/apostrophes, treats the right-most of a mixed ",/." pair as the decimal separator, rounds HALF-UP beyond 4 dp, and rejects `''`/whitespace/negatives/`abc`/`1.2.3`/`1,2,3` → null. Since 5 October 2026 it also adds a typed sum up: `20+30` → 50, `50-12.50` → 37.50, `-5+10` → 5, each term parsed as above; a half-typed sum (`20+`, `20++30`) or one below zero (`5-10`) → null, and `tooPrecise` refuses a sum whose term has a third decimal that matters. The client never surfaces server validation text — every API failure maps to a fixed generic string. Client wiring is exercised by `client/src/pages/TransactionsPage.test.tsx`; option grouping by `client/src/lib/transactions.test.ts`; money parsing/formatting by `client/src/lib/money.test.ts`; backend behaviour by the `tests/AllotJar.Application.Tests/Transactions/*` suite.

---

## Register load, hero & list rendering

### TX-001 - Register loads every transaction across all months
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Default fixture with a handful of transactions spanning June and July 2026.
- **Steps:**
  1. Navigate to `/transactions`.
- **Expected:** The page fires `GET /transactions` (unfiltered — no `year`/`month` query), plus `GET /budget/current`, `GET /accounts`, `GET /members` in parallel. Rows for **all months** render (the register is NOT scoped to the viewed month), server-ordered **Date desc, then Id desc**. The `{n} transactions` count equals the total rows loaded. Only a failure of the `/transactions` call sets the page error.
- **Automated:** Partial (TransactionsPage.test.tsx renders the register from mocked `/transactions`; the all-months span and ordering are not separately asserted)

### TX-002 - Empty register shows the first-use empty state
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Brand-new account, zero transactions.
- **Steps:**
  1. Open `/transactions`.
- **Expected:** No table. `EmptyState` renders icon + title **"No transactions yet"** and description **"Use + Add transaction to record one, or Import a bank statement."** The hero still renders with `+€0.00` Money in, `€0.00` Money out and **"All assigned"**. The toolbar still shows the **+ Add transaction** button (Owner).
- **Automated:** No

### TX-003 - Hero totals sum all income / expense, excluding transfers
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Transactions: Income 2,500.00; Expenses 40.00 + 6.30; one Transfer 100.00.
- **Steps:**
  1. Open `/transactions` and read the hero.
- **Expected:** Eyebrow **"Money in · July 2026"**; amount **+€2,500.00** (sum of all Income tx). Tile **Money out** = **€46.30** (sum of all Expense tx). The transfer is excluded from both totals, and so is any row still waiting for its budget-currency amount (TX-103). Both computed as integer-minor sums (`sumMinor`), formatted in the month base currency (EUR; the household's `budgetCurrency` when there is no current month).
- **Automated:** No

### TX-004 - Unassigned tile counts only external, non-split, unassigned transactions
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** 5 transactions: 2 assigned to lines, 1 split, 1 transfer, 1 plain expense with `budgetItemId === null`.
- **Steps:**
  1. Read the hero **Unassigned** tile.
- **Expected:** Tile reads **"1 to assign"** — the count includes only rows where `type !== Transfer && !isSplit && budgetItemId === null`. Transfers and split parents are excluded. With none unassigned the tile reads **"All assigned"**.
- **Automated:** No

### TX-005 - "{n} transactions" count reflects the whole list, not the filter
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** 8 transactions, 3 of them unassigned.
- **Steps:**
  1. Switch the **Filter transactions** control to **Unassigned**.
- **Expected:** The table shows 3 rows but the count text still reads **"8 transactions"** (it counts `transactions.length`, not the filtered `visible` subset).
- **Automated:** No

### TX-006 - Row signs: income +green, expense −, transfer unsigned grey
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** One Income 2,500.00, one Expense 40.00, one Transfer 100.00 row.
- **Steps:**
  1. Read the Amount column for each.
- **Expected:** Income → **+€2,500.00** (brand-green). Expense → **−€40.00** (ink/slate-900). Transfer → **€100.00** with no sign (muted slate). Each formatted from `t.amount` in **`t.currency`** (the transaction's own stamped currency; `baseAmount` no longer exists). A row waiting for its budget-currency amount is the exception: it shows "{CODE} {amount}" plain (TX-103).
- **Automated:** Partial (lib/transactions.test.ts asserts signed amount by direction; row colour classes not asserted)

### TX-007 - Account cell renders account name, "—", or transfer "{from} → {to}"
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Rows: expense on **Joint**; expense with no account; a transfer Joint→Rainy Day.
- **Steps:**
  1. Read the Account column for each.
- **Expected:** Expense on Joint → **"Joint"**. No-account expense → **"—"**. Transfer → **"Joint → Rainy Day"** (each side falls back to **"—"** when the name is null).
- **Automated:** No

### TX-008 - Category cell states render correctly
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Rows: assigned-to-Groceries expense; a split expense; a transfer; an unassigned expense.
- **Steps:**
  1. Read the Category column for each (as Owner, `canEnterData = true`).
- **Expected:** Assigned → a tint pill with a colour dot + line name (**"Groceries"**), the pill is a button (aria `Reassign {payee}`). Split → violet **Split** badge + slice summary `"{line}{ (Member)} {money}"` joined by " · ". Transfer → brand **Transfer** badge, no assign affordance. Unassigned → dashed **"+ Assign"** pill (aria `Assign {payee}`).
- **Automated:** Partial (TransactionsPage.test.tsx exercises assigned/unassigned/split/transfer rows via fixtures; exact pill markup not asserted)

### TX-009 - Bill tag appears on a transaction assigned to a bill line
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** An expense assigned to *Internet* (`DueDay = 20`, a bill in the current month).
- **Steps:**
  1. Read the Payee cell of that row.
- **Expected:** The payee text is followed by an uppercase **"Bill"** pill (`billItemIds` contains any current-month line whose `dueDay != null`). A transaction assigned to *Groceries* (no due day) shows no tag; transfers never show it (`!isTransfer` gate).
- **Automated:** No

### TX-010 - Loading and page-load-error states
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** (a) `/transactions` slow; (b) `/transactions` rejects.
- **Steps:**
  1. Observe the page during load, then after a `/transactions` failure.
- **Expected:** (a) **"Loading…"** text while the promise is pending; the hero renders immediately with zero totals. (b) An `ErrorBanner` reading **"Could not load transactions."** Note the sibling calls (`/budget/current`, `/accounts`, `/members`) are `.catch`-tolerant — their failure degrades options but never sets this error.
- **Automated:** No

### TX-011 - Register does not refetch when the viewed month changes
- **Priority:** P2
- **Type:** Edge
- **Origin:** transactions map §1 / hero label-vs-data mismatch
- **Preconditions:** Register loaded; transactions in June and July.
- **Steps:**
  1. Change the app-wide month (via the month switcher elsewhere) from July to June.
- **Expected:** The hero relabels to "Money in · June 2026" and its totals count June's transactions only. The list does **not** refilter or refetch: it always spans all transactions ever loaded.
- **Automated:** No

---

## Adding a transaction (Expense / Income)

### TX-012 - Add an expense assigned to a budget line (core daily flow)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Default fixture.
- **Steps:**
  1. Click **+ Add transaction** (aria "Add transaction"). The modal title reads **"Add a transaction"**.
  2. Leave **Type** = Expense; set **Date** = 2026-07-10; **Payee** = "Tesco"; **Amount** = "40.00"; **Account** = "Joint"; **Category** = "Groceries".
  3. Click **Add transaction**.
- **Expected:** `POST /transactions` with `{ date:"2026-07-10", payee:"Tesco", amount:40, type:0, budgetItemId:<Groceries>, accountId:<Joint>, memberId:null }`. On 201 the row is **prepended** to the register, `transaction_added` fires with `line_type:"expense"`, and Payee + Amount are cleared while Date/Type/Account stay. Groceries' actual and Joint's derived balance both reflect −40.00 at next read.
- **Automated:** Yes (TransactionsPage.test.tsx "add manual tx assigned to a line"; ManualTransactionTests create-assigned; BudgetActualsTests)

### TX-013 - Add an income transaction (Category field hidden, always unassigned from form)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Default fixture.
- **Steps:**
  1. Open the add modal; set **Type** = Income.
- **Expected:** The **Category** select is **not rendered** for income (`type === Expense` gate). Submitting sends `budgetItemId: null` → the income tx is created unassigned (the AutoCategorizer may still inherit a line if a prior same-payee tx exists — TX-030). `transaction_added` fires with `line_type:"income"`.
- **Automated:** Partial (TransactionsPage.test.tsx covers add + member/account; the income-hides-category branch is not separately asserted)

### TX-014 - Add tags the transaction to an account
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Accounts Joint + Rainy Day exist.
- **Steps:**
  1. Open the add modal; choose **Account** = "Rainy Day"; fill payee/amount; Add.
- **Expected:** `accountId` = Rainy Day id in the POST; the row's Account cell shows "Rainy Day" and Rainy Day's derived balance moves. Default is **"No account"** → `accountId: null`.
- **Automated:** Yes (TransactionsPage.test.tsx "tag tx to account")

### TX-015 - Attribute a transaction to a member (shared household)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Shared household (`members.length >= 2`).
- **Steps:**
  1. Open the add modal; the **Member** select (aria "Transaction member", default "No member") is present. Choose "Robin"; Add.
- **Expected:** `memberId` = Robin's id in the POST; member spending reflects it. The select lists both members.
- **Automated:** Yes (TransactionsPage.test.tsx "attribute tx to member")

### TX-016 - Member select is hidden in a solo household
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Solo variant (`members.length < 2`).
- **Steps:**
  1. Open the add modal.
- **Expected:** No **Member** select renders (`members.length >= 2` gate). The POST omits `memberId` (sends null). Same gate hides the member select in inline-edit and split rows.
- **Automated:** No

### TX-017 - Account select hidden with zero accounts
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Household with 0 accounts.
- **Steps:**
  1. Open the add modal.
- **Expected:** The **Account** select is not rendered (`accounts.length > 0` gate); the **Entry type** Transaction/Transfer toggle is also absent (needs `accounts.length >= 2`), so only a plain transaction can be recorded and it carries `accountId: null`.
- **Automated:** No

### TX-018 - Add Category select offers unfiltered optgroups (income & savings groups included)
- **Priority:** P2
- **Type:** Edge
- **Origin:** transactions map §7.7 / add-form Category is `buildItemOptions(month)` unfiltered
- **Preconditions:** Month has Income, Expense and Savings groups.
- **Steps:**
  1. Open the add modal (Type = Expense) and open the **Category** select (aria "Assign transaction to").
- **Expected:** Options are **"Unassigned"** plus optgroups for **every** category kind — Income and Savings groups appear alongside Expense. An expense may therefore be pointed at an Income line here; the server accepts the assignment but such a mismatch contributes **0** to actuals (see TX-029). Only the split editor filters options by type.
- **Automated:** No

### TX-019 - Enter key in the Amount field submits the add form
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Add modal open with valid fields.
- **Steps:**
  1. Focus **Amount** and press **Enter**.
- **Expected:** `addTransaction()` runs (same as clicking **Add transaction**).
- **Automated:** No

### TX-020 - Cancel closes the add modal without a call
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Add modal open with partly-filled fields.
- **Steps:**
  1. Click **Cancel** (or the modal's close control).
- **Expected:** `setShowAdd(false)`; no `POST`. Field state persists in memory (only payee/amount are cleared on a *successful* add).
- **Automated:** No

### TX-021 - Default date is today's UTC date
- **Priority:** P2
- **Type:** Boundary
- **Origin:** transactions map §7.10 / `today()` uses the UTC date
- **Preconditions:** Local clock in a UTC+ zone, late evening (local date already tomorrow / UTC still today).
- **Steps:**
  1. Open the add modal and read the pre-filled **Date**.
- **Expected:** Date defaults to `new Date().toISOString().slice(0,10)` — the **UTC** calendar date, which can read as "yesterday" for users far ahead of UTC late in the day. Editable by the user.
- **Automated:** No

---

## Add-transaction validation & boundaries

### TX-022 - Zero and negative amounts are blocked client-side
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Add modal open, valid payee.
- **Steps:**
  1. Enter Amount = "0" and submit; then "-5" and submit.
- **Expected:** Both blocked **before** any API call: `parseMinor("0")` → 0 (≤ 0) and `parseMinor("-5")` → null. Error banner (inside the modal) reads **"Enter a valid amount greater than zero."** No `POST`.
- **Automated:** Yes (TransactionsPage.test.tsx "non-positive amount rejected client-side"; ManualTransactionTests validator rejects non-positive)

### TX-023 - Empty / whitespace / non-numeric amounts are rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Add modal open.
- **Steps:**
  1. Try Amount = "" , "   ", "abc", "1.2.3", "1,2,3", each submitted.
- **Expected:** Each `parseMinor` → null → **"Enter a valid amount greater than zero."**, no API call. (`parseMinor` rejects empty, whitespace-only, non-numeric, and ambiguous multi-separator strings.)
- **Automated:** Partial (money.test.ts asserts the `parseMinor` reject table; the add-form wiring for each is not enumerated)

### TX-024 - Amount parsing accepts European and grouped formats
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Add modal open.
- **Steps:**
  1. Enter "2.500,00", then "1,234.56", then "1 234,50", then "12,34".
- **Expected:** All parse to the right minor units — "2.500,00" → 2500.0000, "1,234.56" → 1234.5600, "1 234,50" → 1234.5000 (spaces stripped), "12,34" → 12.3400. When both "," and "." appear the right-most is the decimal separator, the other is stripped as grouping.
- **Automated:** Yes (money.test.ts parseMinor accept table)

### TX-025 - More than four decimal places rounds HALF-UP on the 5th digit
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Add modal open.
- **Steps:**
  1. Enter Amount = "1.23455" and submit.
- **Expected:** Parsed to 1.2346 (12346 minor units) — HALF-UP on the 5th decimal. The POST carries `amount: 1.2346`. Server storage is `decimal(18,4)`.
- **Automated:** Yes (money.test.ts >4dp rounding)

### TX-026 - Amount above the supported range is rejected by the server
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Add modal open; amount parses but exceeds the cap.
- **Steps:**
  1. Enter Amount = "100000000000000" (10^14, above 99,999,999,999,999.9999) and submit.
- **Expected:** Client parse succeeds (positive) so a `POST` is sent; the server `CreateTransactionCommandValidator` returns 400 with **"Amount exceeds the supported range."** The client catch maps it to the generic **"Could not add that transaction."** (server text is never surfaced).
- **Automated:** No

### TX-027 - Payee at/over 200 characters (boundary + server max length)
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Add modal open, valid amount.
- **Steps:**
  1. Submit a payee of exactly 200 chars; then 201 chars.
- **Expected:** 200 → accepted (trimmed server-side). 201 → server `MaximumLength(200)` 400 → client shows generic **"Could not add that transaction."**
- **Automated:** No

### TX-028 - Empty / whitespace / unicode / emoji payee
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Add modal open, valid amount.
- **Steps:**
  1. Submit with Payee blank; then Payee = "   "; then Payee = "Café ☕ 日本 🍜".
- **Expected:** Blank/whitespace payee is allowed (trimmed to empty server-side); the row renders **"—"** in the Payee cell. The unicode/emoji payee is stored and rendered verbatim (trimmed). No client payee validation exists.
- **Automated:** No

### TX-029 - Transaction date on the 31st and on a leap day
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Add modal open.
- **Steps:**
  1. Set Date = 2026-01-31 and submit; then Date = 2024-02-29 (leap) and submit.
- **Expected:** Both accepted (the Date is a plain `type="date"` input with no month clamping; the tx's month is independent of the viewed budget month). Currency is always the household's budget currency (`BudgetCurrency.ResolveAsync`: the earliest month's `BaseCurrency`, else the owner's preference, else EUR — W08), whatever month the date falls in and whether or not that month has a budget.
- **Automated:** No

---

## Assigning a transaction to a budget line

### TX-030 - Assign an unassigned transaction via the inline picker
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** An unassigned expense "Tesco 40.00".
- **Steps:**
  1. Click the dashed **+ Assign** pill (aria `Assign Tesco`).
  2. In the autofocused select choose "Groceries".
- **Expected:** `PUT /transactions/{id}/assignment` `{ budgetItemId:<Groceries> }`; the row updates in place to the Groceries tint pill; Groceries' actual gains 40.00. `savingId` disables the select while in flight.
- **Automated:** No (assignment covered indirectly; ManualTransactionTests/TransactionHandlersTests cover the handler `assign links/clears`)

### TX-031 - Reassign an already-assigned transaction
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Tx assigned to Groceries.
- **Steps:**
  1. Click the Groceries pill (aria `Reassign Tesco`) and pick "Internet".
- **Expected:** `PUT …/assignment` `{ budgetItemId:<Internet> }`; pill relabels to "Internet" and now shows the **Bill** tag; Groceries' actual drops by 40.00, Internet's gains it.
- **Automated:** No

### TX-032 - Clearing the assignment (select "Unassigned")
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Tx assigned to Groceries.
- **Steps:**
  1. Open the reassign picker and choose the top **"Unassigned"** option.
- **Expected:** `PUT …/assignment` `{ budgetItemId: null }`; the row reverts to the dashed **+ Assign** pill and the Unassigned tile count rises by one.
- **Automated:** No

### TX-033 - Blur cancels the assign picker without a call
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Assign picker open on a row.
- **Steps:**
  1. Click elsewhere so the select loses focus (no selection change).
- **Expected:** `onBlur` sets `assigningId = null`, closing the picker; no `PUT` fires. The row keeps its prior state.
- **Automated:** No

### TX-034 - Assign picker offers unfiltered lines (income tx can point at an expense line)
- **Priority:** P1
- **Type:** Edge
- **Origin:** transactions map §7.7 / register assign picker is `buildItemOptions(month)` with no type
- **Preconditions:** An unassigned **income** transaction; month has Income, Expense and Savings groups.
- **Steps:**
  1. Open its assign picker and inspect the options.
- **Expected:** The picker lists lines from **all** groups (income tx can be pointed at an expense/savings line and vice-versa). The `PUT …/assignment` succeeds (the endpoint does **no** kind/type check). The pill shows the mismatched line — but budget actuals only count a line's own kind, so an income tx on an expense line contributes 0 "spent" and 0 "received" (see TX-035). Unlike this picker, the **split** editor filters by type.
- **Automated:** No

### TX-035 - Mismatched whole-assignment contributes 0 to actuals
- **Priority:** P1
- **Type:** Regression
- **Origin:** transactions map §6/§7.7 / assign endpoint has no kind/type validation, actuals ignore the mismatch
- **Preconditions:** An income tx of 100.00 force-assigned (via the picker or API) to the *Groceries* expense line.
- **Steps:**
  1. Read Groceries' actual on the Budget page and the tx pill.
- **Expected:** The pill shows "Groceries" but Groceries' spent actual is unchanged (income tx are grouped by (BudgetItemId, Income) and only income lines read them; expense/savings lines read only Expense tx). The money "shows but never lands." A transfer force-assigned to any line likewise contributes 0.
- **Automated:** No

### TX-036 - Assigning a whole line clears an existing split
- **Priority:** P1
- **Type:** Regression
- **Origin:** transactions map §7.5 / Assign clears an existing split
- **Preconditions:** A split expense (2 slices).
- **Steps:**
  1. Note the reassign pill is unavailable on a split row (it shows the **Split** badge). Trigger a whole-line assignment another way: the split editor's **Remove split** button, or a direct `PUT /transactions/{id}/assignment` with a line id.
- **Expected:** The `AssignTransactionCommandHandler` first `RemoveRange`s the transaction's splits and clears them, then sets/clears `BudgetItemId`. The split slices vanish; the roll-up is coherent (no double-count). **Remove split** in the UI is exactly `assign(id, null)`.
- **Automated:** Yes (SplitTransactionTests "assign clears an existing split")

### TX-037 - Assign against a budget line owned by another household is refused
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** A valid own transaction; a budget-item id belonging to another household (obtainable only via crafted API call).
- **Steps:**
  1. `PUT /transactions/{ownId}/assignment` `{ budgetItemId:<foreignLine> }`.
- **Expected:** Handler 404s a missing line ("Budget item {id} was not found.") or 403s a cross-owner line (existence revealed as Forbidden, not NotFound). No UI path can reach a foreign line (options come from the user's own month).
- **Automated:** Yes (TransactionHandlersTests "cross-user tx or line throws"; ManualTransactionTests "assigning to another user's line throws")

### TX-038 - Assign failure surfaces the generic error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Assign in flight; API returns 500.
- **Steps:**
  1. Trigger an assign that fails server-side.
- **Expected:** Error banner **"Could not save that assignment."**; the row keeps its prior line (no optimistic mutation — state updates only on success).
- **Automated:** No

---

## Auto-categorizer (payee inheritance)

### TX-039 - Create-without-a-line inherits the line of the latest same-payee transaction
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** An earlier "Tesco" expense already assigned to *Groceries*.
- **Steps:**
  1. Add a new expense Payee = "Tesco", Amount = 22.00, leaving Category = "Unassigned".
- **Expected:** Because `budgetItemId` is null, `AutoCategorizer` inherits the most recent earlier same-normalized-payee tx's line (*Groceries*). The returned DTO already carries the inherited `budgetItemName`, so the new row renders assigned to Groceries.
- **Automated:** Yes (AutoCategorizationTests "inherits line from most recent same-description tx"; "create-without-line inherits")

### TX-040 - Payee matching is trim/case/whitespace-insensitive
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Prior "Tesco" → Groceries.
- **Steps:**
  1. Add an unassigned expense Payee = "  tesco   " (leading/trailing spaces, lower-case, doubled internal spaces).
- **Expected:** Normalization (trim, lower-invariant, collapse internal whitespace) matches the prior tx → inherits Groceries. A blank payee never matches (never inherits).
- **Automated:** Yes (AutoCategorizationTests "case/whitespace-insensitive")

### TX-041 - Explicit category on create suppresses the auto-categorizer
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Prior "Tesco" → Groceries.
- **Steps:**
  1. Add "Tesco" but explicitly choose Category = "Internet".
- **Expected:** The explicit `budgetItemId` wins; AutoCategorizer does not run. The row is assigned to Internet, not the inherited Groceries.
- **Automated:** Yes (AutoCategorizationTests "explicit line wins over fallback")

### TX-042 - Auto-categorizer never inherits across households
- **Priority:** P1
- **Type:** Regression
- **Origin:** transactions map §6 / AutoCategorizer is owner-scoped
- **Preconditions:** Another household has a "Tesco" → their-Groceries tx; the current household has none.
- **Steps:**
  1. Add an unassigned "Tesco" expense in the current household.
- **Expected:** No match found (source set is scoped to the current OwnerId) → the tx stays unassigned. It never inherits another household's line.
- **Automated:** Yes (AutoCategorizationTests "never inherits across owners")

### TX-043 - Auto-categorizer prefers the most recent matching line
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** "Tesco" assigned to Groceries (old) then to Internet (newer).
- **Steps:**
  1. Add a fresh unassigned "Tesco".
- **Expected:** Inherits **Internet** (most recent match by Date desc, Id desc), not the older Groceries. Auto-categorization runs only at create time — it never retro-applies on edit or assign.
- **Automated:** Yes (AutoCategorizationTests "prefers most recent matching line")

---

## Split transactions

### TX-044 - Split an expense across two lines (exact sum)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** An expense "Costco 100.00" assigned to Groceries.
- **Steps:**
  1. Hover the row and click **⑂** (aria `Split transaction: Costco`, title "Split across budget lines").
  2. The editor seeds 2 rows; the first inherits the current line (Groceries). Set row 1 = Groceries 70.00; row 2 = Internet 30.00.
  3. Click **Save split**.
- **Expected:** Remainder chip flips to **"Fully allocated"** (emerald) once 70+30 = 100. `PUT /transactions/{id}/splits` with two allocations. Server clears the whole-tx `BudgetItemId` (parent becomes null), so no double-count: 70 lands on Groceries, 30 on Internet. Row now shows the violet **Split** badge + summary "Groceries €70.00 · Internet €30.00".
- **Automated:** Yes (TransactionsPage.test.tsx "split across two lines"; SplitTransactionTests allocate/clear-whole-assignment/rolls-into-actuals)

### TX-045 - Split editor seeds two rows; first inherits current line & member
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** A whole (unsplit) expense assigned to Groceries, member Robin.
- **Steps:**
  1. Open the split editor.
- **Expected:** Exactly 2 rows appear; row 1 pre-fills `budgetItemId` = Groceries and `memberId` = Robin; row 2 is blank. (Re-opening the editor on an already-split tx pre-fills each existing slice instead.)
- **Automated:** No

### TX-046 - Add and remove split lines
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Split editor open with 2 rows.
- **Steps:**
  1. Click **+ Add line** (aria "Add split line") to get a 3rd row.
  2. Click a row's **✕** (aria `Remove split line {n}`).
- **Expected:** **+ Add line** appends a blank slice. The per-row **✕** removes a slice but only renders when there are **> 2** rows (the minimum of 2 can never be reduced). The remainder chip recomputes live.
- **Automated:** No

### TX-047 - Remainder chip shows the live shortfall / overage
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Splitting a 100.00 tx.
- **Steps:**
  1. Enter row 1 = 70.00, row 2 = 20.00.
- **Expected:** `remainderMinor = 100.00 − 90.00 = 10.00`; chip reads **"€10.00 left"** in rose. Over-allocating (row 2 = 40.00) shows a **negative** "€−10.00 left" (rose). Only at exactly 0 does it read **"Fully allocated"** (emerald).
- **Automated:** No

### TX-048 - Save split is disabled until the remainder is exactly zero
- **Priority:** P0
- **Type:** Boundary
- **Preconditions:** Splitting a 100.00 tx with rows summing to 90.00.
- **Steps:**
  1. Hover/click **Save split**.
- **Expected:** The **Save split** button is `disabled` while `remainderMinor !== 0` (and while `savingId === t.id`). No `PUT` is possible until the slices sum exactly to the total (integer-minor comparison).
- **Automated:** Partial (TransactionsPage.test.tsx "split not summing to total blocked" asserts the block; the disabled-button state is implied)

### TX-049 - Split with a missing category or non-positive amount is blocked client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Split editor open.
- **Steps:**
  1. Leave one row's category = "Choose a line…" (empty) or its amount = "0"/blank, then attempt to save (if the remainder happens to reach 0 by the other rows).
- **Expected:** `saveSplit` guards `parsed.length < 2 || some(!budgetItemId || minor === null || minor <= 0)` → error **"Give every split line a category and an amount greater than zero."**; no `PUT`.
- **Automated:** No

### TX-050 - Split slices not summing to the total blocked client-side
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Split editor with both rows filled but summing to 99.00 on a 100.00 tx (reached e.g. by editing after Save was enabled).
- **Steps:**
  1. Attempt to save.
- **Expected:** `allocatedMinor !== fromAmount(t.amount)` → error **"The split lines must add up to the transaction total."**; no `PUT`. (Belt-and-braces behind the disabled Save button.)
- **Automated:** Yes (TransactionsPage.test.tsx "split not summing to total blocked")

### TX-051 - Split options are filtered by transaction type
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** (a) an **expense** tx; (b) an **income** tx; month has Income, Expense and Savings groups.
- **Steps:**
  1. Open each transaction's split editor and inspect the category options (`buildItemOptions(month, t.type)`).
- **Expected:** Expense tx → options are **Expense AND Savings** groups (a savings line is drawn down by an expense). Income tx → **Income** groups only. This is stricter than the whole-tx assign picker (which is unfiltered).
- **Automated:** Yes (lib/transactions.test.ts "expense tx offered Expense AND Savings lines, income tx only Income")

### TX-052 - Server rejects a cross-kind split
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** An income tx; a crafted split payload pointing at an expense line (UI cannot build this, but the API can be called directly).
- **Steps:**
  1. `PUT /transactions/{incomeId}/splits` with an expense line allocation.
- **Expected:** 400 keyed `Allocations`: **"Income can only be split across income lines."** (mirror for expense→income-line: **"An expense can only be split across expense lines."**). Savings-kind lines count as non-income, so an expense may split into Savings but income may not.
- **Automated:** Yes (SplitTransactionTests "throws when line kind ≠ transaction kind")

### TX-053 - Server rejects a split that does not sum, with the exact totals
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** A 100.00 tx; crafted allocations summing to 90.
- **Steps:**
  1. `PUT …/splits` with allocations 60 + 30.
- **Expected:** 400 keyed `Allocations`: **"The split lines must add up to 100; they add up to 90."** (formatted `0.####`). Decimal-exact server-side.
- **Automated:** Yes (SplitTransactionTests "throws when slices don't sum to total")

### TX-054 - Server rejects fewer than two allocations
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** A tx; crafted single-allocation (or null) payload.
- **Steps:**
  1. `PUT …/splits` with one allocation; then with `allocations: null`.
- **Expected:** Both 400 with **"A split needs at least two lines."** (null is treated as an empty list). Per-allocation rules also apply: empty budgetItemId → "Choose a budget line for every split line."; amount ≤ 0 → "Each split line needs an amount greater than zero."
- **Automated:** Yes (SplitTransactionTests "validator rejects <2 allocations + non-positive slice")

### TX-055 - Unsplit via Remove split (assign-null)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A split expense.
- **Steps:**
  1. Open the split editor and click **Remove split** (aria "Remove split"; only shown when `t.isSplit`).
- **Expected:** Calls `assign(id, null)` → `PUT …/assignment` `{ budgetItemId:null }`; the handler removes the slices and leaves the tx whole and unassigned. The editor closes. The **Remove split** button is absent when first splitting a whole tx.
- **Automated:** No (removeSplit path not separately asserted; assign-clears-split covered by SplitTransactionTests)

### TX-056 - Split editor warns when no candidate lines exist
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A month with no expense/savings lines (only income); an expense tx.
- **Steps:**
  1. Open the expense tx's split editor.
- **Expected:** `splitOptions` is empty → message **"Add some expense budget lines first."** (income tx with no income lines → "Add some income budget lines first."). Save cannot succeed (rows have no selectable line).
- **Automated:** No

### TX-057 - Split and edit editors are mutually exclusive
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A transaction row.
- **Steps:**
  1. Open the inline edit (✎), then open the split editor (⑂) on the same or another row.
- **Expected:** Starting a split calls `setEditingId(null)` (closes any edit); starting an edit calls `setSplittingId(null)` (closes any split). Only one inline editor is open at a time.
- **Automated:** No

### TX-058 - No affordance to split or edit a transfer
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A transfer row.
- **Steps:**
  1. Hover the transfer row.
- **Expected:** Only the **✕** delete action renders — the ✎ edit and ⑂ split buttons are gated behind `!isTransfer`. The Category cell shows the **Transfer** badge with no assign affordance.
- **Automated:** No

### TX-059 - Split with rounding: slices summing exactly at scale 4
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** A 10.00 tx.
- **Steps:**
  1. Split as 3.33 + 3.33 + 3.34.
- **Expected:** Integer-minor sum = 33300 + 33300 + 33400 = 100000 = 10.00 → **"Fully allocated"**; save succeeds. There is no auto-distribute — the user must land the last cent. (Three slices exercise the ≥2 minimum with a remainder ✕ on the third.)
- **Automated:** No

---

## Inline edit

### TX-060 - Inline-edit core fields of a transaction
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** An expense "Tesco 40.00" on Joint.
- **Steps:**
  1. Hover the row and click **✎** (aria `Edit transaction: Tesco`, title "Edit transaction").
  2. The row becomes an inline editor: change **Edit payee** to "Tesco Metro", **Edit amount** to "42.50", keep **Edit type** = Expense.
  3. Click **Save** (aria "Save transaction").
- **Expected:** `PUT /transactions/{id}` `{ date, payee:"Tesco Metro", amount:42.5, type:0, accountId:<Joint>, memberId:... }`; `transaction_edited` fires; the row updates in place. Budget-line **assignment and currency are untouched** by the edit. Joint's balance re-derives to reflect 42.50.
- **Automated:** Yes (TransactionsPage.test.tsx "inline edit"; UpdateTransactionTests "updates core fields")

### TX-061 - Edit can flip a transaction's type Expense↔Income
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** An expense row.
- **Steps:**
  1. Open the inline editor and change **Edit type** from Expense to Income; Save.
- **Expected:** The `type` in the PUT flips to 1; the row's sign/colour flip to **+green**; hero Money-in/out shift accordingly. The type select offers only **Expense / Income** (no Transfer).
- **Automated:** No

### TX-062 - Edit amount validation mirrors add
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Inline editor open.
- **Steps:**
  1. Set **Edit amount** to "0" (or blank / negative) and Save.
- **Expected:** `parseMinor` guard → error **"Enter a valid amount greater than zero."**; no `PUT`. A too-large amount passes the client and is rejected server-side (generic **"Could not save that change."**).
- **Automated:** Yes (UpdateTransactionTests "validator rejects non-positive amount"; TransactionsPage.test.tsx edit path)

### TX-063 - Edit account and member (null clears)
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Shared household; a tx on Joint, member Robin.
- **Steps:**
  1. Open the editor; set **Edit account** = "No account" and **Edit member** = "No member"; Save.
- **Expected:** `PUT` carries `accountId:null, memberId:null`; the account cell becomes "—" and member attribution clears. Joint's balance loses the amount.
- **Automated:** No

### TX-064 - Cancel edit reverts without a call
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Inline editor open with changed fields.
- **Steps:**
  1. Click **Cancel** (aria "Cancel edit").
- **Expected:** `setEditingId(null)`; no `PUT`; the row shows its unchanged stored values.
- **Automated:** No

### TX-065 - API rejects setting Type=Transfer via generic create/update (money-vanish guard)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 / destination-less transfer used to make money vanish from derived balances
- **Preconditions:** A crafted API call (no UI path — the Type select never offers Transfer, and transfers have no edit affordance).
- **Steps:**
  1. `POST /transactions` `{ type:2 (Transfer), accountId:<Joint>, amount:100 }`.
  2. `PUT /transactions/{id}` `{ type:2, ... }`.
- **Expected:** Both 400 (validator `Must(t => t != Transfer)`) with **"Use the transfer action to move money between accounts."** A bare Type=Transfer row would otherwise subtract from Joint's derived balance with no destination and hide from budget actuals.
- **Automated:** Yes (ManualTransactionTests + UpdateTransactionTests "validator rejects Transfer type")

### TX-066 - Editing a stored transfer via UpdateTransaction clears the dangling counterparty
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 / stale TransferAccountId phantom-credited the old destination
- **Preconditions:** A stored Transfer row (AccountId=Joint, TransferAccountId=Rainy Day); a crafted `PUT` turning it into a plain expense.
- **Steps:**
  1. `PUT /transactions/{transferId}` `{ type:0 (Expense), amount:100, accountId:<Joint> }`.
- **Expected:** The handler nulls `TransferAccountId` on any non-transfer update, so Rainy Day stops being phantom-credited for the leg; the row becomes a clean expense with no counterparty. (No UI reaches this — transfer rows expose only delete.)
- **Automated:** Yes (UpdateTransactionTests "re-typing a transfer clears the dangling counterparty")

### TX-067 - Editing a split parent's amount does NOT revalidate the slices
- **Priority:** P2
- **Type:** Regression
- **Origin:** transactions map §7.6 / UpdateTransaction changes Amount while slices persist
- **Preconditions:** A split expense of 100.00 (slices 70 + 30).
- **Steps:**
  1. Open the inline editor on the split parent (edit ✎ remains available on splits) and change **Edit amount** to "120.00"; Save.
- **Expected:** The `PUT /transactions/{id}` updates `Amount` to 120 while the slices stay 70 + 30 (sum 100). No UI/server guard revalidates the slices, so actuals roll up the **stale** 70/30 while the account balance moves by 120 — a known coherence edge to flag.
- **Automated:** No

---

## Delete

### TX-068 - Delete a transaction immediately (no confirmation)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** An expense "Tesco 40.00" assigned to Groceries on Joint.
- **Steps:**
  1. Hover the row and click **✕** (aria `Delete transaction: Tesco`, title "Delete transaction").
- **Expected:** `DELETE /transactions/{id}` fires **with no confirmation dialog**; on 204 the row is removed, `transaction_deleted` fires, Groceries' actual drops 40.00 and Joint's derived balance rises 40.00. Hero totals recompute.
- **Automated:** Yes (TransactionsPage.test.tsx "delete"; ManualTransactionTests delete + ownership)

### TX-069 - Delete is un-confirmed here (contrast with account delete)
- **Priority:** P2
- **Type:** Edge
- **Origin:** transactions map §7.11 / delete is immediate and un-confirmed (accounts got a confirm modal in PR #168)
- **Preconditions:** Any transaction.
- **Steps:**
  1. Click the ✕ delete action.
- **Expected:** Deletion happens on the single click — there is deliberately **no** "Delete transaction?" modal (unlike account deletion). An accidental click is unrecoverable (hard delete).
- **Automated:** No

### TX-070 - Deleting a split transaction cascades its slices
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A split expense (2 slices on Groceries + Internet).
- **Steps:**
  1. Delete the split parent.
- **Expected:** The parent and both `TransactionSplit` rows are removed (FK Cascade); Groceries' and Internet's actuals both drop their slice amounts. No orphan slices remain.
- **Automated:** No (cascade is DB-level; unit InMemory does not enforce FKs)

### TX-071 - A transfer row can be deleted
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A transfer Joint→Rainy Day of 100.00.
- **Steps:**
  1. Hover the transfer row; the only action is **✕**; click it.
- **Expected:** `DELETE /transactions/{id}` removes the single transfer row; Joint's balance rises 100.00 and Rainy Day's drops 100.00 (both legs were one row). The ✎/⑂ actions were never present.
- **Automated:** No

### TX-072 - Delete failure surfaces the generic error and keeps the row
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Delete in flight; API returns 500.
- **Steps:**
  1. Trigger a delete that fails.
- **Expected:** Error banner **"Could not delete that transaction."**; the row remains (removal happens only on success). The ✕ button is disabled (`savingId === id`) while in flight.
- **Automated:** No

---

## Filters & search

### TX-073 - Filter register to Unassigned then back to All
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Mixed rows (assigned, unassigned, split, transfer).
- **Steps:**
  1. Click **Unassigned** in the "Filter transactions" control, then **All**.
- **Expected:** **Unassigned** shows only rows where `type !== Transfer && !isSplit && budgetItemId === null` (transfers and split parents are excluded from this UI filter). **All** shows every row again. `transactions_filtered` may be tracked. The filter is client-side only — no refetch.
- **Automated:** Yes (TransactionsPage.test.tsx "filter register to Unassigned / All")

### TX-074 - Empty-filter messages
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** (a) All rows assigned; (b) an empty All list impossible since empty→EmptyState.
- **Steps:**
  1. With every row assigned, select **Unassigned**.
- **Expected:** The table body shows a single centered row **"Nothing left to assign."** (Unassigned filter with no matches). Under the **All** filter with rows present the fallback would read **"No transactions yet."**, but with zero rows overall the page shows the `EmptyState` instead.
- **Automated:** No

### TX-075 - No free-text search on the register
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Register loaded.
- **Steps:**
  1. Look for a payee/amount search field.
- **Expected:** There is **no** search input — the only register control is the All/Unassigned segmented filter. (Documented so QA does not expect one.) There is also no pagination: every row is rendered.
- **Automated:** No

### TX-076 - Server `unassignedOnly` filter differs from the UI Unassigned filter
- **Priority:** P2
- **Type:** Edge
- **Origin:** transactions map §7.8 / server counts transfers & split parents as unassigned
- **Preconditions:** API-level test (the UI never sends the param).
- **Steps:**
  1. `GET /transactions?unassignedOnly=true`.
- **Expected:** The server filters `BudgetItemId == null`, which **includes** transfers and split parents (both carry null BudgetItemId) — a wider set than the UI's Unassigned view. Also `GET /transactions?month=7` without `year` matches July of **every** year (independent filters). Purely API behaviour; documented for API-level testers.
- **Automated:** Partial (TransactionHandlersTests "unassignedOnly filter")

---

## Transfers on the register (creation form + row rendering)

### TX-077 - Entry-type toggle appears only with two or more accounts
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** (a) 2 accounts; (b) 1 account; (c) 0 accounts.
- **Steps:**
  1. Open the add modal in each case.
- **Expected:** With **≥ 2** accounts the **Entry type** segmented control (options **Transaction** / **Transfer**) renders and the title switches to **"Record a transfer"** in Transfer mode. With 0–1 accounts the toggle is absent and there is **no UI way to open the transfer form** (the API endpoint still exists).
- **Automated:** No

### TX-078 - Record a transfer between two accounts
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Accounts Joint + Rainy Day (same EUR currency).
- **Steps:**
  1. Open the add modal, switch to **Transfer**. Set **Transfer date**; **Transfer amount** = "100.00"; **From** = "Joint"; **To** = "Rainy Day"; **Note** = "Buffer top-up".
  2. Click **Record transfer**.
- **Expected:** `POST /transactions/transfer` `{ date, amount:100, fromAccountId:<Joint>, toAccountId:<Rainy Day>, payee:"Buffer top-up" }`. On 201 a single Transfer row is prepended (AccountId=Joint, TransferAccountId=Rainy Day), `transfer_created` fires, amount+note clear. The row shows the **Transfer** badge, "Joint → Rainy Day", unsigned €100.00. Joint −100 / Rainy Day +100 at next balance read. Currency stamped from the **source** account.
- **Automated:** Yes (TransactionsPage.test.tsx "record transfer"; TransfersTests "moves balance source→destination")

### TX-079 - Blank note defaults the payee to "Transfer"
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Transfer form open.
- **Steps:**
  1. Leave **Note** empty and record the transfer.
- **Expected:** `payee: null` is sent; the server defaults the payee to **"Transfer"**; the register Payee cell reads "Transfer".
- **Automated:** No

### TX-080 - Transfer amount validation (client)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Transfer form open.
- **Steps:**
  1. Try **Transfer amount** = "0" / blank / "-5" and record.
- **Expected:** Blocked before the API: **"Enter a valid transfer amount greater than zero."** (server backstop: "A transfer amount must be greater than zero.").
- **Automated:** Partial (TransfersTests validator rejects non-positive; the client transfer-amount guard not separately asserted)

### TX-081 - Missing source or destination is blocked (client)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Transfer form open, valid amount.
- **Steps:**
  1. Leave **From** = "Choose…" (or **To** = "Choose…") and record.
- **Expected:** Client error **"Choose both a source and a destination account."**; no `POST`.
- **Automated:** No

### TX-082 - Same source and destination is blocked (client)
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Transfer form open, valid amount.
- **Steps:**
  1. Set **From** = **To** = "Joint" and record.
- **Expected:** Client error **"A transfer needs two different accounts."**; no `POST`. Server backstop `NotEqual`: "Choose two different accounts for a transfer."
- **Automated:** Yes (TransactionsPage.test.tsx "same-account transfer blocked client-side"; TransfersTests validator rejects same-account)

### TX-083 - Cross-currency transfer is refused (money-integrity guard)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 / cross-currency transfers silently changed net worth; W08 — accounts in another currency can no longer be created, so this needs legacy data
- **Preconditions:** A EUR account and a **legacy** GBP account in an EUR budget (seeded directly; `POST /accounts` now refuses GBP — see TRF-021/ACCT-079); transfer form open.
- **Steps:**
  1. From EUR account to GBP account, amount 100, tick the completed confirmation, record.
- **Expected:** The client sends the `POST`; the handler throws a ValidationException keyed `ToAccountId`: **"Both accounts must use the same currency to transfer between them."**, moving nothing. The client shows that server message in the modal banner (`serverErrors`; the generic "Could not record that transfer." only for non-400 failures). (Deep balance/currency behaviour lives in the accounts sibling file; here only the block from this form is asserted.)
- **Automated:** Yes (TransfersTests "cross-currency transfer rejected and moves nothing")

### TX-084 - Transfer failure surfaces the generic error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Transfer form open; API returns 500.
- **Steps:**
  1. Record a transfer that fails server-side.
- **Expected:** Error banner (inside the modal) **"Could not record that transfer."**; the row is not added; amount/note retained.
- **Automated:** No

### TX-085 - Transfers are excluded from hero totals and budget actuals
- **Priority:** P1
- **Type:** Edge
- **Origin:** transactions map §6 / transfers excluded from money in/out and actuals
- **Preconditions:** Income 1,000; Expense 200; one Transfer 500.
- **Steps:**
  1. Read the hero and (on the Budget page) the actuals.
- **Expected:** Hero Money in = €1,000.00, Money out = €200.00 (the 500 transfer counts in neither). Budget actuals ignore transfers entirely, even if one is force-assigned to a line. Transfers move only account balances.
- **Automated:** Partial (TransfersTests "transfer never counts as income in the budget")

---

## Roles, feature flags & duplicate/state variants

### TX-086 - Read-only role: no entry controls, static category text
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Login with **Read-only** access to the household.
- **Steps:**
  1. Open `/transactions`.
- **Expected:** No **+ Add transaction** button, no row hover actions (✎/⑂/✕), no assign picker — an assigned line renders as static text and an unassigned row shows plain **"Unassigned"** (no dashed +Assign). The AppShell shows the read-only banner. Any command attempt is 403 server-side.
- **Automated:** Yes (RoleGating.test.tsx ReadOnly: entry/edit/assign hidden, assigned line static, read-only banner; AuthorizationBehaviourTests ReadOnly blocked from commands)

### TX-087 - Limited role: full entry, but no Import link
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Login with **Limited** access; `camtImport` flag on.
- **Steps:**
  1. Open `/transactions` and inspect the toolbar.
- **Expected:** **+ Add transaction** and all row actions are available (all six transaction commands are `[AllowLimited]`), but the **Import** link is hidden (`canWrite` = Admin+). Transfers are allowed for Limited.
- **Automated:** Yes (RoleGating.test.tsx Limited: tx entry available, admin-only account/import management hidden)

### TX-088 - Import link visibility follows the camtImport flag + canWrite
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; toggle `features.camtImport`.
- **Steps:**
  1. Load the page with the flag on, then off.
- **Expected:** Flag on + Admin+ → the **Import** link (icon + "Import") renders and routes to `/import`. Flag off → the link is hidden. The rest of the page (account select, transfer mode) is **not** gated by `accounts`/`camtImport` — it depends only on account count.
- **Automated:** No

### TX-089 - Duplicate manual transactions are both accepted (no BankReference dedup)
- **Priority:** P2
- **Type:** Boundary
- **Origin:** PR #154/#159 / BankReference dedup exempts reference-less manual transactions
- **Preconditions:** Default fixture.
- **Steps:**
  1. Add "Tesco 40.00" on 2026-07-10, then add an identical "Tesco 40.00" on 2026-07-10 again.
- **Expected:** Both succeed and both rows appear — manual create never sets a `BankReference`, so the unique `(OwnerId, BankReference)` index (which guards imported rows) does not apply. The count rises by 2. (Import-side dedup is covered in the import sibling file.)
- **Automated:** No (UniqueBankReferenceTests covers the index at the integration layer for imports; manual-exempt case there)

### TX-090 - Assigning without a current-month budget offers only "Unassigned"
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `GET /budget/current` returns null/fails (no month, or an offline budget fetch).
- **Steps:**
  1. Open an unassigned row's assign picker; open a split editor.
- **Expected:** The assign picker offers only **"Unassigned"** (no optgroups). The split editor shows the "Add some … budget lines first." warning and cannot save. Bill tags and pill hues are absent; the hero currency falls back to the household's **budget currency** (`budgetCurrency` from `/auth/me`; was a hardcoded EUR before W08). The register itself still renders (only `/transactions` failing blocks it).
- **Automated:** No

### TX-091 - Income transactions do not mark a month balanced
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #172 / IsBalanced requires planned TotalIncome > 0, not income transactions
- **Preconditions:** An empty budget month (no planned income) with an income **transaction** of 2,500 assigned to an income line.
- **Steps:**
  1. Record the income tx, then view the Budget hero for that month.
- **Expected:** The month is still **not** balanced — recording income *transactions* drives "received" actuals only; `IsBalanced` needs planned `TotalIncome > 0`. The empty-month hero keeps its "plan your income" prompt, never the gold balanced badge. (Full balanced/empty-month coverage lives in `06-dashboard-budget-view.md`; this case pins the transaction-side interaction.)
- **Automated:** Yes (budgetModel.test.ts empty-month-not-balanced; DashboardPage.test.tsx income-prompt; RemainingToBudgetTests domain side)

### TX-092 - Deleted budget line detaches its transactions (become unassigned)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A tx assigned to *Groceries* and a split slice on *Groceries*; then *Groceries* is deleted (Budget page).
- **Steps:**
  1. Delete the Groceries line, return to `/transactions`.
- **Expected:** The whole tx's `BudgetItemId` FK is SetNull → it renders **Unassigned** (+Assign pill). A split slice's `BudgetItemId` SetNull → the slice summary shows **"Unassigned"** for that portion. No row is deleted.
- **Automated:** No

### TX-093 - Deleted account leaves its transactions with a "—" account
- **Priority:** P2
- **Type:** Edge
- **Origin:** PR #167/#168 / delete unlinks (AccountId SetNull, TransferAccountId cleared), rows survive
- **Preconditions:** A tx on Joint and a transfer into Joint; then Joint is deleted (Accounts page).
- **Steps:**
  1. Delete Joint, return to `/transactions`.
- **Expected:** The plain tx keeps its row with Account cell **"—"** (`AccountId` nulled). The transfer keeps its row; the missing side renders **"—"** here (the `AccountDetailPage` renders "(removed account)" — that page is in the accounts sibling file). Remaining accounts' balances keep the other leg.
- **Automated:** Partial (TransfersTests "DeleteAccount clears transfers pointing at it and keeps the transaction")

### TX-094 - Stale Category selection leaks a budget line onto an income transaction
- **Priority:** P2
- **Type:** Edge
- **Origin:** transactions map §7.7 / create endpoint has no kind check + form keeps `assignTo` across a Type flip
- **Preconditions:** Add modal open; month has Income, Expense and Savings groups.
- **Steps:**
  1. Leave **Type** = Expense (the default), open **Category** (aria "Assign transaction to") and pick "Groceries" (an expense line). `assignTo` now holds the Groceries id.
  2. Change **Type** to **Income** — the Category select disappears but `assignTo` is **not** reset.
  3. Fill Payee + Amount and click **Add transaction**.
- **Expected:** The POST carries `type:1 (Income)` **and** `budgetItemId:<Groceries>` (`budgetItemId: assignTo || null` with the stale expense id). The server `CreateTransactionCommandValidator` has **no kind check** (only splits validate kind), so the income tx is created assigned to an expense line. The row shows the "Groceries" pill, but budget actuals count it as 0 on Groceries (income tx only credit income lines — see TX-035). A coherence edge: re-opening the modal and choosing Type=Income first (the normal path) sends `budgetItemId:null`. Only payee+amount are cleared after a successful add, so `assignTo` also survives into the next add.
- **Automated:** No

### TX-095 - A transaction on an ExcludeFromAllocation category still counts to that line's actual
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A category whose `ExcludeFromAllocation` flag is set (e.g. the importer's *Personal Savings* group), holding a line; the flag is a **category-level** toggle with **no control on the Transactions page**.
- **Steps:**
  1. Record an expense of 50.00 assigned to a line inside the ExcludeFromAllocation category (via the add-form Category picker, the inline assign picker, or a split slice).
  2. Read that line's spent/available on the Budget page and the row's pill.
- **Expected:** The transaction and its derived actual behave **identically** to any other line — `BudgetActuals.ApplyAsync` groups assigned transactions by `(BudgetItemId, Type)` and **never reads `ExcludeFromAllocation`** (verified: the flag appears nowhere in `BudgetActuals.cs`), so the line's spent (or a savings line's `SavingsAvailable`) reflects the 50.00 as usual and the register renders the normal tint pill. The flag changes **only** the income-split pool (the category is dropped from the allocation waterfall in `AllocationPlanner`), which is asserted in `14-allocation.md`; it has **no** transaction-side effect and produces no special badge, filter behaviour, or actuals adjustment here.
- **Automated:** Yes (backend — the flag has no UI/API writer, so it is seeded directly on the entity: `Application/ExcludeFromAllocationCoverageTests.cs` asserts whole + split-slice actuals on an excluded line equal a control line's via the real GetBudgetMonth handler; `Application/TTransactionsCoverageTests.cs` "ExcludeFromAllocationCategory_StillCountsTheTransactionToTheLineActual" covers the single-tx path)

### TX-096 - The Add modal splits an expense across categories at creation
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in with `canEnterData`; a current month with expense lines.
- **Steps:**
  1. + Add transaction; enter payee + amount (e.g. 100); click "Split across categories".
  2. Fill two slice rows (category + amount, optionally a member each) summing to the amount.
  3. Add transaction.
- **Expected:** The toggle replaces the single Category select (and the whole-transaction Member select — members attribute per slice) with two slice rows and a "Fully allocated"/"€X left" chip. Submit stays disabled until the slices sum exactly to the amount. One `POST /transactions` carries `budgetItemId: null`, `memberId: null` and the `splits` array; the server persists parent + slices atomically and the register row immediately shows the violet Split badge + slice summary. The auto-categorizer is NOT applied (slices are the assignment). "Don't split", switching Type to Income, switching to Transfer, or closing the modal resets split mode to two blank rows.
- **Automated:** Full (client `TransactionsPage.test.tsx` split-mode cases; backend `CreateTransactionWithSplitsTests` incl. atomicity, kind/ownership guards, auto-categorizer skip, actuals roll-up; IntegrationTests FK case)

### TX-097 - Add-modal split guards: mismatched sum and incomplete rows never post
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** As TX-096.
- **Steps:**
  1. In split mode, enter slices that do not sum to the amount; press Enter in the Amount field (bypasses the disabled button).
  2. Fix the sum but clear a slice's category; press Enter again.
- **Expected:** "The split lines must add up to the transaction total." then "Give every split line a category and an amount greater than zero." — no POST either time. Server-side the same rules are enforced (400 with the identical sum message shape; expense slices only onto expense/savings lines; income lines rejected), so a hand-crafted request cannot create a torn or double-counted split.
- **Automated:** Full (client Enter-key guard case; backend validator + handler tests)

### TX-098 - Register row actions are always visible (split is discoverable)
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Any transactions in the register; `canEnterData`.
- **Steps:**
  1. Look at a register row without hovering.
- **Expected:** The ✎ edit, ⑂ split and ✕ delete actions are visible on every row (no hover reveal — the affordance was previously `opacity-0 group-hover:opacity-100`, invisible on touch devices and undiscoverable). The ⑂ editor still opens seeded from an existing split and `PUT /transactions/{id}/splits` replaces it.
- **Automated:** Partial (existing inline split editor cases exercise the button; visibility itself is visual)

---

## Refunds (rules 38/39; W12)

### TX-099 - The add modal records a refund of a purchase
- **Priority:** P0
- **Type:** Happy
- **Origin:** rules 38/39 / HANDOVER P18–P20.
- **Preconditions:** Default fixture; a "Tesco" €40.00 expense assigned to *Groceries* in July.
- **Steps:**
  1. + Add transaction; set **Type** to **Refund**. A **Refund of** select appears listing the user's purchases newest first as `{d MMM} · {payee} · {amount}` (expenses only — not refunds, not split rows; "No purchases to refund yet." when there are none).
  2. Fill Payee/Amount/Date and click **Add transaction** without picking a purchase.
  3. Pick "Tesco"; leave **Category** on `Same category as the purchase`; click **Add transaction**.
- **Expected:** Step 2: `Choose the purchase this refund is for.` and no POST. Step 3: one `POST /transactions` carrying `type: 1 (Income)`, `refundOfTransactionId: <Tesco>`, `budgetItemId: null` (the split toggle is **hidden** — a refund is never split — and the Category select offers only expense/savings lines). Server: the refund lands on Tesco's *Groceries* line when it falls in the same budget month, otherwise on the continuing line in its own month (same jar, else same group kind/name and line name; none → uncategorised); the auto-categorizer is skipped, so the payee's learned **income** line is never used. Server 400s (`RefundOfTransactionId` unless stated): type not Income (`Type`: "A refund is money received: record it as income linked to the purchase."), splits present (`Splits`), the purchase is income, a transfer or itself a refund, the refund is dated before the purchase, the purchase's refunds would total more than was paid (partial refunds are allowed and add up); another user's purchase → 403.
- **Automated:** Full (client `TransactionsPage.catalog.test.tsx` TX-099; backend `Transactions/RefundTests`: `Refund_LandsOnThePurchasesLine_AndNetsItsSpending`, `Refund_InALaterMonth_ReducesThatMonth_NotThePurchaseMonth`, `Refund_OfAnUncategorisedPurchase_StaysUncategorised_AndSkipsTheLearnedIncomeLine`, `Validator_RequiresIncomeAndNoSplits_ForARefund`, `Refund_OfIncomeOrTransferOrAnotherRefund_IsRefused`, `Refund_DatedBeforeThePurchase_IsRefused`, `Refunds_MayBePartial_ButNeverExceedThePurchase`, `Refund_OfAnotherUsersPurchase_IsForbidden`, `Refund_CanBeAssignedToAnExpenseLine_ButNotAnIncomeLine`)

### TX-100 - A refund row is labelled, its purchase says how much came back, and the hero nets it out of spending
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Salary €2,500.00 income; "Tesco" €40.00 expense on *Groceries*; a €10.00 refund of Tesco (TX-099).
- **Steps:**
  1. Open `/transactions`; read the refund row, the Tesco row and the hero.
- **Expected:** The refund row shows a teal **Refund** badge, the amount as money received (`+€10.00`) and the sub-label `Refund of Tesco · {d MMM}` (`refundOfPayee`/`refundOfDate`). The Tesco row shows a `€10.00 refunded` tag (`refundedAmount`, `refundCount`). Hero: **Money in** `€2,500.00` (refunds are **excluded**), **Money out** `€30.00` (expenses − refunds). Budget page: *Groceries* Spent €30.00 (`BudgetItemDto.refundedAmount: 10`). People page: a refund attributed to a person counts **negative** in their month's Spent and never in their Received income.
- **Automated:** Full (client `TransactionsPage.catalog.test.tsx` TX-100; backend `RefundTests.Refund_LandsOnThePurchasesLine_AndNetsItsSpending`, `MemberFigures_NetRefundsOutOfSpending_AndLeaveThemOutOfIncome`)

### TX-101 - Money received can be marked as a refund from the register, and unmarked
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** An income row "Amazon" €15.00 (not split) already recorded, and an "Amazon" €60.00 purchase.
- **Steps:**
  1. Click ↩ on the income row (aria `Mark as refund: Amazon`). An inline row opens: `Refund of` + a select (aria `Purchase refunded by Amazon`, same options as TX-099), the hint "The refund moves to the purchase's category and is not counted as income.", **Save refund link** (disabled until a purchase is picked) and **Cancel refund link**.
  2. Pick the €60.00 purchase; click **Save refund link**.
  3. Click ↩ on the now-refund row (aria `Not a refund: Amazon`).
- **Expected:** Step 2: `PUT /transactions/{id}/refund { refundOfTransactionId: <purchase> }`; the row gains the Refund badge and sub-label and the purchase row's `€15.00 refunded` tag. Server: the link is set and the row is moved off any **income** line onto the purchase's line in its own month (or onto `budgetItemId` when the request names an expense/savings line). Step 3: `PUT … { refundOfTransactionId: null }`; the badge goes, the row leaves its expense line and is plain income again (an income line may be given in the same request). **Cancel refund link** closes the inline row with no request. Server refusals (400): a payment ("Only money received can be marked as a refund. This is a payment; if it was refunded, mark the refund instead."), a split row ("A split transaction can't be a refund. Remove the split first."), itself ("A transaction can't be a refund of itself."). The client shows the server's message (`serverErrors`) or `Could not update that refund.`.
- **Automated:** Full (client `TransactionsPage.catalog.test.tsx` TX-101; backend `RefundTests.LinkRefund_MovesIncomeOffTheIncomeLine_OntoThePurchasesLine`, `LinkRefund_Unlinking_MakesItPlainIncomeAgain_OffTheExpenseLine`, `LinkRefund_RefusesAPayment_ASplitRow_AndItself`)

### TX-102 - A refund and its purchase stay coherent: types locked, no split, no orphaning
- **Priority:** P1
- **Type:** Negative
- **Origin:** HANDOVER P20.
- **Preconditions:** As TX-100 (a purchase with one refund).
- **Steps:**
  1. Click ✎ on the refund row, then on the purchase row.
  2. Look for ⑂ on the refund row; open its inline assign picker.
  3. Via the API: change the refund's type to Expense; change the purchase's type; set the purchase's amount below €10.00; date the purchase after the refund; `PUT /transactions/{refund}/splits`; `DELETE /transactions/{purchase}`; then `DELETE /transactions/{refund}`.
- **Expected:** Step 1: the `Edit type` select is **disabled** on the refund (title "A refund is money received. Use “Not a refund” first to change its type.") and on the refunded purchase ("This purchase has refunds linked to it; unmark them first to change its type."). Step 2: ⑂ is **hidden** on a refund; the picker offers only expense/savings lines. Step 3, all 400: `Type` ("A refund is money received. To record it as a payment, first unmark it as a refund." / "This purchase has refunds linked to it. Unmark them as refunds before changing its type."), `Amount` (names the refunded figure), `Date` (the purchase can't be dated after its first refund), `Allocations` ("A refund follows one purchase and can't be split across lines."), `TransactionId` ("This purchase has a refund linked to it. Unlink or delete the refund first."). Deleting the **refund** itself succeeds and the purchase's line spending goes back up. The SQL foreign key is `Restrict` as well, so a hand-written delete of a refunded purchase fails at the database.
- **Automated:** Full (client `TransactionsPage.catalog.test.tsx` TX-102; backend `RefundTests.Update_RefusesTurningARefundIntoAPayment_OrShrinkingARefundedPurchaseBelowItsRefunds`, `Delete_RefusesAPurchaseWithRefunds_ButDeletesARefund`, `Split_RefusesARefund`) — the SQL `Restrict` FK itself is not exercised (in-memory provider)

## Money in another currency (W08)

Every counted transaction is in the household's **budget currency** (rule 85; EUR in this file's fixture). A row recorded in another currency — only a statement import on no account (or on a legacy account kept in another currency) creates one — **waits** (`fxPending`) and counts in **no** figure until the user confirms its budget-currency amount; the app never converts on its own (no background reconciliation, no automatic rate, no inferred fee). The one exception to "a counted row is in the budget currency" is a row on a **legacy account kept in another currency** (from before rule 63; Christopher's "Support them", 29 Sep 2026): its `amount` is that account's money and stays in the account's currency, and what it counts in the budget is stored beside it as `budgetAmount` (TX-112–TX-116). Every budget, report, People and refund figure reads `budgetAmount ?? amount`; account and jar balances keep reading `amount`. Fixture for this section: a waiting import row **"London Cab"** dated 2026-06-10, `GBP 12.50`, on no account, unassigned; plus an EUR expense "Tesco" 12.50.

### TX-103 - A waiting row is flagged, shows its own currency, and is left out of the hero totals
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Section fixture (London Cab GBP 12.50 waiting; Tesco €12.50).
- **Steps:**
  1. Open `/transactions`; read London Cab's Amount cell and the hero.
- **Expected:** London Cab's amount reads **"GBP 12.50"** (code + plain number, never `£`/`€`, so it can't read as budget money) with an amber tag **"Needs EUR amount"** (title "In another currency. Not counted anywhere until you enter the amount in EUR.") and an **Enter amount** button (aria "Enter amount in EUR: London Cab"). Only that row carries the tag. Hero **Money out** = **€12.50** (Tesco only — never €25.00); a waiting income row would likewise be missing from Money in. The dashboard, reports and People leave it out too (see DASH/RPT/PPL cases).
- **Automated:** Yes (client/src/pages/TransactionsPage.test.tsx — "flags a row waiting for its budget-currency amount and leaves it out of the totals")

### TX-104 - Enter amount: Suggest fills an editable figure without saving; Confirm makes the row count
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Section fixture; the reference-rate provider (Frankfurter/ECB) is reachable.
- **Steps:**
  1. Click **Enter amount** on London Cab.
  2. Read the modal, click **Suggest**.
  3. Replace the suggested figure with **14.8**; click **Confirm amount**.
- **Expected:** Step 1–2: modal "Amount in EUR" says "London Cab was GBP 12.50 on {10 Jun 2026, medium date style}. Enter what it cost in EUR. It isn’t counted anywhere until you confirm."; Suggest calls `GET /transactions/conversion-suggestion?currency=GBP&amount=12.5&date=2026-06-10`, fills **Amount in EUR** with the suggested amount (e.g. 14.79) and shows "Suggested from the European Central Bank reference rate: 1 GBP = {rate} EUR. Check it matches what you paid." — **nothing is saved** (no PUT). Step 3: `PUT /transactions/{id}/converted-amount {amount: 14.8}` → 200; the modal closes and the row now reads **−€14.80** with a grey caption **"GBP 12.50"** (title "Paid in GBP"), no tag, no Enter amount button. Server-side the row is `amount 14.80, currency EUR, fxPending false, originalAmount 12.50, originalCurrency GBP` — the user's figure stands whatever the rate says, and no fee or rate is stored. From now on it counts: hero Money out €27.30, and on its line/People/reports once assigned.
- **Automated:** Yes (client/src/pages/TransactionsPage.test.tsx — "Enter amount: Suggest fills an editable amount without saving; Confirm saves it"; tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs — `Confirming_makes_the_row_a_budget_currency_row_and_keeps_the_foreign_figure`; FxPendingAggregatesTests.cs — `A_confirmed_amount_counts_on_its_line_and_leaves_the_waiting_count`)

### TX-105 - Enter amount without a suggestion: the user types it; refusals are shown in the modal
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Section fixture; the rate provider is down or has no rate for that date.
- **Steps:**
  1. Open Enter amount on London Cab; click **Suggest**.
  2. Click **Confirm amount** with the field empty, then type "0" and confirm.
  3. Type **15** and confirm while the server refuses (e.g. another tab confirmed the row first).
  4. Click **Cancel**.
  5. Re-open it, type **15** and press **Enter** twice quickly in the amount field (slow the network so the first save is still in flight).
- **Expected:** Step 1: "No suggestion is available for GBP on this date. Enter the amount in EUR yourself."; the field stays empty (a failed request shows "Could not get a suggestion. Enter the amount yourself." or the server's 400 text). Step 2: **Confirm amount** is disabled while blank; "0" → "Enter the amount in EUR, greater than zero." with no PUT. Step 3: the server's message shows in the modal (e.g. "This transaction already counts in the budget currency. Edit its amount instead."); fallback "Could not save that amount."; the modal stays open. Step 4: closes with no request; the row still waits. Step 5: exactly **one** `PUT /transactions/{id}/converted-amount` — the second Enter is ignored while the first save is in flight (the button reads "Saving…"), so no second request comes back refused with "already counts".
- **Automated:** Partial (client/src/pages/TransactionsPage.test.tsx — "Enter amount: says so when no suggestion is available and shows a refusal"; ForeignAmountsTests — `No_rate_means_no_suggestion_and_the_user_types_the_amount`; the double-Enter guard is not asserted)

### TX-106 - Confirming an amount is refused for a row that isn't waiting or is split
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Rows: Tesco (EUR, counts); a waiting GBP row that was split into two slices (20.00 + 25.50 GBP), on no account.
- **Steps:**
  1. Look for the Enter amount button on the split row.
  2. `PUT /api/transactions/{id}/converted-amount` `{amount: 50}` for Tesco and for the split row; then `{amount: 0}` and `{amount: -5}` for London Cab; then as a Read-only member.
- **Expected:** Step 1: no Enter amount button on the split row (only unsplit rows get it; it still shows "Needs EUR amount"). Step 2, all 400 keyed `Amount`: Tesco → "This transaction already counts in the budget currency. Edit its amount instead."; split row → "This transaction is split. Remove the split, enter the amount, then split it again."; 0 / −5 → "Enter an amount greater than zero.". Read-only → 403 (the command is `[AllowLimited]`: Limited may confirm). Nothing changes; the rows keep waiting. A waiting row **on an account** is no longer refused: it gets Enter amount like any other and keeps its own amount (TX-112).
- **Automated:** Yes (ForeignAmountsTests — `Only_a_waiting_row_that_is_not_split_can_be_given_an_amount`)

### TX-107 - Refunds and waiting rows: a waiting row counts nothing until confirmed, and a confirmed refund must fit
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Purchase "Hotel" €100.00 (EUR, counts); a waiting USD 90.00 income row "Hotel refund" already linked as a refund of Hotel (imported before its amount was known); a waiting GBP expense "B&B"; a waiting GBP income "Deposit back".
- **Steps:**
  1. Read Hotel's "€X refunded" tag.
  2. Confirm "Hotel refund" at **100.01**, then at **82.40**.
  3. Mark "Deposit back" as a refund of Hotel (↩); link a new EUR refund to "B&B" (`POST /transactions` with `refundOfTransactionId` = B&B).
- **Expected:** Step 1: no refunded tag — a waiting refund counts nothing (`refundedAmount` sums confirmed refunds only). Step 2: 100.01 → 400 keyed `RefundOfTransactionId` (a refund of 100.01 is more than the 100 paid); 82.40 → 200, Hotel now shows "€82.40 refunded" and, on the purchase's line, spending nets by €82.40. Step 3: 400 "This is in GBP and is waiting for its amount in the budget currency. Enter that amount before marking it as a refund."; 400 "The purchase this refunds is in GBP and is waiting for its amount in the budget currency. Enter the purchase's amount first." (both keyed `RefundOfTransactionId`). The same refusal meets **Enter amount** on a waiting refund whose purchase still waits: the purchase's amount comes first. Confirming a purchase below what's already refunded against it is refused ("This purchase has {n} refunded against it; its amount can't be less than that.").
- **Automated:** Partial (ForeignAmountsTests — `A_confirmed_refund_must_still_fit_its_purchase`, `Confirming_a_refund_of_a_purchase_that_still_waits_asks_for_the_purchases_amount_first`; RefundTests — `Update_CountsARefundByItsConfirmedAmount_AndAWaitingRefundAsNothing`; the LinkRefund refusals are not asserted)

### TX-108 - Editing a waiting row's amount corrects its foreign figure; it keeps waiting
- **Priority:** P1
- **Type:** Regression
- **Origin:** W08 — the old edit cleared the pending flag, so correcting £100 to £90 then counted £90 as €90.
- **Preconditions:** A waiting GBP 100.00 expense "London Cab" on no account.
- **Steps:**
  1. ✎ the row, change **Edit amount** to 90, **Save**.
  2. Change only its payee and save again.
- **Expected:** Step 1: `PUT /transactions/{id}` → 200 with `amount 90`, `currency "GBP"`, `fxPending true`; the row reads "GBP 90.00" with "Needs EUR amount" and still counts nowhere. Step 2: still waiting. Only Enter amount (TX-104) makes it count.
- **Automated:** Yes (ForeignAmountsTests — `Editing_a_waiting_rows_amount_corrects_the_foreign_figure_and_it_keeps_waiting`; UpdateTransactionTests — `Update_NonAmountEdit_KeepsThePendingFlag`)

### TX-109 - Add form "Paid in another currency": the budget-currency Amount counts, the foreign figure is kept
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** `multiCurrency` on; rate provider reachable.
- **Steps:**
  1. **+ Add transaction**: Date 2026-06-10, Payee "Diner", tick **Paid in another currency**.
  2. Read the helper text; type Currency "usd" (aria "Currency paid in"), **Amount paid** 20 (aria "Amount paid in that currency"); click **Suggest**.
  3. Click **Add transaction**.
- **Expected:** Step 2: helper "The Amount above is what counts, in EUR. Suggest fills it in for you to check."; the currency upper-cases to USD; Suggest calls `GET /transactions/conversion-suggestion?currency=USD&amount=20&date=2026-06-10` and fills **Amount** (e.g. 18.4) — still editable, nothing saved; the hint names the ECB reference rate. Step 3: `POST /transactions` with `amount: 18.4, originalAmount: 20, originalCurrency: "USD"` → 201; the row is **−€18.40** with a grey caption "USD 20.00" (title "Paid in USD"), counts at once (never waits), currency EUR. Unticking the box clears the three fields; a plain add sends no `originalAmount`/`originalCurrency` at all.
- **Automated:** Yes (client/src/pages/TransactionsPage.test.tsx — “add form: "Paid in another currency" suggests the Amount and sends the foreign figure”, "add form: a transaction paid in the budget currency carries no foreign figure"; ForeignAmountsTests — `A_manual_entry_paid_abroad_counts_the_confirmed_amount_and_keeps_what_was_paid`; client/e2e/a11y.spec.ts — "currency conversion (Enter amount + paid in another currency) has no WCAG A/AA violations")

### TX-110 - "Paid in another currency" guards: code, budget currency, amount — client and server
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Add modal with Payee "Diner", Amount 18.40, **Paid in another currency** ticked.
- **Steps:**
  1. Leave Currency empty (or "US"), Add / Suggest.
  2. Currency "EUR", Add.
  3. Currency "USD", Amount paid empty (then "0"), Add.
  4. API: `POST /transactions` with `originalAmount: 20` and no `originalCurrency`; with `originalCurrency: "USD"` and no amount; with `originalCurrency: "POUNDS"`; with `originalAmount: -1`; with `originalCurrency: "EUR"`.
  5. Currency "USD", Amount paid 20, Date set to **tomorrow** (UTC); click **Suggest**.
- **Expected:** Client banner, no request: 1 → "Enter the three-letter code of the currency you paid in, like USD."; 2 → "EUR is your budget currency. Untick “Paid in another currency”."; 3 → "Enter the amount you paid in USD, greater than zero.". API, all 400: "Choose the currency that was paid."; "Enter the amount that was paid in that currency."; "Currency must be a 3-letter ISO 4217 code."; "Enter an amount greater than zero."; `OriginalCurrency` → "The budget is in EUR already; leave the other currency empty." Nothing is created. Step 5: `GET /transactions/conversion-suggestion?…&date={tomorrow}` → 400 keyed `Date` → "There is no reference rate for a future date yet. Enter the amount yourself.", shown in the add modal's banner; the rate provider is not asked (it would answer with its latest rate) and Amount stays as typed.
- **Automated:** Partial (ForeignAmountsTests — `A_manual_entry_cannot_name_the_budget_currency_as_the_other_currency`, `The_other_currency_needs_both_a_code_and_a_positive_amount`, `A_suggestion_needs_another_currency_a_positive_amount_and_a_day_that_has_a_rate` [Theory, tomorrow's row]; the client guards are not asserted)

### TX-111 - multiCurrency off hides only the add form's option; waiting rows can still be confirmed
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Server flag `Features:MultiCurrency=false`; section fixture (London Cab waiting).
- **Steps:**
  1. Open **+ Add transaction**.
  2. Click **Enter amount** on London Cab and confirm an amount.
- **Expected:** The add form has no **Paid in another currency** checkbox (the flag only hides that option and the account currency labels). London Cab still shows "Needs EUR amount" and **Enter amount**; confirming works exactly as in TX-104 (the conversion endpoints are not feature-gated).
- **Automated:** No

## A legacy account kept in another currency ("Support them", W08)

Fixture for this section: budget currency EUR; a legacy **GBP** account **"UK Current"** (created before rule 63; new accounts can't be in another currency — ACCT-079) with opening balance £500.00; a June 2026 month with the expense lines **Travel** and **Food** (planned €500.00 each). A row on UK Current is in GBP and its `amount` is UK Current's money, so it is never restated; once its budget figure is known it is stored beside it as `budgetAmount`.

### TX-112 - Enter amount on a row on an account kept in another currency: the account keeps its amount, the budget counts yours
- **Priority:** P0
- **Type:** Happy
- **Origin:** W08 adversarial review — such rows used to be refused ("…can't be converted without changing that account's balance") and so could never count; Christopher's "Support them" (29 Sep 2026).
- **Preconditions:** Section fixture; a waiting import row "London Cab" `GBP 12.50` dated 2026-06-10 on UK Current, assigned to Travel.
- **Steps:**
  1. Open `/transactions`; read the row.
  2. Click **Enter amount**; read the dialog; type **14.80**; **Confirm amount**.
  3. Read the row, the hero, Travel's actual on the dashboard, UK Current's balance on `/accounts` and its detail register.
- **Expected:** Step 1: "GBP 12.50" with **"Needs EUR amount"** and an **Enter amount** button (aria "Enter amount in EUR: London Cab") — offered on account rows too now. Step 2: the dialog adds "UK Current keeps its GBP amount; the budget counts yours." after "It isn’t counted anywhere until you confirm."; `PUT /transactions/{id}/converted-amount {amount: 14.8}` → 200 with `amount 12.50, currency "GBP", budgetAmount 14.80, fxPending false` and **no** `originalAmount`/`originalCurrency`. Step 3: the row reads **−£12.50** with a grey caption **"Counts as €14.80"** (title "The account keeps its GBP amount; the budget counts this"); hero Money out adds **€14.80** (the hero sums `budgetAmount ?? amount`), never 12.50; Travel's actual rises by €14.80; UK Current's balance is **£487.50** (balances sum `amount`) and stays out of the hero totals (ACCT-005); its detail register shows "−£12.50" with "Counts as €14.80 in the budget". A waiting foreign row on a budget-currency account (possible only before #210) is handled the same way: the account keeps its amount.
- **Automated:** Yes (ForeignAmountsTests — `A_waiting_row_on_an_account_kept_in_another_currency_counts_its_confirmed_figure_and_the_balance_stays`; client/src/pages/TransactionsPage.test.tsx — "Enter amount on a row on an account kept in another currency keeps its amount and shows what it counts"; the hero total and the detail-register caption are not asserted)

### TX-113 - Changing the amount of such a row makes it wait for its new figure; other edits keep it
- **Priority:** P1
- **Type:** Regression
- **Preconditions:** Section fixture; a counted expense on UK Current `GBP 25.00` with `budgetAmount 30.00` (confirmed, or kept by the migration — CURR-054), dated 2026-06-03, assigned to Travel.
- **Steps:**
  1. ✎ the row; change only the payee to "Train"; **Save**.
  2. ✎ again; change **Edit amount** to 27; **Save**.
  3. Read Travel's actual; click **Enter amount** and confirm 32.40.
- **Expected:** Step 1: 200; `budgetAmount` stays **30.00**, the row still counts €30.00 ("Counts as €30.00"). Step 2: 200 with `amount 27, currency "GBP", budgetAmount null, fxPending true` — the old figure was for another amount, so the row waits ("GBP 27.00" + "Needs EUR amount") rather than keep counting €30.00; UK Current's balance moves by the £2.00 difference. Step 3: Travel no longer counts the row until confirmed; after confirming it counts **€32.40** with `amount 27` kept. (A split row's amount can't be changed here at all — "This transaction is split across {n} lines totalling {sum}. Change the split before changing the amount." — so its slices keep their shares.)
- **Automated:** Yes (ForeignAmountsTests — `Changing_the_amount_of_such_a_row_makes_it_wait_for_its_new_figure_and_other_edits_keep_it`; step 3's re-confirmation follows TX-112)

### TX-114 - Splitting such a row shares its figure over the slices
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Section fixture; a counted expense on UK Current `GBP 10.00` with `budgetAmount 11.2346`, dated 2026-06-03, unassigned.
- **Steps:**
  1. ⑂ split it: Travel **3.33**, Food **6.67** (slices are entered in the row's own GBP and must sum to 10.00).
  2. Read Travel's and Food's actuals.
- **Expected:** `PUT /transactions/{id}/splits` → 200. Each slice gets `budgetAmount` = its share of the row's figure in proportion to its amount, rounded to 4 decimals, the largest slice taking the rounding: Travel **3.7411**, Food **7.4935** — together exactly 11.2346. Travel's actual rises by 3.7411 and Food's by 7.4935 (never 3.33 / 6.67). The split does not touch UK Current's balance (the whole £10.00 counts against it, as for any split — ACCT-040). This divides a figure already fixed; no rate is used.
- **Automated:** Yes (ForeignAmountsTests — `Splitting_such_a_row_shares_its_figure_over_the_slices`)

### TX-115 - A refund is measured against what its purchase counts, not the account's amount
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Section fixture; a purchase on UK Current `GBP 25.00` with `budgetAmount 30.00`; a waiting `USD 20.00` income row on no account linked as its refund (imported before its amount was known).
- **Steps:**
  1. **Enter amount** on the refund: **30.01**.
  2. Then **28**.
  3. Read the purchase's refunded tag and its line.
- **Expected:** Step 1: 400 keyed `RefundOfTransactionId` → "A refund of 30.01 is more than the 30 paid for this purchase." (the purchase's figure, never its £25). Step 2: 200 with `amount 28` — more than the account's 25 but within the 30 the purchase counts. Step 3: the purchase's `refundedAmount` (28) and the refund's `refundOfAmount` (30) are budget figures (`budgetAmount ?? amount` on both sides) and the purchase's line nets out €28.00. The register's refunded tag formats `refundedAmount` in the budget currency ("€28.00 refunded"), and linking a refund in the register adds the refund's `budgetAmount ?? amount` to it. A refund that itself sits on such an account is likewise measured by its own `budgetAmount` when it is linked (LinkRefund).
- **Automated:** Yes (ForeignAmountsTests — `A_refund_is_measured_against_what_its_purchase_counts_not_its_accounts_amount`; the tags are not asserted)

### TX-116 - A purchase and refund whose figures were fixed apart can still be edited, but not pushed further apart
- **Priority:** P1
- **Type:** Regression
- **Origin:** W08 adversarial review — the `ForeignAmounts` migration restates a purchase and its refund each at its own day's rate (USD 100 bought at 0.92 → €92.00, refunded at 0.95 → €95.00), so the refund can exceed its purchase; every later edit of either row was refused.
- **Preconditions:** A purchase "US shop" €92.00 (`originalAmount 100 USD`) and its refund €95.00 (`originalAmount 100 USD`), both dated 2026-06-03, on no account.
- **Steps:**
  1. ✎ the purchase: rename to "US shop (online)", keep 92.00, **Save**.
  2. ✎ the refund: rename to "Refund", keep 95.00, **Save**; then lower it to **94.00**.
  3. ✎ the purchase: lower it to **91.00**.
  4. ✎ the refund: raise it to **94.50**.
- **Expected:** Steps 1–2: all 200 — the refund's fit is checked only when it starts counting or counts more than before (`RefundRules.ValidateOriginalAsync` `previousAmount`), and the purchase's only when it is lowered, so a rename, recategorisation or a change that brings the pair closer never trips over it. Step 3: 400 keyed `Amount` → "This purchase has 94 refunded against it; its amount can't be less than that." Step 4: 400 keyed `RefundOfTransactionId` → "A refund of 94.5 is more than the 92 paid for this purchase." Nothing changes on a refusal. Linking, creating or confirming a refund is always checked in full (TX-107).
- **Automated:** Yes (ForeignAmountsTests — `A_purchase_and_refund_restated_at_different_rates_can_still_be_edited_but_not_pushed_further_apart`; the messages' wording is not asserted, only the keys)
