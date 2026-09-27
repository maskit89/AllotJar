# Month lifecycle & rollover (create blank / copy / template, navigation, first-ever, duplicates)

**ID prefix:** BUDG | **Scope:** Everything about a budget MONTH as an object rather than what is rendered inside it: creating the viewed month from the dashboard not-found state via **"Start a blank budget"**, **"Copy {Month Year}"**, or an **"Or start from a template"** card (`POST /api/budget {year, month, copyFromPrevious, templateKey}` → `CreateBudgetMonthCommandHandler`); the exact semantics a copy carries (planned amounts flat vs. jar lines re-seeded from the accrual calculator, `DueDay` carried while `IsPaid` resets, `ExcludeFromAllocation` carried, category `DisplayOrder`/`Kind`, `SavingsId` identity, `BaseCurrency` inherited, archived-jar lines dropped, dangling `SavingsId` lines kept, actuals reset because they are always tx-derived); the "every active jar takes part" append step and the as-of (strictly-before) jar-seed balance used when back-filling an earlier month; template precedence and each built-in template's shape; the over-budgeted **empty** month a jar-owning household is born into (PR #172); month navigation via the TopBar `‹ {Month Year} ›` navigator (`MonthContext`, unbounded, clear-month-before-fetch, year-boundary roll, moves every month-scoped screen together); viewing/creating/editing past and future months; the first-ever month (no copy source); duplicate-month and concurrent-create friendly-400 recovery; and the absence of any month-delete affordance. | **Out of scope:** what the loaded month renders and how its groups/lines/bills/hero/jars-shelf/planned-editing behave → **06-dashboard-budget-view.md** (that file owns the four hero footnote states, the bills strip, the jars shelf, group/line CRUD, inline planned edits and dashboard role gating); jar accrual/recurrence maths, jar CRUD, the Jars page and the allocation engine that consumes `ExcludeFromAllocation` → **jars & allocation file** (09); the transactions/transfers that produce the actuals a copy resets → **transactions & transfers file** (08); the onboarding "Create your first month" checklist step, welcome dialog and tour → **05-onboarding.md**; deep role matrix across all pages and session/auth expiry → **03-session-auth-lifecycle.md** + households/roles file; sample-budget opt-in at sign-up (which pre-creates the first month) → **02-registration-login.md** / **05-onboarding.md**; GA event payloads (`budgetMonthCreated{source}`, `monthNavigated{direction}`) → analytics file; dark-mode/responsive/a11y sweeps → cross-cutting file. **Do not test for:** a delete-month button, route or `DELETE /api/budget/{year}/{month}` endpoint (none exists — only category/item delete); a min/max clamp on the TopBar month navigator (there is none — it reaches any year); server validation text surfacing in the dashboard (create failures are swallowed into the fixed string "Could not create that budget.").

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

### BUDG-003 - Blank create is available even when a copy source exists
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 exists; viewing August 2026 (no budget).
- **Steps:**
  1. On the not-found card observe the buttons, then click **"Start a blank budget"**.
- **Expected:**
  - The **"Copy July 2026"** button (copy always names the most-recent PRIOR month — July, for an August target) sits beside an always-offered **"Start a blank budget"** button.
  - Clicking blank sends `copyFromPrevious:false` and creates a fresh month ignoring JUN26/JUL26 (only the jar-append step touches jars, not the prior month's plan).
- **Automated:** No

### BUDG-004 - Blank create is disabled while a create is in flight (double-click guard)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; not-found writer state; throttle network so the POST is observable.
- **Steps:**
  1. Click **"Start a blank budget"** and immediately click it again.
- **Expected:**
  - Both **"Start a blank budget"** and any **"Copy …"** / template buttons become `disabled` (opacity-50) for the duration of the POST (`creating` flag); only one `POST /api/budget` is sent; exactly one month is created.
- **Automated:** No

## Creating a month — copy the previous month

### BUDG-005 - Copy previous reproduces structure and planned amounts, resets actuals
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 is the fixture; viewing July 2026 with no budget; JUN26 has real spending (Groceries has an assigned transaction).
- **Steps:**
  1. On the July 2026 not-found card click **"Copy June 2026"**.
- **Expected:**
  - `POST /api/budget {year:2026, month:7, copyFromPrevious:true}`; 200.
  - New month has the same groups in the same order (Income → Housing → Food → Personal Savings → Savings) and the same line names.
  - Planned amounts copy flat for non-jar lines (Salary 2,500.00, Rent 1,000.00, Council Tax 150.00, Groceries 400.00, Personal Savings 300.00).
  - Every line's actual is 0 (actuals are tx-derived; July has no transactions yet) — Groceries shows 400.00 planned / 0 spent even though June had spend.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copy-from-previous copies structure+planned and resets actuals)

### BUDG-006 - Copy button names the actual most-recent prior month, not literally last calendar month
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (copy names the real source `prevBudget`)
- **Preconditions:** budg-owner; only APR26 and JUN26 exist (May was skipped); viewing July 2026 (no budget).
- **Steps:**
  1. Observe the copy button label on the July not-found card.
- **Expected:**
  - Button reads **"Copy June 2026"** (the most-recent month strictly before July), never "Copy May 2026" or a hardcoded "last month".
  - Clicking it copies JUN26's plan.
- **Automated:** Partial (client/src/pages/DashboardPage.test.tsx — Copy-previous offered on an empty month; source-month label wording itself not asserted)

### BUDG-007 - Copy source is the most-recent month strictly BEFORE the target (back-fill picks an earlier source)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-owner; APR26 and JUN26 exist; viewing **May 2026** (a gap month, no budget).
- **Steps:**
  1. Observe and click the copy button on the May 2026 not-found card.
- **Expected:**
  - Button reads **"Copy April 2026"** (June is later than May, so it is not the source); copying builds May from APR26's plan.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copies only the caller's own previous month; handler picks the most-recent strictly-earlier month)

### BUDG-008 - Copy carries the bill due day but resets Paid to unpaid
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 / gotcha: DueDay carries on copy, IsPaid resets
- **Preconditions:** budg-owner; JUN26 has Rent (dueDay 1, **IsPaid=true**) and Council Tax (dueDay 28, unpaid); viewing July 2026 (no budget).
- **Steps:**
  1. Click **"Copy June 2026"**.
- **Expected:**
  - July's Rent keeps `dueDay 1` and July's Council Tax keeps `dueDay 28` (both still tagged "Bill").
  - Both lines are **unpaid** in July — Rent's paid state did NOT copy (a new month starts unpaid); the bills strip reads "0/2 paid".
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs — CreateBudgetMonth carries the due day but resets paid)

### BUDG-009 - Copy carries a day-31 due day unchanged (clamping is display-only)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** budg-owner; JUN26 has a bill line "Rent" with `dueDay 31`; copy JUN26 into **February 2027**? (build a source first). Simpler: JAN27 has a `dueDay 31` bill; viewing February 2027 (no budget).
- **Steps:**
  1. Click **"Copy January 2027"** to create February 2027.
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

### BUDG-011 - Copy inherits BaseCurrency from the previous month
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** budg-owner; JUN26 `BaseCurrency = EUR`; viewing July 2026 (no budget).
- **Steps:**
  1. Copy JUN26 into July.
- **Expected:**
  - July's `BaseCurrency` = EUR (inherited from the previous month). (A first-ever month with no previous defaults to EUR — see BUDG-039.)
- **Automated:** No

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

### BUDG-017 - Copy drops a line that funds an archived jar
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #167 (copy re-funded archived jars forever)
- **Preconditions:** budg-owner; JUN26 has an "Old Boiler" fund line backed by an **archived** jar; viewing July 2026 (no budget).
- **Steps:**
  1. Copy JUN26 into July.
- **Expected:**
  - The July month has NO "Old Boiler" line — lines whose `SavingsId` is an archived jar id are skipped on copy (archiving stops future contributions).
  - All non-archived-jar lines still carry.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — copy skips lines funding archived jars)

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
  - The "Or start from a template" section is absent (templates state stays `[]`); Copy/blank buttons still render and work.
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

### BUDG-029 - The jar-append note appears on the not-found card for jar owners
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** budg-owner owns 2 active jars; not-found writer state.
- **Steps:**
  1. Read the small print under the Copy/blank buttons.
- **Expected:**
  - "Your 2 existing jars are added to any new budget automatically, so it will have a few more lines than a template lists." (singular "jar is" for exactly 1 jar; absent when 0 jars).
- **Automated:** No

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

### BUDG-032 - Archived jars are excluded from the append step
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** budg-owner owns active Holiday + archived Old Boiler; create a blank July.
- **Steps:**
  1. Inspect the appended savings lines.
- **Expected:**
  - Only Holiday is appended; the archived Old Boiler gets no line (only `!IsArchived` jars are in `activeJars`).
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

### BUDG-034 - A savings line deleted in one month re-appears in the next created month
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** budg-owner; JUL26 exists; delete its Holiday savings line (the jar Holiday stays active — deleting a line does not archive/delete the jar); viewing August 2026 (no budget).
- **Steps:**
  1. Copy JUL26 into August (or start August blank).
- **Expected:**
  - August gets a fresh Holiday line appended (the jar has no representation in the new month, so the append step re-adds it) planned at its accrual requirement — deleting the line was per-month, not permanent.
- **Automated:** No

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
  - The not-found writer card renders: "No budget for December 2026 yet." with **"Copy {most-recent prior month}"** + **"Start a blank budget"** + template grid — future months are freely creatable.
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
  - "No budget for {Month} {Year} yet." + "Ask an admin or the owner to set this month up." — no Copy/blank/template controls (create is Admin+).
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

### BUDG-055 - The first-ever month offers only blank + templates (no Copy)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** budg-solo (fresh opt-out-of-samples account, no months, no jars); on `/` at July 2026.
- **Steps:**
  1. Observe the not-found create card.
- **Expected:**
  - **"Start a blank budget"** and the template grid are shown; NO **"Copy …"** button (no strictly-earlier month exists); no jar-append note (no jars).
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
  1. Click **"Start a blank budget"** (or "Copy …" when no strictly-earlier month exists, which falls back to blank).
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
