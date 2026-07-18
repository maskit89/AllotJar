# Time & data lifecycle (year boundaries, leap years, due-day clamping, dating & long-horizon accumulation)

**ID prefix:** TIME | **Scope:** The cross-feature behaviour that only shows up when the clock and the calendar move: the December→January **year-boundary rollover** as it threads through month navigation, copy-source selection, bill carry, jar accrual re-seeding and reports; **leap-year February** and 29/30/31 **due-day clamping** across the dashboard bill strip, the copy path and the domain; **transaction dating** (past/future/UTC-boundary dates) and how a transaction's budget attribution is actually decided by the *assigned line's month*, not its date, while the register hero labels the app-wide viewed month but sums all-time; **out-of-order month creation** and the strictly-before as-of balance used to seed jars when back-filling; **jar time horizons** — cover windows that span a year end, `TargetDate` in the past, recurring jars re-arming across cycles and years, `DailyRate` day-counts; **import date parsing** — one date-format-per-file resolution, ambiguous dd/MM vs MM/dd, 2-digit-year pivoting, the ±4-day possible-duplicate window across month/year edges, and 4-digit-year `BankReference` signatures; **locale date display** vs the money number-format preference and the always-English TopBar month label; **month-list ordering** across a year edge; and **data accumulation over 12+ months** (the 6-budget trends window, the un-paginated register, ever-growing all-time balances). This file stitches subsystems together at their date seams; it does not re-test any single area's own date handling. | **Out of scope:** the four hero footnote states, the bills strip rendering, group/line CRUD, inline planned editing and the jars shelf mechanics → **06-dashboard-budget-view.md**; month create/copy/template mechanics, the not-found create card, the `‹ Month Year ›` navigator's own controls, first-ever-month and duplicate/concurrent-create recovery → **07-month-lifecycle.md**; transaction/transfer/split CRUD, the assign picker, transfer currency guard → **transactions & transfers file**; jar CRUD, the New/Edit-jar modal, allocation waterfall/commit → **jars & allocation file**; import upload/mapping/commit flow, dedup mechanics, transfer heuristics → **import file**; reports card layout, empty/partial states and feature-flag gating → **reports & landing file**; per-currency money formatting and `parseMinor` → **account-preferences / dashboard files**. **Do not re-file as bugs:** deferred multi-currency FX (ExchangeRate hardcoded 1 outside imports); the unbounded month navigator vs 2000–2100 create clamp (a known soft dead-end); the register hero label naming the viewed month while data spans all time (known label/data mismatch).

**Test data setup:** Local stack (API :5099, `ASPNETCORE_ENVIRONMENT=Development`, `RateLimiting__AuthPermitLimit=1000`) or staging (staging.allotjar.com). **Assumed "today" = Wednesday 15 July 2026** (browser local clock **and** server UTC agree unless a case says otherwise), so **July 2026 is the current month**. Browser locale **en-GB**, money number-format **comma-dot** (renders `€1,234.56`), currency **EUR** (noun "euro"). Passwords are random `Aa1-<uuid>` (HIBP rejects fixed common ones). Logins: **time-owner@example.test** (Owner of household "Timeline"); **time-solo@example.test** (jar-less, zero months). Household "Timeline" fixture months **JUN26** and **DEC26**; JUN26 has Income group **"Income"** (Salary planned 2,500.00), expense group **"Housing"** (Rent 1,000.00 `dueDay 1` paid; Council Tax 150.00 `dueDay 31` unpaid), expense group **"Food"** (Groceries 400.00), savings group **"Savings"** with fund line **Holiday**. Household jars: **Holiday** (Kind Goal, Accrual TargetByDate, target 1,200.00, **no target date** → seeds `(1,200 − balanceₐₛ₋ₒf) ÷ 12` = 100.00/mo at zero balance); **Insurance** (Kind Recurring, Accrual TargetByDate, RecurMonths 12, target 600.00, anchor `TargetDate` 2025-12-15); **Boiler Service** (Kind Recurring, RecurMonths 3, anchor 2026-01-31, target 300.00). Money is `decimal(18,4)` server / integer minor units client; actuals are ALWAYS transaction-derived at read time; `POST /api/budget` returns **200** with the full recomputed `BudgetMonthDto`; there is no month-delete verb.

---

## 1. December → January year-boundary rollover

### TIME-001 - Navigating ‹ › across December rolls the year and moves every month-scoped screen together
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** time-owner signed in, viewing **December 2026** (DEC26 exists).
- **Steps:**
  1. In the TopBar click **›** (aria-label "Next month").
  2. Read the navigator label and the dashboard content.
  3. Navigate to `/transactions`, then `/reports` without touching the navigator again, then back to `/`.
  4. Click **‹** (aria-label "Previous month") twice.
- **Expected:**
  - Step 1 sets `MonthContext` to `{year:2027, month:1}` — label reads **"January 2027"** (English month name from `MONTH_NAMES`, not localized), tracks `monthNavigated {direction:'next'}`.
  - The dashboard now requests `GET /api/budget/2027/1` (year incremented, month rolled to 1), showing that month's create/loaded state — not a December view.
  - The transactions register hero eyebrow reads "Money in · January 2027" (label follows the shared month) even though the register list/totals still span all transactions ever (see TIME-018); Reports ignore the shared month entirely (TIME-024).
  - Step 4: from January 2027, **‹** goes to December 2026 then November 2026 — the first **‹** rolls the year back to 2026.
  - Extends **07-month-lifecycle.md** BUDG-039 (single-screen roll) to the app-wide multi-screen + label-localization angle.
- **Automated:** No

### TIME-002 - Copying January 2027 picks December 2026 as the source across the year boundary
- **Priority:** P0
- **Type:** Boundary
- **Preconditions:** time-owner; DEC26 is the most-recent existing month; viewing **January 2027** with no budget (writer not-found state).
- **Steps:**
  1. On the "No budget for January 2027 yet." card read the copy button label, then click it.
- **Expected:**
  - The button reads **"Copy December 2026"** — `prevBudget` is the most-recent month *strictly before* the target by absolute (year,month) ordering, so it reaches back across the year edge, not to a January.
  - `POST /api/budget {year:2027, month:1, copyFromPrevious:true}` → 200; the new month carries December's groups/lines, `DueDay` values, `ExcludeFromAllocation`, `SavingsId` identity, `BaseCurrency`; `IsPaid` resets to false; actuals are 0 (Jan 2027 has no transactions).
  - Builds on **07-month-lifecycle.md** BUDG-007 (source is strictly-before) — this case pins the cross-year selection specifically.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copy uses the caller's most-recent prior month and resets actuals/paid)

### TIME-003 - January 2027 re-seeds seedable jar lines from the January-2027 as-of balance, not December's amount
- **Priority:** P0
- **Type:** Boundary
- **Preconditions:** time-owner; DEC26 exists with a Holiday fund line; jar Holiday target 1,200.00, no date; some Holiday contributions exist in months ≤ Dec 2026.
- **Steps:**
  1. Copy December 2026 into January 2027 (TIME-002).
  2. Inspect the Holiday fund line's planned amount in January 2027.
- **Expected:**
  - The Holiday line is re-seeded at `RequiredMonthlyContribution(jar, 2027-01-01, OpeningBalance + asOfBalance)` where the as-of balance counts only months **strictly before** January 2027 (i.e. through December 2026) — it does NOT copy December's planned figure flat.
  - With no target date the seed is `(1,200 − balance) ÷ 12`; the balance reflects contributions accrued through Dec 2026, so a partly-funded jar shows a smaller January contribution than a fresh 100.00.
  - Non-seedable lines (target 0 or ProportionalPool jars) still copy flat; archived-jar lines are dropped.
  - Crosses month-create (07) + jar accrual (jars file) at the year edge; extends BUDG-015/BUDG-035.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — backfilled/created month seeds jar from the as-of-that-month balance, not all-time)

### TIME-004 - A day-31 bill carried Dec→Jan stays day 31 and renders day 31 in January
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** time-owner; DEC26 has Council Tax `dueDay 31` (December has 31 days).
- **Steps:**
  1. Copy December 2026 into January 2027.
  2. Hover the Council Tax **Bill** tag in January 2027.
- **Expected:**
  - The stored `DueDay` copies unchanged (31); January also has 31 days, so the tooltip reads "Bill due on day 31" (no clamping needed) and `IsPaid` is reset to unpaid.
  - Contrast TIME-007/TIME-008 where the same value clamps in short months — clamping is display-only and per-rendered-month.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs — CreateBudgetMonth carries the due day, resets paid)

### TIME-005 - Trends and annual reports split the Dec 2026 / Jan 2027 pair correctly across the year edge
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** time-owner; consecutive budgets exist for Nov 2026, Dec 2026, Jan 2027 (each with some planned income + spending); `features.reports` on.
- **Steps:**
  1. Open `/reports`.
  2. Read the "Income vs spending" trend columns.
  3. In "Annual overview" use **Previous year** / **Next year** to view 2026 then 2027.
- **Expected:**
  - Trends plot the most-recent budgets chronologically, so Dec 2026 and Jan 2027 appear as **adjacent columns** with aria-labels "Trend for Dec 2026" and "Trend for Jan 2027" — the window does not reset at the year boundary.
  - Annual 2026 shows December in its December row; Annual 2027 shows January in its January row — the same rollover pair lands in two different annual tables (each always 12 Jan–Dec rows, `Key = "{year:D4}-{month:D2}"`).
  - Net/Income/Spent for each month are consistent between the trend column and its annual row.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs — chronological points, window cap; AnnualSummaryTests.cs — 12 months with gaps, year-scoped)

---

## 2. Leap years & short-month due-day clamping

### TIME-006 - A day-31 bill clamps to 28 in February 2026 and to 29 in February 2028
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** time-owner; a Feb 2026 month and a Feb 2028 month each with a bill line `dueDay 31` (non-leap vs leap).
- **Steps:**
  1. View February 2026, hover the bill's **Bill** tag.
  2. Navigate to February 2028 (via the navigator), hover the same-named bill's tag.
- **Expected:**
  - `effectiveDueDay(31, 2026, 2)` = `min(31, new Date(2026,2,0).getDate())` = **28** → tooltip "…day 28".
  - `effectiveDueDay(31, 2028, 2)` = **29** (2028 is a leap year) → tooltip "…day 29".
  - The stored `DueDay` remains 31 in both months (clamp is display/scoring only); the dashboard bill strip's overdue/due-soon scoring uses the clamped day.
  - Cross-references **06-dashboard-budget-view.md** DASH-055 (single-month clamp) — this case pins the leap vs non-leap difference for the identical stored value.
- **Automated:** Partial (client/src/budgetModel.test.ts — due-day clamped in short months; tests exercise the clamp but not both leap/non-leap years side by side)

### TIME-007 - A leap-day (Feb 29) bill copied into a non-leap February clamps to 28
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** time-owner; Feb 2028 (leap) has a bill with `dueDay 29`; Feb 2029 is the copy target (2029 is not a leap year). (Copy source is the most-recent prior month; arrange months so Feb 2028 is that source, or copy Jan 2029→Feb 2029 with a day-29 bill.)
- **Steps:**
  1. Create February 2029 by copying its most-recent prior month, which carries a `dueDay 29` bill.
  2. Hover the bill tag in February 2029.
- **Expected:**
  - `DueDay 29` copies unchanged; February 2029 has 28 days, so `effectiveDueDay(29, 2029, 2)` = **28** → tooltip "…day 28" and the bill scores against day 28.
  - No value is lost or rewritten — moving forward again to a month with ≥29 days would render 29 again.
- **Automated:** No

### TIME-008 - A day-30/31 bill renders its true day in 30- vs 31-day months
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** time-owner; a bill line with `dueDay 31` present across April 2026 (30 days) and May 2026 (31 days).
- **Steps:**
  1. View April 2026, hover the bill tag.
  2. Navigate to May 2026, hover the bill tag.
- **Expected:**
  - April: `effectiveDueDay(31,2026,4)` = **30** → "…day 30". May: **31** → "…day 31".
  - Confirms the clamp is `min(dueDay, daysInMonth)` for every month, not just February, and is stable across navigation because each month stores the same raw 31.
- **Automated:** Partial (client/src/budgetModel.test.ts — effectiveDueDay clamp)

---

## 3. Transaction dating & actuals attribution

### TIME-009 - A transaction's budget attribution follows the assigned line's month, never the transaction date
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** time-owner; July 2026 is the current month with a Groceries line; a transaction exists dated **2026-08-20** (a future month) but assigned to July's Groceries line.
- **Steps:**
  1. On `/` viewing July 2026, read Groceries' spent actual.
  2. Navigate to August 2026 (if a budget exists) and read any Groceries actual there.
- **Expected:**
  - The August-dated transaction contributes to **July** Groceries' actual (it is assigned to July's `BudgetItemId`); actuals group by assignment, not by `Transaction.Date`.
  - August's Groceries line (a different `BudgetItemId`) shows 0 from this transaction.
  - Demonstrates the core seam: dating a transaction in another month does not move its budget impact; only re-assigning does.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/BudgetActualsTests.cs — actuals sum assigned transactions; attribution is by BudgetItemId)

### TIME-010 - The assign picker only offers the current calendar month's lines, so a past-dated transaction cannot be pointed at a past month from the UI
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** time-owner; server UTC current month = July 2026 (drives `/budget/current`); a transaction dated **2026-05-03** sits Unassigned in the register; a May 2026 budget with its own Groceries line also exists.
- **Steps:**
  1. On `/transactions` click the dashed **"+ Assign"** pill on the May-dated row.
  2. Inspect the category options.
- **Expected:**
  - The picker is built from `buildItemOptions(month)` where `month` is `/budget/current` (July 2026) — options are **July's** lines only; there is no way to select May's Groceries line, regardless of the row's May date.
  - Assigning lands the May-dated transaction on a July line (July's actual), reinforcing TIME-009.
  - If `/budget/current` is absent/failed, the picker offers only "Unassigned".
- **Automated:** No

### TIME-011 - The Add-transaction date defaults to the UTC calendar date, which can differ from the user's local date near midnight
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; browser clock set to a negative-offset zone (e.g. America/Los_Angeles) at **19:00 local on 2026-07-15** (= 2026-07-16 02:00 UTC).
- **Steps:**
  1. Click **+ Add transaction**; read the pre-filled **Date** field.
- **Expected:**
  - The default is `new Date().toISOString().slice(0,10)` = **2026-07-16** (UTC date), a day ahead of the user's local 15 July; a positive-offset early-morning user would instead see the prior day.
  - The user can override the date; but an un-edited evening entry in the Americas is dated "tomorrow", which then feeds the tx-date-month currency stamp (TIME-013) and, if it crosses a month end, the possible-duplicate window on import matching.
  - Contrast the dashboard's own `today` (browser-local `new Date()`, TIME-021) — the two surfaces read the clock differently.
- **Automated:** No

### TIME-012 - A future-dated transaction is accepted and shown, and its all-time totals count regardless of the viewed month
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; viewing July 2026.
- **Steps:**
  1. Add an Income transaction dated **2027-01-10** for 500.00, assigned or not.
  2. Read the register hero "Money in · July 2026".
  3. Navigate the TopBar to December 2026 and re-read the register.
- **Expected:**
  - The future-dated income is created with no date restriction; `shortDate("2027-01-10")` renders **"10 Jan"** (en-GB, **no year** — see TIME-019) in the register.
  - "Money in" includes the 500.00 because the hero sums ALL income transactions (all-time); only the eyebrow label changes with the viewed month, never the underlying total or the row list.
  - Navigating to December 2026 does not filter the row out — the register never refetches/filters by the viewed month.
- **Automated:** No

### TIME-013 - A transaction's currency is stamped from its own date-month's budget, not the viewed month
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** time-owner; May 2026's `BudgetMonth.BaseCurrency` is EUR; a hypothetical month with a different base currency is NOT the tx-date month.
- **Steps:**
  1. Add a transaction dated **2026-05-20** while viewing July 2026.
  2. Inspect the stored `currency` on the created row.
- **Expected:**
  - Currency = the **May 2026** month's `BaseCurrency` (the tx-date month), else EUR when May has no budget; `ExchangeRate` stays 1 (manual entries never resolve FX).
  - This is display-only today (rate 1), but confirms the stamp keys off `Transaction.Date`'s month, independent of the app-wide viewed month.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/FxRateResolverTests.cs — defaults to EUR when no budget for that month; ManualTransactionTests — currency stamped from tx-date month)

---

## 4. Out-of-order month creation & as-of jar seeding

### TIME-014 - Back-filling an earlier month seeds jars from that month's as-of balance, unaffected by later months already created
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** time-owner; months exist for **September 2026** and **October 2026** with funded Holiday contributions; **July 2026** does NOT yet exist; Holiday jar target 1,200.00, no date.
- **Steps:**
  1. Navigate to July 2026 and create it (blank or copy).
  2. Inspect July's Holiday fund line planned amount.
- **Expected:**
  - July's seed uses `JarBalances.ComputeAsync(asOf:(2026,7))`, which counts only months **strictly before** July — September's and October's contributions are excluded, so the later months cannot zero-out or shrink the back-filled July seed.
  - The seed is `(1,200 − balance-through-June) ÷ 12`; creating July does not retro-edit September/October.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — backfilled month seeds from as-of-that-month balance, not all-time)

### TIME-015 - Creating months out of chronological order keeps the jars shelf's all-time balance coherent
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** time-owner; today = July 2026; create months in the order Oct 2026 → Jul 2026 → Aug 2026, each with a Holiday contribution.
- **Steps:**
  1. After creating all three out of order, view the **current** month (July 2026) on `/`.
  2. Read the "Your jars" shelf Holiday balance and compare with the Holiday fund line's "avail." on the grid.
- **Expected:**
  - The shelf's `JarDto.currentBalance` sums Holiday planned across **all** months (Jul+Aug+Oct here) minus any spend, **plus** `OpeningBalance` — creation order does not matter, only the set of months.
  - The grid "avail." for July sums planned−spent across months **≤ July** and **excludes** `OpeningBalance`, so it can legitimately differ from the shelf figure by the opening balance and by the not-yet-≤-July future months (Aug/Oct).
  - The shelf only renders on the current calendar month (July), not on Aug/Oct.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/SavingsTests.cs — balance counts months up to and including the viewed one; JarsTests — balance = opening + contributions − spend)

### TIME-016 - Month list ordering is newest-first by (year, month), across a year edge
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** time-owner; months exist for Nov 2026, Dec 2026 and Jan 2027.
- **Steps:**
  1. Call `GET /api/budget/months` (or observe any month-list-driven UI such as the Reports breakdown select).
- **Expected:**
  - Order is **Jan 2027, Dec 2026, Nov 2026** (Year desc then Month desc) — January of the new year sorts *ahead of* December of the old year, not by raw month number.
  - The Reports "Spending by category" month `<select>` lists the trend window's months newest-first with labels like "Jan 2027", "Dec 2026".
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — GetMonths newest-first)

---

## 5. Jar time horizons

### TIME-017 - A StraightLine cover window that spans a year end computes the right month count
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** time-owner; a jar with Accrual StraightLine, target 600.00, `CoverStart` 2026-11-01, `CoverEnd` 2027-02-01.
- **Steps:**
  1. View the jar's monthly set-aside on `/jars` (or read `requiredMonthlyContribution`).
- **Expected:**
  - Cover months = `MonthsBetween(2026-11, 2027-02)` = (2027×12+2) − (2026×12+11) = **3**, computed on the absolute month index so it crosses the year edge cleanly; monthly = `Round2(600 ÷ 3)` = **200.00**.
  - A window with `CoverEnd ≤ CoverStart` would fall back to ÷12; StraightLine ignores the balance (over-fills if seeded every month).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/JarAccrualCalculatorTests.cs — StraightLine = target/cover-period length)

### TIME-018 - A Goal jar with a target date in the past reads Behind and demands the full remainder this month
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** time-owner; a Goal jar target 900.00, `TargetDate` 2026-03-15 (past, asOf 2026-07-15), current balance 300.00.
- **Steps:**
  1. View the jar on `/jars`; read its status chip and monthly set-aside.
- **Expected:**
  - Goal dates never roll, so `EffectiveTargetDate` = 2026-03-15 < asOf → **Behind** status chip.
  - `TargetByDate`: remaining = 900 − 300 = 600; `MonthsBetween(2026-07, 2026-03)` is negative → floored to **1** → monthly = `Round2(600 ÷ 1)` = **600.00** (catch-up this month).
  - A funded past-due Goal (balance ≥ target) shows 0/mo and FullyFunded, never Behind.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarLifecycleTests.cs — past-due Goal stays Behind; JarAccrualCalculatorTests — floors at one month when overdue, 0 when funded)

### TIME-019 - A Recurring jar with a passed anchor re-arms to the next cycle across the year, preserving the day-of-month
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #141–#146 / jar recurrence is a pure view — the stored anchor is NEVER rewritten
- **Preconditions:** time-owner; Insurance jar (Recurring, RecurMonths 12, anchor `TargetDate` 2025-12-15, target 600.00), asOf 2026-07-15.
- **Steps:**
  1. View Insurance on `/jars`; read the projected-full date in the pace label.
  2. Open the Edit-jar modal and read the **"Next due"** date field.
- **Expected:**
  - `EffectiveTargetDate` jumps whole 12-month cycles from the anchor: cycles = `MonthsBetween(2025-12,2026-07)/12` = 0 → 2025-12-15 < asOf → +1 cycle → **2026-12-15** (≥ asOf) — day 15 preserved, no compounding drift; accrual spreads remaining over the months to 2026-12-15.
  - The Edit modal shows the **stored anchor 2025-12-15** (the DTO returns the anchor so edits round-trip), NOT the rolled 2026-12-15 — the roll is view-only.
  - A healthy past-due Recurring jar reads OnTrack (it re-arms), unlike the Goal in TIME-018.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarLifecycleTests.cs — EffectiveDate rolls a passed recurring date forward by cycle, anchor never rewritten, month-end day preserved; rolls across multiple missed cycles)

### TIME-020 - A quarterly Recurring jar anchored on the 31st rolls to month-end without permanent drift
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** time-owner; Boiler Service jar (Recurring, RecurMonths 3, anchor 2026-01-31, target 300.00), asOf 2026-07-15.
- **Steps:**
  1. Read the jar's effective due date / projected-full month.
- **Expected:**
  - Each roll is `anchor.AddMonths(cycles × 3)` from the fixed anchor, so cycles = `MonthsBetween(2026-01,2026-07)/3` = 2 → 2026-01-31.AddMonths(6) = **2026-07-31** (≥ asOf, valid 31-day month).
  - Because rolls always start from the anchor (not the previous roll), a step into a short month clamps to that month's end (e.g. a step landing in a 30-day month yields the 30th) but the anchor's 31 is never lost — the next long month renders 31 again. No cumulative drift toward the 28th.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarLifecycleTests.cs — rolls across multiple missed cycles, month-end day preserved across rolls)

### TIME-021 - The current-month boundary (jars shelf, checklist) can disagree with the server's UTC "current" near midnight
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; browser clock in a positive-offset zone at **00:30 local on 2026-08-01** (= 2026-07-31 22:30 UTC); jars exist.
- **Steps:**
  1. Load `/` without touching the navigator; observe which month the dashboard defaults to and whether the "Your jars" shelf renders.
  2. Observe what `/budget/current` (server UTC) resolves to for the Getting-started checklist.
- **Expected:**
  - `MonthContext` defaults to browser-local now = **August 2026**; the dashboard `today = new Date()` (browser-local) makes `isCurrentMonth` true for August, so the shelf renders on August.
  - `/budget/current` uses `DateTime.UtcNow` = **July 2026** (still July in UTC) — the checklist's "current" month can be July while the viewed/shelf month is August, a legitimate one-user split near the boundary in non-UTC zones.
  - No data corruption; purely a which-month-is-"now" divergence between browser-local and server-UTC clocks.
- **Automated:** No

---

## 6. Import date parsing & the calendar

### TIME-022 - A generic CSV locks one date format for the whole file; ambiguous dd/MM vs MM/dd resolves dd/MM-first
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #154/#159 / per-file date-format lock (was per-row, which baked wrong dates into references)
- **Preconditions:** time-owner (Admin+), `features.camtImport` on; a generic CSV whose dates are all ≤ the 12th (e.g. `03/07/2026`, `05/06/2026`) so both dd/MM and MM/dd parse every row.
- **Steps:**
  1. `/import` → File format "Bank CSV (auto-detect)" → upload → **Review transactions**.
  2. Read the "We read your dates as **{label}**" readout and the sample rows' interpreted dates.
- **Expected:**
  - `ResolveDateFormat` picks the single format parsing the most rows, tie-broken by preference order (ISO first, then **dd/MM before MM/dd**), so `03/07/2026` is read as **3 July 2026**, not 7 March; the label echoes "DD/MM/YYYY" and pins it into the mapping for re-scans.
  - Every row uses that one format; the applied format is echoed as `ResolvedDateFormat`. Overriding "Date format" to MM/DD/YYYY and re-scanning re-reads the whole file as month-first.
  - A file that only parses cleanly under MM/dd resolves to MM/dd; PR #154's accepted trade-off is that such rows re-appear once after the format lock changed how they were previously read.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs — one date format locked for the whole file; explicit date format wins over scan; client ImportPage.test.tsx — "We read your dates as …" readout)

### TIME-023 - A 2-digit-year CSV pivots via the invariant-culture window and stores a 4-digit year in the reference
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** time-owner; a generic CSV using a 2-digit-year format, e.g. rows `29/12/29` and `01/01/30` under `dd/MM/yy`.
- **Steps:**
  1. Upload and review; if needed set **Date format** to DD/MM/YY and re-scan.
  2. Read the interpreted dates in the sample/preview, then commit and check the stored transaction dates.
- **Expected:**
  - `DateOnly.TryParseExact(..., CultureInfo.InvariantCulture)` applies the invariant Gregorian two-digit-year pivot (default max **2029**): `29` → **2029**, `30` → **1930**. (Verify the exact pivot in the running build — it is culture/framework-dependent; the code pins `InvariantCulture`.)
  - 2-digit formats sit AFTER their 4-digit peers in `DateFormats` and `TryParseExact` is length-strict, so a genuine 4-digit file is never mis-resolved to a YY format.
  - The stored transaction date and the `BankReference` signature both use the resolved **4-digit** year (`{date:yyyy-MM-dd}`), so a mis-pivoted year bakes into the dedup key — re-importing the same file re-dedups only if the pivot resolves identically.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/ParserToleranceTests.cs — 2-digit years parsed; references stable across releases)

### TIME-024 - The ±4-day possible-duplicate window matches across a month/year boundary
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** time-owner; an existing transaction dated **2026-12-31**, amount 42.50 EUR, payee "TESCO", assigned to any line; a re-import CSV containing a row dated **2027-01-02**, amount 42.50, payee containing "TESCO".
- **Steps:**
  1. Upload the CSV and open Review.
- **Expected:**
  - The 2 Jan 2027 row is flagged **"Possibly already imported"** (default unticked, amber tint): the ±4-day window is a date-difference in days (`2026-12-31` → `2027-01-02` = 2 days), so it spans the year boundary; amount must match exactly, currency equal, direction compatible, payee normalized-equal-or-contains.
  - A distinct `BankReference` (different date signature) means it is NOT an exact dedup skip — only a soft hint the user can tick to import anyway.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/ImportPreviewCommitTests.cs — possible-duplicate date-window boundary [Theory], requires matching direction+currency)

### TIME-025 - A CAMT entry with no bookable date is skipped, never dated "today"
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** time-owner; a CAMT.053 XML with one entry missing both `BookgDt` and `ValDt` (and other valid entries).
- **Steps:**
  1. Upload as "CAMT.053 statement (XML)" and review.
- **Expected:**
  - The date-less entry is dropped (per-entry tolerance) and never fabricated to the import date or today; the other entries import normally; the file does not abort.
  - Guards against a whole statement's undated rows silently landing in the current month.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/ParserToleranceTests.cs — CAMT entry without a date is skipped, never booked today; malformed entry skipped without failing the statement)

### TIME-026 - HSBC rows use the purchase date, so a statement straddling a year end books rows into the right year
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** time-owner; an HSBC transaction-history CSV whose Details encode a **purchase date 2026-12-30** while the **posting date is 2027-01-02**.
- **Steps:**
  1. Upload as "HSBC transaction history (CSV)" and review the interpreted date.
- **Expected:**
  - The entry's `BookingDate` = the **purchase date 2026-12-30** (fallback to posting date only when Details lack one) — so a late-December purchase posted in January books into December, not January.
  - The `BankReference` signature includes both `{postingDate:yyyy-MM-dd}|{purchaseDate:yyyy-MM-dd}` with 4-digit years; `formatDate` in the review table shows the full year for straddling rows.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/HsbcCsvStatementParserTests.cs — purchase date, not posting date; references stable across releases)

---

## 7. Locale date display & month labels

### TIME-027 - Register dates follow the browser locale while money follows the number-format preference (independent sources)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** time-owner with money number-format **dot-comma** (de-DE, renders `€1.234,56`) but a **en-US** browser (`navigator.language`); a transaction dated 2026-06-20 for 1234.56.
- **Steps:**
  1. On `/transactions` read the row's Date cell and Amount cell.
- **Expected:**
  - Date = `shortDate("2026-06-20")` in the **browser** locale (en-US) → **"Jun 20"**; amount formatted with the **money preference** (de-DE grouping) → **`€1.234,56`**.
  - Dates ignore the money number-format preference entirely (`dateLocale()` reads `navigator.language`), so the two can legitimately use different locales in one row.
- **Automated:** Partial (client/src/lib/dates.test.ts — shortDate compact month+day, no TZ day-shift; client/src/lib/money.test.ts — de-DE/en-GB/fr-FR/de-CH/en-IN groupings)

### TIME-028 - The TopBar month label is always English regardless of locale, while dates below it localize
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** time-owner; browser locale **de-DE**; viewing June 2026 with transactions.
- **Steps:**
  1. Read the TopBar navigator label and a register row's date.
- **Expected:**
  - The navigator label uses `MonthContext.MONTH_NAMES` (hardcoded English) → **"June 2026"** even for a German user; the register row localizes via `shortDate` → **"20. Juni"**.
  - A deliberate inconsistency to flag: the app-wide month label is not localized, unlike register/report/jar dates.
- **Automated:** No

### TIME-029 - The register shows no year, so same-day dates in different years look identical
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; two transactions, one dated 2025-12-20 and one dated 2026-12-20.
- **Steps:**
  1. On `/transactions` read both rows' Date cells.
  2. Open `/accounts/{id}` for the account and read the same rows.
- **Expected:**
  - Both render `shortDate` = **"20 Dec"** (en-GB) with **no year** — the register/account-detail deliberately drop the year (it "lives in the month picker"), so two December-20 rows from different years are visually indistinguishable by date alone (distinguish by list order: Date desc, Id desc).
  - Import review rows, by contrast, use `formatDate` (with year) precisely because statements can straddle a year boundary.
- **Automated:** Partial (client/src/lib/dates.test.ts — shortDate has no year; formatDate includes year)

### TIME-030 - `shortDate`/`monthYear` parse ISO as local midnight (no timezone day-shift) and pass non-ISO through unchanged
- **Priority:** P2
- **Type:** Regression
- **Origin:** dates.ts `fromIso` — avoids the UTC shift `new Date("2026-06-20")` causes in negative-offset zones
- **Preconditions:** browser in a negative-offset zone (e.g. UTC-8); a transaction dated 2026-06-20.
- **Steps:**
  1. Read the register date cell.
  2. (Dev/inspection) confirm a non-ISO string passes through `shortDate` unchanged.
- **Expected:**
  - `fromIso` builds `new Date(2026, 5, 20)` (local midnight), so the row shows **"Jun 20"** — never "Jun 19" from a UTC back-shift.
  - A jar pace label's `monthYear`/projected-full date ("full by Nov 2026") uses the same local-parse; a non-parseable input is returned verbatim (no crash).
- **Automated:** Yes (client/src/lib/dates.test.ts — no TZ day-shift; passthrough for non-ISO; monthYear month+year only)

---

## 8. Long-horizon accumulation (12+ months)

### TIME-031 - The trends window shows only the 6 most-recent budgets, skipping calendar gaps
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** time-owner; budgets exist for 8 non-contiguous months spanning >1 year (e.g. Feb, Apr, Jun, Aug, Oct, Dec 2026, Jan, Mar 2027); `features.reports` on.
- **Steps:**
  1. Open `/reports`; count the "Income vs spending" columns and read their month labels.
- **Expected:**
  - Exactly **6** columns — the most-recent 6 **budgets** (Jun, Aug, Oct, Dec 2026, Jan, Mar 2027), ordered chronologically — NOT the last 6 calendar months; the older Feb/Apr 2026 budgets fall outside the window.
  - Gaps between budgeted months render as adjacent columns (no empty in-between columns); "Avg monthly spend" divides by the number of points (6), not by elapsed calendar months.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs — window cap = most recent N; chronological points; ReportsPage.test.tsx — trend labels)

### TIME-032 - The annual year navigator is unbounded; a year with no budgets renders 12 dash rows
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** time-owner; budgets only in 2026; `features.reports` on.
- **Steps:**
  1. On `/reports` Annual overview click **Next year** repeatedly to 2030, then **Previous year** back past 2026 to 2024.
- **Expected:**
  - Every year loads: `GET /api/reports/annual/{year}` has an `:int` route constraint but **no range validation**, so 2030/2024 (and even year 0/9999) each return 12 `HasBudget:false` months → the Annual table always renders 12 rows with an em dash in Income/Spent/Net and 0 totals.
  - The "Average monthly spending by category" card disappears for a budget-less year (empty categories); `report_viewed {report_type:'annual'}` fires on each year-nav click.
  - No client-side year clamp — the navigator is symmetric to the domain's unbounded acceptance.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AnnualSummaryTests.cs — 12 months with gaps, empty year; ReportsPage.test.tsx — year nav)

### TIME-033 - Annual category averages accumulate over 12 months and split when a category is renamed mid-year
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; the "Food" expense category has actuals across Jan–Jun 2026, is renamed to "Groceries" in July, and has actuals Jul–Dec 2026 (12 budgeted months).
- **Steps:**
  1. On `/reports` view Annual 2026's "Average monthly spending by category" card.
- **Expected:**
  - Categories are keyed by `(Name, Kind)`, so "Food" and "Groceries" appear as **two separate rows**, each `AveragePerMonth = Round(total ÷ budgetedMonths, 2)` over the same 12-month denominator — a rename splits the year's history rather than merging it.
  - A same-named Expense vs Savings pair would likewise be two rows (the Savings one carries the violet **Fund** badge); deleting a category stops accumulation but its past actuals still count.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AnnualSummaryTests.cs — per-category average over budgeted months; keyed by name+kind)

### TIME-034 - The transactions register loads every row with no pagination as data accumulates over years
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; an account with 12+ months of imported history (hundreds of transactions).
- **Steps:**
  1. Open `/transactions`; observe the load and the "{n} transactions" count.
  2. Open `/accounts/{id}` for the account.
- **Expected:**
  - `GET /api/transactions` returns **every** row (unfiltered by month/year); the page renders all of them (no pagination/virtualization), and "{n} transactions" counts all loaded rows; account-detail similarly renders all rows touching that account.
  - As history accumulates over 12+ months the payload and DOM grow unboundedly — a soak/perf consideration, not a correctness bug; the hero all-time sums (Money in/out) grow accordingly while only the eyebrow label tracks the viewed month.
- **Automated:** No

### TIME-035 - Jar all-time balance and savings "available" both keep growing as months accumulate
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; the Holiday jar has a funded line in each of 14 consecutive months (target 1,200.00 already exceeded by contributions).
- **Steps:**
  1. On the current month's `/` read the shelf Holiday balance and the grid "avail.".
  2. On `/jars` read the Holiday balance and status.
- **Expected:**
  - `JarBalances` sums planned−spend across **all** months (+ opening) — the balance keeps climbing past the target; status becomes **FullyFunded** once `remaining == 0` and `RequiredMonthlyContribution` returns 0 (no negative demand), and **Overspent** only if spend drives the balance negative.
  - Grid "avail." (months ≤ viewed, no opening) also accumulates; the two figures stay offset by the opening balance and any future-month lines — the divergence is by design, not drift, however many months pile up.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/SavingsTests.cs — balance rolls over and subtracts spending, counts months ≤ viewed; JarsTests — FullyFunded/Overspent status)

### TIME-036 - A jar created mid-year plants lines into the current and future existing months but never past ones
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** time-owner; today = July 2026; existing months Jun 2026, Jul 2026, Aug 2026, Oct 2026; `features.jars` on.
- **Steps:**
  1. On `/jars` create a new jar "School Fees" (target 1,000.00) via **New jar** → **Add jar**.
  2. Inspect each existing month's Savings group for a "School Fees" line.
- **Expected:**
  - `CreateJar` appends the contribution line to the **current month (July)** and every already-created **future** month (Aug, Oct), each recomputed with earlier plantings folded in; **June (past) is left untouched**; a "Savings" group is created where missing.
  - "Future" is relative to the server's current calendar month (UTC-derived) — near a month boundary the set of months that receive a planted line can shift by one (ties to TIME-021).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — CreateJar plants its line in the current AND future months, leaves past months untouched, works with no months at all)
