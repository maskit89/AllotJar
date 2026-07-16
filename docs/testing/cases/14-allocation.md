# Allocation

**ID prefix:** ALLOC | **Scope:** The `/allocation` page (`client/src/pages/AllocationPage.tsx`) for shared households — the income-allocation setup profile (source account, pocket money, "Split shared costs" Equally/By income, "Send savings to" Balance/Equally/By income, balance lean), the read-only hero + waterfall preview (Cover shared costs → Fund the jars → Pocket money → Split remainder to savings), per-member surplus tiles, honest banners/InfoHints, the Allocate (commit) action with its idempotency/no-source/stranded/dangling-account guards, and the solo-household gate. Covers the surfaced behaviour of the domain `IncomeAllocator`/`AllocationPlanner` (split modes, savings pooling, BalanceTilt/WaterFill, ExcludeFromAllocation, member savings balances) as it appears in preview and commit. | **Out of scope:** jar creation/accrual and the Savings budget grid (`13-jars.md`); member CRUD, personal-savings-account assignment, roles/invite mechanics (`households-people` sibling); the transfer transactions created by commit as register entries (`11-transfers.md`); account balances/reconciliation (`12-accounts-reconciliation.md`); the empty-month IsBalanced hero and month copy/seeding (`06-dashboard-budget-view.md`, `07-month-lifecycle.md`); deep role matrix, dark/responsive/axe sweeps and cross-feature journeys (their own files) — touched here only where the behaviour is allocation-specific.

**Test data setup:**
- **Muscat (shared)** — 2 active members: **Chris** (net €4,411.64, personal savings account "Chris Savings"), **Liza** (net €3,999.97, personal savings account "Liza Savings"). EUR accounts: **"Joint Current"** (source, balance €8,000.00), "Chris Savings" (€35,631.96), "Liza Savings" (€46,033.38). Current budget month **June 2026** with Expense envelopes planned **€3,641.00** and Savings/jar contributions **€2,164.00**, income lines pooling to **€8,411.61**. Saved profile **"Household allocation"**: source = Joint Current, pocket **€250** each, split **Equally**, send savings to **Balance**, lean **25**. Golden preview under these settings: pool €8,411.61 → Cover shared costs €3,641.00, Fund the jars €2,164.00, Pocket money €500.00 (€250 each), Split remainder to savings €2,106.61 (Chris €1,316.63 / Liza €789.98). Hero: Shared spending €6,305.00, To savings €2,106.61.
- **Solo** — a 1-member household (owner only); `isShared` = false.
- Enum wire values: `AllocationRuleType` FundEnvelopes=0, FundJars=1, FixedPerMember=2, SplitRemainderToMembers=3; `SplitMethod` Equal=0, ByIncomeRatio=1, BalanceTilt=2. Money is integer minor units at scale 4 client-side; the visitor's `preferredCurrency` (EUR here) drives the `€` symbol and formatting.
- Roles: `canWrite` (Admin+) gates Settings/Set-up + the modal; `canEnterData` (Limited+) gates the Allocate button; ReadOnly gets neither. The commit endpoint is `[AllowLimited]`.

---

## Page gating & entry states

### ALLOC-001 - Shared household with a saved profile loads hero + waterfall
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Muscat household, signed in as Owner, profile saved as in setup.
- **Steps:**
  1. Navigate to `/allocation`.
- **Expected:** Hero renders eyebrow "Income to allocate" with **€8,411.61**, tiles "Shared spending" **€6,305.00** and "To savings" **€2,106.61**. Card heading "How **June** is allocated" (browser-locale long month of the current budget month, from `/budget/current`, else today). Four waterfall rows with their totals and two per-member surplus tiles appear. No error banner.
- **Automated:** Yes (`client/src/pages/AllocationPage.test.tsx` — "renders the waterfall and each member's surplus")

### ALLOC-002 - Solo household reaching /allocation shows "Add people first"
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Solo household (1 member), signed in as Owner; even if an allocation profile happens to exist.
- **Steps:**
  1. Navigate directly to `/allocation` by URL.
- **Expected:** EmptyState titled **"Add people first"** with copy about pooling everyone's income, and a button **"Add people"**. The settings form / waterfall never render. Clicking "Add people" navigates to `/people`. (Client-only gate — the API has no ≥2-member guard.)
- **Automated:** Yes (`AllocationPage.test.tsx` — "nudges a solo user to add members instead of the allocation engine")

### ALLOC-003 - Allocation nav link hidden for a solo household
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Solo household; `householdAllocation` flag on.
- **Steps:**
  1. Observe the primary nav.
- **Expected:** No "Allocation" nav item while `isShared` is false (it appears once the household has ≥2 active members); "People" stays visible. Deep nav-gating matrix lives in the routing/households siblings; this asserts only the allocation link.
- **Automated:** Yes (`client/src/components/AppNav.test.tsx` — People always shown, Allocation hidden solo, appears at 2+ members)

### ALLOC-004 - No profile yet → "No allocation set up yet" + Set up allocation
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household (shared), **no** allocation profile, signed in as Owner (canWrite).
- **Steps:**
  1. Navigate to `/allocation`.
- **Expected:** EmptyState titled **"No allocation set up yet"** with a **"Set up allocation"** button. No hero, no waterfall (preview is not fetched until a profile exists).
- **Automated:** Yes (`AllocationPage.test.tsx` — "shows a setup empty-state when no profile exists")

### ALLOC-005 - No profile, ReadOnly role hides "Set up allocation"
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Shared household, no profile, signed in as a **Read-only** member.
- **Steps:**
  1. Navigate to `/allocation`.
- **Expected:** The "No allocation set up yet" EmptyState renders but the **"Set up allocation"** button is absent (button is `canWrite`-gated). No modal can be opened.
- **Automated:** No

### ALLOC-006 - Loading state
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Shared household; profile + accounts + budget requests in flight.
- **Steps:**
  1. Open `/allocation` and observe before the requests resolve.
- **Expected:** Plain "Loading…" text is shown; hero/waterfall/empty-state appear only after load completes.
- **Automated:** No

### ALLOC-007 - Fetch failures degrade gracefully (no hard error page)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Shared household; `/allocation/profile`, `/accounts`, or `/budget/current` returns an error.
- **Steps:**
  1. Open `/allocation` with the profile fetch failing.
- **Expected:** A failed profile fetch is treated as **no profile** → the "No allocation set up yet" setup state; a failed accounts fetch leaves the source select empty; a failed `/budget/current` falls back to today's year/month. The generic "Could not load the allocation setup." banner is defensive (each request has its own catch) and should essentially never be the observed outcome for a single failed dependency.
- **Automated:** No

### ALLOC-008 - Feature flag householdAllocation off
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `GET /api/features` returns `householdAllocation: false`.
- **Steps:**
  1. Attempt to reach `/allocation`.
- **Expected:** The route is not registered → the SPA redirects unknown paths to `/`; the "Allocation" nav item is hidden; `/api/allocation/*` returns 404 server-side. Flag/route behaviour is owned by the routing sibling; asserted here only for the allocation surface.
- **Automated:** Partial (`AppNav.test.tsx` covers nav hiding; route redirect untested here)

---

## Allocation settings modal — setup & controls

### ALLOC-009 - Open Settings on an existing profile prefills saved values
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household with saved profile, Owner.
- **Steps:**
  1. On `/allocation`, click **"Settings"** (aria "Allocation settings").
- **Expected:** Modal titled **"Allocation settings"** opens with source = "Joint Current", pocket money "250", "Split shared costs" = **Equally**, "Send savings to" = **Balance**, "Balance lean (0–100)" = "25". Primary button reads **"Save"**. (For a new profile the title is "Set up allocation" and the primary button is "Set up".)
- **Automated:** No

### ALLOC-010 - Set up a brand-new profile end-to-end
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Shared household, **no** profile, Owner, at least one account exists.
- **Steps:**
  1. Click **"Set up allocation"**.
  2. In the modal (titled **"Set up allocation"**), pick "Joint Current" in **"Source account"**.
  3. Type `250` in **"Pocket money per member"**.
  4. Leave "Split shared costs" = Equally, "Send savings to" = Balance, lean = 25.
  5. Click **"Set up"** (aria "Save allocation settings").
- **Expected:** `PUT /allocation/profile` is sent with `sourceAccountId` = the chosen account, `name` "Household allocation", `balanceLeanPercent` 25, and a **4-rule** `rules` array (orders 0-3: FundEnvelopes, FundJars, FixedPerMember €250, SplitRemainderToMembers). Modal closes; hero + waterfall render from the fresh preview.
- **Automated:** Yes (`AllocationPage.test.tsx` — "saves a new profile from the setup form")

### ALLOC-011 - Source account select options
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Shared household with 3 EUR accounts, Owner, in the settings modal.
- **Steps:**
  1. Open the **"Source account"** select.
- **Expected:** First option is the placeholder **"Choose an account…"** (empty value), followed by every account name ("Joint Current", "Chris Savings", "Liza Savings"). Selecting one sets the source; the InfoHint "About the source account" clarifies it only affects the commit, not the preview.
- **Automated:** No

### ALLOC-012 - Split shared costs segmented control
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Settings modal open, Owner.
- **Steps:**
  1. Toggle **"Split shared costs"** between **"Equally"** and **"By income"**.
- **Expected:** Two options only (Equally / By income); the chosen value is written to BOTH the FundEnvelopes and FundJars rules on save (cost split applies to shared costs and jars alike).
- **Automated:** No

### ALLOC-013 - Send savings to segmented control
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Settings modal open, Owner.
- **Steps:**
  1. Inspect **"Send savings to"**.
- **Expected:** Three options in order **"Balance"** / **"Equally"** / **"By income"** (BalanceTilt / Equal / ByIncomeRatio). Default for a new profile is **Balance**. The value is written to the terminal SplitRemainderToMembers rule.
- **Automated:** No

### ALLOC-014 - Balance lean field is conditional on "Balance"
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Settings modal open, Owner.
- **Steps:**
  1. With "Send savings to" = **Balance**, observe the **"Balance lean (0–100)"** field.
  2. Switch to **Equally** (or By income).
  3. Switch back to **Balance**.
- **Expected:** The lean input is visible only while "Balance" is selected; it disappears for Equally/By income and reappears for Balance. The typed lean value persists across the toggle.
- **Automated:** No

### ALLOC-015 - InfoHints render and are not nested inside labels
- **Priority:** P3
- **Type:** Regression
- **Origin:** PR #163 / InfoHint `<button>` must not sit inside a `<label>`
- **Preconditions:** Settings modal open.
- **Steps:**
  1. Locate the InfoHint buttons "About the source account", "About splitting shared costs", "About the savings split", "About balance lean".
  2. Click the field's visible label text (e.g. "Pay shared costs from").
- **Expected:** Each InfoHint opens its tooltip on click. Clicking the control's label text focuses/opens the control, NOT the tooltip — the source-account InfoHint sits in a `div` with the Select carrying its own `aria-label="Source account"`, so the label press never routes to the hint button.
- **Automated:** Partial (`client/e2e/a11y.spec.ts` axe-scans the page, not this specific interaction)

### ALLOC-016 - Pocket money invalid rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Settings modal open, Owner.
- **Steps:**
  1. Type `abc` (or `1.2.3`) in "Pocket money per member".
  2. Click Save/Set up.
- **Expected:** In-modal ErrorBanner **"Enter a valid pocket-money amount."**; no `PUT /allocation/profile` request; modal stays open.
- **Automated:** No

### ALLOC-017 - Pocket money empty defaults to zero
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Settings modal open, Owner.
- **Steps:**
  1. Clear the pocket-money field entirely.
  2. Save.
- **Expected:** Blank parses as **0**; profile saves with the FixedPerMember rule at €0; the "Pocket money" waterfall step then shows €0.00 total and no "· €X each" suffix.
- **Automated:** No

### ALLOC-018 - Pocket money negative / whitespace / unicode
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Settings modal open, Owner.
- **Steps:**
  1. Try `-50`, then `   ` (spaces only), then `💶`.
  2. Save each.
- **Expected:** `-50` and `💶` → **"Enter a valid pocket-money amount."** with no request (`parseMinor` rejects negatives and non-numeric). Whitespace-only: `pocket.trim() === ''` treats it as empty → 0 and saves at €0 (documented behaviour).
- **Automated:** No

### ALLOC-019 - Pocket money huge value & >4 decimals
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Settings modal open, Owner.
- **Steps:**
  1. Enter `250.12345` (5 dp), save; then a very large value like `99999999999`, save.
- **Expected:** `250.12345` is rounded half-up to scale 4 (250.1235) before storage. A large amount within `[0, 99 999 999 999 999.9999]` is accepted; beyond it the server 400s "Fixed amount is out of range." (client has no upper bound of its own).
- **Automated:** No

### ALLOC-020 - Balance lean non-numeric rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Settings modal, "Send savings to" = Balance, Owner.
- **Steps:**
  1. Type `abc` in "Balance lean percent".
  2. Save.
- **Expected:** ErrorBanner **"Balance lean must be a whole number between 0 and 100."**; no request (`Number.parseInt('abc')` → NaN).
- **Automated:** No

### ALLOC-021 - Balance lean boundary 0 and 100 accepted
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Settings modal, Balance, Owner.
- **Steps:**
  1. Enter `0`, save; reopen, enter `100`, save.
- **Expected:** Both accepted; `balanceLeanPercent` 0 and 100 persist. 0 = plain even split, 100 = fill lowest balance first (per the InfoHint).
- **Automated:** No

### ALLOC-022 - Balance lean out of range 101 / -1 rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Settings modal, Balance, Owner.
- **Steps:**
  1. Enter `101`, save; then `-1`, save.
- **Expected:** Both blocked with **"Balance lean must be a whole number between 0 and 100."**; no request.
- **Automated:** No

### ALLOC-023 - Balance lean empty defaults to 25
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Settings modal, Balance, Owner.
- **Steps:**
  1. Clear the lean field and save.
- **Expected:** Blank lean defaults to **25** and is saved as `balanceLeanPercent: 25`.
- **Automated:** No

### ALLOC-024 - Balance lean silently truncates fractional/trailing text
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Settings modal, Balance, Owner.
- **Steps:**
  1. Enter `25.5`, save; then `25px`, save.
- **Expected:** `Number.parseInt(...,10)` truncates both to **25** (in range) → saved as 25 with no validation error. Documented quirk: the field accepts and truncates rather than rejecting a decimal/suffixed lean.
- **Automated:** No

### ALLOC-025 - Saving the profile clears a stale "Allocated" banner
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / committed banner cleared on profile save (numbers changed → stale)
- **Preconditions:** Muscat household; an allocation was just committed (green "Allocated June — N transfers…" banner showing).
- **Steps:**
  1. Click Settings, change a value (e.g. pocket money), click Save.
- **Expected:** On save the committed banner is cleared (`setCommitted(null)`) and the preview re-runs; the stale transfer count no longer shows beside the freshly changed numbers.
- **Automated:** No

### ALLOC-026 - Cancel reverts unsaved settings edits
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / Cancel & backdrop resync the form from the saved profile
- **Preconditions:** Muscat household with saved profile (pocket €250, split Equally), Owner.
- **Steps:**
  1. Open Settings, change pocket to `999`, switch split to "By income".
  2. Click **"Cancel"** (aria "Cancel settings").
  3. Reopen Settings.
- **Expected:** On reopen the form shows the saved values (pocket 250, split Equally) — the discarded edits are gone. A later Save cannot quietly commit a value the user thought they had cancelled (`syncFormFromProfile` runs on close).
- **Automated:** No

### ALLOC-027 - Backdrop close reverts unsaved settings edits
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #163 / backdrop close also resyncs
- **Preconditions:** As ALLOC-026.
- **Steps:**
  1. Open Settings, change lean to `90`.
  2. Close the modal by clicking the backdrop (not Save).
  3. Reopen Settings.
- **Expected:** Lean is back to the saved 25 — closing via backdrop discards edits exactly like Cancel.
- **Automated:** No

### ALLOC-028 - Save failure surfaces an error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Settings modal, Owner; `PUT /allocation/profile` returns 500/network error.
- **Steps:**
  1. Fill valid values and Save.
- **Expected:** In-modal ErrorBanner **"Could not save the allocation profile."**; modal stays open; no committed banner is cleared until a successful save.
- **Automated:** No

### ALLOC-029 - Balance lean is sent even when savings split is not Balance
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Settings modal, Owner.
- **Steps:**
  1. Set "Send savings to" = **Equally** (lean field hidden), leave lean at 25 from a prior state, Save.
- **Expected:** The request still includes `balanceLeanPercent` (from the retained lean state), even though the lean control was hidden. The value is inert for a non-Balance savings split but is persisted and re-applies if the user switches back to Balance.
- **Automated:** No

---

## Preview, hero & waterfall display

### ALLOC-030 - Hero eyebrow, pool amount and two tiles
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household, profile saved, Owner.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** Hero eyebrow **"Income to allocate"**, amount **€8,411.61**, tile "Shared spending" **€6,305.00**, tile "To savings" **€2,106.61**.
- **Automated:** Yes (`AllocationPage.test.tsx` — asserts pool 8,411.61, "Shared spending" and "To savings" tiles present)

### ALLOC-031 - Hero tiles reconcile to the pool by construction
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #163 / hero reconciliation (Shared spending + To savings = pool)
- **Preconditions:** Muscat household, profile saved.
- **Steps:**
  1. Read the two hero tiles and the pool.
- **Expected:** "Shared spending" (€6,305.00 = envelopes €3,641.00 + jars €2,164.00 + pocket €500.00) **plus** "To savings" (€2,106.61) equals the pool €8,411.61 exactly, because the terminal step total = pool − (envelopes+jars+pocket). Holds even when "To savings" is negative (see the negative-remainder case in this section).
- **Automated:** Partial (`AllocationPage.test.tsx` renders both tiles; exact arithmetic reconciliation asserted in domain `IncomeAllocatorTests`)

### ALLOC-032 - Waterfall shows four labelled steps with totals
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household, profile saved.
- **Steps:**
  1. Read the ordered waterfall list.
- **Expected:** Four rows in order: **"Cover shared costs" €3,641.00**, **"Fund the jars" €2,164.00**, **"Pocket money" €500.00**, **"Split remainder to savings" €2,106.61**. Each row has the brand dot marker; totals are right-aligned tabular numbers; only the terminal savings row carries the highlighted brand-tinted background.
- **Automated:** Yes (`AllocationPage.test.tsx` asserts "Pocket money" step label present within the rendered waterfall)

### ALLOC-033 - Pocket money step shows the per-member "· €X each"
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Muscat household, pocket €250 each.
- **Steps:**
  1. Read the "Pocket money" row.
- **Expected:** Row reads "Pocket money · **€250.00 each**" with total €500.00. When pocket is €0 the "· each" suffix is absent.
- **Automated:** No

### ALLOC-034 - Per-member surplus tiles
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household, profile saved, both members have savings accounts.
- **Steps:**
  1. Read the two member tiles.
- **Expected:** Chris tile: name "Chris", "Savings €35,631.96 → saves", surplus **€1,316.63** (brand colour, positive), "Projected balance **€36,948.59**" (= 35,631.96 + 1,316.63). Liza tile: surplus **€789.98**, "Projected balance €46,823.36". No "no savings account" warning.
- **Automated:** Yes (`AllocationPage.test.tsx` asserts 1,316.63 and 789.98 appear)

### ALLOC-035 - Negative residual member shown in rose with projected balance
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A member whose income share of obligations exceeds their income so their residual is negative (remainder ≤ 0 keep-own branch).
- **Steps:**
  1. Load `/allocation` with such a preview.
- **Expected:** That member's surplus is rendered rose/negative (e.g. −€120.00); "Projected balance" = savingsBalance + residual (can be lower than the current balance). Commit skips a residual ≤ 0 (nothing transferred for them).
- **Automated:** No

### ALLOC-036 - Member with no savings account warns and won't transfer
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Muscat household; Liza's "Savings account" is set to "None" on `/people`.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** Liza's tile shows **"No savings account set — won't transfer on commit."** Her positive share is counted as *stranded* (see the stranded-note case). Committing does not create a transfer for her and does not error.
- **Automated:** No

### ALLOC-037 - "Nothing left to move to savings" note
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A month where shared costs + jars + pocket consume the whole pool (To savings ≤ 0) and every member has a savings account (stranded = 0).
- **Steps:**
  1. Load `/allocation`.
- **Expected:** Slate note: **"Shared spending uses up all the pooled income this month, so there's nothing left to move to savings."** The stranded note is not shown.
- **Automated:** No

### ALLOC-038 - Stranded-surplus note when a member lacks a savings account
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Muscat household; a member with a **positive** residual but no savings account.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** Amber note: **"€X has nowhere to go — a member has no savings account, so that share stays in the source account instead of transferring."** where €X = the sum of positive residuals of account-less members. This note wins over the "nothing to save" note when the stranded total > 0.
- **Automated:** No

### ALLOC-039 - Negative "To savings" hero tile still reconciles
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** A month where obligations exceed the pool → terminal remainder ≤ 0 (keep-own), so "To savings" is negative.
- **Steps:**
  1. Read the hero.
- **Expected:** "To savings" renders a negative amount (e.g. −€310.00); Shared spending + To savings still equals the pool. Member tiles show each member's own (possibly negative) leftover; commit transfers nothing (all residuals ≤ 0).
- **Automated:** No

### ALLOC-040 - Zero-income / empty budget month → pool €0.00
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Muscat household; current budget month has no income lines (pool 0). Profile saved.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** Hero pool **€0.00**; the waterfall deducts obligations from a €0 pool so "To savings" is ≤ 0 and the "nothing left to move to savings" note shows (or the stranded note if applicable). No crash. The empty-month *IsBalanced* hero on the dashboard is out of scope (`06-dashboard-budget-view.md`).
- **Automated:** No

### ALLOC-041 - Preview failure shows an error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Shared household with a profile; `GET /allocation/preview/{y}/{m}` returns an error.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** Page-level ErrorBanner **"Could not compute the allocation preview."** (shown when no modal is open). Hero/waterfall do not render for that failed period.
- **Automated:** No

---

## Committing the allocation

### ALLOC-042 - Allocate the month creates savings transfers
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Muscat household, profile with source "Joint Current", both members have savings accounts, Owner or Limited.
- **Steps:**
  1. On `/allocation`, click **"Allocate June"** (aria "Commit allocation").
- **Expected:** `POST /allocation/commit/2026/6` with `{}`. Green status banner **"Allocated June — 2 savings transfers created. Re-running Allocate replaces them, never doubles up."** Two `Transfer` transactions (Chris €1,316.63 → Chris Savings, Liza €789.98 → Liza Savings), dated the 1st, payee "Income allocation — {name}", `BankReference` `alloc:2026-6:{memberId}` (month not zero-padded).
- **Automated:** Yes (`AllocationPage.test.tsx` — "commits the allocation"; commit body + "2 savings transfers created")

### ALLOC-043 - Allocate with zero transfers needed
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Muscat household where every member's residual ≤ 0 or none have savings accounts, so `transfersCreated` = 0.
- **Steps:**
  1. Click Allocate.
- **Expected:** Banner reads the zero variant: **"Allocated June — no savings transfers were needed this month."** No transfer transactions written.
- **Automated:** No

### ALLOC-044 - Re-running Allocate replaces, never doubles
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #163 wording + idempotent commit (`alloc:{y}-{m}:` prefix delete-then-recreate)
- **Preconditions:** Muscat household already allocated for June once.
- **Steps:**
  1. Click **"Allocate June"** a second time (optionally after editing a member's income).
- **Expected:** The prior `alloc:2026-6:*` transfers are deleted then recreated with the same references — the register shows exactly 2 allocation transfers, not 4; the unique `(Owner, BankReference)` index is not tripped. Preview totals match the re-commit because the savings-balance tilt read excludes this month's own alloc transfers.
- **Automated:** Yes (`tests/AllotJar.IntegrationTests/AllocationRerunTests.cs` — rerun recreates same references without tripping the index; `Application/AllocationTests.cs` — Allocate is idempotent)

### ALLOC-045 - Allocate disabled + hint when no source account
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #163 / no-source guard (Allocate disabled + amber hint)
- **Preconditions:** Muscat household with a profile whose `sourceAccountId` is null.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** The **"Allocate June"** button is `disabled`; amber hint **"Set the account to pay shared costs from in Settings before you can allocate June."** The waterfall/preview still render (source only affects commit). `hasSource` reads from the saved profile, so setting a source in Settings and saving re-enables the button.
- **Automated:** Yes (`AllocationPage.test.tsx` — "disables Allocate and explains when no source account is set")

### ALLOC-046 - Commit failure shows the check-your-accounts error
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Muscat household; `POST /allocation/commit/{y}/{m}` returns 400/404/500 (e.g. source account deleted between load and commit → 404 "Source account {id} was not found.").
- **Steps:**
  1. Click Allocate.
- **Expected:** Page ErrorBanner **"Could not commit the allocation. Check the source account and members' savings accounts are set."** No committed banner shown; the button re-enables when `busy` clears.
- **Automated:** No

### ALLOC-047 - Commit skips a member whose savings account is gone (no 500)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #162 / dangling savings-account link — commit must not write a broken Transfer FK
- **Preconditions:** Muscat household where Liza's `personalSavingsAccountId` points at a now-deleted (or foreign) account; Chris's is valid.
- **Steps:**
  1. Click Allocate.
- **Expected:** Commit succeeds with only Chris's transfer created; Liza is skipped (the planner nulls the dangling link). No `DbUpdateException`/500. Liza's tile shows "No savings account set — won't transfer on commit." and her share is reported stranded.
- **Automated:** Yes (`tests/AllotJar.IntegrationTests/AllocationRerunTests.cs` — commit skips a member whose savings account is gone)

### ALLOC-048 - ReadOnly member cannot see Settings or Allocate
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Muscat household with a profile, signed in as a **Read-only** member.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** Hero + read-only waterfall render, but neither the **"Settings"** button (canWrite) nor the **"Allocate June"** button (canEnterData) appears. The read-only access banner explains view-only access.
- **Automated:** No

### ALLOC-049 - Limited member can Allocate but not open Settings
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Muscat household with a profile, signed in as a **Limited** member.
- **Steps:**
  1. Load `/allocation`.
- **Expected:** The **"Allocate June"** button is present and usable (commit endpoint is `[AllowLimited]`); the **"Settings"** button is hidden (profile edits need Admin+). A Limited user runs allocations but cannot change the split/source.
- **Automated:** No

---

## Split modes & savings-split behaviour

### ALLOC-050 - Split shared costs = Equally
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household, "Split shared costs" = Equally.
- **Steps:**
  1. Read the per-member breakdown of the "Cover shared costs" and "Fund the jars" steps.
- **Expected:** Each member is charged half of €3,641.00 and half of €2,164.00 (Round2, with the LAST member absorbing any odd cent so the split sums exactly to each step total).
- **Automated:** Partial (`Application/AllocationTests.cs` — preview reproduces the waterfall from budget totals)

### ALLOC-051 - Split shared costs = By income
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household, "Split shared costs" = By income (Chris 4,411.64 / Liza 3,999.97 of net 8,411.61).
- **Steps:**
  1. Save the profile with By income and read the step breakdown.
- **Expected:** Shared costs and jars are split in proportion to each member's net income (Chris pays the larger share); each step still sums exactly to its total, last member taking the rounding cent.
- **Automated:** Partial (`Domain/IncomeAllocatorTests.cs` — by-income split sums exactly to the total)

### ALLOC-052 - Send savings to = Balance (BalanceTilt) leans to the lower balance
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Muscat household, savings split = Balance, lean 25; Chris balance €35,631.96 < Liza €46,033.38.
- **Steps:**
  1. Read the terminal step per-member amounts.
- **Expected:** The €2,106.61 remainder tilts toward Chris (lower balance): Chris €1,316.63 > Liza €789.98; both still receive a positive share at lean 25. Rounding drift is pushed onto the LARGEST share (not necessarily the last member).
- **Automated:** Partial (`Domain/IncomeAllocatorTests.cs` — BalanceTilt leans toward the lower balance, both still save)

### ALLOC-053 - Send savings to = Equally pools then splits evenly
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #162 / "Send savings to: Equally" was inert (kept-own) before the terminal-rule pooling fix
- **Preconditions:** Muscat household, savings split = **Equally**.
- **Steps:**
  1. Save the profile and read the terminal step.
- **Expected:** The €2,106.61 remainder is pooled and split evenly (≈€1,053.30 / €1,053.31 with the last member taking the odd cent) — NOT left as each member's own leftover. Sum equals the terminal total exactly.
- **Automated:** Yes (`Domain/IncomeAllocatorTests.cs` — SplitRemainderToMembers Equally pools and splits; `Application/AllocationTests.cs`)

### ALLOC-054 - Send savings to = By income pools then splits by income ratio
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #162 / "By income" savings split was inert before the fix
- **Preconditions:** Muscat household, savings split = **By income**.
- **Steps:**
  1. Save and read the terminal step.
- **Expected:** The remainder is pooled and split in proportion to each member's net income; sum is exact. Confirms the option is now real (not silently keep-own).
- **Automated:** Yes (`Domain/IncomeAllocatorTests.cs` — ByIncome pool-and-split; sums exactly)

### ALLOC-055 - Full lean (100) pours everything into the lower balance
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Muscat household, savings split = Balance, lean **100**; Chris balance < Liza.
- **Steps:**
  1. Save and read the terminal step.
- **Expected:** With lean 100 the WaterFill fills the lowest balance first, so (given the gap) the whole positive remainder goes to Chris and Liza gets €0.00 of the surplus until balances level. No overflow.
- **Automated:** Yes (`Domain/IncomeAllocatorTests.cs` — full lean pours everything into the lower account)

### ALLOC-056 - Rounding-cent placement differs by split rule but sums stay exact
- **Priority:** P2
- **Type:** Edge
- **Origin:** PR #162 / cent placement — Split → last member, BalanceTiltSplit → largest share
- **Preconditions:** Muscat household; a remainder that does not divide evenly.
- **Steps:**
  1. Compare the terminal per-member amounts under Equally vs Balance.
- **Expected:** Under Equally the odd cent lands on the LAST member; under Balance the drift lands on the LARGEST share — potentially different members. In both cases the per-member amounts sum EXACTLY to the terminal total. Assert sum-exactness + invariants, not a fixed member's cent.
- **Automated:** Partial (`Domain/IncomeAllocatorTests.cs` — equal split sums exactly even with odd cents)

### ALLOC-057 - New/equal-balance couple must not 500 (WaterFill overflow)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #162 / WaterFill `k * decimal.MaxValue` OverflowException at the top tier — the default-savings-split regression for any brand-new couple
- **Preconditions:** Brand-new Muscat-style household: 2 members with **equal or zero** savings balances, savings split = Balance (default), any lean.
- **Steps:**
  1. Load `/allocation` (fires the preview), then click Allocate.
- **Expected:** Preview AND commit both succeed; the top tier is levelled directly via `FillToLevel` and the remainder splits between the two members without an OverflowException/500. Highest-value regression — the pre-fix code 500'd for every equal-balance couple on both preview and commit.
- **Automated:** Yes (`Domain/IncomeAllocatorTests.cs` — BalanceTilt does not overflow for equal/zero balances across lean settings; `Application/AllocationTests.cs`)

### ALLOC-058 - ExcludeFromAllocation categories are excluded from the deductions
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #162 / preview excludes categories flagged `ExcludeFromAllocation` (allocation-output lines like "Personal Savings")
- **Preconditions:** Muscat household whose month contains an Expense or Savings category flagged `ExcludeFromAllocation` (importer-set, carried by month-copy).
- **Steps:**
  1. Load `/allocation` and read the "Cover shared costs" / "Fund the jars" totals.
- **Expected:** The flagged category's planned amount is NOT included in the FundEnvelopes/FundJars resolved totals, so it is not deducted from the pool (prevents double-counting the engine's own output lines). Removing the flag would raise those step totals.
- **Automated:** Yes (`Application/AllocationTests.cs` — preview excludes flagged categories + tilts surplus to the lower balance)

### ALLOC-059 - Savings balances feeding the tilt exclude this month's own alloc transfers
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Muscat household already allocated for June once (alloc transfers exist), savings split = Balance.
- **Steps:**
  1. Reload `/allocation` and compare the per-member tilt to the first commit.
- **Expected:** The savings balances feeding the tilt exclude transfers whose `BankReference` starts `alloc:2026-6:` for the viewed month, so the preview equals the re-commit (a re-run does not "see" its own prior transfers and drift). Member tile "Savings €X" reflects account opening + income − expense + transfers in − transfers out, minus this month's own alloc transfers.
- **Automated:** Partial (`tests/AllotJar.IntegrationTests/AllocationRerunTests.cs` covers rerun idempotency; the exclusion read is unit-covered in `AllocationTests`)

### ALLOC-060 - Cost split writes to both the envelope and jar rules
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Muscat household, Owner.
- **Steps:**
  1. In Settings set "Split shared costs" = By income, Save.
  2. Inspect the persisted profile rules.
- **Expected:** Both the FundEnvelopes (order 0) and FundJars (order 1) rules carry `split = ByIncomeRatio`; the FixedPerMember rule keeps `split = Equal` and the terminal rule carries the separate savings split. The client always writes the fixed 4-rule standard waterfall.
- **Automated:** No
