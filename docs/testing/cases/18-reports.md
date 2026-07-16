# Reports

**ID prefix:** RPT | **Scope:** Everything on `/reports` (`client/src/pages/ReportsPage.tsx` + its three server queries). The page is a single scroll of a gold **Hero** (`Saved this month` + `Avg monthly spend` / `Savings rate` tiles) and four cards: **Income vs spending** (per-budget bars of received income vs actual spend), **Annual overview** (12-row Income/Spent/Net table with a year navigator), **Average monthly spending by category** (per-`(Name,Kind)` yearly average), and **Spending by category** (a month-selectable breakdown). Covers the exact labels/aria, the loading/error/empty states, the computed money (saved-this-month, avg spend, savings rate, per-category %, annual net, bar scaling, the 2% sliver), sum correctness against budget data (splits counted once, transfers excluded, tx-derived actuals), the "most recent N **budgets** not last N months" window, `(Name,Kind)` category keying, silent partial-failure of the annual/breakdown fetches, the breakdown-currency follow behavior, the `Reports` feature-flag 404/redirect defence-in-depth, and single-month/read-only households. Endpoints: `GET /api/reports/trends?months={n}`, `GET /api/reports/annual/{year}`, and `GET /api/budget/{y}/{m}` (breakdown source). | **Out of scope:** the LandingPage / legal pages / beta banner / SEO / prerender that share the reports-landing subsystem map → **01-landing-public.md**; the dashboard budget view, `IsBalanced` empty-month hero, and month create/copy → **06-dashboard-budget-view.md** + **07-month-lifecycle.md**; transaction/split CRUD and transfer mechanics themselves → **10-transactions.md** + **11-transfers.md** (this file only asserts how they roll up into report sums); the full Owner/Admin/Limited/Read-only matrix and general nav gating → **25-roles-permissions.md** (only the area-specific "reports have no role gate" fact is here); session-expiry interceptor behavior mid-view → **03-session-auth-lifecycle.md**; dark-mode / responsive / axe sweeps → **26-ux-states.md**. **Do not test for:** a CSV/PDF export control (none exists); a date-range picker (only a year navigator + a month `<select>`); any write action on this page (it is read-only GET-only).

**Test data setup:** Local stack (API `:5099`, `ASPNETCORE_ENVIRONMENT=Development`) or beta (app.allotjar.com). Assume **today = 2026-07-16**. Locale **en-GB** so money renders `€1,234.56`; user `preferredCurrency` **EUR**. Feature flag **`Reports` ON** (default). Money is `decimal(18,4)` server-side, integer minor units scale 4 client-side. Household **"Report House"** (owner **report-owner@example.test**, role Owner), solo (1 member) unless a case states shared.

**Baseline history "H2"** (two contiguous budgets — the household has NOT yet created July 2026, so the most-recent budget is June):
- **May 2026** — Income budgeted €3,000.00 / received €2,900.00; Housing (Expense) €1,400.00/€1,400.00; Food (Expense) €700.00/€1,000.00; Emergency Fund (Savings) €300.00/€300.00. Derived: spent €2,700.00, planned (non-income) €2,400.00.
- **June 2026** — Income budgeted €3,000.00 / received €2,950.00; Housing (Expense) €1,500.00/€1,400.00; Food (Expense) €800.00/€700.00; Emergency Fund (Savings) €300.00/€300.00. Derived: spent €2,400.00, planned €2,600.00.
- Trends window totals: TotalIncome €6,000.00, TotalIncomeReceived €5,850.00, TotalSpent €5,100.00. Default annual year = **2026**, default breakdown month = **Jun 2026** (`2026-06`).

Actuals are ALWAYS transaction-derived at read time (`BudgetActuals.ApplyAsync`): income lines roll up **Income** transactions, every other line rolls up **Expense** transactions; whole transactions add `Amount × ExchangeRate`, split slices add `Split.Amount × parent.ExchangeRate`; a split parent has `BudgetItemId == null` (no double count); transfers roll up into neither.

---

## Page load, hero & summary

### RPT-001 - Reports page loads with hero and all four cards
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed-in owner of "Report House" with baseline history H2.
- **Steps:**
  1. Sign in and click the `Reports` nav item (or navigate to `/reports`).
  2. Wait for `Loading your reports…` to clear.
- **Expected:** AppShell title `Reports`. Gold Hero shows eyebrow `Saved this month` with a big amount and two tiles `Avg monthly spend` and `Savings rate`. Four cards render in order: `Income vs spending`, `Annual overview`, `Average monthly spending by category`, `Spending by category`. No error banner, no empty state.
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

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

## Income vs spending trend chart

### RPT-006 - Trend renders one column per budget with month ticks and the current month tinted
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (May + June budgets).
- **Steps:**
  1. Load `/reports`.
  2. Inspect the `Income vs spending` card: legend, columns, tick labels, bar tooltips.
- **Expected:** Legend swatches labelled `Income` (solid brand) and `Spent` (bordered/ghost). Two columns, each wrapper `aria-label="Trend for May 2026"` / `"Trend for Jun 2026"`. Tick labels `May` and `Jun`; the last (current) column's label is brand-tinted (`text-brand-700 dark:text-brand-200`). Each column has two bars with `title="Income {money}"` (= that month's **received** income) and `title="Spent {money}"`, e.g. June `title="Income €2,950.00"` / `title="Spent €2,400.00"`.
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

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

### RPT-009 - Trends window is the most recent N budgets, not the last N calendar months
- **Priority:** P1
- **Type:** Regression
- **Origin:** reports-landing map gotcha #7 — window = "most recent N budgets" (Year desc, Month desc, take N), output sorted chronologically; calendar gaps are skipped.
- **Preconditions:** Owner whose ONLY budgets are **Jan 2026** and **Jun 2026** (five calendar months apart).
- **Steps:**
  1. Load `/reports`.
  2. Inspect the trend columns and the breakdown `<select>` options.
- **Expected:** Exactly **two** columns, labelled `Jan` and `Jun`, sitting side-by-side (Feb–May are NOT rendered as empty gaps). Columns are in chronological order (Jan then Jun). The breakdown select offers only `Jun 2026` and `Jan 2026` (newest first). Default breakdown = `2026-06`, default annual year = 2026.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs) — chronological ordering + window cap.

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

## Annual overview & year navigation

### RPT-011 - Annual overview table renders with headers, month rows and totals footer
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (May + June budgets in 2026).
- **Steps:**
  1. Load `/reports`.
  2. Inspect the `Annual overview` card (defaults to the latest budget's year, 2026).
- **Expected:** Year navigator shows `2026` between `◀`/`▶` buttons (aria-labels `Previous year`/`Next year`). Table headers `Month | Income | Spent | Net`. May row: Income `€3,000.00`, Spent `€2,700.00`, Net `€300.00`. June row: Income `€3,000.00`, Spent `€2,400.00`, Net `€600.00`. Footer `Total`: Income `€6,000.00`, Spent `€5,100.00`, Net `€900.00`.
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

### RPT-012 - Non-budgeted months show em dashes; Net is emerald/rose by sign
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (only May/June budgeted in 2026); add a July budget where spent (€3,200.00) exceeds budgeted income (€3,000.00) so July Net is negative.
- **Steps:**
  1. Load `/reports`, view `Annual overview` for 2026.
  2. Inspect Jan–Apr / Aug–Dec rows, and the sign colors of Net cells.
- **Expected:** The 10 monthless rows render `—` (em dash) in all three money cells and use muted (`text-slate-500`) row text. May/June Net cells are emerald (`text-emerald-600 dark:text-emerald-400`, positive). July Net = **−€200.00** in rose (`text-rose-600 dark:text-rose-400`). A non-budgeted month's Net cell carries no color class (just the dash).
- **Automated:** No

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
- **Expected:** The `Annual overview` card still renders (server always returns 12 `hasBudget:false` months): all 12 rows show `—`, and Total row shows `€0.00 / €0.00 / €0.00`. The `Average monthly spending by category` card **disappears** (empty `categories`). The `Income vs spending` and `Spending by category` cards are unaffected (they follow trends, not the annual year). Navigation is unbounded (no disabled state).
- **Automated:** No

### RPT-015 - Annual Net deliberately mixes budgeted income against actual spend
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner whose June budgeted income is €3,000.00 but received only €2,950.00; June spent €2,400.00.
- **Steps:**
  1. Load `/reports`, read the June row Net and the footer Net.
- **Expected:** June `Net` = **€600.00** = `income(budgeted 3,000) − spent(actual 2,400)` — it uses **budgeted** income (not the €2,950.00 received the hero used), so the annual table's income column and the trend's income bar can differ for the same month. Footer `Net` = `totalIncome(budgeted) − totalSpent(actual)`.
- **Automated:** No

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

## Average monthly spending by category

### RPT-017 - Average card lists categories by descending average with totals and Fund badge
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2; 2026 has 2 budgeted months.
- **Steps:**
  1. Load `/reports`, view `Average monthly spending by category` (year 2026).
- **Expected:** Subtitle `Each category's spend averaged over the 2 budgeted months of 2026.` (plural). Rows ordered by average desc: `Housing` → `€1,400.00/mo · €2,800.00 total`; `Food` → `€850.00/mo · €1,700.00 total`; `Emergency Fund` with a violet `Fund` badge → `€300.00/mo · €600.00 total`. Each row wrapper `aria-label="Average spending for {name}"`, sky-blue bar `aria-label="Average for {name}"`; the largest average fills the bar to 100%.
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

### RPT-018 - Subtitle uses the singular "budgeted month" for a single-month year
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner whose only 2026 budget is June.
- **Steps:**
  1. Load `/reports`, read the average-card subtitle.
- **Expected:** `Each category's spend averaged over the 1 budgeted month of 2026.` (singular `budgeted month`, switched on `budgetedMonths === 1`). Averages equal that single month's actuals.
- **Automated:** No

### RPT-019 - Categories are keyed by (Name, Kind): renames split history and same-name kinds separate
- **Priority:** P1
- **Type:** Regression
- **Origin:** reports-landing map gotcha #8 — annual categories grouped by `(Name, Kind)` string across per-month entities (no id-stable category concept).
- **Preconditions:** Owner where (a) an Expense group is named `Groceries` in Jan–Mar then renamed `Food` from Apr, and (b) a Savings group also named `Food` exists with contributions.
- **Steps:**
  1. Load `/reports`, view the average card for that year.
- **Expected:** `Groceries` and `Food` appear as **separate** rows (rename splits the year's spend across two names — Jan–Mar under `Groceries`, Apr+ under `Food`), each averaged over the SAME `budgetedMonths` denominator. The Expense `Food` and the Savings `Food` are **two distinct rows** (different `Kind`), and only the Savings one shows the `Fund` badge. Deleting a category mid-year stops further accumulation but its past actuals still count.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AnnualSummaryTests.cs) — per-category averages by name; the rename-split path is not explicitly asserted.

---

## Spending by category (breakdown)

### RPT-020 - Breakdown defaults to the latest month, biggest category first, with share % and bars
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2; default breakdown = June 2026.
- **Steps:**
  1. Load `/reports`, view `Spending by category` (select defaults to `Jun 2026`).
- **Expected:** Non-income categories only, sorted by spend desc: `Housing` `€1,400.00 · 58%` (bar 100%); `Food` `€700.00 · 29%` (bar 50%); `Emergency Fund` with violet `Fund` badge `€300.00 · 13%` (bar ~21%). `%` is share of the month's summed category spend (€2,400.00); bar width is relative to the LARGEST category, not the total. Income group is excluded. Row wrapper `aria-label="Spending for {name}"`, bar `role="img" aria-label="{name}"`.
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

### RPT-021 - Changing the breakdown month reloads that month and fires the breakdown event
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner with H2 (May + June). Analytics consent granted.
- **Steps:**
  1. Load `/reports` (breakdown = June → Housing/Food/Emergency Fund).
  2. Open the `Breakdown month` select (options newest-first: `Jun 2026`, `May 2026`; values `2026-06`, `2026-05`).
  3. Choose `May 2026`.
- **Expected:** `GET /budget/2026/5` fires; the card repopulates with May's categories (`Housing €1,400.00`, `Food €1,000.00`, `Emergency Fund €300.00`), and June-only rows disappear. Each change fires `track('report_viewed', { report_type: 'breakdown' })`; no event fired for the initial default view. The hero/annual cards do NOT change (they follow trends/annual, not the breakdown select).
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx)

### RPT-022 - Breakdown month with no spending shows the empty line
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner whose selected month has a budget but zero non-income actuals (planned lines, nothing spent yet — e.g. a freshly created current month).
- **Steps:**
  1. Load `/reports`, select that month in `Breakdown month`.
- **Expected:** The card body reads exactly `No spending recorded for this month yet.` (no rows, no bars). The select still shows the chosen month. Hero/trend/annual cards remain populated from the window.
- **Automated:** No

### RPT-023 - Category with a negative net actual is excluded from the breakdown
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner whose selected month has a category whose net actual is negative (e.g. a refund/reversal exceeding spend on `Utilities`), plus other positive-spend categories.
- **Steps:**
  1. Select that month in `Breakdown month`.
- **Expected:** `Utilities` (net ≤ 0) is **not** rendered (the `spentMinor > 0` filter drops it); only positive-spend categories appear, and the share `%` denominator is the sum of the positive rows only. If every category nets ≤ 0, the `No spending recorded for this month yet.` line shows instead.
- **Automated:** No

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
- **Origin:** reports-landing map §4/gotcha #9 — the `/budget/{y}/{m}` fetch has `.catch(() => {})`.
- **Preconditions:** Owner with H2 (breakdown defaults to June, loaded OK); make `GET /budget/2026/5` fail.
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
- **Origin:** reports-landing map gotcha #10 — `currency = breakdownMonth?.baseCurrency ?? 'EUR'` drives every card.
- **Preconditions:** Cross-currency household: June budget `baseCurrency = EUR`, an older budget `baseCurrency = GBP`; both appear in the trend window.
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
- **Expected:** `Income vs spending` has a single column (`Jun`, current-tinted). `Avg monthly spend` = the single month's spend `€2,400.00` (`round(spent/1)`). `Breakdown month` select has exactly one option `Jun 2026`. Average-card subtitle is singular (`1 budgeted month`). Annual overview + year nav still work (June row populated, other 11 dashed). No empty state (there IS one point).
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
