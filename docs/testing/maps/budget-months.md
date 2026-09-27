# Feature map — Budget months, categories, lines, bills, dashboard

Subsystem ground truth for QA test design. Verified against the working tree at
`<local>\Documents\Projects\ZeroBudget` on 2026-07-15 (post PR #172). All paths below are repo-relative
to that folder unless absolute.

---

## 1. Screens & routes

| Route | Component | When shown | Guards / gating |
|---|---|---|---|
| `/` | `client/src/pages/DashboardPage.tsx` | Signed-in users (anonymous visitors get `LandingPage`) | `App.tsx:74-81`: while `bootstrapping` shows `AuthSplash`; `isAuthenticated ? DashboardPage : LandingPage`. The dashboard route itself has NO feature flag. |
| `*` (unknown) | redirect | — | `App.tsx:179` `Navigate to="/"`. |

Chrome around the page (`client/src/components/AppShell.tsx`):
- Desktop ≥900px: left sidebar (jar logo, `AppNav`, user-chip menu); <900px: horizontal top bar. Nav key `budget` is active; page title "Budget" rendered as a visually-hidden `<h1>` (AppShell.tsx:234).
- `StagingBanner` above content; skip-link "Skip to main content".
- `TopBar` (`client/src/components/TopBar.tsx`) on every data screen: month navigator `‹ {Month Year} ›` (aria-labels "Previous month" / "Next month"), "Zero-based" pill, `ThemeToggle`. Month state lives in `client/src/features/MonthContext.tsx` (app-wide `{year, month}`, defaults to today's month; `goPrev`/`goNext` roll across year boundaries with NO min/max clamp — the UI can navigate to any year).
- Access banners (AppShell.tsx:164-169): read-only → "You have read-only access — you can view everything but cannot make changes."; Limited → "You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings."
- One-time greeting banner from `?joined=1` / `?started=1` / `?left=1` (AppShell.tsx:174-183), param stripped immediately.
- `GettingStartedChecklist` (`client/src/onboarding/GettingStartedChecklist.tsx`) floats bottom-right on all authed pages via `Onboarding`; hidden when the active household is not the login's own (`activeHousehold && !activeHousehold.isOwn` → null, line 74-75).
- Onboarding tour anchor: the Hero carries `data-tour="remaining-banner"` (DashboardPage.tsx:574; tourSteps.tsx:54). There is no separate `RemainingBanner.tsx` — deleted in PR #168.

Dashboard render states (DashboardPage.tsx):
1. **Loading** — "Loading your budget…" (line 477). The previous month VM is cleared *before* fetching (line 81, PR #168) so stale data never renders under the new label.
2. **Error strip** — rose box with the last action's error text (line 479-483).
3. **Not found + cannot write** (lines 485-494): "No budget for {MonthName} {Year} yet." + "Ask an admin or the owner to set this month up."
4. **Not found + canWrite** (lines 496-556): create UI (see §2).
5. **Month loaded** (lines 558-822): Hero, bills strip, jars shelf, Income card(s), "Everyday spending" panel, Savings group cards, "+ Add group".

---

## 2. Every UI control & user action (exact visible labels)

### Month create (not-found state, canWrite only)
- Button **`Copy {MonthName} {Year}`** — only when a strictly-earlier month exists; the label names the actual copy source (`prevBudget` = most recent prior month, which may not be last calendar month; DashboardPage.tsx:129-135, 509). POSTs `{year, month, copyFromPrevious:true}`.
- Button **`Start a blank budget`** — POSTs `{copyFromPrevious:false}`.
- Jars note (only when `jars.length > 0`): "Your {n} existing {jar is|jars are} added to any new budget automatically, so it will have a few more lines than a template lists." (lines 522-527).
- **"Or start from a template"** grid: one card per template (`Essentials`, `Student`, `Family`) with name, description, "{n} groups · {n} lines"; aria-label `Start from the {name} template`. POSTs `{copyFromPrevious:false, templateKey}`.
- All create buttons disable while `creating`.

### Hero (all months with a budget)
- Eyebrow **"Remaining to budget"**, gold amount = formatted remaining; aria-label `Remaining to budget: {amount}`.
- Tiles: **Income** / **Allotted**.
- Footnote (one of four, DashboardPage.tsx:582-598):
  - balanced → gold `BalancedBadge` **"Every {noun} has a job"** (noun from `currencyNoun`, e.g. euro/pound/dollar; fallback "unit").
  - empty (income==0 AND allotted==0) → **"Plan your income, then give every {noun} a job"** (neutral tone; PR #172).
  - over (remaining<0) → **"{amount} over-budgeted — trim a line"** (rose tone).
  - else → **"{amount} still to assign"**.

### Bills strip (only when the month has ≥1 bill line; DashboardPage.tsx:601-629)
- "📅 Bills: {paid}/{total} paid", plus "· {n} overdue" (when overdue>0) or "· {n} due soon" (when overdue==0 and dueSoon>0).
- Right side: "All bills paid 🎉" or "{amount} left to pay" (sum of unpaid bills' planned).
- Tone: overdue>0 → rose; all paid → emerald; else amber.

### "Your jars" shelf (only when `jars.length>0` AND viewed month == today's month; DashboardPage.tsx:634-681, PR #168)
- Header "Your jars" + "{total} saved" (sum of `JarDto.currentBalance`).
- Per jar: jar graphic (fill % = currentBalance/targetAmount, label `{name}: {pct}% of goal`), name, balance, then either a status chip (`jarStatusChip`) or "+{monthly}/mo".

### Income card (`client/src/components/IncomeGroup.tsx`) — one per Income category
- Header: category name (plain text — NOT renamable in UI even for Admin+), "{received} of {planned}".
- Per line (`IncomeLineRow.tsx`): editable name input (aria "Income source name"; blur commits, Enter blurs, Escape reverts, empty reverts); green received-vs-planned bar; planned amount as click-to-edit button (aria `Planned amount for {name}`; inputMode decimal; blur/Enter commit, Escape cancels); "{received} received" subtext; hover-revealed **✕** delete (aria `Delete {name}`, title "Delete income source").
- Empty group: "No income yet — add your first source below."
- Add row (canWrite, always visible): input placeholder "Add income source (e.g. Freelance, Child Benefit)…" (aria "New income source name"), Enter or **"+ Add"** button (aria "Add income source"). New lines POST with plannedAmount 0.
- No bill controls, no reorder controls on income lines.

### "Everyday spending" panel (one Card containing ALL expense groups; DashboardPage.tsx:698-738)
- Panel header: "Everyday spending" + "{spent} of {planned}" across all expense groups.
- Per group (`CategoryAccordion.tsx`):
  - Colour dot (hue by index), editable group name (aria `Rename group {name}`; blur commits, Enter blurs, Escape reverts, empty reverts).
  - Hover-revealed **▲/▼** group move (aria `Move {name} up/down`; disabled at ends; only reorders among expense groups).
  - Hover-revealed **🗑** delete (aria `Delete group {name}`) → inline confirm **"Delete"** (aria `Confirm delete {name}`) / **"Cancel"**.
  - Group totals right: "{actual} / {planned}".
  - Empty group: "No lines yet — add one below."
  - Hover-revealed **"+ Add a line"** → input placeholder "Add a line (e.g. Groceries, Fuel)…" + **"Add"** button; Enter submits, Escape cancels, blur with empty text closes.
- Per expense line (`BudgetItemRow.tsx`, expense layout):
  - Hover ▲▼ reorder in left gutter (aria `Move {name} up/down`).
  - Editable name (aria `Rename {name}`).
  - **Bill tag** "Bill" when `dueDay` set — button for Admin+ (aria `Edit due day for {name}`), static span otherwise. Tooltip: "Bill due on day {d}" / "Due soon — day {d}" / "Overdue — was due on day {d}" where d is the CLAMPED day (Feb shows 28 for a day-31 bill; BudgetItemRow.tsx:270-276, PR #168). Overdue tag = rose, due-soon = amber, normal = category tint.
  - Bill editor: `<input type="number" min=1 max=31>` (aria `Due day for {name}`), **✓** save (aria `Save due day for {name}`), **✕** remove (aria `Remove bill from {name}`, title "Remove bill", only when already a bill). Invalid (non-integer or out of 1–31) reverts silently; unchanged value is a no-op.
  - **📅** add-bill button on non-bill lines (hover-revealed; aria `Add a due date to {name}`, title "Track as a bill").
  - **Paid** toggle `☐/☑ Paid` on bill lines, gated `canEnterData` (aria `Mark {name} paid` / `Mark {name} unpaid`; aria-pressed; title "Mark as paid"/"Paid").
  - Progress bar (spent/planned, clamped 0–100%, 0 when planned==0).
  - Right column: "{remaining} left" (rose when overspent) over "{spent} of {planned-editor}"; planned is click-to-edit (same commit semantics as income).
  - Hover **✕** delete (aria `Delete {name}`, title "Delete line").
- "Saving…" pulse dot next to a line while its PUT is in flight (`savingItemId`).

### Savings group cards (`client/src/components/SavingsGroup.tsx`) — one Card per Savings category, below expenses
- Violet dot + editable group name; 🗑 delete with inline Delete/Cancel confirm; totals "{actual} of {planned}".
- Per fund line (`BudgetItemRow` fund layout, `availableMinor` set): editable name; violet funding bar; right column "{available} avail." (title "Available in this savings goal (rolled over from previous months)"; rose when negative) over "{spent} of {planned-editor}"; hover ✕ delete. NO bill controls, NO reorder controls in the savings layout.
- Empty: "No savings goals yet — add one below."
- Hover-revealed **"+ Add a savings goal"** → input placeholder "Add a savings goal (e.g. Car, Holiday, Christmas)…" + **"Add"**.

### Add group (bottom, canWrite; DashboardPage.tsx:757-818)
- **"+ Add group"** button (aria "Add a group") reveals: name input (placeholder "Add a category group (e.g. Subscriptions, Insurance)…" or, when kind=savings, "Add a savings group (e.g. Travel, Big purchases)…"; aria "New category group name"; Enter submits, Escape cancels), kind `<select>` with options **Expense** / **Savings** (aria "New group kind"), **"Add"** (aria "Add category group"), **"Cancel"** (aria "Cancel adding group").

### Getting-started checklist steps (GettingStartedChecklist.tsx:77-82)
1. "Create your first month" — hint "Start blank or pick a template — later months can copy the previous one." (wording from PR #170)
2. "Plan your income" — hint "Add what you expect to earn this month."
3. "Give every {noun} a job" — hint "Assign it all until Remaining reaches zero." — done requires `income > 0 && remaining === 0` (line 48; matches #172).
4. "Log your first transaction" — hint "Record real spending and assign it to a line."
Plus collapse/dismiss buttons, progress bar, "All set — every {noun} has a job! 🎉" when complete. Progress refreshes on mount, on every route change, and on window focus.

### Analytics events fired here
- `budgetMonthCreated` `{source: 'copy'|'blank'|'template'}` (DashboardPage.tsx:151,176)
- `budgetItemEdited` `{context: 'planned'}` (line 200)
- `monthNavigated` `{direction: 'prev'|'next'}` (MonthContext.tsx:54,58)

---

## 3. API endpoints

All in `src/AllotJar.Api/Controllers/BudgetController.cs`, `[Authorize]` + `Route("api/[controller]")` → base `/api/budget`. Client axios instance: `baseURL '/api'`, `withCredentials: true` (`client/src/lib/api.ts:82`).

Role enforcement is NOT on the controller — it is the MediatR `AuthorizationBehaviour` (`src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`): request types ending in "Query" are allowed for every role; types ending in "Command" require **Admin or Owner** unless decorated. In this subsystem the only decorated command is `SetBudgetItemPaidCommand` `[AllowLimited]` (SetBudgetItemPaidCommand.cs:11) — so a **Limited** login can toggle Paid but nothing else; **ReadOnly** can run no command. Role failure → 403 "Your access level ({role}) does not permit this action." Every handler additionally re-checks `OwnerId` (the household key, resolved from HouseholdAccess membership; `ICurrentUser.OwnerId`) and throws 403 on mismatch.

| Verb + route | Command/Query | Role | Notes |
|---|---|---|---|
| GET `/api/budget/{year:int}/{month:int}` | `GetBudgetMonthQuery` | any | 404 "No budget found for {yyyy}-{MM}." when absent. Actuals recomputed at read time. |
| GET `/api/budget/current` | `GetBudgetMonthQuery` (server UTC now) | any | Convenience; the SPA does not use it (checklist uses `/budget/{now}` client-side). |
| GET `/api/budget/months` | `GetBudgetMonthsQuery` | any | `[{year, month, key:"yyyy-MM"}]` newest first. |
| GET `/api/budget/templates` | `GetBudgetTemplatesQuery` | any | Static catalogue; no auth-scoped data. |
| POST `/api/budget` | `CreateBudgetMonthCommand(Year, Month, CopyFromPrevious=true, TemplateKey=null)` | Admin+ | Returns full new month (200). Precedence: templateKey > copyFromPrevious > blank. |
| PUT `/api/budget/items/{id:guid}` | `UpdateBudgetItemCommand(id, PlannedAmount, Name?)` | Admin+ | Name null = keep. Returns recomputed month. |
| POST `/api/budget/categories` | `AddBudgetCategoryCommand(BudgetMonthId, Name, Kind)` | Admin+ | Body `{budgetMonthId, name, isSavings}` — `isSavings:true` → Savings kind, else Expense (controller line 122). |
| PUT `/api/budget/categories/order` | `ReorderBudgetCategoriesCommand(BudgetMonthId, OrderedCategoryIds)` | Admin+ | Sets `DisplayOrder = index` for the listed ids only; accepts ANY ids belonging to the month (income/savings too), though the client sends expense ids only. |
| PUT `/api/budget/categories/{id:guid}` | `RenameBudgetCategoryCommand(id, Name)` | Admin+ | No kind check — the API CAN rename the Income group (UI has no affordance). Name is trimmed. |
| DELETE `/api/budget/categories/{id:guid}` | `DeleteBudgetCategoryCommand(id)` | Admin+ | Deletes lines + group. Income group blocked (400). |
| PUT `/api/budget/categories/{categoryId:guid}/items/order` | `ReorderBudgetItemsCommand(categoryId, OrderedItemIds)` | Admin+ | Sets DisplayOrder = index within the category. |
| POST `/api/budget/categories/{categoryId:guid}/items` | `AddBudgetItemCommand(categoryId, Name, PlannedAmount=0)` | Admin+ | Adding to a Savings-kind category MINTS a new backing Jar (see §7). |
| PUT `/api/budget/items/{id:guid}/bill` | `SetBudgetItemBillCommand(id, DueDay?)` | Admin+ | `dueDay: null` clears the bill AND resets `IsPaid=false` (handler line 43-46). |
| PUT `/api/budget/items/{id:guid}/paid` | `SetBudgetItemPaidCommand(id, IsPaid)` | **Limited+** (`[AllowLimited]`) | No check that the line is actually a bill — IsPaid can be set on any line via API. |
| DELETE `/api/budget/items/{id:guid}` | `DeleteBudgetItemCommand(id)` | Admin+ | Deleting a savings line does NOT delete/archive its jar. |

Every mutating endpoint returns the full recomputed `BudgetMonthDto` (categories ordered Income→Expense→Savings, then DisplayOrder; items by DisplayOrder — `BudgetMonthMapping.cs:27-43`).

Error envelope (`src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs`): ValidationException → 400 `{status, title:"Validation failed", errors:{Field:[...]}}`; NotFoundException → 404 `{status, title:message}`; ForbiddenAccessException → 403; anything else → 500 "An unexpected error occurred.".

No feature flags gate any budget endpoint. The dashboard's `/jars` fetch (for the shelf) is unconditional client-side — it does not consult the `jars` feature flag (DashboardPage.tsx:120-125); failures/non-arrays leave the shelf empty.

---

## 4. Validation rules & exact error messages

### Server (FluentValidation via `ValidationBehaviour`, all → 400 "Validation failed")
- `CreateBudgetMonthCommandValidator`: Year `InclusiveBetween(2000, 2100)`, Month `InclusiveBetween(1, 12)` (default FluentValidation messages).
- `CreateBudgetMonthCommandHandler`:
  - duplicate month → `"A budget for {yyyy}-{MM} already exists."` (pre-check line 36-39 AND the DbUpdateException race-recovery re-check line 226-235, PR #167).
  - unknown template → `"Unknown budget template '{key}'."` (line 100-105). Empty/whitespace templateKey is treated as no template (falls through to copy/blank).
- `AddBudgetCategoryCommandValidator`: BudgetMonthId NotEmpty; Name NotEmpty → `"A category group needs a name."`, MaxLength(120); Kind must be Expense or Savings → `"A group can only be an expense or a fund group."` (Income cannot be created).
- `AddBudgetItemCommandValidator`: CategoryId NotEmpty; Name NotEmpty → `"A line needs a name."`, MaxLength(120); PlannedAmount ≥ 0 → `"Planned amount cannot be negative."`, ≤ 99,999,999,999,999.9999 → `"Planned amount exceeds the supported range."`
- `UpdateBudgetItemCommandValidator`: same PlannedAmount rules; Name MaxLength(120) only when non-null.
- `RenameBudgetCategoryCommandValidator`: `"A category group needs a name."`, MaxLength(120).
- `ReorderBudgetCategoriesCommandValidator`: OrderedCategoryIds NotEmpty → `"Provide the category order."`
- `ReorderBudgetItemsCommandValidator`: OrderedItemIds NotEmpty → `"Provide the line order."`
- `SetBudgetItemBillCommandValidator`: DueDay (when non-null) 1–31 → `"A due day must be between 1 and 31."`
- `DeleteBudgetCategoryCommandHandler`: Income kind → 400 `"The Income group cannot be deleted."` (handler line 42-48; not the validator).

### Server 404 / 403 messages
- `"No budget found for {yyyy}-{MM}."` (GetBudgetMonth)
- `"Budget month {guid} was not found."` / `"Budget category {guid} was not found."` / `"Budget item {guid} was not found."`
- Reorder ids not in scope → 404 `"One or more categories do not belong to this budget."` / `"One or more lines do not belong to this category."`
- Ownership mismatch → 403 (empty message); missing auth → 403 `"No authenticated user on the request."`; role rejection → 403 `"Your access level ({role}) does not permit this action."`

### Client-side validation (silent — no error text)
- Names: empty/whitespace input reverts to the previous name (commit only when trimmed value differs). New line / group names: empty input simply doesn't submit.
- Planned amounts: `parseMinor` (`client/src/lib/money.ts:264-299`) — accepts `.` or `,` decimals, strips space/apostrophe grouping, resolves mixed `1.234,56`/`1,234.56` by right-most separator; rejects empty, negative, and malformed (e.g. `1.2.3`) by reverting the field; >4 dp rounds half-up. There is NO client max — a value over decimal(18,4) range would reach the server and 400.
- Due day: non-integer or outside 1–31 reverts the draft, no message.

### Client error strips (DashboardPage, shown in the rose box; each rolls back the optimistic state)
- Load: `Could not load your budget. Is the API running?` (non-404 failures only)
- Create: `Could not create that budget.` (covers duplicate-month 400, year-out-of-range 400, network — the server detail is not surfaced)
- Planned edit: `Could not save that change — reverted to the previous value.`
- Bill set / paid toggle: `Could not update that bill — reverted.`
- Rename line: `Could not rename that line — reverted to the previous name.`
- Add line: `Could not add that line — reverted.`
- Delete line: `Could not delete that line — reverted.`
- Add group: `Could not add that savings group — reverted.` / `Could not add that group — reverted.`
- Rename group: `Could not rename that group — reverted to the previous name.`
- Delete group: `Could not delete that group — reverted.`
- Reorder groups: `Could not reorder the groups — reverted.`
- Reorder lines: `Could not reorder the lines — reverted.`

---

## 5. State variants

- **Loading**: "Loading your budget…"; month cleared first so no stale render (PR #168).
- **404 / no budget**: two variants by `canWrite` (see §1). Copy button hidden when no earlier month exists (first-ever month shows only blank + templates). Template grid hidden if `/budget/templates` failed (templates state stays `[]`).
- **Empty month (PR #172)**: income==0 AND allotted==0 → hero footnote "Plan your income, then give every {noun} a job"; NOT the gold badge. `IsBalanced` (server `BudgetMonth.cs:75` and client `budgetModel.ts:105-106`) = `TotalIncome > 0 && RemainingToBudget == 0`.
- **Over-budgeted**: remaining<0 → rose "…over-budgeted — trim a line". A *blank* month created by a household that owns jars lands here, not in the empty state: month-create appends a savings line per active jar with an accrual-suggested planned amount (income 0, planned > 0). Only truly zero months show the income prompt.
- **Balanced**: income>0 && remaining==0 → gold BalancedBadge.
- **Under-allotted**: remaining>0 → "…still to assign".
- **Roles** (`AuthContext.tsx:363-368`: canWrite = role ≤ Admin; canEnterData = role ≤ Limited; isReadOnly = role == ReadOnly):
  - Owner/Admin: everything.
  - Limited: read-only structure (names as static text, no editors/reorder/delete/add, no create-month) EXCEPT the Paid toggle on bill lines; amber "limited access" banner.
  - ReadOnly: view only, amber "read-only" banner; server rejects all commands including paid.
- **Solo vs shared**: no dashboard difference — the page is household-scoped by OwnerId; shared households see identical data. The greeting banners (?joined/?started/?left) and household switcher are the shared-specific surfaces. Getting-started checklist is hidden when viewing a joined (not-own) household.
- **Feature flags off**: dashboard route unaffected. `jars:false` does not stop the shelf's `/jars` fetch (client ignores the flag here). Templates/months/budget endpoints are never flag-gated.
- **Jars shelf**: only on the current calendar month AND when `/jars` returned a non-empty array (PR #168). Past/future months never show it.
- **Archived jars**: month copy skips lines whose SavingsId is an *archived* jar (keyed on real archived ids — a dangling SavingsId with no jar row still copies; CreateBudgetMonthCommandHandler.cs:66-71,159). Archived jars are excluded from the missing-jar append (only `!IsArchived` jars are in `activeJars`).
- **Deleted referents**: deleting a savings line leaves its jar active — it re-appends to the NEXT created month (planned = its accrual requirement; €0 for target-0 jars). Deleting a category deletes its lines explicitly + relies on cascade.
- **Concurrent create** (double-click / two logins / StrictMode): second insert trips the unique (OwnerId, Year, Month) index → caught, re-checked, surfaced as the friendly 400 "already exists" (never a 500; PR #167, integration-tested in `tests/AllotJar.IntegrationTests/`).
- **Extreme month navigation**: MonthContext has no bounds; GET for year <2000/>2100 404s normally, but CREATE 400s on the year validator → client shows generic "Could not create that budget." (known soft dead-end, deferred LOW per months-audit memory).
- **Multiple income groups**: possible only via legacy data/copy (AddCategory can't create Income); the UI maps over all income groups and renders one Income card each.

---

## 6. Computed / derived values & money rules (as implemented)

Server (`src/AllotJar.Domain/Entities/BudgetMonth.cs`, `BudgetCategory.cs`, `BudgetItem.cs`; all `decimal`, SQL decimal(18,4)):
- `Category.TotalPlanned = Σ items.PlannedAmount`; `Category.TotalActual = Σ items.ActualAmount`.
- `Month.TotalIncome = Σ TotalPlanned of Income-kind categories` (planned, NOT received).
- `Month.TotalPlanned = Σ TotalPlanned of NON-income categories` (expense + savings — funding a jar counts as giving money a job).
- `Month.RemainingToBudget = TotalIncome − TotalPlanned`.
- `Month.IsBalanced = TotalIncome > 0 && RemainingToBudget == 0` (PR #172).
- `Item.Remaining = PlannedAmount − ActualAmount`.
- `Month.Key = "{Year:D4}-{Month:D2}"`.

Actuals (`src/AllotJar.Application/Budgets/BudgetActuals.cs`, recomputed on EVERY read/write response):
- Income lines sum **Income**-type transactions; expense/savings lines sum **Expense**-type. Whole transactions assigned via `Transaction.BudgetItemId` contribute `Amount × ExchangeRate`; split slices contribute `Split.Amount × parent.ExchangeRate` and inherit the parent's Type. A split parent has `BudgetItemId == null`, so no double counting. Transfers never roll up (Type matches neither). A line with no transactions reads 0. `ExchangeRate` is hardcoded 1 app-wide today (FX deferred).
- `SavingsAvailable` (fund lines only, transient): per SavingsId, `Σ (PlannedAmount − expense-spend on that line)` over ALL of the household's months with Year/Month ≤ the viewed month (BudgetActuals.cs:94-171). **Does NOT include `Jar.OpeningBalance`** — whereas the jars shelf's `JarDto.currentBalance` DOES; the dashboard "avail." and shelf figures can legitimately differ by the opening balance.

Month creation (`CreateBudgetMonthCommandHandler.cs`):
- **Copy** (source = most recent month strictly before the target): carries category Name/Kind/DisplayOrder/**ExcludeFromAllocation** (PR #167), item Name/DisplayOrder/SavingsId/**DueDay**; resets `IsPaid` (not copied → false) and actuals (derived). PlannedAmount copies flat, EXCEPT the lines of jars with a schedule (rule 17: a deadline with a target, or a fixed monthly amount), which `JarPlanner.PlanMonthAsync` re-plans — a month at or before the current one from the jar's ledger balance the day before it starts; a later month from the current month's opening balance projected through the saved planned lines in between (HANDOVER P27). An unscheduled jar's line copies flat. Archived-jar lines are dropped; dangling SavingsIds copy as-is.
- **Template**: groups + named lines, all planned = 0; every Savings-kind template line mints a NEW backing jar (`SavingsLines.AddBackingJar` → `Jar.ForSavingsLine`: Kind=Goal, Accrual=TargetByDate, target 0). Template lookup is case-insensitive on key.
- **Blank**: exactly one category — "Income", Kind=Income, DisplayOrder 0.
- **All three paths** then append a line for every active jar not already represented (alphabetical by name, case-insensitive), planned = the schedule's figure for that month (0 for an unscheduled jar), into the first Savings group (creating a group named "Savings" if none — `SavingsLines.AppendJarLine`).
- As-of balance for seeding: `JarLedgerReader.ReadAsync(..., asOf: the day before the month)` — only money STRICTLY BEFORE the target month counts, so back-filling an earlier month can't be zeroed by later savings (PR #167).
- `BaseCurrency` inherits from the previous month, else EUR.
- Schedule maths (`src/AllotJar.Domain/Services/JarSchedule.cs`, PR #271): TargetByDate splits `(target − balance entering the month)` in whole cents over the months up to the funding-completion month (the month before the deadline, or the deadline month with the opt-in — rule 36), remainder in the final month (rule 35), 0 when funded, the whole remainder when the deadline is this month or passed; no deadline → no plan (rule 17); recurring jars re-arm the date from the anchor virtually (never persisted); FixedMonthly plans its amount every month, capped at what remains when there is a target (rule 18), ongoing without one (rule 16). StraightLine, ProportionalPool and DailyRate are retired (migrated to TargetByDate).

Client money model (`client/src/budgetModel.ts`, `client/src/lib/money.ts`):
- Wire decimals → integer minor units at scale 4 (`Math.round(amount * 10_000)`); ALL UI totals are integer sums, mirroring the domain exactly, so optimistic edits recompute the same banner the server would return. `totalIncome`, `monthPlanned`, `remainingToBudget`, `isBalanced` mirror the domain formulas (budgetModel.ts:87-106).
- Display: `Intl.NumberFormat(locale, {style:'currency'})` where locale comes from the user's NumberFormat preference (dot-comma→de-DE, comma-dot→en-GB default, space-comma→fr-FR, apostrophe→de-CH, lakh→en-IN); per-currency fraction digits (JPY 0 dp).
- Bar percentages: `round(actual/planned × 100)` clamped 0–100; 0 when planned == 0.

Bills (`budgetModel.ts:118-182`):
- `billsSummary`: bills = every item with dueDay ≠ null across ALL kinds; paid count; `unpaidMinor = Σ planned of unpaid bills`.
- `effectiveDueDay = min(dueDay, daysInMonth(year, month))` (31 → 28/29 in Feb).
- `billStatus(item, y, m, today)`: null if not a bill; 'paid' if isPaid; **past month unpaid → 'overdue'** (PR #168); future month → 'upcoming'; current month: due = clamped day; diffDays < 0 → 'overdue', ≤ 7 → 'due-soon', else 'upcoming'.
- `billAlerts` counts overdue/due-soon across the month.

Optimistic-update contract (DashboardPage): every mutation snapshots the VM, applies the pure `with*` transform, then PUTs/POSTs. Adds and deletes and reorders reconcile from the server response (`fromDto(data)`); planned edits, renames, bill set and paid toggle KEEP the optimistic state on success (response ignored). Failures roll back to the snapshot + error strip. Temp ids (`temp-…`, displayOrder MAX_SAFE_INTEGER) bridge add-item/add-category until reconciliation.

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **PR #172 — empty ≠ balanced.** Both `BudgetMonth.IsBalanced` and the client `isBalanced` require `TotalIncome > 0`. Pinned by domain test in `tests/AllotJar.Application.Tests/Domain/RemainingToBudgetTests.cs` and client test "prompts for income on an empty month instead of celebrating it as balanced" (`DashboardPage.test.tsx:107`). Do not regress to bare `remaining == 0`. income==0 + planned>0 shows the honest over-budgeted rose note, NOT the empty prompt.
2. **PR #172/M1 corollary** — a jar-owning household's blank/template month is born over-budgeted (auto-appended accrual-planned savings lines). Truly-empty months only exist for jar-less households.
3. **PR #167 — copy carries `ExcludeFromAllocation`**; dropping it corrupts every copied month's allocation split.
4. **PR #167 — archived-jar copy skip keys on `archivedJarIds`**, never `!activeJars.ContainsKey`: a dangling SavingsId must still copy (prod FK makes absent==test-only; InMemory test seeds a dangling id).
5. **PR #167 — as-of jar seeding**: `JarBalances.ComputeAsync` asOf filter must stay hoisted locals (`hasAsOf`/`asOfYear`/`asOfMonth`) for EF translation; strictly-before semantics protect back-filled months.
6. **PR #167 — duplicate-month race** recovered as friendly 400, both pre-check and post-DbUpdateException paths produce the identical message.
7. **PR #168 — stale month cleared before fetch**; jars shelf current-month-only; unpaid past-month bills read overdue; bill tooltip shows the clamped due day; copy button names the real source month; `RemainingBanner.tsx` no longer exists (tour anchor moved to Hero).
8. **SavingsId is an enforced FK to Jars.Id** — every writer goes through `SavingsLines` (`src/AllotJar.Application/Jars/SavingsLines.cs`); minting a bare Guid passes EF InMemory but violates SQL Server (integration-test layer `tests/AllotJar.IntegrationTests/` exists for enforced-FK writers).
9. **Adding a line to a Savings group mints a new Jar** (Goal/TargetByDate/target 0) named after the line. Renaming the budget line later does NOT rename the jar; deleting the line does NOT delete the jar (it re-appends on the next month create). Repeatedly creating months from templates mints NEW jars each time (e.g. a second "Emergency Fund").
10. **DueDay carries on copy; IsPaid resets.** Clearing a bill (dueDay null) force-resets IsPaid=false server- and client-side.
11. **PUT items/{id}/paid does not verify the line is a bill** — API-level IsPaid on a non-bill line is accepted (UI never offers it; `IsBill => DueDay != null` is only meaningful with a due day).
12. **Rename endpoint requires plannedAmount** — the client sends the line's current planned with every rename (DashboardPage.tsx:269-272); a rename racing a concurrent planned edit can overwrite it.
13. **Income group**: cannot be created (validator) or deleted (400 "The Income group cannot be deleted."), CAN be renamed via API but not via UI; income lines have no bill/reorder affordances; blank months always seed exactly one.
14. **Category ordering** is per-kind at render (Income→Expense→Savings, then DisplayOrder); AddCategory appends after the same-kind max; the reorder endpoint blindly assigns index→DisplayOrder for whatever month-owned ids are sent.
15. **Actuals are always tx-derived at read time** — `ActualAmount` is never authored; every mutation response re-derives. `SavingsAvailable` excludes `Jar.OpeningBalance`; `JarDto.currentBalance` includes it (shelf vs fund-line "avail." may differ by exactly the opening balance).
16. **Client validation is silent-revert**, server messages on optimistic failures are swallowed into fixed strings — QA can't rely on server text reaching the UI from the dashboard.
17. **MonthContext is unbounded** while create is clamped to 2000–2100 → far-past/future months are a soft dead-end (generic create error). Known deferred LOW.
18. **planned-edit commit needs `focusout`** in DOM automation (React 17+ maps onBlur→focusout; a dispatched `blur` won't commit) — from #172 live verification.
19. **GET /budget/current** uses server UTC — near month boundaries in non-UTC timezones it can disagree with the client's `MonthContext` month.
20. Checklist's step-3 guard duplicates the balanced rule (`income > 0 && remaining === 0`) independently of `isBalanced` — keep in sync if the definition ever changes.

---

## 8. File index (read for this map)

Server:
- `src/AllotJar.Api/Controllers/BudgetController.cs`
- `src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs`
- `src/AllotJar.Application/Budgets/BudgetActuals.cs`
- `src/AllotJar.Application/Budgets/Commands/CreateBudgetMonth/{CreateBudgetMonthCommand,CreateBudgetMonthCommandHandler,CreateBudgetMonthCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/AddBudgetCategory/{AddBudgetCategoryCommandHandler,AddBudgetCategoryCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/AddBudgetItem/{AddBudgetItemCommandHandler,AddBudgetItemCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/UpdateBudgetItem/{UpdateBudgetItemCommandHandler,UpdateBudgetItemCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/DeleteBudgetCategory/DeleteBudgetCategoryCommandHandler.cs`
- `src/AllotJar.Application/Budgets/Commands/DeleteBudgetItem/DeleteBudgetItemCommandHandler.cs`
- `src/AllotJar.Application/Budgets/Commands/RenameBudgetCategory/{RenameBudgetCategoryCommandHandler,RenameBudgetCategoryCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/ReorderBudgetCategories/{ReorderBudgetCategoriesCommandHandler,ReorderBudgetCategoriesCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/ReorderBudgetItems/{ReorderBudgetItemsCommandHandler,ReorderBudgetItemsCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/SetBudgetItemBill/{SetBudgetItemBillCommandHandler,SetBudgetItemBillCommandValidator}.cs`
- `src/AllotJar.Application/Budgets/Commands/SetBudgetItemPaid/{SetBudgetItemPaidCommand,SetBudgetItemPaidCommandHandler}.cs`
- `src/AllotJar.Application/Budgets/Dtos/{BudgetMonthDto,BudgetMonthMapping,BudgetTemplateDto}.cs`
- `src/AllotJar.Application/Budgets/Queries/GetBudgetMonth/GetBudgetMonthQueryHandler.cs`
- `src/AllotJar.Application/Budgets/Queries/GetBudgetMonths/GetBudgetMonthsQueryHandler.cs`
- `src/AllotJar.Application/Budgets/Queries/GetBudgetTemplates/GetBudgetTemplatesQueryHandler.cs`
- `src/AllotJar.Application/Budgets/Templates/BudgetTemplates.cs`
- `src/AllotJar.Application/Jars/{SavingsLines,JarBalances}.cs`
- `src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`
- `src/AllotJar.Application/Common/Security/AllowLimitedAttribute.cs`
- `src/AllotJar.Application/Common/Interfaces/ICurrentUser.cs` (excerpt)
- `src/AllotJar.Domain/Entities/{BudgetMonth,BudgetCategory,BudgetItem}.cs`, `Jar.cs` (ForSavingsLine excerpt)
- `src/AllotJar.Domain/Services/JarSchedule.cs`, `src/AllotJar.Application/Jars/JarPlanner.cs`

Client:
- `client/src/App.tsx`
- `client/src/pages/DashboardPage.tsx` (+ test names from `DashboardPage.test.tsx`)
- `client/src/budgetModel.ts`
- `client/src/types.ts`
- `client/src/lib/money.ts`
- `client/src/lib/api.ts` (excerpt)
- `client/src/components/{AppShell,TopBar,Hero,CategoryAccordion,BudgetItemRow,IncomeGroup,IncomeLineRow,SavingsGroup}.tsx`
- `client/src/features/{MonthContext,FeatureContext}.tsx`
- `client/src/auth/AuthContext.tsx` (role-flag excerpt)
- `client/src/onboarding/GettingStartedChecklist.tsx`

Memory notes consulted: `empty-month-not-balanced.md`, `months-accounts-coherence-audit-2026-07.md` (both under `<local>\.claude\projects\C--Users-Laptop-Documents-Projects\memory\`).
