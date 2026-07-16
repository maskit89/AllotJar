# Jars (savings)

**ID prefix:** JAR | **Scope:** Everything on `/jars` (`client/src/pages/JarsPage.tsx`): the jar list, hero (**"Total saved"** / **"Monthly"** / **"Active jars"**), empty state, per-jar `JarCard` (jar graphic + fill %, status chip Behind/Overspent/Funded, % pill, "€X of €Y" balance, progressbar, `jarPaceLabel`), and the **"New jar"/"Edit jar"** modal (Name, Type Recurring/Goal, Target, "Saved so far"/"Opening balance", "Next due"+"Repeats" vs "Target date (optional)", "Held in", live "≈ €X/mo" preview, two-click **Archive**). Covers `JarKind` Recurring-vs-Goal semantics, `TargetByDate` accrual + `RequiredMonthlyContribution` math, the recurrence-as-pure-view invariant (anchor never persisted, DTO returns anchor), the edit-echo of the un-surfaced cover window / accrual / openingAsOf (regression), archived jars (hidden from list, GET default, and month-copy carry-forward; no restore UI), the dashboard **"Your jars"** shelf (current-month-only), how jars fill from budgeted Savings lines (`CreateJar` planting + month-create append + "+ Add a savings goal" minting a backing jar), the two balance flavours, permissive server validators (imported jars survive edits), and jar↔budget-line linking across months. Endpoints: `GET/POST /api/jars`, `PUT /api/jars/{id}`, `PUT /api/jars/{id}/archive`. | **Out of scope:** the allocation engine (waterfall, profile, commit, "Fund the jars" step, savings pooling) → **14-allocation.md**; the account-side **Jar reconciliation** panel / "Held in" earmark view (Balance / In jars / Float) → **12-accounts-reconciliation.md** (this file asserts only the jar-side `fundingAccountId` control); the Savings-group budget-line CRUD surface on the dashboard (rename group, delete line, group totals, "avail." rollover) → **08-categories-budget-lines.md**; month create / copy / template mechanics and the empty-vs-balanced hero → **07-month-lifecycle.md** (referenced only where a jar changes the outcome); the full Owner/Admin/Limited/ReadOnly matrix → **25-roles-permissions.md** (only the area-specific `canWrite` gate on jar controls is here); dark-mode / responsive / axe sweeps → **26-ux-states.md** (only the mobile jar-modal fit is noted); feature-flag routing shell → **routing/shell file**. **Do not test for:** a DELETE jars endpoint (none — archive is a soft flag); a restore-jar UI (API-only); an Accrual-method dropdown in the form (removed in PR #149 — new jars are always `TargetByDate`); a per-jar renaming of the backing budget line when the jar is renamed (they are independent).

**Test data setup:** Local stack (API `:5099`, `ASPNETCORE_ENVIRONMENT=Development`) or beta (app.allotjar.com). Assume **today = 2026-07-16** (July 2026 = current budget month). Locale **en-GB comma-dot** so money renders `€1,234.56`; user `preferredCurrency` **EUR**. Feature flag **`jars` ON** (default). Money is integer minor units scale 4 client-side, `decimal(18,4)` server-side; target/opening range **±99,999,999,999,999.9999**; name max **120** chars; `RecurMonths` ∈ [1,120]. Passwords random `Aa1-<uuid>` (HIBP rejects common ones). Household **"Jar House"** (owner **jar-owner@example.test**, role Owner) with one EUR account **"Joint"** (balance 1,250.00). Baseline jars (all created via the form unless noted, `Accrual = TargetByDate`, `asOf` July 2026):
- **"Home insurance"** — Recurring, target **600.00**, Next due **2026-12-01**, Repeats **Yearly** (recurMonths 12), opening 0, Held in "Joint". → required monthly **€120.00** (600 ÷ 5 months Jul→Dec), status OnTrack, projected "full by Dec 2026".
- **"New kitchen"** — Goal, target **5,000.00**, no target date, opening **1,000.00**. → remaining 4,000 ÷ 12 = required **€333.33/mo**, projected "full by Aug 2027".
- **"Emergency Fund"** — Goal, target **0**, opening 0 (the opt-in sample jar). → status Unfunded, pace "No target yet".
- **"Road tax"** — an *imported* Recurring jar: `Accrual = StraightLine`, `CoverStart 2026-04-01`, `CoverEnd 2027-03-31`, `RecurMonths 12`, target 300.00 (used for edit-echo / non-TargetByDate cases).
- **"Old holiday"** — archived jar (`IsArchived = true`).

Same household also has **jar-limited@example.test** (Limited) and **jar-readonly@example.test** (ReadOnly). Solo variant: a fresh Owner in a 1-member household. Cross-tenant: second household owner **jar-other@example.test** owns jar "Foreign" (for ownership 403). Automation hints: `POST /jars` → **201** + `JarDto`; `PUT /jars/{id}` → 200; `PUT /jars/{id}/archive` body `{archived:bool}` → 200; there is **no DELETE**; unknown/foreign id → **404** `Sinking fund {id} was not found.` / **403**; the modal only mounts when `showForm && canWrite`.

---

## Jars page — list, hero, empty & loading states

### JAR-001 - Empty state when the household owns no jars
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner (Owner) in a household with zero jars.
- **Steps:**
  1. Open `/jars` (nav item "Jars").
- **Expected:**
  - `EmptyState` title **"No jars yet"**, description "Add a jar — give it a target and a date, and we'll work out what to set aside each month.", plus a **"+ New jar"** button (aria-label "New jar").
  - Hero shows **"Total saved" €0.00**, tile **"Monthly" +€0.00**, tile **"Active jars" 0**.
- **Automated:** Partial (client/e2e/a11y.spec.ts scans `/jars`; empty copy not asserted)

### JAR-002 - Hero aggregates Total saved, Monthly and Active jars across all jars
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** jar-owner; jars "Home insurance" (balance 0.00, req 120.00), "New kitchen" (balance 1,000.00, req 333.33), "Emergency Fund" (balance 0.00, req 0.00).
- **Steps:**
  1. Open `/jars` and read the hero + tiles.
- **Expected:**
  - Eyebrow **"Total saved"** = Σ currentBalance = 0 + 1,000.00 + 0 = **€1,000.00** (aria-label "Total saved: €1,000.00").
  - Tile **"Monthly"** = `+` Σ requiredMonthlyContribution = 120.00 + 333.33 + 0 = **+€453.33**.
  - Tile **"Active jars"** = count of listed (non-archived) jars = **3**. "Old holiday" (archived) is not counted.
- **Automated:** No

### JAR-003 - Loading placeholder while jars/accounts fetch
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** jar-owner; `GET /jars` pending.
- **Steps:**
  1. Open `/jars` with the fetch in flight.
- **Expected:** paragraph **"Loading…"** renders; neither the empty state nor cards appear until both `GET /jars` and `GET /accounts` settle (accounts failure is swallowed to `[]`).
- **Automated:** No

### JAR-004 - Load failure surfaces a single error banner
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** jar-owner; `GET /jars` rejected (500/network).
- **Steps:**
  1. Open `/jars`.
- **Expected:** an `ErrorBanner` with **"Could not load your jars."** above the (empty) list; no cards. `GET /accounts` rejecting alone does NOT trip this (it `.catch`es to `[]`).
- **Automated:** No

### JAR-005 - First-ever use: default account has no jars (samples are opt-in)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #170 / sample budget (with its Emergency Fund jar) is OPT-IN at sign-up
- **Preconditions:** Brand-new sign-up WITHOUT ticking "include sample data" (start-own-budget / leave-household paths).
- **Steps:**
  1. Register, land in the app, open `/jars`.
- **Expected:** "No jars yet" empty state — no starter "Emergency Fund" jar exists. Jar/allocation tests must not assume a seeded jar. (Only the opt-in seed creates the Emergency Fund backing jar via `BudgetSeeder`.)
- **Automated:** Partial (tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs — bootstrap-with-sample seeds a jar-backed group; the no-sample = no jar side is HouseholdBootstrapTests)

### JAR-006 - Read-only / limited role sees jars but no write affordances
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-readonly (ReadOnly) and separately jar-limited (Limited), household has ≥1 jar.
- **Steps:**
  1. Sign in as each; open `/jars`.
- **Expected:** cards render (hero, balances, chips, pace) but there is **no "+ New jar" button and no "Edit" link** (`canWrite` = Admin+ only), and the modal never mounts (`showForm && canWrite`). Managing jars needs Admin+; ReadOnly and Limited are both view-only here. (Full matrix → 25-roles-permissions.md.)
- **Automated:** No

---

## Jar card display

### JAR-007 - Jar card shows name, "€balance of €target", % pill and progressbar
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; "New kitchen" (Goal, balance 1,000.00, target 5,000.00, status OnTrack).
- **Steps:**
  1. Open `/jars`; inspect the "New kitchen" card.
- **Expected:**
  - Jar graphic filled to pct = round(1000/5000×100) = **20%** (aria label "New kitchen: 20% funded"); name "New kitchen".
  - Balance line **€1,000.00** with **"of €5,000.00"**.
  - A **20%** pill (shown because target > 0 and status ≠ FullyFunded).
  - `progressbar` with aria-label "New kitchen funding progress", `aria-valuenow=20`, min 0 / max 100, bar width 20%.
- **Automated:** No

### JAR-008 - Status chip "Behind" (amber) for an overdue non-rolling jar
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner; a **Goal** jar "Passport" target 100.00, target date **2026-03-01** (past), balance 20.00 (remaining 80 > 0). asOf July 2026.
- **Steps:**
  1. Open `/jars`; inspect the "Passport" card.
- **Expected:** an amber **"Behind"** badge (effectiveDue 2026-03-01 < asOf, and a Goal never re-arms). A healthy Recurring jar in the same position would NOT show Behind (it re-arms to next cycle).
- **Automated:** No

### JAR-009 - Status chip "Overspent" (rose) when balance is negative
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner; a jar whose spends exceed contributions so `currentBalance` < 0 (e.g. −50.00).
- **Steps:**
  1. Open `/jars`; inspect the card.
- **Expected:** a rose **"Overspent"** badge (balance < 0 wins over every other status). Fill % clamps to 0.
- **Automated:** No

### JAR-010 - Status chip "Funded" (teal) and the % pill is hidden
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner; a jar with balance == target (e.g. 600.00 of 600.00, remaining 0).
- **Steps:**
  1. Open `/jars`; inspect the card.
- **Expected:** a teal **"Funded"** badge; the **% pill is NOT rendered** (redundant next to "Funded"); pace label reads **"Fully funded"**; fill 100%.
- **Automated:** Partial (client/src/lib/jarStatus.test.ts covers the chip label; card render not asserted)

### JAR-011 - No chip for OnTrack or Unfunded (quiet defaults)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** jar-owner; "Home insurance" (OnTrack) and "Emergency Fund" (target 0 → Unfunded).
- **Steps:**
  1. Open `/jars`; inspect both cards.
- **Expected:** neither card shows a status badge (`jarStatusChip` returns null for OnTrack and Unfunded). "Home insurance" still shows its % pill; "Emergency Fund" shows NO % pill (target ≤ 0) and NO "of €…" (only the bare balance).
- **Automated:** Yes (client/src/lib/jarStatus.test.ts — "chips only attention+celebration states, quiet for OnTrack/Unfunded")

### JAR-012 - Pace label variants under each jar
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; jars covering each branch: "Home insurance" (req 120.00, projected Dec 2026), a no-projection contributing jar (req > 0, projected null), "Emergency Fund" (Unfunded, req 0), a FullyFunded jar (req 0), and a €0/mo jar with no matching status.
- **Steps:**
  1. Open `/jars`; read the pace line on each card.
- **Expected:** `jarPaceLabel` renders:
  - req > 0 with projection → **"+€120.00/mo · full by Dec 2026"**.
  - req > 0 without projection → **"+€X/mo"** (no "· full by").
  - FullyFunded, req 0 → **"Fully funded"**.
  - Unfunded, req 0 → **"No target yet"**.
  - otherwise req 0 → bare em-dash **"—"**.
- **Automated:** Yes (client/src/lib/jarStatus.test.ts — monthly set-aside w/ + w/o projected finish; zero-monthly explained; dash fallback)

### JAR-013 - Fill % clamps to 0–100; target ≤ 0 renders 0%
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; jar A balance 8,000.00 of target 5,000.00 (over-funded); jar B target 0, balance 250.00.
- **Steps:**
  1. Open `/jars`; inspect jar A and jar B graphics/progressbars.
- **Expected:** jar A fill clamps to **100%** (never > 100) though balance > target; jar B fill = **0%** (guard: target > 0 else 0), no % pill, no "of €…". Balance text still shows the raw €8,000.00 / €250.00.
- **Automated:** No

---

## Create jar — happy paths

### JAR-014 - Create a Goal jar end-to-end
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** jar-owner (canWrite); on `/jars`.
- **Steps:**
  1. Click **"+ New jar"** — modal titled **"New jar"** opens.
  2. Name = "Wedding"; Type = **Goal**; Target = "8000"; "Saved so far" = "500"; leave "Target date (optional)" blank; "Held in" = "Joint".
  3. Click **"Add jar"**.
- **Expected:**
  - `POST /jars` 201 with `{kind:1, targetAmount:8000, targetDate:null, accrual:1 (TargetByDate), openingBalance:500, recurMonths:null, fundingAccountId:<Joint>}`.
  - Modal closes; a "Wedding" card appears: balance €500.00 of €8,000.00, fill 6%, pace "+€625.00/mo · full by …" (remaining 7,500 ÷ 12). `fundCreated` analytics event fired with `kind:1`.
- **Automated:** Partial (client/e2e/a11y.spec.ts opens the jar modal; happy create not end-to-end automated)

### JAR-015 - Create a Recurring jar with due date and repeat cycle
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** jar-owner; on `/jars`, "Joint" account exists.
- **Steps:**
  1. "+ New jar"; Name = "Car insurance"; Type = **Recurring** (default); Target = "600"; "Next due" = 2026-12-01; **"Repeats"** = **Yearly**; "Held in" = "Joint".
  2. Click "Add jar".
- **Expected:** `POST /jars` `{kind:0, targetAmount:600, targetDate:"2026-12-01", recurMonths:12, accrual:1}` → 201. Card shows req **+€120.00/mo · full by Dec 2026** (600 ÷ 5 months). `recurMonths` sent = the "Repeats" value.
- **Automated:** No

### JAR-016 - Live preview line for a Goal with a target date ("until")
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; New-jar modal open, Type = Goal.
- **Steps:**
  1. Enter Target = "1200"; "Target date (optional)" = 2027-07-01; leave "Saved so far" blank.
- **Expected:** an aria-live line **"Sets aside ≈ €100.00/mo until 1 Jul 2027"** (remaining 1,200 ÷ 12 months to date). Updates live as the fields change; hidden the moment target is blank/0.
- **Automated:** No

### JAR-017 - Live preview for a Recurring jar ("toward … then it repeats")
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; New-jar modal, Type = Recurring.
- **Steps:**
  1. Target = "600"; "Next due" = 2026-12-01; Repeats = Yearly.
- **Expected:** **"Sets aside ≈ €120.00/mo toward 1 Dec 2026, then it repeats"**. The date shown is the recurrence-adjusted (`effectiveDueIso`) date; with a future due it equals the entered date.
- **Automated:** No

### JAR-018 - Preview with no date spreads over 12 months
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** jar-owner; New-jar modal, Type = Goal, no date.
- **Steps:**
  1. Target = "2400"; leave "Target date (optional)" blank.
- **Expected:** **"Sets aside ≈ €200.00/mo (no date — the remainder spreads over 12 months)"** (2,400 ÷ 12). Marked "≈" — a browser-clock estimate that may differ from the server by a cent/month at a boundary.
- **Automated:** No

### JAR-019 - "Saved so far" seeds the opening balance and shifts the preview
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; New-jar modal, Type = Goal.
- **Steps:**
  1. Target = "5000"; "Saved so far" = "1000"; no date.
- **Expected:** preview = (5,000 − 1,000) ÷ 12 = **≈ €333.33/mo**. On save, `openingBalance:1000`; the card's balance starts at €1,000.00 (opening + any planted lines). "Saved so far" binds `openingBalance`, NOT `currentBalance`.
- **Automated:** No

### JAR-020 - "Held in" lists accounts with a "No account" default
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** jar-owner; accounts "Joint" and "Visa" exist.
- **Steps:**
  1. Open the New-jar modal; open the **"Held in"** select (aria "Funding account").
- **Expected:** first option **"No account"** (value ""), then "Joint", "Visa" by list order. Default is "No account" → saved `fundingAccountId:null`. Selecting an account earmarks the jar for the accounts reconciliation view (asserted in 12-accounts-reconciliation.md).
- **Automated:** No

### JAR-021 - "Held in" helper prompt when the household has no accounts
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** jar-owner in a household with **zero accounts**.
- **Steps:**
  1. Open the New-jar modal; look under "Held in".
- **Expected:** select shows only **"No account"**; helper text **"Add accounts to earmark a jar's cash."** appears. Jar can still be created (fundingAccountId null).
- **Automated:** No

---

## Create jar — validation (Negative / Boundary)

### JAR-022 - Empty name is rejected client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** jar-owner; New-jar modal.
- **Steps:**
  1. Leave Name blank; Type Goal; Target "100"; click "Add jar".
- **Expected:** in-modal ErrorBanner **"Give the jar a name."**; no `POST`. (Server would also reject with "A fund needs a name.".)
- **Automated:** No

### JAR-023 - Whitespace-only name is rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; New-jar modal.
- **Steps:**
  1. Name = "   " (spaces only); Target "100"; click "Add jar".
- **Expected:** **"Give the jar a name."** (`form.name.trim() === ''`); no request.
- **Automated:** No

### JAR-024 - Non-numeric / negative amounts rejected as invalid
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** jar-owner; New-jar modal, Type Goal.
- **Steps:**
  1. Name "X"; Target = "abc" (or "-50", or "1.2.3"); click "Add jar".
- **Expected:** **"Enter valid amounts."** (`parseMinor` returns null for non-numeric, negatives, malformed separators); no `POST`. The same applies to a bad "Saved so far".
- **Automated:** No

### JAR-025 - New Recurring jar without a target amount is blocked
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** jar-owner; New-jar modal, Type = Recurring.
- **Steps:**
  1. Name "Tax"; leave Target blank (or "0"); Next due 2026-12-01; click "Add jar".
- **Expected:** **"Give the recurring jar a target amount."** (target ≤ 0 on a NEW Recurring jar). Client-only guidance — the server stays permissive.
- **Automated:** No

### JAR-026 - New Recurring jar without a next-due date is blocked
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** jar-owner; New-jar modal, Type = Recurring.
- **Steps:**
  1. Name "Tax"; Target "300"; leave "Next due" blank; click "Add jar".
- **Expected:** **"Give the recurring jar its next due date."** No `POST`. (This is exactly the pre-submit check; the SERVER validator accepts a date-less Recurring jar — see JAR-062.)
- **Automated:** Partial (client/src/pages/JarsPage.test.tsx — "Recurring jar without a due date blocked client-side")

### JAR-027 - Empty target parses as 0 (a Goal with no target is allowed)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; New-jar modal, Type = **Goal**.
- **Steps:**
  1. Name "Rainy day"; leave Target blank; click "Add jar".
- **Expected:** `parseAmount('')` → 0, so no "Enter valid amounts."; the jar saves with `targetAmount:0`, status **Unfunded**, pace "No target yet". (Only NEW *Recurring* jars require a positive target.)
- **Automated:** No

### JAR-028 - Very large target: in range accepted, over range 400s at the server
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; New-jar modal, Type Goal.
- **Steps:**
  1. Target = "99999999999999.9999" → save; then Target = "100000000000000" → save.
- **Expected:** the first saves (at the max). The second passes the client (`parseMinor` has no max) but the server returns **400** `Target amount is out of range.` — the modal falls back to **"Could not add that jar."** (server field text is not surfaced verbatim).
- **Automated:** No

### JAR-029 - More than 4 decimal places rounds half-up to 4 dp
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; New-jar modal, Type Goal.
- **Steps:**
  1. Target = "100.12345"; click "Add jar".
- **Expected:** `parseMinor` rounds >4 dp half-up to scale 4 → stored `targetAmount = 100.1235` (minor 1001235). Money never uses floats.
- **Automated:** No

### JAR-030 - Long / unicode / emoji name; 120 char boundary
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; New-jar modal.
- **Steps:**
  1. Name = 120-char string incl. emoji/unicode (e.g. "🎄 Christmas — famille …" padded to 120) + Target "100" → save.
  2. Repeat with a 121-char name via raw `POST /jars`.
- **Expected:** 120 chars accepted and rendered truncated on the card (CSS `truncate`, not data loss). 121 chars → server **400** `A fund needs a name.` is NOT it — MaxLength(120) fires; UI shows "Could not add that jar.". Emoji/unicode preserved.
- **Automated:** No

### JAR-031 - Create request failure rolls the modal back with an add error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** jar-owner; New-jar modal filled validly; `POST /jars` forced to 500.
- **Steps:**
  1. Click "Add jar".
- **Expected:** modal stays open showing **"Could not add that jar."**; no card added; `saving` clears so the button is usable again.
- **Automated:** No

---

## Edit jar

### JAR-032 - Edit renames a jar and updates the card in place
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; "New kitchen" jar exists.
- **Steps:**
  1. On its card click **"Edit"** (aria "Edit New kitchen") — modal titled **"Edit jar"** opens prefilled.
  2. Change Name to "Kitchen reno"; click **"Save"** (aria "Save jar").
- **Expected:** `PUT /jars/{id}` 200; the card's title becomes "Kitchen reno"; `fundEdited` event with `kind`. The list entry is replaced by the returned DTO (`setJars map`).
- **Automated:** No

### JAR-033 - Edit relabels the amount field "Opening balance" with the double-count guard
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR A (jar rework) / "Saved so far" double-count trap (audit finding #6)
- **Preconditions:** jar-owner; "New kitchen" (opening 1,000.00, currentBalance 1,000.00 + any planted).
- **Steps:**
  1. Open the Edit modal; inspect the second amount field.
- **Expected:** the field is labelled **"Opening balance"** (not "Saved so far") and prefilled with the STORED opening (1,000.00, via `toEditString`), with helper **"Before tracking began — the card shows the live total."** Retyping the card's live balance here would double-count contributions — the helper exists to stop that.
- **Automated:** No

### JAR-034 - Editing an imported jar echoes its cover window & accrual (not wiped)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #142/#149 / edit must not null coverStart/coverEnd/openingAsOf/accrual (audit finding #5)
- **Preconditions:** jar-owner; imported jar **"Road tax"** (`Accrual = StraightLine`, CoverStart 2026-04-01, CoverEnd 2027-03-31, RecurMonths 12).
- **Steps:**
  1. Edit "Road tax", change only the Name to "Road tax 2026", click "Save".
- **Expected:** the `PUT` body **echoes** `coverStart:2026-04-01, coverEnd:2027-03-31, accrual:0 (StraightLine), openingAsOf:<stored>` from `editingJar` (not null). The StraightLine ÷ cover-months (12-month window) math is preserved — the required monthly does NOT silently switch to ÷12 TargetByDate. The modal never surfaces these fields.
- **Automated:** No

### JAR-035 - Editing a legacy Recurring jar skips the new-jar required-target/date checks
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 / server permissive; form guidance is NEW-jar only
- **Preconditions:** jar-owner; an imported date-less Recurring jar "Open pool" (targetDate null, targetAmount 0).
- **Steps:**
  1. Edit "Open pool", change the Name, click "Save".
- **Expected:** no "Give the recurring jar a target amount." / "…next due date." (the `!editingId` guard skips both in edit mode); save succeeds — legacy/imported jars stay editable without inventing values.
- **Automated:** No

### JAR-036 - Editing a passed Recurring jar does NOT advance its stored anchor date
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #149 / recurrence is a pure view — anchor never persisted; DTO returns the anchor
- **Preconditions:** jar-owner; Recurring jar "Insurance" anchor `TargetDate = 2026-03-01` (already passed), RecurMonths 12. On the card its *effective* due has rolled to 2027-03-01.
- **Steps:**
  1. Edit "Insurance" — the "Next due" field prefills.
  2. Change only the Target; click "Save"; reopen the Edit modal.
- **Expected:** the "Next due" field prefills with the **stored anchor 2026-03-01** (not the rolled 2027-03-01), and the round-trip PUT sends 2026-03-01 back unchanged — the anchor is never silently advanced. (The roll is applied only virtually in status/seeding via `EffectiveTargetDate`.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/JarAccrualCalculatorTests.cs — EffectiveDate rolls, anchor never persisted; DTO round-trip in JarLifecycleTests)

### JAR-037 - Switching a passed Recurring jar to Goal keeps the real anchor date
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 / DTO returns anchor so switch keeps the chosen date, not a rolled one
- **Preconditions:** jar-owner; Recurring jar with passed anchor 2026-03-01 (rolled effective 2027-03-01).
- **Steps:**
  1. Edit the jar; change Type from Recurring to **Goal**; the field becomes "Target date (optional)" prefilled from `form.targetDate`; click "Save".
- **Expected:** the Goal keeps **2026-03-01** (the anchor), not the rolled 2027-03-01; `recurMonths` is sent `null` for the Goal (kind↔recurMonths lockstep). The Goal's date never rolls thereafter.
- **Automated:** No

### JAR-038 - Non-standard stored recurMonths is preserved as an extra option
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** jar-owner; a Recurring jar with `RecurMonths = 24` set via the API/importer.
- **Steps:**
  1. Edit it; open the **"Repeats"** select.
- **Expected:** besides Yearly / Every 6 months / Every 3 months / Monthly, the select shows the current value as **"Every 24 months"** so saving doesn't silently rewrite it to a standard cadence.
- **Automated:** No

### JAR-039 - Update falls back request ?? stored ?? 12 so a stale client can't reset the cycle
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #149 / UpdateJarCommandHandler kind↔RecurMonths lockstep
- **Preconditions:** jar-owner; Recurring jar with `RecurMonths = 3`.
- **Steps:**
  1. Send `PUT /jars/{id}` with `kind:0` and `recurMonths` omitted/null (simulating a stale client).
- **Expected:** the server keeps the stored cycle (`request ?? stored ?? 12` → 3), it does NOT reset to 12. Switching `kind:1` (Goal) sets `recurMonths` null regardless of request.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarLifecycleTests.cs)

### JAR-040 - Preview line is hidden when editing a non-TargetByDate imported jar
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** jar-owner; imported "Road tax" (`Accrual = StraightLine`).
- **Steps:**
  1. Edit "Road tax"; enter/adjust the Target.
- **Expected:** the "Sets aside ≈ €X/mo" preview does NOT render (`editingJar.accrual !== TargetByDate` short-circuits it) — the client math would not match the server's StraightLine figure, so it stays silent rather than mislead.
- **Automated:** No

### JAR-041 - Save-edit failure keeps the modal open with a save error
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** jar-owner; Edit modal open; `PUT /jars/{id}` forced to 500.
- **Steps:**
  1. Click "Save".
- **Expected:** modal stays open, **"Could not save that jar."**; the list is unchanged; button re-enables.
- **Automated:** No

---

## Recurrence & accrual math

### JAR-042 - TargetByDate required monthly = remaining ÷ whole months to due
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; "Home insurance" target 600.00, opening 0, due 2026-12-01, asOf July 2026.
- **Steps:**
  1. Open `/jars`; read the card's monthly + hero "Monthly".
- **Expected:** required = Round2((600 − 0) ÷ max(1, 5 months)) = **€120.00/mo**; balance 0 → 0% funded; projected "full by Dec 2026". Rounding is 2 dp away-from-zero (Excel ROUND parity).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Domain/JarAccrualCalculatorTests.cs — TargetByDate spreads remaining over months-until-due)

### JAR-043 - No date spreads the remainder over 12 months (never exactly finishes)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; Goal "New kitchen" target 5,000.00, opening 1,000.00, no date.
- **Steps:**
  1. Read the monthly on the card.
- **Expected:** required = Round2((5,000 − 1,000) ÷ 12) = **€333.33/mo** (÷12 default when no date). Because balance grows but the divisor stays 12, a date-less jar keeps proposing a positive amount and never reads exactly funded until spends/opening close the gap.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Domain/JarAccrualCalculatorTests.cs)

### JAR-044 - A past-due Recurring jar re-arms (not "Behind"); a past-due Goal is "Behind"
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner; Recurring "Insurance" anchor 2026-03-01, RecurMonths 12, remaining > 0; Goal "Passport" date 2026-03-01, remaining > 0. asOf July 2026.
- **Steps:**
  1. Open `/jars`; compare the two cards.
- **Expected:** "Insurance" shows **OnTrack** with an effective due of 2027-03-01 and spreads its remaining over the months to that rolled date (no "Behind" chip). "Passport" (a Goal, cannot roll) shows the amber **"Behind"** chip (2026-03-01 < asOf).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/JarAccrualCalculatorTests.cs — recurring EffectiveDate rolls forward preserving month-end days)

### JAR-045 - Funded jar reports €0/mo and "Fully funded"
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** jar-owner; jar balance == target (remaining 0).
- **Steps:**
  1. Read the card.
- **Expected:** required monthly = **0** (remaining ≤ 0 → 0); status FullyFunded → teal "Funded" chip; pace "Fully funded"; `projectedFullyFundedDate` null. Contributes €0.00 to the hero "Monthly".
- **Automated:** No

### JAR-046 - projectedFullyFundedDate = asOf + ceil(remaining ÷ required) months
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** jar-owner; "New kitchen" remaining 4,000, required 333.33, asOf July 2026.
- **Steps:**
  1. Read the pace label.
- **Expected:** monthsNeeded = ceil(4000 ÷ 333.33) = 13 → asOf.AddMonths(13) = **Aug 2027** → "+€333.33/mo · full by Aug 2027". Null when remaining 0 or required 0.
- **Automated:** No

---

## Archive & restore

### JAR-047 - Archive is a two-click confirm that removes the jar from the list
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #150 / archive gained a two-click confirm (was none pre-fix)
- **Preconditions:** jar-owner; Edit modal open on "Home insurance".
- **Steps:**
  1. Click **"Archive jar"** (aria "Archive Home insurance").
  2. Observe it arms to **"Really archive?"** (rose, aria "Confirm archive Home insurance"); click again.
- **Expected:** first click only arms (no request). Second click → `PUT /jars/{id}/archive` `{archived:true}` 200; the jar disappears from the list immediately (`filter`), hero totals drop by its balance/monthly, modal closes; `fundArchived` event. History is retained server-side (soft flag).
- **Automated:** No

### JAR-048 - Archived jars are excluded from the default jars list
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner; "Old holiday" archived.
- **Steps:**
  1. Open `/jars`.
- **Expected:** "Old holiday" is not listed and not counted in "Active jars" (`GET /jars` defaults `includeArchived=false`; the client never passes the flag). It is likewise excluded from the accounts reconciliation and month-copy carry-forward.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarLifecycleTests.cs / JarsTests.cs — archived excluded from list)

### JAR-049 - There is no in-app way to view or restore archived jars
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** jar-owner; an archived jar exists.
- **Steps:**
  1. Inspect `/jars` for any "show archived" toggle or restore control.
- **Expected:** none exists — the list request never passes `includeArchived`, and there is no restore button. Restore is only possible via `PUT /jars/{id}/archive {archived:false}` at the API.
- **Automated:** No

### JAR-050 - Archive request failure surfaces an archive error
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** jar-owner; Edit modal armed to "Really archive?"; `PUT …/archive` forced to 500.
- **Steps:**
  1. Click "Really archive?".
- **Expected:** modal stays open, **"Could not archive that jar."**; the jar remains in the list; button re-enables.
- **Automated:** No

---

## Dashboard "Your jars" shelf

### JAR-051 - Jars shelf renders only on the current calendar month
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #168 / shelf is current-month-only (it shows all-time balances)
- **Preconditions:** jar-owner; ≥1 jar; viewing July 2026 (today's month).
- **Steps:**
  1. Open `/` on the current month.
- **Expected:** a **"Your jars"** card with "€X saved" (Σ `currentBalance`) and one row per jar (graphic, name, balance, then a status chip OR "+€X/mo"). It appears because `jars.length > 0 && isCurrentMonth`.
- **Automated:** No

### JAR-052 - Shelf is hidden on past and future months
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner; ≥1 jar.
- **Steps:**
  1. On `/`, use the month navigator `‹ / ›` to move to June 2026, then August 2026.
- **Expected:** the "Your jars" shelf is **absent** on both — it deliberately shows only on today's month because the balances are all-time, not month-scoped. (The Savings-group budget rows still show per-month figures.)
- **Automated:** No

### JAR-053 - Shelf is hidden when the household owns no jars
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** jar-owner in a jar-less household; current month.
- **Steps:**
  1. Open `/`.
- **Expected:** no "Your jars" shelf (`jars.length > 0` fails). The dashboard's `/jars` fetch is unconditional (it ignores the `jars` feature flag) but a non-array/failed response just leaves the shelf empty.
- **Automated:** No

### JAR-054 - Shelf per-jar shows a status chip, else the monthly contribution
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** jar-owner; a "Behind" Goal jar and an OnTrack jar with req > 0; current month.
- **Steps:**
  1. Read each shelf row.
- **Expected:** the Behind jar shows its amber chip; the OnTrack jar (no chip) falls back to **"+€X/mo"** — the chip wins when present. No edit affordances on the shelf.
- **Automated:** No

---

## Jar ↔ budget-line linking across months

### JAR-055 - Creating a jar plants its contribution line in the current and every future month
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #142 / "jars never fill organically" gap — CreateJar now plants Savings lines
- **Preconditions:** jar-owner; budget months exist for July 2026 (current) and Aug 2026 (future); no Aug-2027 month.
- **Steps:**
  1. Create Goal jar "Laptop" target 1,200.00, opening 0, no date.
  2. Open `/` July and August; expand the Savings group.
- **Expected:** a "Laptop" Savings line appears in **July and August** (first Savings group, or a new group named "Savings" if none), each planned at the accrual amount recomputed with earlier plantings folded in (`OpeningBalance + planted`). The `POST` DTO's `currentBalance = opening + planted` so the jar card matches the next GET. Non-existent future months get their line only when created later.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs)

### JAR-056 - Past months are untouched by a newly created jar
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** jar-owner; a June 2026 month exists (past); create a jar in July.
- **Steps:**
  1. After creating the jar, open `/` June 2026; expand Savings.
- **Expected:** no new line for the jar in June — CreateJar only plants from the current month forward (`m.Year > asOf.Year || (== year && Month >= asOf.Month)`). June's history is preserved.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs)

### JAR-057 - Creating a month appends a line for every active jar not already present
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** jar-owner; jars "Home insurance" and "New kitchen" exist; no September 2026 month yet.
- **Steps:**
  1. Create September 2026 (blank / template / copy) from the dashboard.
- **Expected:** September carries a Savings line per active jar (alphabetical, case-insensitive), planned = each jar's accrual requirement, in the first Savings group (created as "Savings" if none). This is why a blank month for a jar-owning household is not empty. (Month-create mechanics detailed in 07-month-lifecycle.md.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application — month-create appends jar lines)

### JAR-058 - Adding a "+ Add a savings goal" budget line mints a backing jar
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #142 / SavingsId is an enforced FK — every savings line mints a real Jar via SavingsLines.AddBackingJar
- **Preconditions:** jar-owner; on `/` current month, a Savings group exists.
- **Steps:**
  1. In the Savings group use **"+ Add a savings goal"**, enter "Christmas", click "Add".
  2. Open `/jars`.
- **Expected:** a new **"Christmas"** jar exists on `/jars` (Kind = Goal, Accrual = TargetByDate, target 0 → Unfunded, "No target yet"), created server-side to back the line (never a bare Guid). Renaming the budget line later does NOT rename the jar; deleting the line does NOT delete the jar (it re-appends next month). This write path is FK-covered in integration tests.
- **Automated:** Yes (tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs — enforced-FK writer on real SQL Server)

### JAR-059 - Month copy drops archived-jar lines but keeps a dangling SavingsId line
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #167 / copy skip keys on archivedJarIds, never on "!activeJars.Contains"
- **Preconditions:** jar-owner; a source month whose Savings group has a line for archived "Old holiday" AND a line whose SavingsId points to no jar row (dangling, e.g. imported).
- **Steps:**
  1. Copy the source month into a new month (**"Copy {Month Year}"**).
- **Expected:** the new month **omits** the "Old holiday" line (archived jar) but **still copies** the dangling-SavingsId line as-is. (On real SQL Server a dangling id can't exist due to the FK; the skip must key on real archived ids so InMemory-seeded dangling ids survive.)
- **Automated:** No

### JAR-060 - Two balance flavours: Jars page total vs budget-grid "avail."
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** jar-owner; a jar with **opening 200.00** plus a planted future-month line, currentBalance 260.00; viewing the current month's Savings group where its "avail." reads 60.00.
- **Steps:**
  1. Compare the jar's card balance on `/jars` with its Savings line "avail." on `/` for the current month.
- **Expected:** `/jars` shows `openingBalance + Σ all months (incl. future plantings) − spends` = **€260.00**; the budget grid "avail." = `Σ (planned − spend) for months ≤ viewed`, **excluding OpeningBalance** = **€60.00**. The legitimate difference is the opening balance (and any future-month plantings) — they are only equal on the current month with zero opening. This is why the shelf is current-month-only.
- **Automated:** Partial (tests/AllotJar.Application.Tests — SavingsAvailable excludes opening; JarBalances includes it)

### JAR-061 - A jar-owning household's blank month is born over-budgeted, not empty
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #172 / empty ≠ balanced; appended accrual-planned savings lines
- **Preconditions:** jar-owner with ≥1 active jar (e.g. "Home insurance" req 120.00); no October 2026 month.
- **Steps:**
  1. Create October 2026 with **"Start a blank budget"** (income 0).
- **Expected:** October is NOT the empty "Plan your income…" state — the auto-appended jar Savings lines give it planned > 0 with income 0, so the hero reads the rose **"€X over-budgeted — trim a line"** (e.g. €120.00 over). Truly-empty months only exist for jar-less households. (Full hero-state coverage in 07-month-lifecycle.md.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/RemainingToBudgetTests.cs — IsBalanced requires income; client DashboardPage.test.tsx)

---

## Server validators, permissiveness & imported jars

### JAR-062 - Server accepts a date-less Recurring jar (permissive validators)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #149 / server validators stay permissive so importer/legacy jars survive
- **Preconditions:** jar-owner; raw API access.
- **Steps:**
  1. `POST /jars` with `{name:"Pool", kind:0 (Recurring), targetAmount:0, targetDate:null, recurMonths:12}`.
- **Expected:** **201** — the server does NOT enforce a target or date for a Recurring jar (that is client-form guidance only; see JAR-025/026). Past target dates and target 0 are likewise accepted.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/JarLifecycleTests.cs — Validator_StaysPermissive_ForDatelessRecurringJars)

### JAR-063 - CoverEnd not after CoverStart is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** jar-owner; raw API (the form never surfaces the cover window).
- **Steps:**
  1. `POST`/`PUT` a jar with `coverStart:2026-06-01, coverEnd:2026-06-01` (equal) or coverEnd earlier.
- **Expected:** **400** with `CoverEnd`: **"Cover end must be after cover start."** The rule fires only when BOTH are set (a jar with just one, or neither, is fine).
- **Automated:** No

### JAR-064 - RecurMonths outside 1–120 is rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; raw API.
- **Steps:**
  1. `POST` a Recurring jar with `recurMonths:0`, then `121`, then `120`, then `1`.
- **Expected:** 0 and 121 → **400** `Repeat cycle must be between 1 and 120 months.`; **1** and **120** accepted (inclusive bounds). Non-standard-but-valid values (e.g. 24) round-trip and show as "Every 24 months" in the form (JAR-038).
- **Automated:** No

### JAR-065 - Negative opening balance is allowed by the server
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** jar-owner; raw API (the client blocks negatives via parseMinor — JAR-024).
- **Steps:**
  1. `POST` a jar with `openingBalance:-50.00` (within ±max).
- **Expected:** **201** — negative opening is explicitly permitted (`OpeningBalance ∈ [−max, +max]`), for importer parity; out of range → 400 `Opening balance is out of range.`. A negative resulting `currentBalance` renders "Overspent".
- **Automated:** No

### JAR-066 - Editing an unknown or foreign-owned jar → 404 / 403
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** jar-owner; a random Guid, and jar "Foreign" owned by jar-other's household.
- **Steps:**
  1. `PUT /jars/{randomGuid}` a valid body.
  2. `PUT /jars/{foreignJarId}` a valid body.
- **Expected:** unknown id → **404** `Sinking fund {id} was not found.`; a jar owned by another household → **403** (ownership enforced by `OwnerId`). There is no DELETE route at all.
- **Automated:** No

---

## Feature flag & access

### JAR-067 - jars feature flag off hides the page, nav and endpoints
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `features.jars = false` (server `GET /features`).
- **Steps:**
  1. Sign in; look for the "Jars" nav item; try to reach `/jars` by URL; call `GET /jars` directly.
- **Expected:** the "Jars" nav link is hidden (`AppNav` gates on `features.jars`); the `/jars` route is unregistered so the SPA redirects `*` → `/`; every `api/jars` endpoint returns **404** (`[FeatureGate(Jars)]`). Note the client defaults ALL flags ON until `/features` resolves, so a brief flag-on flash is possible before the response arrives.
- **Automated:** Partial (client/src/components/AppNav.test.tsx — Funds/Jars hidden when the flag is off)

---
