# Subsystem map: Jars & the Allocation engine

Ground-truth feature inventory for QA test design. Verified against the working tree at
`<local>\Documents\Projects\ZeroBudget` (repo `maskit89/AllotJar`, main) on 2026-07-15.
All server money values are `decimal(18,4)`; the client works in integer minor units
(`client/src/lib/money.ts`). Jar/allocation enums are serialized as **numbers** on the wire.

---

## 1. Screens & routes

| Route | Component | Guards / gating |
|---|---|---|
| `/jars` | `client/src/pages/JarsPage.tsx` | `RequireAuth`; route only registered when `features.jars` is true (`client/src/App.tsx:110-119`). Nav link "Jars" shown when `features.jars` (`client/src/components/AppNav.tsx:35`). |
| `/allocation` | `client/src/pages/AllocationPage.tsx` | `RequireAuth`; route only registered when `features.householdAllocation` (`App.tsx:133-142`). Nav link "Allocation" shown only when `features.householdAllocation && isShared` (`AppNav.tsx:38`); the route itself is reachable by URL for a solo user and then renders the "Add people first" empty state (`AllocationPage.tsx:214-226`). |
| `/` (Dashboard, current month) | `client/src/pages/DashboardPage.tsx` | "Your jars" shelf renders only when `jars.length > 0 && isCurrentMonth` (`DashboardPage.tsx:634`) — deliberately hidden on past/future months because it shows all-time balances (`DashboardPage.tsx:568-570`). |
| Budget grid Savings groups | `client/src/components/SavingsGroup.tsx` (rendered by DashboardPage below expense groups) | Structure edits gated on `canWrite` (Admin+). |
| `/people` | `client/src/pages/PeoplePage.tsx` | Member "Savings account" select — the personal-savings link the allocation engine transfers into. |
| `/accounts` | AccountsPage reconciliation panel | Read-only earmark reconciliation of jars via `FundingAccountId` ("Held in"). |

Feature flags come from anonymous `GET /api/features` (`FeaturesController.cs`); client defaults
ALL-ON until the response arrives (`client/src/features/FeatureContext.tsx`), so a flag-off flash
is theoretically possible. Server-side, `[FeatureGate]` returns **404** for every endpoint of a
disabled feature (`src/AllotJar.Api/Features/FeatureGateAttribute.cs`).

`isShared` = active members ≥ 2 (`client/src/features/HouseholdContext.tsx:97`).

Role gating client-side (`client/src/auth/AuthContext.tsx:365-368`):
`canWrite` = role ≤ Admin; `canEnterData` = role ≤ Limited; ReadOnly gets neither.

---

## 2. UI controls & user actions (exact visible labels)

### JarsPage (`/jars`)
- Hero: eyebrow **"Total saved"** (sum of `currentBalance` across listed jars); tiles **"Monthly"** (`+<sum of requiredMonthlyContribution>`) and **"Active jars"** (count).
- Empty state: title **"No jars yet"**, description "Add a jar — give it a target and a date, and we'll work out what to set aside each month."; **"+ New jar"** button (only `canWrite`).
- Section heading **"Your jars"**, **"+ New jar"** button (only `canWrite`).
- Jar card (`JarCard`, JarsPage.tsx:523-593): jar graphic (fill % clamped 0–100), name, status chip (**"Behind"** amber / **"Overspent"** rose / **"Funded"** teal — no chip for OnTrack/Unfunded, `client/src/lib/jarStatus.ts:21-32`), a **%** pill (hidden when `FullyFunded` or target ≤ 0), balance **"€X of €Y"**, progressbar, pace label (**"+€X/mo · full by <Month Year>"** or **"+€X/mo"** or **"Fully funded"** / **"No target yet"** / **"—"**, `jarStatus.ts:39-55`), **"Edit"** link (only `canManage`=`canWrite`).
- Modal **"New jar"** / **"Edit jar"** (mounted only while open; `canWrite` required):
  - **Name** (text, placeholder "e.g. Home insurance")
  - **Type** select with InfoHint "About jar types" (copy: Recurring "Saves toward a due date, then repeats…", Goal "A one-off savings target — once it's funded, it's done…"). Options from `JAR_KIND_LABELS`.
  - **Target** (decimal text, placeholder "0.00")
  - **"Saved so far"** (create mode) / **"Opening balance"** (edit mode, with helper text "Before tracking began — the card shows the live total.") — both bind `openingBalance`.
  - If Type=Recurring: **"Next due"** (date) + **"Repeats"** select (options: **Yearly**=12, **Every 6 months**, **Every 3 months**, **Monthly**=1, `client/src/types.ts:304-309`; a non-standard stored value such as 24 is kept as extra option "Every 24 months", JarsPage.tsx:110-113).
  - If Type=Goal: **"Target date (optional)"** (date).
  - **"Held in"** select (option **"No account"** + account names; helper "Add accounts to earmark a jar's cash." when no accounts).
  - Live preview line (aria-live): **"Sets aside ≈ €X/mo"** + " toward <date>, then it repeats" (Recurring) / " until <date>" (Goal) / " (no date — the remainder spreads over 12 months)". Hidden when target invalid/0, or in edit mode when the jar's accrual ≠ TargetByDate (JarsPage.tsx:121-142).
  - Footer: **"Archive jar"** → arms to **"Really archive?"** (two-click confirm, edit mode only); **"Cancel"**; **"Add jar"** / **"Save"**.
- No UI to list or restore archived jars (list request never passes `includeArchived`; restore exists only via the API).

### Dashboard "Your jars" shelf (current month only)
- Card heading **"Your jars"** + **"€X saved"** total; per jar: jar graphic, name, balance, then either the status chip **or** **"+€X/mo"** (chip wins; DashboardPage.tsx:662-674). No edit affordances.
- No-month screen: note "Your N existing jar(s) are added to any new budget automatically, so it will have a few more lines than a template lists." (DashboardPage.tsx:522-527).

### Budget grid Savings group (`SavingsGroup.tsx`)
- Violet-dot group header, inline-rename input (canWrite), 🗑 delete with **"Delete"**/**"Cancel"** confirm, totals "€actual of €planned".
- Rows via `BudgetItemRow` with rolled-over **Available** balance (`savingsAvailableMinor`).
- **"+ Add a savings goal"** → input placeholder "Add a savings goal (e.g. Car, Holiday, Christmas)…" + **"Add"** button. Adding a line here auto-creates a backing Jar server-side (see §7).
- Empty group: "No savings goals yet — add one below."

### AllocationPage (`/allocation`)
- Solo (not shared): EmptyState **"Add people first"** with button **"Add people"** → navigates `/people`.
- Hero (only when profile+preview loaded): eyebrow **"Income to allocate"** (pool); tiles **"Shared spending"** (envelopes+jars+pocket) and **"To savings"** (terminal step total) — the two tiles reconcile to the pool by construction.
- No profile: EmptyState **"No allocation set up yet"** with **"Set up allocation"** button (canWrite).
- Main card **"How {month} is allocated"** ({month} = browser-locale long month name of the current budget month, falling back to today):
  - **"Settings"** ghost button (canWrite); **"Allocate {month}"** button (canEnterData; `disabled` while busy or when `!profile.sourceAccountId`).
  - No-source hint: "Set the account to pay shared costs from in **Settings** before you can allocate {month}."
  - Committed banner (role=status): "Allocated {month} — no savings transfers were needed this month." (0 transfers) or "Allocated {month} — N savings transfer(s) created. Re-running Allocate replaces them, never doubles up."
  - Waterfall list, step labels: **"Cover shared costs"**, **"Fund the jars"**, **"Pocket money"** (with "· €X each" when per-member amount > 0), **"Split remainder to savings"** (terminal row highlighted); each with its total.
  - Notes: "Shared spending uses up all the pooled income this month, so there's nothing left to move to savings." (nothingToSave && stranded==0); "€X has nowhere to go — a member has no savings account, so that share stays in the source account instead of transferring." (stranded > 0).
  - Per-member tiles: name, "Savings €X → saves", residual (rose when negative), "Projected balance €Y" (= savingsBalance + residual), and "No savings account set — won't transfer on commit." when the member lacks a savings account.
- Settings modal **"Allocation settings"** / **"Set up allocation"** (canWrite):
  - **"Pay shared costs from"** select (option "Choose an account…" + accounts) with InfoHint "About the source account" ("…It only affects the commit — the preview below is the same whichever account you pick.").
  - **"Pocket money (each)"** decimal input.
  - **"Split shared costs"** SegmentedControl: **"Equally"** / **"By income"** (+ InfoHint "About splitting shared costs").
  - **"Send savings to"** SegmentedControl: **"Balance"** / **"Equally"** / **"By income"** (+ InfoHint "About the savings split").
  - **"Balance lean (0–100)"** numeric input, shown only when savings split = Balance (+ InfoHint "About balance lean": "0 is a plain even split; 100 fills the lowest balance first. 25 is a gentle nudge.").
  - **"Cancel"** / **"Save"** (existing profile) or **"Set up"** (new). Cancel AND backdrop close both call `syncFormFromProfile()` — unsaved edits are reverted so a later Save can't commit them (AllocationPage.tsx:162-184, PR #163).
- Saving the profile clears any prior committed banner (stale numbers) and re-runs the preview (AllocationPage.tsx:133-137).

### PeoplePage (member personal savings, allocation input)
- Per-member **"Savings account"** select (add form and inline edit, `aria-label="Savings account for {name}"`); writes `personalSavingsAccountId` (null when blank).

---

## 3. API endpoints

All owner-scoped via `ICurrentUser.OwnerId`; MediatR `AuthorizationBehaviour` enforces roles on every `*Command` (Queries readable by every role incl. ReadOnly; Commands need Admin+ unless `[AllowLimited]`; ReadOnly can run no command) — `src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`.

### JarsController — `[Authorize]`, `[FeatureGate(Jars)]`, `api/jars` (`src/AllotJar.Api/Controllers/JarsController.cs`)
| Verb + route | Handler | Role | Notes |
|---|---|---|---|
| `GET /api/jars?includeArchived=` | `GetJarsQuery(IncludeArchived=false, AsOf=null)` | any role | Returns `JarDto[]` sorted by Name; archived excluded unless flag; balances derived per read. |
| `POST /api/jars` | `CreateJarCommand` | Admin+ | 201; body `CreateJarRequest` (name, kind, targetAmount, targetDate?, coverStart?, coverEnd?, accrual, openingBalance, openingAsOf?, fundingAccountId?, recurMonths?). Also plants a contribution line in the current + every future existing month (§6). |
| `PUT /api/jars/{id}` | `UpdateJarCommand` | Admin+ | 200/400/403/404. Whole-resource replace; does NOT retro-edit budget lines. |
| `PUT /api/jars/{id}/archive` | `ArchiveJarCommand(id, Archived)` | Admin+ | body `{archived: bool}` (default true) — archive or restore; soft flag only. |

There is **no DELETE** for jars. 404 body message: `Sinking fund {id} was not found.`; foreign owner → 403.

### AllocationController — `[Authorize]`, `[FeatureGate(HouseholdAllocation)]`, `api/allocation` (`src/AllotJar.Api/Controllers/AllocationController.cs`)
| Verb + route | Handler | Role | Notes |
|---|---|---|---|
| `GET /api/allocation/profile` | `GetAllocationProfileQuery` | any role | 200 with `AllocationProfileDto` or JSON `null` (first profile ordered by Name). |
| `PUT /api/allocation/profile` | `UpsertAllocationProfileCommand` | Admin+ | Create (Id null) or replace (Id set; rules replaced wholesale). 200/400/403/404. |
| `GET /api/allocation/preview/{year}/{month}?profileId=` | `PreviewIncomeAllocationQuery` | any role | Dry run, no writes; works with **no profile** (empty steps; members with residual = full net income). |
| `POST /api/allocation/commit/{year}/{month}?profileId=` | `AllocateIncomeCommand` | **Limited+** (`[AllowLimited]`, AllocateIncomeCommand.cs:31) | Idempotent: deletes all transactions whose `AllocationKey` starts `alloc:{year}-{month}:` then recreates. 200/400/403/404. |

Commit failure modes: no profile → 404 `There is no allocation profile to run.`; no source account → 400 ValidationException key `SourceAccountId`: `Set a source account on the allocation profile before committing.`; source account missing → 404 `Source account {id} was not found.`; source owned by someone else → 403.

Commit writes one `Transaction` per member with `Residual > 0` **and** a valid `SavingsAccountId`:
`Type=Transfer, Date = 1st of month, Payee = "Income allocation — {name}", Amount = residual, Currency = the source account's currency (the handler refuses a source account whose currency differs from the month's `BaseCurrency`), AccountId = source, TransferAccountId = member savings, AllocationKey = "alloc:{year}-{month}:{memberId}"` (W07: the key lives in the `AllocationKey` column, not `BankReference`; `AllocateIncomeCommandHandler.cs`). `TransfersCreated` in the response = number created (0 for preview).

### Related endpoints feeding this subsystem
- `POST /api/budget/{...}` month creation (`CreateBudgetMonthCommandHandler`) — seeds/append jar lines (§6).
- Budget item add (`AddBudgetItemCommandHandler`) — a line added to a Savings group mints a backing Jar (`SavingsLines.AddBackingJar`, open-ended Goal, target 0).
- `GET /api/accounts/reconciliation` (`GetAccountReconciliationQueryHandler`) — per account: `BackedJarsTotal` = Σ(opening + tracked) of non-archived jars with `FundingAccountId == account`, `Float = CurrentBalance − BackedJarsTotal`. Jars with no account are silently excluded; archived jars excluded.
- `POST/PUT /api/members` (Create/UpdateHouseholdMember) — validates `PersonalSavingsAccountId` exists AND is owned (else 404 `Account {id} was not found.`) — closes the dangling/cross-tenant vector (PR #162).

---

## 4. Validation rules & exact error messages

### Server (FluentValidation → 400 with field errors)
Create/Update jar (`CreateJarCommandValidator.cs`, `UpdateJarCommandValidator.cs` — identical rules; Update also requires non-empty Id):
- Name: NotEmpty → **"A fund needs a name."**; MaxLength 120.
- Kind, Accrual: `IsInEnum`.
- TargetAmount ∈ [0, 99 999 999 999 999.9999] → **"Target amount is out of range."**
- OpeningBalance ∈ [−max, +max] → **"Opening balance is out of range."** (negative opening IS allowed).
- RecurMonths, when present, ∈ [1, 120] → **"Repeat cycle must be between 1 and 120 months."**
- CoverEnd > CoverStart only when both set → **"Cover end must be after cover start."**
- Deliberately permissive otherwise (PR #149): past target dates, target 0, Recurring without date/target all pass — form-only guidance keeps importer/legacy jars editable.

Upsert allocation profile (`UpsertAllocationProfileCommandValidator.cs`):
- Name: NotEmpty → **"An allocation profile needs a name."**; MaxLength 120.
- BalanceLeanPercent ∈ [0, 100] → **"Balance lean must be between 0 and 100."**
- Per rule: Type/Split `IsInEnum`; FixedAmountPerMember ∈ [0, max] → **"Fixed amount is out of range."**

Other server errors: role rejection → 403 **"Your access level ({role}) does not permit this action."**; commit errors as in §3.

### Client (pre-submit, shown in the modal's ErrorBanner)
JarsPage (`submit`, JarsPage.tsx:196-258):
- Empty name → **"Give the jar a name."**
- Target/opening not parseable (`parseMinor` null: negative, non-numeric, malformed separators) → **"Enter valid amounts."** ('' parses as 0.)
- NEW jar with Type=Recurring: target ≤ 0 → **"Give the recurring jar a target amount."**; no date → **"Give the recurring jar its next due date."** (Edit mode skips both — legacy jars stay editable.)
- Request failures → **"Could not save that jar."** / **"Could not add that jar."** / **"Could not archive that jar."**; initial load → **"Could not load your jars."**

AllocationPage:
- Pocket money invalid → **"Enter a valid pocket-money amount."**
- Lean not an int in [0,100] → **"Balance lean must be a whole number between 0 and 100."** (blank lean defaults to 25)
- Failures: **"Could not load the allocation setup."**, **"Could not compute the allocation preview."**, **"Could not save the allocation profile."**, **"Could not commit the allocation. Check the source account and members’ savings accounts are set."**

`parseMinor` (money.ts:264-291): accepts both "1,234.56" and "1.234,56" styles (right-most separator = decimal), strips spaces/apostrophes, rejects negatives, rounds >4 dp half-up to scale 4.

---

## 5. State variants

- **Loading**: both pages show plain "Loading…" text.
- **Jars empty**: EmptyState "No jars yet"; hero shows €0.00 / +€0.00 / 0.
- **Jars read-only roles**: cards render without "+ New jar" / "Edit"; modal never mounts (`showForm && canWrite`).
- **Archived jar**: removed from JarsPage list immediately on archive; excluded from GET by default, from the accounts reconciliation, and from month-copy line carry-forward (`CreateBudgetMonthCommandHandler.cs:159` — a copied month drops lines backed by archived jars; a **dangling** SavingsId with no jar row is still copied, only truly-archived ids are dropped, lines 67-71). Restoring is API-only.
- **Deleted "Held in" account**: `FundingAccountId` is a soft hint, NOT an FK (`Jar.cs:61-66`) — deleting the account leaves the id dangling; the jar's "Held in" select then shows no matching option, and reconciliation just stops counting the jar (its account no longer exists).
- **Deleted member savings account**: `PersonalSavingsAccountId` is soft; `AllocationPlanner` nulls any link not present in the owned-accounts balance dict, so preview shows "No savings account set" and commit skips the member instead of 500-ing (PR #162, `AllocationPlanner.cs:53-68`).
- **Allocation, solo household**: page short-circuits to "Add people first" (client only — the API itself has no ≥2-member guard; a solo commit via API works and transfers to the single member).
- **Allocation, no profile**: EmptyState + "Set up allocation"; no hero, no preview shown (loadPreview only runs when a profile exists client-side, though the endpoint answers without one).
- **Profile without source account**: preview renders; "Allocate" disabled + amber hint; commit via raw API → 400.
- **Feature flag off**: route unregistered → SPA redirects `*` → `/`; nav hidden; API 404s.
- **Zero members**: pool 0; empty splits (IncomeAllocator handles n=0 in `Split`, returns empty shares; WaterFill only called with n≥1 members via terminal rule when remainder>0 — with 0 members remainder=0 → keep-own branch).
- **All members zero/equal balances (brand-new couple)**: WaterFill top-tier levelling — the pre-#162 `k*decimal.MaxValue` overflow is fixed (`IncomeAllocator.cs:193-208`); must NOT 500.
- **Negative residual member** (income < share of obligations): shown rose; keep-own branch (remainder ≤ 0) leaves each member their own (possibly negative) leftover; commit skips residual ≤ 0.
- **Re-run commit**: prior `alloc:{y}-{m}:` transfers deleted then recreated → replaced, never doubled; savings-balance tilt reads exclude this month's alloc transfers so preview == re-commit (`AllocationPlanner.SavingsBalancesAsync`, prefix filter).
- **Empty month (PR #172)**: `IsBalanced = TotalIncome > 0 && RemainingToBudget == 0` (`BudgetMonth.cs:75`; client mirror `budgetModel.ts:105-106`). Empty month hero shows "Plan your income, then give every {euro/pound/...} a job" instead of the gold "Every {noun} has a job" badge (`DashboardPage.tsx:558-598`).
- **Blank/template month for a jar-owning household (PR #172 context)**: month creation appends accrual-planned lines for every active jar (§6) → a blank month with jars has planned savings > 0 and 0 income → lands **over-budgeted** ("€X over-budgeted — trim a line"), not empty.
- **Sample-budget opt-in (PR #170)**: only the opt-in seed creates the starter budget + "Emergency Fund" backing jar (`BudgetSeeder.cs:33`); default sign-up = zero jars, zero months. Start-own-budget/leave-household never seed.

---

## 6. Computed/derived values & money rules (as implemented)

All jar planning in `src/AllotJar.Domain/Services/JarSchedule.cs` (pure) and `src/AllotJar.Application/Jars/JarPlanner.cs` (month seeding, replanting, the form's preview): an equal whole-cent split with the rounding remainder in the final month (rule 35), never half-away-from-zero rounding (W02, PR #271).

**Jar current balance** (Jars page, reconciliation, `JarBalances.ComputeAsync`):
`OpeningBalance + Σ over ALL months of linked Savings lines' PlannedAmount − Σ spends`, where spends = Expense transactions assigned to those lines + Expense split slices, at their recorded `Amount` (budget currency; rows still `FxPending` are left out — W08, no exchange rate exists). Optional `asOf` (year,month) restricts to months **strictly before** it (used by month-creation seeding so back-filling an earlier month can't see later savings).

**Budget-grid `SavingsAvailable`** (`BudgetActuals.ApplySavingsBalancesAsync`): same planned−spent net but months **≤ viewed month** and **WITHOUT OpeningBalance**. So Jars page balance ≠ grid Available for jars with an opening balance or future-month lines — a known two-flavour design, only consistent on the current month with no opening.

**Plans** (`JarSchedule.Plan(jar, asOf, balanceEnteringTheMonth)`; `AccrualMethod` is TargetByDate = 1 | FixedMonthly = 2 — StraightLine, ProportionalPool and DailyRate were retired and migrated to TargetByDate, HANDOVER O6):
- TargetByDate (1): `remaining = Target − balance`, 0 when ≤ 0; otherwise split in whole cents over the months from the planning month to the funding-completion month — the month before the deadline, or the deadline month itself when the deadline falls after the 1st and `IncludeDeadlineMonth` is set (rule 36) — with the remainder in the final month (rule 35); a deadline this month or already passed plans the whole remainder now. No deadline → no plan (rule 17: there is no ÷12 default).
- FixedMonthly (2): `MonthlyContribution` every month; with a target the final month is capped at what remains and nothing is planned once the target is held (rule 18; `EstimatedMonths` is rule 58's estimate); with no target the jar is ongoing (rule 16).
- Recurring jars plan toward their **open cycle** (`Jar.CycleDeadline`, W03); the next cycle is stepped from the stored anchor (`JarSchedule.NextCycleDeadline`, rule 62 clamps a 31st to a shorter month without losing it). A passed open cycle plans the whole remainder now — it never rolls on its own (rule 20).

**Recurrence (W03, replaces the PR #149 pure view)**: a Recurring jar has a persisted open cycle (`Jar.CycleDeadline`) and a history table `JarCycles` (`JarCycle`: `Deadline`, `TargetAmount`, `Outcome` Paid | Funded | Missed | FundedLate, `BalanceAtDeadline`, `PaymentTransactionId`, `PaidOn`, `PaidAmount`, `ClosedOn`; unique `(JarId, Deadline)`, unique filtered payment). `JarCycles.SettleAsync` runs on every read/plan path (`GetJars`, `GetJarSchedule`, `UpdateJar`, `CreateBudgetMonth`): an open cycle whose deadline passed with the balance at the end of the day before ≥ target closes **Funded** and the jar advances to `NextCycleDeadline` (rule 21); a short one stays open → `JarDto.Status = DeadlineMissed` with `Shortfall` (rule 20), or `FundedLate` once held in full (rule 57). `MarkJarCyclePaidCommand` (`POST /jars/{id}/cycles/paid`, rule 83) links the chosen expense (never income/transfer/refund, never future-dated, never one still waiting for its budget-currency amount — W08: 400 `PaymentTransactionId` "That payment is in {CODE} and is waiting for its amount in the budget currency. Enter that amount on Transactions first."; one cycle per payment) and closes/advances the open cycle, or links a closed Funded one; `DismissJarCycleCommand` (`POST /jars/{id}/cycles/dismiss`) closes the passed open cycle as Missed/FundedLate and advances. `GetJarPaymentsQuery` (`GET /jars/{id}/payments[?all=true]`) lists candidate expenses (the jar's own via rule 79's `SavingsId`/stored allocation, or all), each with `fxPending`; the Mark paid dialog (`MarkCyclePaidModal`) lists a waiting one dimmed with " · Needs its amount entered on Transactions first" and its radio disabled. The anchor `TargetDate` is still never rewritten by settlement (day of month preserved, no drift); `JarCycles.DeadlinesFor` keeps both when a form echoes the open cycle's date or the anchor, and treats any other date as a new anchor + open cycle. `JarDto.Deadline` is the open cycle; `LastCycle` is the latest closed one. Goal dates never roll. No money moves on any cycle event. Kind↔RecurMonths lockstep: create sets `RecurMonths = Kind==Recurring ? (request ?? 12) : null`; update falls back `request ?? stored ?? 12` so a stale client can't reset a 3/6-month cycle (`UpdateJarCommandHandler.cs:48-50`).

**Lifecycle (W04; rules 25–27, 55–56, 60–61, 84)**: `JarSchedule.IsPlanning(jar)` (neither `IsArchived` nor `CompletedOn`) gates month creation's copy/append, `UpdateJar`'s replant and the DTO's plan. Stopping a jar (`ArchiveJar` with `archived:true`, `CompleteJar` → `POST /jars/{id}/complete`) calls `SavingsLines.CancelPlansAsync`: the current month's line := max(0, balance now − planning balance), later lines removed unless a `Transaction`/`TransactionSplit` references them (then 0); past months, transactions and money untouched. Restoring (`archived:false`) calls `JarPlanner.ReplantAsync`. `CompleteJar` refuses non-Goals, completed/archived jars and an unavailable or negative balance (O3); `UpdateJar` refuses `Kind = Recurring` on a completed goal. `DeleteJar` (`DELETE /jars/{id}`) is allowed only when `JarUsage.HasHeldMoneyAsync` is false — no `JarAllocationPosting` ever, no transaction ever on one of its lines — and removes every `BudgetItem` with the jar's `SavingsId` (all months), its `JarCycles` and the jar; `JarDto.CanDelete` carries the same predicate. A jar's line cannot be deleted from a month (`DeleteBudgetItem` refuses `SavingsId != null`); `SkipJarContribution` (`PUT /budget/items/{id}/skip {skipped}`) sets `BudgetItem.IsSkipped` and 0 (or clears it) and replants; `GetJarSkipPreview` (`GET /budget/items/{id}/skip-preview`) is `JarPlanner.ScheduleAsync(…, alsoSkip: month)`; `UpdateBudgetItem` clears the flag when an amount is typed; both go through `Budgets/JarLineLoader` (a jar's line, a planning jar, a month not over). Every replant reads the flagged months (`SavingsLines.SkippedMonthsAsync`, or the loaded lines) into `JarPlanOptions.SkippedMonths`, so a skipped month is never re-planned and month creation never recreates it (the line exists). `JarDto.CompletedOn`/`SkippedThisMonth`, status `Completed`; `JarScheduleDto.Unplanned`, month `Skipped`.

**Status** (`JarMapping.ToDto`, priority order): balance < 0 → `Overspent`; target ≤ 0 → `Unfunded`; remaining == 0 → `FullyFunded`; effectiveDue < asOf → `Behind` (only Goals / roll-less jars can be Behind — a healthy Recurring jar re-arms); else `OnTrack`. `ProjectedFullyFundedDate = asOf.AddMonths(ceil(remaining ÷ requiredMonthly))` when remaining>0 and required>0, else null.

**CreateJar planting** (`CreateJarCommandHandler.cs:54-82`): after inserting the jar, appends its contribution line to the first Savings group (creating a "Savings" group at DisplayOrder 0 if none) of the current month and every already-created FUTURE month, each month's planned recomputed with earlier plantings folded in (`fund.OpeningBalance + planted`). Past months untouched. Response DTO reports `balance = opening + planted` so the card equals the next GET.

**Month creation** (`CreateBudgetMonthCommandHandler`): copy path re-seeds copied jar lines at the calculator amount when `TargetAmount > 0 && Accrual != ProportionalPool` (else copies planned flat); drops archived-jar lines; then ANY active jar not yet represented gets a line appended (ordered by name, case-insensitive), so template/blank months also carry every jar. Template Savings lines mint a fresh backing jar per line (`:127-129`) — note built-in templates can therefore create duplicate-name jars across months if used repeatedly (deferred known issue).

**Client ≈ preview** (JarsPage.tsx:121-142): mirrors TargetByDate with browser clock: `remaining = target − base`; base = opening (create) or opening-field + (currentBalance − storedOpening) (edit); months = max(1, monthsToEffectiveDue) or 12 when no date; `Math.round(remaining/months)` minor units. Explicitly approximate ("≈"), may differ from server by a month/cent at boundaries.

**Allocation waterfall** (`IncomeAllocator.Compute`): pool = Σ member NetIncome. Ordered rules deduct from each member's running balance:
- FundEnvelopes/FundJars: ResolvedTotal = month's Σ PlannedAmount of Expense / Savings categories respectively, EXCLUDING categories with `ExcludeFromAllocation` (allocation outputs like "Personal Savings"; the flag is only ever set by the importer and carried by month-copy).
- Split (Equal or ByIncomeRatio): per-member = Round2(total/n) or Round2(total × income/totalNet); **LAST member absorbs the rounding remainder** (exact sum).
- FixedPerMember: each member pays the same fixed amount (step total = amount × n).
- SplitRemainderToMembers (terminal): remainder = Σ balances. If remainder ≤ 0 → keep-own (each keeps their own, possibly negative, leftover). Else BalanceTilt → `BalanceTiltSplit`; Equal/ByIncomeRatio → pooled and `Split()` (PR #162 made these real; keep-own was the old always-behaviour and is what the golden spreadsheet figures Alex 1200.50 / Sam 800.25 anchor).
- BalanceTiltSplit: share = Round2((1−α)·even + α·waterFill), α = clamp(lean,0,100)/100; **rounding drift pushed onto the LARGEST share** (different member than Equal's last-member rule — assert invariants, not exact cents). WaterFill levels the k lowest savings balances to a common level; top tier levelled directly via `FillToLevel` (overflow fix).
- Terminal step SETS balances = shares; `Members[].Residual` reads them back. Hero reconciliation is by construction: terminal total = pool − (envelopes+jars+pocket), so "Shared spending" + "To savings" always = pool (even with negative To savings).

**Member savings balance for tilt** (`AllocationPlanner.SavingsBalancesAsync`): account opening + income − expense + transfers in − transfers out, EXCLUDING transfers whose AllocationKey starts `alloc:{year}-{month}:` for the viewed month (idempotent re-runs; preview == commit view). Only owned, existing accounts.

**Defaults**: AllocationProfile.BalanceLeanPercent = 25; controller default request BalanceLeanPercent = 25; client profile form defaults: split Equal, savings split BalanceTilt, lean "25", name "Household allocation". The client always writes the fixed 4-rule standard waterfall (`standardRules`: envelopes, jars, pocket, remainder — orders 0-3; cost split applied to both envelope and jar rules).

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **SavingsId FK invariant (PR #142)**: `BudgetItems.SavingsId` is an ENFORCED FK → `Jars.Id` on SQL Server. Every Savings-line writer must go through `SavingsLines` (`AddBackingJar` / `AppendJarLine`); minting a bare Guid passes EF InMemory tests but 500s in prod. Enforced-FK writers need a case in `tests/AllotJar.IntegrationTests/` (real mssql; EF InMemory doesn't enforce FKs).
2. **Recurrence is a persisted cycle (W03; PR #149's pure view is retired)**: `RecurMonths int?` replaced `RecurAnnually`; the open cycle lives in `Jar.CycleDeadline`, settlement is lazy (`JarCycles.SettleAsync`) and never rewrites the anchor; the DTO's `Deadline` is the open cycle and `TargetDate` the anchor. Server validators enforce rule 17 through `JarDefinition` (PR #271): a recurring jar needs a target and a date; a goal needs a deadline or a fixed monthly amount; legacy jars with neither read Unscheduled until edited. Regressions to watch: an edit that echoes the open cycle's date (or the anchor) must keep the cycle (`DeadlinesFor`); a passed cycle must never roll without a Funded settlement, a mark-paid or a dismiss; a payment must fulfil at most one cycle; the `JarCycles` migration must leave legacy jars on the cycle the old roll displayed.
3. **Edit replants (rule 46)**: the modal submits the whole definition (kind, target, deadline, method, monthly amount, deadline-month option, cycle); when any schedule input changes, `UpdateJarCommandHandler` rewrites this month's and later months' planned lines through `JarPlanner.ReplantAsync` and leaves past months alone; a rename or an account change replants nothing. The cover window and `OpeningAsOf` columns are gone (W02).
4. **"Saved so far" vs "Opening balance"**: same field, relabelled by mode; edit mode adds "Before tracking began…" helper to stop users retyping the card's live balance (double-count trap).
5. **Two balance flavours**: Jars page = opening + ALL months (incl. future plantings); Budget grid `SavingsAvailable` = ≤ viewed month, NO opening. The jars shelf is current-month-only on the dashboard for exactly this reason.
6. **WaterFill overflow (PR #162 BLOCKER fix)**: ≥2 members with equal/zero savings balances used to throw OverflowException (`k * decimal.MaxValue`) → 500 on preview AND commit for every brand-new couple. Now levelled via `FillToLevel`. High-value regression test.
7. **Dangling savings-account link (PR #162)**: planner nulls links to deleted/foreign accounts; Create/UpdateHouseholdMember validate account exists+owned. Regression: commit writing a broken `Transfer.TransferAccountId` FK → DbUpdateException 500.
8. **Send-savings-to options are real (PR #162)**: Equal/ByIncomeRatio pool the remainder; BalanceTilt default unchanged; keep-own only when remainder ≤ 0.
9. **Rounding-cent placement differs**: `Split` → last member; `BalanceTiltSplit` → largest share. Tests should assert sum-exactness + invariants, not a specific member's cents.
10. **Cancel-reverts (PR #163)**: settings modal Cancel/backdrop resync form from saved profile; committed banner cleared on profile save; commit idempotency wording "replaces them, never doubles up".
11. **InfoHint placement**: the InfoHint `<button>` must NOT sit inside a `<label>` (it becomes the label's control); AllocationPage uses `div` + control `aria-label` (comment at AllocationPage.tsx:374-376), JarsPage uses `<label htmlFor>` sibling pattern.
12. ~~**Allocation commit currency hardcoded EUR**~~ — fixed: the transfer takes the source account's currency, the source must be in the month's base currency and each savings account in the source's currency. W08 also stops a jar being held in an account in another currency than the budget (`JarAccounts.LoadDesignatedAsync`: "{Account} is in {X}, but the budget is in {Y}. Choose an account in {Y}."; `ForeignAmountsTests.A_jar_cannot_live_in_an_account_kept_in_another_currency`).
13. **Idempotency key**: `AllocationKey = "alloc:{year}-{month}:{memberId}"` (W07: moved out of `BankReference` by migration `TransferReturnsFeesAndAllocationKeys`) — note month is NOT zero-padded; the prefix filter depends on this exact composition.
14. **Empty month ≠ balanced (PR #172)**: `IsBalanced` requires `TotalIncome > 0` (domain + client selector); empty-month hero prompts income planning; blank months for jar-owning households land over-budgeted via appended accrual-planned savings lines. Don't regress to bare `remaining == 0`.
15. **PR #170**: sample budget (with its Emergency Fund jar) is OPT-IN at sign-up; default account is empty — jar/allocation tests must not assume a starter jar exists.
16. **Archive**: two-click confirm in the modal (was none pre-#150); archive stops future month lines but keeps history; no restore UI.
17. **ProportionalPool dead in-app**: always €0 (pool args 0), excluded from seeding; only importer-created jars carry it. The Accrual dropdown was removed from the form (PR #149).
18. **Preview clock skew**: the "≈ €X/mo" client preview uses the browser clock vs the server's UTC today — a boundary-day mismatch is by design (prefixed ≈).
19. **Analytics events**: fundCreated/fundEdited (with kind), fundArchived, allocationPreviewed (split), allocationCommitted (count_bucket), navClick.
20. **Server-side solo commit allowed**: the "Add people first" gate is client-only; API-level commit for a 1-member household succeeds (member gets the whole remainder).

---

## 8. File index (read for this map)

Backend:
- `src/AllotJar.Api/Controllers/JarsController.cs`
- `src/AllotJar.Api/Controllers/AllocationController.cs`
- `src/AllotJar.Api/Controllers/FeaturesController.cs`
- `src/AllotJar.Api/Features/FeatureFlags.cs`, `FeatureGateAttribute.cs`
- `src/AllotJar.Application/Jars/Queries/GetJars/GetJarsQuery.cs`, `GetJarsQueryHandler.cs`
- `src/AllotJar.Application/Jars/Commands/CreateJar/CreateJarCommandHandler.cs`, `CreateJarCommandValidator.cs`, `CreateJarCommand.cs`
- `src/AllotJar.Application/Jars/Commands/UpdateJar/UpdateJarCommandHandler.cs`, `UpdateJarCommandValidator.cs`
- `src/AllotJar.Application/Jars/Commands/ArchiveJar/ArchiveJarCommandHandler.cs`
- `src/AllotJar.Application/Jars/Dtos/JarDto.cs` (status + projection mapping)
- `src/AllotJar.Application/Jars/JarBalances.cs`, `SavingsLines.cs`
- `src/AllotJar.Application/Allocation/AllocationPlanner.cs`
- `src/AllotJar.Application/Allocation/Commands/AllocateIncome/AllocateIncomeCommandHandler.cs`, `AllocateIncomeCommand.cs`
- `src/AllotJar.Application/Allocation/Commands/UpsertAllocationProfile/UpsertAllocationProfileCommandHandler.cs`, `UpsertAllocationProfileCommandValidator.cs`
- `src/AllotJar.Application/Allocation/Queries/PreviewIncomeAllocation/PreviewIncomeAllocationQueryHandler.cs`
- `src/AllotJar.Application/Allocation/Queries/GetAllocationProfile/GetAllocationProfileQueryHandler.cs`
- `src/AllotJar.Application/Allocation/Dtos/AllocationProfileDto.cs`, `AllocationResultDto.cs`
- `src/AllotJar.Application/Budgets/Commands/CreateBudgetMonth/CreateBudgetMonthCommandHandler.cs`
- `src/AllotJar.Application/Budgets/Commands/AddBudgetItem/AddBudgetItemCommandHandler.cs`
- `src/AllotJar.Application/Budgets/BudgetActuals.cs` (ApplySavingsBalancesAsync)
- `src/AllotJar.Application/Accounts/Queries/GetAccountReconciliation/GetAccountReconciliationQueryHandler.cs`
- `src/AllotJar.Application/Household/Commands/CreateHouseholdMember/CreateHouseholdMemberCommandHandler.cs`
- `src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`, `Common/Security/AllowLimitedAttribute.cs`
- `src/AllotJar.Domain/Entities/Jar.cs`, `AllocationProfile.cs`, `AllocationRule.cs`, `BudgetMonth.cs` (IsBalanced)
- `src/AllotJar.Domain/Enums/JarKind.cs`, `AccrualMethod.cs`, `AllocationRuleType.cs`, `SplitMethod.cs`
- `src/AllotJar.Domain/Services/JarSchedule.cs`, `IncomeAllocator.cs`; `src/AllotJar.Application/Jars/JarPlanner.cs`
- `src/AllotJar.Infrastructure/Persistence/BudgetSeeder.cs` (opt-in sample seed jar)

Client:
- `client/src/App.tsx` (routes), `client/src/components/AppNav.tsx` (nav gating)
- `client/src/pages/JarsPage.tsx`, `client/src/pages/AllocationPage.tsx`
- `client/src/pages/DashboardPage.tsx` (jars shelf, empty-month hero), `client/src/components/SavingsGroup.tsx`, `client/src/components/Jar.tsx`
- `client/src/lib/jarStatus.ts`, `client/src/lib/money.ts` (parseMinor), `client/src/budgetModel.ts` (isBalanced)
- `client/src/types.ts` (JarKind/AccrualMethod/SplitMethod/AllocationRuleType constants, RECUR_MONTHS_OPTIONS, JarDto)
- `client/src/features/FeatureContext.tsx`, `client/src/features/HouseholdContext.tsx`, `client/src/auth/AuthContext.tsx` (roles)
- `client/src/pages/PeoplePage.tsx` (member savings account)

Existing test surfaces: `tests/AllotJar.Application.Tests/Application/{JarsTests,JarBudgetLinkTests,JarLifecycleTests,AllocationTests}.cs`, `Domain/{JarScheduleTests,IncomeAllocatorTests}.cs`, `Application/JarPlannerTests.cs`; `tests/AllotJar.IntegrationTests/{SavingsForeignKeyTests,AllocationRerunTests}.cs` (real SQL Server); client `*.test.tsx` beside each page; e2e `client/e2e/a11y.spec.ts` (jar modal, axe + 375px). Journeys: `client/e2e-journey/{jars-ledger,money-movement,allocation-commit,budget-lifecycle}.spec.ts` create Goal jars through the real form (a deadline twelve months out, or a fixed monthly amount — rule 17).

Audit notes consulted (memory, verified against code): `jar-flow-audit-2026-07.md`, `allocation-coherence-audit-2026-07.md`.
