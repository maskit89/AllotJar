# Jars (savings)

**ID prefix:** JAR | **Scope:** Everything on the Jars screen at `/jars` (`client/src/pages/JarsPage.tsx`) and the money math behind it: the **Total saved / This month / Active jars** hero; the jar-card grid (jar graphic with clamped fill %, name, status chip, `%` pill, `€X of €Y` balance, progressbar, the month line **Plan · in · to go** and the horizon line, Edit link); the **New jar** / **Edit jar** modal (`JarFormModal`: Name, Type Recurring vs Goal, **Save** = By a deadline | A fixed amount each month, Target, Next due + Repeats | Deadline | Each month, Include the deadline month, Held in — required, non-credit-card, Already set aside + Set aside on) with its client-side and server-side validation and its **schedule preview** (`POST /jars/schedule`); the two-click **Archive** flow; how a jar's **actual balance** is read from its designated account's ledger (`JarLedgerReader` / `ActualSavingsLedger`: initial allocation, same-account moves, expenses from that account on the jar's line — never planned contributions; PR jar-ledger slice, rules 1–6, 26, 68, 70, 73–80); the schedule engine (`Domain/Services/JarSchedule` — TargetByDate: exact split to the month before the deadline, remainder last, deadline-month opt-in, rule 62 clamp; FixedMonthly: fixed amount, capped final month, estimate, ongoing; rules 12–18, 35–36, 58, 62, 82, 86) and the planner that seeds, previews and replants Savings lines from it (`Application/Jars/JarPlanner`, rules 46, 59; W02); the recurrence-as-pure-view invariant (stored anchor never advanced); status derivation (`JarDto` / `lib/jarStatus.ts`); archived-jar exclusion from lists / copy / reconciliation; and the dashboard **Your jars** shelf (`DashboardPage.tsx`, current-month-only). | **Out of scope:** The **Allocation** engine (`/allocation`, `AllocationPage`, allocation profiles, income waterfall, member savings transfers, BalanceTilt/WaterFill) → the allocation sibling file; the budget grid's Savings-group UI (inline rename, add/delete a savings line, `SavingsAvailable` "avail." column rendering) and month create/copy/template mechanics → `08-categories-budget-lines.md` and `07-month-lifecycle.md` (jar-relevant seeding/copy behaviour is asserted here); the **Held in** account's reconciliation panel (Account/Balance/In jars/Float) → `12-accounts-reconciliation.md`; whole-transaction assignment / splits that move jar spend → `10-transactions.md`; the dashboard hero, bills strip and empty-month prompt → `06-dashboard-budget-view.md`; the full role matrix, cross-tab logout, silent refresh → the session & roles sibling files (only jar-page `canWrite` gating and the jar commands' 403/404 appear here); responsive / dark-mode / a11y sweeps live in their own files (referenced only where behaviour is jar-specific, e.g. the modal's 375px fit); the recurring **Deadline missed** lifecycle (W03) is not built yet — a passed recurring date still rolls silently.

**Test data setup:** Unless a case says otherwise, assume an authenticated **Owner** (`canWrite = true`, `canEnterData = true`) of a **shared EUR household "Home"** with **2 members** *Alex* and *Robin*. Today (server UTC and browser clock) is **2026-07-15**, so the app-wide viewed month is **July 2026**, the schedule's planning month is July and its opening balance is the ledger as of **2026-06-30** (rule 82: plain calendar dates; the current month counts until it ends). The `jars` feature flag is **on**; a single EUR account **Joint** exists. By PR #170 a fresh account is **empty** (zero jars, zero months) — cases that need jars/months say so. Money is `decimal(18,4)` server-side and integer minor units at scale 4 (`FACTOR = 10_000`) client-side; a jar's `currentBalance`, `plannedThisMonth`/`contributedThisMonth`/`remainingThisMonth`, `deadline`, `fundingCompletesOn`, `estimatedMonthsToTarget` and `status` are **always derived at read time**, never stored (this month's plan is the saved Savings line when the month exists, else the schedule from the month-start balance). Enum fields (`kind`, `accrual`) go over the wire as **numbers** (JarKind: Recurring=0, Goal=1; AccrualMethod: TargetByDate=1, FixedMonthly=2 — StraightLine/ProportionalPool/DailyRate are retired, rule 86). The modal's amount fields use `parseAmount` → `parseMinor` ('' → 0; strips spaces/apostrophes; right-most of a mixed `,/.` pair is the decimal; rounds HALF-UP beyond 4 dp; rejects negatives / whitespace-only / `abc` / `1.2.3` / `1,2,3` → the modal shows "Enter valid amounts."). Client wiring is exercised by `client/src/pages/JarsPage.test.tsx` and the two `JarsPage.catalog*.test.tsx` files; jar domain/handler behaviour by `tests/AllotJar.Application.Tests/Domain/JarScheduleTests.cs`, `Application/{JarPlannerTests,JarsTests,JarBudgetLinkTests,JarLifecycleTests,JJarsCoverageTests,CreateBudgetMonthTests}.cs`, and the enforced-FK writers by `tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs`.

---

## Jars list, hero, card & empty state (JarsPage)

### JAR-001 - Empty state on first-ever use
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Brand-new opt-out Owner (PR #170 default = empty account); `GET /jars` returns `[]`.
- **Steps:**
  1. Navigate to `/jars`.
- **Expected:** Hero eyebrow "Total saved" with amount **€0.00**; tiles "Monthly" **+€0.00** and "Active jars" **0**. Below it an `EmptyState` titled "No jars yet", description "Add a jar — give it a target and a date, and we'll work out what to set aside each month.", and a "New jar" button (aria-label "New jar", visible text "+ New jar") because Owner is `canWrite`. No "Your jars" section heading.
- **Automated:** Yes (JarsPage.test.tsx — "shows an empty state when there are no funds")

### JAR-002 - List jars with the hero totals
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner with two jars: "Home insurance" (currentBalance 120.00, plannedThisMonth 25.00) and "Holiday" (currentBalance 300.00, plannedThisMonth 50.00).
- **Steps:**
  1. Open `/jars`.
- **Expected:** Hero "Total saved" = **€420.00** (Σ currentBalance), tile "This month" = **+€75.00** (Σ plannedThisMonth, rule 14), tile "Active jars" = **2**. Section heading "Your jars" with a "+ New jar" button; one `JarCard` per jar in a responsive grid.
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-002)

### JAR-003 - Jar card anatomy (balance, of-target, progressbar, month line, horizon)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** One jar "Home insurance" (Recurring, yearly): target 300.00, currentBalance 120.00, plannedThisMonth 25.00, contributedThisMonth 10.00, remainingThisMonth 15.00, deadline 2026-12-01, fundingCompletesOn 2026-11-30, status OnTrack.
- **Steps:**
  1. Open `/jars` and read the card.
- **Expected:** Jar graphic with `aria-label` "Home insurance: 40% funded" (120/300); title "Home insurance"; no status chip (OnTrack is quiet); a `40%` pill; balance line "**€120.00** of €300.00"; a `progressbar` (aria-label "Home insurance funding progress", `aria-valuenow=40`, min 0 max 100) filled 40%; the month line "**Plan €25.00 · in €10.00 · to go €15.00**" (rule 14: three figures, the plan never shrinking because money landed) and under it the horizon "Funded by Nov 2026 · due 1 Dec 2026, then it repeats" (rule 36: the funding-completion month and the deadline it serves are distinct); an "Edit" link (aria-label "Edit Home insurance") because `canManage`.
- **Automated:** Yes (JarsPage.test.tsx — cards + "shows a status chip, this month's plan and the funding horizon")

### JAR-004 - Fill % clamps to 0–100
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Two jars: "Overshoot" (target 100.00, currentBalance 250.00) and "Negative" (target 1000.00, currentBalance −40.00, status Overspent).
- **Steps:**
  1. Open `/jars`.
- **Expected:** "Overshoot" graphic + progressbar clamp at **100%** (pill shows 100%, though the pill is hidden entirely once FullyFunded — see the %-pill case); "Negative" clamps at **0%** (`Math.max(0, …)`), balance renders "−€40.00" in the card. Neither the graphic nor the bar exceeds its track.
- **Automated:** No

### JAR-005 - `%` pill hidden for FullyFunded and target-less jars
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Two jars: "Sofa" (target 300.00, currentBalance 300.00, status FullyFunded) and "Slush" (Goal, target 0.00, no deadline, no monthly amount, currentBalance 500.00, status Unscheduled).
- **Steps:**
  1. Open `/jars`.
- **Expected:** "Sofa" shows the teal "Funded" chip and **no** `%` pill (redundant next to Funded); its balance line shows "€300.00" plus "of €300.00". "Slush" (target ≤ 0) shows **no** `%` pill and **no** "of €…" suffix — just "€500.00"; the amber **Needs a plan** chip and the month line "Add a deadline or a monthly amount to plan contributions" (rule 17).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-005)

### JAR-006 - Status chips: Behind / Overspent / Funded / Needs a plan / Unavailable only
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Jars with statuses OnTrack, Ongoing, Behind (Goal, deadline 2026-01-01), Overspent (currentBalance −40.00), FullyFunded, Unscheduled, Unavailable (balance null).
- **Steps:**
  1. Open `/jars`.
- **Expected:** Chips render only for the states that need attention or celebrating: **Behind** (amber), **Overspent** (rose), **Funded** (teal), **Needs a plan** (amber, Unscheduled), **Unavailable** (neutral). The OnTrack and Ongoing jars show **no** chip (their month line and horizon carry the plan instead). Matches `jarStatusChip` returning null for OnTrack/Ongoing. Status precedence server-side: Unavailable → Overspent → Ongoing → FullyFunded → Unscheduled → Behind → OnTrack (a funded jar reads Funded even with no plan).
- **Automated:** Yes (JarsPage.test.tsx — "shows a status chip, this month's plan and the funding horizon"; lib/jarStatus.test.ts — chip states)

### JAR-007 - Month-line and horizon variants for every state
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Jars covering: (a) a deadline plan in progress (planned 25, in 10, to go 15; funded by Nov 2026, due 1 Dec 2026, recurring); (b) a fixed monthly target (planned 100, estimatedMonthsToTarget 6, no deadline); (c) an ongoing pot (status Ongoing, planned 50); (d) FullyFunded with planned 0 and balance 400 of 300; (e) Unscheduled; (f) Unavailable; (g) OnTrack with planned 0 for another reason.
- **Steps:**
  1. Open `/jars` and read each card's month line and horizon.
- **Expected:** (a) "Plan €25.00 · in €10.00 · to go €15.00" / "Funded by Nov 2026 · due 1 Dec 2026, then it repeats" (a Goal drops ", then it repeats"); (b) "Plan €100.00 · in €0.00 · to go €100.00" / "About 6 more months at this rate (an estimate, not a deadline)" (rule 58); (c) "Plan €50.00 · …" / "Ongoing" (rule 16); (d) "Fully funded · €100.00 above target" (rule 47) and no horizon; (e) "Add a deadline or a monthly amount to plan contributions", no horizon; (f) "Balance not available", no horizon; (g) "Nothing to set aside this month". Never a bare "—".
- **Automated:** Yes (lib/jarStatus.test.ts — jarMonthLabel / jarHorizonLabel variants)

### JAR-008 - Loading state
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; `/jars` request pending.
- **Steps:**
  1. Open `/jars` while the fetch is in flight.
- **Expected:** Plain text "Loading…" (slate) shows; the hero still renders with €0.00 / +€0.00 / 0 until data arrives; no jar cards and no empty state flash before the response resolves.
- **Automated:** No

### JAR-009 - Load failure banner
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `GET /jars` returns 500 (the `/accounts` fetch is separately `.catch`-guarded to `[]`).
- **Steps:**
  1. Open `/jars`.
- **Expected:** An `ErrorBanner` "Could not load your jars." renders above the (empty) content; no cards; the modal is not open. A failing `/accounts` alone does not error the page (accounts default to an empty "Held in" list).
- **Automated:** No

### JAR-010 - Jars are sorted by name
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Jars created out of alphabetical order: "Zoo pass", "Apples", "mittens".
- **Steps:**
  1. Open `/jars`.
- **Expected:** Cards render in `OrderBy(f => f.Name)` order as returned by `GetJarsQuery`. (Server ordering is ordinal; note case handling is the DB collation's — not asserted to a specific casing rule here.)
- **Automated:** No

### JAR-011 - Read-only role hides create/edit and never mounts the modal
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A **Read-only** login of "Home" with existing jars.
- **Steps:**
  1. Open `/jars`.
- **Expected:** Cards render fully (graphic, balance, chip, pace) but with **no** "+ New jar" button and **no** "Edit" link on any card (`canManage` false). The add/edit modal never mounts (`showForm && canWrite`). Hero still shows totals. (Full role matrix lives in the roles sibling file.)
- **Automated:** Partial (RoleGating.test.tsx covers ReadOnly control-hiding broadly; not jar-specific)

---

## Creating a jar (New jar modal)

### JAR-012 - Create a Recurring jar end to end
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner, July 2026 exists; no jars yet.
- **Steps:**
  1. Open `/jars`, click "New jar".
  2. In the dialog type "Vacation" into "Jar name".
  3. Type `1200` into "Target amount".
  4. Leave Type = "Recurring"; set "Next due date" to `2027-06-01`; leave "Repeats" = Yearly.
  5. Click "Add jar".
- **Expected:** A `POST /jars` fires with body containing `name:"Vacation"`, `kind:0`, `targetAmount:1200`, `accrual:1` (TargetByDate), `targetDate:"2027-06-01"`, `recurMonths:12`, `coverStart:null`, `coverEnd:null`, `openingBalance:0`. Modal closes; a "Vacation" card appears; `EVENTS.fundCreated` fires with `{kind:0}`. Server also plants the jar's contribution line into July 2026 and any later existing months (see the CreateJar-planting case under Jar filling).
- **Automated:** Yes (JarsPage.test.tsx — "adds a fund from the New jar modal")

### JAR-013 - Create a Goal jar by a deadline
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → set Type = "Goal" (Save stays on "By a deadline").
  2. Name "New kitchen", Target `5000`, "Deadline" `2027-01-01`.
  3. Click "Add jar".
- **Expected:** The Recurring-only fields ("Next due"/"Repeats") are replaced by the **Save** select ("By a deadline" | "A fixed amount each month") and a "Deadline" input. `POST /jars` sends `kind:1`, `recurMonths:null`, `targetDate:"2027-01-01"`, `accrual:1`, `monthlyContribution:null`, `includeDeadlineMonth:false`. Card "New kitchen" appears; a Goal reads Behind only once past its deadline (Goals never re-arm).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-013; JarsPage.test.tsx — "offers Recurring/Goal …" asserts the Save select and the Deadline/Monthly amount swap)

### JAR-014 - A Goal needs a deadline or a monthly amount — no twelve-month default (rule 17)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → Type "Goal", Name "Buffer", Target `1200`, leave "Deadline" blank; "Add jar".
  2. `POST /jars` directly with `kind:1, targetAmount:1200, targetDate:null, accrual:1`.
- **Expected:** 1: no preview renders and no `/jars/schedule` request is made; the modal shows "Give the goal a deadline, or save a fixed amount each month instead." and nothing is posted. 2: 400 on `TargetDate` — "Give the jar a deadline, or save a fixed amount each month instead." The old "remainder spreads over 12 months" behaviour is gone; a legacy jar in this state plans 0 and reads **Needs a plan** (JAR-005).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-042 for the missing preview; JarLifecycleTests — `Validator_RequiresADeadlinePlan_ForARecurringJar_AndAPlan_ForAGoal`; JarScheduleTests — `Rule17_…_NoTwelveMonthDefault`)

### JAR-015 - "Saved so far" seeds the opening balance on create
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → Name "Car repairs", Target `600`, Type "Goal", "Saved so far" = `150`.
  2. "Add jar".
- **Expected:** The opening field is labelled "**Saved so far**" (create mode, no "Before tracking began…" helper). `POST /jars` sends `openingBalance:150`. The returned card balance = opening + any planted contributions (opening 150 at minimum); fill % reflects 150/600 = 25% before contributions.
- **Automated:** Partial (JarsPage.test.tsx — "labels the opening amount 'Saved so far' on create…" asserts the label; openingBalance value not asserted)

### JAR-016 - Schedule preview phrasing (Recurring vs Goal; deadline vs fixed monthly)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; today 2026-09-27; the server answers `POST /jars/schedule` (P28: the preview is the planner).
- **Steps:**
  1. "New jar" (Type Recurring), Target `300`, "Next due date" `2026-12-01`; read the preview.
  2. Change "Repeats" to every 3 months; read it again.
  3. Switch Type to "Goal" with the same deadline; read it again.
  4. Set Save = "A fixed amount each month", Each month `50`; read it again.
- **Expected:** 1: "Sets aside **€100.00 a month** from Sep 2026 to Nov 2026, funded by 30 Nov 2026 for the deadline on 1 Dec 2026, then it repeats every year." (the months come from the server; the deadline day is not a contribution day, rule 12). 2: "… then it repeats every 3 months." 3: the same sentence without ", then it repeats …". 4: "Sets aside €50.00 a month — about 6 more months to reach the target (an estimate, not a deadline)." (rule 58). Each change re-asks the server with the form's definition (`kind`, `targetAmount`, `targetDate`, `accrual`, `monthlyContribution`, `includeDeadlineMonth`, `recurMonths`, `initialAllocation`, `jarId` null on create) 250 ms after typing stops.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-016; JarsPage.test.tsx — "previews the schedule the server plans as you type" asserts the request body)

### JAR-017 - Preview hides, and nothing is asked, while the definition can't be planned
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal open (Recurring), "Next due date" `2026-12-01`.
- **Steps:**
  1. Leave Target blank, then type `0`, then type `abc`; then `300`.
- **Expected:** No preview and **no** `POST /jars/schedule` in the first three states (empty → 0 → `targetMinor <= 0`; `abc` → `parseMinor` null). Typing `300` brings the preview and one request with `targetAmount:300`. The same gate hides the preview while a recurring jar has no due date, a by-deadline goal has no deadline, a fixed plan has no monthly amount, or the edited jar's balance is unavailable (rule 67).
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-017; JarsPage.catalog.test.tsx — JAR-041 unavailable, JAR-042)

### JAR-018 - Type select shows Recurring/Goal, with no renews checkbox or Accrual dropdown
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 / Accrual dropdown removed, `RecurAnnually` replaced by `RecurMonths` (recurrence became a real, derived concept)
- **Preconditions:** Owner; New-jar modal open.
- **Steps:**
  1. Inspect the "Jar type" select and the surrounding fields.
- **Expected:** "Jar type" offers exactly options "Recurring" and "Goal". There is **no** "Renews each year" checkbox and **no** "Accrual method" dropdown (new jars always save `accrual:1` TargetByDate; imported jars keep their stored method — see the accrual-echo edit case). An InfoHint "About jar types" button sits beside the Type label (not inside the `<label>`).
- **Automated:** Yes (JarsPage.test.tsx — "offers Recurring/Goal as the jar Type and drops the renews checkbox")

### JAR-019 - Type toggle swaps Next-due/Repeats vs Target-date
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; New-jar modal open.
- **Steps:**
  1. With Type = "Recurring", note the fields; select "Goal"; note the change.
- **Expected:** Recurring shows "Next due" (aria "Next due date") + "Repeats" (aria "Repeat cycle") and no method choice (a recurring jar always saves by its due date). Switching to Goal removes "Repeat cycle" and shows the **Save** select (aria "How to save": "By a deadline" | "A fixed amount each month") with a "Deadline" (aria "Deadline") for the default method; choosing the fixed method swaps the Deadline for "Each month" (aria "Monthly amount") and relabels Target "Target (optional)". The already-typed `targetDate` value carries across the type swap (shared form field).
- **Automated:** Yes (JarsPage.test.tsx — "offers Recurring/Goal as the jar Type and drops the renews checkbox")

### JAR-020 - Repeats cycle options
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Owner; New-jar modal, Type "Recurring".
- **Steps:**
  1. Open the "Repeats" select.
- **Expected:** Options are "Yearly" (12), "Every 6 months" (6), "Every 3 months" (3), "Monthly" (1) — from `RECUR_MONTHS_OPTIONS`. Default selected = "Yearly". Chosen value is sent as `recurMonths`.
- **Automated:** No

### JAR-021 - "Held in" account select and no-account helper
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Case A: Owner with account "Joint". Case B: Owner with zero accounts.
- **Steps:**
  1. Open the New-jar modal and inspect "Held in".
- **Expected:** A "Held in" select (aria "Funding account") defaulting to option "No account" then each account name ("Joint"). Selecting "Joint" sends its id as `fundingAccountId`; "No account" sends `null`. Case B: the select shows only "No account" plus helper text "Add accounts to earmark a jar's cash." `fundingAccountId` is a soft hint, not an FK (deleting the account later leaves it dangling — reconciliation just stops counting the jar; see `12-accounts-reconciliation.md`).
- **Automated:** No

### JAR-022 - Jar-types InfoHint copy
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal open.
- **Steps:**
  1. Activate the "About jar types" InfoHint.
- **Expected:** Popover explains **Recurring** ("Saves toward a due date, then repeats: when the date passes, it rolls forward a cycle and keeps going (insurance, road tax, holiday).") and **Goal** ("A one-off savings target — once it's funded, it's done (new kitchen, sofa, wedding)."). The trigger is a `<button>` outside any `<label>`.
- **Automated:** Partial (a11y.spec.ts scans the modal incl. the InfoHint for axe, not the copy)

---

## Create-time validation & boundaries

### JAR-023 - Empty or whitespace-only name is rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; New-jar modal open, Type "Goal", Target `100`.
- **Steps:**
  1. Leave "Jar name" blank and click "Add jar".
  2. Repeat with only spaces ("   ") in "Jar name".
- **Expected:** Both show the modal `ErrorBanner` "Give the jar a name." (client trims: `form.name.trim() === ''`); no `POST` fires in either case. (Server would also reject with "A fund needs a name." if reached.)
- **Automated:** No

### JAR-024 - Non-numeric / negative target is rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; New-jar modal, valid name.
- **Steps:**
  1. Type `-5` (or `abc`, or `1.2.3`) into "Target amount", "Add jar".
- **Expected:** "Enter valid amounts." (`parseAmount` → `parseMinor` returns null for negatives/malformed); no `POST`. The same message covers an unparseable "Saved so far".
- **Automated:** No

### JAR-025 - Recurring jar with target ≤ 0 is blocked client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; New-jar modal, Type "Recurring", name "Road tax".
- **Steps:**
  1. Leave Target blank (parses to 0), set "Next due date" `2027-01-01`, "Add jar".
- **Expected:** "Give the recurring jar a target amount." (create-only guard: `!editingId && kind===Recurring && targetAmount <= 0`); no `POST`. The server itself stays permissive here (see the permissive-server-validators case).
- **Automated:** No

### JAR-026 - Recurring jar with no due date is blocked client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; New-jar modal, Type "Recurring", name "Road tax", Target `150`.
- **Steps:**
  1. Leave "Next due date" empty, "Add jar".
- **Expected:** "Give the recurring jar its next due date."; no `POST`. This guard is form-only — the server accepts date-less recurring jars so importer/legacy jars stay editable (the edit path skips these create-guards).
- **Automated:** Yes (JarsPage.test.tsx — "blocks a recurring jar without a due date, client-side")

### JAR-027 - A Goal with no target saves as an ongoing pot at a fixed monthly amount (rule 16)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, Type "Goal", name "Someday".
- **Steps:**
  1. Save = "A fixed amount each month" (the Target label becomes "Target (optional)"), leave Target blank, Each month `50`, "Add jar".
- **Expected:** Accepted. `POST /jars` sends `kind:1`, `targetAmount:0`, `targetDate:null`, `accrual:2`, `monthlyContribution:50`, `recurMonths:null`. The card reads "Plan €50.00 · in €0.00 · to go €50.00" with the horizon "Ongoing", no `%` pill and no "of €…". Each new month seeds 50 (JarPlannerTests rule 16); a missed month never raises a later one. A target of 0 with **no** monthly amount is refused (JAR-014).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-027; JarScheduleTests — `Rule16_AnOngoingJar_…`; JarPlannerTests — `Rule16_AnOngoingJar_SeedsItsFixedAmount_EveryMonth`)

### JAR-028 - Target with many decimals rounds to 4 dp
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, Type "Goal".
- **Steps:**
  1. Type `100.123456` into "Target amount", "Add jar".
- **Expected:** `parseMinor` rounds HALF-UP to scale 4 → wire `targetAmount:100.1235`. No validation error (value is in range). Card shows the rounded target.
- **Automated:** Partial (lib/money.test.ts — parseMinor >4dp rounding, not on this page)

### JAR-029 - Out-of-range target or over-long name is rejected server-side
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, Type "Goal".
- **Steps:**
  1. Enter a target above 99,999,999,999,999.9999 (e.g. `100000000000000`) and click "Add jar".
  2. Separately, with Target `100`, paste a 121-character name and click "Add jar".
- **Expected:** There is **no client max or length cap**, so both reach the server: the over-range target → 400 "Target amount is out of range."; the 121-char name → 400 (`MaximumLength(120)`). Both surface only as the generic banner "Could not add that jar." (server field text isn't shown on this page). A 120-char name and an in-range target are accepted.
- **Automated:** Partial (JarsTests.cs / BudgetItemCrud — validator rejects out-of-range target and >120-char names server-side; client string mapping not asserted)

### JAR-030 - Unicode / emoji jar name accepted
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, Type "Goal", Target `50`.
- **Steps:**
  1. Name the jar "Café ☕ fund 🎉", "Add jar".
- **Expected:** Accepted and round-tripped verbatim (trimmed only); the card title and any planted savings line carry the exact string. No mojibake.
- **Automated:** No

### JAR-031 - Create request failure shows the add-error banner
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `POST /jars` returns 500.
- **Steps:**
  1. Fill a valid Goal jar and click "Add jar".
- **Expected:** The modal stays open showing "Could not add that jar."; no card is added; `saving` clears (button re-enabled). Edit-mode failures show "Could not save that jar." instead.
- **Automated:** No

---

## Editing a jar (Edit modal & round-trip invariants)

### JAR-032 - Edit prefill and the "Opening balance" relabel
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; jar "Home insurance" (kind Recurring, target 300, targetDate 2026-12-01, recurMonths 12, openingBalance 0, currentBalance 120).
- **Steps:**
  1. Click "Edit Home insurance".
- **Expected:** Modal titled "Edit jar" prefilled: Name "Home insurance", Type "Recurring", Target "300.00", "Next due" 2026-12-01, "Repeats" Yearly. The opening field is labelled "**Opening balance**" (not "Saved so far") with helper "Before tracking began — the card shows the live total." to stop users retyping the card's live €120 (a double-count trap).
- **Automated:** Yes (JarsPage.test.tsx — "labels the opening amount … 'Opening balance' on edit")

### JAR-033 - Rename round-trips via a whole-resource PUT
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; jar "Home insurance".
- **Steps:**
  1. "Edit Home insurance", clear the name, type "Living Costs", click "Save jar".
- **Expected:** `PUT /jars/{id}` with the full body (name "Living Costs" plus every other field echoed); the card updates in place; `EVENTS.fundEdited` fires with `{kind}`. The edit does **not** retro-edit any already-planted budget lines (their names stay as they were).
- **Automated:** Yes (JarsPage.test.tsx — "lets a legacy date-less recurring jar be edited without inventing a date" asserts the rename PUT)

### JAR-034 - Edit echoes the stored deadline-month option (rule 36)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #142 / audit finding #5 (an unrelated edit must not wipe stored schedule inputs) — now about `includeDeadlineMonth`; the cover window it used to protect was dropped with the retired modes (rule 86).
- **Preconditions:** Owner; a jar with `targetDate:2026-12-15`, `includeDeadlineMonth:true`.
- **Steps:**
  1. "Edit" the jar; the "Include the deadline month" box is ticked; change nothing else, click "Save jar".
- **Expected:** `PUT /jars/{id}` body contains `targetDate:"2026-12-15"`, `accrual:1`, `includeDeadlineMonth:true`, `fundingAccountId` unchanged — echoed from the jar, not reset. Nothing is replanted because no schedule input changed (rule 46 / P29).
- **Automated:** Yes (JarsPage.test.tsx — "echoes the stored deadline-month option and account when editing")

### JAR-035 - Edit echoes the stored plan (a fixed monthly method and amount survive a rename)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #149 (the form must send the jar's own accrual, never force the default) — re-based on the two remaining methods.
- **Preconditions:** Owner; a Goal with `accrual:2`, `monthlyContribution:40`, `targetAmount:480`, `targetDate:null`.
- **Steps:**
  1. "Edit" the jar — Save shows "A fixed amount each month" and Each month `40`; rename it, "Save jar".
- **Expected:** `PUT` body has `accrual:2`, `monthlyContribution:40`, `targetAmount:480`, `targetDate:null` alongside the new name; the jar keeps its fixed plan. Only a jar whose Save is switched to "By a deadline" sends `accrual:1` (and then needs a deadline).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-035; JarsPage.test.tsx — "edits a Goal that saves a fixed amount each month")

### JAR-036 - A recurring jar can't be saved without its target and due date (edit included)
- **Priority:** P1
- **Type:** Negative
- **Origin:** PR #149 kept the guards create-only for imported jars; rule 17 (W02) makes the plan mandatory everywhere, so a legacy date-less recurring jar must be given a date (or archived) on its next save.
- **Preconditions:** Owner; a legacy jar kind Recurring, `targetDate:null`, `targetAmount:0`, `recurMonths:12` (reads **Needs a plan**).
- **Steps:**
  1. "Edit" it, rename to "Living Costs", "Save jar". 2. `PUT /jars/{id}` directly with `kind:0, targetDate:null`.
- **Expected:** 1: the modal shows "Give the recurring jar a target amount." (then, with a target, "Give the recurring jar its next due date."); nothing is sent until both are given, after which the save replants its lines (rule 46). 2: 400 on `TargetDate` — "A recurring jar saves toward its next due date." Archiving the jar instead remains available.
- **Automated:** Partial (JarsPage.test.tsx — "blocks a recurring jar without a due date, client-side" exercises the same submit guard on create; JarLifecycleTests — `Validator_RequiresADeadlinePlan_ForARecurringJar_AndAPlan_ForAGoal`)

### JAR-037 - Switching a passed Recurring jar to Goal keeps the real anchor date
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 — the DTO returns the stored anchor (not the rolled date); switching to Goal must keep that anchor and clear the cycle.
- **Preconditions:** Owner; today 2026-07-15; Recurring jar with anchor `targetDate:2026-01-01`, recurMonths 12 (effective due rolled to 2027-01-01 for status, but the DTO/prefill carries 2026-01-01).
- **Steps:**
  1. "Edit" the jar; the "Next due" field shows **2026-01-01** (the anchor, not 2027-01-01).
  2. Switch Type to "Goal"; "Save jar".
- **Expected:** `PUT` sends `kind:1`, `recurMonths:null`, `targetDate:"2026-01-01"` (the anchor is preserved, not a rolled date the user never chose). As a Goal the past-due date now reads Behind (Goals don't re-arm).
- **Automated:** Partial (JarLifecycleTests — anchor never rewritten, switching to Goal clears the cycle; prefill-shows-anchor on the client not asserted)

### JAR-038 - An edit round-trip never advances the anchor date
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 — recurrence is a pure view; a prefill→save with no date change must persist the same anchor.
- **Preconditions:** Owner; past-due Recurring jar, anchor 2026-01-01, recurMonths 12.
- **Steps:**
  1. "Edit" it, change only the Target, "Save jar", reload `/jars`, "Edit" again.
- **Expected:** The stored `targetDate` is still **2026-01-01** after the round-trip — the roll shown in status (effective due 2027-01-01) is never written back. Repeated edit cycles never drift the anchor.
- **Automated:** Yes (JarLifecycleTests.cs — EffectiveDate rolls but the stored anchor is never rewritten)

### JAR-039 - A non-standard recurMonths value is preserved as an extra option
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; a jar with `recurMonths:24` set via the API (not one of the four standard cadences).
- **Steps:**
  1. "Edit" the jar and open the "Repeats" select.
- **Expected:** The select shows the four standard options **plus** "Every 24 months" (the stored value), pre-selected, so a save doesn't silently rewrite 24 → 12. Saving unchanged sends `recurMonths:24`.
- **Automated:** No

### JAR-040 - A stale client omitting recurMonths can't reset a chosen cycle
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #149 — `UpdateJarCommandHandler` falls back `request.RecurMonths ?? stored ?? 12` for Recurring jars.
- **Preconditions:** Owner; Recurring jar with `recurMonths:3`.
- **Steps:**
  1. Send a `PUT /jars/{id}` (Recurring) with `recurMonths` omitted/null (simulating an older client).
- **Expected:** The server keeps the stored **3**, not a reset to 12. (For a Goal, `recurMonths` is always forced to null regardless of the request.)
- **Automated:** Partial (JarLifecycleTests — create stores cycle for Recurring / nulls for Goal; the stale-fallback path is server logic)

### JAR-041 - Edit preview is the server's schedule for the jar's actual balance, re-asked as the definition changes
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; jar "Home insurance" target 300, currentBalance 120, targetDate 2026-12-01, accrual TargetByDate; today 2026-09-27.
- **Steps:**
  1. "Edit" it; read the preview. 2. Change the Target to `900`; read it again. 3. On a new jar, type Target `1200`, Deadline `2026-12-01`, then Already set aside `600`.
- **Expected:** 1: `POST /jars/schedule` with `jarId:"f1"`, `targetAmount:300`, `initialAllocation:0` — the server plans from the jar's balance entering the month (rule 1; there is no opening field to retype) → "Sets aside €60.00 a month from Sep 2026 to Nov 2026 …". 2: a new request with `targetAmount:900` → "€260.00 a month"; the old figure is gone. 3: the create preview sends `jarId:null`, `initialAllocation:600` and the server folds it in (€400.00 → €200.00 a month). With `currentBalance:null` (Unavailable) no preview renders and nothing is asked.
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-041 ×3; JarPlannerTests — `ThePreview_OfAnEdit_StartsFromTheJarsBalanceEnteringTheMonth_AndOfANewJar_FromWhatIsSetAside`)

### JAR-042 - No preview without a deadline or a monthly amount; either one brings it (rule 17)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; a legacy Goal with `targetAmount:300`, `targetDate:null`, `accrual:1` (Unscheduled).
- **Steps:**
  1. "Edit" the jar and change the Target to `900`. 2. Set Save = "A fixed amount each month", Each month `50`. 3. Set Save back to "By a deadline" and a Deadline `2026-12-01`.
- **Expected:** 1: **no** preview and no `/jars/schedule` request — there is nothing to plan. 2: a request with `accrual:2`, `monthlyContribution:50`, `targetDate:null` → "Sets aside €50.00 a month — about 4 more months to reach the target (an estimate, not a deadline)." 3: a request with `accrual:1`, `targetDate:"2026-12-01"` → the deadline schedule.
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-042)

### JAR-043 - Edit save failure keeps the modal open
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `PUT /jars/{id}` returns 500.
- **Steps:**
  1. "Edit" a jar, change the name, "Save jar".
- **Expected:** Modal stays open with "Could not save that jar."; the card is unchanged (no optimistic replace happens — the list updates only from the response); `saving` clears.
- **Automated:** No

---

## Archiving jars

### JAR-044 - Two-click archive from the edit modal
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #150 — Archive gained a two-click confirm (was a single unconfirmed click).
- **Preconditions:** Owner; jars "Home insurance" and "Holiday".
- **Steps:**
  1. "Edit Home insurance"; click the footer "Archive jar" (aria "Archive Home insurance").
  2. It changes to "Really archive?" (aria "Confirm archive Home insurance"); click it.
- **Expected:** The first click only arms the button (no request); `PUT /jars/{id}/archive` with body `{archived:true}` fires on the second click. Modal closes; the "Home insurance" card disappears from the list; `EVENTS.fundArchived` fires. "Holiday" remains.
- **Automated:** Yes (JarsPage.test.tsx — "archives a fund from its edit modal", asserts no PUT on the first click)

### JAR-045 - Archived jar is dropped from the list and default GET
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; one jar archived, one active.
- **Steps:**
  1. Open `/jars`.
- **Expected:** Only the active jar renders; hero "Active jars" counts active jars only. `GET /jars` (no `includeArchived`) excludes archived rows server-side. There is **no** UI to list or restore archived jars — restore is API-only (`PUT …/archive` with `{archived:false}`).
- **Automated:** Yes (JarsTests.cs — get is owner-scoped and excludes archived)

### JAR-046 - Archive request failure shows the archive-error banner
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `PUT /jars/{id}/archive` returns 500.
- **Steps:**
  1. "Edit" a jar, arm and confirm "Really archive?".
- **Expected:** The modal shows "Could not archive that jar."; the jar stays in the list; `saving` clears.
- **Automated:** No

### JAR-047 - Archived jar is skipped by month copy but a dangling SavingsId is not
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 — copy drops lines backed by a genuinely-archived jar (keyed on archived jar ids), but a dangling SavingsId with no jar row still copies.
- **Preconditions:** Owner; June 2026 has a savings line backed by jar "Old car" (now archived) and one backed by a dangling SavingsId (no jar row).
- **Steps:**
  1. From July's not-found screen (or via `POST /budget` copy), create July 2026 by copying June.
- **Expected:** The copied July month **omits** the archived "Old car" line but **keeps** the dangling-SavingsId line. Archived jars are also excluded from the "append a line for every active jar" step. (Month-create mechanics live in `07-month-lifecycle.md`; this asserts the jar-archival interaction.)
- **Automated:** Yes (CreateBudgetMonthTests.cs — copy skips lines funding archived jars; dangling id still copies)

### JAR-048 - Archived jar is excluded from account reconciliation
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; account "Joint"; jar "Old car" (fundingAccountId = Joint) archived, jar "New tyres" (fundingAccountId = Joint) active.
- **Steps:**
  1. Open `/accounts` and read the Jar reconciliation panel.
- **Expected:** Only "New tyres" contributes to Joint's `BackedJarsTotal`; the archived "Old car" is excluded (and its Float impact vanishes). (Reconciliation math detail lives in `12-accounts-reconciliation.md`.)
- **Automated:** Partial (AccountReconciliationTests.cs — backed-jar vs float; archived exclusion covered there)

### JAR-049 - Cancel from the edit modal without archiving
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Owner; jar "Holiday".
- **Steps:**
  1. "Edit Holiday", click "Archive jar" (it arms to "Really archive?"), then click "Cancel".
- **Expected:** Modal closes with no `PUT` of any kind; the jar remains; re-opening the modal shows the Archive button reset to "Archive jar" (`confirmArchive` cleared on close).
- **Automated:** No

---

## Jar filling, balance & accrual math (money integrity)

### JAR-050 - CreateJar plants a contribution line in the current and future months
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; months June 2026 (past), July 2026 (current), August 2026 (future) exist; no jars yet.
- **Steps:**
  1. Create a Goal jar "Boiler" target 1200, no date.
- **Expected:** A backing savings line for "Boiler" is appended to **July and August** (current + future), into each month's first Savings group (creating a "Savings" group at DisplayOrder 0 if none). **June is untouched** (history). Each month's planned amount = `RequiredMonthlyContribution` recomputed with earlier plantings folded into the balance. The returned card `balance = opening + Σ planted`, matching the next `GET`.
- **Automated:** Yes (JarBudgetLinkTests.cs — CreateJar plants current+future, creates the Savings group when missing, leaves past months untouched, works with no months; SavingsForeignKeyTests.cs — CreateJar_PlantsSavingsLineInTheCurrentMonth on real SQL)

### JAR-051 - Adding a Savings-group budget line mints a backing jar
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #142 — every `BudgetItems.SavingsId` is an enforced FK to `Jars.Id`; a savings line writer must go through `SavingsLines.AddBackingJar`, never a bare Guid.
- **Preconditions:** Owner; July 2026 with a Savings group "Sinking Funds".
- **Steps:**
  1. On the dashboard, in the Savings group, use "+ Add a savings goal", type "Christmas", "Add".
- **Expected:** A new Jar named "Christmas" (Kind Goal, Accrual TargetByDate, target 0, open-ended) is minted server-side and linked as the line's `SavingsId`; it then appears on `/jars`. Adding a line to an **expense** group mints no jar. (The grid UI itself is covered in `08-categories-budget-lines.md`; this asserts the jar side + FK invariant.)
- **Automated:** Yes (JarBudgetLinkTests.cs — AddItem to Savings creates the jar, expense group creates none; SavingsForeignKeyTests.cs — AddBudgetItem_ToSavingsGroup_PersistsLineBackedByAJar)

### JAR-052 - Jar balance = opening + all planned − all spend, across every month
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; jar "Gifts" opening 50.00, linked savings line planned 30.00 in each of June/July 2026, and a €20.00 expense transaction assigned to July's "Gifts" line.
- **Steps:**
  1. Open `/jars` and read the "Gifts" balance.
- **Expected:** `currentBalance` = 50 + (30 + 30) − 20 = **€90.00** (`OpeningBalance + Σ planned across ALL months − Σ assigned expense spend, at FX`). Split slices assigned to the line count too; transfers never do.
- **Automated:** Yes (JarsTests.cs / SavingsTests.cs — balance = opening + contributions − spend)

### JAR-053 - Jars-page balance vs budget-grid "avail." differ by the opening balance / future lines
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; jar "Gifts" opening 50.00, one savings line planned 30.00 in July 2026, none earlier, none spent; viewing July.
- **Steps:**
  1. Compare the "Gifts" balance on `/jars` with the "avail." shown on the July budget-grid savings line.
- **Expected:** `/jars` `currentBalance` = 50 + 30 = **€80.00** (includes opening + all months). The grid `SavingsAvailable` = **€30.00** (planned−spent over months ≤ viewed, **excluding** OpeningBalance). The two legitimately differ by the €50 opening — a known two-flavour design, and exactly why the dashboard shelf is current-month-only.
- **Automated:** Partial (SavingsTests.cs — grid balance counts months ≤ viewed and excludes opening; the cross-check is design-level)

### JAR-054 - Deadline schedule: exact split over the contribution months, remainder last; whole remainder when due now or passed; nothing when funded
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Owner; today 2026-07-15 (planning month July). Jars: (a) target 600, due 2027-01-01, balance 0; (b) target 1,000, due 2027-01-01, balance 0; (c) target 300, due 2026-07-20 (this month), balance 0; (d) target 500, balance 500 (funded); (e) target 1,200, no deadline, `accrual:1`; (f) target 300, due 2026-12-15, balance 0, `includeDeadlineMonth` false then true.
- **Steps:**
  1. Read each jar's schedule (`POST /jars/schedule`) and this month's plan.
- **Expected:** (a) six contribution months Jul→Dec: **100.00** each (rule 12: the deadline day is not a contribution day). (b) 1,000 ÷ 6 floored to the cent = 166.66 ×5 and **166.70** last (rule 35: the months sum exactly; no extra month for the cents). (c) a deadline this month plans the whole remainder now: **300.00** in July (one month, never zero). (d) remaining ≤ 0 → nothing planned, status FullyFunded. (e) **0.00**, status Unscheduled — no ÷12 (rule 17). (f) default Jul→Nov, 60.00 each, funded by 30 Nov 2026; with the opt-in Jul→Dec, 50.00 each, funded by 31 Dec 2026 (rule 36). A recurring date already passed plans toward the next cycle (rule 62 clamps a 31st to a shorter month's last day without losing the 31st).
- **Automated:** Yes (Domain/JarScheduleTests.cs — rules 12, 13, 35, 36, 62, due-now/passed, funded, overspent, rule 17)

### JAR-055 - Server validators require a plan (rule 17) and stay lenient elsewhere
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 kept the validators permissive for imported jars; W02 (rule 17/86) makes the plan mandatory while leaving dates and amounts otherwise free.
- **Preconditions:** Owner; craft `POST /jars`, `PUT /jars/{id}` and `POST /jars/schedule` requests directly (bypassing the form; all three share `JarDefinition`).
- **Steps:**
  1. Kind Recurring with `targetDate:null`; kind Recurring with `accrual:2`. 2. Goal `accrual:1` with `targetDate:null`; Goal `accrual:1` with `targetAmount:0`. 3. Goal `accrual:2` with `monthlyContribution:0`; Goal `accrual:2` with a `targetDate`. 4. A past `targetDate`; `accrual:0` or `3`; `recurMonths:121`.
- **Expected:** 1: 400 "A recurring jar saves toward its next due date." / "A recurring jar saves toward its next due date." (a recurring jar is always by deadline). 2: 400 "Give the jar a deadline, or save a fixed amount each month instead." / "A deadline needs a target amount to save toward." 3: 400 "Enter the amount to set aside each month." / "A fixed monthly plan has no deadline. Remove the date, or save by the deadline instead." 4: a past date is **accepted** (the whole remainder is planned now, or the recurring jar rolls); an unknown accrual → "Choose how to save: by a deadline, or a fixed amount each month."; `recurMonths` must be 1–120. Name (non-empty, ≤120), account and amount-range rules are unchanged.
- **Automated:** Yes (JarLifecycleTests — `Validator_RequiresADeadlinePlan_ForARecurringJar_AndAPlan_ForAGoal`; JJarsCoverageTests / JarsTests validator cases)

### JAR-056 - Past-due Recurring jar re-arms and reads OnTrack, not Behind
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 — `JarSchedule.EffectiveDeadline` rolls a Recurring anchor forward whole cycles from the stored anchor; a healthy recurring jar never reads Behind. (W03 will replace the silent roll of an unfunded cycle with the persistent **Deadline missed** state, rule 20.)
- **Preconditions:** Owner; today 2026-07-15; Recurring jar anchor 2026-01-01, recurMonths 12, not yet fully funded.
- **Steps:**
  1. Read the jar's status and month line on `/jars`.
- **Expected:** Effective due rolls to **2027-01-01**; status = **OnTrack** (no chip), and the contribution spreads over the months to the month before the rolled date (not "the whole remainder this month"). The day-of-month is preserved across the roll (a 31st never drifts to the 28th, rule 62).
- **Automated:** Yes (JarLifecycleTests.cs — past-due recurring reads OnTrack not Behind; JarScheduleTests — `ARecurringJar_PlansTowardItsNextCycle_OnceTheDateHasPassed`, `Rule62_AShorterMonth_ClampsOnlyThatOccurrence_AndKeepsTheIntendedDay`)

### JAR-057 - Past-due Goal stays Behind; funded Goal is Funded
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; today 2026-07-15. Goal (a) target 500, date 2026-01-01, balance 200; Goal (b) target 500, date 2026-01-01, balance 500.
- **Steps:**
  1. Read each Goal's status.
- **Expected:** (a) Goals never re-arm → effective due 2026-01-01 < today and remaining > 0 → **Behind** (amber chip). (b) remaining == 0 → **FullyFunded** (teal "Funded"): FullyFunded is evaluated before Behind, so a fully-funded past-due Goal reads Funded, not Behind.
- **Automated:** Yes (JarLifecycleTests.cs — past-due Goal stays Behind; funded Goal = FullyFunded)

### JAR-058 - Overspent status when the balance goes negative
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; jar "Holiday" target 1000, whose linked line has more assigned expense spend than planned, driving `currentBalance` to −40.00.
- **Steps:**
  1. Read the "Holiday" card.
- **Expected:** Status = **Overspent** (rose chip); `currentBalance < 0` is the highest-priority status branch after Unavailable (ahead of Ongoing/FullyFunded/Unscheduled/Behind). Fill % clamps to 0; balance renders "−€40.00"; the month line still shows the plan — an overspent jar plans its shortfall into the remaining contribution months (JarScheduleTests — `AnOverspentJar_PlansTheShortfallTooIntoTheRemainingMonths`) — or "Nothing to set aside this month" when nothing is planned.
- **Automated:** Yes (JarsTests.cs — status Overspent when negative; JarsPage.test.tsx renders an Overspent jar)

### JAR-059 - Backfilling an earlier month seeds the jar from its as-of balance
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 — `JarBalances.ComputeAsync(asOf:(Year,Month))` counts only months strictly before the target, so a back-filled month isn't zeroed out by later savings.
- **Preconditions:** Owner; jar "Roof" with contributions already recorded in Aug–Dec 2026; no July 2026 month yet.
- **Steps:**
  1. Create July 2026 (blank or copy).
- **Expected:** July's seeded "Roof" line uses the balance **as it stood entering July** (only months before July count), not the all-time balance — so a backfill can't be starved by later contributions. StraightLine/DailyRate seeds ignore balance; ProportionalPool jars are excluded from seeding entirely (always €0 in-app).
- **Automated:** Yes (CreateBudgetMonthTests.cs — backfilled month seeds jar from as-of-that-month balance)

---

## Jars shelf on the dashboard

### JAR-060 - Shelf shows on the current month only
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 — the shelf shows today's all-time balances, so it renders only when the viewed month is the current calendar month.
- **Preconditions:** Owner; viewed month = July 2026 (current); ≥1 jar with a balance.
- **Steps:**
  1. Open `/` on July 2026.
- **Expected:** A "Your jars" card renders with "{total} saved" and one jar graphic each (`label` "{name}: {pct}% of goal"), name, balance, then a status chip **or** "+€X/mo" (chip wins). No edit affordances on the shelf.
- **Automated:** Partial (a11y.spec.ts scans the shelf; DashboardPage.test.tsx does not assert the shelf specifically)

### JAR-061 - Shelf is hidden on past/future months
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; ≥1 jar; navigate to June 2026 (past) and August 2026 (future).
- **Steps:**
  1. Use the month navigator to view June, then August.
- **Expected:** No "Your jars" shelf on either — it would contradict a non-current month's month-scoped savings lines with all-time balances. The hero, bills strip and groups still render.
- **Automated:** No

### JAR-062 - Shelf chip beats the monthly pace line
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Owner; current month; jars: one Overspent (has a chip), one OnTrack with plannedThisMonth 25.
- **Steps:**
  1. Open `/` and read the shelf entries.
- **Expected:** The Overspent jar shows the rose "Overspent" chip (no "+€/mo"); the OnTrack jar shows "**+€25.00/mo**" (no chip). A jar with both a chip candidate and a positive monthly shows only the chip.
- **Automated:** No

### JAR-063 - Shelf absent with no jars; no-month note mentions jar carry-over
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Case A: current month, zero jars. Case B: no budget for the month yet, but the household owns ≥1 jar.
- **Steps:**
  1. Case A: open `/` on the current month. Case B: open `/` on a monthless month (create screen).
- **Expected:** Case A: no "Your jars" card. Case B: the create screen shows the note "Your {n} existing {jar is|jars are} added to any new budget automatically, so it will have a few more lines than a template lists." (A blank/template month for a jar-owning household is then born over-budgeted via appended accrual-planned savings lines — see `06-dashboard-budget-view.md`.)
- **Automated:** No

---

## Server API, permissive validators & feature gating

### JAR-064 - The cover window is gone with the retired modes (rule 86)
- **Priority:** P3
- **Type:** Regression
- **Origin:** W02 — StraightLine/DailyRate/ProportionalPool and their `CoverStart`/`CoverEnd` columns were retired; the `JarSchedules` migration drops the columns and moves every jar to TargetByDate.
- **Preconditions:** Owner; craft a `POST`/`PUT` jar carrying `coverStart`/`coverEnd` (any values) alongside a valid definition.
- **Steps:**
  1. Submit the request; read the jar back.
- **Expected:** The unknown properties are ignored by model binding; the jar is saved from its definition alone and the DTO has no cover fields. There is no "Cover end must be after cover start." rule any more. `tools/AllotJar.Importer`, which wrote those fields, is outside the solution and no longer compiles (HANDOVER O6).
- **Automated:** Partial (JarsTests / JJarsCoverageTests validator cases without a window; the migration is exercised by CI's SQL integration job)

### JAR-065 - RecurMonths out of [1,120] is rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; craft requests with `recurMonths` = 0, 121, and 120.
- **Steps:**
  1. Submit each.
- **Expected:** 0 and 121 → 400 "Repeat cycle must be between 1 and 120 months."; 120 accepted. The rule applies only when `recurMonths` has a value (Goals send null and skip it).
- **Automated:** Partial (JarLifecycleTests.cs — repeat cycle bounded)

### JAR-066 - Negative opening balance is allowed
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; craft a jar with `openingBalance:-100`.
- **Steps:**
  1. Submit the create.
- **Expected:** Accepted — opening balance may be negative (range is [−max, +max]); only out-of-range magnitudes give "Opening balance is out of range." (The modal's `parseAmount` rejects a negative *typed* value, so this path is API/importer-only.)
- **Automated:** Partial (JarsTests.cs — validator amount ranges)

### JAR-067 - No DELETE endpoint; unknown id 404s
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; a random/unknown jar id.
- **Steps:**
  1. Attempt `PUT /jars/{unknownId}` (or `…/archive`).
- **Expected:** 404 with body message "Sinking fund {id} was not found." There is **no** `DELETE /api/jars/{id}` route at all — jars are only soft-archived. (Deleting a savings budget line does not delete/archive its jar; the jar re-appends on the next month create.)
- **Automated:** Partial (JarsTests.cs — update/archive not-found + ownership throws)

### JAR-068 - Editing another household's jar is forbidden
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Two households; a jar id owned by household B; acting as household A's Owner.
- **Steps:**
  1. `PUT /jars/{B-jar-id}` (or `…/archive`).
- **Expected:** 403 (ownership mismatch, after the row is found). `GET /jars` only ever returns the caller's own jars. (Cross-tenant depth lives in the households sibling; this confirms the jar handlers re-check `OwnerId`.)
- **Automated:** Yes (JarsTests.cs — update/archive ownership throws)

### JAR-069 - Jars feature flag off hides the nav, unregisters the route, 404s the API
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; `GET /api/features` returns `jars:false`.
- **Steps:**
  1. Load the app; check the nav; try to reach `/jars` by URL; call `GET /api/jars`.
- **Expected:** The "Jars" nav link is hidden; the `/jars` route is unregistered so the SPA redirects `*` → `/`; every `/api/jars` endpoint returns **404** via `[FeatureGate]`. (Client defaults all flags ON until `/features` resolves, so a brief flash before the flag arrives is possible.) Note the dashboard's own `/jars` fetch for the shelf ignores this flag and just leaves the shelf empty on failure.
- **Automated:** Partial (AppNav.test.tsx — nav items hidden when flags off; server FeatureGate 404 not unit-tested)

### JAR-070 - New-jar modal fits a phone screen without horizontal scroll
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; 375×812 viewport.
- **Steps:**
  1. Open `/jars`, click "New jar".
- **Expected:** The modal and its two-column field grid fit within 375px (`scrollWidth <= clientWidth + 1`); no page-level horizontal scroll. (General responsive sweeps live in the responsive/a11y sibling; this is the one jar-modal-specific guard.)
- **Automated:** Yes (mobile-layout.spec.ts — the New-jar modal fits a phone screen; a11y.spec.ts — modal axe scan at 375px, both themes)

---

## Gap-fill additions

### JAR-071 - Restore an archived jar via `PUT …/archive {archived:false}`
- **Priority:** P1
- **Type:** Regression
- **Origin:** gotcha — `ArchiveJarCommandHandler` does `fund.IsArchived = request.Archived` (a set-to-value, not a blind flip) and `ArchiveJarRequest`/`ArchiveJarCommand` both default `Archived = true`, so the endpoint doubles as restore; every existing case only exercises the archive direction (JAR-044…049 send `{archived:true}` or the default). A regression where `{archived:false}` fails to clear `IsArchived` — or where restore doesn't re-enter the list/reconciliation/copy — is invisible to the current catalog. There is **no** UI restore control (restore is API-only, JAR-045).
- **Preconditions:** Owner of "Home"; account "Joint"; jar "Old car" (fundingAccountId = Joint) currently **archived** (`IsArchived:true`), plus active jar "New tyres"; months July 2026 (current) and August 2026 (future) exist.
- **Steps:**
  1. Confirm the baseline: `GET /jars` (no query) returns only "New tyres"; the `/jars` hero "Active jars" reads **1**.
  2. Send `PUT /jars/{OldCarId}/archive` with body `{"archived":false}`.
  3. Re-read `GET /jars` (default) and the hero; open `/accounts`; then create/copy a later month.
- **Expected:** 200 with the jar's `JarDto`; the handler sets `IsArchived = false` (the requested value, not a toggle — a second `{archived:false}` is idempotent) and re-derives `currentBalance`/`requiredMonthlyContribution`/`status` at read time (`fund.ToDto(balance, required, asOf)`), so the response carries `isArchived:false`. "Old car" now reappears in the **default** `GET /jars` (handler `Where` = `IncludeArchived || !IsArchived`), is re-counted in the "Active jars" hero (back to **2**), re-enters account reconciliation so its earmarked cash again feeds Joint's `BackedJarsTotal`/Float (inverse of JAR-048), and its contribution line is again seeded/carried on the next month create or copy (inverse of JAR-047 — no longer keyed out as an archived jar). Ownership is still enforced (403 for another household's jar id, 404 for an unknown id — JAR-067/068 apply to this route too).
- **Automated:** No (JarsTests.cs `Archive_HidesFromDefaultList` only calls `ArchiveJarCommand(fundId)` with the default `Archived=true`; the `archived:false` restore leg has no test; 21-feature-interactions.md CMB-026 restores a **member**, not a jar, and does not hit this endpoint)

### JAR-072 - `GET /jars?includeArchived=true` returns archived jars too (API-only)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner of "Home" with one archived jar "Old car" (`IsArchived:true`) and one active jar "New tyres"; call the endpoint directly — no UI path passes this flag (`JarsPage` and the dashboard shelf both fetch `GET /jars` with **no** `includeArchived`).
- **Steps:**
  1. `GET /jars` (default) and note the returned jars.
  2. `GET /jars?includeArchived=true` and compare.
- **Expected:** The default call returns **only** "New tyres" (archived rows excluded — JAR-045). With `includeArchived=true` the `[FromQuery] bool includeArchived` binds through to `GetJarsQuery(includeArchived)`, whose `Where` becomes `IncludeArchived || !IsArchived`, so **both** "Old car" and "New tyres" are returned, still owner-scoped and still `OrderBy(Name)` across the merged set. The archived jar is **not** special-cased: it carries `isArchived:true` and its `currentBalance`/`requiredMonthlyContribution`/`status` are derived normally (`JarBalances.ComputeAsync` spans all of the owner's jars). This mirrors the members-side PPL-025 (an archived row fetched with `includeArchived` keeps its computed figures); it is purely an API-surface concern — the Jars hero, card list and dashboard shelf never request archived jars, so their totals stay active-only.
- **Automated:** Partial (JarsTests.cs `Get_IsOwnerScoped_AndExcludesArchivedByDefault` asserts `GetJarsQuery(IncludeArchived: true)` returns both rows at the handler level; the controller's `[FromQuery] bool includeArchived` route binding is not asserted over HTTP)

## Jar ledger: actual balances, allocations and moves (rules 1–6, 26, 68, 70, 73–80)

Cases from the jar-ledger slice. `currentBalance` is **actual money** — `null` when the account's balance is unavailable (rule 67) — and planned contributions never count. JAR-015 (opening balance) and JAR-021 ("No account") are superseded here.

### JAR-073 - A jar cannot be created without an account
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Owner with no accounts.
- **Steps:**
  1. Open "New jar".
- **Expected:** The "Held in" select has no "No account" option; the modal says "Add an account first — a jar's money is held in an account" with a link to `/accounts` and the Add button is disabled. Server-side, `POST /jars` without `fundingAccountId` returns 400 "Choose the account this jar's money is held in." (rule 73). A credit-card account is not offered and is refused by the server (rule 75).
- **Automated:** Yes (JarsPage tests; CreateJar validator/handler tests)

### JAR-074 - "Already set aside" divides the account's unallocated money
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Account "Savings" opened 2026-01-01 with 1,000; no jars.
- **Steps:**
  1. "New jar" → "Holiday", Target 2,000, Held in Savings, Already set aside 400, Set aside on today.
- **Expected:** `POST /jars` sends `fundingAccountId`, `initialAllocation: 400`, `initialAllocationDate`. The card shows **€400.00** and "Held in Savings"; `GET /jars/ledger` shows Savings balance 1,000, Holiday 400, unallocated 600 (rule 77). The account balance is unchanged — nothing was deposited.
- **Automated:** Yes (JarLedgerActivationTests; jars-ledger journey)

### JAR-075 - Setting aside more than is unallocated, or before the account opened, is refused
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** As above, but Holiday already holds 400 (unallocated 600).
- **Steps:**
  1. Create "Car" with Already set aside 700. 2. Create "Car" with Set aside on 2025-12-31.
- **Expected:** 400 with the unallocated figure and date in the message (rule 68); 400 "opens on 2026-01-01" (rule 40). Nothing is persisted either time.
- **Automated:** Yes (JarLedgerActivationTests)

### JAR-076 - Planned contributions do not fill a jar
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Holiday holds 400; its July line plans 200.
- **Steps:**
  1. Open `/jars` and the July budget.
- **Expected:** The card still shows €400.00 and the budget line's Available shows €400.00 — the 200 is a plan (rule 1). Only an allocation, a move or a jar-line payment changes the balance.
- **Automated:** Yes (JarLedgerActivationTests — planned contributions never count)

### JAR-077 - A payment from the jar's account on its line reduces the jar; from another account it is refused
- **Priority:** P0
- **Type:** Happy / Negative
- **Preconditions:** Holiday 400 in Savings; account "Current" also exists.
- **Steps:**
  1. Record expense 150 from Savings, assigned to the Holiday savings line. 2. Record expense 50 from Current assigned to the Holiday line. 3. Record expense 30 from Savings with no line.
- **Expected:** 1: Holiday 250, Savings unallocated unchanged (rule 79). 2: 400 "'Holiday' is the jar Holiday, whose money is held in Savings. Record this payment from Savings so it comes out of the jar." (rules 2/4). 3: unallocated falls by 30; Holiday unchanged.
- **Automated:** Yes (JarLedgerActivationTests; TransactionInvariants tests)

### JAR-078 - Move money within one account (rules 6, 68, 70)
- **Priority:** P0
- **Type:** Happy / Negative
- **Preconditions:** Savings 1,000: Holiday 250, Car 300, unallocated 450.
- **Steps:**
  1. "Move money from Holiday": From Holiday, To Car, 100, today. 2. From unallocated, To Holiday, 200. 3. From Holiday, To Car, 500.
- **Expected:** 1: `POST /jars/reallocations {accountId, sourceJarId: Holiday, destinationJarId: Car, amount: 100, date}` → Holiday 150, Car 400, unallocated 450, account still 1,000. 2: `sourceJarId: null` → Holiday 350, unallocated 250. 3: 400 "Holiday can give at most 350.00 …" (rule 68). A move is never a bank transfer; choosing a jar held in another account is refused with a pointer to the Transactions page (rule 7).
- **Automated:** Yes (JarReallocationTests; MoveMoneyModal tests)

### JAR-079 - Positive jars must be backed by account money (rule 70)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Savings 500: Holiday 100, Repairs 400. A 150 payment from Savings on the Holiday line is recorded → account 350, Holiday −50, Repairs 400.
- **Steps:**
  1. Open `/jars` and `/accounts`. 2. Move 50 from Repairs to Holiday.
- **Expected:** 1: the account shows "Jars exceed account money" (positive jars 400 > 350) on the Jars page summary and the reconciliation row (`hasBackingDeficit`). Holiday shows −€50.00 "Overspent"; nothing is hidden or auto-fixed. 2: Holiday 0, Repairs 350, account 350; the flag clears. A move that would leave positive jars above the balance is refused.
- **Automated:** Yes (JarReallocationTests; AccountsPage reconciliation tests)

### JAR-080 - Archiving needs a zero balance; the account can only change at zero
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Holiday holds 350.
- **Steps:**
  1. Edit Holiday → Archive jar → confirm. 2. Edit Holiday → Held in "Current" → Save. 3. Move 350 to unallocated, then repeat 1.
- **Expected:** 1: 400 "Holiday still holds 350.00. Move it to another jar or to unallocated funds before archiving." (rule 26). 2: 400 "Holiday holds 350.00 in Savings. Move that money first …" (rule 80); the field change never moves money. 3: archived; the jar's history stays in Savings.
- **Automated:** Yes (JarLedgerActivationTests; jars-ledger journey)

### JAR-081 - Past months show the jar's balance at that month end (rule 48); before the account opened it is unavailable (rule 67)
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Savings opened 2026-03-01 with 1,000; Holiday set aside 400 on 2026-03-10; a 100 payment from Savings on the Holiday line dated 2026-04-05.
- **Steps:**
  1. View the March budget. 2. View the April budget. 3. View the February budget (if it exists).
- **Expected:** March Available €400.00; April €300.00; February "Not available" (the account had no balance before its opening date). `GET /jars?asOf=2026-03-31` returns 400 for Holiday.
- **Automated:** Yes (JarLedgerActivationTests — BudgetActuals month-end and unavailable cases)

### JAR-082 - Savings groups offer "Add jar", not a bare line
- **Priority:** P1
- **Type:** Happy / Negative
- **Preconditions:** July budget with a Savings group; account Savings exists.
- **Steps:**
  1. In the Savings group click "Add jar" and complete the jar form. 2. `POST /budget/categories/{savingsGroupId}/items {name:"Loose"}` directly.
- **Expected:** 1: the same modal as the Jars page; `POST /jars` creates the jar and plants its line in July and later months; the group refreshes with the new line. 2: 400 "A savings line is a jar. Create the jar, choosing the account that holds its money …" (rule 73).
- **Automated:** Yes (DashboardPage tests; AddBudgetItem handler test)

### JAR-083 - The preview lists each month's amount, with the rounding remainder visibly in the last month (rule 35)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; New-jar modal (Recurring), Target `100`, Next due `2026-12-01`; today 2026-09-27.
- **Steps:**
  1. Read the preview.
- **Expected:** Uneven months are summarised by their total — "Sets aside **€100.00 in total** from Sep 2026 to Nov 2026, funded by 30 Nov 2026 for the deadline on 1 Dec 2026, then it repeats every year." — and listed one per month: Sep 2026 €33.33, Oct 2026 €33.33, **Nov 2026 €33.34**. Even months read "€X a month" and are listed only when there are six or fewer. What is listed is what `POST /jars` plants on the Savings lines (JarPlannerTests — `ThePreview_IsExactlyWhatCreatingTheJarPlants_…`).
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-083)

### JAR-084 - The preview flags the months whose budget the contribution would push over its income (rule 59)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; October 2026's budget exists with income 1,000 and 920 planned; New-jar modal, Target `300`, Next due `2026-12-01`.
- **Steps:**
  1. Read the preview.
- **Expected:** The schedule carries each existing month's `shortfall` (total planned − the jar's current line + the new contribution − income, floored at zero): October's 100 leaves it 20 over. The preview keeps "Sets aside €100.00 a month …", lists the months with October's €100.00 in rose, and shows the status "**Over budget: Oct 2026 by €20.00.** The full contribution stays planned; adjust other lines if you need to." Nothing is trimmed to fit; months without a budget carry `shortfall:null`.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-084; JarPlannerTests — `ThePreview_IsExactlyWhatCreatingTheJarPlants_AndFlagsAMonthItOverBudgets`)

### JAR-085 - Ongoing and already-funded preview wording
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal, Type Goal.
- **Steps:**
  1. Save = "A fixed amount each month", Each month `50`, no target. 2. Save = "By a deadline", Target `300`, Deadline `2026-12-01`, Already set aside `300`.
- **Expected:** 1: "Sets aside €50.00 every month, ongoing." with no month list (`isOngoing`). 2: "Already funded — nothing more to set aside." (the schedule has no months; the jar will read Funded). A fixed plan with a target reads "Sets aside €50.00 a month — about N more months to reach the target (an estimate, not a deadline)." (JAR-016 step 4).
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-085)

### JAR-086 - "Include the deadline month" is offered only when the deadline is not the 1st, defaults off, and is sent when ticked (rule 36)
- **Priority:** P1
- **Type:** Happy / Edge
- **Preconditions:** Owner; New-jar modal (Recurring), Target `300`, today 2026-09-27.
- **Steps:**
  1. Next due `2026-12-01`. 2. Next due `2026-12-15`. 3. Tick the box. 4. Name it and "Add jar".
- **Expected:** 1: no option (the money must be there before the month begins). 2: the checkbox "Include the deadline month" appears unticked with "Also set aside money in Dec 2026, the deadline month. By default the plan finishes the month before, so the money is already in Joint Current on 15 Dec 2026. Tick this only if that month's contribution will reach the account before the deadline."; the preview runs Sep→Nov (€100.00 a month, `includeDeadlineMonth:false`). 3: re-asked with `includeDeadlineMonth:true` → Sep→Dec, €75.00 a month, funded by 31 Dec 2026. 4: `POST /jars` carries `includeDeadlineMonth:true`; on edit the box echoes the stored value (JAR-034). Switching the deadline back to a 1st hides the option and the server ignores the flag for it (`FundingCompletionMonth`).
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-086; JarScheduleTests — the three rule 36 cases)

### JAR-087 - Long schedules: twelve months listed plus a count, or a summary alone when the months are even
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal (Recurring), Next due `2027-11-01`.
- **Steps:**
  1. Target `140.1` (fourteen months, the last carrying the extra cent). 2. Target `140`.
- **Expected:** 1: "Sets aside €140.10 in total from Sep 2026 to Oct 2027 …", twelve month rows and "… and 2 more months". 2: "Sets aside €10.00 a month from Sep 2026 to Oct 2027 …" with no list (even months beyond six need none). A fixed monthly plan lists at most 120 months (ten years) but its estimate counts the whole span.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-087; JarScheduleTests — `AFixedMonthlyPlan_ListsAtMostTenYears_ButEstimatesTheWholeSpan`)
