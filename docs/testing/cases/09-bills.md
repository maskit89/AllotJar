# Bills & due dates
**ID prefix:** BILL | **Scope:** Tracking an expense line as a bill and everything that hangs off a `DueDay`: adding/changing/clearing the due day (the `📅` add-bill affordance, the `Bill` tag → number-input editor, `✓` save, `✕` remove), the `Paid` toggle (the `aria-pressed` ☐/☑ button gated on `canEnterData`), the per-line urgency pill states (normal / due-soon / overdue) and their tooltips, the current-month **bills summary banner** (paid count, overdue/due-soon suffix, "left to pay" / "All bills paid 🎉", tone colours), past-month overdue behaviour, due-day clamping in short months (31 → 28/29 in February), and bill state carried across a month copy (`DueDay` carried, `IsPaid` reset). Both the `BudgetItemRow` / `CategoryAccordion` UI and the `PUT /api/budget/items/{id}/bill` + `PUT /api/budget/items/{id}/paid` endpoints (incl. the `SetBudgetItemBillCommandValidator` range rule). | **Out of scope:** month create / copy / template *mechanics* and the not-found create UI (see `07-month-lifecycle.md` — this file only asserts the bill-specific carry/reset); the Hero/remaining banner, planned-amount editing, tx-derived actuals (see `06-dashboard-budget-view.md`); category/line CRUD, reorder, savings lines & the `SavingsId` FK (see `08-categories-budget-lines.md`); jar shaping/accrual/shelf (see `13-jars.md`); the full role/permission matrix depth (see `25-roles-permissions.md` — bill-specific role behaviour is covered here); transactions that drive a bill line's spent figure (see `10-transactions.md`).
**Test data setup:** Unless a case says otherwise, act as **Owner "Ana"** (household A, role Owner ⇒ `canWrite` + `canEnterData`) signed in, viewing **July 2026** (the current calendar month; injected `today = 2026-07-16`, a Thursday) which has a saved budget:
- **Income** group with one line **"Salary"**, planned €2,000.00.
- **"Housing"** expense group (Kind=Expense) with bill lines **"Rent"** (planned €900.00, `DueDay 1`, unpaid → overdue), **"Utilities"** (planned €150.00, `DueDay 20`, unpaid → due-soon, diff +4 days), **"Broadband"** (planned €40.00, `DueDay 28`, unpaid → upcoming, diff +12 days), plus a non-bill line **"Groceries"** (planned €300.00, `DueDay null`).
- **"Savings"** group with one jar-backed line **"Emergency Fund"** (planned €100.00, `DueDay null`).
- Derived bills roll-up (`billsSummary`/`billAlerts`): total 3, paid 0, overdue 1, due-soon 1, `unpaidMinor` = €1,090.00. Banner tone rose (overdue>0).
- Also available: **"June 2026"** — the prior month (contains a Rent bill line `DueDay 1`, marked paid) used for copy/past-month cases; a **Limited** login **"Liam"** and a **ReadOnly** login **"Rhea"** on household A; **Owner "Bob"** (household B, separate `OwnerId`) for cross-owner checks.
- Money is `decimal(18,4)` server-side / integer minor units client-side; formatting uses the en-GB default grouping (`€1,090.00`). Every mutating bill endpoint returns the full recomputed `BudgetMonthDto`; the dashboard keeps its optimistic state on success and rolls back to a snapshot on failure. Bill controls render only on **expense** lines (`CategoryAccordion` → `BudgetItemRow`); income and savings rows have no bill affordances.

---

## Marking a line as a bill (set / change / clear the due day)

### BILL-001 - Add a due day to a plain expense line
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Groceries" is a non-bill line (`DueDay null`).
- **Steps:**
  1. Hover the "Groceries" row to reveal the **📅** button (aria `Add a due date to Groceries`, title "Track as a bill") and click it.
  2. In the revealed `<input type="number" min=1 max=31>` (aria `Due day for Groceries`) type `15`.
  3. Click **✓** (aria `Save due day for Groceries`) — or press Enter.
- **Expected:** `commitBill` sends `PUT /api/budget/items/{grocId}/bill { dueDay: 15 }`. Optimistically the row gains a **"Bill"** tag; because 15 is >7 days from day 16... actually diff = 15−16 = −1 so it reads **overdue** rose (tooltip "Overdue — was due on day 15"). The `Paid` toggle appears on the row. Totals (Income/Allotted/Remaining) are unchanged — a due day carries no money. The bills summary now reads 4 total.
- **Automated:** Yes (`client/src/pages/DashboardPage.test.tsx` "marks a line as a bill with a due day"; `tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs` SetBill-sets-due-day)

### BILL-002 - 📅 add-bill is hover-revealed; saving an empty editor is a no-op
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026; "Groceries" non-bill.
- **Steps:**
  1. Observe the "Groceries" row at rest — the **📅** button is `opacity-0` (hidden until row hover/focus).
  2. Hover, click **📅**; the editor opens with an **empty** input (no `✕` remove button is shown while adding, since the line isn't yet a bill).
  3. Without typing, click **✓**.
- **Expected:** `Number('')` → 0, which fails `n >= 1`, so `commitBill` reverts and closes the editor with **no** `PUT`. "Groceries" stays a non-bill line. No error strip.
- **Automated:** No

### BILL-003 - Change an existing bill's due day
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Utilities" is a bill `DueDay 20`.
- **Steps:**
  1. Click the **"Bill"** tag on "Utilities" (aria `Edit due day for Utilities`) — the editor opens pre-filled with `20`.
  2. Change it to `25` and click **✓**.
- **Expected:** `PUT /budget/items/{utilId}/bill { dueDay: 25 }`. Day 25 is diff +9 from today → the tag flips from amber "due-soon" to the normal category-tint "Bill" (tooltip "Bill due on day 25"). `billAlerts.dueSoon` drops to 0 so the banner's "· 1 due soon" clause disappears (overdue still 1 from Rent, so tone stays rose). `IsPaid` is untouched (still false).
- **Automated:** Partial (`client/src/budgetModel.test.ts` withItemBill + billStatus classification; the exact editor round-trip is not unit-tested)

### BILL-004 - Re-saving the same due day is a no-op
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026; "Utilities" bill `DueDay 20`.
- **Steps:**
  1. Click the **"Bill"** tag, leave the value `20`, click **✓**.
- **Expected:** `commitBill` computes `n === item.dueDay` (20 === 20) so it closes the editor **without** calling `onSetBill` — no `PUT`, no optimistic churn, no "Saving…" pulse.
- **Automated:** No

### BILL-005 - Clear a bill removes the due day and un-pays it
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Rent" is a bill `DueDay 1`, currently **paid** (tick it first via BILL-014 if needed).
- **Steps:**
  1. Click the **"Bill"** tag on "Rent" to open the editor (shows `✓` and, because it's already a bill, **✕** aria `Remove bill from Rent`, title "Remove bill").
  2. Click **✕**.
- **Expected:** `clearBill` sends `PUT /budget/items/{rentId}/bill { dueDay: null }`. Optimistically (`withItemBill(..., null)`) the "Bill" tag and the `Paid` toggle both disappear and `isPaid` is forced to `false`; the server handler mirrors this (`item.DueDay = null; item.IsPaid = false`). "Rent" drops out of the bills summary (total 3 → 2) and out of `unpaidMinor`.
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs` clearing-due-day-resets-paid; `client/src/budgetModel.test.ts` withItemBill clear un-pays)

### BILL-006 - Escape in the due-day editor cancels without saving
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026; "Utilities" bill `DueDay 20`.
- **Steps:**
  1. Click the **"Bill"** tag, change the value to `9`, then press **Escape**.
- **Expected:** The editor closes, `billDraft` reverts to `20`, and **no** `PUT` fires. The tag still reads day 20 (amber due-soon).
- **Automated:** No

### BILL-007 - Cancel adding a bill leaves the line non-bill
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Ana on July 2026; "Groceries" non-bill.
- **Steps:**
  1. Hover "Groceries", click **📅**, type `12`, then press **Escape** (or click ✓ with the field cleared).
- **Expected:** Editor closes with no `PUT`; "Groceries" stays a plain line with no "Bill" tag and no `Paid` toggle.
- **Automated:** No

---

## Due-day validation & boundaries

### BILL-008 - Due day 1 (lower boundary) is accepted
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Ana on July 2026; "Groceries" non-bill.
- **Steps:**
  1. **📅** on "Groceries", type `1`, click **✓**.
- **Expected:** `PUT … { dueDay: 1 }` succeeds; "Groceries" becomes a bill due day 1 (diff −15 → overdue rose). Server validator (`InclusiveBetween(1, 31)`) accepts 1.
- **Automated:** Yes (`BillTrackingTests.cs` due-day range validator [Theory] covers the 1 boundary)

### BILL-009 - Due day 31 (upper boundary) is accepted
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Ana on July 2026; "Groceries" non-bill.
- **Steps:**
  1. **📅** on "Groceries", type `31`, click **✓**.
- **Expected:** `PUT … { dueDay: 31 }` succeeds. In July (31 days) the effective day is 31 (diff +15 → upcoming, tooltip "Bill due on day 31"). Validator accepts 31.
- **Automated:** Yes (`BillTrackingTests.cs` due-day range validator [Theory] covers the 31 boundary)

### BILL-010 - Day 0 / 32 / negative revert silently in the client
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Ana on July 2026; open the due-day editor on "Utilities" (currently 20).
- **Steps:**
  1. Type `0`, click **✓**. 2. Re-open, type `32`, click **✓**. 3. Re-open, type `-5`, click **✓**.
- **Expected:** Each fails `n < 1 || n > 31`, so `commitBill` reverts `billDraft` to the stored `20` and closes with **no** `PUT` and **no** error text (client-side silent revert). The bill stays day 20. (Note the `<input type="number">` may itself reject typing `-`, but the guard is the real gate.)
- **Automated:** No

### BILL-011 - Non-integer, decimal, whitespace, non-numeric, and huge inputs revert
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Ana on July 2026; due-day editor open on "Utilities" (20).
- **Steps:**
  1. Try `12.5`, `15abc`, ` ` (spaces only), an empty field, and a very long run of digits like `99999999`, saving each with **✓**.
- **Expected:** `Number('12.5')` → 12.5 fails `Number.isInteger`; `Number('15abc')` → `NaN` fails `Number.isInteger`; whitespace/empty → `Number('')`/`Number(' ')` = 0 fails `n >= 1`; `99999999` fails `n > 31`. Every case reverts to `20` and sends **no** `PUT`, no message.
- **Automated:** No

### BILL-012 - API-direct out-of-range due day is rejected 400
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Ana authenticated; a real budget item id on July 2026.
- **Steps:**
  1. Bypass the UI and `PUT /api/budget/items/{id}/bill { dueDay: 0 }` (and separately `{ dueDay: 40 }`).
- **Expected:** `SetBudgetItemBillCommandValidator` (`InclusiveBetween(1,31)` `.When(DueDay is not null)`) → **400** "Validation failed" with `errors` containing **"A due day must be between 1 and 31."**. `dueDay: null` in the same shape is allowed (clears the bill). The dashboard would surface only its fixed "Could not update that bill — reverted." string, not the server text.
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs` due-day range validator [Theory])

---

## Paid toggle

### BILL-013 - Mark a bill paid (core daily flow)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Rent" bill `DueDay 1`, unpaid.
- **Steps:**
  1. Hover the "Rent" row to reveal the **☐ Paid** button (aria `Mark Rent paid`, `aria-pressed=false`, title "Mark as paid") and click it.
- **Expected:** `setPaid` optimistically flips the button to **☑ Paid** (`aria-pressed=true`, aria-label `Mark Rent unpaid`, title "Paid", now persistently visible in brand colour) and sends `PUT /api/budget/items/{rentId}/paid { isPaid: true }` ([AllowLimited] command). The bills banner recomputes: paid 0→1 ("📅 Bills: 1/3 paid"), `unpaidMinor` €1,090.00 → €190.00, and since Rent was the only overdue bill the tone shifts from rose to amber "· 1 due soon" (Utilities). Actuals are unchanged (paid is a flag, not a transaction).
- **Automated:** Yes (`client/src/pages/DashboardPage.test.tsx` "toggles paid and updates the bills summary"; `tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs` SetPaid-toggles)

### BILL-014 - Mark a paid bill unpaid
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Rent" bill marked paid.
- **Steps:**
  1. Click the **☑ Paid** button on "Rent" (aria `Mark Rent unpaid`, `aria-pressed=true`).
- **Expected:** `PUT … /paid { isPaid: false }`; button reverts to **☐ Paid** (`aria-pressed=false`, aria-label `Mark Rent paid`, title "Mark as paid") and becomes hover-gated again. Banner paid count 1→0, `unpaidMinor` back to €1,090.00, tone back to rose (Rent overdue again).
- **Automated:** Yes (`client/src/pages/DashboardPage.test.tsx` toggle-paid; `BillTrackingTests.cs` SetPaid-toggles)

### BILL-015 - Unpaid Paid toggle is hover-revealed; a paid toggle stays visible
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026; "Rent" unpaid, "Utilities" unpaid.
- **Steps:**
  1. At rest (no hover), scan the bill rows.
  2. Mark "Utilities" paid, then move the mouse away.
- **Expected:** An **unpaid** bill's `☐ Paid` control is `opacity-0` (revealed only on row hover/focus), while a **paid** bill's `☑ Paid` control is always visible (brand colour). This lets a user see at a glance which bills are ticked without hovering each row.
- **Automated:** No

### BILL-016 - Paid toggle appears only on bill lines
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026; "Groceries" non-bill, "Rent" bill.
- **Steps:**
  1. Hover "Groceries" (non-bill) and hover "Rent" (bill).
- **Expected:** "Groceries" shows the **📅** add-bill button but **no** `Paid` toggle (the toggle is gated on `item.dueDay !== null`). "Rent" shows the `Paid` toggle. Income lines and savings lines never show a `Paid` toggle at all (no bill controls in those layouts).
- **Automated:** No

### BILL-017 - API can set IsPaid on a line that is not a bill
- **Priority:** P2
- **Type:** Regression
- **Origin:** map §7.11 gotcha — `PUT items/{id}/paid` does not verify the line is a bill
- **Preconditions:** Ana authenticated; "Groceries" (non-bill, `DueDay null`) id.
- **Steps:**
  1. `PUT /api/budget/items/{grocId}/paid { isPaid: true }` directly.
- **Expected:** The handler sets `IsPaid = true` and returns 200 — there is **no** server check that `DueDay != null`. In the UI this is invisible (a non-bill line renders no `Paid` toggle and `IsBill => DueDay != null` governs every bill surface), so `isPaid` on a due-day-less line is inert. Document as a known API-level looseness, not a UI bug.
- **Automated:** No

---

## Due-soon / overdue pill states & tooltips

### BILL-018 - Due-soon bill shows the amber pill and tooltip
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026 (`today = 2026-07-16`); "Utilities" bill `DueDay 20`, unpaid.
- **Steps:**
  1. Hover the **"Bill"** tag on "Utilities" to read the tooltip.
- **Expected:** `billStatus` = 'due-soon' (diff = 20−16 = +4, `0 ≤ diff ≤ 7`). The tag renders amber (`bg-amber-100 text-amber-700`, dark-aware) with tooltip **"Due soon — day 20"**.
- **Automated:** Partial (`client/src/budgetModel.test.ts` due-soon classification; `DashboardPage.test.tsx` overdue-flagged covers the row-level flag but the exact amber tooltip string isn't unit-asserted)

### BILL-019 - Due-soon window boundaries (today, +7, +8, −1)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Ana on July 2026 (`today = 2026-07-16`); craft bills at days 16, 23, 24, 15.
- **Steps:**
  1. Set one bill each to `DueDay` 16, 23, 24 and 15 (all unpaid) and read each status.
- **Expected:** Day 16 → diff 0 → **due-soon** (due *today* counts as due-soon, `diffDays < 0` is false). Day 23 → diff +7 → **due-soon** (`≤ 7`). Day 24 → diff +8 → **upcoming** (normal tag). Day 15 → diff −1 → **overdue**. (`DUE_SOON_DAYS = 7`.)
- **Automated:** Partial (`client/src/budgetModel.test.ts` due-soon proximity classification)

### BILL-020 - Overdue bill shows the rose pill and tooltip
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026 (`today = 2026-07-16`); "Rent" bill `DueDay 1`, unpaid.
- **Steps:**
  1. Hover the **"Bill"** tag on "Rent".
- **Expected:** `billStatus` = 'overdue' (diff = 1−16 = −15). The tag renders rose (`bg-rose-100 text-rose-700`, dark-aware) with tooltip **"Overdue — was due on day 1"**.
- **Automated:** Partial (`client/src/budgetModel.test.ts` classification; `DashboardPage.test.tsx` "overdue bill flagged in summary and row")

### BILL-021 - A paid bill shows the normal tag, never an urgency pill
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026; "Rent" bill `DueDay 1` marked **paid**.
- **Steps:**
  1. Hover the "Rent" **"Bill"** tag.
- **Expected:** `billStatus` = 'paid' (the `isPaid` short-circuit precedes the date maths), so despite being past-due the tag is the neutral category-tint "Bill" with tooltip **"Bill due on day 1"** — no rose, no "overdue". A paid bill is settled, not urgent.
- **Automated:** Partial (`client/src/budgetModel.test.ts` paid special-cased before date scoring)

### BILL-022 - A future-month bill reads as upcoming (normal tag)
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Ana; navigate `›` to **August 2026** which has a Rent bill `DueDay 1`, unpaid.
- **Steps:**
  1. View August 2026 and hover the "Rent" tag.
- **Expected:** `billStatus` = 'upcoming' (future month short-circuits to 'upcoming' regardless of the day number) → neutral category-tint "Bill", tooltip "Bill due on day 1", no urgency colour. `billAlerts` for August = {overdue 0, due-soon 0}.
- **Automated:** Partial (`client/src/budgetModel.test.ts` future-month = upcoming)

---

## Bills summary banner (current month)

### BILL-023 - Banner rolls up counts and "left to pay" with due-soon suffix
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026 with Rent marked **paid** (so no overdue), Utilities (day 20) + Broadband (day 28) unpaid.
- **Steps:**
  1. Read the bills strip above the income groups.
- **Expected:** With overdue 0 and due-soon 1 the banner shows **"📅 Bills: 1/3 paid · 1 due soon"** on the left and **"€190.00 left to pay"** (Utilities €150 + Broadband €40) on the right, amber tone (`border-amber-200 bg-amber-50`). `bills.total` counts every line with a `DueDay` across all groups.
- **Automated:** Yes (`client/src/pages/DashboardPage.test.tsx` "toggles paid and updates the bills summary")

### BILL-024 - Overdue suffix wins over due-soon and colours the banner rose
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026, default fixture (Rent overdue, Utilities due-soon, Broadband upcoming, all unpaid).
- **Steps:**
  1. Read the bills strip.
- **Expected:** `alerts.overdue = 1 > 0`, so the banner shows **"📅 Bills: 0/3 paid · 1 overdue"** (the `· N due soon` clause is suppressed whenever any overdue exists — `alerts.overdue === 0 && dueSoon > 0` guards it) and **"€1,090.00 left to pay"**, rose tone (`border-rose-200 bg-rose-50 text-rose-800`).
- **Automated:** Yes (`client/src/pages/DashboardPage.test.tsx` "overdue bill flagged in summary and row"; `client/src/budgetModel.test.ts` billAlerts counts)

### BILL-025 - All bills paid shows the emerald "All bills paid 🎉" banner
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Ana on July 2026; mark all three bills (Rent, Utilities, Broadband) paid.
- **Steps:**
  1. Read the bills strip after ticking the last unpaid bill.
- **Expected:** `bills.paid === bills.total` → left reads **"📅 Bills: 3/3 paid"** (no overdue/due-soon suffix, since a paid bill scores 'paid'), right reads **"All bills paid 🎉"**, emerald tone (`border-emerald-200 bg-emerald-50 text-emerald-800`).
- **Automated:** Partial (`client/src/budgetModel.test.ts` billsSummary counts; the emerald all-paid render is not unit-asserted)

### BILL-026 - No bill lines → no banner; empty month → no banner
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** (a) A month whose only lines have `DueDay null`; (b) a freshly created blank month for a jar-less household (income group only).
- **Steps:**
  1. View each and look for the bills strip.
- **Expected:** `billsSummary.total === 0` → the strip returns `null` and is absent in both cases. The empty-month hero ("Plan your income, then give every {noun} a job") renders with no bills banner beneath it.
- **Automated:** No

### BILL-027 - Bill set via API on a savings line counts in the banner but shows no tag
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Ana; "Emergency Fund" savings line id; `PUT /budget/items/{efId}/bill { dueDay: 5 }` (the UI never offers this on a savings line).
- **Steps:**
  1. Set the due day via API, then reload the July dashboard.
- **Expected:** `billsSummary` and `billAlerts` flat-map across **all** kinds, so the Emergency Fund now counts toward `bills.total` (and, unpaid on day 5 vs today 16, toward overdue) and its planned €100 joins `unpaidMinor`. But the **savings row renders no "Bill" tag or Paid toggle** (bill controls live only in the expense `BudgetItemRow` layout). Document as a data/UI mismatch reachable only via API.
- **Automated:** No

---

## Past-month overdue behaviour

### BILL-028 - An unpaid bill in a past month reads overdue
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (`billStatus`: unpaid past-month bills now 'overdue', were 'upcoming')
- **Preconditions:** Ana; navigate `‹` to **June 2026** (a past month) which has an **unpaid** bill line, viewing on `today = 2026-07-16`.
- **Steps:**
  1. View June 2026 and read both the row tag and the bills banner.
- **Expected:** `billStatus` short-circuits: `isPastMonth` true and not paid → **'overdue'** regardless of the day number. The row tag is rose "Overdue — was due on day {d}" and the banner shows rose "· N overdue". (Pre-#168 these read as harmless "upcoming".) The banner renders on past months too (it is not gated to the current month, unlike the jars shelf).
- **Automated:** Partial (`client/src/budgetModel.test.ts` "past unpaid = overdue")

### BILL-029 - A paid bill in a past month reads paid, not overdue
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on June 2026 (past); its Rent bill is **paid**.
- **Steps:**
  1. View June 2026 and hover the paid bill's tag.
- **Expected:** `billStatus` = 'paid' (the `isPaid` check precedes the past-month check), so the tag stays the neutral "Bill" (tooltip "Bill due on day 1") and the bill does not add to the banner's overdue count. Only genuinely *unpaid* past bills are overdue.
- **Automated:** Partial (`client/src/budgetModel.test.ts` paid special-cased)

---

## Due-day clamping in short months

### BILL-030 - A day-31 bill viewed in February shows the clamped day
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (`effectiveDueDay` clamp; tooltip uses the clamped `dueDayEffective`)
- **Preconditions:** Ana; a bill line with `DueDay 31` on **February 2026** (28 days, non-leap).
- **Steps:**
  1. View February 2026 and hover the bill tag.
- **Expected:** `effectiveDueDay(31, 2026, 2)` = `min(31, 28)` = **28**. The tooltip shows day **28** ("Bill due on day 28" / "Overdue — was due on day 28"), and urgency is scored against day 28 (not a non-existent Feb 31). The stored `DueDay` remains 31 (only the display/scoring clamps).
- **Automated:** Partial (`client/src/budgetModel.test.ts` "due-day clamped in short months")

### BILL-031 - Leap February clamps day 31 to 29
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Ana; a bill `DueDay 31` on **February 2028** (leap, 29 days).
- **Steps:**
  1. View February 2028 and hover the tag.
- **Expected:** `effectiveDueDay(31, 2028, 2)` = `min(31, 29)` = **29** (`new Date(2028, 2, 0).getDate()` = 29). Tooltip and scoring use day 29. Confirms the clamp is calendar-correct, not a hardcoded 28.
- **Automated:** Partial (`client/src/budgetModel.test.ts` effectiveDueDay clamp)

---

## Bill state across a month copy

### BILL-032 - Copy carries the due day but resets paid
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 / gotcha "DueDay carries on copy; IsPaid resets" (map §7.10)
- **Preconditions:** Ana; June 2026 has a Rent bill `DueDay 1`, **paid**; July 2026 does not yet exist.
- **Steps:**
  1. On the July not-found create screen click **"Start July"** (`POST /api/budget { year:2026, month:7, copyFromPrevious:true }`).
- **Expected:** The new July Rent line keeps `DueDay = 1` (copied — bills recur) but `IsPaid = false` (never copied → reset each month; `CreateBudgetMonthCommandHandler` sets `DueDay = i.DueDay` and omits `IsPaid`). July's Rent therefore shows the "Bill" tag but appears unpaid in the banner (0/… paid). Conversely, a line whose bill was **cleared** in June (`DueDay null`) copies as a plain non-bill line — clearing sticks across the copy, nothing re-arms a due day.
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs` "CreateBudgetMonth carries the due day but resets paid"; `CreateBudgetMonthTests.cs`)

---

## Roles & optimistic rollback

### BILL-033 - Limited can toggle Paid but cannot change bill structure
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** **Liam** (Limited, `canEnterData` true, `canWrite` false) signed in on household A, July 2026.
- **Steps:**
  1. Inspect the "Rent" bill row and hover it.
  2. Attempt to set/clear a bill via the API: `PUT /api/budget/items/{grocId}/bill { dueDay: 10 }`.
- **Expected:** The "Bill" tag renders as a **static span** (not a button — `canWrite && onSetBill` is false), there is **no** 📅 add-bill button and **no** due-day editor on any line, but the **☐/☑ Paid** toggle **is** shown and works (`SetBudgetItemPaidCommand` is `[AllowLimited]`). The direct `…/bill` call → **403** "Your access level (Limited) does not permit this action." (`SetBudgetItemBillCommand` is an undecorated Command → Admin+).
- **Automated:** No

### BILL-034 - ReadOnly sees no Paid toggle and cannot mark paid
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** **Rhea** (ReadOnly, `canEnterData` false) signed in on household A, July 2026.
- **Steps:**
  1. Inspect the "Rent" bill row.
  2. Attempt `PUT /api/budget/items/{rentId}/paid { isPaid: true }` directly.
- **Expected:** The "Bill" tag is a static span and **no** `Paid` toggle renders (gated on `canEnterData`). The amber read-only banner shows at the top. The direct `…/paid` call → **403** "Your access level (ReadOnly) does not permit this action." ([AllowLimited] admits Owner/Admin/Limited only; ReadOnly = role 3 is rejected).
- **Automated:** Partial (`client/src/pages/RoleGating.test.tsx` asserts ReadOnly hides data-entry controls generally; the Paid toggle specifically is not asserted)

### BILL-035 - A failed bill/paid update rolls back and shows the fixed error
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana on July 2026; force the next `PUT …/bill` or `…/paid` to fail (network error / 4xx/5xx).
- **Steps:**
  1. Toggle "Rent" paid (or change its due day) while the request is stubbed to reject.
- **Expected:** The optimistic change shows instantly (button flips / tag updates, "Saving…" pulse), then on rejection `setPaid`/`setBill` restore the pre-action `snapshot` (via `setMonth(snapshot)`) and set the rose error strip **"Could not update that bill — reverted."**. Both the row and the bills banner return to their prior values. The server's real validation text is *not* surfaced (swallowed into the fixed string).
- **Automated:** Partial (`client/src/pages/DashboardPage.test.tsx` covers optimistic rollback for planned edits; the bill/paid rollback path shares the same mechanism but isn't separately asserted)
