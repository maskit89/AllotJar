# Jars (savings)

**ID prefix:** JAR | **Scope:** Everything on the Jars screen at `/jars` (`client/src/pages/JarsPage.tsx`) and the money math behind it: the **Total saved / Monthly / Active jars** hero; the jar-card grid (jar graphic with clamped fill %, name, status chip, `%` pill, `€X of €Y` balance, progressbar, pace label, Edit link); the **New jar** / **Edit jar** modal (Name, Type Recurring vs Goal, Target, Saved-so-far/Opening balance, Next due + Repeats, Target date, Held in) with its client-side and server-side validation; the two-click **Archive** flow; how a jar fills from budgeted Savings-group lines and expense transactions (`JarBalances`), the `CreateJar` per-month contribution-line planting, the accrual calculator (`JarAccrualCalculator` — StraightLine / TargetByDate / ProportionalPool / DailyRate), the recurrence-as-pure-view invariant (stored anchor never advanced), status derivation (`JarDto` / `lib/jarStatus.ts`), archived-jar exclusion from lists / copy / reconciliation, the permissive server validators that keep imported/legacy jars editable, and the dashboard **Your jars** shelf (`DashboardPage.tsx`, current-month-only). | **Out of scope:** The **Allocation** engine (`/allocation`, `AllocationPage`, allocation profiles, income waterfall, member savings transfers, BalanceTilt/WaterFill) → the allocation sibling file; the budget grid's Savings-group UI (inline rename, add/delete a savings line, `SavingsAvailable` "avail." column rendering) and month create/copy/template mechanics → `08-categories-budget-lines.md` and `07-month-lifecycle.md` (jar-relevant seeding/copy behaviour is asserted here); the **Held in** account's reconciliation panel (Account/Balance/In jars/Float) → `12-accounts-reconciliation.md`; whole-transaction assignment / splits that move jar spend → `10-transactions.md`; the dashboard hero, bills strip and empty-month prompt → `06-dashboard-budget-view.md`; the full role matrix, cross-tab logout, silent refresh → the session & roles sibling files (only jar-page `canWrite` gating and the jar commands' 403/404 appear here); responsive / dark-mode / a11y sweeps live in their own files (referenced only where behaviour is jar-specific, e.g. the modal's 375px fit).

**Test data setup:** Unless a case says otherwise, assume an authenticated **Owner** (`canWrite = true`, `canEnterData = true`) of a **shared EUR household "Home"** with **2 members** *Alex* and *Robin*. Today (server UTC and browser clock) is **2026-07-15**, so the app-wide viewed month is **July 2026** and the accrual `asOf` is **2026-07-15** (calculator month anchors use the 1st). The `jars` feature flag is **on**; a single EUR account **Joint** exists. By PR #170 a fresh account is **empty** (zero jars, zero months) — cases that need jars/months say so. Money is `decimal(18,4)` server-side and integer minor units at scale 4 (`FACTOR = 10_000`) client-side; a jar's `currentBalance`, `requiredMonthlyContribution`, `projectedFullyFundedDate` and `status` are **always derived at read time**, never stored. Enum fields (`kind`, `accrual`) go over the wire as **numbers** (JarKind: Recurring=0, Goal=1; AccrualMethod: StraightLine=0, TargetByDate=1, ProportionalPool=2, DailyRate=3). The modal's amount fields use `parseAmount` → `parseMinor` ('' → 0; strips spaces/apostrophes; right-most of a mixed `,/.` pair is the decimal; rounds HALF-UP beyond 4 dp; rejects negatives / whitespace-only / `abc` / `1.2.3` / `1,2,3` → the modal shows "Enter valid amounts."). Client wiring is exercised by `client/src/pages/JarsPage.test.tsx`; jar domain/handler behaviour by `tests/AllotJar.Application.Tests/Application/{JarsTests,JarBudgetLinkTests,JarLifecycle,Savings,CreateBudgetMonth}Tests.cs`, `Domain/JarAccrualCalculatorTests.cs`, and the enforced-FK writers by `tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs`.

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
- **Preconditions:** Owner with two jars: "Home insurance" (currentBalance 120.00, requiredMonthly 25.00) and "Holiday" (currentBalance 300.00, requiredMonthly 50.00).
- **Steps:**
  1. Open `/jars`.
- **Expected:** Hero "Total saved" = **€420.00** (Σ currentBalance), tile "Monthly" = **+€75.00** (Σ requiredMonthlyContribution), tile "Active jars" = **2**. Section heading "Your jars" with a "+ New jar" button; one `JarCard` per jar in a responsive grid.
- **Automated:** Partial (JarsPage.test.tsx — "lists funds as jars with their balances and funded percentage" asserts cards, not the hero sums)

### JAR-003 - Jar card anatomy (balance, of-target, progressbar, pace)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** One jar "Home insurance": target 300.00, currentBalance 120.00, requiredMonthly 25.00, projectedFullyFundedDate 2026-11-01, status OnTrack.
- **Steps:**
  1. Open `/jars` and read the card.
- **Expected:** Jar graphic with `aria-label` "Home insurance: 40% funded" (120/300); title "Home insurance"; no status chip (OnTrack is quiet); a `40%` pill; balance line "**€120.00** of €300.00"; a `progressbar` (aria-label "Home insurance funding progress", `aria-valuenow=40`, min 0 max 100) filled 40%; pace label "**+€25.00/mo · full by Nov 2026**"; an "Edit" link (aria-label "Edit Home insurance") because `canManage`.
- **Automated:** Yes (JarsPage.test.tsx — cards + "shows a status chip and the projected finish")

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
- **Preconditions:** Two jars: "Sofa" (target 300.00, currentBalance 300.00, status FullyFunded) and "Slush" (target 0.00, currentBalance 500.00, status Unfunded).
- **Steps:**
  1. Open `/jars`.
- **Expected:** "Sofa" shows the teal "Funded" chip and **no** `%` pill (redundant next to Funded); its balance line shows only "€300.00" plus "of €300.00". "Slush" (target ≤ 0) shows **no** `%` pill and **no** "of €…" suffix — just "€500.00"; pace label "No target yet".
- **Automated:** Partial (JarsPage.test.tsx asserts the "Funded" chip and "Fully funded" pace; pill-absence not asserted)

### JAR-006 - Status chips: Behind / Overspent / Funded only
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Four jars with statuses OnTrack, Behind (Goal, target date 2026-01-01), Overspent (currentBalance −40.00), FullyFunded.
- **Steps:**
  1. Open `/jars`.
- **Expected:** Chips render only for the attention/celebration states: **Behind** (amber tone), **Overspent** (rose tone), **Funded** (teal tone). The OnTrack jar shows **no** chip (its pace line carries the projection instead). Matches `jarStatusChip` returning null for OnTrack/Unfunded.
- **Automated:** Yes (JarsPage.test.tsx — "shows a status chip and the projected finish"; lib/jarStatus.test.ts — chip states)

### JAR-007 - Pace-label variants for every state
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Jars covering: (a) monthly > 0 with projection, (b) monthly > 0 no projection (no target date), (c) FullyFunded monthly 0, (d) Unfunded target 0, (e) an OnTrack jar whose monthly is 0 for another reason.
- **Steps:**
  1. Open `/jars` and read each pace line.
- **Expected:** (a) "+€25.00/mo · full by Nov 2026"; (b) "+€25.00/mo"; (c) "Fully funded"; (d) "No target yet"; (e) bare em-dash "—". Never a bare "—" for a genuinely funded or target-less jar (`jarPaceLabel`).
- **Automated:** Yes (lib/jarStatus.test.ts — jarPaceLabel with/without projection, €0/mo funded, dash fallback)

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

### JAR-013 - Create a Goal jar with an optional target date
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → set Type = "Goal".
  2. Name "New kitchen", Target `5000`, "Target date" `2027-01-01`.
  3. Click "Add jar".
- **Expected:** The Recurring-only fields ("Next due"/"Repeats") are replaced by a single "Target date (optional)" input. `POST /jars` sends `kind:1`, `recurMonths:null`, `targetDate:"2027-01-01"`, `accrual:1`. Card "New kitchen" appears with a Goal that will read Behind only once past due (Goals never re-arm).
- **Automated:** Partial (JarsPage.test.tsx — "offers Recurring/Goal … Goal swaps to an optional target date"; POST body for Goal not asserted)

### JAR-014 - Create a Goal jar with no date (spreads over 12 months)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → Type "Goal", Name "Buffer", Target `1200`, leave "Target date" blank.
  2. Observe the preview, then "Add jar".
- **Expected:** Preview reads "Sets aside **≈ €100.00/mo** (no date — the remainder spreads over 12 months)" (1200 ÷ 12). `POST /jars` with `targetDate:null`. Server `TargetByDate` with no date also divides remaining by 12.
- **Automated:** Yes (JarsPage.test.tsx — "previews the monthly set-aside as you type"; Domain/JarAccrualCalculatorTests — TargetByDate ÷12 with no date)

### JAR-015 - "Saved so far" seeds the opening balance on create
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; no jars.
- **Steps:**
  1. "New jar" → Name "Car repairs", Target `600`, Type "Goal", "Saved so far" = `150`.
  2. "Add jar".
- **Expected:** The opening field is labelled "**Saved so far**" (create mode, no "Before tracking began…" helper). `POST /jars` sends `openingBalance:150`. The returned card balance = opening + any planted contributions (opening 150 at minimum); fill % reflects 150/600 = 25% before contributions.
- **Automated:** Partial (JarsPage.test.tsx — "labels the opening amount 'Saved so far' on create…" asserts the label; openingBalance value not asserted)

### JAR-016 - Live preview with a date (Recurring vs Goal phrasing)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Owner; today 2026-07-15.
- **Steps:**
  1. "New jar" (Type Recurring), Target `300`, "Next due date" `2026-12-01`; read the preview.
  2. Switch Type to "Goal", set Target `1200`, "Target date" `2027-07-01`; read the preview.
- **Expected:** Recurring: "Sets aside **≈ €60.00/mo** toward {1 Dec 2026, locale-formatted}, then it repeats" (remaining 300 ÷ 5 whole months Jul→Dec). Goal: "Sets aside **≈ €100.00/mo** until {1 Jul 2027}" (1200 ÷ 12) — " until <date>", not "then it repeats". Both prefixed "≈" (browser clock; may differ from the server by a month/cent at a boundary).
- **Automated:** No

### JAR-017 - Preview hides when target is 0 or unparseable
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; New-jar modal open.
- **Steps:**
  1. Leave Target blank, then type `0`, then type `abc`.
- **Expected:** No preview line shows in any of the three states (empty target parses to 0 → `targetMinor <= 0` → `null`; `abc` → `parseMinor` null → `null`). The preview reappears only once a positive parseable target is entered.
- **Automated:** No

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
- **Expected:** Recurring shows "Next due" (aria "Next due date") + "Repeats" (aria "Repeat cycle"). Switching to Goal removes "Repeat cycle" and shows a single "Target date (optional)" (aria "Target date"). The already-typed `targetDate` value carries across the swap (shared form field).
- **Automated:** Yes (JarsPage.test.tsx — "offers Recurring/Goal … Goal swaps to an optional target date")

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

### JAR-027 - Goal jar with target 0 and no date is allowed
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Owner; New-jar modal, Type "Goal", name "Someday".
- **Steps:**
  1. Leave Target blank and Target date blank, "Add jar".
- **Expected:** Accepted — the target/date guards apply only to **Recurring** creates. `POST /jars` sends `targetAmount:0`, `targetDate:null`, `kind:1`. The card reads status Unfunded, pace "No target yet". (This mirrors the auto-minted backing jar `Jar.ForSavingsLine` = Goal / TargetByDate / target 0.)
- **Automated:** No

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

### JAR-034 - Edit echoes the stored cover window and opening-as-of
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #142 / audit finding #5 — the modal doesn't surface `coverStart`/`coverEnd`/`openingAsOf`, so an unrelated edit must echo them, not null them (nulling a StraightLine jar's window flips ÷coverMonths to ÷12).
- **Preconditions:** Owner; an imported jar with `coverStart:2026-01-01`, `coverEnd:2026-12-31`, `openingAsOf:2025-12-31`.
- **Steps:**
  1. "Edit" the jar, change nothing else, click "Save jar".
- **Expected:** `PUT /jars/{id}` body contains `coverStart:"2026-01-01"`, `coverEnd:"2026-12-31"`, `openingAsOf:"2025-12-31"` — echoed from `editingJar`, not wiped. The jar's accrual math is unchanged after the save.
- **Automated:** Yes (JarsPage.test.tsx — "echoes the stored cover window and opening as-of when editing")

### JAR-035 - Edit echoes the stored accrual method (importer StraightLine survives)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #149 / permissive importer parity — the form has no Accrual control; edit must send `editingJar.accrual`, not force TargetByDate.
- **Preconditions:** Owner; an imported jar with `accrual:0` (StraightLine), cover window Jan–Dec 2026.
- **Steps:**
  1. "Edit" the jar, rename it, "Save jar".
- **Expected:** `PUT` body has `accrual:0` (echoed). The jar keeps StraightLine (target ÷ cover months), not the form's default `1`. Only genuinely new jars save `accrual:1`.
- **Automated:** Partial (JarsPage.test.tsx echoes cover window/opening-as-of in the same body; accrual echo not separately asserted; JarLifecycle/JarsTests cover server-side)

### JAR-036 - Legacy date-less Recurring jar is editable without inventing a date
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 — the required-date/target guards are create-only; a rename of an imported open-ended recurring jar must not be blocked (would 400 the server pre-fix).
- **Preconditions:** Owner; imported jar kind Recurring, `targetDate:null`, `targetAmount:0`, `recurMonths:12`.
- **Steps:**
  1. "Edit" it, rename to "Living Costs", "Save jar".
- **Expected:** No "needs its next due date" / "needs a target amount" error; `PUT` succeeds with `targetDate:null`. The edit path skips the Recurring create-guards entirely (`!editingId` gate).
- **Automated:** Yes (JarsPage.test.tsx — "lets a legacy date-less recurring jar be edited without inventing a date")

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

### JAR-041 - Edit preview tracks the Opening field live
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; jar "Home insurance" target 300, openingBalance 0, currentBalance 120, targetDate 2026-12-01, accrual TargetByDate.
- **Steps:**
  1. "Edit" it; change "Opening balance" from 0 to 60; watch the preview.
- **Expected:** The preview recomputes with base = editedOpening + (currentBalance − storedOpening) = 60 + (120 − 0) = 180, so remaining 120 spread over the months to due; it reacts to the field rather than freezing on the saved figure. (Approximate, "≈".)
- **Automated:** No

### JAR-042 - Edit preview is hidden for non-TargetByDate jars
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Owner; an imported jar with `accrual:0` (StraightLine).
- **Steps:**
  1. "Edit" the jar and change the Target.
- **Expected:** **No** preview line renders (the client's TargetByDate mirror wouldn't match the server's StraightLine figure, so it's suppressed when `editingJar.accrual !== TargetByDate`).
- **Automated:** No

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

### JAR-054 - TargetByDate accrual: remaining ÷ months-to-due, floored at 1, ÷12 with no date
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Owner; today 2026-07-15. Jars: (a) target 600, due 2027-01-01, balance 0; (b) target 1200, no date, balance 0; (c) target 300, due 2026-07-20 (this month), balance 0; (d) target 500, balance 500 (funded).
- **Steps:**
  1. Read each jar's "Monthly" contribution.
- **Expected:** (a) 600 ÷ 6 = **€100.00/mo**; (b) 1200 ÷ 12 = **€100.00/mo**; (c) months floored at 1 → 300 ÷ 1 = **€300.00/mo** (due this/next month); (d) remaining ≤ 0 → **€0.00/mo**, status FullyFunded. All rounded to 2 dp half-away-from-zero.
- **Automated:** Yes (Domain/JarAccrualCalculatorTests.cs — TargetByDate spreads remaining, floors at 1, zero once funded)

### JAR-055 - Server validators stay permissive (past date, target 0, date-less recurring)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 — required date/target for Recurring jars is client-form-only, so the ~41 imported/legacy jars survive `PUT`s.
- **Preconditions:** Owner; craft requests directly (bypassing the form).
- **Steps:**
  1. `POST`/`PUT` jars with: a past `targetDate`; `targetAmount:0`; kind Recurring with `targetDate:null`.
- **Expected:** All succeed (200/201) — the validator enforces only name (non-empty, ≤120), enum kinds/accrual, amount ranges, `recurMonths` ∈ [1,120] when present, and cover-window ordering. No "must have a date/target" rule server-side.
- **Automated:** Yes (JarLifecycleTests.cs — validator stays permissive for date-less recurring jars)

### JAR-056 - Past-due Recurring jar re-arms and reads OnTrack, not Behind
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 — `EffectiveTargetDate` rolls a Recurring anchor forward whole cycles from the stored anchor; a healthy recurring jar never reads Behind.
- **Preconditions:** Owner; today 2026-07-15; Recurring jar anchor 2026-01-01, recurMonths 12, not yet fully funded.
- **Steps:**
  1. Read the jar's status and pace on `/jars`.
- **Expected:** Effective due rolls to **2027-01-01**; status = **OnTrack** (no chip), and the contribution spreads over the months to the rolled date (not "the whole remainder this month"). The day-of-month is preserved across the roll (a 31st never drifts to the 28th).
- **Automated:** Yes (JarLifecycleTests.cs — past-due recurring reads OnTrack not Behind; month-end day preserved across rolls)

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
- **Expected:** Status = **Overspent** (rose chip); `currentBalance < 0` is the highest-priority status branch (ahead of Unfunded/FullyFunded/Behind). Fill % clamps to 0; balance renders "−€40.00"; pace "—" (monthly 0).
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
- **Preconditions:** Owner; current month; jars: one Overspent (has a chip), one OnTrack with requiredMonthly 25.
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

### JAR-064 - Cover-window ordering is validated
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Owner; craft a `POST`/`PUT` jar with `coverStart:2026-12-31`, `coverEnd:2026-01-01` (both set).
- **Steps:**
  1. Submit the request.
- **Expected:** 400 with "Cover end must be after cover start." The rule fires only when **both** dates are set; one-sided or absent windows pass. (The form never surfaces these fields — this guards importer/API writes.)
- **Automated:** Yes (JarsTests.cs — validator rejects bad cover window)

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
