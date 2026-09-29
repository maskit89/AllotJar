# People & Households

**ID prefix:** PPL | **Scope:** The `/people` page (PeoplePage) — budget-person CRUD (add a person with no login, inline rename/income/savings edit, archive/remove, incl. a member who has income & attributed transactions), the owner materialized as member #1 (no 0-member state), the solo→shared transition and `isShared` gating flips (Allocation nav appears, member selects enable), the "Sign-in & access" cell that displays the member↔login linkage (invite pill, "This is me" claim, role select, Remove, "Other sign-ins"), inviting a person to sign in (link + direct temp-password), plus the `/account` household cards (Start my own budget, Leave this household, Sharing) and the UserMenu household switcher with data isolation between households. | **Out of scope:** the exhaustive **invite/accept validation matrix** — every invite-modal field rule, the `AcceptInvitePage` path/error permutations, token/expiry/reuse semantics — is owned by `17-invites.md` (INV-*). This file keeps the People-page **linkage display** (the "Sign-in & access" cell: Invited pill, role select, Remove, "This is me", "Other sign-ins"), the People-page-initiated invite *flow* (creating a link / direct login from a person row) and the household-**landing** consequences of accepting (which household you end up in), each cross-referencing `17-invites.md` for full depth — the two files are designed to overlap, with 17 reciprocally ceding member CRUD, the switcher, start-own and leave back to this file. Deep role/permission enforcement matrices (UI-hidden + server 403/404 for every denied cell) → `25-roles-permissions.md`; auth/session/JWT/refresh, cross-tab logout, ConsentModal internals, `safeInternalPath` unit semantics → `03-session-auth-lifecycle.md`; login/register and the sample-budget opt-in → `02-registration-login.md`; onboarding/welcome/checklist → `05-onboarding.md`; the allocation engine itself (waterfall, splits, commit) → `14-allocation.md`; per-account balances/currency → `12-accounts-reconciliation.md`; transaction attribution mechanics → `10-transactions.md`; dashboard hero/empty-month states → `06-dashboard-budget-view.md`; responsive/dark/a11y sweeps and multi-feature journeys → their dedicated files (`26-ux-states.md`, `20-journeys.md`, `22-concurrency-multiuser.md`).

**Test data setup:** Three reusable fixtures unless a case overrides them. **(A) Solo owner** — login `alex@x.eu` (Owner), household "Your household" with exactly one member ("Alex", income 0), no other logins, no EUR accounts. **(B) Shared household** — Owner `alex@x.eu` + members "Alex" (income 3,000.00, linked to Alex's login) and "Sam" (income 1,000.00, linked to an Active `sam@x.eu` membership, role Admin); an EUR account "Joint". Combined income = 4,000.00; shares 75% / 25%. **(C) Pure invitee** — login `robin@x.eu` created by accepting an invite link into household B; has **no own household** (`ownsHousehold=false`), one Active membership in B. Money is `decimal(18,4)` server-side / integer minor units client-side. Feature flags `HouseholdAllocation` + `HouseholdAccess` default ON. All exact labels/messages below were read from source at repo `<local>\Documents\Projects\ZeroBudget` (`PeoplePage.tsx`, `AccountPage.tsx`, `AcceptInvitePage.tsx`, `AppShell.tsx`, `HouseholdsController.cs`) on 2026-07-15.

---

## People page — load, hero & empty state

### PPL-001 - People page loads with hero, headcount and household table
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B (shared household, 2 members), signed in as owner.
- **Steps:**
  1. Navigate to `/people` (or click the "People" nav item).
  2. Observe the hero and the "Your household" table.
- **Expected:** Hero eyebrow "Combined income" with amount `€4,000.00`; tiles "People" = `2` and "Shared this month" = the summed member spending. Section header "Your household". Table columns in order: Person, Income, Share, Spent, Savings, "Sign-in & access". Alex row shows income `€3,000.00`, share `75%`; Sam row `€1,000.00`, `25%`. The "You" sub-label appears under the person linked to the current login (Alex).
- **Automated:** Partial (`client/src/pages/PeoplePage.test.tsx`)

### PPL-002 - People nav item is always visible (even solo)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture A (solo owner, 1 member).
- **Steps:**
  1. Sign in; inspect the primary nav (sidebar ≥900px and mobile top bar).
- **Expected:** "People" nav item (`data-tour="nav-people"`, → `/people`) is shown whenever `features.householdAllocation` is on, regardless of solo/shared. The "Allocation" item is NOT shown (solo). See PPL-030 for the shared case.
- **Automated:** Yes (`client/src/components/AppNav.test.tsx`)

### PPL-003 - Loading state renders before data resolves
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Fixture B; throttle the `/members` response.
- **Steps:**
  1. Open `/people` and observe before the fetch settles.
- **Expected:** "Loading…" text is shown; the table/empty-state renders only after `reloadAll()` (which fetches `/members`, `/accounts`, `/members/spending`, `/access/members` in parallel) resolves.
- **Automated:** No

### PPL-004 - Initial load failure shows the load error banner
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Fixture B; force `GET /members` to fail (500/network).
- **Steps:**
  1. Open `/people`.
- **Expected:** Page-top ErrorBanner "Could not load your household." (the other three fetches individually `.catch(() => [])`, so only the `/members` failure trips the load error). No table renders.
- **Automated:** No

### PPL-005 - Empty household shows the solo-friendly empty state
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A household whose `GET /members` returns `[]` (reachable only by archiving the owner's own person — see PPL-029 — or pre-backfill/error data).
- **Steps:**
  1. Open `/people` with zero active members.
- **Expected:** EmptyState with title "Budgeting on your own?" and copy inviting the user to add a partner/housemate; no table. Hero "People" tile shows `0`.
- **Automated:** Partial (`client/src/pages/PeoplePage.test.tsx`)

### PPL-006 - Spending tile ("Shared this month") follows the selected month, in the budget currency
- **Priority:** P2
- **Type:** Happy
- **Origin:** REVIEW P2 / rule 29 (the People page shows the same month and figures as the Budget)
- **Preconditions:** Fixture B; Sam has attributed expense transactions of €120 in the selected month, €80 in a prior month, and a row paid in GBP (£100) whose confirmed amount is €120.00 in the selected month, plus a GBP row still waiting for its EUR amount (`fxPending`).
- **Steps:**
  1. Open `/people`; read the "Shared this month" tile and the per-row "Spent" column.
  2. Navigate the TopBar month to the prior month.
- **Expected:** The page loads `GET /members/spending/{year}/{month}` for the selected month: Sam's Spent is €240.00 (120 + the confirmed 120; the £100 is only a caption, never multiplied by a rate), the waiting row is left out and shown as a "+1 needs EUR amount" hint under the Spent cell (PPL-082); after step 2 the figures are the prior month's (€80.00). Split transactions attribute per-slice `MemberId`; unsplit via `t.MemberId`; unattributed count for no one. A **refund** attributed to a person (an income row linked to a purchase, rules 38/39, W12) counts **negative** in their Spent for the month it was received and never in their Received income. The all-time `GET /members/spending` remains for other consumers.
- **Automated:** Full (backend `MemberFiguresRule28Tests`, `MemberSpendingTests`, `RefundTests.MemberFigures_NetRefundsOutOfSpending_AndLeaveThemOutOfIncome`; client PPL-006)

---

## Add a person (member create)

### PPL-007 - Add a budget person without a login (happy)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Fixture A (solo owner), signed in as owner (canWrite).
- **Steps:**
  1. Click "+ Add person" (aria-label "Add person").
  2. In the "Add a person" modal, type "Sam" into "Name" (placeholder "First name").
  3. Type `1000` into "Net monthly income" (placeholder "0.00").
  4. Click "Add person".
- **Expected:** `POST /members {name:"Sam", netMonthlyIncome:1000, personalSavingsAccountId:null}` → 201. Modal closes; Sam appears in the table with income `€1,000.00`; a login is NOT created (Sign-in cell shows the invite/claim controls, not an email). `member_added` analytics event fires. Household refreshes; because there are now 2 members it flips solo→shared (PPL-030).
- **Automated:** Yes (`client/src/pages/PeoplePage.test.tsx`, `client/e2e-journey/invite.spec.ts`)

### PPL-008 - Add person with Enter key submits
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Fixture A; "Add a person" modal open with a name typed.
- **Steps:**
  1. Focus "Net monthly income" and press Enter.
- **Expected:** `addMember()` fires (same as clicking "Add person"); the person is created.
- **Automated:** No

### PPL-009 - Add person with a personal savings account
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B (household has EUR account "Joint").
- **Steps:**
  1. Open "Add a person"; note the "Savings account" select renders (accounts exist).
  2. Choose "Joint" and submit with name "Sam", income `500`.
- **Expected:** `POST /members` carries `personalSavingsAccountId` = Joint's id; the Savings column for Sam shows "Joint". The id is validated server-side to belong to the household.
- **Automated:** No

### PPL-010 - Savings-account select is hidden when no accounts exist
- **Priority:** P2
- **Type:** Edge
- **Origin:** gotcha #22 (accounts fetch `.catch(() => [])`; select renders only when `accounts.length > 0`)
- **Preconditions:** Fixture A (no accounts), or a household whose `/accounts` fetch fails.
- **Steps:**
  1. Open "Add a person".
- **Expected:** No "Savings account" field is rendered (only Name + Net monthly income). No error is surfaced for the missing/failed accounts fetch; the Savings column elsewhere shows "—".
- **Automated:** No

### PPL-011 - Add person: empty name rejected client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture A; "Add a person" modal open.
- **Steps:**
  1. Leave "Name" empty, income `100`, click "Add person".
- **Expected:** In-modal ErrorBanner "Give the person a name."; no `POST /members`.
- **Automated:** No

### PPL-012 - Add person: whitespace-only name rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Fixture A; modal open.
- **Steps:**
  1. Type "   " (spaces) into "Name", income `0`, submit.
- **Expected:** Client trims → empty → "Give the person a name."; no API call. (Server also enforces NotEmpty "A member needs a name." as a backstop.)
- **Automated:** No

### PPL-013 - Add person: invalid / negative income rejected client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture A; modal open, name "Sam".
- **Steps:**
  1. Enter income `abc` → submit. Then retry with `-5` → submit. Then `1.2.3` → submit.
- **Expected:** Each shows "Enter a valid monthly income." with no `POST /members` (`parseMinor` rejects `abc`, `-5`, `1.2.3`). Blank income is treated as `0` and is valid (PPL-014).
- **Automated:** No

### PPL-014 - Add person: blank income defaults to zero
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Fixture A; modal open, name "Sam".
- **Steps:**
  1. Leave "Net monthly income" empty and submit.
- **Expected:** `parseAmount('') → 0`; `POST /members {netMonthlyIncome:0}` succeeds; Sam shows income `€0.00` and share `0%` when the household total is 0, or their proportional share otherwise.
- **Automated:** No

### PPL-015 - Add person: income above server range rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Fixture A; modal open, name "Sam".
- **Steps:**
  1. Enter an income above the max (server bound is `InclusiveBetween 0 and 99,999,999,999,999.9999`), e.g. `100000000000000`, and submit.
- **Expected:** Client passes it (numerically valid); server returns 400 with validator message "Net monthly income is out of range."; the modal surfaces the fallback "Could not add that person." (the client add-catch does not flatten field errors). Person not created.
- **Automated:** No

### PPL-016 - Add person: unicode/emoji and very long names
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Fixture A; modal open.
- **Steps:**
  1. Add a person named "Zoë 🌱" income `10` → submit.
  2. Add a person with a 121-character name → submit.
- **Expected:** (1) Succeeds; the name renders verbatim and the avatar initials derive from the first/last word ("Z"). (2) Server rejects (name max 120) → client fallback "Could not add that person."; not created. Duplicate names are allowed (no uniqueness constraint on member name).
- **Automated:** No

### PPL-017 - "+ Add person" hidden for non-writers
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Signed in to household B as a Limited or Read-only member.
- **Steps:**
  1. Open `/people`.
- **Expected:** No "+ Add person" button (shown only when `canWrite`, i.e. Owner/Admin). The table is still visible. A direct `POST /members` would 403 server-side ("Your access level (…) does not permit this action."). See `25-roles-permissions.md` for the full matrix.
- **Automated:** Partial (`client/src/pages/RoleGating.test.tsx` covers ReadOnly/Limited hiding on other pages)

---

## Edit a person (inline rename / income / savings)

### PPL-018 - Inline edit a person's name, income and savings account
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B; signed in as owner; hover reveals row actions.
- **Steps:**
  1. Hover Sam's row and click "✎" (aria "Edit Sam", title "Edit person").
  2. The row switches to inputs: "Name for Sam", "Net monthly income for Sam", "Savings account for Sam" (with a "None" option).
  3. Change name to "Sam M", income to `1200`, savings to "Joint"; click "Save" (aria "Save Sam").
- **Expected:** `PUT /members/{id} {name:"Sam M", netMonthlyIncome:1200, personalSavingsAccountId:<Joint>}`; `member_edited` fires; row re-renders with the new values; Combined income hero recomputes to `€4,200.00` and shares to ~71% / 29%.
- **Automated:** No

### PPL-019 - Cancel inline edit discards changes
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture B; Sam's row in edit mode with a changed name.
- **Steps:**
  1. Click "Cancel" (aria "Cancel edit").
- **Expected:** Row reverts to display mode with the original values; no `PUT` is sent.
- **Automated:** No

### PPL-020 - Inline edit validation mirrors add
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Fixture B; Sam's row in edit mode.
- **Steps:**
  1. Clear the name, click "Save". Then restore the name, set income to `abc`, click "Save".
- **Expected:** "Give the person a name." then "Enter a valid monthly income." respectively; no `PUT` until both are valid. On a server failure the row shows "Could not save that person."
- **Automated:** No

### PPL-021 - Editing the owner's own person
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Fixture A/B; the owner's own person ("Alex", the "You" row).
- **Steps:**
  1. Edit Alex's income from 0 to `3000` and Save.
- **Expected:** Succeeds (no special guard on the owner's person); the owner is a normal member for CRUD purposes. Combined income and shares update accordingly.
- **Automated:** No

---

## Archive / remove a person

### PPL-022 - Archive a person on one click when no pocket money needs a decision (rule 54)
- **Priority:** P1
- **Type:** Happy
- **Origin:** gotcha #21 (archive has no confirmation, no in-UI undo); W11 (rule 54) added the one case that asks first — PPL-084
- **Preconditions:** Fixture B; signed in as owner. Sam has no pocket-money line this month, or one with nothing left beyond what was paid.
- **Steps:**
  1. Hover Sam's row and click "✕" (aria "Archive Sam", title "Archive person").
- **Expected:** The page reads `GET /members/{id}/archive-preview`; with `thisMonth` null or `thisMonth.remaining` 0 it fires `PUT /members/{id}/archive {archived:true}` on the single click — **no confirmation modal**. Sam disappears from the table; "Income this month" drops to the remaining income lines' total; Alex's share becomes `100%`. Household refreshes; 1 remaining member flips shared→solo (Allocation nav hides). Any pocket-money line of Sam's already planned in a **later** month is cancelled by the server (PPL-084 for the amounts). There is no restore UI — restore is API-only (PPL-077).
- **Automated:** Full (client PPL-022/023, PPL-086 second half; backend `PocketMoneyIdentityTests.Archive_NeedsNoDecision_WhenNothingRemainsThisMonth_OrTheLineIsOverspent`)

### PPL-023 - Archive a member who has income AND attributed transactions
- **Priority:** P0
- **Type:** Edge
- **Origin:** gotcha #6 (leave/revoke/archive keep the budget person's attributed data; "Nothing was deleted")
- **Preconditions:** Fixture B; Sam has income 1,000.00 and €500 of attributed expense transactions in the register.
- **Steps:**
  1. Archive Sam from `/people`.
  2. Open `/transactions` and check Sam's previously-attributed transactions.
- **Expected:** Sam is excluded from `GET /members` (default), from the spending totals, and from income-share math (Combined income → €3,000.00). Her transactions are NOT deleted — they remain in the register (the `HouseholdMember` and all attributed data persist). No money is lost or moved. Rule 54: the pocket-money payments recorded against Sam's lines stay too, and a cancelled line's planned amount never falls below what was paid; her **income** lines in every month are untouched by the archive (only the Allocation pool folds an archived earner's lines into the unattributed pot — ALLOC-073).
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/HouseholdMembersTests.cs` archive-hides-from-default; `MemberSpendingTests.cs` excludes-archived; `PocketMoneyIdentityTests.Archive_LeavesIncomeLines_AndOtherPeoplesLinesAlone`, `Archive_Cancel_DropsThisMonthsPlanToWhatWasPaid_AndKeepsThePayment`)

### PPL-024 - Archived member is absent from the People table (no restore control)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Fixture B with Sam already archived.
- **Steps:**
  1. Open `/people`.
- **Expected:** Sam does not appear (PeoplePage never passes `includeArchived=true`); there is no toggle to view or restore archived people from the UI. Restore requires `PUT /members/{id}/archive {archived:false}` via API (PPL-077) and **recreates nothing** (HANDOVER P17): pocket-money lines cancelled by the archive stay cancelled; the Allocation page's "Add pocket money" sync creates Sam's line for the month again when it is run. The archive-preview of an already archived person reports `isArchived:true` and archiving again is a no-op for the lines.
- **Automated:** No

### PPL-025 - Archived earner's income share is NOT zeroed when fetched with includeArchived
- **Priority:** P2
- **Type:** Regression
- **Origin:** gotcha (HouseholdMemberDto mapping applies `income/activeTotal` to archived members too, contradicting the handler comment)
- **Preconditions:** Household B; call `GET /members?includeArchived=true` directly (API-only; no UI path).
- **Steps:**
  1. Archive Sam (income 1,000; active total after archive = 3,000).
  2. `GET /members?includeArchived=true` and read Sam's `incomeSharePct`.
- **Expected:** Sam's `incomeSharePct` is `1000/3000 ≈ 0.3333` (NOT 0), so the returned shares can exceed 100% across the full list. Confirms the mapping bug; the default (active-only) list is unaffected. Purely an API-surface edge — the People UI never requests archived members.
- **Automated:** No

### PPL-026 - Archive button hidden for non-writers
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Signed in to household B as Limited/Read-only.
- **Steps:**
  1. Hover a member row.
- **Expected:** No "✎"/"✕" hover actions (gated on `canWrite`). Read-only/Limited can view but not mutate members.
- **Automated:** Partial (`client/src/pages/RoleGating.test.tsx`)

---

## Owner-as-member-#1 & the no-0-member invariant

### PPL-027 - Registration materializes the owner as member #1
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #97 (`OwnerMemberSeeder.EnsureOwnerMemberAsync`; no 0-member state)
- **Preconditions:** A brand-new registration (empty account, sample opt-in unchecked).
- **Steps:**
  1. Register a new login, then open `/people`.
- **Expected:** Exactly one member exists — the owner — named from the fallback chain (first name → display name → email local-part → "You"), income 0. The household is solo (1 member); People nav is visible, Allocation nav is not. No "Budgeting on your own?" empty state on a fresh account (there is always ≥1 member).
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/OwnerMemberSeederTests.cs`, `MembershipSeederTests.cs`)

### PPL-028 - Startup backfill gives pre-existing households an owner member (idempotent)
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #97 (`OwnerMemberSeeder.BackfillOwnerMembersAsync`, non-fatal, skips populated households)
- **Preconditions:** A legacy account that predates the owner-member seeder.
- **Steps:**
  1. Restart the API (runs the backfill) and open `/people`.
- **Expected:** The owner appears as a member; a household that already had members is left untouched (backfill is idempotent and skips populated households). No duplicate owner members are created.
- **Automated:** Partial (`OwnerMemberSeederTests.cs`, `MembershipSeederTests.cs`)

### PPL-029 - Archiving the last/only member reaches the empty state (no guard)
- **Priority:** P2
- **Type:** Edge
- **Origin:** gotcha (no guard in `ArchiveHouseholdMemberCommandHandler`; "✕" shows on your own row)
- **Preconditions:** Fixture A (solo owner, only member is the owner's own person).
- **Steps:**
  1. Hover the owner's own row, click "✕".
- **Expected:** The archive succeeds with no block; `GET /members` → `[]` → the "Budgeting on your own?" empty state renders, `isShared=false`. This is the one reachable 0-active-member state; it is recoverable only by re-adding a person (or API restore). Document as an accepted gap, not a crash.
- **Automated:** No

---

## Solo ↔ shared transition & isShared gating

### PPL-030 - Adding a 2nd member flips solo → shared live
- **Priority:** P0
- **Type:** Happy
- **Origin:** PR #97 (`SHARED_THRESHOLD = 2`; PeoplePage calls `refreshHousehold()` after add)
- **Preconditions:** Fixture A (solo, 1 member); Allocation nav absent.
- **Steps:**
  1. Add a 2nd person via "Add person".
  2. Observe the nav immediately (no manual reload).
- **Expected:** After the add, `refreshHousehold()` refetches `/members`; `isShared` becomes true (`members.length >= 2`); the "Allocation" nav item (`data-tour="nav-allocation"`, → `/allocation`) appears without a page reload. AccountPage "Sharing" card copy flips to "shared between 2 people".
- **Automated:** Partial (`client/src/components/AppNav.test.tsx` asserts Allocation at 2+; the live-flip after add is UI-only)

### PPL-031 - Archiving back to 1 member flips shared → solo live
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B (2 members), Allocation nav present.
- **Steps:**
  1. Archive one member so only 1 remains.
- **Expected:** `refreshHousehold()` runs; `isShared` becomes false; the "Allocation" nav item disappears; visiting `/allocation` directly hits the in-page solo guard "Add people first" with an "Add people" button → `/people`. People nav stays visible.
- **Automated:** Partial (`client/src/components/AppNav.test.tsx`, `client/src/pages/AllocationPage.test.tsx`)

### PPL-032 - Solo boundary: exactly 1 member is solo, 2 is shared
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Households with 0, 1, and 2 members respectively.
- **Steps:**
  1. For each, check the Allocation nav item and the `/allocation` guard.
- **Expected:** 0 and 1 member → solo (Allocation hidden, add-people nudge); 2+ → shared (Allocation shown). Threshold is exactly `SHARED_THRESHOLD = 2` (a person IS a member). People nav shown in all cases.
- **Automated:** Yes (`client/src/components/AppNav.test.tsx`)

### PPL-033 - Shared enables member selects across the app (splits/attribution)
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Transition Fixture A → B (add a 2nd member).
- **Steps:**
  1. After becoming shared, open `/transactions` and add/split a transaction.
- **Expected:** Member-attribution selects (new-tx, edit, split-row) become available at 2+ members (they are hidden at 0/1). Detailed split/attribution behavior is covered in `10-transactions.md`; this case only asserts the gating flip is driven by `isShared`.
- **Automated:** Partial (`client/src/pages/TransactionsPage.test.tsx`)

---

## Sign-in & access cell — member↔login linkage display

### PPL-034 - Linked person shows the login email and role control
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B; signed in as owner (`canAccess` = `householdAccess && canManageHousehold`).
- **Steps:**
  1. Open `/people`; inspect the "Sign-in & access" cell for each row.
- **Expected:** Alex's row (the owner's own login) shows the email + a brand Badge with the role label (Owner is not editable). Sam's row (another Active login) shows her email + a role `<select>` (aria "Access level for Sam") with options Admin / Limited / Read-only, plus a "Remove" button (aria "Remove sign-in for Sam"). The current login's own row renders a static bordered role label (no select on yourself).
- **Automated:** Partial (`client/src/pages/PeoplePage.test.tsx`)

### PPL-035 - Change a member's role
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B; owner viewing Sam (Admin).
- **Steps:**
  1. In Sam's "Access level for Sam" select, choose "Limited".
- **Expected:** `PUT /access/members/{id}/role {role:2}`; `member_role_changed {kind:"Limited"}` fires; row updates. On failure: "Could not change that role." Role change is server-live but the SPA's own `canWrite`/`canAccess` only re-resolve on `/auth/me` (a demoted admin keeps buttons until reload). Full role behavior → `25-roles-permissions.md`.
- **Automated:** No

### PPL-036 - Remove a member's sign-in (hard delete of the membership)
- **Priority:** P1
- **Type:** Happy
- **Origin:** gotcha #6 (revoke hard-deletes the membership row; the budget person stays)
- **Preconditions:** Fixture B; owner viewing Sam's login.
- **Steps:**
  1. Click "Remove" (aria "Remove sign-in for Sam").
- **Expected:** `DELETE /access/members/{id}` → 204; `member_revoked` fires; the membership row is hard-deleted (no Revoked tombstone) so Sam's row now shows "Invite to sign in" again; Sam the budget person remains with her income/data. Re-inviting creates a brand-new membership. On failure: "Could not remove that sign-in."
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/HouseholdAccessTests.cs`)

### PPL-037 - Owner sign-in cannot be changed or removed
- **Priority:** P1
- **Type:** Negative
- **Origin:** gotcha #8 (owner is immovable)
- **Preconditions:** Fixture B; owner row.
- **Steps:**
  1. Inspect the owner's "Sign-in & access" cell; attempt `PUT /access/members/{ownerId}/role` and `DELETE /access/members/{ownerId}` directly.
- **Expected:** UI shows only a brand Badge for the owner (no select, no Remove). API returns 403 "The owner's role cannot be changed." for role change and 403 "The owner cannot be removed from the household." for delete. The invite validator also rejects role=Owner with "A household can only have one owner."
- **Automated:** Partial (`HouseholdAccessTests.cs`)

### PPL-038 - Invited (pending) login shows the amber "Invited" badge
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture B with a link-invited person whose membership is Status=Invited.
- **Steps:**
  1. Open `/people`; inspect that person's cell.
- **Expected:** The email shows with an amber Badge "Invited"; the role select and "Remove" are still available to the owner (the pending row can be re-roled or removed). The pending row occupies the email + memberId slots (blocks re-invite of the same email / re-link of the same person until removed).
- **Automated:** No

### PPL-039 - "This is me" claims an unlinked owner login onto a person
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #107 (imported/pre-existing households leave the owner login unlinked; auto-inference impossible)
- **Preconditions:** A household where the current owner login has `memberId=null` (`myUnlinked`), and an unlinked person "Alex" exists.
- **Steps:**
  1. Open `/people`; on Alex's row (no login) a "This is me" button appears (title "Connect your sign-in to this person") alongside "Invite to sign in".
  2. Click "This is me".
- **Expected:** `PUT /access/members/{myMembershipId}/link {memberId:<Alex>}`; the row now shows the owner's email + role Badge and the "You" sub-label; the current login is dropped from the "Other sign-ins" list. The button appears on every unlinked person row while the current login is unlinked.
- **Automated:** Partial (`client/src/pages/PeoplePage.test.tsx`)

### PPL-040 - Unlinked person offers "Invite to sign in"; not-canAccess shows "No sign-in"
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture B with a person who has no login.
- **Steps:**
  1. As owner (canAccess), view that person's cell.
  2. As an Admin (canWrite but NOT canManageHousehold), view the same cell.
- **Expected:** Owner sees the dashed "Invite to sign in" pill (opens the invite modal, PPL-043). Admin (canAccess=false) sees static "No sign-in" text — no invite/role/remove/link controls. Admin still sees the table and can add/edit persons.
- **Automated:** Partial (`client/src/pages/PeoplePage.test.tsx`)

### PPL-041 - "Other sign-ins" card lists orphan logins with link + remove
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture B with a membership whose `memberId=null` and `isSelf=false` (an orphan login, e.g. a login invited before being linked to a person).
- **Steps:**
  1. As owner, scroll to the "Other sign-ins" card.
- **Expected:** The orphan login is listed with displayName/email, an "Invited"/"Active" badge, a role Badge, a "Link to a person…" select (aria "Link {email} to a person") offering only members not already claimed, and a "Remove" button (aria "Remove {name}") — Remove/link controls hidden for owner/self. The card only renders when `canAccess` and at least one orphan exists.
- **Automated:** No

### PPL-042 - Login linked to an ARCHIVED member is invisible everywhere on People
- **Priority:** P2
- **Type:** Edge
- **Origin:** gotcha (person filtered out of members table; `memberId != null` excludes it from "Other sign-ins")
- **Preconditions:** Fixture B; archive Sam while her login membership still has `memberId` = Sam.
- **Steps:**
  1. As owner, open `/people` and scan the members table and "Other sign-ins".
- **Expected:** Sam's login appears NOWHERE — not in the members table (person archived/filtered) and not in "Other sign-ins" (its `memberId` is non-null). Her access cannot be viewed or revoked from the UI in this state. Real edge case: revoking requires un-archiving the member first (API) or removing via the access API by id. Flag as a coverage gap.
- **Automated:** No

---

## Inviting a person to sign in (from People)

### PPL-043 - Create an invite link for a person (happy)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B; owner; a person "Robin" with no login.
- **Steps:**
  1. On Robin's row click "Invite to sign in" → modal titled "Invite Robin to sign in".
  2. Enter Email `robin@x.eu`; leave "Access level" at Admin; keep method "Generate an invite link" (default).
  3. Click "Create invite link".
- **Expected:** `POST /access/invite {email, role:1, method:Link, tempPassword:null, displayName:"Robin", memberId:<Robin>}`; `member_invited {method:"link"}` fires. Success box "Invite link created" + "Copy this and send it to them — it works once and expires in 7 days." + a read-only "Invite link" input holding `${origin}/accept-invite?code=<token>` + a "Copy" button (→ "Copied"). The raw token is returned once and never retrievable again; Robin's row now shows an amber "Invited" badge.
- **Automated:** Yes (`client/e2e-journey/invite.spec.ts`)

### PPL-044 - Create a direct login with a temporary password
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture B; owner; person "Sam" with no login.
- **Steps:**
  1. Open the invite modal for Sam; switch the "How should they get access?" control to "Set a temporary password".
  2. Enter Email `sam@x.eu`, Temporary password `Aa1-longpass`, click "Create login".
- **Expected:** `POST /access/invite {method:Direct, tempPassword:"Aa1-longpass"}`; success box "Login created" + "sam@x.eu can sign in now with the temporary password you set…". The created login has `ConsentedUtc=null`, so it hits a blocking ConsentModal on first sign-in (consent flow → `03-session-auth-lifecycle.md`). Sam's membership is Active.
- **Automated:** No

### PPL-045 - Invite validation: empty email and short temp password
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture B; invite modal open.
- **Steps:**
  1. With email empty, click "Create invite link".
  2. Switch to "Set a temporary password", enter a valid email + a 5-char password, click "Create login".
- **Expected:** (1) In-modal "Enter an email address."; no API call. (2) In-modal "Set a temporary password of at least 8 characters." (pre-submit guard, `<8` chars); no API call. Server also enforces min-8 with the same message.
- **Automated:** No

### PPL-046 - Invite validation: email already has access to this household
- **Priority:** P2
- **Type:** Negative
- **Origin:** gotcha #14 (a pending/active membership for that email blocks re-invite; expired links linger)
- **Preconditions:** Fixture B; `sam@x.eu` already has a membership (Active or pending Invited, incl. an expired-but-not-removed link).
- **Steps:**
  1. Invite `sam@x.eu` again.
- **Expected:** Server 400 field `Email`: "That email already has access to this household."; the modal surfaces the flattened field error. An expired invite still blocks re-inviting until the owner clicks "Remove" on that pending row (no expiry-cleanup job).
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/HouseholdAccessTests.cs`)

### PPL-047 - Invite validation: direct temp-password to an email that already has an account
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** `existing@x.eu` already has an AllotJar account elsewhere.
- **Steps:**
  1. Invite `existing@x.eu` via "Set a temporary password".
- **Expected:** Server 400 field `Email`: "That email already has an account — use 'Generate an invite link' so they can accept it." (a temp-password path cannot claim an existing account). The link method is the correct route.
- **Automated:** Partial (`HouseholdAccessTests.cs`)

### PPL-048 - Invite validation: HIBP-breached temporary password rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Fixture B; direct-invite modal.
- **Steps:**
  1. Enter a known-breached password (e.g. `Password1`) as the temporary password and submit.
- **Expected:** Server 400 field `Password`: "This password has appeared in a known data breach. Please choose a different one." (BreachedPasswordValidator; policy min 8, no non-alphanumeric requirement). The check fails open if the HIBP API is unreachable.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/BreachedPasswordValidatorTests.cs`)

### PPL-049 - Invite Access-level list never offers Owner; role hint updates
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Fixture B; invite modal open.
- **Steps:**
  1. Open the "Access level" select and read the hint line as you change the value.
- **Expected:** Options are exactly Admin / Limited / Read-only (`GRANTABLE_ROLES`; Owner is never grantable). The hint under the select reflects `HOUSEHOLD_ROLE_HINTS` for the chosen role (e.g. Admin "Everything except managing members and access.", Limited "Day-to-day entry: transactions, mark bills paid, run allocation.", Read-only "View everything; cannot make changes.").
- **Automated:** No

### PPL-050 - 1:1 person↔login link is enforced (already-linked person)
- **Priority:** P2
- **Type:** Negative
- **Origin:** gotcha #9 (link enforced at invite-time, link-time, and by a global filtered unique index)
- **Preconditions:** Fixture B; person "Sam" already linked to a login.
- **Steps:**
  1. Attempt to invite a new email with `memberId` = Sam, or link an orphan login to Sam via the "Link to a person…" select.
- **Expected:** 400 field `MemberId`: "That budget person is already linked to another login." A person can be linked to at most one login; the DB unique index on `MemberId` is global (across all households), stronger than the per-household handler checks.
- **Automated:** Partial (`HouseholdAccessTests.cs`)

### PPL-051 - Invite rate limiting (429)
- **Priority:** P3
- **Type:** Boundary
- **Origin:** gotcha #18 (`/access/invite` shares the "auth" rate policy — 20/min/IP)
- **Preconditions:** Fixture B; owner.
- **Steps:**
  1. Fire more than 20 invite requests within a minute from one IP.
- **Expected:** Excess requests get HTTP 429; the modal surfaces the fallback "Could not complete that request." Journey suites hammering invites must throttle or raise `RateLimiting__AuthPermitLimit`.
- **Automated:** No

---

## Accepting an invite & landing (household-specific)

### PPL-052 - Anonymous accept: new login joins and lands IN the household
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #156 (accept sets `ActiveOwnerId` server-side so the accepter lands in the joined household — was a silent no-op)
- **Preconditions:** A valid link `/accept-invite?code=<token>` for Fixture B; a fresh, signed-out browser.
- **Steps:**
  1. Open the link → "Household invite" / "Join the household".
  2. Fill "Your name (optional)" = "Robin", "Password" ≥8, tick "I agree to the Terms of Service and Privacy Policy", click "Accept invite".
- **Expected:** `POST /auth/accept-invite {token, password, displayName, acceptedTerms:true}` → 200 (JWT + refresh cookie, `ConsentedUtc` stamped so no later consent modal). SPA navigates to `/?joined=1`; the dashboard shows household B's budget and the greeting "You've joined this household — you're viewing its shared budget now…". The accepter is a **pure invitee** (no own household). Regression: the "invite did nothing / landed in my own budget" symptom must not recur.
- **Automated:** Partial (`client/src/pages/AcceptInvitePage.test.tsx`; `client/e2e-journey/invite.spec.ts` covers the full round-trip)

### PPL-053 - Signed-in accept: existing login joins, own budget untouched, full reload
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #156 / household-sharing-rework Phase 3 (signed-in path keeps the existing login + own budget)
- **Preconditions:** Signed in as `dana@x.eu` (owns her own household); a valid invite link for B addressed to `dana@x.eu`.
- **Steps:**
  1. Open the link → the signed-in variant: "You're signed in as dana@x.eu. Joining adds this household to your account — your own budget stays exactly as it is…".
  2. Click "Accept invite".
- **Expected:** `POST /auth/accept-invite {token}` (token-only, no password); on success a full `window.location.assign('/?joined=1')` so `/auth/me` picks up the server-set active household. Dana now has 2 households (switcher appears); her own budget is unchanged; she lands in B with the joined greeting.
- **Automated:** Partial (`client/src/pages/AcceptInvitePage.test.tsx`)

### PPL-054 - Signed-in Limited/Read-only accepter is blocked by the role pipeline (defect)
- **Priority:** P1
- **Type:** Regression
- **Origin:** gotcha #25 (probable defect — `AcceptInviteCommand` ends in "Command" with no `[AllowLimited]`; `AuthorizationBehaviour` runs for every request)
- **Preconditions:** A login whose ACTIVE household role is Limited or Read-only (resolved from their current household, not the invited one); a valid invite link to a different household Y.
- **Steps:**
  1. While signed in with that active role, open the link and click "Accept invite".
- **Expected:** **Observed:** 403 "Your access level (Limited|ReadOnly) does not permit this action." before the handler runs, so the accept fails. **Desired:** accepting an invite should not be gated by the accepter's role in an unrelated household. Anonymous accepts are unaffected (no resolved role → enforcement skipped). High-value defect to confirm and file.
- **Automated:** No

### PPL-055 - Accept errors: expired link, reused link, wrong email, missing code
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Various invite links.
- **Steps:**
  1. Open a link whose `InviteExpiresUtc` is in the past and submit.
  2. Open a link that was already redeemed and submit.
  3. Signed in as `other@x.eu`, open a link addressed to `robin@x.eu` and click "Accept invite".
  4. Open `/accept-invite` with no `?code=`.
- **Expected:** (1) 403 "This invite link has expired." (2) 404 "This invite link is invalid or has already been used." (3) 400 field `Email` "This invite was sent to a different email address." (4) inline alert "This invite link is missing its code. Ask the household owner to send you a fresh link." Anonymous accept with an existing email → 400 "You already have an account — sign in first, then open this link to join."; anon terms unticked is blocked by the `required` checkbox before submit.
- **Automated:** Partial (`client/src/pages/AcceptInvitePage.test.tsx`, `HouseholdAccessTests.cs`)

### PPL-056 - "Sign in to accept" round-trips through returnUrl safely
- **Priority:** P2
- **Type:** Edge
- **Origin:** gotcha #20 (`safeInternalPath` rejects `//`, `/\`, control chars → fallback `/`)
- **Preconditions:** Signed out; an existing-account invite link.
- **Steps:**
  1. On the anonymous accept form, click "Sign in to accept".
- **Expected:** Navigates to `/login?returnUrl=%2Faccept-invite%3Fcode%3D<token>`; after sign-in the user returns to the invite page. A tampered `returnUrl` (scheme-relative/backslash/control-char) falls back to `/`. Deep returnUrl semantics → `03-session-auth-lifecycle.md`.
- **Automated:** Partial (`client/src/lib/returnUrl.test.ts`, `client/src/pages/LoginPage.test.tsx`)

---

## Household switcher & data isolation (multi-household)

### PPL-057 - Switcher appears only with >1 household; switching re-bootstraps
- **Priority:** P1
- **Type:** Happy
- **Origin:** gotcha #11 (the live switcher is in the UserMenu; `HouseholdSwitcher.tsx` is dead code) / gotcha #17 (switch returns 204, client must full-reload)
- **Preconditions:** A login with 2 households ("Your household" + joined "Alex's household").
- **Steps:**
  1. Open the account/user menu (avatar, aria "Account menu"). Note the "Household" section listing each household, the active one bold with "✓".
  2. Click the non-active household.
- **Expected:** `POST /households/switch {ownerId}` → 204, then `window.location.assign('/')` full re-bootstrap. After reload the chip reads "{currency} · {new label}", the active "✓" moves, and the whole app scopes to the new household. With only 1 household, the "Household" section is absent. (Any E2E must target these UserMenu buttons, not the unmounted `HouseholdSwitcher` select.)
- **Automated:** Partial (`client/src/components/HouseholdSwitcher.test.tsx` tests the DEAD component only; the live UserMenu switcher is not unit-tested)

### PPL-058 - Data isolation: switching households scopes ALL data
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Login with household "Own" (member "Alex") and joined household B (members Alex+Sam, account "Joint", budget with income).
- **Steps:**
  1. While active in "Own", open `/people`, `/accounts`, dashboard.
  2. Switch to B; re-open the same pages.
- **Expected:** Everything is partitioned by the active `OwnerId`: "Own" shows only its 1 member and no "Joint" account; B shows Alex+Sam, "Joint", and B's budget/months. No member, account, transaction, or budget line from one household leaks into the other. `member` CRUD from B mutates B (the active household), never "Own".
- **Automated:** No

### PPL-059 - Switching to a household you no longer have access to falls back gracefully
- **Priority:** P2
- **Type:** Edge
- **Origin:** `ActiveHouseholdSelector.Pick` (selected → own → first)
- **Preconditions:** Login active in joined B; the owner then revokes/leaves happens so the membership is gone.
- **Steps:**
  1. With the stale `ActiveOwnerId` pointing at B, make any request.
- **Expected:** `POST /households/switch` to a household with no Active membership returns 404 "You don't have access to that household."; and if the active pointer is stale mid-session, `HouseholdResolutionMiddleware` resolves selected→own→first with no error — the user simply lands in their own/first household. Role is re-resolved per request.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/ActiveHouseholdSelectorTests.cs`)

### PPL-060 - Multi-tab switch is not broadcast (stale-tab data-mixing window)
- **Priority:** P2
- **Type:** Regression
- **Origin:** gotcha #27 (switch/start-own/leave re-bootstrap only the acting tab; `authChannel` carries sign-outs only)
- **Preconditions:** Two open tabs on the same login; tab 1 active in "Own", tab 2 also showing "Own".
- **Steps:**
  1. In tab 1, switch to household B (full reload of tab 1 only).
  2. In tab 2 (not reloaded), trigger an API call (navigate to `/people`).
- **Expected:** Tab 2 keeps rendering the OLD household's cached UI, but its new API calls resolve to the NEW active household (server-side `ActiveOwnerId`), producing a transient stale/mixed view until tab 2 reloads. Only sign-outs cross tabs (BroadcastChannel `zbb.auth`). Document as a known limitation; verify no data is written to the wrong household unexpectedly.
- **Automated:** No

---

## Start my own budget (pure invitee)

### PPL-061 - Pure invitee starts their own budget (idempotent, no samples)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #158 (start-own for pure invitees) + PR #170 (never seeds samples)
- **Preconditions:** Fixture C (pure invitee `robin@x.eu`, `ownsHousehold=false`), active in the joined household.
- **Steps:**
  1. Open `/account`; the "Your own budget" card is shown (only when `!ownsHousehold`).
  2. Click "Start my own budget" (busy text "Setting up…").
- **Expected:** `POST /households/start-own` runs `HouseholdBootstrap.EnsureOwnHouseholdAsync(seedSampleBudget:false)` — creates an Owner membership + the owner as member #1, **no sample figures**, sets `ActiveOwnerId=null`, → `window.location.assign('/?started=1')`. Lands on the dashboard's create-month flow (blank/template) with the greeting "This is your own budget — set up your first month below…". Idempotent: calling again just switches back into the already-owned household. On failure: "Could not start your budget. Please try again."
- **Automated:** Partial (`client/src/pages/AccountPage.test.tsx`; `tests/AllotJar.Application.Tests/Application/HouseholdBootstrapTests.cs`)

### PPL-062 - "Your own budget" card hidden for a login that already owns a household
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner `alex@x.eu` (owns "Your household").
- **Steps:**
  1. Open `/account`.
- **Expected:** No "Your own budget" / "Start my own budget" card (gated on `!ownsHousehold` where `ownsHousehold = households.some(h => h.isOwn)`). An owner also never sees the "Leave this household" card while viewing their own household.
- **Automated:** Yes (`client/src/pages/AccountPage.test.tsx` — owner never sees start-own/leave)

### PPL-063 - Newly started own household lands over-budgeted (jars), not "balanced"
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #172 (empty month is NOT balanced; a jar-owning household's blank month lands over-budgeted via accrual-planned savings lines)
- **Preconditions:** A user who starts their own budget where the bootstrap creates jar-backed savings lines; a fresh blank month.
- **Steps:**
  1. After "Start my own budget", create a blank month and read the dashboard hero.
- **Expected:** The hero does NOT show the gold "Every {noun} has a job" balanced badge on an empty month. If accrual-planned savings lines exist it shows the rose "over-budgeted — trim a line" pill; a truly empty month shows "Plan your income, then give every {noun} a job". Detailed hero states → `06-dashboard-budget-view.md`; this case only asserts start-own doesn't produce a false "balanced".
- **Automated:** Partial (`client/src/budgetModel.test.ts`, `client/src/pages/DashboardPage.test.tsx`)

### PPL-064 - Revoked pure invitee → phantom own household with no owner member
- **Priority:** P2
- **Type:** Regression
- **Origin:** gotcha #26 (Path-B invitee has no own household; owner REVOKES their only membership → zero membership rows, no bootstrap ever ran)
- **Preconditions:** Fixture C (pure invitee, only membership is in B). The owner of B **removes** (revokes) Robin's login (not Robin leaving).
- **Steps:**
  1. As Robin, after the revoke, load the app and open `/account`.
- **Expected:** Middleware fallback makes Robin Owner-of-self, but `HouseholdBootstrap` never ran — no owner member, no months (violates the no-0-member invariant). `/auth/me` synthesizes a household entry with `isOwn:true`, so `ownsHousehold=true` and the "Start my own budget" card does NOT appear — Robin can only build up manually from an empty dashboard/People page. Distinct from the leave flow (PPL-065), which materializes the household properly. File as a defect.
- **Automated:** No

---

## Leave household (self-service)

### PPL-065 - Member leaves a joined household and lands in a real own household
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #158 (self-service leave) + PR #170 (defensive bootstrap never seeds samples)
- **Preconditions:** Fixture C (pure invitee) active in joined household B.
- **Steps:**
  1. Open `/account`; the "Leave this household" card is shown (only when the active household is joined, `!isOwn`). Copy: "Remove your access to {label}… the owner isn't needed to do this. You can be invited back anytime."
  2. Click "Leave household" → "Are you sure?" appears → click "Yes, leave" (busy "Leaving…").
- **Expected:** `POST /households/leave {ownerId:<B>}` → hard-deletes Robin's membership, then idempotently materializes Robin's OWN household (membership + owner member, **no samples**), resets `ActiveOwnerId=null`, → `window.location.assign('/?left=1')`. Lands on the create-month flow with greeting "You've left that household — you're viewing your own budget now. Nothing was deleted; you can be invited back anytime." Robin never strands in an empty un-seeded household.
- **Automated:** Partial (`client/src/pages/AccountPage.test.tsx`; `client/e2e-journey/invite.spec.ts` covers leave→own-without-samples)

### PPL-066 - Leave: two-step confirm, Cancel aborts
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture C active in B; "Leave this household" card shown.
- **Steps:**
  1. Click "Leave household" → "Are you sure?" + "Yes, leave" + "Cancel".
  2. Click "Cancel".
- **Expected:** No `POST /households/leave` is sent; the card returns to the single "Leave household" button; the user stays in B.
- **Automated:** Partial (`client/src/pages/AccountPage.test.tsx`)

### PPL-067 - Leave card hidden while viewing your own household
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Owner `alex@x.eu` viewing "Your household".
- **Steps:**
  1. Open `/account`.
- **Expected:** No "Leave this household" card (shown only when `activeHousehold && !activeHousehold.isOwn`). Guards: `POST /households/leave` with `ownerId==userId` → 400 "You can't leave your own household."; with no Active membership → 404 "You don't have access to that household."; on the Owner-role row → 400 "The owner can't leave their own household."
- **Automated:** Partial (`client/src/pages/AccountPage.test.tsx`; controller guards not unit-tested)

### PPL-068 - Leaving a joined household you are NOT currently viewing keeps your view
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** A login active in "Own", also a member of joined B; the Leave card only targets the ACTIVE household.
- **Steps:**
  1. While active in "Own", note the Leave card is absent (own household is active) — so leaving B from `/account` is not offered here.
- **Expected:** The `/account` Leave card acts on the ACTIVE household only (`activeHousehold.ownerId`); to leave B the user must switch to B first. Confirms the card never lets you leave a background household by accident. (If active in B and it is left, `ActiveOwnerId` resets to null / own.)
- **Automated:** No

---

## Sharing card, roles display & feature-flag variants

### PPL-069 - Sharing card copy: solo vs shared
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture A (solo) then Fixture B (shared).
- **Steps:**
  1. Open `/account` solo; then shared.
- **Expected:** Solo: "You're budgeting on your own…" + a "Share this budget" button → `/people`. Shared: "This budget is shared between 2 people. Manage their incomes, savings, sign-ins and access on the People page." + a "Manage people →" link → `/people`. The card is hidden while `householdLoading` (never flashes the wrong state). "1 person" is singularized correctly.
- **Automated:** Yes (`client/src/pages/AccountPage.test.tsx`)

### PPL-070 - Access-level display on the Account details card
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Fixtures for Owner, Admin, Limited, Read-only.
- **Steps:**
  1. Open `/account` as each role.
- **Expected:** The details card "Access level" shows `HOUSEHOLD_ROLE_LABELS[role] ?? 'Member'` → Owner / Admin / Limited / Read-only. The AppShell also renders a role banner for Limited ("You have limited access …") and Read-only ("You have read-only access …"). Full role enforcement → `25-roles-permissions.md`.
- **Automated:** Partial (`client/src/pages/RoleGating.test.tsx` — banner text; Admin role not exercised there)

### PPL-071 - HouseholdAccess flag OFF: People renders but hides sign-in controls
- **Priority:** P2
- **Type:** Edge
- **Origin:** feature-gate (flag off → `/api/access/*` 404; PeoplePage tolerates `/access/members` failing via `.catch(() => [])`)
- **Preconditions:** `HouseholdAccess` flag off (but `HouseholdAllocation` on).
- **Steps:**
  1. Open `/people` as owner.
- **Expected:** The page renders the members table (member CRUD still works via `/members`), but `canAccess=false` → no invite pill, no role select, no Remove, no "Other sign-ins"; every person shows static "No sign-in". No error is surfaced for the 404 on `/access/members`.
- **Automated:** No

### PPL-072 - HouseholdAllocation flag OFF: /people route unmounts, /members 404s
- **Priority:** P2
- **Type:** Edge
- **Origin:** feature-gate (`FeatureGate(HouseholdAllocation)` → controller 404; route conditionally mounted)
- **Preconditions:** `HouseholdAllocation` flag off.
- **Steps:**
  1. Navigate directly to `/people`.
- **Expected:** The `<Route>` is not mounted → the URL falls through to `*` and redirects to `/`. The "People" and "Allocation" nav items are absent. `GET /api/members*` returns 404. The legacy `/members` and `/access` redirects still resolve to `/people`'s absent route → `*` → `/`. (Brief flag-off flash caveat: client defaults all-on until `/features` responds.)
- **Automated:** Partial (`client/src/components/AppNav.test.tsx` for nav hiding)

---

## Income-share math & invite-email boundaries

### PPL-073 - Income shares when total active income is zero (no divide-by-zero)
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Fixture A extended to 2+ members where **every** active member has `NetMonthlyIncome = 0` (e.g. a fresh owner + one added person, both income 0).
- **Steps:**
  1. Open `/people` and read the hero and the "Share" column for each row.
- **Expected:** Combined income hero shows `€0.00`; every member's `IncomeSharePct` is `0` (the mapping returns 0 when `totalActiveNet <= 0`, so there is no divide-by-zero and no `NaN`/`Infinity`); the "Share" column renders `0%` for all rows. Adding income to one member makes the shares recompute (`income / totalActiveNet`, rounded 4 dp away-from-zero) and the client renders `Math.round(pct*100)%` — shares may not sum to exactly 100% due to independent per-row rounding.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/HouseholdMembersTests.cs` covers share computed across active members; the all-zero guard is asserted at the DTO-mapping level)

### PPL-074 - Case-variant / whitespace duplicate invite email (collation divergence)
- **Priority:** P2
- **Type:** Regression
- **Origin:** gotcha #13 (invite dupe-check compares `InvitedEmail == email` trimmed, NOT lowercased — case-INSENSITIVE on prod SQL Server, case-SENSITIVE under the EF InMemory CI job; accept-path email match is explicitly `OrdinalIgnoreCase`)
- **Preconditions:** Fixture B; `sam@x.eu` already has a membership (Active or pending Invited).
- **Steps:**
  1. As owner, invite `LIZA@x.eu` (different case) from a person row.
  2. Separately, invite `  sam@x.eu  ` (surrounding whitespace).
- **Expected:** On production (SQL Server, case-insensitive collation) BOTH are rejected with 400 field `Email`: "That email already has access to this household." (email is trimmed before the dupe check, so the whitespace variant is caught). The case-variant `LIZA@x.eu` is the divergence point: it is rejected on prod but WOULD slip through under the EF InMemory `backend` CI job (case-sensitive equality) — so any automated assertion on case-variant dupes must run against the SQL integration layer, not InMemory. The accept endpoint always matches the invited email case-insensitively (`OrdinalIgnoreCase`), so a case-variant accepter is still recognised. Flag the prod-vs-InMemory split for test placement.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/HouseholdAccessTests.cs` asserts same-email dupe rejection under InMemory; case-variant divergence is not pinned by an integration test)

---

## Gap-fill additions

### PPL-075 - Member create rejects a foreign / bogus personal savings account (API-surface)
- **Priority:** P2
- **Type:** Negative
- **Origin:** guard — `CreateHouseholdMemberCommandHandler` (`Household/Commands/CreateHouseholdMember`, lines ~31-39): a `PersonalSavingsAccountId` is a soft hint with NO foreign key, so the handler requires an `Account` with that id AND `a.OwnerId == userId`, else `throw new NotFoundException($"Account {savingsId} was not found.")`. The comment states this exists so a stale/foreign id can't later be booked as an allocation transfer into a non-existent (crash) or another household's (leak) account. PPL-009 only covers the happy path and asserts the validation in prose — the negative was never fired.
- **Preconditions:** Fixture B (owner `alex@x.eu`, household B has EUR account "Joint"). A SECOND, unrelated household owned by a different login `mallory@x.eu`, holding its own EUR account "Mallory-Savings" (id `A_other`, `OwnerId` = Mallory). The People "Savings account" select only lists the active household's own accounts, so a foreign or nonexistent id is reachable only via a crafted request — mirror the raw-API style of INV-025 / ALLOC-028.
- **Steps:**
  1. As owner of B, send `POST /api/members {name:"Sam", netMonthlyIncome:500, personalSavingsAccountId:<A_other>}` (an account owned by the OTHER household).
  2. Repeat with `personalSavingsAccountId:<a random GUID>` that matches no account in any household.
- **Expected:** Both requests → **404** with the problem-detail message **"Account {id} was not found."** (each id echoed back; `NotFoundException` → 404 via `ExceptionHandlingMiddleware`). The guard runs BEFORE `HouseholdMembers.Add`, so NO member row is persisted in either household: a follow-up `GET /api/members` for B still returns exactly its Fixture-B members (Sam absent), and household "Other" is untouched (no cross-household write, no link to `A_other`). Confirms the cross-household-leak guard fires: because the UI select only offers owned accounts, a regression that dropped this guard (foreign id stored → later booked as an allocation transfer into another household's account) would pass every existing UI-level test.
- **Automated:** No

### PPL-076 - Member update rejects a foreign / bogus personal savings account, leaving the row unchanged (API-surface)
- **Priority:** P2
- **Type:** Negative
- **Origin:** guard — `UpdateHouseholdMemberCommandHandler` (`Household/Commands/UpdateHouseholdMember`, lines ~39-47): same soft-hint ownership check as PPL-075 (`Accounts.AnyAsync(a => a.Id == savingsId && a.OwnerId == userId)` else `NotFoundException`). It runs AFTER the member-exists lookup (404 "Household member {id} was not found.") and the owner check (`member.OwnerId != userId` → `ForbiddenAccessException` 403), and BEFORE any field assignment or `SaveChangesAsync`. PPL-018 only covers the happy inline-edit and asserts the check in prose.
- **Preconditions:** Fixture B; member "Sam" (`lizaId`, savings currently "Joint" or none) owned by household B. The same unrelated household owned by `mallory@x.eu` with account "Mallory-Savings" (id `A_other`). Reachable only via a crafted `PUT` (the inline-edit "Savings account for Sam" select offers only B's own accounts + "None").
- **Steps:**
  1. As owner of B, send `PUT /api/members/{lizaId} {name:"Sam", netMonthlyIncome:1000, personalSavingsAccountId:<A_other>}` (foreign account).
  2. Repeat with `personalSavingsAccountId:<a random GUID>` that matches no account.
- **Expected:** Both requests → **404 "Account {id} was not found."** Because the throw precedes the `member.Name` / `member.NetMonthlyIncome` / `member.PersonalSavingsAccountId` assignments and `SaveChangesAsync`, NO field change is persisted: a subsequent `GET /api/members` shows Sam's `personalSavingsAccountId`, name and income exactly as before (no partial write, no foreign link). Same cross-household-leak regression rationale as PPL-075; distinct from a nonexistent-member `PUT` (→ 404 "Household member {id} was not found.") and a not-owned-member `PUT` (→ 403).
- **Automated:** No

### PPL-077 - Restore an archived member re-adds them to the default list, income share & shared gating (API-surface, reverse of PPL-031)
- **Priority:** P1
- **Type:** Regression
- **Origin:** write leg — `ArchiveHouseholdMemberCommand(Guid Id, bool Archived = true)` (`Household/Commands/ArchiveHouseholdMember/ArchiveHouseholdMemberCommand.cs:7`) is a **toggle**, so `Archived:false` RESTORES. `ArchiveHouseholdMemberCommandHandler.cs:36` does `member.IsArchived = request.Archived;` then (lines 39-41) recomputes `totalActiveNet` over `OwnerId == userId && !IsArchived` — which now re-includes the restored member — and returns `member.ToDto(totalActiveNet)`. `MembersController.cs:79-82` maps `PUT /api/members/{id}/archive` → the command with `request.Archived` (`ArchiveMemberRequest(bool Archived = true)`, line 93). Every existing case (PPL-022/023/029/031 archive; PPL-025 `includeArchived=true` read) only ever sets `Archived:true` or reads archived members; PPL-024 (16-people-households.md:250) documents restore as "requires `PUT /members/{id}/archive {archived:false}` via API" but never runs it. There is **no restore control in the People UI** (PPL-024), so this leg is only reachable via a crafted request, mirroring the raw-API style of PPL-075/076. Without it a broken restore (e.g. `IsArchived` not cleared, or the active-pool income not re-summed) is invisible to a tester following the catalog.
- **Preconditions:** Fixture B with **Sam already archived** (the PPL-024 starting state): the household is currently **solo** — default `GET /api/members` returns only Alex (income 3,000.00, share 100%), Combined income hero `€3,000.00`, Allocation nav absent, AccountPage "Sharing" card reads solo. Note Sam's `lizaId` (recoverable via `GET /api/members?includeArchived=true`, PPL-025). Signed in as owner `alex@x.eu`.
- **Steps:**
  1. Confirm the starting solo state on `/people`: only Alex in the table, hero `€3,000.00`, no "Allocation" nav item (there is no restore toggle in the UI — PPL-024).
  2. Send `PUT /api/members/{lizaId}/archive {"archived":false}` (raw API — no People-page control exists for this).
  3. Reload `/people` (a fresh load runs `refreshHousehold()`, which re-fetches the default `/members`).
- **Expected:** Step 2 → **200** with Sam's DTO where `isArchived:false` and `incomeSharePct` recomputed against the restored active pool: `1000/(3000+1000) = 0.25` (the handler's post-save `totalActiveNet` now sums 4,000.00, NOT the pre-restore 3,000). Then:
  - **Default list re-includes her:** a follow-up `GET /api/members` (no `includeArchived` → `false`; `MembersController.cs:35` + `GetHouseholdMembersQueryHandler.cs:29`) now returns **both** Alex and Sam — the restored member re-appears in the exact list the People UI always requests, so on reload Sam's row is back in "Your household".
  - **Income & shares recompute to include her again:** Combined income hero returns to `€4,000.00`; Alex's share recomputes back to `75%` and Sam's to `25%` (`GetHouseholdMembersQueryHandler.cs:36` sums `totalActiveNet` over active members = 4,000, so both are divided by the restored pool — the exact reverse of the archive in PPL-022/031, not a stale 3,000 divisor).
  - **Shared/solo gating flips back:** `refreshHousehold()` sets `members.length` back to 2 → `isShared` true (`HouseholdContext.tsx:97`, `SHARED_THRESHOLD = 2`) → the "Allocation" nav item (`data-tour="nav-allocation"`, → `/allocation`) reappears and the `/allocation` solo guard lifts; AccountPage "Sharing" card flips back to "shared between 2 people". This is the precise inverse of PPL-031 (archive-to-1 → shared→solo).
  - **Guards:** the restore obeys the same owner scoping as archive — `PUT …/archive` for a member whose `OwnerId != userId` → **403** (`ArchiveHouseholdMemberCommandHandler.cs:31-34`); an unknown id → **404 "Household member {id} was not found."** No sample/undo side effects; nothing was ever deleted by the earlier archive (PPL-023), so the restored member carries her original income and attributed transactions intact. A broken restore leg (IsArchived left true, or income not re-summed into the active pool) would leave Sam absent from the default list, the hero stuck at `€3,000.00`, and the Allocation nav hidden — all caught here.
- **Automated:** No

### PPL-078 - The selected month's budget drives the People hero, income column and shares (rule 28)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** The selected month's budget has income lines: Alex 3,000 attributed, Robin 1,000 attributed, 1,000 "Whole household"; saved defaults Alex 1,000 / Robin 1,000.
- **Steps:**
  1. Open `/people`; read the hero, each person's Income cell and Share.
- **Expected:** The page requests `GET /members?year=&month=`, `/members/income/{y}/{m}` and `/members/spending/{y}/{m}` for the TopBar month. Hero **"Income this month"** = 5,000.00. Alex's Income 3,500.00 (3,000 + half of the unattributed 1,000), Robin's 1,500.00; Shares 70% / 30% — from `incomeSharePct` of the month payload, never from the defaults. The "default €1,000.00" sub-line appears under each because the default differs. `Received` per member counts confirmed budget-currency amounts and excludes rows still waiting for their amount (`fxPendingCount`, shown under the hero as "+N income row(s) in another currency, not counted until its/their amount in EUR is entered." — PPL-082).
- **Automated:** Full (client PPL-078; backend `MemberFiguresRule28Tests`, `AllocationIncomeFromBudgetTests`)

### PPL-079 - Without income lines (or without a budget) every figure is zero; the defaults never fill in
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** The selected month has no budget, or income lines totalling 0; saved defaults 3,000 / 2,000.
- **Steps:**
  1. Open `/people`.
- **Expected:** Hero "Income this month" 0.00 with the note "No budget for {Month Year} yet" when there is none; every Income cell 0.00 and every Share 0%. The saved default is edited as **Default income for {name}** (add modal: "Default income") with the hint "Becomes this person's income line when you start a blank month. Calculations use the income lines in the month's budget." Nothing on the page or the Allocation page ever uses it as a pool (rule 28); its one use is seeding a blank month (BUDG-057).
- **Automated:** Full (client PPL-079; backend `AllocationIncomeFromBudgetTests.NoBudget_YieldsAnEmptyPool_NotTheDefaults`)

### PPL-082 - Rows waiting for their budget-currency amount are left out of People and say so
- **Priority:** P2
- **Type:** Edge
- **Origin:** W08 (rules 28, 42–44). Replaces the pre-W08 "+N pending rate" hint for rows whose exchange rate had not been found.
- **Preconditions:** Fixture B, budget currency EUR, a month with income lines; Alex has €120.00 of attributed spending plus two GBP expense rows and Sam one GBP income row, all imported and still waiting (`fxPending`); Sam has nothing else waiting.
- **Steps:**
  1. Open `/people` for that month; read Alex's and Sam's Spent cells and the hero.
  2. Hover the hint; then on `/transactions` enter the EUR amount for one of Alex's rows and reload `/people`.
- **Expected:** Step 1: Alex's Spent reads **€120.00** with an amber hint **"+2 need EUR amount"** under it (title "2 spending rows are in another currency, waiting for the amount in EUR, and not counted yet"); Sam's Spent has no hint (exactly one hint row on the page). The hero reads "+1 income row in another currency, not counted until its amount in EUR is entered." and Sam's Received leaves the row out. Step 2: Alex's Spent grows by the confirmed amount and the hint reads **"+1 needs EUR amount"**. The figures come from `fxPendingCount` on `GET /members/spending/{y}/{m}` and `/members/income/{y}/{m}`; nothing is converted by the app.
- **Automated:** Yes (client `PeoplePage.catalog.test.tsx` — “PPL-082: FX-pending spending and income rows show a "+N need EUR amount" hint”; backend MemberFiguresRule28Tests — `GetMemberSpending_WithAMonth_CountsOnlyThatMonth_AndSkipsWaitingRows`, `GetMemberIncome_Received_CountsConfirmedAmounts_AndSkipsWaitingRows_CountingThem`)

## Pocket money and the person (rules 53–54)

### PPL-084 - Archiving with pocket money left this month asks keep-or-cancel; "Keep this month" (rule 54)
- **Priority:** P0
- **Type:** Happy
- **Origin:** W11, rule 54 — "for the current month, ask the user whether to keep or cancel the remaining planned amount"
- **Preconditions:** Fixture B; the Allocation sync has put a **Pocket Money** line for Sam (100.00) into the current month and into next month (100.00); 60.00 of this month's line is paid (an expense on that line). Signed in as owner.
- **Steps:**
  1. Click "✕" on Sam's row.
  2. Read the dialog; click **Keep this month**.
- **Expected:** `GET /members/{id}/archive-preview` answers `thisMonth {planned 100, paid 60, remaining 40}` and `futureMonths [next month: planned 100, paid 0, remaining 100]`, so instead of archiving the page opens the dialog **"Archive Sam"**: "Sam still has **€40.00** of pocket money planned for {Month Year} (€60.00 already paid)." and "Keep it for this month, or cancel what remains? Either way Sam's payments stay recorded, and the pocket money already planned for {next Month Year} is cancelled." (with several later months: "for N later months"). Nothing is sent until a button is pressed. **Keep this month** fires `PUT /members/{id}/archive {archived:true, pocketMoneyThisMonth:0}`; the server leaves this month's line at 100.00 (60.00 paid), removes next month's untouched line (a later line with payments would instead drop to its paid amount), archives Sam; the dialog closes and the row leaves the table. Calling the PUT without `pocketMoneyThisMonth` while 40.00 remains → **400** on `PocketMoneyThisMonth`: "Sam still has 40.00 of pocket money planned for {Month Year}. Choose whether to keep or cancel it before archiving." (PPL-087 shows it).
- **Automated:** Full (client PPL-084; backend `Archive_ThisMonthWithARemainder_RequiresTheDecision`, `Archive_Keep_LeavesThisMonthsPlan_AndStillStopsNextMonth`, `Archive_ClearsFutureMonths_RemovingUntouchedLines_AndKeepingPaidOnes`, `ArchivePreview_ReportsThisMonthsRemainder_AndTheFutureMonthsToClear`)

### PPL-085 - "Cancel remaining" lowers this month's plan to what was paid and keeps the payment (rule 54)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** As PPL-084 (this month planned 100.00, paid 60.00).
- **Steps:**
  1. Click "✕" on Sam's row; click **Cancel remaining**.
  2. Open the Budget page for the current month and the Transactions register.
- **Expected:** `PUT /members/{id}/archive {archived:true, pocketMoneyThisMonth:1}`. This month's line is still there, planned **60.00** (= paid; the 40.00 remainder is cancelled), the 60.00 expense is still in the register and no account balance moved; a line nothing was ever recorded against is removed instead; an overspent line (paid above planned) is left as it is. Next month's line is cancelled as in PPL-084. The dialog's wording without payments: "€100.00 of pocket money planned for {Month Year}." with no "(… already paid)"; with no later month: "…payments stay recorded, and no pocket money is planned from next month on."
- **Automated:** Full (client PPL-085; backend `Archive_Cancel_DropsThisMonthsPlanToWhatWasPaid_AndKeepsThePayment`, `Archive_Cancel_RemovesThisMonthsLine_WhenNothingWasRecorded`)

### PPL-086 - "Don't archive" sends nothing; a fully paid or overspent month never asks
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Fixture B; Sam's pocket-money line this month planned 100.00.
- **Steps:**
  1. Click "✕" on Sam's row; click **Don't archive** (or Escape / the backdrop).
  2. Pay the full 100.00 against the line; click "✕" again.
- **Expected:** Step 1: the dialog closes, no PUT is sent, Sam is still in the table and nothing changed on the server. Step 2: the preview's `remaining` is 0, so no dialog — the plain `PUT … {archived:true}` archives on the one click (PPL-022); the same when the line is overspent (paid 120.00 on planned 100.00: remaining 0, the line is left as it is). Later months are still cancelled.
- **Automated:** Full (client PPL-086; backend `Archive_NeedsNoDecision_WhenNothingRemainsThisMonth_OrTheLineIsOverspent`)

### PPL-087 - The server's own refusal is shown, and the lines are owner-scoped
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture B with Sam's remainder this month (PPL-084); a second household whose person also has pocket-money lines.
- **Steps:**
  1. Send `PUT /api/members/{samId}/archive {archived:true}` (no decision) — or archive from a People page whose preview read failed.
  2. Send `PUT /api/members/{otherHouseholdPersonId}/archive {archived:true, pocketMoneyThisMonth:1}` as Alex.
- **Expected:** Step 1: **400** `{ errors: { PocketMoneyThisMonth: ["Sam still has 40.00 of pocket money planned for {Month Year}. Choose whether to keep or cancel it before archiving."] } }`; the People page shows that sentence in its error banner (not "Could not archive that person.") and Sam stays. Step 2: **403** before any line is read or changed — the other household's lines are untouched; an unknown id → **404**. Another person's lines and every income line in the same household are never touched by an archive.
- **Automated:** Full (client PPL-087; backend `Archive_IsOwnerScoped_BeforeItTouchesAnyLine`, `Archive_LeavesIncomeLines_AndOtherPeoplesLinesAlone`)

### PPL-088 - A savings account private to the person reads "Private account" and an edit keeps it
- **Priority:** P2
- **Type:** Regression
- **Origin:** W13 (P53): the People page named a savings account the viewer can't see "—", and its select showed "None".
- **Preconditions:** Sam's savings account is "Sam's current", private to Sam.
- **Steps:**
  1. As Chris, open People. 2. Edit Sam's income only and save.
- **Expected:** 1: Sam's savings account reads "Private account". 2: the select shows "Private account"; the save keeps the same account id and the server does not re-validate an unchanged choice.
- **Automated:** Yes (PeoplePage tests)
