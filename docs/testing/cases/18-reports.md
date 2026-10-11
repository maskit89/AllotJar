# Reports

**ID prefix:** RPT | **Scope:** Everything on `/reports` (`client/src/pages/ReportsPage.tsx` + its three server queries). The page (restyle PR 7) is one KPI row (the green hero `Saved this month` + the `Avg monthly spend` / `Savings rate` tiles) and three cards: **Trend** (the year's months as a chart of spent against received income, or as a Received/Spent/Net/Budgeted/Variance table with Total, with the year switcher in its header and the per-`(Name,Kind)` **Average month by category** table on its Table side), **Spending** (a month-selectable breakdown with an average-month tick per category and an **Uncategorised** row with its Assign chip) and **Jar spending** (each jar's payouts month by month in the year shown, as marks or a table). Covers the exact labels/aria, the loading/error/empty states, the computed money (saved-this-month, avg spend, savings rate, per-category %, annual net, bar scaling, the 2% sliver), sum correctness against budget data (splits counted once, transfers excluded, tx-derived actuals), the "most recent N **budgets** not last N months" window, `(Name,Kind)` category keying, silent partial-failure of the annual/breakdown fetches, the breakdown-currency follow behavior, the `Reports` feature-flag 404/redirect defence-in-depth, and single-month/read-only households. Endpoints: `GET /api/reports/trends?months={n}`, `GET /api/reports/annual/{year}`, and `GET /api/reports/month/{y}/{m}` (breakdown source — `MonthReportDto`: the budget's non-income groups net of refunds plus the month's transaction-dated uncategorised layer, rules 37–39/41). | **Out of scope:** the LandingPage / legal pages / staging banner / SEO / prerender that share the reports-landing subsystem map → **01-landing-public.md**; the dashboard budget view, `IsBalanced` empty-month hero, and month create/copy → **06-dashboard-budget-view.md** + **07-month-lifecycle.md**; transaction/split CRUD and transfer mechanics themselves → **10-transactions.md** + **11-transfers.md** (this file only asserts how they roll up into report sums); the full Owner/Admin/Limited/Read-only matrix and general nav gating → **25-roles-permissions.md** (only the area-specific "reports have no role gate" fact is here); session-expiry interceptor behavior mid-view → **03-session-auth-lifecycle.md**; dark-mode / responsive / axe sweeps → **26-ux-states.md**. **Do not test for:** a CSV/PDF export control (none exists); a date-range picker (only a year navigator + a month `<select>`); any write action on this page (it is read-only GET-only).

**Test data setup:** Local stack (API `:5099`, `ASPNETCORE_ENVIRONMENT=Development`) or staging (staging.allotjar.com). Assume **today = 2026-07-16**. Locale **en-GB** so money renders `€1,234.56`; budget currency **EUR** (every month's `baseCurrency`). Feature flag **`Reports` ON** (default). Money is `decimal(18,4)` server-side, integer minor units scale 4 client-side. Household **"Report House"** (owner **report-owner@example.test**, role Owner), solo (1 member) unless a case states shared.

**Baseline history "H2"** (two contiguous budgets — the household has NOT yet created July 2026, so the most-recent budget is June):
- **May 2026** — Income budgeted €3,000.00 / received €2,900.00; Housing (Expense) €1,400.00/€1,400.00; Food (Expense) €700.00/€1,000.00; Emergency Fund (Savings) €300.00/€300.00. Derived: spent €2,700.00, planned (non-income) €2,400.00.
- **June 2026** — Income budgeted €3,000.00 / received €2,950.00; Housing (Expense) €1,500.00/€1,400.00; Food (Expense) €800.00/€700.00; Emergency Fund (Savings) €300.00/€300.00. Derived: spent €2,400.00, planned €2,600.00.
- Trends window totals: TotalIncome €6,000.00, TotalIncomeReceived €5,850.00, TotalVariance −€150.00, TotalSpent €5,100.00. Default annual year = **2026**, default breakdown month = **Jun 2026** (`2026-06`).

Actuals are ALWAYS transaction-derived at read time (`BudgetActuals.ApplyAsync`): income lines roll up **Income** transactions, every other line rolls up **Expense** transactions; whole transactions add `BudgetAmount ?? Amount`, split slices add `Split.BudgetAmount ?? Split.Amount` (`BudgetAmount` is set only on a row on a legacy account kept in another currency — CURR-057; there is no exchange rate since W08; a row still waiting for its budget-currency amount — `FxPending` — and its slices add nothing and are only counted in `fxPendingCount`, which the page does not display); a split parent has `BudgetItemId == null` (no double count); transfers roll up into neither. A **refund** (an Income row linked to a purchase, `RefundOfTransactionId`) is subtracted from the expense/savings line it sits on (`RefundedAmount`) and never reaches an income line; rows and slices on **no** line are reported by their own date through `ReportFigures.ForMonthAsync` as **Uncategorised** (rules 37–39, 41).

---

## Page load, hero & summary

### RPT-001 - Reports page loads with the KPI row and its three cards
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed-in owner of "Report House" with baseline history H2.
- **Steps:**
  1. Sign in and click the `Reports` nav item (or navigate to `/reports`).
  2. Wait for `Loading your reports…` to clear.
- **Expected:** AppShell title `Reports` (no month switcher in the top bar). One KPI row: the green hero `Saved this month` with a gold amount and its "spent" sub-line, then the tiles `Avg monthly spend` and `Savings rate`, each with an (i). Three cards (h2s looked up by exact name, since "Spending" is inside "Jar spending"): `Trend`, `Spending`, then `Jar spending` (only when the household has jars). Desktop: Trend over Jar spending at the left, Spending at the right, sticky; a phone reads Trend, Spending, Jar spending. No error banner, no empty state.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-001/RPT-010)

### RPT-002 - Loading placeholder while trends fetch is in flight
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Owner with H2; `GET /reports/trends?months=6` artificially slow.
- **Steps:**
  1. Navigate to `/reports`.
  2. Observe the page before the trends response arrives.
- **Expected:** A muted paragraph reads exactly `Loading your reports…` (single ellipsis character). No hero, cards, empty state, or error while `loading` is true.
- **Automated:** No

### RPT-003 - Hero figures computed from the latest month and the window
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2. Latest budget = June (received €2,950.00, spent €2,400.00); window TotalSpent €5,100.00 over 2 points.
- **Steps:**
  1. Load `/reports`.
  2. Read the hero amount and both tiles.
- **Expected:** `Saved this month` = **€550.00** (`incomeReceived − spent` = 2,950 − 2,400) with aria-label `Saved this month: €550.00`. `Avg monthly spend` = **€2,550.00** (`round(5,100 / 2)`). `Savings rate` = **19%** (`round(550 / 2,950 × 100)`).
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

### RPT-004 - Overspent latest month shows negative saved amount and negative rate
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner whose latest budget (June) has received €2,300.00 and spent €2,600.00.
- **Steps:**
  1. Load `/reports`.
  2. Read the hero amount and `Savings rate` tile.
- **Expected:** `Saved this month` = **−€300.00** (formatted as negative money, no special color styling in the hero). `Savings rate` = **−13%** (`round(−300 / 2,300 × 100)`). Page still renders fully (negative saving is not an error).
- **Automated:** No

### RPT-005 - Savings rate is 0% when no income was received
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner whose latest budget has `incomeReceived = 0` (income planned but nothing tracked) and spent €800.00.
- **Steps:**
  1. Load `/reports`.
  2. Read `Saved this month` and `Savings rate`.
- **Expected:** `Savings rate` = **0%** (guard `latestReceived > 0` fails, so the ratio is not computed). `Saved this month` = **−€800.00** (0 − 800). No divide-by-zero / `NaN%`.
- **Automated:** No

---

## Trend chart (the Chart side of the Trend card)

### RPT-006 - Trend chart draws one bar per month against the income line, the month in progress hatched
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (May + June budgets).
- **Steps:**
  1. Load `/reports`.
  2. Inspect the `Trend` card on its `Chart` side (the default).
- **Expected:** A `role="img"` figure named `Spent each month against income received, 2026: May €2,700.00 spent, €2,900.00 income; Jun €2,400.00 spent, €2,950.00 income` (the month in progress says "spent so far" and "income so far"). One bar per month from the year's first month with anything recorded (`data-bar="5"`, `data-bar="6"`), x labels `May` and `Jun` (initials on a phone with more than seven months). Received income is one dashed line, a stretch per run of equal months (`data-income="5"`, `data-income="6"` here), joined where it steps, labelled `Income €2,950.00` at its right end (or above the chart when bars leave no room). The month in progress is hatched, labelled `so far` and its x label bold. No `title=` tooltips; the Table side has the exact figures.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-007/015, "hatches the month in progress", "draws the income line in runs")

### RPT-007 - Income bars plot actually-received income, but scaling includes budgeted income
- **Priority:** P1
- **Type:** Regression
- **Origin:** reports-landing map §6/§7 — bars plot `incomeReceived`/`spent`; budgeted `income` participates only in the height denominator `max(income, incomeReceived, spent)`.
- **Preconditions:** Owner with a latest month where budgeted income €3,000.00 exceeds received €2,950.00, spent €2,400.00.
- **Steps:**
  1. Load `/reports`.
  2. Compare the `Income` bar height/tooltip to the budgeted figure.
- **Expected:** The `Income` bar tooltip reads `Income €2,950.00` (the received figure, not the €3,000.00 budgeted), even though the legend just says `Income`. Bar heights scale to the window max, which includes the **undrawn** budgeted €3,000.00, so the received/spent bars look slightly shorter than if scaled to their own max. No column exceeds 100% height; the largest drawn value maps below full height when budgeted > received.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs) — server split of received vs budgeted income; the client bar source is not unit-asserted.

### RPT-008 - Tiny non-zero bar gets a 2% minimum sliver
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner with a month whose spent is a tiny fraction of the window max (e.g. received €4,000.00 in one month, spent €5.00 in the current month).
- **Steps:**
  1. Load `/reports`.
  2. Inspect the current month's `Spent` bar height.
- **Expected:** The `Spent` bar renders at `max(2, round(value/max×100))` = **2%** height (a visible sliver) rather than a near-invisible hairline. A truly zero value renders 0% (no bar). Same rule applies to every `pct()`-driven bar on the page.
- **Automated:** No

### RPT-009 - Trends window is the last N calendar months up to the latest budget
- **Priority:** P1
- **Type:** Regression
- **Origin:** reports-landing map gotcha #7; changed by D12 (1 Oct 2026, review RP-P3-2) — window = the last N calendar months up to the latest budget, none before the first month with a budget or a recorded row; a month with no budget is a point of its own, as in the annual table.
- **Preconditions:** Owner whose ONLY budgets are **Jan 2026** and **Jun 2026** (five calendar months apart), with spending in March.
- **Steps:**
  1. Load `/reports`.
  2. Inspect the trend columns and the breakdown `<select>` options.
- **Expected:** The window has six points, `Jan` to `Jun`, in chronological order; Feb–May carry no budgeted figures (`hasBudget: false`) and March shows its spending (the window feeds the KPI row and the Spending card's `Breakdown month` select). The select offers `Jun 2026` back to `Jan 2026` (newest first). Default breakdown = `2026-06`; the Trend and Jar spending cards open on 2026, the year of the latest point up to this month (in December with next January budgeted ahead, still this year).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/RReportsCoverageTests.cs `Trends_Window_IsCalendarMonths_SoAMonthWithNoBudgetIsAPointOfItsOwn`).

### RPT-010 - Trends window caps at the client-requested 6 (and the server clamps 1..24)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner with 9 consecutive monthly budgets (Nov 2025 → Jul 2026).
- **Steps:**
  1. Load `/reports` (the client always calls `/reports/trends?months=6`).
  2. Count trend columns / breakdown options.
  3. Separately call the API with `?months=0`, `?months=-3`, `?months=99`, and `?months=abc`.
- **Expected:** Page shows the **6** most recent budgets (Feb→Jul 2026), oldest windowed-out. API-level: `months` is silently `Math.Clamp`ed to 1..24, so `0`/`-3` return 1 point, `99` returns up to 24 — never a 400. Non-numeric `months=abc` fails MVC model binding → **400 ProblemDetails**.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs) — window cap only; the clamp/400 paths are not unit-covered.

---

## Trend table (the Table side) & year navigation

### RPT-011 - Trend table renders with headers, month rows and totals footer
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (May + June budgets in 2026).
- **Steps:**
  1. Load `/reports`.
  2. Press `Table` in the `Trend` card (the year defaults to that of the latest month up to this one, 2026).
- **Expected:** Year switcher in the card header shows `2026` between `Previous year`/`Next year` (a polite live region). Table `Income and spending in 2026`, headers `Month | Received | Spent | Net | Budgeted | Variance` (the month column stays pinned while the figures scroll on a phone). May row: Received `€2,900.00`, Spent `€2,700.00`, Net `€200.00`, Budgeted `€3,000.00`, Variance `-€100.00`. Footer `Total`: Received `€5,850.00`, Spent `€5,100.00`, Net `€750.00`, Budgeted `€6,000.00`, Variance `-€150.00`.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-011)

### RPT-012 - Months with nothing recorded show em dashes; Net is green/red by sign; the month in progress is muted
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (only May/June budgeted in 2026); add a July budget where spent (€3,200.00) exceeds budgeted income (€3,000.00) so July Net is negative.
- **Steps:**
  1. Load `/reports`, press `Table` in the `Trend` card (2026).
  2. Inspect Jan–Apr / Aug–Dec rows, and the sign colors of Net cells.
- **Expected:** The table starts at the year's first month with a budget or a figure and runs to the last budgeted month. A month with nothing recorded renders `—` in every figure cell, muted (`text-slate-500`), no colour. May/June Net are green (`text-ok`, positive). July Net = **-€200.00** in red (`text-bad`); a zero Variance is plain. The month in progress reads `Oct so far` and its whole row is muted, Net and Variance included (not final yet).
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-012, "mutes the month in progress throughout the table")

### RPT-013 - Previous/Next year navigation loads a new year and fires the analytics event
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with budgets in both 2025 and 2026 (analytics consent granted so events flush).
- **Steps:**
  1. Load `/reports` (defaults to 2026).
  2. Click `Previous year`.
  3. Click `Next year` twice.
- **Expected:** Clicking `Previous year` issues `GET /reports/annual/2025`, the navigator shows `2025`, and the table repopulates with 2025 data. Each click fires `track('report_viewed', { report_type: 'annual' })`. `Next year` returns to 2026 then advances to 2027. No `report_viewed` event fired for the initial default render.
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx) — year nav + refetch; the analytics event is not asserted.

### RPT-014 - Navigating to a year with no budgets shows all-dash rows and drops the average card
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner with budgets only in 2026.
- **Steps:**
  1. Load `/reports`.
  2. Click `Next year` to reach 2027 (no budgets), then keep clicking to 2030.
- **Expected:** The `Trend` card stays: its Chart side says `Nothing recorded in 2027.` and its Table side shows only the `Total` row at `€0.00` throughout (no month rows). The `Average month by category` table under it **disappears** (empty `categories`), and the Spending card's ticks go (they show only while the year shown is the breakdown month's). The KPI row and the Spending card are otherwise unaffected (they follow the window, not the year). The Jar spending card follows the year. Navigation is unbounded (no disabled state).
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-014)

### RPT-015 - Annual table shows budgeted and received income with a signed Variance; Net is received − spent
- **Priority:** P1
- **Type:** Happy
- **Origin:** rule 41 / W12 P22 — REVIEW concern 5 closed: the table no longer mixes budgeted income against actual spend.
- **Preconditions:** Owner whose June budgeted income is €3,000.00 but received only €2,950.00; June spent €2,400.00.
- **Steps:**
  1. Load `/reports`, read the June row and the footer.
- **Expected:** Columns read `Month | Budgeted | Received | Variance | Spent | Net`. June: Budgeted `€3,000.00`, Received `€2,950.00`, Variance **`-€50.00`** (rose; `received − budgeted`, signed — `+€…` in emerald when more came in than planned, plain `€0.00` at zero, never worded as a shortfall), Spent `€2,400.00`, Net **`€550.00`** = `received 2,950 − spent 2,400` (emerald). The footer carries `totalIncome`, `totalIncomeReceived`, the signed `totalVariance` and `totalIncomeReceived − totalSpent`. The trend's income bar for June is the same €2,950.00 — the two reports agree on every figure.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-015/RPT-040; backend `RReportsCoverageTests.Annual_AndTrends_ReportTheSameBudgetedAndReceivedIncome_ForTheSameMonth`, `ReportFiguresTests.Income_ReceivedVsBudgeted_IsASignedVariance`)

### RPT-016 - Annual endpoint is int-constrained but otherwise unvalidated
- **Priority:** P2
- **Type:** Boundary
- **Origin:** reports-landing map gotcha #14 — `{year:int}` route constraint only; no range check.
- **Preconditions:** Authenticated owner, `Reports` flag on.
- **Steps:**
  1. Call `GET /api/reports/annual/9999`, `/annual/0`, `/annual/-5`.
  2. Call `GET /api/reports/annual/abc` and `/annual/2026.5`.
- **Expected:** `9999`, `0`, `-5` all return **200** with 12 `hasBudget:false` months and zero totals (no 400). Non-integer `abc` / `2026.5` fail the `:int` route constraint → **404** (route not matched). In the UI this only matters via the navigator, which never emits a non-int year.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AnnualSummaryTests.cs) — empty-year handling.

---

## Average month by category (the Trend card's Table side)

### RPT-017 - Averages table lists categories by descending average with totals and the jars mark
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2; 2026 counts 2 calendar months (D12: `countedMonths`, from the first month with a budget or a figure to the current UTC month).
- **Steps:**
  1. Load `/reports`, press `Table` in the `Trend` card and read `Average month by category` under the months (year 2026).
- **Expected:** Its (i) (`About the averages`) says `Each category’s spend averaged over 2 months of 2026, counting a month with no budget as a month too.` (plural). Headers `Category | Average | Year`; rows ordered by average desc, each named by its cells: `Housing` `€1,400.00` `€2,800.00`; `Food` `€850.00` `€1,700.00`; `Emergency Fund · jars` (a Savings group) `€300.00` `€600.00`. In the Spending card, the same averages show as a tick on each category's bar (named `An average month: €X`), none on Uncategorised.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-017, the averages tick tests)

### RPT-018 - Subtitle uses the singular "month" for a single-month year
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner whose only 2026 budget is June.
- **Steps:**
  1. Load `/reports`, read the average-card subtitle.
- **Expected:** `Each category's spend averaged over 1 month of 2026, counting a month with no budget as a month too.` (singular `month`, switched on `countedMonths === 1`, read in June). Averages equal that single month's actuals.
- **Automated:** Yes (client/src/pages/ReportsPage.catalog.test.tsx)

### RPT-019 - Categories are keyed by (Name, Kind): renames split history and same-name kinds separate
- **Priority:** P1
- **Type:** Regression
- **Origin:** reports-landing map gotcha #8 — annual categories grouped by `(Name, Kind)` string across per-month entities (no id-stable category concept).
- **Preconditions:** Owner where (a) an Expense group is named `Groceries` in Jan–Mar then renamed `Food` from Apr, and (b) a Savings group also named `Food` exists with contributions.
- **Steps:**
  1. Load `/reports`, view the average card for that year.
- **Expected:** `Groceries` and `Food` appear as **separate** rows (rename splits the year's spend across two names — Jan–Mar under `Groceries`, Apr+ under `Food`), each averaged over the SAME `budgetedMonths` denominator. The Expense `Food` and the Savings `Food` are **two distinct rows** (different `Kind`), and only the Savings one is marked `jars`. Deleting a category mid-year stops further accumulation but its past actuals still count.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AnnualSummaryTests.cs) — per-category averages by name; the rename-split path is not explicitly asserted.

---

## Spending (the month's breakdown)

### RPT-020 - Breakdown defaults to the latest month, biggest category first, with share % and bars
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2; default breakdown = June 2026.
- **Steps:**
  1. Load `/reports`, read the `Spending` card (its `Breakdown month` select defaults to `Jun 2026`).
- **Expected:** Non-income categories only, sorted by spend desc, each row `role="group"` named `Spending for {name}`: `Housing` `€1,400.00 · 58%`; `Food` `€700.00 · 29%`; `Emergency Fund · jars` (a Savings group) `€300.00 · 13%`. The share is muted after the amount, of the month's summed positive spend (€2,400.00). One bar under each row across its width, on one scale: the largest of the spends and the average-month ticks takes 96% of the track (Housing 96%, Food 48%); any figure above zero gets at least a 2% sliver. Income group is excluded.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-020, "gives a small group a visible sliver")

### RPT-021 - Changing the breakdown month reloads that month and fires the breakdown event
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (May + June). Analytics consent granted.
- **Steps:**
  1. Load `/reports` (breakdown = June → Housing/Food/Emergency Fund).
  2. Open the `Breakdown month` select (options newest-first: `Jun 2026`, `May 2026`; values `2026-06`, `2026-05`).
  3. Choose `May 2026`.
- **Expected:** `GET /reports/month/2026/5` fires; the card repopulates with May's categories (`Housing €1,400.00`, `Food €1,000.00`, `Emergency Fund €300.00`), and June-only rows disappear. Each change fires `track('report_viewed', { report_type: 'breakdown' })`; no event fired for the initial default view. The hero/annual cards do NOT change (they follow trends/annual, not the breakdown select).
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

### RPT-022 - Breakdown month with no spending shows the empty line
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner whose selected month has a budget but zero non-income actuals (planned lines, nothing spent yet — e.g. a freshly created current month).
- **Steps:**
  1. Load `/reports`, select that month in `Breakdown month`.
- **Expected:** The card body reads exactly `No spending recorded for this month yet.` (no rows, no bars). The select still shows the chosen month. Hero/trend/annual cards remain populated from the window.
- **Automated:** No

### RPT-023 - Category with a negative net actual stays on the breakdown, labelled, without a share
- **Priority:** P2
- **Type:** Edge
- **Origin:** rule 39 / W12 P23 — replaces the earlier behaviour of dropping the row through a `spentMinor > 0` filter.
- **Preconditions:** Owner whose selected month has `Utilities` with €70.00 spent and €120.00 refunded (net −€50.00), plus other positive-spend categories.
- **Steps:**
  1. Select that month in `Breakdown month`.
- **Expected:** `Utilities` is rendered **last**, reading `-€50.00 · after €120.00 refunded` with **no** `%` share and a zero-width bar. The share denominator is the sum of the **positive** nets only, so the other rows' percentages are unchanged by the negative row. A group with nothing at all in the month (net 0 and no refunds) is left out. If no group has spending or refunds, `No spending recorded for this month yet.` shows instead.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-023)

---

## Sum correctness vs budget data (money integrity)

### RPT-024 - A split transaction is counted once across its lines (parent never double-counts)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; June has one €120.00 expense split €80.00 → `Food`, €40.00 → `Housing`; no other actuals in those lines.
- **Steps:**
  1. Load `/reports`, select `Jun 2026` in the breakdown.
  2. Compare `Food`/`Housing` rows and the trend `Spent` for June.
- **Expected:** `Food` shows €80.00 and `Housing` shows €40.00 — the €120.00 parent (which has `BudgetItemId == null`) is NOT added on top, so the month's category total gains exactly €120.00, not €240.00. June trend `Spent` and the annual June `Spent` both include exactly €120.00 from this transaction.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/SplitTransactionTests.cs) — slices roll into each line's actual; the report read reuses `BudgetActuals`.

### RPT-025 - Transfers between accounts are excluded from spend and income
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner with two accounts and a €500.00 transfer between them in June, plus normal spend.
- **Steps:**
  1. Load `/reports`; inspect the June trend `Spent`, the annual June `Spent`, and the June breakdown.
- **Expected:** The €500.00 transfer appears in NO report figure — it is neither an Income nor an Expense transaction assigned to a budget line, so it rolls up into neither `Spent` nor `IncomeReceived`. The breakdown has no "Transfer" row. Deleting or re-typing the transfer changes no report number.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs) — "transfer never counts as income in the budget".

### RPT-026 - Reports are tx-derived: deleting a historical transaction retroactively lowers the report
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner with H2; note June `Food` breakdown = €700.00 and the June trend `Spent` = €2,400.00.
- **Steps:**
  1. On `/transactions`, delete a €100.00 `Food` expense dated in June.
  2. Return to `/reports` (reload so trends refetch).
- **Expected:** June `Food` breakdown now €600.00, June trend `Spent` €2,300.00, the annual June `Spent` and `Total` drop by €100.00, and the `Food` yearly average recomputes — because actuals are recomputed at read time, not stored. No historical snapshot preserves the old value.
- **Automated:** No

---

## Empty, partial & error states

### RPT-027 - Brand-new opt-out account shows the empty state, not sample figures
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #170 — sample budget is opt-in; default new accounts are completely empty.
- **Preconditions:** Freshly registered login that did NOT tick `Start with sample figures`; no budgets created yet.
- **Steps:**
  1. Sign in and open `/reports`.
- **Expected:** After loading, the page shows the `No budget data yet` EmptyState with description `Once you've built a budget or two, your trends will appear here.` and the reports icon medallion. No hero, no cards, no sample numbers (`hasData` needs ≥1 trend point). No error banner.
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx) — empty state on `points: []`.

### RPT-028 - Trends fetch failure shows the error banner in place of all content
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner with H2; force `GET /reports/trends?months=6` to fail (e.g. 500, or a persistent network error after refresh is exhausted).
- **Steps:**
  1. Load `/reports`.
- **Expected:** A `role="alert"` banner reads exactly `Could not load your reports.` and replaces the hero/cards (this is the only client-side error surface on the page). The empty state does NOT also show. (A genuine dead session instead redirects to `/login?...reason=expired` via the axios interceptor — see 03-session-auth-lifecycle.md — rather than showing this banner.)
- **Automated:** No

### RPT-029 - Breakdown fetch failure is swallowed and leaves the previous month on screen
- **Priority:** P2
- **Type:** Regression
- **Origin:** reports-landing map §4/gotcha #9 — the `/reports/month/{y}/{m}` fetch has `.catch(() => {})`.
- **Preconditions:** Owner with H2 (breakdown defaults to June, loaded OK); make `GET /reports/month/2026/5` fail.
- **Steps:**
  1. Load `/reports` (June breakdown renders).
  2. Select `May 2026` in `Breakdown month`.
- **Expected:** No error banner appears. The select shows `May 2026`, but the category rows still show **June's** breakdown (stale) because `setBreakdownMonth` only runs on success. Re-selecting a month that loads OK replaces it. The rest of the page is unaffected.
- **Automated:** No

### RPT-030 - Annual fetch failure is swallowed; the navigator shows the new year while the table stays on the old one
- **Priority:** P2
- **Type:** Regression
- **Origin:** reports-landing map §4/gotcha #9 — the `/reports/annual/{year}` fetch has `.catch(() => {})`; `setAnnual` fires only on success.
- **Preconditions:** Owner with 2026 data; make `GET /reports/annual/2025` fail.
- **Steps:**
  1. Load `/reports` (annual = 2026).
  2. Click `Previous year`.
- **Expected:** No error banner. The year navigator label reads `2025`, but the annual table + average card still show **2026's** data (the last successful load). Clicking `Next year` back to 2026 leaves 2026 shown (already current). The trend/breakdown/hero are unaffected.
- **Automated:** No

---

## Feature flag, routing & access

### RPT-031 - Reports flag off hides the nav item and redirects the deep link
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Server `Features:Reports=false`; authenticated owner; `/features` returns `reports:false`.
- **Steps:**
  1. Sign in; inspect the nav.
  2. Manually navigate to `/reports`.
- **Expected:** No `Reports` nav item (AppNav gates on the flag). The `/reports` route is not registered, so it falls through to `*` and `Navigate to "/"` — the user lands on the dashboard, never a blank/404 page. (`RequireAuth` still applies: an anonymous deep link to `/reports` first bounces to `/login?returnUrl=...`.)
- **Automated:** Partial (client/src/components/AppNav.test.tsx) — Reports hidden when flag off; the route redirect is not unit-covered.

### RPT-032 - Reports flag off makes the API 404 (not 403), but auth still wins first
- **Priority:** P1
- **Type:** Regression
- **Origin:** reports-landing map gotcha #1 — `FeatureGate` short-circuits with 404; action filters run after authz so unauthenticated → 401 first.
- **Preconditions:** Server `Features:Reports=false`.
- **Steps:**
  1. Authenticated: call `GET /api/reports/trends?months=6` and `GET /api/reports/annual/2026`.
  2. Unauthenticated (no/invalid token): call `GET /api/reports/trends?months=6`.
- **Expected:** Authenticated-with-flag-off → **404 NotFound**, empty body (defence-in-depth even though the UI already hides it). Unauthenticated → **401** (auth runs before the feature gate), regardless of the flag. Never a 403.
- **Automated:** No

### RPT-033 - Features fetch failure falls back to all-on, so the nav shows but every reports call 404s
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Server `Features:Reports=false` but `GET /api/features` itself fails/times out; authenticated owner.
- **Steps:**
  1. Load the app; `FeatureContext` fails its fetch and falls back to `ALL_ON`.
  2. Click the (now-visible) `Reports` nav item.
- **Expected:** The `Reports` nav item is shown (all-on fallback), the `/reports` route exists, but `GET /reports/trends` returns 404 (server flag still off) → the page shows the `Could not load your reports.` error banner. A benign mismatch between the client's optimistic all-on flags and the real server flag.
- **Automated:** No

### RPT-034 - A Read-only household member sees the full Reports page
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared household "Report House" with 2 members; sign in as a Read-only member.
- **Steps:**
  1. Sign in as the Read-only member; open `/reports`.
- **Expected:** The page is fully functional and identical to what the owner sees — every household member (any role incl. Read-only) reads the same OwnerId-scoped figures (no role gate on the reports controller; it is GET-only). Solo vs shared makes no difference to the numbers.
- **Automated:** No

---

## Currency & single-month households

### RPT-035 - The whole page formats in the breakdown month's currency
- **Priority:** P1
- **Type:** Regression
- **Origin:** reports-landing map gotcha #10 — `currency = breakdown?.baseCurrency ?? 'EUR'` (the month report's currency) drives every card.
- **Preconditions:** Legacy data only: June budget `baseCurrency = EUR`, an older budget created before W08 with `baseCurrency = GBP`; both appear in the trend window. (Since W08 every new month takes the household's one budget currency — BUDG-011 — and the ForeignAmounts migration never restamps a month but refuses to run while a household's months are in more than one currency — CURR-056 — so on a migrated database this history has to be seeded directly.)
- **Steps:**
  1. Load `/reports`; note hero/annual/trend all render in EUR (June breakdown).
  2. Change `Breakdown month` to the GBP month.
- **Expected:** On first paint (before the breakdown fetch resolves) all figures render in **EUR** (the `?? 'EUR'` fallback). After the EUR June breakdown loads they stay EUR. Selecting the GBP month re-labels **every** card — hero, trend tooltips, annual table AND totals — into `£` formatting, even though those other cards' data did not change. This is expected (single page currency follows the selected month).
- **Automated:** No

### RPT-036 - Single-month household renders one trend point, one breakdown option and a singular subtitle
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner whose ONLY budget ever is June 2026 (received €2,950.00, spent €2,400.00).
- **Steps:**
  1. Load `/reports`.
- **Expected:** The `Trend` chart has a single bar (`Jun`). `Avg monthly spend` = the single month's spend `€2,400.00` (`round(spent/1)`). `Breakdown month` select has exactly one option `Jun 2026`. The averages (i) is singular (`1 month`). The Trend table and the year switcher still work (a June row, no other months). No empty state (there IS one point).
- **Automated:** No

### RPT-037 - Blank current month for a jar-owning household reports over-budgeted, not empty
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #172 — accrual-planned savings lines give a fresh month non-zero `TotalPlanned` with zero income; empty ≠ balanced.
- **Preconditions:** Jar-owning household; create a **blank** July 2026 budget (no income entered) so the auto-appended Savings lines that back the jars carry accrual-planned amounts (e.g. €300.00 planned), nothing received/spent.
- **Steps:**
  1. Load `/reports`; July is now the most recent budget.
  2. Inspect July's trend column and the July row in the annual table.
- **Expected:** July's trend point has `Planned > 0` (the accrual savings lines) while `Income = 0` and `IncomeReceived = 0` — it is NOT treated as balanced/empty. July `Spent` = €0.00 (nothing tracked), so the hero `Saved this month` = €0.00 and `Savings rate` = 0%. Annual July `Net` = `0 − spent` = €0.00, shown emerald (net ≥ 0) not dashed (the month HAS a budget). The Reports empty state does not appear (there is data).
- **Automated:** No

---

## Uncategorised, refunds and variance (rules 37–39, 41; W12)

### RPT-038 - Uncategorised spending is its own breakdown row and the total does not move when it is categorised
- **Priority:** P0
- **Type:** Happy
- **Origin:** rule 37 / W12 P21.
- **Preconditions:** June has `Housing` €1,400.00 on its line and two June expense transactions on **no** line (€60.00 and €40.00; one may be a split slice whose line was removed).
- **Steps:**
  1. Load `/reports` (breakdown defaults to June).
  2. On `/transactions`, assign the €60.00 row to Housing; return to `/reports`.
- **Expected:** Step 1: `Spending` lists **`Uncategorised`** as its own last row (a hatched bar, no average tick) reading `€100.00 · 7%` with the dashed chip **`Assign 2`** (a link named `Assign 2, review uncategorised transactions`, `href="/transactions"`); `Housing` reads `€1,400.00 · 93%`; the card's total is €1,500.00. Step 2: Housing €1,460.00, Uncategorised `€40.00` with `Assign 1`; the total is still €1,500.00 — categorising moves money between rows, never changes the month. Uncategorised **income** counts in `Received` (rule 41), never in this card. Server: `GET /reports/month/2026/6` → `spentUncategorised: 100`, `uncategorisedCount: 2`, `spent` = categorised + uncategorised, and `categories` ending with `{ name: 'Uncategorised', kind: 'Uncategorised', index: -1, isUncategorised: true, count: 2 }`; the trend point's and the annual month's `spent` include the same €100.00 (`spentUncategorised`), and a month with **no budget** still reports its loose transactions (dashed Budgeted/Variance in the annual table).
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-038; backend `ReportFiguresTests.Uncategorised_IsIncludedAsItsOwnRow_AndTheTotalDoesNotMoveWhenCategorised`, `Uncategorised_CountsAMonthWithNoBudget_AndSlicesWhoseLineIsGone`)

### RPT-039 - A refund reduces its category in the month it was received, and the row says so
- **Priority:** P0
- **Type:** Happy
- **Origin:** rules 38/39 / W12 P18, P21.
- **Preconditions:** June `Food` line: €700.00 spent and a €20.00 **refund** (an Income row linked to a Food purchase, see TX-099) received in June; `Housing` €1,400.00.
- **Steps:**
  1. Load `/reports`; read the June breakdown.
- **Expected:** `Food` reads `€680.00 · 33% · after €20.00 refunded` — the group is shown **net** of the refund, the share is of the net positive spending (680 / 2,080) and the refund is labelled, never hidden. The refund appears in no income figure (June `Received` unchanged). Server: the month report's `refunds: 20`, `Food.spent: 700`, `Food.refunds: 20`, `Food.net: 680`; the trend point and the annual month carry `refunds: 20`. A refund received in a **later** month than its purchase reduces that later month: a €100.00 September purchase refunded €20.00 in October reports September €100.00 / October −€20.00 and the year's `Household` total €80.00 (`refunds: 20`), never a September of €80.00. A refund on **no** line reduces the `Uncategorised` row and the total.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-039; backend `ReportFiguresTests.Refund_ReducesTheMonthItWasReceived_AndTheYearNets`, `Refund_WithoutALine_ReducesTheUncategorisedRow_AndTheTotal`; `RefundTests.Refund_LandsOnThePurchasesLine_AndNetsItsSpending`, `Refund_InALaterMonth_ReducesThatMonth_NotThePurchaseMonth`)

### RPT-040 - Annual Variance is signed and coloured; a month with no budget still shows what was received and spent
- **Priority:** P1
- **Type:** Happy
- **Origin:** rule 41 / W12 P21, P22.
- **Preconditions:** 2026 with July budgeted €3,000.00 / received €3,200.00, June budgeted €3,000.00 / received €2,950.00, and August with **no budget** but €80.00 received and €120.00 spent (loose transactions).
- **Steps:**
  1. Load `/reports`; press `Table` in the `Trend` card and read the Jul, Jun and Aug rows.
- **Expected:** Jul `Variance` **`+€200.00`** (emerald); Jun **`-€50.00`** (rose); a zero variance reads `€0.00` unsigned and uncoloured. Aug (muted row): Budgeted `—`, Received `€80.00`, Variance `—`, Spent `€120.00`, Net `-€40.00` (rose). A month with no budget **and** nothing recorded is `—` across the row. The footer's `Variance` is the signed `totalVariance`. Server: `variance = incomeReceived − income`, where `incomeReceived` counts income-line actuals plus uncategorised income and excludes transfers and refunds (3,200 received → +200; 2,800 → −200).
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-040; backend `ReportFiguresTests.Income_ReceivedVsBudgeted_IsASignedVariance`, `Uncategorised_CountsAMonthWithNoBudget_AndSlicesWhoseLineIsGone`)

### RPT-041 - The yearly averages card lists Uncategorised and shows refunded amounts
- **Priority:** P2
- **Type:** Happy
- **Origin:** rules 37–39 / W12 P21.
- **Preconditions:** 2026 with `Food` €800.00 (Jun) and €900.00 (Jul) spent, €40.00 refunded in total; uncategorised spending in the year.
- **Steps:**
  1. Load `/reports`; press `Table` in the `Trend` card and read `Average month by category`.
- **Expected:** The `Food` row reads Average `€830.00`, Year `€1,660.00` with `after €40.00 refunded` under it (the average and total are **net** of refunds: 1,700 − 40 over 2 budgeted months). An `Uncategorised` row appears among them marked `· Review` (and gets no tick in the Spending card). Server: `AnnualSummaryDto.categories` accumulates by `(Name, Kind)` including `{ kind: 'Uncategorised' }`, each with `refunds`; `totalRefunds` is the year's sum.
- **Automated:** Full (client `ReportsPage.catalog.test.tsx` RPT-041; backend `ReportFiguresTests.Uncategorised_CountsAMonthWithNoBudget_AndSlicesWhoseLineIsGone` (annual `Uncategorised` category), `Refund_ReducesTheMonthItWasReceived_AndTheYearNets` (annual category total and refunds))

### RPT-042 - A row waiting for its budget-currency amount is left out of every report figure until it is entered
- **Priority:** P1
- **Type:** Regression
- **Origin:** W08 (rules 42–44). Before W08 an imported row in another currency counted at the ECB rate, or at face value when no rate was found.
- **Preconditions:** Report household; June 2026 has Food spending €700.00 on its line; add an imported row "London Cab" GBP 45.50 dated 2026-06-12, waiting (`fxPending`), assigned to Food; a second waiting row with no line.
- **Steps:**
  1. Load `/reports` with the breakdown on Jun 2026; read the hero, the June trend column, the Food breakdown row, the Uncategorised row and the annual June row.
  2. On `/transactions` click **Enter amount** on London Cab and confirm **53.26**; reload `/reports`.
- **Expected:** Step 1: every figure is as if the two rows did not exist — Food €700.00, no Uncategorised spending from them, June Spent unchanged in the trend, annual and hero (the trends, annual overview and breakdown all derive from `ReportFigures.ForMonthAsync`). `GET /reports/month/2026/6` returns `fxPendingCount: 2`; the Spending card's foot says `Not counted yet · 2 payments` with an `€ amounts` chip to Transactions, its (i) says why, and the `Avg monthly spend` (i) gives the window's count (said once on the screen, no strip). Step 2: Food reads **€753.26**, June Spent rises by 53.26 everywhere, and `fxPendingCount` drops to 1; the other row still counts nowhere.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/ReportFiguresTests.cs — `MonthReport_LeavesPendingFxRowsOut_AndCountsThem`; FxPendingAggregatesTests — `A_confirmed_amount_counts_on_its_line_and_leaves_the_waiting_count`; the page itself unasserted)

## Spending from jars (5 October 2026, the jar notes)

### RPT-043 - A jar's spending counts wholly against the jar that paid, month by month; a move between jars is not spending
- **Priority:** P1
- **Type:** Happy
- **Origin:** Christopher's note of 5 October 2026: "I spent 50 for pets and not a 20/30 split"; "how much I am actually spending from each jar monthly/yearly".
- **Preconditions:** Report household with a Savings account holding jars **Pets** (€20.00) and **Food** (€300.00). On 9 March 2026 move €30.00 from Food to Pets (Move money); on 10 March record a €50.00 expense "Vet" on the Pets Savings line.
- **Steps:**
  1. Load `/reports`; with the annual overview on 2026 read the `Spending from jars` card.
- **Expected:** A table labelled `Spending from jars in 2026` with a `Jar` column, `Jan` … `Dec` and `Total`. Row `Pets`: `€50.00` under Mar and in Total, dashes elsewhere. Row `Food`: dashes throughout (the move is not spending). An `All jars` footer row sums the jars when they share one currency (`€50.00` under Mar and Total). The card's note reads "Money moved between jars is not spending." Server: `GET /api/reports/jars/2026` returns `JarSpendingReportDto` (`jars[]` with `months[12]`, `refunds[12]`, `total`, `totalRefunds`, `currency`, `isArchived`; live jars first, then archived, each in name order; `waitingCount`), read through `JarLedgerSource.SpendingBetween`, the same ledger operations the jar's balance is read from (rule 79: the jar's line, a slice on it, or a payment answered "from this jar", in whichever account paid). It is wider than the Jars page's **Mark paid** list, which leaves out the payment that closed a cycle and transfer fees: both are the jar's spending here.
- **Automated:** Full (client `ReportsPage.jars.test.tsx`; backend `JarSpendingReportTests.TheVetBill_CountsWhollyAgainstThePetsJar_AndTheMoveFromFoodIsNotSpending`, `Draws_CountByTheirOwnDate_FromAnyLine_NetOfRefunds_AndOnlyInTheYear`)

### RPT-044 - Refunds, archived jars, waiting rows and the year navigator on the jars card
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** As RPT-043, plus an archived jar **Old sofa** that paid €400.00 in January and had €20.00 refunded back in February; a live jar **Car** that paid nothing; a jar **Trip** in a GBP account with one expense still waiting for its EUR amount.
- **Steps:**
  1. Read the card on 2026; then click `Previous year` twice.
- **Expected:** `Old sofa (archived)` is listed, muted, with `-€20.00` under Feb and a Total of `€380.00` whose Table side says `after €20.00 refunded` (visually hidden on the Chart side). `Car` is listed with dashes (a live jar always appears). The `All jars` footer is left out when the jars are in more than one currency. The card's foot says `Not counted yet · 1 payment` with an `€ amount` chip to Transactions, and its (i) says payments in another currency aren't counted until they have their amount in EUR. The card follows the Trend card's year: on 2025 it shows that year's figures, and on a year with no figure and no live jar (or when the request fails, or on an older server without the endpoint) the card is left out rather than shown empty.
- **Automated:** Full (client `ReportsPage.jars.test.tsx`; backend `JarSpendingReportTests.ListsEveryLiveJarAtZero_AnArchivedJarOnlyWithAFigure_AndLeavesWaitingRowsOut`)
