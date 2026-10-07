# Jars (savings)

**ID prefix:** JAR | **Scope:** Everything on the Jars screen at `/jars` (`client/src/pages/JarsPage.tsx`) and the money math behind it: the **Total saved / This month / Active jars** hero; the jar-card grid (jar graphic with clamped fill %, name, status chip, `%` pill, `€X of €Y` balance, progressbar, the month line **Plan · in · to go** and the horizon line, Edit link); the **New jar** / **Edit jar** modal (`JarFormModal`: Name, Target, Needed by | Next due, **Repeats** = Doesn’t repeat | Monthly | Every 3 months | Every 6 months | Yearly with its "What repeating means" InfoHint, Held in — required, non-credit-card, the **Set aside a fixed amount each month** switch that swaps the date and Repeats for Each month, and under **More options** Already set aside + Set aside on and Include the deadline month — no Type is asked: Repeats and the switch decide the kind) with its client-side and server-side validation and its **schedule preview** (`POST /jars/schedule`); the two-click **Archive** flow; how a jar's **actual balance** is read from its designated account's ledger (`JarLedgerReader` / `ActualSavingsLedger`: initial allocation, same-account moves, expenses from that account on the jar's line — never planned contributions; PR jar-ledger slice, rules 1–6, 26, 68, 70, 73–80); the schedule engine (`Domain/Services/JarSchedule` — TargetByDate: exact split to the month before the deadline, remainder last, deadline-month opt-in, rule 62 clamp; FixedMonthly: fixed amount, capped final month, estimate, ongoing; rules 12–18, 35–36, 58, 62, 82, 86) and the planner that seeds, previews and replants Savings lines from it (`Application/Jars/JarPlanner`, rules 46, 59; W02); the recurrence-as-pure-view invariant (stored anchor never advanced); status derivation (`JarDto` / `lib/jarStatus.ts`); archived-jar exclusion from lists / copy / reconciliation; and the dashboard **Your jars** shelf (`DashboardPage.tsx`, current-month-only). | **Out of scope:** The **Allocation** engine (`/allocation`, `AllocationPage`, allocation profiles, income waterfall, member savings transfers, BalanceTilt/WaterFill) → the allocation sibling file; the budget grid's Savings-group UI (inline rename, add/delete a savings line, `SavingsAvailable` "avail." column rendering) and month create/copy/template mechanics → `08-categories-budget-lines.md` and `07-month-lifecycle.md` (jar-relevant seeding/copy behaviour is asserted here); the **Held in** account's reconciliation panel (Account/Balance/In jars/Float) → `12-accounts-reconciliation.md`; whole-transaction assignment / splits that move jar spend → `10-transactions.md`; the dashboard hero, bills strip and empty-month prompt → `06-dashboard-budget-view.md`; the full role matrix, cross-tab logout, silent refresh → the session & roles sibling files (only jar-page `canWrite` gating and the jar commands' 403/404 appear here); responsive / dark-mode / a11y sweeps live in their own files (referenced only where behaviour is jar-specific, e.g. the modal's 375px fit); the **Recurring cycle lifecycle** (W03: the persisted open cycle, rule 21 rollover, **Deadline missed** / **Funded late**, **Mark paid** choosing the payment, **Dismiss**, the *Last cycle* line — `Application/Jars/JarCycles`, `MarkCyclePaidModal`, `DismissCycleModal`; rules 19–24, 57, 83) is in scope here as JAR-088–093.

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
- **Expected:** Hero "Total saved" = **€420.00** (Σ currentBalance), tile "This month" = **+€75.00** (Σ plannedThisMonth, rule 14), tile "Active jars" = **2**. Section heading "Your jars" with a "+ New jar" button; one `JarCard` per jar in a responsive grid (`repeat(auto-fit,minmax(min(100%,340px),1fr))`, was 280px: two cards a row on a 1280-wide desktop, each line on one row; one a row on a phone).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-002)

### JAR-003 - Jar card anatomy (balance, of-target, progressbar, month line, horizon)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** One jar "Home insurance" (Recurring, yearly): target 300.00, currentBalance 120.00, plannedThisMonth 25.00, contributedThisMonth 10.00, remainingThisMonth 15.00, deadline 2026-12-01, fundingCompletesOn 2026-11-30, status OnTrack.
- **Steps:**
  1. Open `/jars` and read the card.
- **Expected:** Jar graphic with `aria-label` "Home insurance: 40% funded" (120/300); title "Home insurance"; no status chip (OnTrack is quiet); a `40%` pill; balance line "**€120.00** of €300.00"; a `progressbar` (aria-label "Home insurance funding progress", `aria-valuenow=40`, min 0 max 100) filled 40%; the month line "**Plan €25.00 · in €10.00 · to go €15.00**" (rule 14: three figures, the plan never shrinking because money landed) and under it the horizon "Due 1 Dec 2026 · yearly" (the deadline stays the deadline, rule 36; the funding-completion month, Nov 2026, is not on the card — the form's preview shows it); the lines run the card's full width, and the actions sit in their own right-aligned row under them: **Mark paid**, **Move money** and an "Edit" link (aria-label "Edit Home insurance") because `canManage`.
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
- **Expected:** "Sofa" shows the teal "Funded" chip and **no** `%` pill (redundant next to Funded); its balance line shows "€300.00" plus "of €300.00". "Slush" (target ≤ 0) shows **no** `%` pill and **no** "of €…" suffix — just "€500.00"; the amber **Needs a plan** chip and the month line "Give it a target and a date, or a monthly amount" (rule 17: with no target a date alone can't plan it; an Unscheduled jar that has a target reads "Give it a date or a monthly amount").
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
- **Preconditions:** Jars covering: (a) a deadline plan in progress (planned 25, in 10, to go 15; funded by Nov 2026, due 1 Dec 2026, recurring); (b) a fixed monthly target (planned 100, estimatedMonthsToTarget 6, no deadline); (c) an ongoing pot (status Ongoing, planned 50); (d) FullyFunded with planned 0 and balance 400 of 300; (e) Unscheduled, once with a target and once with target 0; (f) Unavailable; (g) OnTrack with planned 0 for another reason.
- **Steps:**
  1. Open `/jars` and read each card's month line and horizon.
- **Expected:** (a) "Plan €25.00 · in €10.00 · to go €15.00" / "Due 1 Dec 2026 · yearly" (the cadence in the Repeats select's words, lowercased — `cadenceLabel`: "monthly", "every 3 months", "every 6 months", "yearly", and "every N months" for a value the select doesn't offer; a Goal reads "Needed by 1 Dec 2026"; the "Funded by Nov 2026" month is no longer shown, before or after funding completes); (b) "Plan €100.00 · in €0.00 · to go €100.00" / "About 6 months to go (estimate)" (rule 58; "About 1 month to go (estimate)" for one); (c) "Plan €50.00 · …" / "€50.00 every month" (rule 16; no horizon at all if the jar has no monthly amount); (d) "Fully funded · €100.00 above target" (rule 47) and no horizon; (e) "Give it a date or a monthly amount" when the jar has a target, "Give it a target and a date, or a monthly amount" when `targetAmount` is 0 (a date alone can't plan it), no horizon; (f) "Balance not available", no horizon; (g) "Nothing to set aside this month". Never a bare "—".
- **Automated:** Yes (lib/jarStatus.test.ts — jarMonthLabel / jarHorizonLabel variants, both Unscheduled lines, `cadenceLabel` 1/3/6/12/24)

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
  4. Set "Repeats" to Yearly (a new jar starts on "Doesn’t repeat"; the date is now labelled "Next due"); set "Next due date" to `2027-06-01`.
  5. Click "Add jar".
- **Expected:** A `POST /jars` fires with body containing `name:"Vacation"`, `kind:0`, `targetAmount:1200`, `accrual:1` (TargetByDate), `targetDate:"2027-06-01"`, `recurMonths:12`, `coverStart:null`, `coverEnd:null`, `openingBalance:0`. Modal closes; a "Vacation" card appears; `EVENTS.fundCreated` fires with `{kind:0}`. Server also plants the jar's contribution line into July 2026 and any later existing months (see the CreateJar-planting case under Jar filling).
- **Automated:** Yes (JarsPage.test.tsx — "adds a fund from the New jar modal")

### JAR-013 - Create a jar that doesn't repeat (a Goal) by its Needed by date
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → leave "Repeats" on "Doesn’t repeat" (the default for a new jar; no Type is asked) and the fixed-monthly switch unticked.
  2. Name "New kitchen", Target `5000`, "Needed by" `2027-01-01`.
  3. Click "Add jar".
- **Expected:** With Repeats on "Doesn’t repeat" the date field is labelled "Needed by" (aria "Needed by"), not "Next due"; there is no "How to save" select and no "Deadline" field. `POST /jars` sends `kind:1`, `recurMonths:null`, `targetDate:"2027-01-01"`, `accrual:1`, `monthlyContribution:null`, `includeDeadlineMonth:false`. Card "New kitchen" appears; a Goal reads Behind only once past its deadline (Goals never re-arm).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-013; JarsPage.test.tsx — "asks no Type …" asserts the Needed by / Next due relabel and the switch's Each month swap)

### JAR-014 - A Goal needs a deadline or a monthly amount — no twelve-month default (rule 17)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → Name "Buffer", Target `1200`, leave "Repeats" on "Doesn’t repeat" and "Needed by" blank; "Add jar".
  2. `POST /jars` directly with `kind:1, targetAmount:1200, targetDate:null, accrual:1`.
- **Expected:** 1: no preview renders and no `/jars/schedule` request is made; the modal shows "Give the jar the date the money is needed by, or set aside a fixed amount each month instead." and nothing is posted. 2: 400 on `TargetDate` — "Give the jar a deadline, or save a fixed amount each month instead." The old "remainder spreads over 12 months" behaviour is gone; a legacy jar in this state plans 0 and reads **Needs a plan** (JAR-005).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-014 for step 1: name + target, Repeats "Doesn’t repeat", no date, "Add jar" → the "Give the jar the date the money is needed by…" message and no `POST`; JAR-042 for the missing preview; JarLifecycleTests — `Validator_RequiresADeadlinePlan_ForARecurringJar_AndAPlan_ForAGoal`; JarScheduleTests — `Rule17_…_NoTwelveMonthDefault`)

### JAR-015 - "Already set aside" sits under More options on create and seeds the jar from money already in the account
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → Name "Car repairs", Target `600`, "Needed by" `2027-03-01`; click "More options".
  2. "Already set aside" = `150`, "Set aside on" today; "Add jar".
- **Expected:** Before the click neither "Already set aside" nor "Set aside on" is visible; "More options" (a `<button>` with `aria-expanded`, closed by default on create) reveals both (aria "Already set aside" / "Set aside on", max today); "Already set aside" has an InfoHint "What setting money aside does" whose popover reads "Divides money already in Joint into this jar. It doesn’t add money." (no longer a visible line under the fields). `POST /jars` sends `initialAllocation:150` and `initialAllocationDate` today; left blank it sends `initialAllocation:0`, `initialAllocationDate:null`. The returned card balance reflects the 150 (25% of 600) before contributions. On edit the two fields are absent (rule 77; what the server checks is JAR-074/075).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-015 asserts the blank case; JarsPage.test.tsx — "offers "Already set aside" + "Set aside on" under More options on create only" and "sends the initial allocation and its date with the create payload (rule 77)")

### JAR-016 - Schedule preview phrasing (repeats vs doesn't; by date vs fixed monthly)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; today 2026-09-27; the server answers `POST /jars/schedule` (P28: the preview is the planner).
- **Steps:**
  1. "New jar", "Repeats" = Yearly, Target `300`, "Next due date" `2026-12-01`; read the preview.
  2. Change "Repeats" to "Every 3 months"; read it again.
  3. Change "Repeats" to "Doesn’t repeat" (the same date, now labelled "Needed by"); read it again.
  4. Tick "Set aside a fixed amount each month", Each month `50`; read it again.
- **Expected:** 1: one short line, "**€100.00 a month** · Sep 2026 – Nov 2026" (the months come from the server; the last one is when funding completes and the deadline day is not a contribution day, rules 12, 36), and no month list (an even plan needs none). It no longer says "Sets aside", "funded by …", "next due …" or "then it repeats every …": the date and Repeats fields above say those. 2: the same line; the request now carries `recurMonths:3` and the Repeats field shows the cadence. 3: the same line; the request now carries `kind:1`, `recurMonths:null`. 4: "€50.00 a month · about 6 months to go (estimate)" (rule 58). Each change re-asks the server with the form's definition (`kind`, `targetAmount`, `targetDate`, `accrual`, `monthlyContribution`, `includeDeadlineMonth`, `recurMonths`, `initialAllocation`, `jarId` null on create) 250 ms after typing stops.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-016; JarsPage.test.tsx — "previews the schedule the server plans as you type" asserts the request body)

### JAR-017 - Preview hides, and nothing is asked, while the definition can't be planned
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal open, "Repeats" = Yearly, "Next due date" `2026-12-01`.
- **Steps:**
  1. Leave Target blank, then type `0`, then type `abc`; then `300`.
- **Expected:** No preview and **no** `POST /jars/schedule` in the first three states (empty → 0 → `targetMinor <= 0`; `abc` → `parseMinor` null). Typing `300` brings the preview and one request with `targetAmount:300`. The same gate hides the preview while a repeating jar has no next due date, a jar that doesn't repeat has no Needed by date, a fixed plan has no monthly amount, or the edited jar's balance is unavailable (rule 67).
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-017; JarsPage.catalog.test.tsx — JAR-041 unavailable, JAR-042)

### JAR-018 - The form asks no Type: Repeats (default "Doesn’t repeat") and the fixed-monthly switch decide the kind; no renews checkbox, no Accrual/How-to-save dropdown
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 / Accrual dropdown removed, `RecurAnnually` replaced by `RecurMonths` (recurrence became a real, derived concept); PR 1 (type-free form) dropped the "Type" select, its "About jar types" InfoHint and the "How to save" select — the kind is worked out from the answers.
- **Preconditions:** Owner; New-jar modal open.
- **Steps:**
  1. Inspect the fields around Target.
- **Expected:** There is **no** "Jar type" select, **no** "Renews each year" checkbox, **no** "Accrual method" dropdown and **no** "How to save" select. "Repeats" (aria "Repeats", default "Doesn’t repeat") and the checkbox "Set aside a fixed amount each month" (visible text "Fixed amount each month", JAR-019) decide the kind: a cadence with the switch off → `kind:0`, `recurMonths` = the cadence; "Doesn’t repeat" with the switch off → `kind:1`, `recurMonths:null`; the switch on (whatever Repeats said) → `kind:1`, `accrual:2`, `recurMonths:null`, `targetDate:null`. New jars save `accrual:1` TargetByDate unless the switch is ticked; imported jars keep their stored method — see the accrual-echo edit case. An InfoHint "What repeating means" button sits beside the Repeats label (not inside the `<label>`).
- **Automated:** Yes (JarsPage.test.tsx — "asks no Type: Repeats (default "Doesn’t repeat") and the fixed-monthly switch decide the kind; no renews checkbox, no Accrual/How-to-save dropdown"; JarsPage.catalog.test.tsx — JAR-020)

### JAR-019 - Repeats swaps the date label: "Needed by" when it doesn't repeat, "Next due" when it does; the fixed-monthly switch swaps the date for "Each month"
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; New-jar modal open.
- **Steps:**
  1. With "Repeats" = "Doesn’t repeat", note the fields; select "Yearly"; note the change; tick "Set aside a fixed amount each month"; note the change.
- **Expected:** "Doesn’t repeat" shows the date as "Needed by" (aria "Needed by"); a cadence relabels the same field "Next due" (aria "Next due date") and the already-typed date carries across (shared `targetDate`). Neither state offers a method choice: a jar with a date always saves toward it. The switch's visible text is just "Fixed amount each month" (contained in its name "Set aside a fixed amount each month"), followed by an InfoHint "What a fixed amount means" whose popover reads "No date in mind? Set aside the same amount every month, for a pot you keep topping up (an emergency fund). The target is optional."; the old visible sentence "No date in mind: set aside a fixed amount each month instead." and its hint paragraph are no longer shown. Ticking the switch removes the date and "Repeats" and shows "Each month" (aria "Monthly amount") in their place, relabelling Target "Target (optional)"; unticking brings the date and Repeats back with the cadence that was chosen (kept while hidden). The old "How to save" select and "Deadline" aria-label no longer exist.
- **Automated:** Yes (JarsPage.test.tsx — "asks no Type: Repeats (default "Doesn’t repeat") and the fixed-monthly switch decide the kind; no renews checkbox, no Accrual/How-to-save dropdown" for the relabels and the Each-month swap; "keeps the cadence while the fixed-monthly switch hides it (JAR-019)" for the switch's visible text, its "What a fixed amount means" popover and the round trip: choose "Every 6 months", tick the switch, untick it → Repeats is back at "Every 6 months" and the date is labelled "Next due" again)

### JAR-020 - Repeats offers "Doesn’t repeat", Monthly, Every 3 months, Every 6 months, Yearly; a new jar defaults to "Doesn’t repeat"
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Owner; New-jar modal.
- **Steps:**
  1. Open the "Repeats" select (`id="jar-repeats"`, aria "Repeats").
- **Expected:** Options, in order: "Doesn’t repeat" (0; the apostrophe is U+2019), "Monthly" (1), "Every 3 months" (3), "Every 6 months" (6), "Yearly" (12) — "Doesn’t repeat" followed by `RECUR_MONTHS_OPTIONS` reversed. Default selected = "Doesn’t repeat" (so a create with just a target and a date sends `kind:1`). A cadence is sent as `recurMonths` with `kind:0`; "Doesn’t repeat" sends `recurMonths:null` with `kind:1`. The select is hidden while the fixed-monthly switch is ticked. No "Jar type" select exists.
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-020)

### JAR-021 - "Held in" account select and no-account helper
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Case A: Owner with account "Joint". Case B: Owner with zero accounts.
- **Steps:**
  1. Open the New-jar modal and inspect "Held in".
- **Expected:** A "Held in" select (aria "Funding account") defaulting to option "No account" then each account name ("Joint"). Selecting "Joint" sends its id as `fundingAccountId`; "No account" sends `null`. Case B: the select shows only "No account" plus helper text "Add accounts to earmark a jar's cash." `fundingAccountId` is a soft hint, not an FK (deleting the account later leaves it dangling — reconciliation just stops counting the jar; see `12-accounts-reconciliation.md`).
- **Automated:** No

### JAR-022 - "What repeating means" InfoHint copy
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal open.
- **Steps:**
  1. Activate the "What repeating means" InfoHint beside the Repeats label.
- **Expected:** Popover reads, in two short sentences: "For a bill that comes round again (insurance, road tax): once you mark it paid, it saves toward the next one. A jar that doesn’t repeat is for saving up once (a sofa, a trip)." The bold headings "A jar that repeats" / "One that doesn’t" and the pointer to the fixed amount option are no longer shown. The trigger is a `<button>` outside any `<label>`; there is no "About jar types" hint any more.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-022; a11y.spec.ts scans the modal incl. the InfoHint for axe)

---

## Create-time validation & boundaries

### JAR-023 - Empty or whitespace-only name is rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; New-jar modal open, Target `100`, "Needed by" `2027-01-01`.
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
- **Expected:** "Enter valid amounts." (`parseAmount` → `parseMinor` returns null for negatives/malformed); no `POST`. The same message covers an unparseable "Already set aside" (under More options).
- **Automated:** No

### JAR-025 - A by-date jar with target ≤ 0 is blocked client-side with "Give the jar a target amount."
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; New-jar modal, name "Road tax", "Repeats" = Yearly.
- **Steps:**
  1. Leave Target blank (parses to 0), set "Next due date" `2027-01-01`, "Add jar".
  2. Switch "Repeats" to "Doesn’t repeat", "Add jar".
- **Expected:** "Give the jar a target amount." in both cases — the same words whether the jar repeats or not (the guard covers every jar saving toward a date: `byDeadline && targetAmount <= 0`, create and edit alike; the old "Give the recurring jar a target amount." is gone); no `POST`. The server enforces the same rule 17 (400 on `TargetAmount` — "A deadline needs a target amount to save toward.", JAR-055).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-025)

### JAR-026 - Recurring jar with no due date is blocked client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; New-jar modal, "Repeats" = Yearly, name "Road tax", Target `150`.
- **Steps:**
  1. Leave "Next due date" empty, "Add jar".
- **Expected:** "Give the jar its next due date." (a jar that doesn't repeat gets "Give the jar the date the money is needed by, or set aside a fixed amount each month instead." instead, JAR-014); no `POST`. The guard covers every jar saving toward a date, create and edit alike (JAR-025, JAR-036): a legacy date-less recurring jar must be given its date (or archived) on its next save, and the server enforces the same rule 17 (400 on `TargetDate` — "A recurring jar saves toward its next due date.", JAR-036/JAR-055).
- **Automated:** Yes (JarsPage.test.tsx — "blocks a recurring jar without a due date, client-side")

### JAR-027 - The fixed-monthly switch with no target saves an ongoing pot (kind 1, accrual 2; rule 16)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, name "Someday".
- **Steps:**
  1. Tick "Set aside a fixed amount each month" (the date and Repeats disappear, "Each month" appears, the Target label becomes "Target (optional)"), leave Target blank, Each month `50`, "Add jar".
- **Expected:** Accepted. `POST /jars` sends `kind:1`, `targetAmount:0`, `targetDate:null`, `accrual:2`, `monthlyContribution:50`, `recurMonths:null`. The card reads "Plan €50.00 · in €0.00 · to go €50.00" with the horizon "€50.00 every month", no `%` pill and no "of €…". Each new month seeds 50 (JarPlannerTests rule 16); a missed month never raises a later one. A target of 0 with **no** monthly amount is refused (JAR-014).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-027; JarScheduleTests — `Rule16_AnOngoingJar_…`; JarPlannerTests — `Rule16_AnOngoingJar_SeedsItsFixedAmount_EveryMonth`)

### JAR-028 - Target with more decimals than cents is refused (D1)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, "Needed by" `2027-01-01`.
- **Steps:**
  1. Type `100.123456` into "Target amount", "Add jar".
- **Expected:** Refused with "Enter at most 2 decimal places."; nothing is sent and nothing is rounded (D1, 1 Oct 2026). `100.12` is then sent as `targetAmount:100.12`. An edit that leaves a stored target with more decimals unchanged still saves (W10).
- **Automated:** Yes (client/src/pages/JarsPage.catalog.test.tsx)

### JAR-029 - Out-of-range target or over-long name is rejected server-side
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, "Needed by" `2027-01-01`.
- **Steps:**
  1. Enter a target above 99,999,999,999,999.9999 (e.g. `100000000000000`) and click "Add jar".
  2. Separately, with Target `100`, paste a 121-character name and click "Add jar".
- **Expected:** There is **no client max or length cap**, so both reach the server: the over-range target → 400 "Target amount is out of range."; the 121-char name → 400 (`MaximumLength(120)`). Both surface only as the generic banner "Could not add that jar." (server field text isn't shown on this page). A 120-char name and an in-range target are accepted.
- **Automated:** Partial (JarsTests.cs / BudgetItemCrud — validator rejects out-of-range target and >120-char names server-side; client string mapping not asserted)

### JAR-030 - Unicode / emoji jar name accepted
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, Target `50`, "Needed by" `2027-01-01`.
- **Steps:**
  1. Name the jar "Café ☕ fund 🎉", "Add jar".
- **Expected:** Accepted and round-tripped verbatim (trimmed only); the card title and any planted savings line carry the exact string. No mojibake.
- **Automated:** No

### JAR-031 - Create request failure shows the add-error banner
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `POST /jars` returns 500.
- **Steps:**
  1. Fill a valid jar (a name, a target and a "Needed by" date) and click "Add jar".
- **Expected:** The modal stays open showing "Could not add that jar."; no card is added; `saving` clears (button re-enabled). Edit-mode failures show "Could not save that jar." instead.
- **Automated:** No

---

## Editing a jar (Edit modal & round-trip invariants)

### JAR-032 - Edit prefill; no "Already set aside" on an edit
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; jar "Home insurance" (kind Recurring, target 300, targetDate 2026-12-01, recurMonths 12, openingBalance 0, currentBalance 120).
- **Steps:**
  1. Click "Edit Home insurance".
- **Expected:** Modal titled "Edit jar" prefilled: Name "Home insurance", Target "300.00", "Repeats" Yearly (so the date is labelled "Next due", aria "Next due date") 2026-12-01, the "Set aside a fixed amount each month" switch unticked. There is no opening field on an edit: "Already set aside" / "Set aside on" are create-only (under "More options", rule 77), and with a 1st-of-month date there is nothing else to fold away, so no "More options" button renders at all; the old "Saved so far" / "Opening balance" labels no longer exist, so the card's live €120 is never retyped (the double-count trap). "Held in" (aria "Funding account") stays enabled, with no hint under it: the edit-only "The account can change only while the jar holds nothing." is no longer shown (the server's refusal explains it when a jar that holds money is moved, rule 80).
- **Automated:** Yes (JarsPage.test.tsx — "offers "Already set aside" + "Set aside on" under More options on create only — no allocation field on edit")

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
  1. "Edit" the jar; "More options" is already open (`aria-expanded="true"` — the fold starts open when the jar uses something in it) and the "Include the deadline month" box inside it is ticked; change nothing else, click "Save jar".
- **Expected:** `PUT /jars/{id}` body contains `targetDate:"2026-12-15"`, `accrual:1`, `includeDeadlineMonth:true`, `fundingAccountId` unchanged — echoed from the jar, not reset. Nothing is replanted because no schedule input changed (rule 46 / P29).
- **Automated:** Yes (JarsPage.test.tsx — "echoes the stored deadline-month option and account when editing")

### JAR-035 - Edit echoes the stored plan (the fixed-monthly switch and amount survive a rename)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #149 (the form must send the jar's own accrual, never force the default) — re-based on the two remaining methods, now the fixed-monthly switch.
- **Preconditions:** Owner; a Goal with `accrual:2`, `monthlyContribution:40`, `targetAmount:480`, `targetDate:null`.
- **Steps:**
  1. "Edit" the jar — the "Set aside a fixed amount each month" switch is ticked, "Each month" (aria "Monthly amount") shows `40`, Target reads "Target (optional)" and there is no date and no "Repeats"; rename it, "Save jar".
- **Expected:** `PUT` body has `accrual:2`, `monthlyContribution:40`, `targetAmount:480`, `targetDate:null` alongside the new name; the jar keeps its fixed plan. Only a jar whose switch is unticked sends `accrual:1` (and then needs a date).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-035; JarsPage.test.tsx — "edits a Goal that saves a fixed amount each month")

### JAR-036 - A recurring jar can't be saved without its target and due date (edit included)
- **Priority:** P1
- **Type:** Negative
- **Origin:** PR #149 kept the guards create-only for imported jars; rule 17 (W02) makes the plan mandatory everywhere, so a legacy date-less recurring jar must be given a date (or archived) on its next save.
- **Preconditions:** Owner; a legacy jar kind Recurring, `targetDate:null`, `targetAmount:0`, `recurMonths:12` (reads **Needs a plan**, month line "Give it a target and a date, or a monthly amount").
- **Steps:**
  1. "Edit" it, rename to "Living Costs", "Save jar". 2. `PUT /jars/{id}` directly with `kind:0, targetDate:null`.
- **Expected:** 1: the modal shows "Give the jar a target amount." (then, with a target, "Give the jar its next due date."); nothing is sent until both are given, after which the save replants its lines (rule 46). 2: 400 on `TargetDate` — "A recurring jar saves toward its next due date." Archiving the jar instead remains available.
- **Automated:** Partial (JarsPage.test.tsx — "blocks a recurring jar without a due date, client-side" exercises the same submit guard on create; JarLifecycleTests — `Validator_RequiresADeadlinePlan_ForARecurringJar_AndAPlan_ForAGoal`)

### JAR-037 - Switching a Recurring jar's Repeats to "Doesn’t repeat" sends the date it showed as the Goal's deadline
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 — the DTO returns the stored anchor; W03 gave the form the open cycle's date instead (JAR-093); switching to a Goal must send the date the user saw and clear the cycle.
- **Preconditions:** Owner; today 2026-07-15; Recurring jar with anchor `targetDate:2026-01-01`, recurMonths 12, whose funded cycle rolled forward so the open cycle (the DTO's `deadline`) is 2027-01-01.
- **Steps:**
  1. "Edit" the jar; "Repeats" shows Yearly and the "Next due" field shows **2027-01-01** (the open cycle, W03 — not the anchor).
  2. Switch "Repeats" to "Doesn’t repeat"; the same field is now labelled "Needed by" and still shows 2027-01-01; "Save jar".
- **Expected:** `PUT` sends `kind:1`, `recurMonths:null`, `targetDate:"2027-01-01"` — the date the user saw becomes the Goal's deadline (a Goal has no cycle), never a date they never chose; the server clears the cycle. A Goal past its date reads Behind (Goals don't re-arm).
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-037; JarLifecycleTests — anchor never rewritten, switching to Goal clears the cycle)

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
  1. "Edit" it; read the preview. 2. Change the Target to `900`; read it again. 3. On a new jar, type Target `1200`, "Needed by" `2026-12-01`, then click "More options" and type Already set aside `600`.
- **Expected:** 1: `POST /jars/schedule` with `jarId:"f1"`, `targetAmount:300`, `initialAllocation:0` — the server plans from the jar's balance entering the month (rule 1; there is no opening field to retype) → "€60.00 a month · Sep 2026 – Nov 2026". 2: a new request with `targetAmount:900` → "€260.00 a month · …"; the old figure is gone. 3: the create preview sends `jarId:null`, `initialAllocation:600` and the server folds it in (€400.00 → €200.00 a month). With `currentBalance:null` (Unavailable) no preview renders and nothing is asked.
- **Automated:** Yes (JarsPage.catalog.test.tsx — JAR-041 ×3; JarPlannerTests — `ThePreview_OfAnEdit_StartsFromTheJarsBalanceEnteringTheMonth_AndOfANewJar_FromWhatIsSetAside`)

### JAR-042 - No preview without a date or a monthly amount; either one brings it (rule 17)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; a legacy Goal with `targetAmount:300`, `targetDate:null`, `accrual:1` (Unscheduled: "Give it a date or a monthly amount").
- **Steps:**
  1. "Edit" the jar and change the Target to `900`. 2. Tick "Set aside a fixed amount each month", Each month `50`. 3. Untick it and give a "Needed by" date `2026-12-01`.
- **Expected:** 1: **no** preview and no `/jars/schedule` request — there is nothing to plan. 2: a request with `accrual:2`, `monthlyContribution:50`, `targetDate:null` → "€50.00 a month · about 4 months to go (estimate)". 3: a request with `accrual:1`, `targetDate:"2026-12-01"` → the deadline schedule, "€60.00 a month · Sep 2026 – Nov 2026".
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
- **Expected:** The first click only arms the button (no request); `PUT /jars/{id}/archive` with body `{archived:true}` fires on the second click. Modal closes; the "Home insurance" card disappears from the list; `EVENTS.fundArchived` fires. "Holiday" remains. Server-side (W04, rule 25 / P40): the jar's current-month line is cut to what has gone in since the month began and its later months' plan lines are removed (kept at 0 where a transaction sits on one); past months, transactions and balances are untouched.
- **Automated:** Yes (JarsPage.test.tsx — "archives a fund from its edit modal", asserts no PUT on the first click; JarLifecycleW04Tests — `Rule25_Archiving_CancelsThisMonthsAndLaterContributions_AndRestoringReplantsThem`)

### JAR-045 - Archived jar is dropped from the list and default GET
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; one jar archived, one active.
- **Steps:**
  1. Open `/jars`.
- **Expected:** Only the active jar renders; hero "Active jars" counts active jars only — a **completed** goal (W04, rule 55) stays listed but is not counted. `GET /jars` (no `includeArchived`) excludes archived rows server-side. There is **no** UI to list or restore archived jars — restore is API-only (`PUT …/archive` with `{archived:false}`).
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
- **Expected:** The copied July month **omits** the archived "Old car" line (and, W04, a **completed** goal's line) but **keeps** the dangling-SavingsId line. Archived and completed jars are also excluded from the "append a line for every active jar" step. (Month-create mechanics live in `07-month-lifecycle.md`; this asserts the jar-archival interaction.)
- **Automated:** Yes (CreateBudgetMonthTests.cs — copy skips lines funding archived or completed jars; dangling id still copies)

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
- **Expected:** `currentBalance` = 50 + (30 + 30) − 20 = **€90.00** (`OpeningBalance + Σ planned across ALL months − Σ assigned expense spend`, spend taken at its budget-currency amount). Split slices assigned to the line count too; transfers never do, and neither does a row still waiting for its amount in the budget currency (W08) until that amount is confirmed.
- **Automated:** Yes (JarsTests.cs / SavingsTests.cs — balance = opening + contributions − spend)

### JAR-053 - Jars-page balance vs budget-grid "avail." differ by the opening balance / future lines
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; jar "Gifts" opening 50.00, one savings line planned 30.00 in July 2026, none earlier, none spent; viewing July.
- **Steps:**
  1. Compare the "Gifts" balance on `/jars` with the "avail." shown on the July budget-grid savings line.
- **Expected:** `/jars` `currentBalance` = 50 + 30 = **€80.00** (includes opening + all months). The grid `SavingsAvailable` = **€30.00** (planned−spent over months ≤ viewed, **excluding** OpeningBalance). The two legitimately differed by the €50 opening while jars had an opening balance of their own; since the jar allocation slice both read the ledger, and since W05 (rule 48) at one date per month, so they agree on every month (DASH-030).
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

### JAR-056 - A funded Recurring cycle rolls forward at its deadline; a short one reads Deadline missed and never rolls on its own (rules 20, 21)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 rolled a passed recurring date forward silently (`EffectiveDeadline`); W03 replaces that with a persisted open cycle (`Jar.CycleDeadline`) settled lazily on every read: funded → **Funded** and advance; short → persistent **Deadline missed** (rule 20).
- **Preconditions:** Owner; today 2026-07-15; two Recurring jars, target 600, anchor 2026-01-01, recurMonths 12: (a) held 600 on 31 Dec 2025; (b) held 450 on 31 Dec 2025 and still.
- **Steps:**
  1. Read both jars on `/jars`.
- **Expected:** (a) the cycle due 1 Jan 2026 closes as Funded with balance 600 and the jar's deadline is **2027-01-01**; status OnTrack (no chip), the contribution spread over the months to Dec 2026, the horizon "Due 1 Jan 2027 · yearly", the *Last cycle* line "Last cycle funded on time" with a **Record the payment** link; the anchor `targetDate` is still 2026-01-01 and the day of month is preserved across cycles (a 31st never drifts to the 28th, rule 62). (b) the deadline stays **2026-01-01**, status **Deadline missed** (rose chip), month line "Deadline 1 Jan 2026 missed · €150.00 short", this month's plan is the whole 150, and nothing changes on later reads; no money moves in either case. A deposit on the deadline day itself does not count for the rollover (rule 82: the balance at the end of the day before).
- **Automated:** Yes (JarCycleTests — `Rule21_ACycleHeldInFull_WhenItsDeadlineArrives_RollsForward_AndMovesNoMoney`, `Rule21_TheRolloverCountsWhatWasHeldTheDayBefore_NotMoneyThatArrivedOnTheDeadline`, `Rule21_SeveralFundedCyclesPassedUnseen_EachRollsForward_InOrder`, `Rule20_ACycleShortAtItsDeadline_ReadsDeadlineMissed_WithTheShortfall_AndStaysThatWay`; JarLifecycleTests — `Status_PastDueRecurring_ReadsDeadlineMissed_WithTheShortfall_ThenFundedLate`; JarScheduleTests — `ARecurringJar_PlansTowardItsOpenCycle_NotTheAnchor`, `Rule20_AMissedRecurringCycle_NeverRollsOnItsOwn_AndPlansTheShortfallNow`, `Rule62_TheNextCycle_IsSteppedFromTheAnchor_SoAShorterMonthClampsOnlyThatOccurrence`)

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

### JAR-060 - Shelf shows the current month's figures with no date caption
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 (the shelf rendered on the current month only); W05 (rule 48) reads it for the viewed month.
- **Preconditions:** Owner; viewed month = July 2026 (current); ≥1 jar with a balance.
- **Steps:**
  1. Open `/` on July 2026.
- **Expected:** A "Your jars" card renders (from `GET /api/jars?year=2026&month=7`) with "{total} saved" and no "as of" caption, one jar graphic each (`label` "{name}: {pct}% of goal"), name, balance, then a status chip **or** "+€X/mo" (chip wins). No edit affordances on the shelf.
- **Automated:** Yes (client/src/pages/DashboardPage.jars.test.tsx DASH-028; client/e2e-journey/budget-lifecycle.spec.ts month-navigation journey; a11y.spec.ts scans the shelf)

### JAR-061 - Shelf follows past and future months
- **Priority:** P1
- **Type:** Edge
- **Origin:** W05 (rule 48; REVIEW J6) — the shelf used to be hidden off the current month.
- **Preconditions:** Owner; ≥1 jar; budgets for June 2026 (past) and August 2026 (future).
- **Steps:**
  1. Use the month navigator to view June, then August.
- **Expected:** The "Your jars" shelf renders on both, each from a fresh `GET /api/jars?year&month`. June shows each jar's balance at 30 June with "… saved as of 30 Jun 2026" and June's own "+€X/mo"; August shows today's balances with "… saved balances as of today" and August's own plan. Each equals the Savings card's Available on that month (DASH-030). The hero, bills strip and groups still render.
- **Automated:** Yes (client/e2e-journey/budget-lifecycle.spec.ts — the copied next month keeps the shelf with "balances as of today" and the re-planned 250.00; client/src/pages/DashboardPage.jars.test.tsx DASH-073/074)

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
- **Expected:** The unknown properties are ignored by model binding; the jar is saved from its definition alone and the DTO has no cover fields. There is no "Cover end must be after cover start." rule any more. The old workbook importer that wrote those fields was removed in the final review.
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

### JAR-067 - Unknown jar ids 404 on every jar route, DELETE included (W04)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; a random/unknown jar id.
- **Steps:**
  1. Attempt `PUT /jars/{unknownId}` (or `…/archive`, `POST …/complete`, `DELETE /jars/{unknownId}`).
- **Expected:** 404 with body message "Jar {id} was not found." `DELETE /api/jars/{id}` exists since W04 but only for a jar that has never held money (rule 27/84 — JAR-096/097); every other jar is soft-archived. A jar's savings budget line cannot be deleted from a month (rule 60 — BUDG-034); the choice is skip or archive.
- **Automated:** Partial (JarsTests.cs — update/archive not-found + ownership throws; JarLifecycleW04Tests — delete refusals)

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
- **Expected:** 200 with the jar's `JarDto`; the handler sets `IsArchived = false` (the requested value, not a toggle — a second `{archived:false}` is idempotent), **replants the jar's current and later months from its schedule (W04, P40)** and re-derives `currentBalance`/`status` at read time, so the response carries `isArchived:false`. "Old car" now reappears in the **default** `GET /jars` (handler `Where` = `IncludeArchived || !IsArchived`), is re-counted in the "Active jars" hero (back to **2**), re-enters account reconciliation so its earmarked cash again feeds Joint's `BackedJarsTotal`/Float (inverse of JAR-048), and its contribution line is again seeded/carried on the next month create or copy (inverse of JAR-047 — no longer keyed out as an archived jar). Ownership is still enforced (403 for another household's jar id, 404 for an unknown id — JAR-067/068 apply to this route too).
- **Automated:** Partial (JJarsCoverageTests — the `archived:false` leg; JarLifecycleW04Tests `Rule25_Archiving_CancelsThisMonthsAndLaterContributions_AndRestoringReplantsThem` — the replant on restore; the reconciliation/copy re-entry is not asserted end to end)

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
- **Preconditions:** Owner; New-jar modal, "Repeats" = Yearly, Target `100`, Next due `2026-12-01`; today 2026-09-27.
- **Steps:**
  1. Read the preview.
- **Expected:** Uneven months are summarised by their total — "**€100.00 in total** · Sep 2026 – Nov 2026" — and listed one per month: Sep 2026 €33.33, Oct 2026 €33.33, **Nov 2026 €33.34**. Even months read "€X a month · …" and are not listed: the list shows only when the months differ, a month is skipped or a month is over budget (an even plan of six months or fewer is no longer listed). What is listed is what `POST /jars` plants on the Savings lines (JarPlannerTests — `ThePreview_IsExactlyWhatCreatingTheJarPlants_…`).
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-083)

### JAR-084 - The preview flags the months whose budget the contribution would push over its income (rule 59)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; October 2026's budget exists with income 1,000 and 920 planned; New-jar modal, "Repeats" = Yearly, Target `300`, Next due `2026-12-01`.
- **Steps:**
  1. Read the preview.
- **Expected:** The schedule carries each existing month's `shortfall` (total planned − the jar's current line + the new contribution − income, floored at zero): October's 100 leaves it 20 over. The preview keeps "€100.00 a month · Sep 2026 – Nov 2026", lists the months (an over-budget month brings the list even for an even plan) with October's full €100.00 in rose, and shows the status "**Over budget: Oct 2026 by €20.00**" (the old tail ". The full contribution stays planned; adjust other lines if you need to." is no longer shown). Nothing is trimmed to fit; months without a budget carry `shortfall:null`.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-084; JarPlannerTests — `ThePreview_IsExactlyWhatCreatingTheJarPlants_AndFlagsAMonthItOverBudgets`)

### JAR-085 - Ongoing and already-funded preview wording
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal ("Repeats" on "Doesn’t repeat").
- **Steps:**
  1. Tick "Set aside a fixed amount each month", Each month `50`, no target. 2. Untick it, Target `300`, "Needed by" `2026-12-01`, then "More options" → Already set aside `300`.
- **Expected:** 1: "€50.00 every month" with no month list (`isOngoing`). 2: "Already funded" (the schedule has no months; the jar will read Funded). A fixed plan with a target reads "€50.00 a month · about N months to go (estimate)" (JAR-016 step 4), and a definition the server answers with no plan (`hasSchedule:false`) reads "Add a date or a monthly amount.".
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-085)

### JAR-086 - "Include the deadline month" sits under More options, is offered only when the deadline is not the 1st, defaults off, and is sent when ticked (rule 36)
- **Priority:** P1
- **Type:** Happy / Edge
- **Preconditions:** Owner; New-jar modal, "Repeats" = Yearly, Target `300`, today 2026-09-27.
- **Steps:**
  1. Next due `2026-12-01`; click "More options". 2. Next due `2026-12-15`. 3. Tick the box. 4. Name it and "Add jar".
- **Expected:** 1: "More options" starts closed for a new jar (`aria-expanded="false"`, `aria-controls="jar-more-options"`) and opens on the click; with a 1st-of-month date there is no option inside it (the money must be there before the month begins). 2: the checkbox appears inside the fold, unticked, its visible text "Include the deadline month" (also its accessible name), followed by an InfoHint "What including the deadline month means" whose popover reads "By default the plan finishes the month before, so the money is in Joint Current by 15 Dec 2026. Tick this only if Dec 2026’s contribution will reach the account before then." (the old visible "Also set aside money in Dec 2026, the deadline month." and its paragraph are no longer shown); the preview reads "€100.00 a month · Sep 2026 – Nov 2026" (`includeDeadlineMonth:false`). 3: re-asked with `includeDeadlineMonth:true` → "€75.00 a month · Sep 2026 – Dec 2026" (the last month is when funding completes). 4: `POST /jars` carries `includeDeadlineMonth:true`; on edit the fold starts open and the box echoes the stored value (JAR-034). Switching the deadline back to a 1st hides the option and the server ignores the flag for it (`FundingCompletionMonth`); an edit with nothing left to show in the fold (no deadline-month option) has no "More options" button at all.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-086; JarScheduleTests — the three rule 36 cases)

### JAR-087 - Long schedules: twelve months listed plus a count, or a summary alone when the months are even
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal, "Repeats" = Yearly, Next due `2027-11-01`.
- **Steps:**
  1. Target `140.1` (fourteen months, the last carrying the extra cent). 2. Target `140`.
- **Expected:** 1: "€140.10 in total · Sep 2026 – Oct 2027", twelve month rows and "… and 2 more months". 2: "€10.00 a month · Sep 2026 – Oct 2027" with no list (even months need none, however many). A fixed monthly plan lists at most 120 months (ten years) but its estimate counts the whole span.
- **Automated:** Yes (JarsPage.catalog.supplemental.test.tsx — JAR-087; JarScheduleTests — `AFixedMonthlyPlan_ListsAtMostTenYears_ButEstimatesTheWholeSpan`)

### JAR-088 - Deadline missed and Funded late on the card (rules 20, 57)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; Recurring jar "Road tax" target 600 due 1 Sep 2026 yearly; today 2026-09-27; (a) balance 450; (b) balance 600 (the last 150 arrived on 8 Sep).
- **Steps:**
  1. Open `/jars` for (a). 2. For (b).
- **Expected:** (a) rose chip **Deadline missed**; month line (rose) "Deadline 1 Sep 2026 missed · €150.00 short"; no horizon line (the old "Mark the cycle paid, or dismiss it to save toward the next one" is no longer shown: the month line keeps the deadline and shortfall, and the buttons say what to do); the card's action row offers **Dismiss** (aria "Dismiss Road tax's missed deadline") and **Mark paid** (aria "Mark Road tax paid") beside Move money and Edit; the `%` pill reads 75%. (b) amber chip **Funded late**; month line "Funded after the deadline on 1 Sep 2026"; no horizon line; the same two actions; the notice stays on every reload until the user acts (rule 57 — late funding never rewrites the cycle as met on time). The dashboard's jar shelf shows the same chips.
- **Automated:** Yes (JarsPage.cycles.test.tsx — JAR-088 ×2; jarStatus.test.ts; JarCycleTests — `Rule57_FundedAfterTheDeadline_ReadsFundedLate_AndKeepsTheNoticeUntilDismissed`)

### JAR-089 - Mark paid: choose the payment; the cycle closes and the jar moves on (rules 22–24, 83)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; the JAR-088 (a) jar; two expenses recorded from Joint Current on the jar's Savings line: Transport Malta €580.00 on 3 Sep 2026 and Insurance Co €120.00 on 30 Aug 2026; neither linked to a cycle.
- **Steps:**
  1. Click **Mark paid**. 2. Read the list. 3. Click **Mark paid** (confirm) before choosing. 4. Choose "Transport Malta on 3 Sep 2026, €580.00" and confirm.
- **Expected:** 1: the dialog "Mark Road tax paid" asks "Which payment settled the cycle due 1 Sep 2026? The jar then saves toward its next due date with whatever it still holds; nothing is moved." and requests `GET /jars/{id}/payments` (the jar's own payments only). 2: both payments as radios, newest first, each with the date, account and line and a teal **From this jar** badge. 3: the confirm button is disabled until a payment is chosen — the user picks, the app never infers (rule 83). 4: `POST /jars/{id}/cycles/paid` with `{ deadline: "2026-09-01", paymentTransactionId }`; the dialog closes and the card shows the next cycle (due 1 Sep 2027, "Due 1 Sep 2027 · yearly", plan €12.50 a month from the €450 held: rule 23 carries only the actual remainder; rule 24 keeps the €600 target) and "Last cycle paid 3 Sep 2026 (€580.00), late". No money moved. A payment dated before the deadline that emptied the jar reads "Last cycle paid 28 Nov 2025 (€600.00)" with no ", late" and the cycle counts as met on time (rule 22).
- **Automated:** Yes (JarsPage.cycles.test.tsx — JAR-089; JarCycleTests — `Rule22_PaidBeforeTheDeadline_AndMarkedPaid_CountsAsMetOnTime_EvenAtZeroBalance`, `Rule23_ALowerBill_CarriesOnlyTheActualRemainder_IntoTheNextCycle`, `Rule83_AMissedCycle_MarkedPaidWithAnEarlierPayment_IsPaidNotMissed`, `Payments_ListTheJarsOwnPayments_LeaveOutFulfilledOnes_AndOfferTheRestOnRequest`)

### JAR-090 - Mark paid: payments from other accounts on request; refusals shown verbatim
- **Priority:** P2
- **Type:** Edge / Negative
- **Preconditions:** Owner; the JAR-088 (a) jar with no payments from it; an expense Transport Malta €580.00 on 3 Sep 2026 from the Cash account; craft `POST /jars/{id}/cycles/paid` directly for the refusals.
- **Steps:**
  1. Click **Mark paid**. 2. Tick **Show payments from other accounts**. 3. Choose the Cash payment and confirm while the server refuses (e.g. the transaction is income). 4. Cancel. 5. Direct requests: an income, transfer or refund transaction; a future-dated expense; a payment already fulfilling a cycle; a deadline that is not the jar's open cycle nor a closed one; a Goal; another household's jar.
- **Expected:** 1: "No payments from Road tax yet. Record the payment on the Transactions page first, or show payments from other accounts." 2: `GET /jars/{id}/payments?all=true`; the Cash payment appears without the From-this-jar badge, its account named. 3: the server's message is shown in the dialog's error banner ("Choose the payment that settled the bill — money out, not income, a transfer or a refund."); the dialog stays open and the jar is unchanged. 4: the dialog closes; nothing posted. 5: 400 with, respectively, the message above; "…is dated in the future…"; "That payment already fulfilled Road tax's cycle due 1 Sep 2026. A payment settles one cycle."; "Road tax has no cycle due …. Its current cycle is due 1 Sep 2026"; "Road tax is a goal, not a recurring jar; it has no cycles to mark paid."; 403/404 for another household.
- **Automated:** Yes (JarsPage.cycles.test.tsx — JAR-090; JarCycleTests — `Rule83_MarkPaid_RefusesIncomeTransfersRefunds_UnknownCycles_Goals_AndOtherHouseholds`)

### JAR-091 - Dismiss a missed deadline: the jar moves on, nothing is paid, no money is made up (rule 20)
- **Priority:** P1
- **Type:** Happy / Edge
- **Preconditions:** Owner; the JAR-088 (a) jar (450 of 600, 150 short).
- **Steps:**
  1. Click **Dismiss**. 2. Cancel. 3. Click **Dismiss** again and **Move on**. 4. In the dialog, click **Mark the cycle paid** instead. 5. Direct `POST /jars/{id}/cycles/dismiss` with a deadline that is not the open cycle, and for a cycle not yet passed.
- **Expected:** 1: "Move Road tax on to its next cycle?" — "Road tax missed its deadline on 1 Sep 2026 — €150.00 short. Dismissing keeps the €450.00 it holds for the next cycle, records nothing as paid and makes up no shortfall; the jar simply saves toward its next due date." with "Paid the bill? Mark the cycle paid and choose the payment instead." 2: nothing posted; the notice stays. 3: `POST /jars/{id}/cycles/dismiss` with `{ deadline: "2026-09-01" }`; the card moves on: no chip, "Due 1 Sep 2027 · yearly", plan €12.50 a month, "Last cycle missed"; Dismiss is gone; balances unchanged. A jar that had reached its target late is recorded as funded late instead ("Last cycle funded late"). 4: the dismiss dialog is replaced by the Mark paid dialog for the same cycle; nothing posted yet. 5: 400 "Road tax has no missed cycle due …" / "…has not been missed; there is nothing to dismiss."
- **Automated:** Yes (JarsPage.cycles.test.tsx — JAR-091 ×2; JarCycleTests — `Rule20_Dismissing_ResumesSavingTowardTheNextDeadline_FromWhatIsHeld_AndMovesNoMoney`, `Dismiss_RefusesACycleThatIsNotMissed_OrNotTheOpenOne`)

### JAR-092 - A cycle that rolled forward funded can still be given its payment ("Record the payment")
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Owner; Recurring jar whose cycle due 1 Sep 2026 was held in full and rolled forward (JAR-056 (a)); an expense from the jar on 3 Sep 2026.
- **Steps:**
  1. Read the card. 2. Click **Record the payment**. 3. Choose the payment and confirm.
- **Expected:** 1: no chip; "Last cycle funded on time" and under it the link "Record the payment" (aria "Record the payment for Road tax's cycle due 1 Sep 2026"; it used to read "Paid it? Record the payment"). 2: the Mark paid dialog for the **closed** cycle: "Which payment settled the cycle due 1 Sep 2026? This only records the payment against that cycle; nothing is moved." 3: `POST /jars/{id}/cycles/paid` with `deadline: "2026-09-01"` (the closed cycle, not the open 2027 one); the open cycle is untouched; the line becomes "Last cycle paid 3 Sep 2026 (€580.00), late" and the link is gone. Deleting that transaction later clears the link but keeps the recorded date and amount.
- **Automated:** Yes (JarsPage.cycles.test.tsx — JAR-092; JarCycleTests — `Rule83_APaymentCanBeLinkedToTheLastCycle_AfterItRolledForwardFunded`)

### JAR-093 - Cycle actions exist only for a Recurring jar with a balance, and only for writers; editing echoes the open cycle's date
- **Priority:** P2
- **Type:** Negative / Regression
- **Preconditions:** Owner and a read-only viewer; a Goal, a Recurring jar whose account balance is unavailable (rule 67), the JAR-088 (a) jar; a Recurring jar with anchor 2026-01-01 whose open cycle is 2027-01-01.
- **Steps:**
  1. Read the Goal and the unavailable jar as Owner. 2. Read the missed jar as the viewer. 3. Edit the advanced jar; save without changes; save with Next due 2027-03-01.
- **Expected:** 1: no Mark paid, no Dismiss, no "Record the payment" link (a Goal has no cycle; an unavailable balance cannot settle one). 2: the chip and the rose line are shown, the actions are not. 3: "Next due" is prefilled with **2027-01-01** (the open cycle, not the anchor); saving it back keeps both the anchor and the cycle (a rename never resets an advanced cycle — the preview also plans toward the open cycle); 2027-03-01 becomes the new anchor and the open cycle. Switching the jar to a Goal keeps the date the user saw as the Goal's deadline (JAR-037).
- **Automated:** Yes (JarsPage.cycles.test.tsx — JAR-093 ×2; JarsPage.catalog.test.tsx — JAR-037; JarCycleTests — `Update_EchoingTheOpenCyclesDate_KeepsTheCycle_AndANewDateRestartsIt`, `ThePreviewOfAnEdit_PlansTowardTheOpenCycle_WhenTheDateIsEchoed`)

---

## Completing, deleting and skipping (W04; rules 25, 27, 55–56, 60–61, 84)

### JAR-094 - Mark a Goal completed: the plan stops, the money stays, the jar stays listed
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; Goal "New laptop" (target 1,000, deadline in six months) holds 400, plans 100 this month; the current and two later months exist with its lines.
- **Steps:**
  1. On the card click **Mark completed** (aria "Mark New laptop completed"). 2. Read the dialog; click **Mark completed** (aria "Confirm complete New laptop").
- **Expected:** The dialog says the jar holds €400.00 of its €1,000.00 target (€600.00 short), that completing stops the planned contributions from this month on and that the money stays in the jar. `POST /jars/{id}/complete` returns the jar: `status: "Completed"`, `completedOn` = today, `plannedThisMonth` = what went in this month, `canDelete: false`. The card shows the **Completed** chip and "Completed · €400.00 left to move", and no horizon line (the old "Completed on 27 Sep 2026 · no more contributions planned" is no longer shown: the chip and the month line say it); its Edit form says "Completed: nothing more is planned." and offers no Repeats; Move money and Edit remain, Mark completed does not; the hero's Active jars count drops by one. Server-side (P40): this month's line is cut to what went in since the month began, later months' lines are removed (kept at 0 where a transaction sits on one); no money moves. Month creation and copy leave the completed jar out (BUDG-017/032).
- **Automated:** Yes (JarsPage.lifecycle.test.tsx — JAR-094, JAR-095; JarLifecycleW04Tests — `Rule55_Completing_StopsThePlan_FromThisMonthOn_AndKeepsTheMoney`, `Rule55_ACompletedGoal_IsLeftOutOfTheNextMonthsPlanning_AndStillListed`; jar-lifecycle journey)

### JAR-095 - Completing is refused for a recurring jar, an overdrawn or unavailable balance, and twice
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner; a Recurring jar; a Goal 20 overdrawn; a Goal whose account balance is unavailable (rule 67); a completed Goal.
- **Steps:**
  1. Read the four cards. 2. `POST /jars/{id}/complete` for each.
- **Expected:** 1: none of the four offers **Mark completed** (a recurring jar offers Mark paid instead). 2: 400 for each — "… is a recurring jar: mark its cycle paid …", "… is 20 overdrawn. Cover the shortfall … before completing it." (HANDOVER O3 stays open, P41), "…'s balance is not available today …", "… is already completed."; an archived jar is refused too. A completed Goal edited to Recurring is refused with "A completed goal cannot become a recurring jar." The dialog shows a refusal in the server's words and the jar is unchanged.
- **Automated:** Yes (JarsPage.lifecycle.test.tsx — JAR-095, JAR-098; JarLifecycleW04Tests — `Rule55_Completing_IsRefused_…`, `Rule55_ACompletedGoal_CannotBecomeARecurringJar`)

### JAR-096 - Delete a jar that has never held money, with its planned lines (rule 27/84)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Owner; Goal "Bike" created with no money set aside, no allocation and no transaction ever on its lines; lines in a past, the current and a future month; a cycle row.
- **Steps:**
  1. "Edit Bike": the footer offers **Archive jar** and **Delete jar** (aria "Delete Bike"). 2. Click Delete jar (arms to "Really delete?", aria "Confirm delete Bike"); click again.
- **Expected:** The first click sends nothing; the second sends `DELETE /jars/{id}` → 204. The modal closes, the card disappears, `EVENTS.fundDeleted` fires. Server-side the jar, **every** line it had in any month (past included — they were plans, never money) and its cycle rows are removed; the months and their other lines stay. `JarDto.canDelete` was `true` beforehand.
- **Automated:** Yes (JarsPage.lifecycle.test.tsx — JAR-096; JarLifecycleW04Tests — `Rule27_AJarThatNeverHeldMoney_CanBeDeleted_WithItsPlannedLinesAndCycles`; jar-lifecycle journey)

### JAR-097 - A jar that has ever held money offers Archive, never Delete
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Owner; jar "Holiday" that once received a 100 allocation since moved back out (balance 0); jar "Car" with an expense assigned to one of its lines.
- **Steps:**
  1. "Edit Holiday" and "Edit Car". 2. `DELETE /jars/{id}` for each directly.
- **Expected:** 1: the footer shows **Archive jar** only (`canDelete:false` — eligibility is "never held money", read from the ledger, P42). 2: 400 "… has held money, so it cannot be deleted. Archive it instead to keep its history."; the jar and its lines stay. A forced attempt from the form shows the message verbatim.
- **Automated:** Yes (JarsPage.lifecycle.test.tsx — JAR-097, JAR-098; JarLifecycleW04Tests — `Rule27_AJarThatHasHeldMoney_CannotBeDeleted_OnlyArchived`; jar-lifecycle journey)

### JAR-098 - Refusals to complete or delete are shown in the server's words
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; `POST …/complete` and `DELETE /jars/{id}` answer 400 with a field message.
- **Steps:**
  1. Confirm Mark completed; confirm Delete jar.
- **Expected:** Each dialog shows the server's message in its error banner and stays open; nothing on the page changes; a non-400 failure reads "Could not mark that jar completed." / "Could not delete that jar.".
- **Automated:** Yes (JarsPage.lifecycle.test.tsx — JAR-098 ×2)

### JAR-099 - The card and the form show a skipped month; write gating
- **Priority:** P2
- **Type:** Regression
- **Preconditions:** Owner and a read-only viewer; Goal "Sofa" whose current-month line is skipped (BUDG-060).
- **Steps:**
  1. Read Sofa's card. 2. "Edit Sofa" and read the schedule preview. 3. Read the page as the viewer.
- **Expected:** 1: the month line reads **Skipped this month** (`skippedThisMonth:true`, `plannedThisMonth: 0`); the deadline (the horizon's "Needed by …") and the funding-completion month (shown in the form's preview) are unchanged. 2: the preview lists the current month as "Skipped" and the later months carrying the remainder (rule 61; a skipped month always brings the list); when skipping leaves money **unplanned** it says so in rose — "€X unplanned because of skipped months", or, when every month left is skipped, "Nothing planned: every month is skipped, €X unplanned" (P45). 3: no Mark completed, no Edit (so no Delete) for the viewer.
- **Automated:** Yes (lib/jarStatus.test.ts — "Skipped this month"; JarsPage.lifecycle.test.tsx — JAR-093; JarLifecycleW04Tests — `Rule61_Skipping_ThisMonth_…` asserts `SkippedThisMonth`; jar-lifecycle journey)

### JAR-100 - A goal completed this month reads as it was on a past month
- **Priority:** P1
- **Type:** Regression
- **Origin:** Review of PR #275 (W05): the shelf showed **Completed** on every past month once a goal was completed.
- **Preconditions:** Owner; Goal "Sofa" (target 300) fully funded since August; marked completed on 5 October; budgets for September and October.
- **Steps:**
  1. On the Budget page view September, then October.
- **Expected:** September's shelf reads Sofa as **Funded** (the status it had at 30 September), with the deadline and funded-by month it had then; October reads **Completed**. The Jars page (today) reads Completed. `GET /api/jars?year=2026&month=9` returns `status: "FullyFunded"` and `completedOn: "2026-10-05"` (the completion is the jar's dated fact, the status is the month's).
- **Automated:** Yes (JarMonthViewW05Tests — `Rule55_AGoalCompletedThisMonth_StillReadsAsItWas_InThePastMonth`)

### JAR-101 - A jar moved to another account keeps the balance it held on a past month
- **Priority:** P1
- **Type:** Regression
- **Origin:** Review of PR #275 (W05): the past month's balance was looked up in the jar's current account only.
- **Preconditions:** Owner; accounts A and B; Goal "Sofa" in A holding 100 at 31 August; emptied (reallocated to unallocated) on 10 September; its account changed to B (rule 80, at zero); 50 allocated to it in B on 5 October.
- **Steps:**
  1. View August, September and October on the Budget page.
- **Expected:** August reads Sofa at **100** ("saved as of 31 Aug 2026") and the Savings line's Available agrees; September reads 0 with nothing in; October reads 50 with 50 in. `fundingAccountId` is B on every month (the designation is current; the money is where the ledger says it was).
- **Automated:** Yes (JarMonthViewW05Tests — `Rule80_AJarMovedToAnotherAccount_KeepsTheBalanceItHeld_InThePastMonth`; `Rule80_AJarMovedToAnAccountOpenedLater_StillReadsWhatTheOldAccountHeld_ForTheEarlierMonth` — the same with B opened on 1 October: August still reads 100)

### JAR-102 - A past month is judged against the recurring cycle that was open then
- **Priority:** P1
- **Type:** Regression
- **Origin:** Adversarial review of PR #275 (W05, P49): after a missed cycle was marked paid, the past month read today's cycle.
- **Preconditions:** Owner; Recurring "Insurance" 300 due 15 September holding 100; on 3 October the user marked the cycle paid (next deadline 15 September 2027).
- **Steps:**
  1. On the Budget page view September, then October.
- **Expected:** September's shelf reads Insurance **Deadline missed** (deadline 15 Sep 2026, shortfall 200), as it read on 30 September; October reads **On track** toward 15 Sep 2027. `GET /api/jars?year=2026&month=9` returns `status: "DeadlineMissed"`, `deadline: "2026-09-15"`, `shortfall: 200`, `lastCycle: null` (no cycle had closed by then).
- **Automated:** Yes (JarMonthViewW05Tests — `Rule20_AMonthThatIsOver_IsJudgedAgainstTheCycleOpenThen_NotTodays`)

### JAR-103 - A past month lists a jar archived since, and plans nothing for a jar it had no line for
- **Priority:** P2
- **Type:** Regression
- **Origin:** Adversarial review of PR #275 (W05): the shelf omitted an archived jar the grid still showed, and invented a plan for a jar created later.
- **Preconditions:** Owner; Goal "Sofa" holding 300 at 30 September, emptied and archived on 2 October; Goal "Bike" created in October (no September line).
- **Steps:**
  1. View September on the Budget page. 2. View October.
- **Expected:** 1: the shelf shows Sofa at 300 beside its Savings line (Available 300); Bike is on the shelf with no plan ("+€0.00/mo"). 2: Sofa is gone (archived); Bike shows its October line. The Jars page shows no Sofa.
- **Automated:** Yes (JarMonthViewW05Tests — `Rule27_AMonthThatIsOver_StillListsAJarArchivedSince_WhoseLineItCarries`, `Rule46_AMonthThatIsOver_WithNoLineForTheJar_PlansNothingForIt`)

### JAR-104 - A past month keeps the target and deadline it was judged against after the jar is edited
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, P2-8 and P3-4): a month that was over was re-judged against today's target, deadline and kind, and returned a target its status had not used.
- **Preconditions:** Owner; today 10 October 2026; Goal "Holiday" 300 due 1 Jul 2027, holding 300 since 20 August; Goal "Deposit" 300 due 15 Sep 2026, holding 100; budgets for September and October. On 5 October Holiday's target goes to 600 and Deposit's date moves to 1 Jul 2027.
- **Steps:**
  1. On the Budget page view September. 2. View October.
- **Expected:** 1: Holiday shows **Funded** and is drawn full (`targetAmount` 300, `status` "FullyFunded"); Deposit shows **Behind** (`deadline` "2026-09-15", `targetAmount` 300). 2: Holiday is on track against 600 (half full) and Deposit is on track toward 1 Jul 2027. The same holds the other way (a target lowered after the month does not turn it Funded), for a Recurring jar whose date is moved after a missed month (it still reads **Deadline missed** there, with its shortfall) and for a goal turned Recurring later (the month reads the goal it was: Behind, never Deadline missed). An edit dated on or before a month's last day applies to that month; several edits on one day keep the last; a rename or an account change records nothing.
- **Automated:** Yes (JarMonthViewW05Tests — `Rule46_ATargetChangedAfterAMonthEnded_LeavesThatMonthJudgedAgainstTheTargetItHad`, `Rule46_ADeadlineOrKindChangedAfterAMonthEnded_LeavesThatMonthBehind`, `Rule20_ARecurringDateChangedAfterAMissedMonth_LeavesThatMonthDeadlineMissed`, `Rule21_ACycleThatRolledForwardBeforeTheMonthEnded_IsNotReadAsMissed_WhenSettledLater`, `Rule46_ARecurringTargetRaisedAfterTheMonth_StaysThatMonthsTarget_WhenTheCycleCloses`, `Rule20_APastMonthsTargetAmount_IsTheTargetItsStatusUsed`, `Rule46_UpdateJar_RecordsTheDefinitionItReplaces_OnePerDay_AndLastMonthKeepsIt`; JarLifecycleW04Tests — `Rule27_AJarThatNeverHeldMoney_CanBeDeleted_WithItsPlannedLinesAndCycles` removes the history with the jar; integration JarLedgerSqlTests — `A_jar_edit_is_dated_so_last_month_keeps_the_target_it_had`)

### JAR-105 - A Recurring jar archived since keeps Deadline missed on the month it missed
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, P2-7): archiving had no date, so a month before the archive read the jar as archived and showed **Behind** with no shortfall.
- **Preconditions:** Owner; today 10 October 2026; Recurring "Insurance" 300 due 15 Sep 2026 yearly, holding 100 at 30 September (Deadline missed, 200 short); on 2 October the bill is cancelled: the 100 goes back to unallocated and the jar is archived; budgets for September and October.
- **Steps:**
  1. On the Budget page view September. 2. Repeat with the jar archived on 30 September instead.
- **Expected:** 1: the shelf lists Insurance with **Deadline missed** (`status` "DeadlineMissed", `deadline` "2026-09-15", `shortfall` 200), as it read on 30 September; the archive on 2 October does not rewrite it. 2: the jar was already archived at September's end, so September reads no Deadline missed and no shortfall. Archiving records the day and restoring clears it; a jar archived before the day was recorded counts as archived on every date.
- **Automated:** Yes (JarMonthViewW05Tests — `Rule27_AJarArchivedAfterAMonthItMissed_StillReadsDeadlineMissedThere`; JarLifecycleW04Tests — `Rule25_Archiving_CancelsThisMonthsAndLaterContributions_AndRestoringReplantsThem` sets and clears the date; JarScheduleTests — `Rules25And55_AnArchivedOrCompletedJar_PlansNothing_ButStillKnowsWhatIsLeft` counts a dated archive from its day)

### JAR-106 - A bill paid on time but marked paid after the month ended reads paid on time on that month (rule 22)
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, rule 22 question, decided 28 Sep 2026): a cycle paid before its deadline but marked paid later read **Deadline missed**, the full target short, on every month up to the marking.
- **Preconditions:** Owner; today 10 October 2026; Recurring "Insurance" 600 due 1 Sep 2026 yearly, holding 600 since July; the bill paid 600 from the jar's August line on 28 August (the jar is then at 0); on 5 October the user marks the cycle paid with that payment; budgets for August, September and October.
- **Steps:**
  1. On the Budget page view August, then September.
- **Expected:** August reads Insurance on track toward 1 Sep 2027 (`deadline` "2027-09-01", balance 0) with its last cycle paid on time (`lastCycle.paidOnTime` true); September reads on track with no shortfall. Neither month reads **Deadline missed**: the cycle counts as met from the day it was paid, not the day it was marked.
- **Automated:** Yes (JarMonthViewW05Tests — `Rule22_ABillPaidBeforeItsDeadline_ButMarkedPaidLater_ReadsPaidOnTimeOnThePastMonths`)

### JAR-107 - Correcting or deleting a payment a moved jar made in its old account is settled on the day it moved
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, P2-10; P51): the correction left a residue in the old account that showed on the jar while the archive and move checks read 0.
- **Preconditions:** Owner; today 28 September 2026; accounts A and B, each opened with 1,000; Goal "Holiday" in A gets 100 on 1 August; its August line pays 100 from A on 20 August; on 1 September Holiday (now at 0) moves to B.
- **Steps:**
  1. On the Transactions page change the 20 August payment's amount to 80. 2. View August and September on the Budget page, and A's figures on 31 August and 1 September. 3. Archive Holiday. 4. From the same start, delete the payment instead, or move it to the Groceries line. 5. From the same start with the move on 25 August, re-date the payment to 22 August, then to 28 August.
- **Expected:** 1–2: the edit is accepted. Holiday reads 100 on 19 August and 20 at August's end (the corrected history: it held 100 and spent 80, rule 49), then 0 from 1 September. A reads balance 920, Holiday 20, unallocated 900 on 31 August, and 920, 0, 920 from 1 September: the 20 goes back to A's unallocated money on the day Holiday left (a Departure operation dated 1 September, Holiday −20 and unallocated +20), never to B. 3: archiving is allowed; the card and `GET /api/jars?includeArchived=true` show 0. 4: deleted, A reads 1,000 / 100 / 900 on 31 August and 1,000 / 0 / 1,000 from 1 September; moved to Groceries, 900 / 100 / 800 and then 900 / 0 / 900. 5: 22 August is accepted (Holiday 100 on 21 August, 0 on 22 August; nothing to settle); 28 August is refused on `Date` with "This entry moved money in Holiday while Holiday was held in this account, and Holiday left it on 25 Aug 2026. It can't be dated after that." and the payment keeps 22 August. A payment on Holiday's September line from A dated after the move (10 September) is not kept on the jar: A's unallocated money pays it. A move made before the day was recorded is settled on the last day A's ledger touched the jar.
- **Automated:** Yes (JarDepartureTests — `Rule80_CorrectingAKeptPayment_SettlesTheDifference_OnTheDayTheJarLeft`, `Rule80_DeletingAKeptPayment_SettlesIt_OnTheDayTheJarLeft`, `Rule80_MovingAKeptPaymentOffTheJarsLine_SettlesIt`, `Rule80_AKeptPayment_CanMoveWithinTheStretch_ButNotPastTheDayTheJarLeft`, `Rule80_APaymentDatedAfterTheMove_IsNotKeptOnTheJar`, `Rule80_ALegacyMove_WithNoDepartureRecorded_IsSettledOnTheLastDayTheOldLedgerTouchedTheJar`, `UpdateJar_RecordsTheDayTheJarLeft_OnlyWhereItLeavesHistory`; JarLedgerActivationTests — `ChangingTheAccount_KeepsThePaymentsTheJarMadeFromTheOldAccount_AttributedToIt`; integration JarLedgerSqlTests — `A_correction_to_a_kept_payment_is_settled_on_the_day_the_jar_left`)

### JAR-108 - A payee edit of an income from before the move keeps its jar share
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, P2-11; P51): the old account backs no jar after the move, so the edit sent no jar answer and the server cleared the income's split, taking its share off the jar.
- **Preconditions:** Owner; today 28 September 2026; accounts A and B, each opened with 1,000; Goal "Holiday" in A; a 300 income into A on 10 August put wholly into Holiday; Holiday's line pays 300 from A on 20 August; on 1 September Holiday moves to B; on 5 September 300 of B's money goes into Holiday.
- **Steps:**
  1. On the Transactions page change the 10 August income's payee and save. 2. Change its amount to 400, then to 250. 3. From the same start, move the income to another account C.
- **Expected:** 1: Holiday still reads 300 today and 300 on 15 August; A on 31 August still reads balance 1,000, Holiday 0, unallocated 1,000; nothing is settled. When A backs another jar the form echoes Holiday's 300 share, and the save is accepted with the same result. 2: at 400 the share stays 300 (A's unallocated on 15 August is 1,100); at 250 it is cut to 250, and A reads 950 / Holiday −50 / unallocated 1,000 on 31 August (the corrected history overdrew it) and 950 / 0 / 950 from 1 September. Holiday still reads 300 today: B's money is untouched. 3: A reads 700 / −300 / 1,000 on 31 August and 700 / 0 / 700 from 1 September. A payment drawn from Holiday through "which jar?" before the move keeps its draw the same way (MM-021).
- **Automated:** Yes (JarDepartureTests — `Rule80_APayeeEditOfAKeptIncome_KeepsItsJarShare`, `Rule80_AnEditEchoingAKeptIncomeShare_IsAccepted_WhileTheOldAccountBacksAnotherJar`, `Rule80_CorrectingAKeptIncomesAmount_KeepsTheShareWhileItFits_AndSettlesWhatNoLongerFits`, `Rule80_MovingAKeptIncomeToAnotherAccount_SettlesItsShare`, `Rule80_APayeeEditOfAPaymentDrawnFromAMovedJar_KeepsTheDraw`)

### JAR-109 - A jar's account can't change while a transfer into it is still in transit
- **Priority:** P2
- **Type:** Negative
- **Origin:** Re-review of PR #275 (W05, round 3, P51): a transfer leg that posts after the move would land in the account the jar had left.
- **Preconditions:** Owner; accounts A and B; Goal "Holiday" in A at 0; a 50 transfer from B to A on 10 August with its 50 put into Holiday, receipt not yet confirmed.
- **Steps:**
  1. Edit Holiday → Held in "B" → Save.
- **Expected:** 400 on `FundingAccountId`: "Holiday has a transfer in transit in A. Confirm it first, then change the account."; Holiday stays in A. The same applies to a transfer out of the jar that has not left yet. Once the receipt is confirmed, the zero rule applies as usual (JAR-080).
- **Automated:** Yes (JarDepartureTests — `UpdateJar_IsRefused_WhileATransferIntoTheJarHasNotArrived`)

### JAR-110 - After a mid-month move, the card a save returns, the list and the month's plan agree
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 3, P2-9; P51): after a move the card a save returned read the new account only while the list read every account, so the card changed on reload (the €50 reproduction: the card said 50 in, the list 0, and the month's plan differed from the jar form's preview).
- **Preconditions:** Owner; accounts A (2,000) and B (1,000); Goal "Holiday" 1,200 due 1 July next year, held in A, entering this month with 300; on the 1st the 300 goes back to A's unallocated money; Holiday (now at 0) moves to B; then 50 of B's money goes into it.
- **Steps:**
  1. Edit Holiday and save it (a rename, or no change). 2. Reload the Jars page. 3. Compare the plan the month is seeded with to the first month of the jar form's preview.
- **Expected:** 1: the returned card reads balance 50 with 0 **in** (it entered the month holding 300 in A). 2: the reloaded card is identical to the one the save returned. 3: both are the same amount. With 300 of B's money put in instead of 50, the card and the list likewise agree and read 0 in.
- **Automated:** Yes (JarDepartureTests — `P2_9_AJarEmptiedInA_MovedToB_AndGiven50_ReadsTheSame_OnTheCard_TheList_AndThePlan`, `P2_9_TheCardAWriteReturns_EqualsTheNextRead_AfterAMidMonthMove`)

### JAR-111 - A jar's account can't change while its old account has an entry for it dated after today
- **Priority:** P1
- **Type:** Negative
- **Origin:** Re-review of PR #275 (W05, round 4, P2-18; P51): the zero rule read today only, so an income entered ahead of payday and put into the jar let the jar move, and from payday the old account held the jar's money again. The entry then couldn't be edited ("It can't be dated after that") and the jar couldn't be archived or emptied.
- **Preconditions:** Owner; accounts A and B; Goal "Holiday" in A at 0; an income of 200 into A dated three days from today, all of it put into Holiday.
- **Steps:**
  1. Edit Holiday → Held in "B" → Save. 2. Edit the income's payee, keeping the 200 in Holiday, and try again. 3. Edit the income so none of it goes into Holiday, and try again.
- **Expected:** 1 and 2: 400 on `FundingAccountId`: "Holiday has an entry dated <payday> in A. Change or remove it first, then change the account."; Holiday stays in A. 3: Holiday moves to B; on payday A's 200 is unallocated and Holiday holds nothing in A. The same applies to any entry in A dated after today that moves money in or out of Holiday (a payment drawn from it, a reallocation).
- **Automated:** Yes (JarDepartureTests — `UpdateJar_IsRefused_WhileTheOldAccountHasAJarEntryDatedAfterToday`)

### JAR-112 - A jar on a private account warns before sharing it (rule 34)
- **Priority:** P0
- **Type:** Happy / Negative
- **Origin:** W13 (rules 33–34, HANDOVER P55).
- **Preconditions:** Sam's login; "Sam's current" private to Sam.
- **Steps:**
  1. As Sam, **New jar** "Bike", Held in "Sam's current", Save. 2. **Pick another account**. 3. Save again with "Sam's current"; **Share the account and continue**. 4. Move an existing jar to a private account from its Edit form. 5. With the warning showing for one private account, switch **Held in** to another account.
- **Expected:** 1: nothing is saved; a warning: "'Sam's current' is private. A jar is part of the household budget, so the account it lives in is visible to everyone: sharing this jar shows the household 'Sam's current', its balance and all its transactions. Share the account, or pick another account for the jar." The form notes the account is private beforehand, under Held in: "Private: saving asks you to share it." 2: the warning closes, the form stays. 3: the account becomes shared and the jar is created in it; no money moves. 4: the same warning and choices. 5: the warning goes, so it can never share an account it didn't name; saving with another private account warns about that one.
- **Automated:** Yes (JointAccountsW13Tests — `AJarOnAPrivateAccount_WarnsFirst_ThenSharesTheAccount_Rule34`; JarsPage tests, including `drops the rule 34 warning when the account changes, so it never shares another account`)

### JAR-115 - Restoring a jar keeps the months it spent archived
- **Priority:** P2
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 4, P2-19): restoring cleared the archive date, so every month the jar spent archived read it as live (a Recurring jar with no line there read "Deadline missed, short 300").
- **Preconditions:** Owner; Recurring "Insurance", 300 due 15 August; 100 put in on 1 July and taken out on 20 July, when it was archived; July has its line, August has none.
- **Steps:**
  1. View August on the Budget page. 2. Restore Insurance on the Jars page. 3. View August and July again, then this month.
- **Expected:** 1 and 3: August's shelf has no Insurance; July lists it (its line) and does not read Deadline missed. This month lists it, planning again. Archiving and restoring again keeps each stretch. An archive made before archives were dated has no stretch to keep (restored, it reads live on every month, as before).
- **Automated:** Yes (JarW05FollowUpTests — `P2_19_RestoringAJar_KeepsTheMonthsItSpentArchived`, `P2_19_IsArchivedOn_ReadsTheArchivePeriods`)

### JAR-116 - Moving a jar into an account leaves that account's earlier payments on its line where they were
- **Priority:** P1
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 4, P2-20; pre-existing on `main`): the reader looked a line's jar up by today's account, so after the move an old payment from the new account on the jar's line was read as a draw from the jar (−50), and the jar could not be archived ("50 overdrawn"). Review of PR #276 (P2-A): the first fix treated the move day as the old account's, so a payment from B on Holiday's line dated the move day, the only account it can be recorded from, never came out of Holiday (Holiday stayed at 300 and B's unallocated dropped by 600). Its second round (R2-P2-1, R2-P2-2, R2-P3-1): a move-day payment answered "paid from Car" and then put on Holiday's line still stayed off Holiday; after a move away and back, the jar's earlier payments in that account could not be re-dated or split; and the refusals gave a false reason or sent the user to the other account.
- **Preconditions:** Owner; accounts A and B with 1,000 each; Goal "Holiday" in A holding 0; a 50 payment from B on Holiday's August line dated 20 August (the payee auto-categoriser can put it there).
- **Steps:**
  1. Edit Holiday → Held in "B" → Save. 2. Look at Holiday's balance and B's unallocated money today and on 25 August. 3. Edit the old payment's payee. 4. Move 300 of B's money into Holiday and record the 300 deposit from B on Holiday's line dated today. 5. Try to record a payment on Holiday's line dated yesterday, from A and from B, and to re-date the deposit to yesterday. 6. Archive Holiday (after emptying it). 7. With Car (100) also in B, record two 80 payments from B today on Groceries, "paid from Car"; move one to Holiday's line and edit its payee; split the other 50 Holiday + 30 Groceries, keeping "paid from Car". 8. Move a jar that paid 150 on 3 August and 250 on 4 August from A to B and straight back to A; re-date the 250 to 5 August, split the 150 as 100 on the jar's line + 50 Eating out, then try a new payment from A on its line dated 6 August.
- **Expected:** 2: Holiday 0 on both dates; B's unallocated 950. 3: unchanged. 4: the deposit comes out of Holiday (0 today and tomorrow, B's unallocated 650) and the jar's payments list shows it as from the jar. 5: all three are refused with "Holiday, which moved to B on <today>"; from A the message says it can't be added to the line from any account (it does not send the user to B), since Holiday had nothing in A and the move recorded no stretch there. 6: allowed once Holiday holds 0. 7: each Holiday share comes out of Holiday (Holiday 170, Car 70, B's unallocated 600 after both). 8: both edits are accepted (the jar reads 300 on 4 August, 50 on 5 August and 0 today), and so is a re-date into September (acknowledged); a new 50 payment dated 6 August is accepted too, since A held the jar then (JAR-120): the jar reads 0 on 6 August and today, and A's unallocated 550. Moving a jar and moving it back the same day leaves payments from its account that day drawing from it; a Recurring bill paid the move day and marked paid holds nothing afterwards.
- **Automated:** Yes (JarW05FollowUpTests — `P2_20_MovingAJarIntoAnAccount_LeavesThatAccountsEarlierLinePaymentsWhereTheyWere`, `P2_20_APaymentOnTheJarsLineFromItsNewAccount_DrawsFromTheJarFromTheMoveDay`, `P2_20_ABillPaidOnTheMoveDay_MarkedPaid_LeavesNothingHeld`, `P2_20_APaymentOnTheJarsLineDatedBeforeTheMove_IsRefused_FromEitherAccount`, `P2_20_ThatAccountsPaymentRecordedBeforeTheMove_DatedOnTheMoveDay_StaysOnItsUnallocatedMoney`, `P2_20_ARoundTripTheSameDay_PaymentsFromTheJarsAccountDrawFromIt`, `P2_20_AMoveDayPaymentPaidFromAnotherJar_PutOnTheJarsLine_DrawsFromTheJar`, `P2_20_AMoveDayPaymentKeptFromAJarThatLeftTheSameDay_PutOnTheJarsLine_DrawsFromTheJar`, `P51_AfterTheJarMovesAwayAndBack_ItsEarlierPaymentsThereCanStillBeRedatedAndResplit`, `P51_AfterTheJarMovesAwayAndBack_ItsEarlierPaymentsThereCanBeRedatedIntoTheNextMonth`; JointAccountsW13Tests — `MovingAJarIntoTheHoldersPrivateAccount_SharesIt_AndItsEarlierPaymentOnTheJarsLineStaysOffTheJar_Rule34`)

### JAR-117 - A month before a moved jar's first entry in its old account reads 0, not Unavailable
- **Priority:** P2
- **Type:** Regression
- **Origin:** Adversarial review of PR #275 (W05, round 3, P2-15): an old account counted as holding the jar only from its first posting there, so before it a jar whose current account opened later read Unavailable.
- **Preconditions:** Owner; A open since 1 January holds Holiday: 100 in on 20 August, out on 10 September; Holiday moved to B, which opens on 1 October; July has a budget.
- **Steps:**
  1. View July on the Budget page.
- **Expected:** Holiday reads 0 saved (not Unavailable) and the Savings line's Available is 0. A month before A opened still reads Unavailable (rule 67).
- **Automated:** Yes (JarMonthViewW05Tests — `Rule80_AJarMovedToAnAccountOpenedLater_StillReadsWhatTheOldAccountHeld_ForTheEarlierMonth`)

### JAR-118 - A jar move made before departures were recorded no longer blocks the archive
- **Priority:** P2
- **Type:** Regression
- **Origin:** Re-review of PR #275 (W05, round 4, P3-8): a move made on the old code, whose kept payment was then corrected (100 → 80), left 20 of the jar in the old account; the card read 20, archive was refused and the 20 could not be moved from either account until a kept entry happened to be edited. Review of PR #276 (P2-B): a move made before PR #274 (26 to 28 September) wrote nothing down, so the old account's payments on the jar's lines lost the jar; the first backfill dated the departure on the last stored posting, before those payments, and July read 0 where Holiday held 500. Its second round (R2-P1-1, R2-P2-3, R2-P3-2, R2-P3-4): the backfill also wrote down payments dated before the old account opened (Holiday then held 100 there for good) and payments dated after #275 reached production, settled stored postings the ledger doesn't count, and logged its result where nobody sees it.
- **Preconditions:** Such jars (data from before PR #275): one moved after PR #274 with a corrected kept payment; one moved before PR #274 after 500 went in on 15 July and was paid out from its August line on 20 August.
- **Steps:**
  1. Start the API (deploy). 2. Open the Jars page and archive the jars. 3. View July and August for the second jar.
- **Expected:** 1: the Windows Event Log has one Warning "Jar-departure backfill: recorded 2 departure(s) and wrote down 1 line payment(s)."; the second jar's 20 August payment is written down as drawing from it, and its departure (of nothing) is dated 20 August; a second start records 0 and 0. 2: the jars read 0 and archive. 3: July reads 500 and 19 August 500; the old account's unallocated money is unchanged. A transfer into the jar is dated on the day it reached the old account. Only payments the old account's ledger counts are written down: none dated before its opening date (none at all when it has no opening date) and none after 29 September 2026, the day #275 reached production. A payment that carries a budget figure beside its amount, or waits for one (W08), is written down at its amount, since jar balances read the amount. The departure settles what the ledger reads the jar holding there plus any share stored on a transfer leg still in transit there, so the jar reads that share below zero in the old account until the leg is confirmed, and 0 from then on. A failed run logs an Error, saves nothing, and the API starts anyway.
- **Automated:** Yes (JarW05FollowUpTests — `P3_8_AMoveMadeBeforeDeparturesWereRecorded_IsSettledByTheBackfill_Once`, `P3_8_AMoveMadeBefore274_WritesDownTheOldAccountsLinePaymentsBeforeDatingTheDeparture`, `P3_8_TheBackfill_DatesATransferLegOnTheDayItPosts`, `P3_8_TheBackfill_SettlesJarSharesOnTransferLegsStillInTransit_SoNothingIsLeftOnceTheyPost`, `P3_8_TheBackfill_WritesDownNoPaymentDatedBeforeTheOldAccountOpened`, `P3_8_TheBackfill_WritesDownNoPaymentDatedAfterDeparturesWereRecorded`, `P3_8_TheBackfill_WritesDownALinePaymentsOwnAmount_AfterForeignAmountsGaveItABudgetFigure`; JarLedgerSqlTests — `A_move_made_before_departures_were_recorded_is_backfilled_once`, `A_move_made_before_274_has_its_old_line_payments_written_down_before_its_departure`)

### JAR-119 - A jars read for a month outside 2000–2100 is a validation error
- **Priority:** P3
- **Type:** Negative
- **Origin:** Adversarial review of PR #275 (W05, round 3, P3-5): `GET /api/jars?year=9999&month=12` (and `year=1&month=1`, or `asOf=9999-12-31`) passed the controller's check and failed with 500.
- **Steps:**
  1. `GET /api/jars?year=9999&month=12`. 2. `GET /api/jars?asOf=0001-01-01`. 3. `GET /api/jars?year=2026&month=9`.
- **Expected:** 1 and 2: 400 with a validation error on Year / AsOf. 3: 200.
- **Automated:** Yes (JarW05FollowUpTests — `P3_5_AMonthOrDateOutsideTheBudgetRange_IsAValidationError`, `P3_5_AnOrdinaryMonth_IsValid`)

### JAR-120 - A late payment from the jar's old account goes on its line, and the move is re-settled
- **Priority:** P1
- **Type:** Happy / Negative
- **Origin:** Review of PR #276, round 2 (R2-D1): a payment the old account really made before the move and entered late could go on the jar's line from neither account. Christopher chose "Accept and settle" on 29 September 2026. Round 3 (R3-P3-4, K3): after a one-way move, a kept payment in the old account could not be re-split keeping its jar slice, re-dated across a month, or put back on the jar's line once taken off it. Review of PR #280, round 1 (P2-1, P3-1): a kept payment could be re-dated within its month to before the jar arrived, and the refusal could name an account that never held the jar.
- **Preconditions:** Owner; accounts A and B with 1,000 each (opened 1 January), C with 1,000; Goal "Holiday" in A: 300 put in on 1 August and paid out on 20 August from its August line; today Holiday moved to B.
- **Steps:**
  1. Record a 50 payment from A on Holiday's August line dated 10 August. 2. Look at Holiday on 9, 10 and 20 August and today, and at A's and B's unallocated money today; open Holiday's payments. 3. Delete it. 4. Record it again from B, then from C. 5. Import A's statement with the 50 row on Holiday's line instead. 6. Put the 20 August payment on Eating out, then back on Holiday's line. 7. Record a payment from A on Holiday's line dated tomorrow. 8. With a kept 150 payment from A on 28 August and a 200 one on 30 August: split the 150 as 100 Holiday + 50 Eating out, and re-date the 200 to 2 September (acknowledged). 9. With A's opening date empty (an account from before opening dates were required), repeat step 1. 10. With Holiday moved into A from X on 10 August (X held money for it) before today's move to B: re-date a kept A payment of 20 August on its line to 5 August, then to 10 August. 11. Separately: Holiday 400 in A from 1 August pays a 100 transfer from A to C on 10 August, is emptied on 15 August and moves to B today; then mark the transfer returned on 12 August.
- **Expected:** 1 and 5: accepted. 2: Holiday 300 on 9 August, 250 on 10 August, −50 on 20 August and 0 today; A's unallocated 700 on 20 August and 650 today; B's 1,000; the payment is listed as from the jar. 3: Holiday reads 300 on 10 August and 0 today, A's unallocated 700. 4: refused. From B: "'Holiday' is the jar Holiday, which moved to B on <today>. A payment on its line from B can't be dated before then. Record it on another line." From C: "…A payment dated before then goes on its line only from the account that held the jar that day. Record it from that account, or on another line." A is not named, since Holiday's stretch there is its first recorded one and where it began isn't known; with an earlier recorded move into A, the message names A ("which was held in A on 10 Aug 2026. Record this payment from A so it comes out of the jar, or put it on another line."). 6: Holiday reads 300 on 20 August while it is on Eating out, 0 once it is back; A's unallocated stays 700. 7: refused: its money is held in B. 8: both accepted: Holiday 250 on 28 and 31 August, 50 on 2 September, 0 today; A's unallocated 650. 9: refused until A has an opening date again. 10: 5 August is refused ("…and another account held Holiday until 10 Aug 2026. It can't be dated before that."); 10 August is accepted. 11: the 100 goes back to Holiday while A held it: Holiday reads 400 in A on 12 August, 100 on 15 August and 0 today, and A's unallocated money 1,000 today. A payment from A dated before A's opening date is accepted but counts in no jar figure, and so does a kept one re-dated there (Holiday still reads 0 today). If the jar had nothing in A before it moved, the move recorded no stretch there and the payment is refused (JAR-116, step 5).
- **Automated:** Yes (JarMoveAcceptAndSettleTests, all seventeen; JarW05FollowUpTests — `P51_AfterTheJarMovesAwayAndBack_ItsEarlierPaymentsThereCanStillBeRedatedAndResplit`)

---

## One budget currency (W08; rule 63)

### JAR-113 - A jar can't be held in an account kept in another currency
- **Priority:** P1
- **Type:** Negative
- **Origin:** W08 (one budget currency). New accounts are always in the budget currency (ACCT-079), so this only bites on a legacy account created before W08 in another currency.
- **Preconditions:** Owner; budget in EUR; a legacy account "UK savings" in GBP and an EUR account "Main"; a jar "Rainy day" held in "Main".
- **Steps:**
  1. `/jars` → **New jar** "Holiday", target 1000, Needed by `2027-07-01` (Repeats: Doesn’t repeat), Held in "UK savings" → Save. 2. Edit "Rainy day" → Held in "UK savings" → Save. 3. `POST /api/jars/reallocations` with `accountId` = UK savings (reallocating jar money within that account).
- **Expected:** 1 and 2: 400 on `FundingAccountId`: "UK savings is in GBP, but the budget is in EUR. Choose an account in EUR."; no jar is created and "Rainy day" stays in "Main". 3: the same message on `AccountId`; nothing moves. A credit card is still refused first with its own message. The picker itself does not hide the legacy account; the server refuses it.
- **Automated:** Partial (ForeignAmountsTests — `A_jar_cannot_live_in_an_account_kept_in_another_currency`, create path only)

### JAR-114 - A payment still waiting for its budget-currency amount can't mark a cycle paid
- **Priority:** P1
- **Type:** Negative
- **Origin:** W08 adversarial review — a waiting payment counts nowhere yet (rule 44), so settling a cycle with it would record its foreign figure as budget money.
- **Preconditions:** Owner; budget in EUR; the JAR-088 (a) jar (Road tax, cycle due 1 Sep 2026); an imported expense "US insurer" **USD 650.00** dated on or before today, on **no** account (a waiting row can't sit on the jar's EUR account: an import refuses a row in another currency than its account), still waiting (`fxPending`, "Needs EUR amount").
- **Steps:**
  1. Click **Mark paid**; tick **Show payments from other accounts** (`GET /jars/{id}/payments?all=true`); read the list. 2. Try to choose "US insurer". 3. `POST /api/jars/{id}/cycles/paid` with `{ deadline: "2026-09-01", paymentTransactionId: <US insurer> }`. 4. On `/transactions`, **Enter amount** on US insurer (e.g. 598.00); re-open **Mark paid** and choose it.
- **Expected:** 1: "US insurer" is listed (without the From-this-jar badge), dimmed, with " · Needs its amount entered on Transactions first" after its date and line. 2: its radio is **disabled**, so nothing is selected and **Mark paid** (aria "Confirm Road tax paid") stays disabled. 3: 400 keyed `PaymentTransactionId` → "That payment is in USD and is waiting for its amount in the budget currency. Enter that amount on Transactions first."; no cycle is recorded and the jar is unchanged. 4: once confirmed the payment is an ordinary choice and marking paid proceeds as in JAR-089 (the server checks "money out, not income, a transfer or a refund" and "dated in the future" before this refusal, and "already fulfilled" after it — JAR-090).
- **Automated:** Yes (ForeignAmountsTests — `A_waiting_payment_cannot_mark_a_cycle_paid`; client/src/pages/JarsPage.cycles.test.tsx — "JAR-114: a payment still waiting for its budget-currency amount is listed but cannot be chosen"; step 4 is not asserted)

---

## Dates by month only (jar setup plan, PR 2)

### JAR-121 - A jar can be needed by a month, and reads the month everywhere
- **Priority:** P2
- **Type:** Happy
- **Origin:** Christopher's jar note 2 (a date as a month) and the jar setup plan he accepted on 6 October 2026 ("Looks promising let's do it"): some jars need a day (a loan the bank takes on an agreed day), most savings only a month.
- **Preconditions:** Owner; an account "Joint Current"; today is in October 2026.
- **Steps:**
  1. `/jars` → **New jar**: read the date's label row. 2. Pick **Month**; open the list. 3. Name "Summer holiday", target 1,800, pick **Jul 2027** → read the preview → **Add jar**. 4. Read its card. 5. A second jar "Car insurance", 600, **Repeats: Yearly**, **Month**, **Mar 2027** → **Add jar**; read its card. 6. With a date of 15 Mar 2027 typed, switch to **Month**, then back to **Date**; then type 28 Oct 2026 and switch to **Month**. 7. Pick **Month** and **Add jar** with no month chosen. 8. Edit "Car insurance". 9. Let a month-only jar that repeats miss its month short, then open **Dismiss** and **Mark paid**; let another be funded late; let one roll forward funded and unpaid.
- **Expected:** 1: "Needed by" with **Date** (chosen) and **Month** beside it; on a narrow phone the two sit above the label. 2: the date input becomes one list, "Pick a month", then Nov 2026 to Dec 2036 (this month's 1st has passed: a date can still pick a later day). 3: the preview plans toward 1 Jul 2027 exactly as a date on the 1st would ("€200.00 a month · Oct 2026 – Jun 2027"); the jar is created with `targetDate` 2027-07-01 and `monthOnly: true`. 4: "Needed by Jul 2027". 5: "Due Mar 2027 · yearly". 6: Month shows Mar 2027; back on Date the field reads 1 Mar 2027; 28 Oct 2026 switched to Month shows "Pick a month" (October's 1st has passed, so it is never saved as Oct 2026). 7: "Pick the month the money is needed by." and nothing is saved ("Pick the month it is next due." for a jar that repeats). 8: the form opens on **Month** with Mar 2027 chosen; Save sends `monthOnly: true`. 9: "Deadline Sep 2026 missed · €150.00 short"; Dismiss reads "Road tax missed its Sep 2026 deadline — €150.00 short."; Mark paid asks "Which payment settled the cycle due Sep 2026?"; funded late reads "Funded after the Sep 2026 deadline"; the "Record the payment" link is named "… cycle due Sep 2026". A jar with a full date reads exactly as before ("Needed by 1 Jul 2027"). "Include the deadline month" never appears for a month (it needs a day after the 1st).
- **Automated:** Yes (client/src/pages/JarsPage.monthOnly.test.tsx, all eleven; client/src/pages/JarsPage.cycles.test.tsx — both "JAR-121" tests; client/src/lib/jarStatus.test.ts — "jarDate"; e2e/a11y.spec.ts and e2e/mobile-layout.spec.ts scan and fit the month list)

### JAR-122 - A month-only date is stored as the 1st and changes no plan
- **Priority:** P2
- **Type:** Happy / Negative
- **Origin:** Jar setup plan, PR 2: one additive column (`Jars.MonthOnly`, default false), no data step; existing jars untouched.
- **Preconditions:** Owner; an account.
- **Steps:**
  1. `POST /api/jars` a Goal, target 300, `targetDate` the 1st three months out, `monthOnly: true`; and the same with `monthOnly` left out. 2. The same with `targetDate` on the 15th and `monthOnly: true`. 3. A fixed monthly pot with `monthOnly: true` and no date. 4. `PUT` a Recurring jar dated on the 1st with the same date and `monthOnly: true`, then `false`. 5. `PUT` a month-only jar with no `monthOnly` field (a client from before the deploy), first with a date on the 1st, then on the 10th. 6. `PUT` it as a fixed monthly plan. 7. On a month-only Recurring jar: mark paid against the wrong month, dismiss a month that hasn't passed, and change its date to a month that already has a recorded cycle.
- **Expected:** 1: both plan 100 this month and the next two and finish the day before the 1st; only the first returns `monthOnly: true`. 2: 400 "A date given as just the month must be the 1st of that month." (a full date on the 15th is fine without the flag). 3: saved, `monthOnly: false`. 4: `monthOnly` follows the request; no revision is dated, no line is replanted and the open cycle is kept. 5: on the 1st it stays month-only; on the 10th it is a full date. 6: `monthOnly: false`. 7: "Insurance has no cycle due Jan 2027. Its current cycle is due Dec 2026.", "Insurance's cycle due Dec 2026 has not been missed; there is nothing to dismiss.", "A cycle due in Sep 2026 is already recorded for Insurance. Pick another month." (with the months of the case); a full-date jar keeps "1 Dec 2026" and "Pick another date.".
- **Automated:** Yes (JarMonthOnlyTests, the first eight)

### JAR-123 - A month runs before it is missed, and a payment in it is on time
- **Priority:** P2
- **Type:** Happy / Edge
- **Origin:** Christopher, 7 October 2026 (jar notes thread, on PR #324): "how about showing a warning while still in July and show missed in August?" Agreed rule 92.
- **Preconditions:** Owner; an account; a yearly jar "Insurance", 600, due **Mar 2027** by month; a goal "Holiday", 1,800, needed by **Jul 2027** by month.
- **Steps:**
  1. Let 1 March 2027 arrive with Insurance holding 450. Read its card on 1 March, 15 March and 31 March; try **Dismiss**. 2. Read it on 1 April. 3. Instead, put the missing 150 in on 10 March, let the insurer take the 600 from the jar on 20 March without pressing **Mark paid**, and read it on 15 March and on 1 April. 4. Instead, record the bill's payment on 15 March and **Mark paid**. 5. Instead, on 15 March edit Insurance to **Apr 2027**. 6. Let 1 July 2027 arrive with Holiday short; read it in July and in August. 7. The same with Insurance given the full date 1 Mar 2027.
- **Expected:** 1: amber **Behind**, "Due Mar 2027 · yearly", this month's plan the 150 still to go; **Mark paid** is there, **Dismiss** is not (the server refuses it: "Insurance's cycle due Mar 2027 has not been missed; there is nothing to dismiss."). 2: red **Deadline missed**, "Deadline Mar 2027 missed · €150.00 short", **Dismiss** offered. 3: from 10 March the cycle is **Funded** on time (closed 10 March), and the jar moves on to Mar 2028 with "Last cycle funded on time" and **Record the payment**; the payment on the 20th doesn't make it missed. 4: "Last cycle paid 15 Mar 2027 (€600.00)", not late. 5: the jar is due Apr 2027 and no missed cycle is recorded. 6: **Behind** from 1 July and still Behind in August: a goal is never "missed". 7: **Deadline missed** on 1 March itself, and a payment on 15 March reads late (full dates are unchanged).
- **Automated:** Yes (JarMonthOnlyTests, the last nine; client/src/pages/JarsPage.monthOnly.test.tsx — "a bill due this month and still short reads Behind")
