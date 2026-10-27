# Month lifecycle & rollover (create blank / copy / template, navigation, first-ever, duplicates)

**ID prefix:** BUDG | **Scope:** Everything about a budget MONTH as an object rather than what is rendered inside it: creating the viewed month from the dashboard not-found state via **"Start {Month}"** (continues the most-recent earlier month; the only choice once one exists), or, with no earlier month, **"Start a blank budget"** or (first budget only) an **"Or start from a template"** card; the wrap-up of the month before shown on that card and the **"From {Month}"** carry-over at the top of Income (BUDG-063 to BUDG-068) (`POST /api/budget {year, month, copyFromPrevious, templateKey}` → `CreateBudgetMonthCommandHandler`); the exact semantics a copy carries (planned amounts flat vs. jar lines re-seeded from the accrual calculator, `DueDay` carried while `IsPaid` resets, `ExcludeFromAllocation` carried, category `DisplayOrder`/`Kind`, `SavingsId` identity, `BaseCurrency` = the budget currency, archived-jar lines dropped, dangling `SavingsId` lines kept, actuals reset because they are always tx-derived); the "every active jar takes part" append step and the as-of (strictly-before) jar-seed balance used when back-filling an earlier month; template precedence and each built-in template's shape; the over-budgeted **empty** month a jar-owning household is born into (PR #172); month navigation via the TopBar `‹ {Month Year} ›` navigator (`MonthContext`, unbounded, clear-month-before-fetch, year-boundary roll, moves every month-scoped screen together); viewing/creating/editing past and future months; the first-ever month (no copy source); duplicate-month and concurrent-create friendly-400 recovery; and the absence of any month-delete affordance. | **Out of scope:** what the loaded month renders and how its groups/lines/bills/hero/jars-shelf/planned-editing behave → **06-dashboard-budget-view.md** (that file owns the four hero footnote states, the bills strip, the jars shelf, group/line CRUD, inline planned edits and dashboard role gating); jar accrual/recurrence maths, jar CRUD, the Jars page and the allocation engine that consumes `ExcludeFromAllocation` → **jars & allocation file** (09); the transactions/transfers that produce the actuals a copy resets → **transactions & transfers file** (08); the onboarding "Create your first month" checklist step, welcome dialog and tour → **05-onboarding.md**; deep role matrix across all pages and session/auth expiry → **03-session-auth-lifecycle.md** + households/roles file; sample-budget opt-in at sign-up (which pre-creates the first month) → **02-registration-login.md** / **05-onboarding.md**; GA event payloads (`budgetMonthCreated{source}`, `monthNavigated{direction}`) → analytics file; dark-mode/responsive/a11y sweeps → cross-cutting file. **Do not test for:** a delete-month button, route or `DELETE /api/budget/{year}/{month}` endpoint (none exists — only category/item delete); a min/max clamp on the TopBar month navigator (there is none — it reaches any year); server validation text surfacing in the dashboard (create failures are swallowed into the fixed string "Could not create that budget.").

**Test data setup:** Local stack (API :5099, `ASPNETCORE_ENVIRONMENT=Development`) or staging (staging.allotjar.com). **Assumed "today" = 2026-07-15**, so **July 2026 is the current month**, June 2026 is last month, August 2026 is next month. Locale/format default **en-GB comma-dot** (money renders `€1,234.56`), currency **EUR** (noun "euro"). Logins (passwords random `Aa1-<uuid>` — HIBP rejects fixed common ones): **budg-owner@example.test** (Owner of household "Rollover"); **budg-limited@example.test** (role Limited) and **budg-readonly@example.test** (role ReadOnly) as members of the same household. Canonical copy source **JUN26** (June 2026, owned by budg-owner) unless a case builds its own: Income group **"Income"** (line **Salary** planned 2,500.00); expense group **"Housing"** (Rent 1,000.00 `dueDay 1` **IsPaid=true**; Council Tax 150.00 `dueDay 28` unpaid); expense group **"Food"** (Groceries 400.00); an importer-created expense category **"Personal Savings"** with `ExcludeFromAllocation=true` (one line, planned 300.00); savings group **"Savings"** with fund line **Holiday** (backed by jar). Jars owned by the household: **Holiday** (Kind Goal, Accrual TargetByDate, target 1,200.00, due **1 July 2027**, opening 0, active — scheduled, so a month plans `(1,200.00 − balance entering it)` split in whole cents over its contribution months up to June 2027 (twelve from July 2026), remainder in the final month — rules 12, 13, 35, 36); **Car Fund** (a legacy jar with no deadline and no monthly amount → Unscheduled, rule 17; its line copies flat); **Old Boiler** (archived). "Jar-less household" cases use **budg-solo@example.test** with zero jars/months. A month with `TotalIncome = 0` shows the plan-your-income hero prompt and is NOT balanced (`IsBalanced = TotalIncome > 0 && RemainingToBudget == 0`, PR #172). Automation hint: `POST /api/budget` returns **200** (not 201) with the full recomputed `BudgetMonthDto`; there is no month-delete verb.

## Creating a month — blank budget

### BUDG-001 - Start a blank budget for a jar-less household lands on an empty month
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-solo signed in, zero jars, zero months, nobody with a Default income (a person with one seeds a line — BUDG-057); viewing July 2026 (no budget → not-found writer state).
- **Steps:**
  1. On `/`, in the "No budget for July 2026 yet." card, click **"Start a blank budget"**.
- **Expected:**
  - `POST /api/budget` body `{year:2026, month:7, copyFromPrevious:false}`; 200 with the new month.
  - The page swaps to the loaded month: exactly one **Income** group (Kind Income, at top), no expense/savings groups.
  - Hero eyebrow "Remaining to budget" = `€0.00`; footnote is the neutral **"Plan your income, then give every euro a job"** (empty state), NOT the gold "Every euro has a job" badge.
  - No Copy button was needed (first-ever month); no error strip.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — empty month prompts for income; client/e2e-journey/register.spec.ts — starting blank lands on a real empty month with Income group only; tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — blank = empty income group only)

### BUDG-002 - Blank month keeps exactly one Income group at DisplayOrder 0
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** budg-solo; create a blank month (BUDG-001).
- **Steps:**
  1. Inspect the created month's categories (UI render and/or GET `/api/budget/2026/7`).
- **Expected:**
  - One category: Name "Income", Kind Income, DisplayOrder 0, no items.
  - No "Savings" group is created (household owns no jars — the append step adds nothing).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — blank = empty income group only)

### BUDG-003 - Once an earlier month exists, a new month only continues it
- **Priority:** P1
- **Type:** Happy
- **Origin:** Christopher, 27 October 2026 ("where did the jars go, where's the continuation?"): a blank or template start dropped the household's plan.
- **Preconditions:** budg-owner; JUL26 exists; viewing August 2026 (no budget).
- **Steps:**
  1. On the not-found card observe the buttons.
- **Expected:**
  - One button, **"Start August"**; no **"Start a blank budget"**, no template grid, no jar note.
  - Clicking it sends `copyFromPrevious:true` (the server still accepts a blank or template POST; the screen no longer offers one).
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx, client/src/pages/DashboardPage.carry.test.tsx)

### BUDG-004 - Blank create is disabled while a create is in flight (double-click guard)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; not-found writer state; throttle network so the POST is observable.
- **Steps:**
  1. Click **"Start a blank budget"** and immediately click it again.
- **Expected:**
  - Both **"Start a blank budget"** and any **"Start {Month}"** / template buttons become `disabled` (opacity-50) for the duration of the POST (`creating` flag); only one `POST /api/budget` is sent; exactly one month is created.
- **Automated:** No

## Creating a month — copy the previous month

### BUDG-005 - Copy previous reproduces structure and planned amounts, resets actuals
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 is the fixture; viewing July 2026 with no budget; JUN26 has real spending (Groceries has an assigned transaction).
- **Steps:**
  1. On the July 2026 not-found card click **"Start July"**.
- **Expected:**
  - `POST /api/budget {year:2026, month:7, copyFromPrevious:true}`; 200.
  - New month has the same groups in the same order (Income → Housing → Food → Personal Savings → Savings) and the same line names.
  - Planned amounts copy flat for non-jar lines (Salary 2,500.00, Rent 1,000.00, Council Tax 150.00, Groceries 400.00, Personal Savings 300.00).
  - Every line's actual is 0 (actuals are tx-derived; July has no transactions yet) — Groceries shows 400.00 planned / 0 spent even though June had spend.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copy-from-previous copies structure+planned and resets actuals)

### BUDG-006 - Start continues the actual most-recent prior month, not literally last calendar month
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (copy names the real source `prevBudget`)
- **Preconditions:** budg-owner; only APR26 and JUN26 exist (May was skipped); viewing July 2026 (no budget).
- **Steps:**
  1. Click **"Start July"** on the July not-found card.
- **Expected:**
  - July is built from JUN26's plan (the most-recent month strictly before July), never from a hardcoded "last month".
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — Start continues on an empty month; the source month is the handler's, tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs)

### BUDG-007 - Copy source is the most-recent month strictly BEFORE the target (back-fill picks an earlier source)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-owner; APR26 and JUN26 exist; viewing **May 2026** (a gap month, no budget).
- **Steps:**
  1. Click **"Start May"** on the May 2026 not-found card.
- **Expected:**
  - May is built from APR26's plan (June is later than May, so it is not the source).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copies only the caller's own previous month; handler picks the most-recent strictly-earlier month)

### BUDG-008 - Copy carries the bill due day but resets Paid to unpaid
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 / gotcha: DueDay carries on copy, IsPaid resets
- **Preconditions:** budg-owner; JUN26 has Rent (dueDay 1, **IsPaid=true**) and Council Tax (dueDay 28, unpaid); viewing July 2026 (no budget).
- **Steps:**
  1. Click **"Start July"**.
- **Expected:**
  - July's Rent keeps `dueDay 1` and July's Council Tax keeps `dueDay 28` (both still tagged "Bill").
  - Both lines are **unpaid** in July — Rent's paid state did NOT copy (a new month starts unpaid); the bills strip reads "0/2 paid".
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs — CreateBudgetMonth carries the due day but resets paid)

### BUDG-009 - Copy carries a day-31 due day unchanged (clamping is display-only)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** budg-owner; JUN26 has a bill line "Rent" with `dueDay 31`; copy JUN26 into **February 2027**? (build a source first). Simpler: JAN27 has a `dueDay 31` bill; viewing February 2027 (no budget).
- **Steps:**
  1. Click **"Start February"** to create February 2027.
- **Expected:**
  - The copied line stores `dueDay 31` verbatim (the stored value is not truncated to 28).
  - The February tag/tooltip DISPLAY clamps to day 28 (display concern owned by 06); the persisted `DueDay` is still 31 and re-copies as 31.
- **Automated:** No

### BUDG-010 - Copy carries the ExcludeFromAllocation flag on categories
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 (copy dropped `ExcludeFromAllocation` → excluded category folded back into the allocation pool)
- **Preconditions:** budg-owner; JUN26 has the importer-created "Personal Savings" category with `ExcludeFromAllocation=true`; viewing July 2026 (no budget).
- **Steps:**
  1. Copy JUN26 into July 2026.
  2. Inspect the copied "Personal Savings" category (GET the month, or run an allocation preview for July).
- **Expected:**
  - The copied "Personal Savings" category still has `ExcludeFromAllocation=true`.
  - An allocation preview for July excludes it from the shared-obligation total exactly as June did — the member split is not corrupted by re-folding it in.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copy preserves ExcludeFromAllocation; Application/AllocationTests.cs — preview excludes flagged categories)

### BUDG-011 - Every new month takes the budget currency, whichever way it is created
- **Priority:** P2
- **Type:** Happy
- **Origin:** W08 (rule 85). Months used to inherit the previous month's `BaseCurrency` (or EUR for a first month) while accounts took the sign-up currency.
- **Preconditions:** budg-owner; JUN26 `BaseCurrency = EUR` (the earliest month); viewing July 2026 (no budget). A second, fresh household registered with GBP and no month yet.
- **Steps:**
  1. Copy JUN26 into July; then create May 2026 blank (a month before the first one).
  2. In the fresh GBP household, **Start a blank budget** for July 2026.
- **Expected:**
  - Step 1: July and May both get `BaseCurrency = EUR` — the budget currency, which is the earliest month's (`BudgetCurrency.ResolveAsync`), not the creating login's preference. Even if the owner's stored preference were something else, it is not consulted once a month exists.
  - Step 2: the first month adopts the owner's chosen currency, **GBP**; from then on the household's currency is locked (PREF-042/043). A member creating the household's first month gets the owner's currency, not their own.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — `Create_FirstMonth_AdoptsTheUsersPreferredCurrency`, `Create_AnyMonth_TakesTheBudgetCurrency_NotThePreference` [next month copied; a month backfilled before the first])

### BUDG-012 - Copy preserves category DisplayOrder and per-kind ordering
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 groups ordered Income, then Housing before Food (DisplayOrder 0,1), then Personal Savings, then Savings.
- **Steps:**
  1. Copy JUN26 into July; observe group order top-to-bottom.
- **Expected:**
  - July renders Income first, then Housing, then Food (Housing before Food, matching June's DisplayOrder), then the savings-kind group(s) last — copy carries each category's DisplayOrder and Kind.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copies structure incl. order; render order not asserted)

### BUDG-013 - Copy with copyFromPrevious=true but no earlier month falls back to blank
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-solo, no months at all; raw `POST /api/budget {year:2026, month:7, copyFromPrevious:true}` (the UI hides the Copy button here, so this is the API contract).
- **Steps:**
  1. Send the POST with `copyFromPrevious:true` and no template.
- **Expected:**
  - 200; because no strictly-earlier month exists, the handler falls through to blank → one Income group only (plus jar-append lines if the household owned jars; budg-solo owns none).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copy w/o prior falls back to blank)

### BUDG-014 - Copy only ever reads the caller's own previous month
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Two households; budg-owner's JUN26 and an unrelated owner's June 2026 both exist; budg-owner creates July.
- **Steps:**
  1. As budg-owner, copy into July 2026.
- **Expected:**
  - The copy source is budg-owner's JUN26 only (scoped by `OwnerId`); the other household's month is never read or copied.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copies only the caller's own previous month)

## Copy semantics: jars, archived lines, dangling links

### BUDG-015 - Copy re-seeds a seedable jar line from the accrual calculator, not the previous planned amount
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26's "Holiday" fund line (jar Holiday: target 1,200.00, due 1 July 2027, opening 0) was planned 100.00 in June, and June contributed 100.00 (so balance-as-of-July = 100.00); viewing July 2026 (no budget).
- **Steps:**
  1. Copy JUN26 into July.
- **Expected:**
  - The July Holiday line is re-planned to `(1,200.00 − 100.00)` over the twelve contribution months Jul 2026→Jun 2027 = **91.66** (rule 35 floors to the cent; the remainder lands in June 2027), NOT copied flat at June's 100.00 — because the jar has a schedule (rule 17). A hand-edited June figure is not carried either: the `budget-lifecycle.spec.ts` journey raises the current month's line to 200.00 and sees the next month re-planned over the remaining months from the balance projected through that saved line (HANDOVER P27).
  - Its `SavingsId` is unchanged (same jar identity, so the balance rolls over).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarsTests.cs — month-create plans a scheduled jar's line; Application/SavingsTests.cs — CreateBudgetMonth copies FundId; client/e2e-journey/budget-lifecycle.spec.ts — copy-from-previous re-plans the scheduled jar)

### BUDG-016 - Copy carries an unscheduled jar line's planned amount flat; a scheduled jar is re-planned
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-owner; JUN26 has a "Car Fund" line backed by jar Car Fund (**no deadline and no monthly amount** — Unscheduled, rule 17), planned 50.00, and a "Holiday" line backed by a jar due 1 January 2027 (target 1,200, balance 300 on 30 June); viewing July 2026 (no budget).
- **Steps:**
  1. Copy JUN26 into July.
- **Expected:**
  - The July Car Fund line copies flat at 50.00 (nothing to plan from ⇒ no recompute); `SavingsId` preserved.
  - The July Holiday line is re-planned from the jar's balance entering July: (1,200 − 300) over the six contribution months Jul→Dec = **150.00** (rules 12/13, exact split); an ongoing fixed-monthly jar seeds its fixed amount (rule 16). Seeding a later month projects through the saved plans of the months in between (HANDOVER P27).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarsTests.cs — keeps the copied amount when the jar has no plan; CreateBudgetMonthTests — backfills the seeded amount; JarPlannerTests — later-month projection, rule 16 seeding)

### BUDG-017 - Copy drops a line that funds an archived or completed jar
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 (copy re-funded archived jars forever); W04 adds completed goals (rule 55).
- **Preconditions:** budg-owner; JUN26 has an "Old Boiler" fund line backed by an **archived** jar and a "Sofa" line backed by a **completed** goal; viewing July 2026 (no budget).
- **Steps:**
  1. Copy JUN26 into July.
- **Expected:**
  - The July month has NO "Old Boiler" and NO "Sofa" line — lines whose `SavingsId` is an archived or completed jar id are skipped on copy (both stop future contributions; `JarSchedule.IsPlanning`).
  - All other jar lines still carry.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copy skips lines funding archived or completed jars)

### BUDG-018 - Copy keeps a dangling SavingsId line (not treated as archived)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 (archived-skip must key on `archivedJarIds`, not `!activeJars.ContainsKey`)
- **Preconditions:** InMemory/test-only: JUN26 has a fund line whose `SavingsId` points at NO jar row (dangling — production's enforced FK prevents this in prod, so this is an InMemory-layer guarantee); viewing July 2026.
- **Steps:**
  1. Copy JUN26 into July.
- **Expected:**
  - The dangling-SavingsId line IS copied (only truly-archived ids are dropped) — a missing jar row must not be mistaken for an archived one.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/SavingsTests.cs / CreateBudgetMonthTests.cs — dangling SavingsId still copies)

### BUDG-019 - Copy preserves SavingsId so the jar balance rolls across months
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 Holiday line linked to jar Holiday; copy into July.
- **Steps:**
  1. After copying, compare July's Holiday line `SavingsId` with June's.
- **Expected:**
  - Identical `SavingsId` — the fund line in every month is the SAME jar entity, which is what makes the rolled-over "Available" balance accumulate (persisted `SavingsId` is an enforced FK to `Jars.Id`).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/SavingsTests.cs — copies FundId so the fund is the same entity across months; tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs — persisted SavingsId points at a real jar)

## Creating a month — from a template

### BUDG-020 - Create from the Essentials template builds its groups and lines at zero planned
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-solo (no jars/months); viewing July 2026; `/api/budget/templates` loaded.
- **Steps:**
  1. In the "Or start from a template" grid, click the **Essentials** card (aria-label "Start from the Essentials template").
- **Expected:**
  - `POST /api/budget {year:2026, month:7, copyFromPrevious:false, templateKey:"essentials"}`; 200.
  - Month has groups Income (Take-home Pay), Housing (Rent / Mortgage, Utilities, Internet & Phone), Food (Groceries, Restaurants), Transport (Fuel, Public Transport, Car Insurance), Lifestyle (Subscriptions, Clothing, Personal Care), Savings (Emergency Fund) — every line planned 0.00.
  - Hero remaining `€0.00` with the empty/plan-your-income footnote (income planned is 0).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BudgetTemplatesTests.cs — template builds groups+lines at zero planned; client/src/pages/DashboardPage.test.tsx — quick-start templates offered + create-from-template)

### BUDG-021 - Template card shows the correct groups·lines count and aria-label
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** budg-owner; not-found writer state; templates loaded.
- **Steps:**
  1. Read each of the three template cards.
- **Expected:**
  - **Essentials**: "A clean starting point covering the bills most households share." · "6 groups · 13 lines".
  - **Student**: "A lightweight budget for term-time living costs." · "5 groups · 10 lines".
  - **Family**: "Two incomes, the kids, and sinking funds for the big stuff." · "7 groups · 20 lines".
  - Each card's aria-label is "Start from the {name} template".
- **Automated:** No

### BUDG-022 - Each template Savings line mints a fresh backing jar
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** budg-solo, no jars; create July 2026 from **Family** (Savings group: Emergency Fund, Holiday, Christmas).
- **Steps:**
  1. Create the month from the Family template.
  2. Check the household's jars (Jars page or GET `/api/jars`).
- **Expected:**
  - Three new jars exist (Emergency Fund, Holiday, Christmas), each Kind Goal / Accrual TargetByDate / target 0, each linked as the `SavingsId` of its budget line (enforced FK).
  - Creating a Family month again next period mints ANOTHER set (duplicate-name jars) — templates always mint (known deferred behavior).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — CreateMonth-from-template backs every savings line with a jar; tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs — [Theory] essentials/student/family persist jar-backed savings lines)

### BUDG-023 - Template key takes precedence over copyFromPrevious
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-owner; JUN26 exists; raw `POST /api/budget {year:2026, month:7, copyFromPrevious:true, templateKey:"student"}`.
- **Steps:**
  1. Send the POST with both a template key and copyFromPrevious true.
- **Expected:**
  - The template wins: July is built from Student, NOT copied from JUN26 (precedence templateKey > copyFromPrevious > blank).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BudgetTemplatesTests.cs — template wins over copy-from-previous)

### BUDG-024 - Template key is matched case-insensitively
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** budg-owner; raw `POST /api/budget {year:2026, month:7, copyFromPrevious:false, templateKey:"ESSENTIALS"}`.
- **Steps:**
  1. Send the POST with an upper-cased key.
- **Expected:**
  - 200; the Essentials template is found (`BudgetTemplates.Find` is `OrdinalIgnoreCase`).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTemplatesTests.cs — built-in catalogue lookup; explicit case-insensitivity assertion not confirmed)

### BUDG-025 - Unknown template key is rejected with a specific 400
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** budg-owner; raw `POST /api/budget {year:2026, month:7, copyFromPrevious:false, templateKey:"deluxe"}`.
- **Steps:**
  1. Send the POST with a non-existent key.
- **Expected:**
  - 400 `{title:"Validation failed", errors:{TemplateKey:["Unknown budget template 'deluxe'."]}}`; no month created.
  - Via the UI this can't happen (only real keys are sent); if it did, the dashboard would show the generic "Could not create that budget." strip.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BudgetTemplatesTests.cs — unknown template throws)

### BUDG-026 - Empty / whitespace template key is treated as "no template"
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** budg-owner; JUN26 exists; raw `POST /api/budget {year:2026, month:7, copyFromPrevious:true, templateKey:"   "}`.
- **Steps:**
  1. Send the POST with a whitespace-only template key.
- **Expected:**
  - Whitespace key is ignored (`Find` returns null but no "unknown template" error is thrown); the request falls through to copy-from-previous → July is copied from JUN26.
- **Automated:** No

### BUDG-027 - Template grid is hidden when the templates fetch fails
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** budg-owner; not-found writer state; `/api/budget/templates` blocked/erroring.
- **Steps:**
  1. Load the not-found create card with templates unavailable.
- **Expected:**
  - The "Or start from a template" section is absent (templates state stays `[]`); the Start / blank buttons still render and work.
- **Automated:** No

## Jar-driven creation & the over-budgeted empty month (#172)

### BUDG-028 - A blank month for a jar-owning household is born OVER-BUDGETED, not empty
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #172 (empty ≠ balanced; jar-owning blank month lands over-budgeted via appended accrual lines)
- **Preconditions:** budg-owner owns active jar Holiday (target 1,200.00, due 1 July 2027, balance 0); NO month exists for July 2026; viewing July.
- **Steps:**
  1. Click **"Start a blank budget"**.
- **Expected:**
  - The month is NOT the neutral empty state: the append step adds a "Savings" group with a Holiday line planned `1,200.00` over the twelve contribution months to June 2027 `= 100.00` (income 0, planned > 0).
  - Hero: Income `€0.00`, Allotted `€100.00`, Remaining `-€100.00`, rose footnote **"€100.00 over-budgeted — trim a line"** — NOT "Plan your income…", NOT the gold badge.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — blank creates a Savings group for existing jars; Domain/RemainingToBudgetTests.cs + client budgetModel.test.ts — IsBalanced requires income, #172; the combined "blank+jars ⇒ over-budgeted" hero string is not asserted end-to-end)

### BUDG-029 - No jar-append note on the not-found card
- **Priority:** P3
- **Type:** Regression
- **Origin:** 27 October 2026: the note ("Your 2 existing jars are added to any new budget automatically…") explained templates against jars; a household with history no longer sees templates, and jars always carry on, so the card says nothing about them.
- **Preconditions:** budg-owner owns 2 active jars; not-found writer state.
- **Expected:**
  - No jar note on the card, with or without an earlier month. Creating the month still appends each jar's line (BUDG-030).
- **Automated:** Yes (client/e2e-journey/budget-lifecycle.spec.ts)

### BUDG-030 - Every create path appends a line for each active jar not already represented, alphabetically
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** budg-owner owns active jars **Boiler** and **Holiday**; create July 2026 from the **Student** template (whose Savings group is "Rainy Day Fund", backed by its own new jar — so neither existing jar is represented).
- **Steps:**
  1. Create July from Student.
  2. Inspect the Savings group lines.
- **Expected:**
  - The Savings group gains appended lines for Boiler and Holiday (case-insensitive alphabetical order), each planned at its accrual requirement, in addition to the template's Rainy Day Fund line.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — copy/template/blank append lines for jars the month lacks)

### BUDG-031 - Append creates a "Savings" group when the month has none
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner owns active jar Holiday; create a **blank** July (blank makes only an Income group).
- **Steps:**
  1. Create blank July; inspect groups.
- **Expected:**
  - A new category named **"Savings"** (Kind Savings) is created to hold the appended Holiday line (`SavingsLines.AppendJarLine`).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — blank creates a Savings group for existing jars)

### BUDG-032 - Archived and completed jars are excluded from the append step
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-owner owns active Holiday + archived Old Boiler + completed Sofa; create a blank July.
- **Steps:**
  1. Inspect the appended savings lines.
- **Expected:**
  - Only Holiday is appended; the archived Old Boiler and the completed Sofa get no line (only jars for which `JarSchedule.IsPlanning` holds — neither archived nor completed — are in `activeJars`, W04).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — skips archived jars)

### BUDG-033 - Another household's jars never seed this household's month
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Two households each with jars; budg-owner creates a blank July.
- **Steps:**
  1. Create the month as budg-owner; inspect appended lines.
- **Expected:**
  - Only budg-owner's own active jars are appended (jar query scoped by `OwnerId`); the other household's jars are invisible.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — skips other owners' jars)

### BUDG-034 - A jar's line cannot be deleted from a month: the ✕ offers skip or archive (W04, rule 60)
- **Priority:** P0
- **Type:** Happy / Negative
- **Origin:** W04 replaces the old "delete the line, it re-appears next month" behaviour, which silently undid what the user did.
- **Preconditions:** budg-owner on the current month; Holiday's savings line plans 150, two later months exist.
- **Steps:**
  1. Hover the Holiday row and click **✕** (aria "Remove Holiday this month", title "Skip this month's contribution, or archive the jar"). 2. Send `DELETE /api/budget/items/{holidayLineId}` directly.
- **Expected:**
  - 1: no optimistic removal and no DELETE. A sheet dialog "Skip Holiday this month" (restyle PR 18; why the line is a jar's monthly contribution and can't just be deleted sits behind its title's (i) "About skipping a month") loads `GET /budget/items/{id}/skip-preview` and shows the server's preview ("Skipping September 2026 spreads this month's €150.00 over the months that are left:" with each later month's amount — the same planner that will replant them, rule 61), in a compact panel, then offers Cancel and the one primary **Skip this month** (BUDG-060), with the quiet **Archive jar** at the footer's left (BUDG-061).
  - 2: 400 "Holiday is a jar's monthly contribution. Skip this month's contribution, or archive the jar to stop future ones."; the line and the jar are untouched.
- **Automated:** Yes (DashboardPage.skip.test.tsx — BUDG-034; CCategoriesLinesCoverageTests `DeleteSavingsLine_IsRefused_TheLineAndItsJarStay`; JarLifecycleW04Tests `Rule60_AJarsLine_CannotBeDeletedFromAMonth_TheChoiceIsSkipOrArchive`; jar-lifecycle journey)

## As-of jar seeding & back-filling earlier months

### BUDG-035 - Seeding uses the balance as of the created month (contributions strictly BEFORE it)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner; jar Holiday target 1,200.00, due 1 July 2027, opening 0; MAY26 and JUN26 each contributed 100.00 to Holiday (balance = 200 by end of June); viewing July 2026 (no budget).
- **Steps:**
  1. Copy JUN26 into July (or start July blank).
- **Expected:**
  - July's Holiday line is seeded from balance-as-of-July (= 200.00 from May+June): `(1,200.00 − 200.00)` over the twelve contribution months Jul 2026→Jun 2027 `= 83.33`.
  - Only months strictly before July count toward the as-of balance.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs / JarsTests.cs — backfilled month seeds jar from as-of-that-month balance, not all-time)

### BUDG-036 - Back-filling an EARLIER month is not zeroed out by later months' savings
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 (jar seed used all-time balance → later months zeroed the back-filled seed)
- **Preconditions:** budg-owner; jar Holiday target 1,200.00, due 1 July 2027, opening 0; JUL26 and AUG26 exist and together already contributed 1,200.00 (jar all-time balance = fully funded); NO budget for **April 2026**; viewing April via the TopBar.
- **Steps:**
  1. On the April 2026 not-found card, click **"Start a blank budget"** (or copy an earlier month).
- **Expected:**
  - April's Holiday line is seeded from the as-of-April balance (only months before April count = 0.00), giving `1,200.00` over the fifteen contribution months Apr 2026→Jun 2027 `= 80.00` — it is NOT seeded to 0 just because later months (July/Aug) already filled the jar.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — backfilled month seeds from as-of-that-month balance)

### BUDG-037 - Seeding folds the jar's actual balance (its allocation as of the day before the month) into the plan
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; jar Holiday target 1,200.00 due **1 July 2027**, **300.00 allocated on 1 June 2026**, no prior-month contributions; viewing July 2026 (no budget).
- **Steps:**
  1. Start July blank.
- **Expected:**
  - Holiday line seeded from the ledger balance as of 30 June 2026 (300.00, rule 48): `(1,200.00 − 300.00)` over the twelve contribution months Jul 2026→Jun 2027 = **75.00** (rules 12, 13, 35). A jar with no deadline and no monthly amount would not be seeded at all (rule 17).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BMonthLifecycleCoverageTests.cs — `Create_SeedsAppendedJarLine_FoldingInTheJarsAllocatedBalance`; Domain/JarScheduleTests.cs — rule 14)

## Month navigation (TopBar ‹ ›)

### BUDG-038 - The month navigator moves the app-wide viewed month and its label
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner; on `/` viewing July 2026 (label "July 2026").
- **Steps:**
  1. Click **‹** (aria-label "Previous month").
  2. Click **›** (aria-label "Next month") twice.
- **Expected:**
  - After ‹: TopBar reads "June 2026" and the dashboard fetches `GET /api/budget/2026/6`.
  - After two ›: "August 2026" (July → August), fetching each month in turn; label always matches the fetched month.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — month nav offers Copy on a new month; label/arrow aria-labels exercised via a11y scans)

### BUDG-039 - Navigating past December rolls into the next year (and January ‹ into the previous year)
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** budg-owner; navigate the TopBar to December 2026.
- **Steps:**
  1. From "December 2026" click **›**.
  2. From the resulting month click **‹** twice.
- **Expected:**
  - › from December 2026 → **"January 2027"** (month wraps 12→1, year +1).
  - ‹ from January 2027 → December 2026 → November 2026 (year decrements when wrapping 1→12).
- **Automated:** No

### BUDG-040 - Navigating to a future month with no budget shows the create state
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** budg-owner; JUL26 exists; no budget for December 2026.
- **Steps:**
  1. Use **›** to reach December 2026.
- **Expected:**
  - The not-found writer card renders: "No budget for December 2026 yet." with **"Start December"** only (JUL26 exists, so it continues) — future months are freely creatable; no wrap-up yet (November has not begun, BUDG-064).
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — empty future month offers create; specific month label not asserted)

### BUDG-041 - Switching months clears the previous month before fetching (no stale render)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (month VM cleared before fetch so stale data never renders under the new label)
- **Preconditions:** budg-owner; JUL26 and JUN26 both loaded with visibly different figures; throttle network (slow 3G).
- **Steps:**
  1. From July click **‹** to June and watch the content area during the fetch.
- **Expected:**
  - July's Hero/lines vanish immediately (replaced by "Loading your budget…"); at no frame do July's numbers show under the "June 2026" label; June appears only when its response lands.
- **Automated:** No

### BUDG-042 - The viewed month is shared across every month-scoped screen
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** budg-owner; on `/` viewing July 2026.
- **Steps:**
  1. Click **‹** to June 2026 on `/`.
  2. Navigate to `/transactions`, then `/reports`.
- **Expected:**
  - Transactions and Reports both open on June 2026 (the `MonthContext` state persists across route changes) — the navigator moves Budget, Transactions, Reports, People and Allocation together.
- **Automated:** No

### BUDG-043 - The navigator has no min/max clamp (reaches any year)
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** budg-owner; on `/`.
- **Steps:**
  1. Hold/click **‹** far back to 1999 (and **›** far forward to 2101).
- **Expected:**
  - The navigator reaches 1999 and 2101 without clamping; each renders the not-found state and issues a normal `GET` (which 404s cleanly — viewing far years is allowed).
- **Automated:** No

## Viewing & editing past and future months

### BUDG-044 - A past month with a budget is fully viewable and editable
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 exists; viewing June 2026 on `/`.
- **Steps:**
  1. Confirm the June month loads with its groups/lines.
  2. Edit a June line's planned amount (control behavior owned by 06 — here only the month-scoping matters).
- **Expected:**
  - June loads and its edits persist against `GET/PUT /api/budget/2026/6...`; editing June recomputes June's Remaining only and does not touch July.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — planned edit recomputes the loaded month; not asserted specifically for a past month)

### BUDG-045 - Editing a jar contribution in one month does not disturb another month's line
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; Holiday line exists in both JUN26 and JUL26 (same jar).
- **Steps:**
  1. Change June's Holiday planned amount.
  2. View July.
- **Expected:**
  - July's Holiday planned amount is unchanged by the June edit (each month stores its own line's planned); only the rolled-over "Available" balance (a derived, cross-month value owned by 06/jars) reflects the extra June contribution.
- **Automated:** No

### BUDG-046 - Non-writers see the read-only not-found message on a month-less month
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** budg-limited (or budg-readonly) signed in; viewing a month with no budget.
- **Steps:**
  1. Load the month-less month.
- **Expected:**
  - "No budget for {Month} {Year} yet." + "Ask an admin or the owner to set this month up." — no Start/blank/template controls (create is Admin+).
- **Automated:** No

### BUDG-047 - A Limited/ReadOnly login cannot create a month via the API
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** budg-limited signed in; raw `POST /api/budget {year:2026, month:9, copyFromPrevious:false}`.
- **Steps:**
  1. Send the create POST as a Limited login.
- **Expected:**
  - 403 "Your access level (Limited) does not permit this action." — `CreateBudgetMonthCommand` is a plain command (not `[AllowLimited]`), so only Admin/Owner may run it; ReadOnly likewise blocked.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AuthorizationBehaviourTests.cs — ReadOnly blocked from commands; Limited only AllowLimited; create not decorated)

## Concurrent creation, duplicates & validation

### BUDG-048 - Creating a month that already exists returns a friendly 400
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** budg-owner; JUL26 already exists; raw `POST /api/budget {year:2026, month:7, copyFromPrevious:false}`.
- **Steps:**
  1. Send a create for the existing month.
- **Expected:**
  - 400 `{title:"Validation failed", errors:{Month:["A budget for 2026-07 already exists."]}}` (pre-check) — no second month, no 500.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — duplicate month throws)

### BUDG-049 - Concurrent create of the same month recovers as the same friendly 400, never a 500
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 (concurrent create tripped the unique index → raw 500)
- **Preconditions:** budg-owner; no July 2026 yet; fire two `POST /api/budget {2026,7}` in parallel (double-click, StrictMode double-mount, or two logins in the household).
- **Steps:**
  1. Race two identical create requests.
- **Expected:**
  - Exactly one succeeds (200 with the month); the loser trips the unique `(OwnerId, Year, Month)` index, is caught in the `DbUpdateException` handler, re-checks existence, and rethrows the identical 400 "A budget for 2026-07 already exists." — never a 500.
- **Automated:** Yes (tests/AllotJar.IntegrationTests/BudgetMonthConcurrencyTests.cs — concurrent create is a validation error, not a 500 [real SQL])

### BUDG-050 - Create year below range is rejected (soft dead-end via the navigator)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** budg-owner; navigate the TopBar to a not-found month in year **1999**; click a create button.
- **Steps:**
  1. On the 1999 not-found card click **"Start a blank budget"**.
- **Expected:**
  - `POST /api/budget {year:1999,...}` → 400 (Year `InclusiveBetween(2000,2100)` validator fails); the dashboard shows the generic "Could not create that budget." strip (server detail not surfaced). Known soft dead-end (deferred LOW) — the navigator has no clamp but create does.
- **Automated:** No

### BUDG-051 - Create year above range is rejected
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** budg-owner; navigate to a not-found month in year **2101**; click a create button.
- **Steps:**
  1. Click **"Start a blank budget"** on the 2101 not-found card.
- **Expected:**
  - `POST /api/budget {year:2101,...}` → 400 (Year > 2100); generic "Could not create that budget." strip; no month created.
- **Automated:** No

### BUDG-052 - Create with an out-of-range month is rejected (API-only)
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** budg-owner; raw `POST /api/budget {year:2026, month:13, copyFromPrevious:false}` (the UI can only send 1–12).
- **Steps:**
  1. Send the malformed create.
- **Expected:**
  - 400 (Month `InclusiveBetween(1,12)` validator); no month created.
- **Automated:** Partial (tests/AllotJar.Application.Tests — CreateBudgetMonthCommandValidator range rules exercised; month=13 case not explicitly confirmed)

## Month deletion & first-ever month

### BUDG-053 - There is no way to delete a whole month
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** budg-owner; JUL26 exists.
- **Steps:**
  1. Look for any "Delete month" control on `/` and attempt `DELETE /api/budget/2026/7` against the API.
- **Expected:**
  - No delete-month button or menu exists in the UI; the API has no month-delete route (`BudgetController` exposes DELETE only for `categories/{id}` and `items/{id}`) → the request 404s/405s.
  - The only way to empty a month is to delete its groups/lines individually (owned by 06); the Income group cannot be deleted, so a month always retains at least the Income group.
- **Automated:** No

### BUDG-054 - Emptying every deletable line leaves the month existing but not balanced
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; a jar-less month with only Income lines (no expense/savings); delete all income lines.
- **Steps:**
  1. Delete each income line (leaving the un-deletable Income group empty).
- **Expected:**
  - The month still exists (Income group remains); Income 0, Allotted 0, Remaining `€0.00`; hero shows the neutral empty **"Plan your income, then give every euro a job"** — NOT the gold balanced badge (`IsBalanced` needs `TotalIncome > 0`).
- **Automated:** Partial (client/src/budgetModel.test.ts / pages/DashboardPage.test.tsx — empty month is not balanced, #172)

### BUDG-055 - The first-ever month offers only blank + templates (nothing to continue)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-solo (fresh opt-out-of-samples account, no months, no jars); on `/` at July 2026.
- **Steps:**
  1. Observe the not-found create card.
- **Expected:**
  - **"Start a blank budget"** and the template grid are shown; NO **"Start {Month}"** button (no strictly-earlier month exists); no jar-append note (no jars).
  - Starting blank lands on a real empty July with the Income group only and the income-planning prompt.
- **Automated:** Yes (client/e2e-journey/register.spec.ts — default registration lands on an empty budget, create-month hero offers "Start a blank budget" + "Or start from a template" with NO Copy button for a first-ever month)

### BUDG-056 - A first month created for a jar-owning household is over-budgeted, not empty
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #172 (jar-owning household's first blank/template month lands over-budgeted)
- **Preconditions:** A brand-new household that already owns a jar (e.g. created a jar on the Jars page before any month exists); on `/` at July 2026 with no month.
- **Steps:**
  1. Click **"Start a blank budget"** (or any template).
- **Expected:**
  - The first month is born with appended accrual-planned savings line(s) → income 0, planned > 0 → **over-budgeted** rose hero, not the truly-empty state. Truly-empty first months exist only for jar-less households.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs — CreateJar plants its line, blank creates a Savings group for existing jars; the over-budgeted hero string is not asserted end-to-end)

### BUDG-057 - A blank month starts with one income line per person who has a Default income (rule 28)
- **Priority:** P1
- **Type:** Happy
- **Origin:** W06 follow-up, HANDOVER question Q1 answered (a) on 27 September 2026
- **Preconditions:** People page: Alex (Default income 3,000.00, first), Robin (2,000.00), Sam (0.00), plus an archived person with a default; no budget for the viewed month.
- **Steps:**
  1. Click **"Start a blank budget"** (or "Start {Month}" when no strictly-earlier month exists, which falls back to blank).
  2. Open the People page for the same month.
- **Expected:**
  - The Income group holds exactly two lines, in People-page order: **Alex 3,000.00** and **Robin 2,000.00**, each attributed to that person (the "Who earns" picker shows them once the household is shared). Sam (no default) and the archived person get no line; another household's people never do.
  - Income 5,000.00; the People page shows Alex 3,000.00 / Robin 2,000.00 (60% / 40%) read from these lines, not from the defaults.
  - A **template** month keeps the template's own income lines (all 0.00, unattributed) and a **copied** month keeps last month's lines exactly; neither adds lines from the defaults. A household where nobody has a default still gets the empty Income group of BUDG-001/002.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — `Create_Blank_SeedsOneAttributedIncomeLinePerActivePersonWithADefault`, `Create_CopyWithNoPriorMonth_FallsBackToTheSeededBlank`, `Create_CopyOrTemplate_KeepsItsOwnIncomeLines_NeverTheDefaults`)

### BUDG-058 - Copying a month drops an archived person's pocket-money line (rule 54)
- **Priority:** P1
- **Type:** Edge
- **Origin:** W11, rule 54 — "stops their pocket-money planned allocations from the next month onward, including future budgets already created"
- **Preconditions:** Shared household; the latest month holds a synced **Pocket Money** group with lines "Alex" (100.00) and "Sam" (100.00), each linked to its person; Sam is then archived (keeping this month). No budget for the next month.
- **Steps:**
  1. Create the next month with **Copy from {month}**.
- **Expected:** The new month's Pocket Money group holds **Alex 100.00** only — Sam's linked line is not copied, exactly as an archived jar's Savings line is not; every other line (incl. Sam's income line, if any, and any unlinked expense line named after Sam) is copied as before. The archive itself already cancelled Sam's lines in months that existed at the time, so the copy is the case for months created afterwards. A template month is unaffected (templates carry no pocket-money lines).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/PocketMoneyIdentityTests.cs — `CreateMonth_Copy_DropsAnArchivedPersonsPocketLine_AndKeepsTheOthers`)

## Skipping a jar's contribution for a month (W04; rules 60–61)

### BUDG-059 - Skipping the last plannable month is allowed; the preview says what stays unplanned
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-owner on the current month; Holiday (target 450, held 300) is due on the 1st of next month, so this month alone carries the remaining 150.
- **Steps:**
  1. Click Holiday's **✕** and read the preview.
- **Expected:** "Skipping September 2026 leaves €150.00 unplanned: no month is left to spread it over before the deadline." (`unplanned: 150`, the only month listed is the current one, `skipped:true`); **Skip this month** stays enabled — the user decides (P45). After skipping, the jar's card reads "Skipped this month" and the Edit form's preview shows the unplanned remainder.
- **Automated:** Yes (DashboardPage.skip.test.tsx — BUDG-059; JarLifecycleW04Tests — `Rule61_SkippingTheLastMonthBeforeTheDeadline_IsAllowed_AndThePreviewSaysWhatStaysUnplanned`; JarScheduleTests — `Rule61_SkippingEveryRemainingMonth_IsAllowed_AndReportsWhatStaysUnplanned`)

### BUDG-060 - Skip this month keeps the line at €0 with a Skipped tag; Plan it again or a typed amount restores it
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner on the current month; Holiday plans 150 here and in the next two months (450 by the 1st in three months).
- **Steps:**
  1. ✕ → **Skip this month** (aria "Skip Holiday this month"). 2. Click **Plan it again** (aria "Plan Holiday again this month"). 3. Skip again, then type 30 into the line's planned amount.
- **Expected:**
  - 1: `PUT /budget/items/{id}/skip` `{skipped:true}` returns the month: the line stays in the month at **€0.00** with `isSkipped:true`, a **Skipped** tag and the Plan it again link; it is never removed. Server-side the later months are replanted to 225 each (rule 61, whole cents, remainder last), the `/jars` shelf is re-read, and the Jars card reads "Skipped this month". Month creation never recreates the contribution (the line exists).
  - 2: `{skipped:false}` clears the flag and replants: 150/150/150 again.
  - 3: `PUT /budget/items/{id}` with an amount clears `isSkipped` (a typed amount is a plan) and stores 30; the later months are the user's to adjust.
- **Automated:** Yes (DashboardPage.skip.test.tsx — BUDG-060; JarLifecycleW04Tests — `Rule61_Skipping_ThisMonth_…`, `Rule61_PlanningASkippedMonthAgain_…`; JarScheduleTests — `Rule61_ASkippedMonth_PlansZero_…`; jar-lifecycle journey)

### BUDG-061 - Archive jar from the skip dialog (a second step in the same sheet; rule 26 shown verbatim)
- **Priority:** P1
- **Type:** Happy / Negative
- **Preconditions:** budg-owner on the current month; Holiday holds 450.
- **Steps:**
  1. ✕ → the quiet **Archive jar** (aria "Archive Holiday") turns the dialog to its archive step, "Archive Holiday" (one line, Cancel, **Skip this month instead** at the left and the one bad-toned **Archive jar**, aria "Confirm archive Holiday", focused) → click it. 2. Move the 450 out; repeat.
- **Expected:** 1: the first click sends nothing; the second sends `PUT /jars/{savingsId}/archive` `{archived:true}` → 400 "Holiday still holds €450.00 …" shown in the dialog's banner, which stays open. 2: 200 — the dialog closes, the month is re-read (this month's line cut to what went in, later months' lines gone — P40) and the shelf refreshed; `EVENTS.fundArchived` fires.
- **Automated:** Yes (DashboardPage.skip.test.tsx — BUDG-061; JarLedgerActivationTests — rule 26; JarLifecycleW04Tests — `Rule25_Archiving_…`)

### BUDG-062 - A past month's jar lines offer neither ✕ nor Plan it again; the server refuses too
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** budg-owner viewing last month, whose Holiday line was skipped.
- **Steps:**
  1. Hover the Holiday row. 2. `PUT /budget/items/{id}/skip` for that line; the same for a Salary line; for an archived jar's line.
- **Expected:** 1: the **Skipped** tag shows, but no ✕ (`Remove Holiday this month`), no `Delete Holiday` and no Plan it again — the month is over (P46). 2: 400 "August 2026 is over; its planned contributions are history and cannot be skipped."; "Salary is not a jar's contribution line …"; "… is archived and plans no contributions; there is nothing to skip."; another household's line → 403.
- **Automated:** Yes (DashboardPage.skip.test.tsx — BUDG-062; JarLifecycleW04Tests — `Rule60_OnlyAJarsLine_InAMonthThatIsNotOver_ForAJarThatIsPlanning_CanBeSkipped`)

## Continuing a month: wrap-up and carry-over (27 October 2026)

What the months leave over is actual money, the money in the household's shared accounts that is neither spent nor in a jar (rule 94): what new accounts held when opened, plus income received (rule 41) and money in from private accounts, less net spending (rules 37–39) other than what jars paid (saved for earlier), less money put into jars however it got there, less money out to private accounts. Counted from the household's first recorded money (`MonthLeftover`, `GET /api/budget/{y}/{m}/wrap-up`). Nothing is stored: a back-dated correction (rule 49) moves it.

### BUDG-063 - The not-found card shows how the month before went
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 exists; June: 3,000.00 received, 2,380.00 spent, 500.00 moved into Holiday; viewing July 2026 (no budget).
- **Expected:**
  - Under **"Start July"**, a section **"June 2026"**: In €3,000.00 · Spent − €2,380.00 · Into jars − €500.00 · **Left over €120.00** (green), with an ⓘ saying July starts with it.
  - Overspent instead (left over below zero): the last figure reads **Overspent** in red.
  - A month before with a carry of its own shows **"From May"** as the first figure, so the row adds up; **New accounts** and **To private** / **From private** show only when not zero.
  - Money taken out of jars reads **Out of jars + €300.00**, refunds above spending **Spent + €…**: every figure carries its own sign, so the row adds up as shown.
- **Automated:** Yes (client/src/pages/DashboardPage.carry.test.tsx; tests/AllotJar.Application.Tests/Application/MonthLeftoverTests.cs)

### BUDG-064 - No wrap-up for a month before that has not begun
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; today in July 2026; JUL26 exists; viewing September 2026 (no budget).
- **Expected:** only **"Start September"**: August has not begun, so there is nothing to sum. While the month before is still running the heading reads **"July 2026 so far"**, by the viewer's own date (on 1 August at 01:00 Malta time it reads "July 2026").
- **Automated:** No

### BUDG-065 - A started month shows "From {Month}" first under Income, counted in Remaining
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 left 120.00 over; JUL26 exists (income 3,000.00, planned 2,900.00).
- **Expected:**
  - The Income group's first row is **"From June"** €120.00 (not editable, no menu), with an ⓘ.
  - Remaining to budget reads €220.00 (3,000 + 120 − 2,900), and its bar fills against 3,120.00; the Income tile stays €3,000.00 with its own received figure (the carry is not income).
  - With June overspent by 80.00 the row reads **− €80.00** in red and Remaining drops by 80.00.
  - While the figure loads, the row and Remaining read **—** and nothing says "balanced" or "over"; if it can't load they stay **—** and the row's ⓘ says "Couldn't load this. Reload the page to try again." Moving to another month never shows the last month's figure.
  - Reports are unchanged: the carry is not income (Planned income and Received exclude it, rule 41).
- **Automated:** Yes (client/src/pages/DashboardPage.carry.test.tsx)

### BUDG-066 - The first budget gives a job to money already in the accounts
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** budg-solo; only JUL26 exists; Everyday holds 700.00, Savings 2,000.00 of which 2,000.00 is in a jar.
- **Expected:** the first Income row reads **"In your accounts"** €700.00 and Remaining counts it. With nothing outside a jar there is no row, and Remaining is income − planned. The Getting started step "Give every euro a job" ticks only once this is given a job too.
- **Automated:** Yes (client/src/pages/DashboardPage.carry.test.tsx; GettingStartedChecklist.test.tsx; MonthLeftoverTests)

### BUDG-067 - A month that has not begun shows the carry as still to come
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; JUL26 and AUG26 exist; today in July.
- **Expected:** August's first Income row reads **"From July"** with **—** and an ⓘ ("What July leaves over arrives here when August starts."); Remaining does not count it yet.
- **Automated:** Yes (client/src/pages/DashboardPage.carry.test.tsx)

### BUDG-068 - The carry always equals the money in the accounts with no job
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner; Everyday (500.00) and Savings (1,000.00) opened 1 September, 300.00 set aside into Holiday; September: 3,000.00 in, 2,500.00 on food, 200.00 moved into Holiday, a 50.00 bill paid from it; October overspends 120.00 (20.00 of it uncategorised).
- **Expected:**
  - September's **"In your accounts"** reads €1,200.00 (1,500.00 less the 300.00 in the new jar); October's **"From September"** €1,500.00; November's **"From October"** €1,380.00, which is the shared accounts' balance less the jars' on 31 October.
  - Savings already there and put into a jar give the same carry with **Set aside** at the jar's creation or **Move money** after.
  - An account added later brings its opening balance in its opening month; rows imported for dates before an account's opening date count once.
  - Money moved to a private account leaves the carry; money from one into a jar nets out. A member's salary paid into their private account on the household's Salary line, with food paid from it, counts in In and Spent but carries nothing: the wrap-up shows the rest under **To private**.
  - A payday or jar bill dated 31 October and budgeted to November counts in November, with what went straight into a jar as it arrived; jar money on its way between two accounts over a month end carries no phantom.
  - A month with no budget still moves money (December's flows count toward January).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/MonthLeftoverTests.cs)

