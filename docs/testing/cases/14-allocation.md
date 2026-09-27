# Allocation (income split engine)

**ID prefix:** ALLOC | **Scope:** Everything on the Allocation screen at `/allocation` (`client/src/pages/AllocationPage.tsx`) for shared households: the solo "Add people first" gate and the no-profile "Set up allocation" state; the **Income to allocate / Shared spending / To savings** hero and its by-construction reconciliation to the pool; the **How {month} is allocated** waterfall card (step labels "Cover shared costs" / "Fund the jars" / "Pocket money" / "Split remainder to savings", the terminal-row highlight, per-step totals); the per-member savings tiles ("Savings … → saves", residual, "Projected balance", "No savings account set" note); the **Allocation settings** / **Set up allocation** modal (source account, pocket money, split-shared-costs Equally/By income, send-savings-to Balance/Equally/By income, balance lean, InfoHints) with client + server validation; **Cancel/backdrop revert** of unsaved edits (PR #163); the **Allocate {month}** commit flow (idempotency banner, no-source guard, stranded-surplus + nothing-to-save notes); and the underlying `IncomeAllocator`/`AllocationPlanner` math — Equal / By income / BalanceTilt+WaterFill splits, `ExcludeFromAllocation` exclusion, member savings balances, the WaterFill-overflow and dangling-savings-account regressions, and the EUR-hardcoded / non-zero-padded `BankReference` transfer composition. | **Out of scope:** The **Jars** page, jar accrual and the dashboard jar shelf → `13-jars.md`; per-member **Savings account** selects, `NetMonthlyIncome`, add/archive member, `isShared` derivation and the full role matrix → the households/people sibling (only allocation-page `canWrite`/`canEnterData` gating and the solo gate appear here); the Savings-group budget grid and month create/copy that seed the planned figures the engine reads → `08-categories-budget-lines.md` and `07-month-lifecycle.md`; the account **reconciliation**/earmark panel and account balances feeding the tilt → `12-accounts-reconciliation.md`; the transfers the commit writes, viewed as register rows → `11-transfers.md`; session/refresh, cross-tab logout and responsive/dark/a11y sweeps → their own files (referenced only where behaviour is allocation-specific, e.g. the InfoHint-in-label gotcha).

**Test data setup:** Unless a case says otherwise, assume an authenticated **Owner** (`canWrite = true`, `canEnterData = true`) of a **shared EUR household "Home"** with **2 active members** — *Alex* (`NetMonthlyIncome` 3,000.00, personal savings account **"Alex Savings"** balance 1,000.00) and *Robin* (`NetMonthlyIncome` 2,000.00, personal savings account **"Robin Savings"** balance 500.00). The browser locale is **en-GB** and today (browser clock + server UTC) is **2026-07-15**, so `GET /budget/current` returns **July 2026** and `monthName` renders **"July"**. One EUR source account **"Joint"** exists. The `householdAllocation` feature flag is **on**. The **standard profile** (what the client always writes) is: source `Joint`, pocket money `0.00`, split shared costs **Equally**, send savings to **Balance**, balance lean **25**, name "Household allocation", four rules in order `FundEnvelopes(0)`, `FundJars(1)`, `FixedPerMember(2)`, `SplitRemainderToMembers(3)`. The **worked-example July budget** has planned **expense** categories totalling **2,000.00** (envelopes) and planned **Savings** categories totalling **500.00** (jars); with pocket **0** that gives pool **5,000.00** (3,000+2,000), shared spending **2,500.00** (2,000+500+0) and **To savings 2,500.00**. Enums go over the wire as **numbers**: `AllocationRuleType {FundEnvelopes:0, FundJars:1, FixedPerMember:2, SplitRemainderToMembers:3}`, `SplitMethod {Equal:0, ByIncomeRatio:1, BalanceTilt:2}`. Money is `decimal(18,4)` server-side and integer minor units (scale 4) client-side. Commit idempotency key is `BankReference = "alloc:{year}-{month}:{memberId}"` (month **not** zero-padded). Client wiring is exercised by `client/src/pages/AllocationPage.test.tsx`; engine math by `tests/AllotJar.Application.Tests/Domain/IncomeAllocatorTests.cs` + `Application/AllocationTests.cs`; the dangling-account and idempotent-rerun crash paths by `tests/AllotJar.IntegrationTests/AllocationRerunTests.cs`.

---

## Page access, gating & loading

### ALLOC-001 - Solo household is nudged to add people, not shown the engine
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Solo household (1 active member, so `isShared = false`); `householdAllocation` on.
- **Steps:**
  1. Navigate to `/allocation`.
- **Expected:** No hero, no settings, no waterfall. An `EmptyState` with the allocation icon, title **"Add people first"**, description "Allocation pools everyone's income and divides the surplus into each person's savings, so it needs the people you share money with. Add them to set this up.", and a **"Add people"** button. Clicking it navigates to `/people`.
- **Automated:** Yes (AllocationPage.test.tsx — "nudges a solo user to add members")

### ALLOC-002 - Solo gate is reachable-by-URL only; nav link is hidden
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Solo household; `householdAllocation` on.
- **Steps:**
  1. Inspect the left nav; then hit `/allocation` directly by URL.
- **Expected:** The **"Allocation"** nav link is **absent** (shown only when `householdAllocation && isShared`, `AppNav.tsx`), but the route itself is registered, so the direct URL renders the "Add people first" gate (ALLOC-001) rather than a redirect or 404.
- **Automated:** Yes (AppNav.test.tsx — "Allocation hidden for solo households, appears at 2+ members")

### ALLOC-003 - Nav link appears once the household becomes shared
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Household with 1 member; user on `/people`.
- **Steps:**
  1. Add a second member so `members.length` reaches 2.
- **Expected:** After `refreshHousehold()`, `isShared` flips true and the **"Allocation"** nav link appears live (no reload). Reducing back below 2 hides it again.
- **Automated:** Yes (AppNav.test.tsx — isShared gating at 0/1 vs 2+ members)

### ALLOC-004 - Feature flag off: route unregistered, nav hidden, API 404s
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** `GET /api/features` returns `householdAllocation: false`.
- **Steps:**
  1. Load the app; check the nav; try `/allocation` by URL; call `GET /api/allocation/profile`.
- **Expected:** No "Allocation" nav link; the `/allocation` route is not registered so the SPA redirects `*` → `/`; `/people` is **also** gated off the same flag (the whole allocation feature is one gate); every `/api/allocation/*` endpoint returns **404** via `[FeatureGate(HouseholdAllocation)]`. (Client defaults all flags ON until `/features` resolves, so a brief flash before the flag arrives is possible.)
- **Automated:** Partial (AppNav.test.tsx — nav gating; server FeatureGate 404 not unit-tested)

### ALLOC-005 - Loading placeholder while profile/accounts/budget resolve
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Shared household; the three bootstrap requests (`/allocation/profile`, `/accounts`, `/budget/current`) are in flight.
- **Steps:**
  1. Open `/allocation` and observe before the requests settle.
- **Expected:** Plain **"Loading…"** text (slate) shows; no hero, empty state, or card renders until `loading` clears.
- **Automated:** No

### ALLOC-006 - Page tolerates failed bootstrap fetches without crashing
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared household; `/allocation/profile` **and** `/accounts` both 500.
- **Steps:**
  1. Open `/allocation`.
- **Expected:** Each failing call is swallowed (`.catch` → `{ data: null }` / `{ data: [] }`), so `profile` is null and `accounts` is `[]`; the page falls through to the **"No allocation set up yet"** empty state instead of an error boundary. `/budget/current` failing leaves `period` at the browser-clock year/month. No unhandled rejection.
- **Automated:** Partial (AllocationPage.test.tsx — "tolerates failed profile/accounts fetches")

### ALLOC-007 - Viewed month is the app-wide selected month (rule 29)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared household; the TopBar month is July 2026.
- **Steps:**
  1. Open `/allocation`; read the card heading and the Allocate button. 2. Move the TopBar month to June.
- **Expected:** The page uses `useMonth()`: the card reads **"How July is allocated"**, the commit button **"Allocate July"**, preview/commit target `/allocation/preview/2026/7` and `/allocation/commit/2026/7`; after step 2 everything re-reads for 2026/6. `/budget/current` no longer sets the period.
- **Automated:** Full (client ALLOC-007)

---

## Setup & the no-profile state

### ALLOC-008 - No-profile empty state offers Set up allocation (Owner)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Shared household, **no** allocation profile (`GET /allocation/profile` → JSON `null`); Owner.
- **Steps:**
  1. Open `/allocation`.
- **Expected:** No hero (needs `profile && preview`); an `EmptyState` titled **"No allocation set up yet"**, description "Choose where shared costs come from and how to split them, then save — we'll show you the monthly breakdown.", and a **"Set up allocation"** button (aria-label "Set up allocation") because Owner is `canWrite`. `loadPreview` is **not** run (client only previews once a profile exists).
- **Automated:** Yes (AllocationPage.test.tsx — "shows a setup empty-state when there is no profile")

### ALLOC-009 - Limited/Read-only see the empty state but no Set up button
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Shared household, no profile; login role **Limited** (`canWrite = false`).
- **Steps:**
  1. Open `/allocation`.
- **Expected:** The "No allocation set up yet" empty state renders but the **"Set up allocation"** button is hidden (`canWrite &&`). The settings modal never mounts (`showSettings && canWrite`). A Read-only (role 3) user is identical here. (Full role matrix lives in the roles sibling.)
- **Automated:** No

### ALLOC-010 - Set up allocation opens the modal titled "Set up allocation"
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Shared household, no profile; Owner.
- **Steps:**
  1. Click **"Set up allocation"**.
- **Expected:** A modal opens titled **"Set up allocation"** (title is "Allocation settings" only when a profile exists). `syncFormFromProfile()` seeds defaults: source blank ("Choose an account…"), pocket empty, split **Equally**, savings split **Balance**, lean **"25"**. The primary button reads **"Set up"** (not "Save").
- **Automated:** No

---

## Allocation settings modal — controls

### ALLOC-011 - Source account select lists owned accounts
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Shared household with accounts "Joint" and "Savings pot"; settings modal open.
- **Steps:**
  1. Open the **"Pay shared costs from"** select (aria-label "Source account").
- **Expected:** First option **"Choose an account…"** (empty value = no source), then one option per owned account ("Joint", "Savings pot"). An **"About the source account"** InfoHint sits beside the label explaining the account only affects the commit, not the preview.
- **Automated:** No

### ALLOC-012 - Pocket money input accepts a per-member amount
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Type `50` into **"Pocket money (each)"** (aria-label "Pocket money per member", placeholder "0.00"); Save.
- **Expected:** The saved profile's `FixedPerMember` rule carries `fixedAmountPerMember = 50.00`; the preview's "Pocket money" step total = 50.00 × active members (100.00 for 2) with "· €50.00 each".
- **Automated:** No

### ALLOC-013 - Split-shared-costs segmented control: Equally / By income
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Read the **"Split shared costs"** SegmentedControl (aria-label "Split method").
- **Expected:** Exactly two options, **"Equally"** (`SplitMethod.Equal` = 0) and **"By income"** (`ByIncomeRatio` = 1); default selection Equally. The chosen value is written to **both** the FundEnvelopes and FundJars rules (`standardRules(costSplit, …)`). An "About splitting shared costs" InfoHint is present.
- **Automated:** No

### ALLOC-014 - Send-savings-to segmented control: Balance / Equally / By income
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Read the **"Send savings to"** SegmentedControl (aria-label "Savings split method").
- **Expected:** Three options in order **"Balance"** (`BalanceTilt` = 2, default), **"Equally"** (`Equal` = 0), **"By income"** (`ByIncomeRatio` = 1); this value drives the terminal `SplitRemainderToMembers` rule. An "About the savings split" InfoHint explains all three.
- **Automated:** No

### ALLOC-015 - Balance-lean input shows only when savings split = Balance
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Settings modal open, savings split = **Balance**.
- **Steps:**
  1. Confirm the **"Balance lean (0–100)"** input (aria-label "Balance lean percent", placeholder "25") is visible.
  2. Switch "Send savings to" to **Equally**, then **By income**.
- **Expected:** With Balance selected the lean input renders (with an "About balance lean" InfoHint: "0 is a plain even split; 100 fills the lowest balance first. 25 is a gentle nudge."). Switching to Equally or By income **hides** the lean input entirely.
- **Automated:** No

### ALLOC-016 - InfoHints exist on all four opaque controls
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Settings modal open, savings split = Balance.
- **Steps:**
  1. Locate the InfoHint buttons beside each labelled control.
- **Expected:** Four help buttons: **"About the source account"**, **"About splitting shared costs"**, **"About the savings split"**, **"About balance lean"**; each toggles a tooltip with the explanatory copy from the source. (General a11y coverage is in the a11y sibling; this asserts their presence and labels.)
- **Automated:** No

### ALLOC-017 - InfoHint button is not the control of a `<label>` (clicking the label focuses the field)
- **Priority:** P3
- **Type:** Regression
- **Origin:** PR #163 / gotcha #11 — an InfoHint `<button>` nested in a `<label>` becomes that label's form control
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Click the **text** "Pay shared costs from" / "Split shared costs" / "Send savings to" / "Balance lean" (not the ? icon).
- **Expected:** Clicking the label text focuses/activates the associated field (Select/SegmentedControl/Input via its own `aria-label`), **not** the InfoHint tooltip — because these are wrapped in a `<div>` + control `aria-label`, not `<label>`. Only "Pocket money (each)" uses a real `<label>` (its field is a plain Input with no nested InfoHint).
- **Automated:** No

---

## Allocation settings modal — save, cancel & revert

### ALLOC-018 - Save a new profile writes the standard four-rule waterfall
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Shared household, no profile; Owner; modal open.
- **Steps:**
  1. Pick source **"Joint"**, pocket `0`, split **Equally**, savings **Balance**, lean `25`.
  2. Click **"Set up"**.
- **Expected:** `PUT /allocation/profile` with `{ id: null, name: "Household allocation", sourceAccountId: <Joint>, balanceLeanPercent: 25, rules: [FundEnvelopes/Equal, FundJars/Equal, FixedPerMember/Equal amount 0, SplitRemainderToMembers/BalanceTilt] }`. On 200 the returned profile is stored, the modal closes, and `loadPreview(2026,7)` runs so the hero + waterfall appear. `allocationPreviewed` analytics fires with `{ split }`.
- **Automated:** Yes (AllocationPage.test.tsx — "saves a new allocation profile")

### ALLOC-019 - Editing an existing profile shows "Save" and round-trips the change
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile exists; Owner; modal opened via **"Settings"**.
- **Steps:**
  1. Change split to **By income**; click the primary button.
- **Expected:** The primary button reads **"Save"** (profile exists), sends `PUT /allocation/profile` with `id` set (rules replaced wholesale) and `split = 1` on both cost rules; the reloaded preview reflects the by-income cost split. The pocket/split/savings/lean fields are pre-seeded from the saved profile's rules on open.
- **Automated:** No

### ALLOC-020 - Saving the profile clears a stale "Allocated" banner and re-runs preview
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / committed banner cleared on profile save
- **Preconditions:** Standard profile committed (banner showing "Allocated July — 2 savings transfers created…").
- **Steps:**
  1. Open **Settings**, change lean to `50`, click **Save**.
- **Expected:** On save the committed banner is cleared (`setCommitted(null)`) because the numbers just changed, and `loadPreview` re-runs so the waterfall/tiles reflect the new lean. The banner does not linger with now-stale figures.
- **Automated:** No

### ALLOC-021 - Cancel reverts unsaved edits so a later Save can't commit them
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / `syncFormFromProfile` on close
- **Preconditions:** Standard profile (split Equally, pocket 0); modal open.
- **Steps:**
  1. Change split to **By income** and pocket to `200`.
  2. Click **"Cancel"** (aria-label "Cancel settings").
  3. Re-open **Settings**.
- **Expected:** Cancel calls `closeSettings` → `syncFormFromProfile()`, so the reopened form shows the **saved** values (split Equally, pocket empty), not the discarded edits. A subsequent Save writes the saved values, never the cancelled ones. Any modal error is cleared (`setError(null)`).
- **Automated:** No

### ALLOC-022 - Backdrop close also reverts unsaved edits
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / backdrop close resyncs the form
- **Preconditions:** Standard profile; modal open with edited (unsaved) fields.
- **Steps:**
  1. Edit savings split to **Equally** and lean to `0`.
  2. Dismiss the modal via the backdrop / close (X), not Save.
  3. Re-open Settings.
- **Expected:** The backdrop `onClose` is `closeSettings`, so edits are discarded exactly as with Cancel — reopened fields show the saved profile. No `PUT` is sent.
- **Automated:** No

---

## Allocation settings modal — validation & boundaries

### ALLOC-023 - Invalid pocket money is blocked with a message (no PUT)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Type `abc` (or `-5`, `1.2.3`, `1,2,3`, or whitespace-only) into "Pocket money (each)"; click Save/Set up.
- **Expected:** `parseMinor` returns null → the modal `ErrorBanner` shows **"Enter a valid pocket-money amount."**; no `PUT /allocation/profile` is sent; the modal stays open.
- **Automated:** No

### ALLOC-024 - Pocket-money boundaries: blank→0, 0, huge, 4dp, thousands separators
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Save with pocket **blank**; then `0`; then `1234.5678`; then `1,234.56` and `1.234,56`; then a 12-digit amount.
- **Expected:** Blank → `pocketAmount = 0` (no error). `0` accepted. `1234.5678` accepted at 4 dp (rounded half-up beyond scale 4). Both mixed-separator styles parse identically (right-most separator = decimal). A within-range huge value passes client-side; only the server's `FixedAmountPerMember ∈ [0, max]` bound ("Fixed amount is out of range.") would reject an absurd value.
- **Automated:** Partial (lib/money.test.ts — parseMinor accept/reject table underpins this)

### ALLOC-025 - Non-integer / out-of-range balance lean is blocked with a message
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Settings modal open, savings split = Balance.
- **Steps:**
  1. Enter lean `12.5` (or `abc`, `-1`, `101`); click Save.
- **Expected:** `Number.parseInt` NaN, `<0`, or `>100` → the modal shows **"Balance lean must be a whole number between 0 and 100."**; no `PUT`. (`12.5` parses to 12 via parseInt? No — the guard uses the raw string; `parseInt('12.5')` = 12 which is valid, so it saves 12. Use `abc`/`-1`/`101` for the reject path.)
- **Automated:** No

### ALLOC-026 - Balance-lean boundaries: 0, 100, blank→25
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Settings modal open, savings split = Balance.
- **Steps:**
  1. Save lean `0`; then `100`; then blank.
- **Expected:** `0` (plain even split) and `100` (fill-lowest-first) both pass and persist. Blank defaults to **25** (`lean.trim() === '' ? 25`). Server mirror `BalanceLeanPercent ∈ [0,100]` ("Balance lean must be between 0 and 100.") is the backstop; the lean field is not even sent to the engine when savings split ≠ Balance, but the value still persists on the profile.
- **Automated:** No

### ALLOC-027 - Profile save failure surfaces an error and keeps the modal open
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Settings modal open; `PUT /allocation/profile` returns 500 (or 403).
- **Steps:**
  1. Fill valid values; click Save.
- **Expected:** The catch shows **"Could not save the allocation profile."** in the modal ErrorBanner; the modal stays open; `busy` resets. A 403 (role downgraded to below Admin mid-session) surfaces the same generic message.
- **Automated:** No

### ALLOC-028 - Server-only profile validation (raw API)
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** Direct `PUT /api/allocation/profile` bypassing the UI (the client always sends a non-empty name and a valid 4-rule set).
- **Steps:**
  1. POST a body with empty `name`; then `balanceLeanPercent = 150`; then a rule with `fixedAmountPerMember` out of range.
- **Expected:** 400 with FluentValidation field errors: **"An allocation profile needs a name."** / **"Balance lean must be between 0 and 100."** / **"Fixed amount is out of range."**. A Limited/Read-only caller gets 403 **"Your access level ({role}) does not permit this action."** (upsert is Admin+). These paths are unreachable from the current UI — documented for API/regression coverage.
- **Automated:** No

---

## Hero tiles & reconciliation

### ALLOC-029 - Hero shows Income to allocate / Shared spending / To savings
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Standard profile + worked-example July budget (envelopes 2,000.00, jars 500.00, pocket 0); preview loaded.
- **Steps:**
  1. Open `/allocation` and read the hero.
- **Expected:** Eyebrow **"Income to allocate"** with amount **€5,000.00** (`preview.pool` = Σ member `NetMonthlyIncome`). Tile **"Shared spending"** = **€2,500.00** (envelopes 2,000 + jars 500 + pocket 0). Tile **"To savings"** = **€2,500.00** (the `SplitRemainderToMembers` step total). Hero amountLabel repeats the pool for screen readers.
- **Automated:** Partial (AllocationPage.test.tsx — renders the waterfall + surplus; exact hero sums not asserted)

### ALLOC-030 - The two hero tiles always reconcile to the pool
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Any loaded preview.
- **Steps:**
  1. Read Shared spending + To savings and compare to Income to allocate.
- **Expected:** **Shared spending + To savings = Income to allocate**, always, by construction (`toSavings = pool − envelopes − jars − pocket`). Changing the cost split or pocket money re-runs the preview and the identity still holds to the cent.
- **Automated:** No

### ALLOC-031 - Negative "To savings" (over-committed month) still reconciles
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Envelopes 4,000.00 + jars 1,500.00 + pocket 0 = 5,500.00 shared spending vs pool 5,000.00 (remainder −500.00 ≤ 0 → keep-own terminal branch).
- **Steps:**
  1. Open `/allocation`; read hero + per-member tiles.
- **Expected:** Shared spending **€5,500.00**, To savings **−€500.00** rendered as a shortfall (rose value in the hero tile); the two still sum to the pool **€5,000.00**. Terminal remainder ≤ 0 → keep-own: each member keeps their own (possibly negative) leftover shown as a rose residual; commit will skip members whose residual ≤ 0. The rose overshoot note shows (see ALLOC-056).
- **Automated:** No

### ALLOC-032 - Hero hidden until both profile and preview are present
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Profile exists but the preview request is still pending / failed.
- **Steps:**
  1. Observe the page while `preview` is null.
- **Expected:** The hero renders only under `profile && preview`; with a missing preview there is no hero and, if the preview call failed, the ErrorBanner **"Could not compute the allocation preview."** shows (when not in the settings modal).
- **Automated:** No

---

## Waterfall steps & split math

### ALLOC-033 - Waterfall card: heading + four step labels + totals
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile + worked-example budget; pocket 50.00 each.
- **Steps:**
  1. Read the **"How July is allocated"** card.
- **Expected:** An ordered list of steps with brand-dot bullets and right-aligned totals: **"Cover shared costs"** €2,000.00, **"Fund the jars"** €500.00, **"Pocket money · €50.00 each"** €100.00, **"Split remainder to savings"** (terminal, highlighted) €2,400.00 (pool 5,000 − 2,000 − 500 − 100). Card also carries the **"Settings"** and **"Allocate July"** buttons.
- **Automated:** Yes (AllocationPage.test.tsx — asserts Shared spending / Pocket money / To savings steps render)

### ALLOC-034 - Pocket-money "· €X each" only when the per-member amount > 0
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Two variants — pocket 0.00, and pocket 25.00.
- **Steps:**
  1. Compare the "Pocket money" row in each.
- **Expected:** With pocket 0 the row shows just **"Pocket money"** and total €0.00 (no "each" suffix, since `perEach > 0` is false). With pocket 25 it shows **"Pocket money · €25.00 each"** and total €50.00 (2 members). The "each" figure reads `step.perMember[0].amount`.
- **Automated:** No

### ALLOC-035 - Terminal savings row is visually highlighted
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Any loaded preview.
- **Steps:**
  1. Inspect the "Split remainder to savings" row.
- **Expected:** Only the `SplitRemainderToMembers` row gets the highlighted (brand-tinted, rounded) treatment; the other three rows are plain with top borders between them. Purely visual — the total is still the same figure as the "To savings" hero tile.
- **Automated:** No

### ALLOC-036 - Categories flagged ExcludeFromAllocation are left out of envelopes/jars
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #162/#163 / allocation outputs must not be double-counted
- **Preconditions:** July has an expense/savings category with `ExcludeFromAllocation = true` (e.g. an imported "Personal Savings" output line) planned at 800.00, plus the worked-example 2,000 envelopes / 500 jars.
- **Steps:**
  1. Open `/allocation`; read "Cover shared costs" and "Fund the jars".
- **Expected:** The flagged 800.00 is **excluded** from both the envelopes and jars totals (they stay €2,000.00 / €500.00), so the surplus is not subtracted from the pool twice. The flag is only ever set by the importer and carried by month-copy — it cannot be toggled from this page.
- **Automated:** Yes (Application/AllocationTests.cs — "preview excludes flagged categories"; Application/ExcludeFromAllocationCoverageTests.cs additionally pins that excluded categories of BOTH kinds — Expense and Savings — are dropped from the pooled envelopes/jars totals while comparable non-excluded categories stay in)

### ALLOC-037 - Equal cost split sums exactly; last member absorbs the odd cent
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Split shared costs **Equally**; envelopes+jars = 2,500.01 (odd cent), 2 members.
- **Steps:**
  1. Inspect the per-member deductions feeding the terminal step.
- **Expected:** Each member is charged `Round2(2500.01/2)`; the **last** member absorbs the rounding remainder so the two charges sum **exactly** to 2,500.01 (e.g. 1,250.00 + 1,250.01). Assert sum-exactness, not which member gets the cent.
- **Automated:** Yes (Domain/IncomeAllocatorTests.cs — "equal split sums exactly even with odd cents")

### ALLOC-038 - By-income cost split charges in proportion to net income
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Split shared costs **By income**; envelopes+jars 2,500.00; Alex 3,000 / Robin 2,000 (ratio 60/40).
- **Steps:**
  1. Read the cost deductions.
- **Expected:** Alex charged `Round2(2500 × 3000/5000)` = 1,500.00, Robin `Round2(2500 × 2000/5000)` = 1,000.00; last member absorbs any remainder so the sum is exactly 2,500.00. Step totals (Cover shared costs / Fund the jars) are unchanged — the split only redistributes *who* pays.
- **Automated:** Partial (Domain/IncomeAllocatorTests.cs — "by-income split sums exactly to the total")

### ALLOC-039 - Send savings to "Equally" pools the remainder then splits evenly
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Send savings to **Equally**; terminal remainder 2,500.00; 2 members.
- **Steps:**
  1. Read the per-member residuals.
- **Expected:** Remainder is **pooled** and split via `Split()` → 1,250.00 each (last member absorbs any odd cent), regardless of each member's running balance. Projected balances = each member's savings balance + 1,250.00. (Pre-PR #162 this option was inert / kept-own.)
- **Automated:** Yes (Domain/IncomeAllocatorTests.cs — "SplitRemainderToMembers Equally pools and splits")

### ALLOC-040 - Send savings to "By income" splits the pooled remainder by income ratio
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Send savings to **By income**; remainder 2,300.00; Alex 3,000 / Robin 2,000.
- **Steps:**
  1. Read the per-member residuals.
- **Expected:** Alex residual `Round2(2300 × 3000/5000)` = 1,380.00, Robin 920.00; sum exactly 2,300.00 (last member absorbs remainder). (Pre-PR #162 this was also inert.)
- **Automated:** Yes (Domain/IncomeAllocatorTests.cs — "ByIncome pool-and-split")

### ALLOC-041 - Balance (default) leans the remainder toward the lower savings balance
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Send savings to **Balance**, lean 25; remainder 2,300.00; Alex savings 1,000.00, Robin savings 500.00.
- **Steps:**
  1. Read the per-member residuals and projected balances.
- **Expected:** `BalanceTiltSplit` gives Robin (lower balance) a **larger** share than Alex while both still save; residuals sum **exactly** to 2,300.00 (rounding drift pushed onto the **largest** share). Assert the invariants — sum-exact, lower-balance-gets-more, both non-negative — not fragile per-member cents. Full lean 100 would pour everything into the lowest balance first.
- **Automated:** Yes (Domain/IncomeAllocatorTests.cs — "BalanceTilt leans toward the lower balance", "full lean pours into the lower account")

### ALLOC-042 - New/equal-balance couple: default savings split must not 500 (WaterFill overflow)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #162 / `IncomeAllocator.WaterFill` formed `k * decimal.MaxValue` at the top tier → OverflowException
- **Preconditions:** Brand-new shared household, 2 members with **equal (or both zero)** savings balances; default profile (savings split Balance, lean 25); a positive remainder to split.
- **Steps:**
  1. Open `/allocation` (preview) and then press **Allocate July** (commit).
- **Expected:** Both preview and commit succeed — the top tier is levelled directly via `FillToLevel`, so no `OverflowException`/500. Each member gets an even share of the remainder. This is the highest-value regression: the old code only survived because live data had a large balance gap.
- **Automated:** Yes (Domain/IncomeAllocatorTests.cs — "BalanceTilt does not overflow for equal/zero balances", Theory across lean settings)

### ALLOC-043 - Odd-cent placement differs between Equal and BalanceTilt (assert invariants)
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #162 / gotcha #9 — `Split` gives the last member the cent, `BalanceTiltSplit` the largest share
- **Preconditions:** A remainder that doesn't divide evenly (e.g. 2,300.01); run once with savings split Equally, once with Balance.
- **Steps:**
  1. Compare which member receives the extra cent under each mode.
- **Expected:** Under **Equally** the **last** member absorbs the cent; under **Balance** the **largest share** absorbs it — potentially a different member. Tests/assertions must check sum-exactness and per-mode invariants, never a hard-coded member's cents.
- **Automated:** No

---

## Per-member savings tiles

### ALLOC-044 - Per-member tile anatomy
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile; remainder split gives Alex residual 1,150.00 (savings 1,000.00), Robin 1,150.00 (savings 500.00).
- **Steps:**
  1. Read each member card in the 2-up grid below the waterfall.
- **Expected:** Each tile shows the member **name**, **"Savings €X → saves"** (X = pre-allocation `savingsBalance`, e.g. "Savings €1,000.00 → saves"), the residual as a large figure (**€1,150.00**, brand tone when ≥ 0), and **"Projected balance €Y"** where Y = `savingsBalance + residual` (Alex €2,150.00, Robin €1,650.00).
- **Automated:** Partial (AllocationPage.test.tsx — per-member surplus renders)

### ALLOC-045 - Negative residual is rendered in the rose tone
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A member whose income is below their share of obligations (keep-own remainder ≤ 0), e.g. residual −300.00.
- **Steps:**
  1. Read that member's tile.
- **Expected:** The residual figure is rose-toned (`text-rose-600`), the projected balance = savingsBalance + (−300.00) is shown, and on commit the member is **skipped** (residual ≤ 0, no transfer).
- **Automated:** No

### ALLOC-046 - "No savings account set" note for a member without a personal savings account
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Robin has **no** `PersonalSavingsAccountId`; Robin's residual is positive (e.g. 1,150.00).
- **Steps:**
  1. Read Robin's tile.
- **Expected:** Robin's tile shows the amber note **"No savings account linked — Robin's share stays in {source account} when you allocate."** (Admin+; Limited/Read-only instead see "…will stay in the source account. Ask an admin to link one on the People page."); `savingsBalance` reads €0.00 (no account). The warning is actionable: an inline **"Link a savings account…"** picker (savings-type accounts first, "Name — Type" labels) links via a full-echo `PUT /members/{id}` and reloads the preview so the warning clears (ALLOC-064); with no savings-type account a **"Create a savings account"** button deep-links to /accounts. The positive residual becomes **stranded** on commit (see ALLOC-055/067).
- **Automated:** No

### ALLOC-047 - Member savings balance for the tilt excludes this month's own allocation transfers
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #162 / preview == re-commit view (`SavingsBalancesAsync` prefix filter)
- **Preconditions:** Standard profile already committed once for July (alloc transfers exist in Alex/Robin savings accounts).
- **Steps:**
  1. Reopen `/allocation` and read the "Savings €X → saves" figure, then re-commit.
- **Expected:** The savings balances used for BalanceTilt **exclude** transactions whose `BankReference` starts `alloc:2026-7:` for the viewed month, so the preview's tilt matches a fresh re-commit (no feedback loop where each run tilts differently). The pre-allocation balance shown is stable across re-runs.
- **Automated:** Partial (AllocationRerunTests.cs — idempotent rerun; balance-exclusion asserted indirectly)

---

## Commit / Allocate flow

### ALLOC-048 - Allocate button gating (canEnterData, disabled while busy or no source)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile with source set; Owner.
- **Steps:**
  1. Observe the **"Allocate July"** button; click it and watch during the request.
- **Expected:** The button (aria-label "Commit allocation") renders because `canEnterData`; it is `disabled` while `busy` (mid-commit) or when `!profile.sourceAccountId`. A **Read-only** user (role 3) never sees it (`canEnterData` false); a **Limited** user does (commit is `[AllowLimited]`).
- **Automated:** No

### ALLOC-049 - No source account: Allocate disabled with an amber hint
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / no-source guard
- **Preconditions:** Profile exists but `sourceAccountId` is null.
- **Steps:**
  1. Open `/allocation`.
- **Expected:** The "Allocate July" button is **disabled**, and an amber hint reads **"Set the account to pay shared costs from in Settings before you can allocate July."** (with "Settings" emphasised). The preview/hero still render (source only affects commit). A raw-API commit in this state → 400 key `SourceAccountId`: "Set a source account on the allocation profile before committing."
- **Automated:** Yes (AllocationPage.test.tsx — "Allocate disabled + explained when no source account")

### ALLOC-050 - Commit creates member transfers and shows the count banner
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Standard profile, source Joint; both members have savings accounts and positive residuals.
- **Steps:**
  1. Click **"Allocate July"**.
- **Expected:** `POST /allocation/commit/2026/7` with `{}`; on 200 `preview` is replaced with the result, `committed = transfersCreated` (2), and a role=status banner shows **"Allocated July — 2 savings transfers created. Re-running Allocate replaces them, never doubles up."**. Two `Transfer` transactions are written (1st of month, payee "Income allocation — {name}", amount = residual, into each member's savings account). `allocationCommitted` analytics fires with a `count_bucket`.
- **Automated:** Yes (AllocationPage.test.tsx — "commits the allocation"; Application/AllocationTests.cs — "Allocate creates member savings transfers and is idempotent")

### ALLOC-051 - Zero-transfer commit shows the singular "no transfers needed" banner
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Standard profile, source set, but **no** member has both a positive residual and a savings account (e.g. remainder ≤ 0, or all residuals stranded).
- **Steps:**
  1. Click **"Allocate July"**.
- **Expected:** `transfersCreated = 0`; the banner reads **"Allocated July — no savings transfers were needed this month."** (the 0-variant), and no transactions are written.
- **Automated:** No

### ALLOC-052 - Re-running commit replaces prior transfers, never doubles them
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #162 / idempotent commit vs the unique (Owner, BankReference) index
- **Preconditions:** July already committed (2 alloc transfers exist).
- **Steps:**
  1. Click **"Allocate July"** a second time (optionally after changing lean and saving).
- **Expected:** The handler first deletes every transaction whose `BankReference` starts `alloc:2026-7:`, then recreates them — so the member savings accounts end with **one** transfer each, not two. Balances match a single run; the unique index is not tripped; no 500 on the dup-key race (recovery path skips, not crashes).
- **Automated:** Yes (AllocationRerunTests.cs — "rerun recreates the same references without tripping the unique index")

### ALLOC-053 - Commit failure surfaces the actionable error banner
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Standard profile; `POST /allocation/commit/2026/7` returns 400/403/404/500.
- **Steps:**
  1. Click **"Allocate July"**.
- **Expected:** The catch clears any banner and shows **"Could not commit the allocation. Check the source account and members' savings accounts are set."**; `busy` resets; the preview is unchanged. (Underlying server causes: no profile → 404 "There is no allocation profile to run."; source account missing → 404 "Source account {id} was not found."; foreign source → 403.)
- **Automated:** No

### ALLOC-054 - Deleted member savings account: commit skips the member instead of crashing
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #162 / dangling `PersonalSavingsAccountId` wrote a broken `Transfer.TransferAccountId` FK → DbUpdateException/500
- **Preconditions:** Robin's `PersonalSavingsAccountId` points at an account that has since been **deleted**; Robin's residual is positive.
- **Steps:**
  1. Open `/allocation` (preview) then **Allocate July**.
- **Expected:** `AllocationPlanner` nulls the link not present in the owned/existing balances dict, so the preview shows Robin's "No savings account set" note and the **commit skips Robin** (no broken FK insert, no 500). Alex's transfer still writes. `Create/UpdateHouseholdMember` also validate the account exists+owned, closing the vector at the source.
- **Automated:** Yes (AllocationRerunTests.cs — "commit skips a member whose savings account is gone")

### ALLOC-055 - Stranded-surplus note when a member with a positive share has no savings account
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Robin has no savings account but a positive residual of 1,150.00; Alex has one.
- **Steps:**
  1. Open `/allocation`.
- **Expected:** An amber note reads **"€1,150.00 won't be transferred — Robin has no savings account linked (see below)."** — it names the affected people and points at the inline fix on their cards (`strandedMinor` = Σ residual of members with `!savingsAccountId && residual > 0`). Commit requires an explicit confirm (ALLOC-067); confirmed, it writes only Alex's transfer and Robin's share stays in the source account, repeated in the success banner.
- **Automated:** No

### ALLOC-056 - Nothing-to-save note when shared spending consumes the whole pool
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Envelopes+jars+pocket ≥ pool so `toSavings ≤ 0` and no stranded surplus (`strandedMinor === 0`).
- **Steps:**
  1. Open `/allocation`.
- **Expected:** Two honest variants: with `toSavings < 0` a **rose** note reads **"Shared costs, jars and pocket money overshoot the pooled income by €X — pocket money can't be funded this month."** and the commit banner's zero-transfer copy becomes "…nothing was transferred because shared spending overshoots the pooled income." (never the cheerful "no savings transfers were needed"). At exactly `toSavings === 0` the slate note reads **"Shared spending uses up all the pooled income this month, so there's nothing left to move to savings."** If instead a positive share is stranded, the stranded note (ALLOC-055) shows rather than either.
- **Automated:** Yes (`AllocationPage.catalog.test.tsx` ALLOC-031/045/056 + ALLOC-070)

### ALLOC-057 - Commit only transfers members with residual > 0 AND a savings account
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Mixed household — member A residual 1,200 + savings account; member B residual 0.00; member C residual −50 + savings account; member D residual 900 + no savings account.
- **Steps:**
  1. Click **"Allocate July"**.
- **Expected:** Exactly **one** transfer is written (member A). B (residual 0, not > 0), C (residual ≤ 0), and D (no savings account) are all skipped; `transfersCreated = 1`, banner singular ("1 savings transfer created"). D's 900 shows in the stranded note.
- **Automated:** Partial (Application/AllocationTests.cs — Allocate transfer creation; combined skip-conditions not all in one test)

### ALLOC-058 - Transfer composition: EUR-hardcoded, non-zero-padded BankReference
- **Priority:** P1
- **Type:** Regression
- **Origin:** gotchas #12/#13 — commit currency hardcoded EUR; `BankReference = "alloc:{year}-{month}:{memberId}"` month not zero-padded
- **Preconditions:** A GBP household commits July; a member with residual > 0 + savings account.
- **Steps:**
  1. Commit and inspect the written transfer (register / DB).
- **Expected:** Each transfer is `Type=Transfer`, Date = 1st of month, Payee = "Income allocation — {name}", Amount = residual, `AccountId` = source, `TransferAccountId` = member savings, **Currency = EUR / ExchangeRate = 1 (hardcoded)** even for a GBP household (known display-label limitation), and `BankReference = "alloc:2026-7:{memberId}"` — month **"7"**, not "07". The prefix filter for idempotent re-runs and the unique (Owner, BankReference) index both depend on this exact, non-padded composition; changing it breaks both.
- **Automated:** Partial (AllocationRerunTests.cs exercises the reference/index; the EUR label and non-padding are not separately asserted)

### ALLOC-059 - Commit with no profile (raw API) → 404
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** No allocation profile; `POST /api/allocation/commit/2026/7` called directly (the UI never shows Allocate without a profile+preview).
- **Steps:**
  1. Send the commit request.
- **Expected:** 404 with **"There is no allocation profile to run."**. From the UI this is unreachable (the commit button only renders under `profile && preview`) — documented for API/regression coverage.
- **Automated:** No

### ALLOC-060 - Solo-household commit is allowed server-side (gate is client-only)
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** 1-member household with a profile + source; `POST /api/allocation/commit/2026/7` via raw API.
- **Steps:**
  1. Send the commit request.
- **Expected:** The API has **no ≥2-member guard**, so the single member receives the whole remainder as one transfer (if they have a savings account and positive residual). The "Add people first" UI gate is purely client-side — this asymmetry is intentional and documented; the households sibling owns the broader solo-vs-shared matrix.
- **Automated:** No

---

## State variants & regressions

### ALLOC-061 - Empty / over-committed month with jars but no income
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared household that owns jars; July is a **blank** month (0 income lines) with month-create's appended accrual-planned savings lines (jars total > 0); standard profile.
- **Steps:**
  1. Open `/allocation` for July.
- **Expected:** Pool €0.00 (no member income counted only if members have 0 net income — otherwise pool = Σ net income regardless of budget income lines); jars step > 0; shared spending exceeds the pool → To savings negative; keep-own residuals shown rose. No crash. (The dashboard's own "over-budgeted" empty-month framing is covered in `06-dashboard-budget-view.md`; here we only assert the engine tolerates it.)
- **Automated:** No

### ALLOC-062 - Zero-income / zero-member edge: empty splits, no divide-by-zero
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** A shared household whose members all have `NetMonthlyIncome = 0` (pool 0); or (API) a household reduced to 0 active members.
- **Steps:**
  1. Open `/allocation` (or call preview via API for the 0-member case).
- **Expected:** Pool €0.00; cost/jar/pocket steps deduct against zero balances; the terminal remainder is ≤ 0 → keep-own; `IncomeAllocator.Split` handles `n = 0` returning empty shares (WaterFill only runs with ≥1 member and remainder > 0). No `DivideByZeroException`, no 500.
- **Automated:** Partial (Domain/IncomeAllocatorTests.cs covers equal/zero balances; explicit 0-member path not asserted)

### ALLOC-063 - Fresh opt-out account has no starter profile or jars
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #170 / sample budget is opt-in; default sign-up = empty account
- **Preconditions:** Brand-new Owner who did **not** tick "Start with sample figures"; then adds a 2nd member so `isShared`.
- **Steps:**
  1. Open `/allocation`.
- **Expected:** `GET /allocation/profile` → null and there are no jars/months, so the page shows **"No allocation set up yet"** — allocation tests must not assume a starter profile, Emergency Fund jar, or seeded budget exists. Only the opt-in sample seed (or a manual Set up) creates a profile.
- **Automated:** Partial (register.spec.ts / HouseholdBootstrapTests — opt-in seeding; not the allocation page specifically)

### ALLOC-064 - The inline savings-link picker on a member card links and reloads
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Admin+; Robin unlinked; at least one savings-type account exists (e.g. "Robin Savings").
- **Steps:**
  1. On Robin's Allocation card, pick "Robin Savings — Savings" in "Link a savings account…".
- **Expected:** A full-echo `PUT /members/{robin}` carries `{name, netMonthlyIncome, personalSavingsAccountId}` (name + income echoed from the preview DTO), the preview reloads, the warning clears and the balance-tilt figures recompute. Any stale "Allocated" banner is cleared (the figures changed). A unique case-insensitive name match additionally offers a one-click **"Use 'Robin Savings'"** chip — offer-only, nothing links without a click; an ambiguous match (two candidates) offers no chip (ALLOC-065). The picker lists savings-type accounts first with type-label suffixes.
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-064/065)

### ALLOC-065 - No suggestion chip on an ambiguous name match
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Two unlinked savings accounts both containing the member's name.
- **Steps:**
  1. Read the unlinked member's card.
- **Expected:** No "Use '…'" chip renders — only the picker. Suggestions require exactly one candidate.
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-065)

### ALLOC-066 - Limited/Read-only see explanatory copy instead of the picker
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Limited login; a member without a savings link.
- **Steps:**
  1. Open `/allocation` and read the unlinked member's card.
- **Expected:** "No savings account linked — {name}'s share will stay in the source account. Ask an admin to link one on the People page." — no picker, no chip (member-edit is Admin+ while commit is Limited+). The Allocate button remains available.
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-066)

### ALLOC-067 - Allocating with a stranded share needs an explicit confirm
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A member with a positive residual and no savings link (`strandedMinor > 0`).
- **Steps:**
  1. Press "Allocate {month}".
  2. Cancel; press again; choose "Allocate anyway".
- **Expected:** The first press opens a confirm modal — "Allocate without {names}?" / "€X will stay in {source account} because {names} has no savings account linked. You can link one on the person's card and re-run — re-running Allocate replaces the transfers, never doubles up." Cancel aborts with no POST. "Allocate anyway" commits (the loss-free skip stays possible for households that keep a member's savings off-app), and the success banner appends "€X stayed in {source account} for {names} (no savings account linked)." With no stranded share the modal never appears — commit fires directly.
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-067; direct-commit path covered by ALLOC-020)

### ALLOC-068 - The reconciliation banner: engine pocket money missing from the budget, one-click sync
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A profile with pocket money > 0; the viewed month has no (or under-planned) flagged pocket lines, so `U = pocket + max(toSavings,0) − Σ planned(flagged categories) > 0`.
- **Steps:**
  1. Open `/allocation`; read the amber banner between the card header and the waterfall.
  2. Click "Add pocket money to {month}'s budget".
- **Expected:** With `remainingToBudget < U` the copy is the honest disagreement: "Your budget and your allocation disagree. The budget leaves only €R unassigned, but the allocation also promises €P in pocket money[ and €S to personal savings]. That's €(U−R) more than your income covers — trim budget lines, or lower pocket money in Settings." (with `remainingToBudget ≥ U`: "€U of your income is already promised by the allocation … the budget will keep showing it as 'still to assign'."). The CTA (Admin+ only, pocket > 0 only) POSTs `/allocation/pocket-lines/{y}/{m}` — the server creates/adopts a **"Pocket Money"** Expense category flagged `ExcludeFromAllocation` with one line per active member at the rule amount (idempotent; archived members skipped; unmatched lines left alone; pocket 0 zeroes lines) — then the budget and preview refresh, the banner clears once the flagged lines cover the promise, and a `role="status"` confirms "Pocket money added to {month}'s budget."
- **Automated:** Full (backend `SyncPocketMoneyLinesTests` + `AllocationTests` end-to-end scenario; client ALLOC-068)

### ALLOC-069 - The counted-twice banner: an unflagged "Pocket Money" category plus the rule
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Pocket rule > 0 AND the month has an **unflagged** Expense category named "Pocket Money" (the imported household's shape).
- **Steps:**
  1. Open `/allocation`.
- **Expected:** The banner's distinct variant: "Pocket money is currently counted twice — once as a budget group and once as the allocation's pocket-money step." The same CTA heals it: the sync ADOPTS the existing category (flags it, never duplicates), the envelopes total drops by the pocket lines' planned sum, and the engine's FixedPerMember rule becomes the single deduction. No blind name-based migration exists — the flag flips only via this user-invoked sync.
- **Automated:** Full (backend adopt/heal test asserts EnvelopesTotal 2,500 → 2,000; client ALLOC-069)

### ALLOC-070 - Negative To savings is styled and worded as a shortfall end-to-end
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Envelopes + jars + pocket > pool (`toSavings < 0`).
- **Steps:**
  1. Read the hero tile, the note under the waterfall, then Allocate.
- **Expected:** The "To savings" tile value renders rose; the rose note names the overshoot amount; committing yields "Allocated {month} — nothing was transferred because shared spending overshoots the pooled income." instead of the cheerful zero-transfer copy.
- **Automated:** Full (client ALLOC-070; commit-skip math in AllocationTests)

### ALLOC-071 - Pool vs budgeted income mismatch gets a source note
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** The month's budgeted income lines total > 0 and ≠ the members' combined `NetMonthlyIncome`.
- **Steps:**
  1. Open `/allocation` and read below the waterfall.
- **Expected:** Since rule 28 the pool IS the month's budgeted income, so the two never disagree and no note is needed; the case is kept to assert that the pool equals the budget's income total on any month (attributed + unattributed). When the month has no income lines the page shows the no-income notice (ALLOC-073).
- **Automated:** Full (client ALLOC-071)

### ALLOC-072 - Unattributed budget income: shared equally with an assign-it banner
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** The month's budget has income lines with no person (or attributed to an archived member), whether or not any line is attributed.
- **Steps:**
  1. Open `/allocation`; read above the committed banner.
- **Expected:** The unattributed planned total is shared equally across active members (last member absorbs the rounding remainder, the `Split` convention; sum-preserving) and an amber banner names it: "€X of {month}'s income isn't assigned to a person, so it's treated as shared equally." with an "Assign income lines on the Budget page" link. Commit is never blocked. `AllocationResultDto` carries `unattributedIncome`/`incomeFromBudget` on preview AND commit.
- **Automated:** Full (backend `AllocationIncomeFromBudgetTests`; client ALLOC-072)

### ALLOC-073 - The pool is the month's budgeted income and nothing else (rule 28)
- **Priority:** P0
- **Type:** Regression
- **Preconditions:** Case A: a month whose income lines are attributed to people. Case B: a month with income lines but none attributed. Case C: a month with no income lines (or no budget). Saved defaults 9,999 / 8,888 in every case.
- **Steps:**
  1. Open `/allocation` on each month and compare the pool with the budget figures.
- **Expected:** Case A: pool = the month's PLANNED attributed income plus the equally shared unattributed lines; each member's `netIncome` is their attributed sum plus their equal share. Case B: pool = the unattributed total shared equally (a 4,000 line → 2,000 each), `incomeFromBudget` true, `unattributedIncome` 4,000. Case C: pool 0 and the notice "No income in {Month Year}'s budget yet. Add income lines to the Budget (attribute them to people for a by-income split) and come back."; the defaults are never used. Lines attributed to an archived member fold into the unattributed pot. Linking a savings account from this page never rewrites a person's default income. PLANNED (not received) by design: the engine plans; a mid-month run must not see half a salary.
- **Automated:** Full (backend `AllocationIncomeFromBudgetTests` incl. `NoAttributedLines_ShareTheUnattributedIncomeEqually_AndIgnoreTheSavedDefaults`, `NoBudget_YieldsAnEmptyPool_NotTheDefaults`; client ALLOC-073)
