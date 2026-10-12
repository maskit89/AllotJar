# Allocation (income split engine)

**ID prefix:** ALLOC | **Scope:** Everything on the Allocation screen at `/allocation` (`client/src/pages/AllocationPage.tsx`) for shared households: the solo "Add people first" gate and the no-profile "Set up allocation" state; since restyle PR 10, the KPI row (the hero tile **Income to allocate** with its (i), the tiles **Shared spending** and **To savings**) and its by-construction reconciliation to the pool; the page's warnings and notes as short **strips** above the cards (each a short line, its full sentence behind an (i), its action at the right); the **Steps** card (a segmented income bar, then the list named **How {month} is allocated** with step labels "Cover shared costs" / "Fund the jars" / "Pocket money" / "Split remainder to savings", per-step totals, the last step showing the people's avatars, one (i) on the title and the **Settings** button); the **Savings** card's row per person (the share, the savings account it goes to, the projected balance behind an (i), "Stays in {source}" for a person with no savings account, the dashed **Link account** chip and its picker); the **Allocation settings** / **Set up allocation** dialog (source account, pocket money, split-shared-costs Equally/By income, send-savings-to Balance/Equally/By income, balance lean, InfoHints) with client + server validation; **Cancel/backdrop revert** of unsaved edits (PR #163); the **Allocate** button (named "Allocate {month}"; in the top bar on a wide screen, under the KPI row below 900px) and its **Record {month}’s transfers** / **Allocate without {names}?** dialog (both dialogs a centred card on a wide screen and a bottom sheet below 700px), the "Allocated …" strip, the no-source guard, and the stranded-share and nothing-to-save states; and the underlying `IncomeAllocator`/`AllocationPlanner` math — Equal / By income / BalanceTilt+WaterFill splits, `ExcludeFromAllocation` exclusion, member savings balances, the WaterFill-overflow and dangling-savings-account regressions, and the EUR-hardcoded / non-zero-padded `AllocationKey` transfer composition. | **Out of scope:** The **Jars** page, jar accrual and the dashboard jar shelf → `13-jars.md`; per-member **Savings account** selects, `NetMonthlyIncome`, add/archive member, `isShared` derivation and the full role matrix → the households/people sibling (only allocation-page `canWrite`/`canEnterData` gating and the solo gate appear here); the Savings-group budget grid and month create/copy that seed the planned figures the engine reads → `08-categories-budget-lines.md` and `07-month-lifecycle.md`; the account **reconciliation**/earmark panel and account balances feeding the tilt → `12-accounts-reconciliation.md`; the transfers the commit writes, viewed as register rows → `11-transfers.md`; session/refresh, cross-tab logout and responsive/dark/a11y sweeps → their own files (referenced only where behaviour is allocation-specific, e.g. the InfoHint-in-label gotcha).

**Test data setup:** Unless a case says otherwise, assume an authenticated **Owner** (`canWrite = true`, `canEnterData = true`) of a **shared EUR household "Home"** with **2 active members** — *Alex* (`NetMonthlyIncome` 3,000.00, personal savings account **"Alex Savings"** balance 1,000.00) and *Robin* (`NetMonthlyIncome` 2,000.00, personal savings account **"Robin Savings"** balance 500.00). The browser locale is **en-GB** and today (browser clock + server UTC) is **2026-07-15**, so `GET /budget/current` returns **July 2026** and `monthName` renders **"July"**. One EUR source account **"Joint"** exists. The `householdAllocation` feature flag is **on**. The **standard profile** (what the client always writes) is: source `Joint`, pocket money `0.00`, split shared costs **Equally**, send savings to **Balance**, balance lean **25**, name "Household allocation", four rules in order `FundEnvelopes(0)`, `FundJars(1)`, `FixedPerMember(2)`, `SplitRemainderToMembers(3)`. The **worked-example July budget** has planned **expense** categories totalling **2,000.00** (envelopes) and planned **Savings** categories totalling **500.00** (jars); with pocket **0** that gives pool **5,000.00** (3,000+2,000), shared spending **2,500.00** (2,000+500+0) and **To savings 2,500.00**. Enums go over the wire as **numbers**: `AllocationRuleType {FundEnvelopes:0, FundJars:1, FixedPerMember:2, SplitRemainderToMembers:3}`, `SplitMethod {Equal:0, ByIncomeRatio:1, BalanceTilt:2}`. Money is `decimal(18,4)` server-side and integer minor units (scale 4) client-side. Commit idempotency key is `AllocationKey = "alloc:{year}-{month}:{memberId}"` (W07: its own column, no longer `BankReference`; month **not** zero-padded). A sentence behind an (i) is in the page only while that (i) is open (hovered or focused), so a step that reads one opens the (i) first; Escape closes the (i) alone. Client wiring is exercised by `client/src/pages/AllocationPage.test.tsx`, `AllocationPage.catalog.test.tsx` (by case ID), `AllocationPage.restyle.test.tsx` (the KPI row, strips, cards, Link account picker and both dialogs), `AllocationPage.jars.test.tsx` and `AllocationPage.lateAnswer.test.tsx`; in a browser on the mocked API by `client/e2e/allocation.spec.ts` (the strips' (i), the picker, the dialogs' focus, Tab and Escape, the phone sheets at 375x667); against the real backend by `client/e2e-journey/allocation-commit.spec.ts`; engine math by `tests/AllotJar.Application.Tests/Domain/IncomeAllocatorTests.cs` + `Application/AllocationTests.cs`; the dangling-account and idempotent-rerun crash paths by `tests/AllotJar.IntegrationTests/AllocationRerunTests.cs`.

---

## Page access, gating & loading

### ALLOC-001 - Solo household is nudged to add people, not shown the engine
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Solo household (1 active member, so `isShared = false`); `householdAllocation` on.
- **Steps:**
  1. Navigate to `/allocation`.
- **Expected:** No KPI row, no Settings, no Steps or Savings card, no Allocate button, and no month in the top bar. An `EmptyState` with the allocation icon, title **"Add people first"**, description "Allocation pools everyone's income and divides the surplus into each person's savings, so it needs the people you share money with. Add them to set this up.", and a **"Add people"** button. Clicking it navigates to `/people`.
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
- **Expected:** Plain **"Loading…"** text (slate) shows; no KPI row, strip, empty state, card or Allocate button renders until `loading` clears.
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
  1. Open `/allocation`; read the name of the Steps card's list and the Allocate button. 2. Move the TopBar month to June.
- **Expected:** The page uses `useMonth()`: the Steps card's list is named **"How July is allocated"** (the card's visible title is "Steps"), the Allocate button reads "Allocate" and is named **"Allocate July"**, preview/commit target `/allocation/preview/2026/7` and `/allocation/commit/2026/7`; after step 2 everything re-reads for 2026/6. `/budget/current` no longer sets the period.
- **Automated:** Full (client ALLOC-007)

---

## Setup & the no-profile state

### ALLOC-008 - No-profile empty state offers Set up allocation (Owner)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Shared household, **no** allocation profile (`GET /allocation/profile` → JSON `null`); Owner.
- **Steps:**
  1. Open `/allocation`.
- **Expected:** No KPI row, strips, cards or Allocate button (they need `profile && preview`); an `EmptyState` titled **"No allocation set up yet"**, description "Choose where shared costs come from and how to split them, then save — we'll show you the monthly breakdown.", and a **"Set up allocation"** button (aria-label "Set up allocation") because Owner is `canWrite`. `loadPreview` is **not** run (client only previews once a profile exists).
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
- **Expected:** A dialog opens titled, and named, **"Set up allocation"** (title is "Allocation settings" only when a profile exists): a centred card on a wide screen, a bottom sheet below 700px whose grab handle is its Close (no ✕). Focus starts on the Close control; the title and the Cancel / Set up row stay put while the fields between them scroll. `syncFormFromProfile()` seeds defaults: source blank ("Choose an account…"), pocket empty, split **Equally**, savings split **Balance**, lean **"25"**. The primary button reads **"Set up"** (not "Save"; named "Save allocation settings").
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-010; `client/src/components/Modal.test.tsx` — the sheet frame, its focus and its phone grab handle; journey `allocation-commit.spec.ts` "the first-run Set up allocation modal opens from the no-profile empty state")

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
  1. Confirm the **"Balance lean"** input (aria-label "Balance lean percent", placeholder "25"; since restyle PR 10 the label no longer shows "(0–100)", its (i) explains 0 and 100) is visible.
  2. Switch "Send savings to" to **Equally**, then **By income**.
- **Expected:** With Balance selected the lean input renders (with an "About balance lean" InfoHint: "0 is a plain even split; 100 fills the lowest balance first. 25 is a gentle nudge."). Switching to Equally or By income **hides** the lean input entirely.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-015; journey `allocation-commit.spec.ts` — the hide leg)

### ALLOC-016 - InfoHints exist on all four opaque controls
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Settings modal open, savings split = Balance.
- **Steps:**
  1. Locate the InfoHint buttons beside each labelled control.
- **Expected:** Four help buttons: **"About the source account"**, **"About splitting shared costs"**, **"About the savings split"**, **"About balance lean"**; each opens a tooltip on hover or focus with the explanatory copy from the source, placed against the screen so the dialog's scrolling middle never cuts it off (on a 375x667 phone sheet too); Escape closes the tooltip alone, a second Escape the dialog. (General a11y coverage is in the a11y sibling; this asserts their presence and labels.)
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-016 — the four names; `client/e2e/allocation.spec.ts` "an (i) inside a sheet is never cut off by its scrolling middle" — each tooltip fully on screen at 1280x720 and 375x667)

### ALLOC-017 - InfoHint button is not the control of a `<label>` (clicking the label focuses the field)
- **Priority:** P3
- **Type:** Regression
- **Origin:** PR #163 / gotcha #11 — an InfoHint `<button>` nested in a `<label>` becomes that label's form control
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Click the **text** "Pay shared costs from" / "Split shared costs" / "Send savings to" / "Balance lean" (not the (i)).
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
- **Expected:** `PUT /allocation/profile` with `{ id: null, name: "Household allocation", sourceAccountId: <Joint>, balanceLeanPercent: 25, rules: [FundEnvelopes/Equal, FundJars/Equal, FixedPerMember/Equal amount 0, SplitRemainderToMembers/BalanceTilt] }`. On 200 the returned profile is stored, the dialog closes, and `loadPreview(2026,7)` runs so the KPI row and the Steps and Savings cards appear. The empty state's Set up button that opened the dialog is gone, so focus moves to the Allocate button (to Settings while Allocate is off). `allocationPreviewed` analytics fires with `{ split }`.
- **Automated:** Yes (AllocationPage.test.tsx — "saves a new allocation profile")

### ALLOC-019 - Editing an existing profile shows "Save" and round-trips the change
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile exists; Owner; dialog opened via the Steps card's **"Settings"** button (named "Allocation settings").
- **Steps:**
  1. Change split to **By income**; click the primary button.
- **Expected:** The primary button reads **"Save"** (profile exists), sends `PUT /allocation/profile` with `id` set (rules replaced wholesale) and `split = 1` on both cost rules; the reloaded preview reflects the by-income cost split. The pocket/split/savings/lean fields are pre-seeded from the saved profile's rules on open.
- **Automated:** No

### ALLOC-020 - Saving the profile clears a stale "Allocated" strip and re-runs preview
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / committed banner cleared on profile save
- **Preconditions:** Standard profile committed (the green strip showing "Allocated July · 2 transfers in transit").
- **Steps:**
  1. Open **Settings**, change lean to `50`, click **Save**.
- **Expected:** On save the "Allocated" strip is cleared (`setCommitted(null)`) because the numbers just changed, and `loadPreview` re-runs so the KPI tiles, the steps and the Savings rows reflect the new lean. The strip does not linger with now-stale figures.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-020)

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
  2. Dismiss the dialog via the backdrop, the ✕ (on a phone, the sheet's grab handle) or Escape, not Save.
  3. Re-open Settings.
- **Expected:** Each of these calls `closeSettings`, so edits are discarded exactly as with Cancel — reopened fields show the saved profile, and focus is back on the Settings button. No `PUT` is sent.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-022 — the ✕; `AllocationPage.restyle.test.tsx` "the settings dialog: focus on Close, Escape discards the edits and returns focus to Settings"; `client/e2e/allocation.spec.ts` — Escape back to Settings)

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

## KPI row & reconciliation

### ALLOC-029 - The KPI row shows Income to allocate / Shared spending / To savings
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Standard profile + worked-example July budget (envelopes 2,000.00, jars 500.00, pocket 0); preview loaded.
- **Steps:**
  1. Open `/allocation` and read the KPI row at the top of the page.
- **Expected:** The hero tile **"Income to allocate"** reads **€5,000.00** (`preview.pool`, the month's budgeted income); its figure is named "Income to allocate: €5,000.00" for screen readers, and its (i) **About income to allocate** says "July’s income lines from the budget, pooled. A line not assigned to a person is shared equally." Tile **"Shared spending"** (receipt icon) = **€2,500.00** (envelopes 2,000 + jars 500 + pocket 0). Tile **"To savings"** (coins icon) = **€2,500.00** (the `SplitRemainderToMembers` step total). On a narrow screen the hero spans the row and the two tiles sit side by side under it.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-029/030 — the sums; `AllocationPage.restyle.test.tsx` "shows the KPI row" — the hero's name and its (i); journey `allocation-commit.spec.ts`)

### ALLOC-030 - The two KPI tiles always reconcile to the pool
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
  1. Open `/allocation`; read the KPI row, the last step and the Savings rows.
- **Expected:** Shared spending **€5,500.00**, To savings **−€500.00** rendered as a shortfall (the To savings tile's figure in the bad red); the two still sum to the pool **€5,000.00**. The last step, "Split remainder to savings", shows its −€500.00 in red in place of the people's avatars. Terminal remainder ≤ 0 → keep-own: each member keeps their own (possibly negative) leftover, shown in red as the share on their Savings row; commit will skip members whose residual ≤ 0. The red overshoot strip shows (see ALLOC-056).
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-031/045/056; journey `allocation-commit.spec.ts` — the over-committed leg)

### ALLOC-032 - KPI row and cards hidden until both profile and preview are present
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Profile exists but the preview request is still pending / failed.
- **Steps:**
  1. Observe the page while `preview` is null.
- **Expected:** The KPI row, the strips, the Steps and Savings cards and the Allocate button render only under `profile && preview`; with a missing preview none of them shows (no "Income to allocate", no list "How July is allocated") and, if the preview call failed, the ErrorBanner **"Could not compute the allocation preview."** shows (when no dialog is open).
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-032)

---

## Waterfall steps & split math

### ALLOC-033 - Steps card: income bar + four step rows + totals
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile + worked-example budget; pocket 50.00 each.
- **Steps:**
  1. Read the **Steps** card (its list is named **"How July is allocated"**) and open the (i) beside its title.
- **Expected:** Under the title **"Steps"** a segmented bar splits the month's income by step (an image named "July’s income: €2,000.00 cover shared costs, €500.00 fund the jars, €100.00 pocket money, €2,400.00 split remainder to savings"; a step at or below zero has no slice, and the bar is left out when every step is zero). Then the ordered list, one row per step with its icon and its total at the right: **"Cover shared costs"** €2,000.00, **"Fund the jars"** €500.00, **"Pocket money · €50.00 each"** €100.00, and **"Split remainder to savings"**, whose row shows the people's avatars instead of its €2,400.00 (pool 5,000 − 2,000 − 500 − 100; see ALLOC-035). Amounts keep their cents. The (i) **About the steps** reads "Shared costs are July’s spending lines (€1,000.00 each), jars this month’s contributions (€250.00 each). Pocket money is set in Settings. What’s left goes to savings, leaning toward whoever’s savings are lowest." (by income it names each person's part after ", split by income"; a Balance lean of 0, an Equally split or a split that fell back to equal reads "split equally"; By income reads "in proportion to income"). For an admin the card's **Settings** button (named "Allocation settings") sits at its top right. Allocate is not on the card: it sits in the top bar, or under the KPI row below 900px (ALLOC-048). On a wide screen the Steps card and the Savings card sit side by side; on a narrow one Savings follows Steps.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-033 — labels, "€50.00 each", cents; `AllocationPage.restyle.test.tsx` "draws the Steps card" and "the Steps (i) follows the saved splits"; `client/e2e/allocation.spec.ts` — Steps beside Savings at 1280px; journey `allocation-commit.spec.ts` — the rows' totals)

### ALLOC-034 - Pocket-money "· €X each" only when the per-member amount > 0
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Two variants — pocket 0.00, and pocket 25.00.
- **Steps:**
  1. Compare the "Pocket money" row in each.
- **Expected:** With pocket 0 the row shows just **"Pocket money"** and total €0.00 (no "each" suffix, since `perEach > 0` is false). With pocket 25 it shows **"Pocket money · €25.00 each"** and total €50.00 (2 members); the "·" is hidden from screen readers, and on a narrow row "€25.00 each" moves under the name rather than cutting it short. The "each" figure reads `step.perMember[0].amount`.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-034; `AllocationPage.restyle.test.tsx` "pocket money keeps its whole name"; `client/e2e/allocation.spec.ts` — the whole name at 375px)

### ALLOC-035 - The last step shows who the remainder goes to
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Any loaded preview with a remainder ≥ 0.
- **Steps:**
  1. Inspect the "Split remainder to savings" row.
- **Expected:** Since restyle PR 10 no row is highlighted. Only the `SplitRemainderToMembers` row shows the people's avatars (an image named "To Alex and Robin"; past three people, two avatars and "+N", the name still listing everyone) in place of its amount; the amount stays in the row's text for screen readers and is the same figure as the "To savings" tile. The other three rows show their amount. A negative remainder shows its amount in red instead (ALLOC-031).
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-035; `AllocationPage.restyle.test.tsx` "the last step shows at most three circles")

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
  1. Open `/allocation` (preview) and then press **Allocate** (named "Allocate July"), tick **I’ve completed these transfers** and press **Record transfers** (commit).
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

## Savings card: a row per person

### ALLOC-044 - A person's Savings row
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile; remainder split gives Alex residual 1,150.00 (savings 1,000.00), Robin 1,150.00 (savings 500.00).
- **Steps:**
  1. Read each person's row in the **Savings** card (the list "Savings by person"; beside the Steps card on a wide screen, under it on a narrow one) and open the row's (i).
- **Expected:** Each row shows the person's avatar (in their People-page colour), their **name**, the residual as the large figure at the right (**€1,150.00**), and under the name the savings account it goes to ("Alex Savings"; "Savings account" when that account isn't in the account list). The row's (i) **About Alex’s savings** reads "Projected balance €2,150.00: €1,000.00 in Alex Savings today, plus this share." (Robin: €1,650.00 from €500.00 in Robin Savings), where the projected balance = `savingsBalance + max(0, residual)` and the balance today is the pre-allocation `savingsBalance`; with no known balance it reads "Savings not available". The old "Savings €X → saves" line is gone.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-044 — the share and both (i); `AllocationPage.restyle.test.tsx` "draws the Savings card" and the "Savings account" fallback; journey `allocation-commit.spec.ts` — the balance today and the projection behind the (i))

### ALLOC-045 - Negative residual is rendered in the bad (red) tone
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A member whose income is below their share of obligations (keep-own remainder ≤ 0), e.g. residual −300.00.
- **Steps:**
  1. Read that person's Savings row and open its (i).
- **Expected:** The share reads −€300.00 in the bad red (`data-tone="bad"`, class `text-bad`); the (i) gives the projected balance as the balance today (a share ≤ 0 adds nothing: "Projected balance €X: €X in {account} today."), and on commit the member is **skipped** (residual ≤ 0, no transfer) and has no line in the Allocate dialog.
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-031/045/056; journey `allocation-commit.spec.ts` — the over-committed leg)

### ALLOC-046 - "Stays in {source}" for a member without a personal savings account
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Robin has **no** `PersonalSavingsAccountId`; Robin's residual is positive (e.g. 1,150.00).
- **Steps:**
  1. Read Robin's Savings row and open its (i).
- **Expected:** Under Robin's name, in the warning (amber) tone, the row reads **"Stays in Joint"** (the source account's name; "the source account" when none is set, "Private account" for a source its holder made private), with his €1,150.00 at the right. Its (i) **About Robin’s share** says **"No savings account linked — Robin’s share stays in Joint when you allocate."** (Admin+; Limited/Read-only instead read "…will stay in the source account. Ask an admin to link one on the People page."). The line shows whatever the share's sign; no balance or projection is shown (no account). For an admin it is actionable on the row: the dashed **Link account** chip (named "Link account for Robin’s savings") opens the picker, which links via a full-echo `PUT /members/{id}` and reloads the preview so the line clears (ALLOC-064); with no savings-type account the chip reads **"Create a savings account"** and goes to /accounts. The positive residual becomes **stranded** on commit (see ALLOC-055/067).
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-046/055; `AllocationPage.restyle.test.tsx` "draws the Savings card"; journey `allocation-commit.spec.ts` — the stranded leg)

### ALLOC-047 - Member savings balance for the tilt excludes this month's own allocation transfers
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #162 / preview == re-commit view (`SavingsBalancesAsync` prefix filter)
- **Preconditions:** Standard profile already committed once for July (alloc transfers exist in Alex/Robin savings accounts).
- **Steps:**
  1. Reopen `/allocation`, open each person's (i) on their Savings row and read the balance today ("€X in {account} today"), then re-commit.
- **Expected:** The savings balances used for BalanceTilt **exclude** transactions whose `AllocationKey` starts `alloc:2026-7:` for the viewed month, so the preview's tilt matches a fresh re-commit (no feedback loop where each run tilts differently). The pre-allocation balance shown is stable across re-runs.
- **Automated:** Partial (AllocationRerunTests.cs — idempotent rerun; balance-exclusion asserted indirectly)

---

## Commit / Allocate flow

### ALLOC-048 - Allocate button gating (canEnterData, disabled while busy or no source)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Standard profile with source set; Owner.
- **Steps:**
  1. Observe the **Allocate** button; press it, record the transfers (ALLOC-050) and watch the button during the request.
- **Expected:** The button reads **"Allocate"** (with the split icon) and is named **"Allocate July"**. From 900px wide it sits in the top bar; below 900px it sits under the KPI row, at the right (one copy at a time). It renders once the profile and preview are loaded, because `canEnterData`; it is `disabled` while `busy` (mid-commit) or when the profile has no source (a source its holder made private counts as set). A **Read-only** user (role 3) never sees it (`canEnterData` false); a **Limited** user does (commit is `[AllowLimited]`).
- **Automated:** Yes (client `AllocationPage.catalog.test.tsx` ALLOC-048 ×2 — read-only and in flight; `AllocationPage.restyle.test.tsx` "on a wide screen Allocate sits in the top bar, once" and the phone case; `client/e2e/allocation.spec.ts` — the top bar at 1280px, none there at 375px)

### ALLOC-049 - No source account: Allocate disabled with a warning strip
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / no-source guard
- **Preconditions:** Profile exists but `sourceAccountId` is null.
- **Steps:**
  1. Open `/allocation`.
- **Expected:** The Allocate button (named "Allocate July") is **disabled**, and an amber strip above the cards reads **"No account to pay from"**; its (i) **About the account to pay from** holds "Set the account to pay shared costs from in Settings before you can allocate July." For an admin the strip's action **Settings** (named "Settings: choose the account to pay from", so the Steps card's button stays the only "Allocation settings") opens the settings dialog; a Limited user's strip has no action. Once a source is saved the strip goes and focus moves to Allocate. The KPI row and cards still render (source only affects commit). A raw-API commit in this state → 400 key `SourceAccountId`: "Set a source account on the allocation profile before committing."
- **Automated:** Yes (AllocationPage.test.tsx — "disables Allocate and explains when no source account is set", the sentence read behind the (i); `AllocationPage.restyle.test.tsx` — the strip, its action, a Limited user's strip, focus after the save; journey `allocation-commit.spec.ts`)

### ALLOC-050 - Recording the allocation creates member transfers and shows the count strip
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Standard profile, source Joint; both members have savings accounts and positive residuals; neither savings account holds jars.
- **Steps:**
  1. Press **Allocate** (named "Allocate July") and read the dialog; open the (i) beside its title.
  2. Press the **Sent today** pill, pick 3 July, press Enter.
  3. Tick **I’ve completed these transfers** and press **Record transfers**.
- **Expected:** Step 1: the dialog is titled **"Record July’s transfers"** (a centred card from 700px wide; a bottom sheet below 700px, whose grab handle is its Close); focus starts on its Close and the actions stay below the scrolling middle. The (i) **About recording the transfers** reads "The suggested amounts become recorded transfers only once you’ve moved the money at the bank. Each transfer is recorded as departed from Joint on the date you set and stays in transit until you confirm its receipt on the Transactions page." The list **Transfers** has a line per person with a positive share: avatar, name, "Joint → Alex Savings" (an arrow; a screen reader hears "to") and the amount. Step 2: the pill (named "Sent today: the date the money left Joint") opens the date field **Allocation departure date** in its place; Enter (or leaving the field) shows the pill again, now reading "Sent 3 Jul" (the year is added for another year). Step 3: the dialog closes and `POST /allocation/commit/2026/7` sends `{departedOn: "2026-07-03", receivedOn: null, confirmedCompleted: true}`; on 200 the preview is replaced with the result and a green strip above the cards reads **"Allocated July · 2 transfers in transit"** (that line alone is the `role="status"` live region). Its (i) **About the allocation** reads "Allocated July — 2 savings transfers recorded as in transit; confirm each receipt on the Transactions page. Re-running Allocate keeps unchanged transfers, never doubles up." One transfer reads "1 transfer in transit" / "1 savings transfer recorded". When a person's savings account holds jars, the dialog adds **Into jars** under the list ("Into {name}’s jars" when two or more people's do), with an (i) saying where the share lands, an amount field per jar ("Amount for {jar}") and the **Stays unallocated** figure; amounts entered there go in the POST as `jarAllocations` (MM-011). Two `Transfer` transactions are written (dated 3 July, the day the money left, with no receipt yet; payee "Income allocation — {name}", amount = residual, into each member's savings account). `allocationCommitted` analytics fires with a `count_bucket`.
- **Automated:** Yes (AllocationPage.test.tsx — "commits the allocation" (the date pill and the POST body); `AllocationPage.catalog.test.tsx` ALLOC-050 — the singular line and its (i); `AllocationPage.restyle.test.tsx` — the dialog's name, focus and date pill, the phone sheet, two people's jars; `AllocationPage.jars.test.tsx` — the jar fields; `client/e2e/allocation.spec.ts` — the dialog's focus and Tab, the 375x667 sheet; journey `allocation-commit.spec.ts`; Application/AllocationTests.cs — `Allocate_CreatesMemberSavingsTransfers_AndIsIdempotent`)

### ALLOC-051 - Zero-transfer commit shows the "no transfers needed" strip
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Standard profile, source set, but **no** member has both a positive residual and a savings account (e.g. remainder ≤ 0, or all residuals stranded); no allocation transfers recorded yet for July.
- **Steps:**
  1. Press **Allocate** (named "Allocate July"), tick **I’ve completed these transfers** and press **Record transfers**; open the strip's (i).
- **Expected:** `transfersCreated = 0`; the strip reads **"Allocated July · no transfers needed"** and its (i) "Allocated July — no savings transfers were needed this month." (the 0-variant); no transactions are written. With To savings below zero the line is "· nothing transferred" instead (ALLOC-070), and with earlier transfers kept as they were, "· 2 transfers unchanged" (ALLOC-052).
- **Automated:** Yes (`AllocationPage.catalog.test.tsx` ALLOC-051)

### ALLOC-052 - Re-running commit keeps or replaces prior transfers, never doubles them
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #162 / idempotent commit vs the unique (Owner, BankReference) index
- **Preconditions:** July already committed (2 alloc transfers exist, still in transit).
- **Steps:**
  1. Allocate July a second time without changing anything (press **Allocate**, tick the box, **Record transfers**); open the strip's (i).
  2. Change the lean, save, and allocate again.
- **Expected:** Step 1: the handler keeps every transfer whose amount and accounts are unchanged and records nothing new; the strip reads **"Allocated July · 2 transfers unchanged"**, its (i) "Allocated July — the 2 recorded transfers are unchanged; nothing new was recorded." (never "no transfers needed"). Step 2: a member whose amount changed has their in-transit transfer (`AllocationKey` starting `alloc:2026-7:`) replaced — so the member savings accounts end with **one** transfer each, not two. Balances match a single run; no 500 on the dup-key race (recovery path skips, not crashes).
- **Automated:** Yes (AllocationRerunTests.cs — "rerun recreates the same references without tripping the unique index" (an unchanged re-run, then a changed one); AllocationPage.test.tsx — "reports an unchanged re-run instead of pretending nothing was needed")

### ALLOC-053 - Commit failure surfaces the actionable error banner
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Standard profile; `POST /allocation/commit/2026/7` returns 403/404/500.
- **Steps:**
  1. Press **Allocate**, tick **I’ve completed these transfers** and press **Record transfers**.
- **Expected:** The dialog closes; no "Allocated" strip shows and the page's error banner reads **"Could not record the allocation. Check the source account and members’ savings accounts are set."**; `busy` resets; the preview is unchanged. A 400 that carries the server's messages (a refusal such as a private savings account's, ALLOC-076, or a jar amount) shows those messages instead. (Underlying server causes: no profile → 404 "There is no allocation profile to run."; source account missing → 404 "Source account {id} was not found."; foreign source → 403.)
- **Automated:** Yes (`AllocationPage.catalog.test.tsx` ALLOC-053)

### ALLOC-054 - Deleted member savings account: commit skips the member instead of crashing
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #162 / dangling `PersonalSavingsAccountId` wrote a broken `Transfer.TransferAccountId` FK → DbUpdateException/500
- **Preconditions:** Robin's `PersonalSavingsAccountId` points at an account that has since been **deleted**; Robin's residual is positive.
- **Steps:**
  1. Open `/allocation` (preview), then press **Allocate** and record the transfers.
- **Expected:** `AllocationPlanner` nulls the link not present in the owned/existing balances dict, so the preview shows Robin's Savings row as **"Stays in Joint"** (no savings account; ALLOC-046), the dialog asks "Allocate without Robin?", and the **commit skips Robin** (no broken FK insert, no 500). Alex's transfer still writes. `Create/UpdateHouseholdMember` also validate the account exists+owned, closing the vector at the source.
- **Automated:** Yes (AllocationRerunTests.cs — "commit skips a member whose savings account is gone")

### ALLOC-055 - Stranded share when a member with a positive share has no savings account
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Robin has no savings account but a positive residual of 1,150.00; Alex has one.
- **Steps:**
  1. Open `/allocation`; read Robin's Savings row and open its (i).
  2. Press **Allocate**, read the dialog, tick **I’ve completed these transfers** and press **Record transfers**; open the strip's (i).
- **Expected:** The person's row says it; there is no separate note on the page. Robin's row reads **"Stays in Joint"** in amber beside his €1,150.00, and its (i) **About Robin’s share** reads "No savings account linked — Robin’s share stays in Joint when you allocate." (ALLOC-046), with the inline fix on the row (**Link account**, ALLOC-064). With two or more people stranded, each stranded row's (i) also gives the total: "€X won’t be transferred — Robin and Sam have no savings account linked." (`strandedMinor` = Σ residual of members with no savings account (not a private one) and `residual > 0`). Allocating asks first (ALLOC-067): the dialog is titled **"Allocate without Robin?"** and lists Robin after Alex as "Stays in Joint". Recorded, it writes only Alex's transfer; the strip reads "Allocated July · 1 transfer in transit" and its (i) ends "€1,150.00 stayed in Joint for Robin (no savings account linked)."
- **Automated:** Yes (`AllocationPage.catalog.test.tsx` ALLOC-046/055 and ALLOC-055b — two people stranded; `AllocationPage.restyle.test.tsx` "a stranded share: the dialog asks “Allocate without Robin?”"; journey `allocation-commit.spec.ts` — the stranded leg)

### ALLOC-056 - Nothing-to-save strip when shared spending consumes the whole pool
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Envelopes+jars+pocket ≥ pool so `toSavings ≤ 0` and no stranded surplus (`strandedMinor === 0`).
- **Steps:**
  1. Open `/allocation` and open the strip's (i).
- **Expected:** Two honest variants: with `toSavings < 0` a red strip reads **"Over the pooled income by €X"**, its (i) **About the overshoot** "Shared costs, jars and pocket money overshoot the pooled income by €X — pocket money can’t be funded this month."; recording then gives the strip "Allocated July · nothing transferred", its (i) "Allocated July — nothing was transferred because shared spending overshoots the pooled income." (never the cheerful "no transfers needed"). At exactly `toSavings === 0` a grey strip reads **"Nothing left for savings"**, its (i) **About savings this month** "Shared spending uses up all the pooled income this month, so there’s nothing left to move to savings." If a positive share is stranded, the grey strip does not show (the share is on the person's row, ALLOC-055); the red one shows whatever.
- **Automated:** Yes (`AllocationPage.catalog.test.tsx` ALLOC-031/045/056 + ALLOC-070; journey `allocation-commit.spec.ts` — the over-committed leg)

### ALLOC-057 - Commit only transfers members with residual > 0 AND a savings account
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Mixed household — member A residual 1,200 + savings account; member B residual 0.00; member C residual −50 + savings account; member D residual 900 + no savings account.
- **Steps:**
  1. Press **Allocate** (named "Allocate July") and read the dialog; tick **I’ve completed these transfers** and press **Record transfers**.
- **Expected:** The dialog is titled "Allocate without D?" and its **Transfers** list has two lines: A ("Joint → {A's savings account}", 1,200.00), then D ("Stays in Joint", 900.00); B and C have no line. Exactly **one** transfer is written (member A). B (residual 0, not > 0), C (residual ≤ 0), and D (no savings account) are all skipped; `transfersCreated = 1`, the strip is singular ("Allocated July · 1 transfer in transit") and its (i) ends "€900.00 stayed in Joint for D (no savings account linked)." D's Savings row reads "Stays in Joint".
- **Automated:** Partial (Application/AllocationTests.cs — Allocate transfer creation; combined skip-conditions not all in one test)

### ALLOC-058 - Transfer composition: one currency throughout, non-zero-padded AllocationKey
- **Priority:** P1
- **Type:** Regression
- **Origin:** gotchas #12/#13 — the commit currency used to be hardcoded EUR (since fixed: it is the source account's) and `AllocationKey = "alloc:{year}-{month}:{memberId}"` month is not zero-padded (W07 moved it out of `BankReference`); W08 removed the exchange rate altogether.
- **Preconditions:** A GBP household (budget currency GBP) commits July; a member with residual > 0 and a GBP savings account.
- **Steps:**
  1. Commit and inspect the written transfer (register / DB).
- **Expected:** Each transfer is `Type=Transfer`, Date = `DepartedOn` = the day set on the Allocate dialog's **Sent …** pill (`ReceivedOn` null, in transit), Payee = "Income allocation — {name}", Amount = residual, `AccountId` = source, `TransferAccountId` = member savings, **Currency = the source account's currency (GBP)** — there is no exchange rate — and `AllocationKey = "alloc:2026-7:{memberId}"` — month **"7"**, not "07". The source must be in the month's budget currency ("The source account is in {X}, but this budget is in {Y}. Choose an account in the budget currency.") and each savings account in the source's ("{name}'s savings account is in {C} but the source account is in {S}. Allocation transfers must stay in one currency."); since W08 only a legacy account can trip either (CMB-011). The prefix filter for idempotent re-runs and the unique (Owner, BankReference) index both depend on this exact, non-padded composition; changing it breaks both.
- **Automated:** Partial (AllocationRerunTests.cs exercises the reference/index; the currency stamp and non-padding are not separately asserted)

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
- **Expected:** Pool €0.00 (rule 28: the month has no income lines, so the grey "No income in July 2026’s budget yet" strip shows, ALLOC-073); jars step > 0; shared spending exceeds the pool → To savings negative and the red "Over the pooled income by €X" strip shows; keep-own residuals shown in red. No crash. (The dashboard's own "over-budgeted" empty-month framing is covered in `06-dashboard-budget-view.md`; here we only assert the engine tolerates it.)
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

### ALLOC-064 - The Link account chip on a person's Savings row links and reloads
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Admin+; Robin unlinked; at least one savings-type account exists (e.g. "Robin Savings", the only unlinked savings account whose name contains "Robin").
- **Steps:**
  1. On Robin's Savings row, press the dashed **Link account** chip (named "Link account for Robin’s savings"); press Escape; press Enter on the chip again.
  2. Pick **Use “Robin Savings”**.
- **Expected:** Step 1: on a screen 700px or wider a menu named **"Savings account for Robin"** opens from the chip; below 700px a bottom sheet with that title. A unique case-insensitive name match among the unlinked savings accounts comes first as **Use “Robin Savings”** (with the account type's icon, not a tick) — offer-only, nothing links without a click; an ambiguous match (two candidates) offers none (ALLOC-065). Then the other accounts, savings-type first, each showing its name and a type icon and named "{Name} — {Type}" (e.g. "Joint — Current"). Escape closes the menu with focus back on the chip; Enter opens it again, the arrow keys move and Enter picks. Step 2: the chip is disabled while linking. The page reads Robin's saved record (`GET /members`) and sends a full-echo `PUT /members/{robin}` with `{name, netMonthlyIncome, personalSavingsAccountId, version}` — the saved name, default income and version, never the preview's month income (rule 28) — then the preview reloads: the "Stays in Joint" line and the chip go, the row names "Robin Savings", and the balance-tilt figures recompute. Any "Allocated" strip is cleared (the figures changed). A failed link shows "Could not link a savings account for Robin." (or the server's message).
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-064/065; `AllocationPage.restyle.test.tsx` — the menu, Escape back to the chip, the keyboard pick, the phone sheet, the suggestion's icon; `client/e2e/allocation.spec.ts` — the same in a browser, and the sheet fitting a 375x667 phone)

### ALLOC-065 - No one-click suggestion on an ambiguous name match
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Two unlinked savings accounts both containing the member's name (e.g. "Robin Savings" and "Robin Savings 2").
- **Steps:**
  1. Press the unlinked member's **Link account** chip.
- **Expected:** The menu "Savings account for Robin" has no "Use “…”" item — only the accounts, savings-type first, named "Robin Savings — Savings", "Robin Savings 2 — Savings", then the others (e.g. "Joint — Current"). A suggestion needs exactly one candidate.
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-065)

### ALLOC-066 - Limited/Read-only see explanatory copy instead of the picker
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Limited login; a member without a savings link.
- **Steps:**
  1. Open `/allocation`, read the unlinked member's Savings row and open its (i).
- **Expected:** The row reads "Stays in Joint" as it does for an admin, but has no **Link account** or **Create a savings account** chip (member-edit is Admin+ while commit is Limited+). Its (i) **About {name}’s share** reads "No savings account linked — {name}’s share will stay in the source account. Ask an admin to link one on the People page." The Allocate button (named "Allocate July") remains available to a Limited user; a Read-only user has none (ALLOC-048).
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-066; `AllocationPage.restyle.test.tsx` "read-only: the person’s row has no Link account chip")

### ALLOC-067 - Allocating with a stranded share needs an explicit confirm
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A member with a positive residual and no savings link (`strandedMinor > 0`).
- **Steps:**
  1. Press **Allocate** (named "Allocate {month}"); read the dialog and open the stranded person's (i) in its list.
  2. Press **Cancel**; press **Allocate** again; tick **I’ve completed these transfers** and press **Record transfers**.
- **Expected:** Step 1: the dialog is titled **"Allocate without {names}?"**. Its **Transfers** list shows the transfers first, then each stranded person reading "Stays in {source}" with their share; the (i) **About {name}’s share** reads "€X will stay in {source account} because {names} has no savings account linked. You can link one on the person’s row and re-run — re-running Allocate keeps unchanged transfers, never doubles up." ("have" for two or more). Nothing is sent yet. Cancel — like ✕, Escape, the backdrop or a phone sheet's grab handle — closes it with no POST and focus back on Allocate. Step 2 records (the loss-free skip stays possible for households that keep a member's savings off-app), and the "Allocated" strip's (i) ends "€X stayed in {source account} for {names} (no savings account linked)." With no stranded share the same dialog opens titled "Record {month}’s transfers" (ALLOC-050); recording always goes through the dialog.
- **Automated:** Full (`AllocationPage.catalog.test.tsx` ALLOC-067; `AllocationPage.restyle.test.tsx` "a stranded share: the dialog asks “Allocate without Robin?”" and the dialog's Escape back to Allocate; journey `allocation-commit.spec.ts` — the stranded leg)

### ALLOC-068 - The reconciliation strip: engine pocket money missing from the budget, one-click sync
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A profile with pocket money > 0; the viewed month has no (or under-planned) flagged pocket lines, so `U = pocket + max(toSavings,0) − Σ planned(flagged categories) > 0`.
- **Steps:**
  1. Open `/allocation`; read the amber strip above the cards and open its (i) **About the budget and the allocation**.
  2. Press **Add pocket money** (named "Add pocket money to {month}'s budget").
- **Expected:** With `remainingToBudget < U` the strip reads **"Budget and allocation disagree by €(U−R)"** and its (i) gives the honest disagreement: "Your budget and your allocation disagree. The budget leaves only €R unassigned, but the allocation also promises €P in pocket money[ and €S to personal savings]. That's €(U−R) more than your income covers — trim budget lines, or lower pocket money in Settings." (with `remainingToBudget ≥ U` the line says what is missing — "Pocket money and savings aren’t budgeted", "Pocket money isn’t budgeted" or "Savings aren’t budgeted"; once some flagged lines exist, "€U promised but not budgeted" — and the (i) reads "€U of your income is already promised by the allocation … the budget will keep showing it as “still to assign”."). The action (Admin+ only, pocket > 0 only) POSTs `/allocation/pocket-lines/{y}/{m}` — the server creates/adopts a **"Pocket Money"** Expense category flagged `ExcludeFromAllocation` with one line per active member at the rule amount, each line **linked to its member by id** (`BudgetItem.MemberId`, rule 53); an existing line with no link whose name is the member's is adopted and linked instead of duplicated (idempotent; archived members skipped and their linked lines left alone; unmatched lines left alone; pocket 0 zeroes lines) — then the budget and preview refresh, the strip clears once the flagged lines cover the promise, and a green strip (its line `role="status"`) confirms "Pocket money added to {month}’s budget."
- **Automated:** Full (backend `SyncPocketMoneyLinesTests` + `AllocationTests` end-to-end scenario, `PocketMoneyIdentityTests.Sync_LinksEachLineToItsPerson_AndARenameReusesTheLine`, `Sync_AdoptsALegacyLineByName_AndLinksIt`, `Sync_LeavesAnArchivedPersonsLinkedLineAlone`; client ALLOC-068 and ALLOC-068b; `AllocationPage.restyle.test.tsx` "pocket money and savings not in the budget" and "after Add pocket money … never contradicts the “added” line")

### ALLOC-069 - The counted-twice strip: an unflagged "Pocket Money" category plus the rule
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Pocket rule > 0 AND the month has an **unflagged** Expense category named "Pocket Money" (the imported household's shape).
- **Steps:**
  1. Open `/allocation`.
- **Expected:** The strip's distinct variant: the line **"Pocket money is counted twice"**, its (i) "Pocket money is currently counted twice — once as a budget group and once as the allocation’s pocket-money step." The same action (**Add pocket money**) heals it: the sync ADOPTS the existing category (flags it, never duplicates), the envelopes total drops by the pocket lines' planned sum, and the engine's FixedPerMember rule becomes the single deduction. No blind name-based migration exists — the flag flips only via this user-invoked sync.
- **Automated:** Full (backend adopt/heal test asserts EnvelopesTotal 2,500 → 2,000; client ALLOC-069)

### ALLOC-070 - Negative To savings is styled and worded as a shortfall end-to-end
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Envelopes + jars + pocket > pool (`toSavings < 0`).
- **Steps:**
  1. Read the To savings tile, the strips above the cards and the last step; then press **Allocate** and record the transfers.
- **Expected:** The "To savings" tile's figure is red; a red strip reads **"Over the pooled income by €X"**, with the full sentence behind its (i) (ALLOC-056); the last step, "Split remainder to savings", shows its negative amount in red in place of the avatars. The Allocate dialog says **"No savings to transfer this month."** rather than listing nothing; recording gives the strip "Allocated {month} · nothing transferred", its (i) "Allocated {month} — nothing was transferred because shared spending overshoots the pooled income." instead of the cheerful zero-transfer copy.
- **Automated:** Full (client ALLOC-070; commit-skip math in AllocationTests)

### ALLOC-071 - Pool vs budgeted income mismatch gets a stale-read note
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** The month's budgeted income lines total > 0. For the note: the page's preview was read before the budget's income lines were edited, so the pool and that total differ.
- **Steps:**
  1. Open `/allocation` and read the strips above the cards; open the note's (i).
- **Expected:** Since rule 28 the pool IS the month's budgeted income, so on a fresh read the two agree and no note shows; the case asserts that the pool equals the budget's income total on any month (attributed + unattributed). When they differ, a grey strip reads **"Income here doesn’t match the budget"**; its (i) **About the income here**: "Note: the pooled income here (€5,000.00) doesn’t match July’s budgeted income lines (€3,000.00). Both come from the same budget — refresh the page if you’ve just edited it." Nothing mentions the People page. When the month has no income lines the page shows the no-income strip instead (ALLOC-073).
- **Automated:** Full (client ALLOC-071)

### ALLOC-072 - Unattributed budget income: shared equally with an assign-it strip
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** The month's budget has income lines with no person (or attributed to an archived member), whether or not any line is attributed.
- **Steps:**
  1. Open `/allocation`; read the strips above the cards and open the unassigned-income strip's (i).
- **Expected:** The unattributed planned total is shared equally across active members (last member absorbs the rounding remainder, the `Split` convention; sum-preserving) and an amber strip names it: **"€X of income isn’t assigned to a person"**; its (i) **About unassigned income** reads "€X of {month}’s income isn’t assigned to a person, so it’s treated as shared equally. Assign income lines on the Dashboard for an accurate split." The strip's action **Assign on the Dashboard** (named "Assign income lines on the Dashboard") opens the Dashboard (`/`). Commit is never blocked. `AllocationResultDto` carries `unattributedIncome`/`incomeFromBudget` on preview AND commit.
- **Automated:** Full (backend `AllocationIncomeFromBudgetTests`; client ALLOC-072; `AllocationPage.restyle.test.tsx` "unassigned income: the action says it goes to the Dashboard")

### ALLOC-073 - The pool is the month's budgeted income and nothing else (rule 28)
- **Priority:** P0
- **Type:** Regression
- **Preconditions:** Case A: a month whose income lines are attributed to people. Case B: a month with income lines but none attributed. Case C: a month with no income lines (or no budget). Saved defaults 9,999 / 8,888 in every case.
- **Steps:**
  1. Open `/allocation` on each month and compare the pool with the budget figures.
- **Expected:** Case A: pool = the month's PLANNED attributed income plus the equally shared unattributed lines; each member's `netIncome` is their attributed sum plus their equal share. Case B: pool = the unattributed total shared equally (a 4,000 line → 2,000 each), `incomeFromBudget` true, `unattributedIncome` 4,000. Case C: pool 0 (the hero reads **€0.00**) and a grey strip **"No income in {Month Year}’s budget yet"** (its line `role="status"`); its (i) **About adding income** reads "No income in {Month Year}’s budget yet. Add income lines to the Dashboard (attribute them to people for a by-income split) and come back.", and its action **Open the Dashboard** opens `/`. The defaults are never used. Lines attributed to an archived member fold into the unattributed pot. Linking a savings account from this page never rewrites a person's default income. PLANNED (not received) by design: the engine plans; a mid-month run must not see half a salary.
- **Automated:** Full (backend `AllocationIncomeFromBudgetTests` incl. `NoAttributedLines_ShareTheUnattributedIncomeEqually_AndIgnoreTheSavedDefaults`, `NoBudget_YieldsAnEmptyPool_NotTheDefaults`; client ALLOC-073 and ALLOC-074 — the same strip with no budget at all)

### ALLOC-075 - A renamed person keeps one pocket-money line: the sync reuses it, the rename follows it (rule 53)
- **Priority:** P0
- **Type:** Regression
- **Origin:** W11, rule 53 — "syncing after a rename must reuse the existing linked line rather than leaving the original amount and adding a duplicate"
- **Preconditions:** Shared household with pocket money 100.00 per member; the current and next months hold synced **Pocket Money** lines "Alex" and "Sam" (linked). Sam also has a line the user renamed to "Sam — treats" in an earlier month.
- **Steps:**
  1. On `/people`, rename Sam to "Samantha".
  2. Open the current and next months' budgets; then, on `/allocation` for the current month, press the strip's **Add pocket money** (named "Add pocket money to {month}'s budget").
  3. Set pocket money to 120.00 and sync again.
- **Expected:** Step 1: the linked lines named "Sam" now read **"Samantha"** in every month (100.00 each, category and month totals unchanged); the customised "Sam — treats" line keeps its name. Step 2: the sync finds Samantha's line by its link — the category still has exactly two lines, no "Samantha" duplicate next to a stale "Sam"; the response reports nothing created. Step 3: the same two lines move to 120.00. A pre-W11 month whose "Sam" line has no link: the first sync after the rename finds no linked line and no unlinked "Samantha" line, so it adds one — the only case a rename can leave two lines, and it needs a month never synced since the change.
- **Automated:** Full (backend `PocketMoneyIdentityTests.Sync_LinksEachLineToItsPerson_AndARenameReusesTheLine`, `Rename_FollowsEveryMonthsLinkedLine_ButKeepsACustomisedName`, `Sync_AdoptsALegacyLineByName_AndLinksIt`)

### ALLOC-076 - A share bound for a private savings account is refused up front; its holder runs the allocation
- **Priority:** P0
- **Type:** Negative / Happy
- **Origin:** Adversarial review of PR #277 (P1-2): the owner's run skipped a person whose savings account was private to them, reported success, and the person's own re-run then failed with 403.
- **Preconditions:** Shared household; Chris and Sam each have June income lines; the allocation profile's source is "Joint"; Chris's savings account is shared; Sam's savings account (chosen on People) is private to Sam's login.
- **Steps:**
  1. As Chris, open `/allocation` for June. 2. As Chris, **Allocate**. 3. As Sam, **Allocate** June.
- **Expected:** 1: Sam's Savings row reads "Private savings account" (amber while his share is positive), with no "Stays in" line and no **Link account** chip; its (i) **About Sam’s share** says only Sam can record this transfer and Allocating is refused until Sam shares it or picks a shared savings account on the People page. Sam is not listed as having no savings account. 2: the Allocate dialog is titled "Record June’s transfers" and lists Sam as "Private savings account" with the same (i); recording gets 400 "Sam's savings account is private, so only Sam can record a transfer into it…", shown in the page's error banner; nothing moves for anyone. 3: the run records both transfers, Sam's into his private account. A profile whose source account is private to another login is refused the same way, naming the source (P53).
- **Automated:** Yes (JointAccountsW13Tests — `IncomeAllocation_IntoAPrivateSavingsAccount_IsRefusedUpFront_ThenItsHolderRunsIt_P53`; AllocationPage.test.tsx — "names a private savings account instead of calling it missing")
