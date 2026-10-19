# Dashboard budget view (month view, hero, groups, lines, bills strip, jars shelf)

**ID prefix:** DASH | **Scope:** The authenticated dashboard at `/` (`client/src/pages/DashboardPage.tsx` inside `AppShell active="budget"`): render states (loading / error / not-found / month loaded), the first-run empty state with its Copy / blank / template create cards, the Hero remaining-to-budget banner and its four footnote states per PR #172 (a month with TotalIncome = 0 shows the plan-your-income prompt and NEVER the gold balanced badge; `IsBalanced` requires income > 0 AND remaining == 0), the bills strip, the month-scoped "Your jars" shelf (W05: it follows the viewed month), the Income card (`IncomeGroup`/`IncomeLineRow`), the "Everyday spending" panel (`CategoryAccordion`/`BudgetItemRow` expense layout) with group/line CRUD + reorder, planned-amount inline editing (optimistic with rollback, `parseMinor` semantics), bill tag/due-day/paid controls, Savings group cards (`SavingsGroup` + fund-line layout with rolled-over Available), the "+ Add group" flow, and dashboard-specific role gating. All totals are integer-minor-unit sums mirroring the domain (`client/src/budgetModel.ts`); actuals are always transaction-derived at read time. | **Out of scope:** month create/copy/rollover SEMANTICS (what a copy carries, jar re-seeding/accrual maths, duplicate-month race, backfill as-of seeding, month navigation via the TopBar ‹ › and its unbounded-year dead-end) → file 07 (budget-months lifecycle); recording/editing the transactions that produce actuals → transactions & transfers file; the Jars page, jar accrual/recurrence rules and allocation → jars & allocation file; the Getting-started checklist, welcome dialog and tour (incl. the checklist's own balanced rule) → 05-onboarding.md; deep role matrix across all pages and session/auth expiry → 03-session-auth-lifecycle.md and the households/roles file; GA event delivery (`budgetMonthCreated`, `budgetItemEdited`, `monthNavigated` payloads) → analytics file; dark-mode/responsive/a11y sweeps → cross-cutting file (`client/e2e/a11y.spec.ts` + `mobile-layout.spec.ts` already scan `/` in both themes and at 375px). **Do not test for:** a `RemainingBanner.tsx` component (deleted in PR #168 — the tour anchor `data-tour="remaining-banner"` now sits on the Hero); a rename affordance on the Income group header (API-only, no UI); a client-side maximum on planned amounts (none exists — the server 400s); server error text surfacing in the dashboard error strip (optimistic failures are swallowed into fixed strings).

**Test data setup:** Local stack (API :5099, `ASPNETCORE_ENVIRONMENT=Development`) or staging (staging.allotjar.com). Assumed date: **2026-07-15** (cases that score bill urgency say so). Locale/format left at default **en-GB comma-dot** (money renders `€1,234.56`), currency **EUR** (noun "euro") unless stated. Logins: (a) **dash-owner@example.test** — Owner of a solo household; (b) **dash-limited@example.test** (role Limited) and **dash-readonly@example.test** (role ReadOnly), both members of dash-owner's household; passwords random `Aa1-<uuid>` (HIBP rejects fixed common ones). Canonical month fixture "**JUL26**" (July 2026, owned by dash-owner) unless a case builds its own: Income group "Income" with lines **Take-home Pay** planned 2,600.00 (one assigned income transaction of 2,600.00 → received 2,600.00) and **Freelance** planned 400.00 (received 0) → TotalIncome 3,000.00; expense group **Housing** (Rent 1,100.00, bill dueDay 1, unpaid; Utilities 180.00, bill dueDay 20, unpaid), expense group **Food** (Groceries 400.00 with 250.00 spent; Restaurants 90.00 with 120.00 spent → overspent); savings group **Savings** with fund line **Holiday** planned 150.00, spent 0, savingsAvailable 450.00, backed by jar "Holiday" (target 1,200.00, currentBalance 450.00, requiredMonthlyContribution 150.00). Jar #2 "**Emergency Fund**" (target 500.00, balance 500.00, status FullyFunded) exists for shelf cases. Derived: month planned (non-income) = 1,920.00, **Remaining to budget = 1,080.00**. Automation hint (from PR #172 live verification): committing an inline edit in DOM automation needs a `focusout` event — React maps onBlur→focusout; a dispatched `blur` won't commit.

## Page load & render states

### DASH-001 - Month view loads with the canonical section order
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** dash-owner signed in; JUL26 exists; viewing July 2026 (current month).
- **Steps:**
  1. Navigate to `/`.
  2. Observe the transient state, then the loaded page top to bottom.
- **Expected:**
  - "Loading your budget…" shows while the GET `/budget/2026/7` is in flight, then disappears.
  - Sections render in this order: Hero (eyebrow "Remaining to budget") → bills strip → "Your jars" shelf card → Income card → "Everyday spending" card (Housing then Food inside one card) → Savings card → "+ Add group" button.
  - No error strip; the visually-hidden page `<h1>` is "Budget".
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx renders the month fixture; client/e2e/a11y.spec.ts + mobile-layout.spec.ts render `/` — section order itself unasserted)

### DASH-002 - Switching months never renders stale data under the new label
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (month cleared before fetch)
- **Preconditions:** JUL26 loaded; June 2026 budget also exists with visibly different numbers; throttle the network (slow 3G) to make the fetch window observable.
- **Steps:**
  1. Click the TopBar "Previous month" arrow.
  2. Watch the content area during the June fetch.
- **Expected:**
  - The July Hero/lines disappear immediately (replaced by "Loading your budget…"); at no instant do July's figures render under the "June 2026" TopBar label.
  - June's data appears only when its response lands.
- **Automated:** No

### DASH-003 - Budget fetch failure shows the load-error strip
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** dash-owner signed in; API stopped (or `/api/budget/*` blocked in devtools) — a non-404 failure.
- **Steps:**
  1. Load `/`.
- **Expected:**
  - Rose error strip with exactly: "Could not load your budget. Is the API running?"
  - No create-month UI (the 404 branch is not taken); no month content.
- **Automated:** No

### DASH-004 - No-budget state for a writer offers the create options
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** dash-owner; navigate to a month with no budget (e.g. August 2026) while JUL26 exists.
- **Steps:**
  1. Use the TopBar › to view August 2026.
- **Expected:**
  - Dashed card: "No budget for August 2026 yet."
  - Buttons: "Copy July 2026" (emerald) and "Start a blank budget"; below, "Or start from a template" grid.
  - No error strip; no Hero.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — Copy-previous offer on an empty month; client/e2e-journey/register.spec.ts — create hero for a first-ever month)

### DASH-005 - No-budget state for a non-writer is read-only
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** dash-limited (or dash-readonly) signed in; viewing a month with no budget.
- **Steps:**
  1. Load the month-less month on `/`.
- **Expected:**
  - "No budget for {Month} {Year} yet." plus "Ask an admin or the owner to set this month up."
  - No Copy/blank buttons, no template grid, no jars note.
- **Automated:** No

## First-run empty state & quick-start templates

### DASH-006 - First-ever month shows no Copy button
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Brand-new owner registered WITHOUT sample figures (PR #170 default) — zero budget months exist.
- **Steps:**
  1. Land on `/` after registration.
- **Expected:**
  - "No budget for {current Month Year} yet." with ONLY "Start a blank budget" + "Or start from a template" — no "Copy …" button (no strictly-earlier month exists).
- **Automated:** Yes (client/e2e-journey/register.spec.ts — no Copy button for a first-ever month, empty landing)

### DASH-007 - Copy button names the actual source month across a gap
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (copy names the real source, which may not be last calendar month)
- **Preconditions:** dash-owner has budgets for May 2026 and earlier only (no June, no July).
- **Steps:**
  1. View July 2026 (no budget).
- **Expected:**
  - The copy button reads exactly "Copy May 2026" (the most recent strictly-earlier month), NOT "Copy June 2026".
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx asserts the Copy offer; gap-naming unasserted)

### DASH-008 - "Start a blank budget" lands on a truly empty month
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Jar-less household (no jars anywhere); viewing a month with no budget; canWrite.
- **Steps:**
  1. Click "Start a blank budget".
- **Expected:**
  - POST `/budget` `{year, month, copyFromPrevious:false}`; the month renders without a reload.
  - Exactly one group: the Income card ("No income yet — add your first source below."), no Everyday spending panel, no Savings card.
  - Hero: Income €0.00 / Allotted €0.00, footnote "Plan your income, then give every euro a job" — no gold badge (see DASH-016).
- **Automated:** Yes (client/e2e-journey/register.spec.ts — starting blank lands on a real empty month, hero + Income group only)

### DASH-009 - Template grid renders the three catalogue cards exactly
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Any writer viewing a no-budget month; `/budget/templates` reachable.
- **Steps:**
  1. Read the "Or start from a template" grid.
- **Expected:** Three cards with exact name / description / counts (counts derive from `BudgetTemplates.cs`):
  - **Essentials** — "A clean starting point covering the bills most households share." — "6 groups · 13 lines"
  - **Student** — "A lightweight budget for term-time living costs." — "5 groups · 10 lines"
  - **Family** — "Two incomes, the kids, and sinking funds for the big stuff." — "7 groups · 20 lines"
  - Each card has aria-label "Start from the {name} template".
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — templates offered + create-from-template; exact descriptions/counts unasserted)

### DASH-010 - Creating from a template builds the zero-planned structure
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Jar-less household; no-budget month; canWrite.
- **Steps:**
  1. Click the "Essentials" template card.
  2. While the POST is in flight, try clicking another create button.
- **Expected:**
  - All create buttons are disabled while `creating` (no double submission).
  - POST `/budget` `{copyFromPrevious:false, templateKey:'essentials'}`; the month renders with groups Income / Housing / Food / Transport / Lifestyle / Savings and the template's lines, every planned amount €0.00.
  - Hero shows the empty-month prompt (income 0, allotted 0 — planned amounts are all zero).
  - The Savings group's "Emergency Fund" line is a fund line (Available column) — its backing jar now exists (deep jar-minting semantics → file 07 / jars file).
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — create-from-template POST; tests/AllotJar.Application.Tests/Application/BudgetTemplatesTests.cs — structure at zero planned; tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs — template savings lines jar-backed)

### DASH-011 - Jars note pluralises correctly on the create screen
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Household owns exactly 1 active jar; then repeat with 2.
- **Steps:**
  1. View a no-budget month as a writer; read the note under the create buttons.
- **Expected:**
  - With 1 jar: "Your 1 existing jar is added to any new budget automatically, so it will have a few more lines than a template lists."
  - With 2 jars: "Your 2 existing jars are added to any new budget automatically, …"
  - With 0 jars the note is absent entirely.
- **Automated:** No

### DASH-012 - Create failure surfaces the generic create error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Two tabs on the same no-budget month; create the month in tab A first (or block POST `/budget`).
- **Steps:**
  1. In tab B (still showing the create state), click "Start a blank budget".
- **Expected:**
  - The server 400 ("A budget for {yyyy}-{MM} already exists.") is NOT surfaced verbatim; the strip reads exactly "Could not create that budget."
  - The create UI remains usable; navigating away and back to the month now loads tab A's budget.
- **Automated:** No (the server-side race → friendly 400 is covered in tests/AllotJar.IntegrationTests/BudgetMonthConcurrencyTests.cs; the client strip is not)

### DASH-013 - Templates fetch failure hides only the template grid
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Block GET `/budget/templates` (or 500 it); view a no-budget month as a writer.
- **Steps:**
  1. Load the create state.
- **Expected:**
  - "Or start from a template" section absent (templates state stays `[]`); Copy/blank buttons unaffected; no error strip for the template failure.
- **Automated:** No

## Hero & balanced states (PR #172)

### DASH-014 - Under-allotted month: tiles and "still to assign"
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26 as fixtured (Income 3,000.00, Allotted 1,920.00).
- **Steps:**
  1. Load `/` and read the Hero.
- **Expected:**
  - Eyebrow "Remaining to budget"; gold amount "€1,080.00" with aria-label "Remaining to budget: €1,080.00".
  - Tiles: Income "€3,000.00", Allotted "€1,920.00" (Allotted = expense + savings planned; income planned excluded).
  - Footnote (neutral pill): "€1,080.00 still to assign". No gold badge.
- **Automated:** Partial (client/src/budgetModel.test.ts — remaining/pool math incl. savings-in-planned; footnote text unasserted)

### DASH-015 - Balanced month shows the gold badge
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26; then edit Groceries planned from 400.00 to 1,480.00 so remaining hits exactly 0 (income 3,000.00 = planned 3,000.00).
- **Steps:**
  1. Commit the planned edit; read the Hero.
- **Expected:**
  - Gold amount "€0.00"; footnote is the gold `BalancedBadge` (gold disc + checkmark) reading "Every euro has a job".
  - The badge appears instantly from the optimistic recompute — before the PUT resolves.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — optimistic edit drives Remaining to €0.00; budgetModel.test.ts + tests/.../Domain/RemainingToBudgetTests.cs — isBalanced; badge rendering unasserted)

### DASH-016 - Empty month prompts for income and never celebrates
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #172 (empty ≠ balanced; IsBalanced requires TotalIncome > 0)
- **Preconditions:** Jar-less household with a blank month (income 0, nothing planned) — remaining is €0.00.
- **Steps:**
  1. Load the month; read the Hero footnote.
- **Expected:**
  - Footnote (neutral tone, NOT gold, NOT rose): "Plan your income, then give every euro a job".
  - The gold `BalancedBadge` is absent even though remaining == 0.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — "prompts for income on an empty month instead of celebrating it as balanced"; client/src/budgetModel.test.ts; tests/.../RemainingToBudgetTests.cs — IsBalanced_RequiresIncome_NotJustZeroRemaining)

### DASH-017 - Income 0 with planned > 0 shows over-budgeted, not the income prompt
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #172 (empty prompt only when income==0 AND allotted==0)
- **Preconditions:** Blank month, jar-less household; add expense group "Bills" with line "Rent" planned 500.00; income still 0.
- **Steps:**
  1. Read the Hero after the planned edit commits.
- **Expected:**
  - Footnote is the rose over-budget pill: "€500.00 over-budgeted — trim a line" — NOT "Plan your income…" and NOT the gold badge.
  - Gold amount reads "-€500.00"; Income tile €0.00, Allotted €500.00.
- **Automated:** Partial (budgetModel.test.ts covers the selector math; the rose-vs-prompt UI branch unasserted)

### DASH-018 - Over-budgeted month: rose footnote with the positive overrun
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26; edit Rent planned to 2,300.00 → planned 3,120.00 vs income 3,000.00 (remaining −120.00).
- **Steps:**
  1. Commit the edit; read the Hero.
- **Expected:**
  - Gold amount "-€120.00"; rose-toned pill: "€120.00 over-budgeted — trim a line" (the amount is negated to read positive).
- **Automated:** No

### DASH-019 - One minor unit off is not balanced
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** JUL26 balanced per DASH-015; then edit Groceries planned to 1,479.9999 (4 dp accepted).
- **Steps:**
  1. Commit; read the Hero.
- **Expected:**
  - Remaining is 0.0001 (1 minor unit) → NOT balanced: no gold badge.
  - The footnote reads "€0.00 still to assign" (currency display rounds to 2 dp) — honest per the integer math even though the visible amount shows zero.
- **Automated:** No (4-decimal precision is covered server-side in RemainingToBudgetTests; this display seam is not)

### DASH-020 - Jar-owning household's blank month is born over-budgeted
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #172 corollary + PR #167/M1 (month create appends accrual-planned savings lines per active jar)
- **Preconditions:** dash-owner (owns jars Holiday + Emergency Fund); a no-budget month; canWrite.
- **Steps:**
  1. Click "Start a blank budget".
- **Expected:**
  - The new month contains a Savings group with a line per active jar, planned at each jar's accrual requirement (> 0 for Holiday).
  - Hero: Income €0.00, Allotted > €0.00 → rose "…over-budgeted — trim a line", NOT the plan-your-income prompt (only truly zero months show it).
- **Automated:** Partial (tests/.../Application/JarBudgetLinkTests.cs — blank create appends jar lines; the resulting hero state unasserted)

### DASH-021 - Currency-aware noun, symbol and fraction digits in the Hero
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Three fresh households whose budget currency (chosen at sign-up, so every month's `baseCurrency`) is: (a) GBP, month balanced; (b) JPY; (c) a code outside the noun map (e.g. ISK). A month's currency can't be set on its own — it is always the budget currency (BUDG-011).
- **Steps:**
  1. Load each variant's dashboard and read the Hero.
- **Expected:**
  - (a) Badge reads "Every pound has a job"; amounts render "£…".
  - (b) Amounts render 0 dp ("¥1,234", never "¥1,234.00"); empty prompt would say "every yen".
  - (c) Noun falls back to "unit" ("Plan your income, then give every unit a job" / "Every unit has a job").
- **Automated:** Partial (client/src/lib/money.test.ts — currencyNoun incl. "unit" fallback + per-currency fraction digits; Hero usage unasserted)

## Bills strip

### DASH-022 - No bill lines → no strip
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A month whose lines all have dueDay null (e.g. clear both fixture bills).
- **Steps:**
  1. Load the month.
- **Expected:** No bills strip between the Hero and the jars shelf — the row is absent entirely (not an empty box).
- **Automated:** No

### DASH-023 - Unpaid bills summary and left-to-pay sum
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26 viewed on 2026-07-15 but with Rent's dueDay moved to 25 (so nothing is overdue: Rent day 25 = upcoming, Utilities day 20 = due soon).
- **Steps:**
  1. Read the strip.
- **Expected:**
  - Left: "📅 Bills: 0/2 paid · 1 due soon" (amber tone).
  - Right: "€1,280.00 left to pay" (sum of unpaid bills' planned: 1,100 + 180).
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — paid toggle + bills summary; client/src/budgetModel.test.ts — billsSummary/billAlerts; tone + exact strings unasserted)

### DASH-024 - Overdue takes the rose tone and suppresses the due-soon count
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26 as fixtured, today 2026-07-15 (Rent day 1 overdue, Utilities day 20 due soon).
- **Steps:**
  1. Read the strip.
- **Expected:**
  - Rose tone; "📅 Bills: 0/2 paid · 1 overdue" — the "due soon" fragment does NOT render while overdue > 0.
  - Right side still "€1,280.00 left to pay".
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — overdue bill flagged in summary and row; suppression rule unasserted)

### DASH-025 - Paying down to all-paid flips the strip to the celebration
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26 with both bills unpaid.
- **Steps:**
  1. Mark Rent paid (☐ Paid on the row), observe the strip.
  2. Mark Utilities paid.
- **Expected:**
  - After step 1: "📅 Bills: 1/2 paid …", right side "€180.00 left to pay" (only unpaid planned counts).
  - After step 2: emerald tone, "📅 Bills: 2/2 paid", right side "All bills paid 🎉".
  - Each update appears optimistically before the PUT resolves.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — toggle paid + bills summary; the all-paid emerald string unasserted)

### DASH-026 - Bills on non-expense lines still count in the strip
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Via API, PUT `/budget/items/{id}/bill` `{dueDay: 10}` on an income line and on the Holiday savings line (the UI offers no bill controls on either layout).
- **Steps:**
  1. Reload the dashboard; read the strip.
- **Expected:**
  - `billsSummary` spans all kinds: total now 4; unpaid sum includes the income/savings lines' planned amounts.
  - The income/savings rows themselves still render no Bill tag or Paid toggle (those live only in the expense layout) — the strip is the only surface reflecting them.
- **Automated:** No

## Your jars shelf

### DASH-027 - Shelf renders on the current month with totals and per-jar detail
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26 is the current calendar month; jars Holiday (450.00 of 1,200.00 target, +150.00/mo, no chip) and Emergency Fund (FullyFunded) exist.
- **Steps:**
  1. Load `/`; inspect the "Your jars" card.
- **Expected:**
  - The shelf's request is `GET /api/jars?year=2026&month=7` (W05: the viewed month's figures).
  - Header "Your jars" + "€950.00 saved" (sum of `currentBalance`) with no "as of" suffix on the current month.
  - Holiday: jar graphic with accessible label "Holiday: 38% of goal" (450/1200 rounded), name, "€450.00", and "+€150.00/mo".
  - Emergency Fund: its status chip (funded celebration) replaces the monthly figure — chip and "+…/mo" are mutually exclusive.
  - Boundary: a jar with target 0 labels "0% of goal"; an overfunded jar's label clamps at 100%.
- **Automated:** Partial (client/src/lib/jarStatus.test.ts — chip selection; client/src/pages/DashboardPage.jars.test.tsx DASH-028 — the request, the total and the monthly figure; shelf rendering itself also axe-scanned in client/e2e/a11y.spec.ts)

### DASH-028 - Shelf follows the viewed month
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (shelf showed today's all-time balances on the current month only); W05 (rule 48, REVIEW J6) makes it the viewed month's view.
- **Preconditions:** Jars exist; budgets exist for June, July (current) and August 2026; Holiday held 300.00 at June's end and 450.00 today.
- **Steps:**
  1. View July 2026 → shelf visible.
  2. Navigate to June 2026, then August 2026.
- **Expected:**
  - The "Your jars" card renders on every month that has a budget; each navigation issues a fresh `GET /api/jars?year=…&month=…` and the shelf re-renders from it (never the previous month's figures).
  - June: Holiday reads €300.00 and the header "€… saved as of 30 Jun 2026"; the "+€…/mo" figure is June's own line.
  - August: the header reads "€… saved balances as of today", Holiday reads today's €450.00, "+€…/mo" is August's line.
  - The Savings card's Available figure on the same month equals the shelf's balance (DASH-030).
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-028/073/074 — mocked; the month switch itself is covered by the effect's dependency and the past/future cases)

### DASH-029 - /jars failure leaves the shelf absent with a note; a non-array body leaves it absent
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Block GET `/jars` (or return a non-array body); current month loaded.
- **Steps:**
  1. Load `/`.
- **Expected:** No shelf, no error strip, rest of the dashboard intact. A blocked read shows the note "Could not load your jars for this month. Change month or reload to try again." and no first-run checklist (DASH-079); a non-array body shows no note (the fetch is guarded; non-arrays coerce to `[]`). Note: this fetch ignores the `jars` feature flag — flag-off behaves identically to flag-on here.
- **Automated:** Partial (client/src/pages/DashboardPage.jars.test.tsx DASH-079 — a failed read after a month change)

### DASH-030 - Shelf balance and the fund line's "avail." agree on every month
- **Priority:** P2
- **Type:** Regression
- **Origin:** Jar allocation slice (both read the ledger); W05 (rule 48) reads them at one date per month.
- **Preconditions:** Jar "Holiday" with 300.00 allocated by June's end and 150.00 more in July; budgets for June, July (current) and August.
- **Steps:**
  1. On June, July and August in turn, compare the shelf's Holiday balance with the Savings card's "avail." figure on the Holiday line.
- **Expected:**
  - June: both €300.00 (as of 30 June); July and August: both €450.00 (today). Neither figure includes planned contributions.
  - A difference on any month is a defect (there is no longer a jar opening balance to explain one).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarMonthViewW05Tests.cs `Rules48And49_TheBudgetGridsAvailable_AgreesWithTheShelf_OnEveryMonth`)

### DASH-073 - A past month's shelf is dated at the month's end
- **Priority:** P1
- **Type:** Happy
- **Origin:** W05 (rule 48)
- **Preconditions:** Today is in the month after the viewed one; the server answers `/jars?year&month` with `balanceAsOf` = the month's last day, `currentBalance` 300.00, `plannedThisMonth` 100.00.
- **Steps:**
  1. View the past month.
- **Expected:** The shelf renders; the header reads "€300.00 saved as of 30 Jun 2026" (the server's `balanceAsOf`, browser-locale formatted); Holiday reads €300.00 and "+€100.00/mo" (that month's line). No ✕ / skip affordances on the lines (BUDG-062).
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx)

### DASH-074 - A month that has not begun shows today's balances and says so
- **Priority:** P2
- **Type:** Happy
- **Origin:** W05 (P47)
- **Preconditions:** Today is in the month before the viewed one; the server answers with today's `currentBalance` and the viewed month's `plannedThisMonth` 130.00, `contributedThisMonth` 0.
- **Steps:**
  1. View the later month (it has a budget).
- **Expected:** The shelf renders with the header "€… saved balances as of today" and "+€130.00/mo" — the month's own plan, nothing contributed yet. The server never reads a future date.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx; the server side in JarMonthViewW05Tests `Rule48_AMonthThatHasNotBegun_…` and `…DoesNotSettleACycle_…`)

### DASH-075 - The shelf is re-read after changes that move a jar's figures
- **Priority:** P1
- **Type:** Regression
- **Origin:** REVIEW J6 (the shelf went stale after edits); W05 (P50)
- **Preconditions:** JUL26 loaded with the Holiday jar line; the shelf has loaded once.
- **Steps:**
  1. Edit Holiday's planned amount to 200.00 and commit (focusout).
  2. Edit Rent's planned amount and commit.
  3. On a month with no budget, click "Start a blank budget".
- **Expected:**
  - Step 1: after `PUT /api/budget/items/{id}` succeeds, `GET /api/jars?year&month` is issued again and the shelf's "+€/mo" follows the new plan.
  - Step 2: no `/jars` re-read (an expense line moves no jar figure).
  - Step 3: after `POST /api/budget` returns the month, `/jars` is re-read and the shelf appears with the seeded lines as its plan.
  - Skipping a month / Plan it again / Archive jar from a line (BUDG-060/061) and creating a jar from a Savings group already re-read it.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-075 ×2)

### DASH-076 - Navigating months never shows the previous month's shelf under the new month
- **Priority:** P1
- **Type:** Regression
- **Origin:** Adversarial review of PR #275 (W05): the month was cleared on navigation, the jars were not.
- **Preconditions:** A past month with a jar at 300 (dated shelf) and the current month with the same jar at 450; a slow `/jars` response for the current month.
- **Steps:**
  1. View the past month. 2. Navigate to the current month.
- **Expected:** 1: "€300.00 saved as of <last day>". 2: the current month's grid appears with the shelf absent until its own `GET /api/jars?year&month` lands, then "€450.00 saved" with no date; at no point does "€300.00 saved" show under the current month.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-076)

### DASH-077 - Navigating months never flashes the first-run checklist while the new month's jars load
- **Priority:** P1
- **Type:** Regression
- **Origin:** Adversarial re-review of PR #275 (W05): clearing the shelf on navigation (DASH-076) left the checklist reading "no jar yet" until the new month's read landed.
- **Preconditions:** An account, a past month and the current month each with a jar (300 then 450); a slow `/jars` response for the current month.
- **Steps:**
  1. View the past month. 2. Navigate to the current month. 3. Let the jars read land.
- **Expected:** "Set up your budget" is never shown: not on the past month, not while the current month's grid is on screen with its shelf still loading, and not after "€450.00 saved" appears.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-077)

### DASH-078 - A jar line's save that returns after a month change leaves the new month's shelf alone
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, P2-12): the save's shelf refresh read the month it was made on after the user had moved on, and that month's jars stayed under the new month's grid.
- **Preconditions:** The current month with Holiday at 450 (its line on the grid) and a past month with Holiday at 300; a slow `PUT /api/budget/items/{id}`.
- **Steps:**
  1. On the current month click Holiday's planned amount and type 200. 2. Click the previous-month arrow (the blur commits the save, the click changes month). 3. Let the save return.
- **Expected:** 2: `PUT /api/budget/items/{id}` with `plannedAmount: 200` is sent; the past month's grid and shelf load ("€300.00 saved as of <last day>"). 3: no further `/jars` read is issued and the shelf keeps "€300.00 saved"; "€450.00 saved" never shows under the past month. The same guard covers every shelf refresh that follows a save, such as Start a blank budget or a template.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-078)

### DASH-079 - A failed jars read after a month change says so instead of showing the first-run checklist
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, P2-13): a failed read counted as loaded, so the cleared shelf read as "no jar yet" and the checklist asked to "Add a jar from an account".
- **Preconditions:** An account and a Holiday jar; the current month loaded with its shelf ("€450.00 saved"); `GET /api/jars?year&month` for the previous month answers 500.
- **Steps:**
  1. Navigate to the previous month.
- **Expected:** The month's grid loads; the shelf is absent and a note reads "Could not load your jars for this month. Change month or reload to try again."; "Set up your budget" is not shown. A later successful read (another month, or a reload) clears the note.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-079)

### DASH-080 - Typing an amount on a skipped jar line clears its Skipped tag
- **Priority:** P2
- **Type:** Regression
- **Origin:** Adversarial review of PR #275 (W05, P2-16; pre-existing since W04): the server un-skips the month when a jar line gets an amount (rule 60) and the shelf re-read showed it planned, but the line kept "Skipped" and "Plan it again".
- **Preconditions:** The current month with Holiday's contribution skipped (its line at €0.00 with the Skipped tag).
- **Steps:**
  1. Click Holiday's planned amount, type 200, and tab away.
- **Expected:** `PUT /api/budget/items/{id}` with `plannedAmount: 200`; the line shows €200.00 with no Skipped tag and no "Plan it again"; the shelf re-reads to "+€200.00/mo". Typing 0 on a skipped line keeps it skipped (the server keeps it too).
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-080)

### DASH-081 - An answer that returns after the user changed month never repaints the month now viewed
- **Priority:** P2
- **Type:** Regression
- **Origin:** Adversarial review of PR #275 (W05, P2-17; pre-existing): creating a month, "Plan it again", a save's reconcile or a failed save's rollback that returned after the user changed month put the old month's grid under the new month's label, and later edits went to the old month's lines.
- **Preconditions:** The previous month has a budget (Holiday planned €100.00); the current month has none, or has Holiday's contribution skipped; `POST /api/budget` or `PUT /api/budget/items/{id}/skip` is slow.
- **Steps:**
  1. On the current month click "Start a blank budget" (or Holiday's "Plan it again"). 2. Before it returns, go to the previous month. 3. Let the request return.
- **Expected:** 2: the previous month's grid loads (Holiday €100.00). 3: it stays; the current month's answer (Holiday €150.00) never shows under the previous month's label. Going back to the current month loads it from the server. The same guard covers every save's reconcile and rollback on the grid.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-081, both cases)

### DASH-082 - Every save, re-read, reconcile and rollback that answers after the user changed month leaves the viewed month alone
- **Priority:** P2
- **Type:** Regression
- **Origin:** Adversarial review of PR #276 (P3-12): the guards #276 added to every Dashboard handler (`isViewed`/`stillOn`) had tests for two of the twenty sites only (DASH-081).
- **Preconditions:** The previous month has a budget (Rent €900.00) and the current month another (Rent €1,100.00), with the same lines and groups; the request under test is slow.
- **Steps:**
  1. On the current month start the action: a template create, a re-read (archive Holiday from its line), an amount, member, due-day, paid or name edit, adding or deleting a line or group, renaming a group, moving a group or a line, or skipping Holiday's line. 2. Before it returns, go to the previous month. 3. Let the request return with the current month, or fail.
- **Expected:** 2: the previous month's grid loads (Rent €900.00). 3: it stays; neither the current month's answer (Rent €1,100.00) nor the rollback to the current month's snapshot shows under the previous month's label, and a 404 on the re-read does not say the previous month is missing.
- **Automated:** Yes (client/src/pages/DashboardPage.lateAnswers.test.tsx DASH-082, 22 cases, one per guarded site; each fails with its guard removed)

## Income card

### DASH-031 - Income header shows transaction-derived received of planned
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26 (Take-home Pay received 2,600.00 via an assigned income transaction).
- **Steps:**
  1. Read the Income card header and the Take-home Pay row.
- **Expected:**
  - Header: "Income" + "€2,600.00 of €3,000.00".
  - Row subtext "€2,600.00 received"; green bar at 100% (2,600/2,600); Freelance bar at 0%.
  - The received figure has no edit affordance anywhere — actuals are read-only and change only when transactions change.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — tx-derived spent is read-only; income-header string unasserted)

### DASH-032 - Rename an income source: commit and revert semantics
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; dash-owner.
- **Steps:**
  1. Click into the "Freelance" name input (aria "Income source name"), type "Consulting", press Enter.
  2. Edit again, type "Ignored", press Escape.
  3. Edit again, clear to empty/whitespace, blur.
  4. Repeat step 1 with the API blocked.
- **Expected:**
  1. Enter blurs → PUT `/budget/items/{id}` `{plannedAmount: 400, name: "Consulting"}` (rename carries current planned); name sticks optimistically.
  2. Escape reverts the field to "Consulting"; no request.
  3. Empty reverts silently to the previous name; no request.
  4. Rollback to the old name + strip "Could not rename that line — reverted to the previous name."
- **Automated:** No

### DASH-033 - Editing income planned moves the pool instantly
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26 (remaining €1,080.00).
- **Steps:**
  1. Click the Freelance planned amount button (aria "Planned amount for Freelance"), type "600", blur.
- **Expected:**
  - Hero remaining jumps to "€1,280.00" and the Income tile to "€3,200.00" before the PUT resolves; Income header now "€2,600.00 of €3,200.00".
  - PUT `/budget/items/{id}` `{plannedAmount: 600}`.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — optimistic planned-edit recomputes Remaining)

### DASH-034 - Add an income source
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; dash-owner.
- **Steps:**
  1. In the add row (placeholder "Add income source (e.g. Freelance, Child Benefit)…", aria "New income source name") type "Child Benefit", press Enter.
  2. Try submitting "   " (whitespace only) via the "+ Add" button (aria "Add income source").
- **Expected:**
  1. A temp row appears instantly at the bottom (planned €0.00, received €0.00); POST `/budget/categories/{incomeCatId}/items` `{name:"Child Benefit", plannedAmount:0}`; the row reconciles to the server id. Input clears. Failure path: row vanishes + "Could not add that line — reverted."
  2. Whitespace never submits — no request, input unchanged.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — add income source reconciling from server)

### DASH-035 - Delete an income source (no confirm) and reach the empty state
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Month with a single income line planned 500.00, remaining computed off it.
- **Steps:**
  1. Hover the line; click ✕ (aria "Delete {name}", title "Delete income source").
- **Expected:**
  - The line disappears immediately — line deletes have NO confirm step (unlike group deletes); DELETE `/budget/items/{id}`; Hero income drops by €500.00.
  - The card now shows "No income yet — add your first source below."; failure path restores the row + "Could not delete that line — reverted."
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — delete income source)

### DASH-036 - Income-specific constraints hold
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** JUL26; for the multi-group check, seed a second Income-kind category via direct DB/legacy data (AddCategory cannot create Income).
- **Steps:**
  1. Inspect income rows and the card header; hover everywhere.
  2. Load the two-income-group variant.
- **Expected:**
  1. Income lines have NO Bill tag, no 📅 add-bill, no Paid toggle, no ▲▼ reorder gutter (those affordances are expense-layout only). The card header "Income" is plain text — no rename input even for the Owner (rename exists only via API).
  2. Each Income-kind category renders its own Income card, both above the Everyday spending panel.
- **Automated:** No

## Planned-amount inline editing & parsing

### DASH-037 - Optimistic commit: instant banner, saving dot, exact payload
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26; slow network (to observe in-flight state).
- **Steps:**
  1. Click Groceries' planned amount (rendered formatted at rest, e.g. "€400.00").
  2. Observe the editor; type "450.50"; press Enter.
  3. While the PUT is in flight, watch the row; then let it succeed.
  4. Re-open the editor and press Escape.
- **Expected:**
  - The editor shows the RAW edit string ("400", via `toEditString`) with a "€" prefix outside the input; inputMode decimal.
  - On commit: row + Hero recompute instantly (remaining drops €50.50 before the response); a pulsing "Saving…" dot (aria-label "Saving") sits next to the line until the PUT resolves; payload `{plannedAmount: 450.5}`.
  - Success keeps the optimistic state (response body ignored). Escape closes the editor with no request.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — optimistic planned edit + PUT /budget/items/{id})

### DASH-038 - Failed planned save rolls back and explains
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** JUL26; block PUT `/budget/items/*`.
- **Steps:**
  1. Edit Groceries planned to "999", blur.
- **Expected:**
  - Value snaps back to €400.00; Hero remaining returns to €1,080.00; strip: "Could not save that change — reverted to the previous value."
  - The rollback restores the exact pre-edit snapshot (no other line disturbed).
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — failed save rolls back + shows error)

### DASH-039 - Accepted number formats and 4-dp rounding
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** JUL26; en-GB display.
- **Steps:** Edit a planned amount with each input, blurring between: `12,50` · `1.234,56` · `1,234.56` · `1 234,56` · `1'234.56` · `0` · `1.00005` · `1.00004`.
- **Expected:**
  - `12,50` → €12.50 (comma decimal); `1.234,56`, `1,234.56`, `1 234,56`, `1'234.56` all → €1,234.56 (right-most separator wins; space/apostrophe grouping stripped).
  - `0` → €0.00 accepted (zero planned is legal; bar renders 0%).
  - `1.00005` rounds half-up to 1.0001 minor units (displays €1.00); `1.00004` truncates to 1.0000. Each changed value fires exactly one PUT.
- **Automated:** Partial (client/src/lib/money.test.ts — parseMinor accept table + scale-4 round-trip; the in-row commit per format unasserted)

### DASH-040 - Rejected inputs revert silently
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** JUL26; Groceries planned €400.00.
- **Steps:** Edit the planned amount with each input, blurring between: `` (empty) · `   ` · `-5` · `abc` · `1.2.3` · `1,2,3` · `.5` · `€10` · `1e3`.
- **Expected:**
  - Every one reverts the field to "400" with NO request and NO error message (client validation is silent-revert by design — negatives included; `.5` fails the leading-digit rule).
  - Hero remaining never flickers.
- **Automated:** Partial (client/src/lib/money.test.ts — parseMinor reject table; silent in-row revert unasserted)

### DASH-041 - Range boundaries: unchanged no-op and over-max server rejection
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** JUL26; network tab open.
- **Steps:**
  1. Open Groceries' planned editor, retype the same value "400", blur.
  2. Edit to `99999999999999.9999` (the server max), blur.
  3. Edit to `100000000000000000`, blur.
- **Expected:**
  1. No PUT fires (commit only when the parsed value differs).
  2. Accepted (≤ decimal(18,4) max) — PUT succeeds.
  3. There is NO client-side max: the PUT is sent, the server 400s ("Planned amount exceeds the supported range.") and the UI rolls back with the fixed strip "Could not save that change — reverted to the previous value." (the server detail never surfaces).
- **Automated:** No

## Everyday spending panel — groups & lines

### DASH-042 - Panel header sums all expense groups; absent when none exist
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26 (Housing spent 0/1,280; Food spent 370/490).
- **Steps:**
  1. Read the "Everyday spending" card header and each group's totals.
  2. Load a blank month (Income only).
- **Expected:**
  1. Panel header: "Everyday spending" + "€370.00 of €1,770.00" (expense groups only — savings excluded). Group rows: Housing "€0.00 / €1,280.00", Food "€370.00 / €490.00". Each group gets a distinct colour dot (hue by index).
  2. With zero expense groups the whole panel is absent (no empty card).
- **Automated:** No

### DASH-043 - Rename a group inline
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; dash-owner.
- **Steps:**
  1. Edit the Housing header input (aria "Rename group Housing") to "Home", press Enter; then test Escape and empty-revert as in DASH-032; then retry with PUT `/budget/categories/{id}` blocked.
- **Expected:**
  - Enter/blur commits (name trimmed server-side), Escape/empty revert silently; PUT `/budget/categories/{id}` `{name:"Home"}`.
  - Blocked: name rolls back + "Could not rename that group — reverted to the previous name."
- **Automated:** No

### DASH-044 - Delete a group requires the inline confirm
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; Food group has 2 lines.
- **Steps:**
  1. Hover the Food header; click 🗑 (aria "Delete group Food").
  2. Click "Cancel" (aria "Cancel delete").
  3. Repeat and click "Delete" (aria "Confirm delete Food").
- **Expected:**
  2. Confirm strip collapses; nothing deleted, no request.
  3. Group and BOTH its lines vanish optimistically; DELETE `/budget/categories/{id}`; Hero remaining rises by €490.00 (the group's planned). Failure path restores the group + "Could not delete that group — reverted."
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — delete group only after confirm)

### DASH-045 - Move groups up/down, expense-only, ends disabled
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26 (expense order Housing, Food; plus Income above and Savings below).
- **Steps:**
  1. Hover Housing's header: verify ▲ (aria "Move Housing up") is disabled, ▼ enabled.
  2. Click "Move Housing down".
  3. Retry with PUT `/budget/categories/order` blocked.
- **Expected:**
  2. Housing and Food swap instantly; PUT `/budget/categories/order` `{budgetMonthId, orderedCategoryIds:[foodId, housingId]}` (expense ids only). Income stays first and Savings last regardless (per-kind render order is fixed).
  3. Order snaps back + "Could not reorder the groups — reverted."
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — reorder groups via move buttons; tests/.../ReorderBudgetCategoriesTests.cs — Income stays first)

### DASH-046 - Add a line to an expense group
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; dash-owner.
- **Steps:**
  1. Hover the Food group; click "+ Add a line" (aria "Add a line to Food").
  2. Type "Coffee" in the input (placeholder "Add a line (e.g. Groceries, Fuel)…"), press Enter.
  3. Re-open, press Escape; re-open, blur with the field empty.
- **Expected:**
  2. Temp row appears at the bottom of Food (planned €0.00); POST `/budget/categories/{foodId}/items` `{name:"Coffee", plannedAmount:0}`; reconciles to the server row. Failure: row vanishes + "Could not add that line — reverted."
  3. Escape and empty-blur both close the input without a request.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — add expense line)

### DASH-047 - Reorder lines within a group
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Food group with Groceries above Restaurants.
- **Steps:**
  1. Hover Groceries; in the left gutter click ▼ (aria "Move Groceries down"); verify ▲ was disabled while first.
  2. Retry with PUT `/budget/categories/{id}/items/order` blocked.
- **Expected:**
  1. Rows swap instantly; PUT `/budget/categories/{foodId}/items/order` `{orderedItemIds:[restaurantsId, groceriesId]}`; server response reconciles.
  2. Rollback + "Could not reorder the lines — reverted."
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — reorder lines via move buttons)

### DASH-048 - Delete an expense line
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; Groceries has 250.00 of transaction spend.
- **Steps:**
  1. Hover Groceries; click ✕ (aria "Delete Groceries", title "Delete line").
- **Expected:**
  - Row vanishes immediately (no confirm); DELETE `/budget/items/{id}`; Hero remaining rises by €400.00; panel spent total drops by €250.00.
  - Its transactions are NOT deleted — they become unassigned (verify on /transactions; deep coverage in the transactions file).
  - Failure path: row restored + "Could not delete that line — reverted."
- **Automated:** No

### DASH-049 - Rename a line; name boundaries
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** JUL26; dash-owner.
- **Steps:**
  1. Rename Groceries (aria "Rename Groceries") to a 120-character string, blur.
  2. Rename to a 121-character string, blur.
  3. Rename to "🛒 Groceries & Café — ćčž".
  4. Rename Restaurants to "Groceries" (duplicate of an existing line).
- **Expected:**
  1. Accepted (MaxLength 120).
  2. Server 400s; UI rolls back + "Could not rename that line — reverted to the previous name." (no client-side length cap).
  3. Unicode/emoji accepted and round-trips intact.
  4. Duplicates are allowed — no uniqueness rule on names.
- **Automated:** Partial (tests/.../BudgetItemCrudHandlerTests.cs — name > 120 rejected; UI paths unasserted)

### DASH-050 - Overspent and zero-planned line rendering
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26 (Restaurants planned 90.00, spent 120.00); plus a line with planned 0 and 15.00 spent.
- **Steps:**
  1. Read the Restaurants row; then the zero-planned row.
- **Expected:**
  - Restaurants: right column "-€30.00 left" in rose; beneath it "€120.00 of €90.00"; progress bar clamped at 100%.
  - Zero-planned row: bar renders 0% (never NaN/overflow); "-€15.00 left" rose.
  - Spent figures are transaction-derived with no edit affordance.
- **Automated:** Partial (client/src/budgetModel.test.ts — itemRemaining; DashboardPage.test.tsx — tx-derived spent read-only; bar clamp unasserted)

### DASH-051 - Add group flow: both kinds, placeholders, cancel paths
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; dash-owner.
- **Steps:**
  1. Click "+ Add group" (aria "Add a group").
  2. Verify the input placeholder with kind = Expense; switch the kind select (aria "New group kind") to "Savings" and re-check.
  3. Type "Subscriptions", kind Expense, click "Add" (aria "Add category group").
  4. Repeat with kind Savings, name "Travel", but with POST `/budget/categories` blocked.
  5. Re-open and press Escape; re-open and click "Cancel" (aria "Cancel adding group"); try "Add" with an empty name.
- **Expected:**
  2. Placeholder swaps: "Add a category group (e.g. Subscriptions, Insurance)…" ↔ "Add a savings group (e.g. Travel, Big purchases)…".
  3. Temp group appears instantly then reconciles; POST body `{budgetMonthId, name:"Subscriptions", isSavings:false}`; the group lands inside the Everyday spending panel after Food.
  4. Rollback + the kind-specific strip: "Could not add that savings group — reverted." (expense variant reads "Could not add that group — reverted.").
  5. Escape/Cancel close and clear the input; empty name never submits.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — add category group + create fund group)

### DASH-052 - Rename PUT carries the current planned amount (lost-update seam)
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Two sessions (A: dash-owner, B: second Admin) on JUL26.
- **Steps:**
  1. In B, change Groceries planned 400 → 450 (commits).
  2. In A (which still shows 400 and hasn't refetched), rename Groceries to "Food shop".
- **Expected:**
  - A's rename sends `{plannedAmount: 400, name:"Food shop"}` — the update endpoint requires plannedAmount, so A's stale 400 overwrites B's 450. Document the observed final value; this is a known API-shape gotcha (map §7.12), not a silent client bug — B's next refetch shows 400.
- **Automated:** No

## Bill controls on expense lines

### DASH-053 - Track a line as a bill via the due-day editor
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; Groceries has no bill.
- **Steps:**
  1. Hover Groceries; click 📅 (aria "Add a due date to Groceries", title "Track as a bill").
  2. In the number input (aria "Due day for Groceries", min 1 max 31) type `1`, click ✓ (aria "Save due day for Groceries").
  3. Repeat on another line with `31`.
- **Expected:**
  - PUT `/budget/items/{id}/bill` `{dueDay: 1}`; the "Bill" tag appears optimistically; boundary days 1 and 31 both accepted.
  - The bills strip appears/updates to include the new bill; the Paid toggle now renders on the row.
  - While a line has no bill, no ✕-remove button shows inside the editor.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — mark line as bill w/ due day)

### DASH-054 - Invalid due days revert silently; unchanged is a no-op
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Rent is a bill due day 1.
- **Steps:**
  1. Open Rent's due-day editor (click the Bill tag, aria "Edit due day for Rent"); try `0`, `32`, `2.5`, `abc` — ✓ after each.
  2. Re-open and save `1` (unchanged).
  3. Re-open, type `15`, press Escape.
- **Expected:**
  1. Each invalid value closes the editor and reverts the draft to "1" — no request, no message (silent revert).
  2. Unchanged value sends no request.
  3. Escape reverts without a request.
- **Automated:** Partial (tests/.../BillTrackingTests.cs — due-day range validator; the client silent-revert unasserted)

### DASH-055 - Bill tooltip shows the clamped due day in short months
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (tooltip uses effectiveDueDay — Feb shows 28, not 31)
- **Preconditions:** A February 2026 budget with a bill line dueDay 31, unpaid; view that month.
- **Steps:**
  1. Hover the Bill tag; read the title text.
- **Expected:**
  - The tooltip names day 28 (Feb 2026 has 28 days), e.g. "Overdue — was due on day 28" / "Bill due on day 28" — never "day 31".
  - Urgency was scored against the same clamped day (tooltip and status agree).
- **Automated:** Partial (client/src/budgetModel.test.ts — due-day clamped in short months; tooltip string unasserted)

### DASH-056 - Paid toggle: optimistic, labelled, strip-connected
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; Rent unpaid bill.
- **Steps:**
  1. Click "☐ Paid" on Rent (aria "Mark Rent paid", title "Mark as paid").
  2. Click it again.
- **Expected:**
  1. Toggle flips to "☑ Paid" instantly (aria-pressed true, aria-label now "Mark Rent unpaid", title "Paid"); PUT `/budget/items/{id}/paid` `{isPaid:true}`; bills strip paid count increments and Rent stops counting as overdue.
  2. Reverts to unpaid with the mirror-image request.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — toggle paid + bills summary)

### DASH-057 - Removing a bill also un-pays it
- **Priority:** P1
- **Type:** Regression
- **Origin:** BillTracking invariant (dueDay null force-resets IsPaid, server and client)
- **Preconditions:** Utilities is a bill dueDay 20 AND marked paid.
- **Steps:**
  1. Open the due-day editor on Utilities; click ✕ (aria "Remove bill from Utilities", title "Remove bill").
  2. Re-add a bill (dueDay 20) to the same line.
- **Expected:**
  1. PUT `/budget/items/{id}/bill` `{dueDay: null}`; the Bill tag, Paid toggle and strip membership all vanish; the strip's paid count drops.
  2. The re-added bill starts UNPAID — the paid flag did not survive the clear (client `withItemBill` and the server handler both reset it).
- **Automated:** Partial (client/src/budgetModel.test.ts — clearing due day un-pays; tests/.../BillTrackingTests.cs — server reset; full UI round-trip unasserted)

### DASH-058 - Past-month unpaid bills read overdue; future months read upcoming
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (past-month unpaid → overdue, were upcoming)
- **Preconditions:** Today 2026-07-15; June 2026 budget has an unpaid bill dueDay 25; August 2026 budget has an unpaid bill dueDay 1.
- **Steps:**
  1. View June 2026 — read the bill row tag and strip.
  2. View August 2026.
- **Expected:**
  1. June's bill is rose "Bill" (overdue) with tooltip "Overdue — was due on day 25"; strip is rose with "· 1 overdue" — a month already gone with an unpaid bill is a genuinely missed bill.
  2. August's bill is the normal category-tinted tag (upcoming) — never overdue or due-soon for a future month; strip amber with no urgency fragment.
- **Automated:** Partial (client/src/budgetModel.test.ts — past unpaid = overdue, future month = upcoming; DashboardPage.test.tsx — overdue row flag)

### DASH-059 - Due-soon window boundaries
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Current month; today 2026-07-15; unpaid bills with dueDay 15, 22, 23 and 14.
- **Steps:**
  1. Read each bill's tag tone/tooltip and the strip counts.
- **Expected:**
  - Day 15 (today, diff 0) → due-soon (amber, "Due soon — day 15").
  - Day 22 (diff 7) → due-soon (inclusive boundary).
  - Day 23 (diff 8) → upcoming (normal tint).
  - Day 14 (diff −1) → overdue (rose).
  - Strip: "· 1 overdue" (due-soon count suppressed while overdue > 0).
- **Automated:** Yes (client/src/budgetModel.test.ts — bill-reminder classification incl. due-soon proximity)

### DASH-060 - Bill and paid failures share the rollback message
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** JUL26; block PUT `/budget/items/*/bill` and `/budget/items/*/paid`.
- **Steps:**
  1. Try adding a due day to Groceries.
  2. Try toggling Rent's Paid.
- **Expected:**
  - Both roll back their optimistic state (tag disappears / toggle reverts) and show exactly "Could not update that bill — reverted."
- **Automated:** No

## Savings group cards & fund lines

### DASH-061 - Savings card renders the fund layout below expenses
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26 (Savings group, Holiday line planned 150.00, spent 0, available 450.00).
- **Steps:**
  1. Read the Savings card and the Holiday row; hover the row.
- **Expected:**
  - Card sits below the Everyday spending panel; violet dot; header totals "€0.00 of €150.00".
  - Holiday row: violet funding bar; right column "€450.00 avail." (title "Available in this savings goal (rolled over from previous months)") over "€0.00 of €150.00" with the planned figure click-to-edit.
  - The fund layout has NO bill controls (no 📅/Bill/Paid) and NO ▲▼ reorder gutter; hover reveals only ✕ delete and "+ Add a savings goal" below.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — fund group renders rolled-over Available; affordance absences unasserted)

### DASH-062 - Funding a jar counts toward Allotted
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** JUL26 (remaining €1,080.00).
- **Steps:**
  1. Edit Holiday's planned from 150.00 to 300.00, blur.
- **Expected:**
  - Hero: Allotted rises to €2,070.00 and remaining falls to €930.00 instantly — a fund contribution is money given a job; the budget only balances once jars are funded.
  - PUT `/budget/items/{id}` `{plannedAmount: 300}`.
- **Automated:** Partial (client/src/budgetModel.test.ts — fund contribution counts as budgeted; tests/.../SavingsTests.cs — contributions count toward TotalPlanned/Remaining)

### DASH-063 - Adding a savings goal creates a line AND a backing jar
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** JUL26; dash-owner.
- **Steps:**
  1. Hover the Savings card; click "+ Add a savings goal" (aria "Add a savings goal to Savings").
  2. Type "Car" (placeholder "Add a savings goal (e.g. Car, Holiday, Christmas)…"), press Enter.
- **Expected:**
  - Temp row appears then reconciles; POST `/budget/categories/{savingsCatId}/items` `{name:"Car", plannedAmount:0}`; the reconciled row is a fund line (avail. €0.00).
  - A new jar "Car" (Goal kind, target 0) now exists — visible on /jars and (current month) the shelf. Renaming the line later does NOT rename the jar (jar semantics → jars file).
- **Automated:** Partial (tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs — AddBudgetItem to a Savings group persists a jar-backed line; tests/.../JarBudgetLinkTests.cs; the UI flow unasserted)

### DASH-064 - Negative available renders rose
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A savings line whose cumulative spend exceeds cumulative contributions (savingsAvailable < 0), e.g. Holiday planned 50.00 across months with 300.00 spent against it.
- **Steps:**
  1. Read the row's Available figure.
- **Expected:** "-€250.00 avail." rendered in rose (fund overdrawn); the funding bar still reflects this month's spent/planned only.
- **Automated:** No (the e2e mock fixture includes an overspent jar but only axe-asserts it)

### DASH-065 - Deleting a savings line leaves its jar alive
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** JUL26 current month; Holiday fund line + Holiday jar on the shelf.
- **Steps:**
  1. Hover the Holiday line; click ✕ (aria "Delete Holiday").
  2. Check the "Your jars" shelf and /jars.
- **Expected:**
  1. Line vanishes; DELETE `/budget/items/{id}`; Hero remaining rises by €150.00; Savings card may show "No savings goals yet — add one below." if it was the last line.
  2. The Holiday jar is untouched — still on the shelf and /jars with its balance (it will re-append to the NEXT created month; that behavior → file 07).
- **Automated:** Partial (tests/.../JarBudgetLinkTests.cs — jars re-append on later month creates; the UI delete + shelf persistence unasserted)

## Roles & access on the dashboard

### DASH-066 - Limited role: read-only structure plus the Paid toggle
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** dash-limited signed in; JUL26 with the Rent bill unpaid.
- **Steps:**
  1. Load `/`; inspect every surface; hover rows.
  2. Click "☐ Paid" on Rent.
- **Expected:**
  1. Warn-tone banner: "Limited access: you can record transactions, mark bills paid and run allocation." (what an admin keeps behind its (i) "About your access") Group and line names render as static text (no inputs); planned amounts are plain text (no click-to-edit); no ▲▼, ✕, 🗑, 📅, "+ Add" rows, "+ Add a line", "+ Add group" anywhere; the Bill tag is a static span (no due-day editor).
  2. The Paid toggle IS present and works (PUT `/budget/items/{id}/paid` succeeds — `SetBudgetItemPaidCommand` is `[AllowLimited]`); the strip updates.
- **Automated:** Partial (tests/.../AuthorizationBehaviourTests.cs — Limited runs only AllowLimited commands; client/src/pages/RoleGating.test.tsx covers Limited on other pages, not the dashboard chrome)

### DASH-067 - ReadOnly role: pure view
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** dash-readonly signed in; JUL26.
- **Steps:**
  1. Load `/`; inspect and hover everywhere.
- **Expected:**
  - Info-tone banner: "Read-only access: you can view everything, not change it." (the full explanation behind its (i) "About your access")
  - Everything DASH-066 hides is hidden, AND the Paid toggle is also absent (canEnterData false). Hero, strip, shelf and all figures render normally.
- **Automated:** Partial (client/src/pages/RoleGating.test.tsx — ReadOnly banner + hidden controls on other pages; dashboard rows unasserted)

### DASH-068 - Server rejects under-privileged budget commands with the role message
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** dash-limited's bearer token; JUL26 item id known.
- **Steps:**
  1. As Limited, send raw PUT `/api/budget/items/{id}` `{plannedAmount: 1}`.
  2. As ReadOnly, send raw PUT `/api/budget/items/{id}/paid` `{isPaid:true}`.
- **Expected:**
  1. 403 with "Your access level (Limited) does not permit this action." — nothing changes; a reload shows the old planned value.
  2. 403 "Your access level (ReadOnly) does not permit this action." — even the paid toggle is Owner/Admin/Limited only.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/AuthorizationBehaviourTests.cs — per-role command matrix)

### DASH-069 - Ownership scoping: another household's item ids are 403/404
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Two households (dash-owner's and a stranger's); a budget item id from the stranger's month.
- **Steps:**
  1. As dash-owner (an Admin+ role, so the role gate passes), send PUT `/api/budget/items/{strangerItemId}` `{plannedAmount: 1}`.
- **Expected:**
  - The request fails (403 ownership mismatch or 404 "Budget item {guid} was not found." depending on handler order) — never a 200; the stranger's budget is untouched. The dashboard never renders foreign data because GET `/budget/{y}/{m}` is OwnerId-scoped.
- **Automated:** Partial (tests/.../UpdateBudgetItemHandlerTests.cs + BudgetItemCrudHandlerTests.cs — ownership throws; no HTTP-level case)

### DASH-070 - Admin (non-owner) has full dashboard write parity
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** A second login with role Admin in dash-owner's household.
- **Steps:**
  1. As the Admin, perform one of each: planned edit, rename line, add line, add group, set bill, toggle paid, delete line, reorder groups, create a missing month.
- **Expected:** Every action succeeds identically to the Owner (canWrite = role ≤ Admin; no owner-only commands exist in this subsystem); no access banner is shown.
- **Automated:** No (RoleGating.test.tsx exercises roles 0/2/3 but not Admin=1)

### DASH-071 - Income lines carry a "Who earns this" picker in shared households
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Shared household (2+ active members), Admin+; a month with income lines.
- **Steps:**
  1. Read an income line in the Income card; open its "Who earns {line}" select.
  2. Pick a person; then pick "Whole household".
- **Expected:** The quiet select under the line name (aria-label `Who earns {name}`) lists "Whole household" + every active member. Picking one optimistically updates and `PUT /budget/items/{id}/member` persists `BudgetItem.MemberId` (FK → HouseholdMembers, SetNull); "Whole household" clears with `memberId: null`. A failed PUT rolls back to the last saved value with "Could not update who earns that income — reverted." Solo households and expense/savings lines never show the picker (the server also rejects non-income targets with "Only income lines can be assigned to a person.", and foreign/archived members 404). Read-only/Limited users see a static name instead. Add-a-line can attribute at creation (`AddBudgetItemRequest.MemberId`). This attribution is the budget-side half of per-person income — the allocation engine consumes it in the switchover PR.
- **Automated:** Full (client `DashboardPage.test.tsx` picker cases; backend `BudgetItemMemberTests`; real-SQL `BudgetItemMemberForeignKeyTests`)

### DASH-072 - Month copy rolls income attribution forward, dropping archived people
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A month with attributed income lines; one attributed member archived since.
- **Steps:**
  1. Create the next month with "copy from previous".
- **Expected:** Every income line's `MemberId` carries into the new month EXCEPT lines attributed to an archived member, which copy as whole-household (null) — never crediting someone who left. The one-time `AddBudgetItemMember` migration also backfills history conservatively: an income line is attributed only when exactly ONE active member's name prefixes the line name (the importer's "{Member} — Salary" shape); solo "Take-home Pay" and ambiguous prefixes stay null.
- **Automated:** Full (backend `BudgetItemMemberTests.MonthCopy_CarriesAttribution_ButDropsArchivedMembers`; the migration applies in the real-SQL fixture)

---

## Money in another currency (W08)

### DASH-080 - Rows waiting for their budget-currency amount are left out of the month and a notice says so
- **Priority:** P1
- **Type:** Edge
- **Origin:** Re-review F5 / W08 (rules 42–44). Before W08 the rows were "awaiting an exchange rate"; now nothing converts them and the user enters the amount.
- **Preconditions:** dash-owner, July 2026 month; Groceries (Food) planned 400.00 with €150.00 spent; two imported GBP rows dated in July, both assigned to Groceries and waiting (`fxPending`). A second month (June) with no waiting rows.
- **Steps:**
  1. Open `/` on July 2026; read the notice, Groceries' actual and the Hero.
  2. Follow the notice's link; enter the EUR amount for one row (e.g. 20.00); return to `/`.
  3. Enter the other row's amount; return to `/`. Switch to June.
- **Expected:** Step 1: an amber `role="status"` notice under the Hero reads **"2 transactions in another currency are waiting for their amount in EUR and aren’t counted until it’s entered."** with the link **"Enter them on Transactions"** (`/transactions`); Groceries still reads €150.00 spent and Remaining/leftovers ignore both rows (`fxPendingCount: 2` on the month; every sum excludes them). Step 2: Groceries reads €170.00; the notice reads "1 transaction in another currency is waiting for its amount in EUR and isn’t counted until it’s entered." with "Enter it on Transactions". Step 3: no notice; June never shows one. The count covers every waiting row dated in the month (assigned or not), except a row on a private account that is not on a budget line (rule P56: it counts nowhere for the household anyway).
- **Automated:** Partial (client `DashboardPage.catalog.test.tsx` — "shows the pending-FX notice when the month reports pending rows", "renders no pending-FX notice when nothing is pending"; backend FxPendingAggregatesTests — `BudgetActuals_ExcludePendingRows_AndReportTheCount`, `A_confirmed_amount_counts_on_its_line_and_leaves_the_waiting_count`)

