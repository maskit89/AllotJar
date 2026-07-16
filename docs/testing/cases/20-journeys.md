# End-to-end user journeys

**ID prefix:** JRN | **Scope:** Realistic multi-feature life journeys run start-to-finish, each a numbered script with an explicit CHECKPOINT expectation after every stage. These cases deliberately cross subsystem boundaries — registration → onboarding → accounts → months → transactions → bills → jars → allocation → reports → sharing → session lifecycle — to exercise the *seams* that per-area cases (which see one subsystem at a time) cannot: server-side active-household resolution flowing between pages, tx-derived actuals rippling from a transaction into a month hero and a report, sample-vs-empty landing shaping the whole first run, cross-tab/cross-device session state, and the money-integrity chain across allocation → transfer → account balance → reconciliation. Where a single step equals an existing area case it is referenced by ID (e.g. "as ACCT-007"); the journey asserts the *stitching between* those steps, not the step in isolation. | **Out of scope:** single-surface depth lives in the sibling files — `01-landing-public.md` (LAND), `02-registration-login.md` (REG), `03-session-auth-lifecycle.md` (SESS), `04-account-preferences.md` (PREF), `05-onboarding.md` (ONBD), `06-dashboard-budget-view.md` (DASH), `07-month-lifecycle.md` (BUDG), `11-transfers.md` (TRF), `12-accounts-reconciliation.md` (ACCT), `13-jars.md` (JAR), `14-allocation.md` (ALLOC), `18-reports.md` (RPT), plus the transactions, people/invites and import area files. Do not re-test isolated field validation or single-endpoint error strings here.

**Test data setup:** These journeys assume a clean beta environment (`app.allotjar.com`, `IS_BETA` true, `RateLimiting__AuthPermitLimit` raised for serial e2e). Passwords must be HIBP-safe randoms (`Aa1-<uuid>`), never fixed common strings. Canonical fixtures used across journeys:
- **Solo user "Sam":** EUR, number format `comma-dot` (en-GB), registers with the sample checkbox **unticked** (PR #170 default = empty account).
- **Couple "Chris + Liza":** Chris owns the household (net monthly income 3,000.00), Liza is member #2 (net 2,000.00); joint EUR account "Joint" opening 1,250.00, plus each member's personal savings account. The allocation golden anchor figures (keep-own remainder Chris 1,259.14 / Liza 847.47) are the Bank-Summary-2026 reference numbers.
- **Multi-currency household:** one EUR account "Joint" and one GBP account "UK Savings" (currency fixed at create).
- All money is decimal(18,4) server-side / integer minor units client-side; actuals are ALWAYS transaction-derived at read time; `ExchangeRate` is hardcoded 1 app-wide today (FX deferred).

---

## Solo first-run lifecycle

### JRN-001 - Brand-new solo user: empty sign-up through a full first month to next-month copy
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** No account exists for the chosen email. Beta build. Today = mid-month (so bills can be past/future within the month).
- **Steps:**
  1. Visit `/`, click **"Get started"** → lands on `/login?register=1` with the "Create account" tab pre-selected.
  2. Fill **"First name"** "Sam", **"Last name"** "Rivera", **"Email"**, **"Password"** (random), leave **"Currency"** at the locale default (EUR) and **"Number format"** at `1,234.56`. Leave **"Start with sample figures…"** UNTICKED. Tick the required terms checkbox and the beta data-loss checkbox. Submit **"Create account"** (as REG-006).
  3. Observe the landing dashboard at `/`.
  4. The onboarding **"Welcome to AllotJar"** dialog auto-opens (owner copy). Click **"Take the tour"**, step through all 9 spotlight steps, click **"Finish"** (as ONBD-001/ONBD-007).
  5. Open the account menu → **"Account settings"** → not needed yet; instead go to `/accounts` via nav, click **"+ Add account"**, add "Everyday" (Current, opening 1,200.00) and a second "Rainy Day" (Savings, opening 0.00) (as ACCT-007).
  6. Return to `/` (Budget). On the create-month hero click a template card — aria **"Start from the Essentials template"** (as BUDG-020 / DASH-010).
  7. In the loaded month, plan income: open the Income card, edit the "Take-home Pay" style line's planned to 2,000.00; if none, use the add-income input "Add income source (e.g. Freelance, Child Benefit)…" then set planned (as DASH-033/DASH-034).
  8. Assign the rest: set expense line planned amounts until the Hero **"Remaining to budget"** reaches 0,00.
  9. Mark one expense line as a bill: hover the line, click the **📅** add-bill control, set a due day earlier than today, **✓** save (as DASH-053).
  10. Go to `/transactions`, **"+ Add transaction"**, record an Expense (Type Expense, Payee "Tesco", Amount 45.30, Account "Everyday", Category = the billed line). Submit **"Add transaction"**.
  11. Back on `/`, tick the bill's **"Paid"** toggle (as DASH-056).
  12. Review month-end: read the bills strip and the Hero footnote; open `/reports`.
  13. Advance the month with the TopBar **"Next month"** ‹›, then click **"Copy {Month Year}"** on the next month's create hero (as BUDG-005 / DASH-007).
  14. Verify the Getting-started checklist state throughout (bottom-right).
- **Expected:**
  - CP2: account created with `includeSampleData:false`; analytics `sign_up {method:'password', sample_data:false}`. No ConsentModal (registration records consent up front, as REG-048).
  - CP3: because samples were declined, `/` shows the **create-month hero** ("No budget for {Month} {Year} yet" writer variant), NOT a seeded month and NOT the gold badge — the empty default landing (PR #170).
  - CP4: welcome auto-opened exactly once for this owner; after Finish the Getting-started checklist shows **0 of 4 done** (as ONBD-028).
  - CP5: both accounts persist with derived balances 1,200.00 and 0.00; net Total-balance hero 1,200.00 (as ACCT-001).
  - CP6: month is created from the template with all planned = 0; every template Savings line minted a backing jar (real SavingsId→Jars FK). Because the household now owns jars, the month is born **over-budgeted** (rose "…over-budgeted — trim a line"), not empty (PR #172 / BUDG-028) — appended accrual savings lines carry planned > 0 against 0 income.
  - CP7-CP8: editing income planned moves the pool live; when income > 0 AND remaining == 0 the Hero flips to the gold **BalancedBadge "Every euro has a job"** and checklist steps 2 ("Plan your income") and 3 ("Give every euro a job") tick (checklist step 3 requires `income > 0 && remaining === 0`, PR #172).
  - CP9-CP11: the bill appears in the bills strip; after the Tesco tx its **tx-derived** actual lands on the billed line (spent shown, not authored); paying it flips the strip toward "All bills paid 🎉"; the paid toggle is optimistic + persists via `PUT /budget/items/{id}/paid`.
  - CP12: `/reports` now shows one trend point for this month; **"Saved this month"** hero = received income − spent; the checklist's step 4 ("Log your first transaction") is ticked → checklist reads **All set — every euro has a job! 🎉**.
  - CP13: month view resets to current calendar month is NOT triggered (SPA nav, not reload); the Copy button names the actual most-recent prior month; the copied month reproduces structure + planned, resets IsPaid to unpaid and actuals to tx-derived 0, and re-seeds seedable jar lines from the accrual calculator (as BUDG-008/BUDG-015).
  - CP14: no stale-month flash on navigation (month cleared before fetch, PR #168).
- **Automated:** Partial (`client/e2e-journey/register.spec.ts` covers the empty-landing sign-up leg only; the account→month→tx→bill→copy chain is unautomated end-to-end)

### JRN-002 - Opt-in sample sign-up: from seeded starter budget to a balanced, personalised first month
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fresh email, beta build.
- **Steps:**
  1. Register via `/login?register=1` exactly as JRN-001 but TICK **"Start with sample figures to explore…"** before submitting **"Create account"** (as REG-007).
  2. Land on `/`; skip the welcome with **"Skip for now"**.
  3. Inspect the Getting-started checklist immediately.
  4. Inspect the Hero footnote and the "Your jars" shelf.
  5. Rename a sample group inline (aria "Rename group Housing") and delete a sample line you don't need (inline confirm).
  6. Reduce the sample income line "Take-home Pay" planned from 3,000.00 to your real 2,500.00.
  7. Re-assign expense planned amounts until Remaining reaches 0,00.
  8. Open `/jars` and confirm the seeded "Emergency Fund" jar exists; open its Edit modal and read the "Opening balance" relabel + double-count helper (as JAR-033).
  9. Open `/reports`.
- **Expected:**
  - CP1: `sign_up {sample_data:true}`; server seeds the sample month (Income "Take-home Pay" 3,000 planned, Housing/Transport/Food… groups) AND a real backing "Emergency Fund" jar via `HouseholdBootstrap` with `seedSampleBudget:true` (enforced SavingsId→Jars FK).
  - CP2-CP3: dashboard shows the seeded month with a **positive** Remaining-to-budget on purpose (BudgetSeeder leaves it under-allotted) → Hero reads "{amount} still to assign", NOT the empty prompt and NOT balanced. Checklist pre-ticks exactly **2 of 4** (month exists + income > 0) but NOT step 3 (as ONBD-029).
  - CP4: the jars shelf renders (current month, jars.length > 0) showing the Emergency Fund.
  - CP5-CP7: renames/deletes are optimistic and reconcile from the server; lowering income and re-planning drives Remaining to 0 → gold **"Every euro has a job"** badge appears (income > 0 required, PR #172).
  - CP8: the jar Edit modal labels the amount field **"Opening balance"** (not "Saved so far") with the "Before tracking began…" helper; the live card balance is not double-counted.
  - CP9: reports reflect the personalised planned/received figures (tx-derived), not the seed defaults.
- **Automated:** Partial (`client/e2e-journey/register.spec.ts` asserts the seeded landing incl. `Emergency Fund` on the shelf; the edit-to-balanced chain is unautomated)

---

## Household formation & collaboration

### JRN-003 - Solo owner grows into a couple: add partner, set allocation, invite a login, partner accepts and both use it
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Chris is a registered solo owner (own household, 1 member, EUR) with a funded "Joint" account (opening 1,250.00) and a current month that has income planned. A second fresh email is available for Liza.
- **Steps:**
  1. As Chris, open `/people`. Note the solo state (1 member = "You"; Allocation nav item hidden).
  2. Click **"+ Add person"**, add "Liza" with **"Net monthly income"** 2,000.00 and a **"Savings account"** = "Liza Savings" (create that account first on `/accounts` if needed), submit **"Add person"** (people suite).
  3. Observe the nav after the add.
  4. Set Chris's own person income to 3,000.00 via the row **✎** inline edit.
  5. Go to `/allocation`; if prompted, click **"Set up allocation"**; in **"Allocation settings"** set **"Pay shared costs from"** = "Joint", **"Split shared costs"** = "By income", **"Send savings to"** = "Balance", **"Balance lean (0–100)"** = 25; **"Set up"** (as ALLOC-010).
  6. Read the waterfall preview and per-member tiles.
  7. Back on `/people`, on Liza's row click **"Invite to sign in"** → in the modal keep **"Generate an invite link"**, set **"Access level"** = "Admin", submit **"Create invite link"**, then **"Copy"** the link (`{origin}/accept-invite?code=…`).
  8. In a separate signed-out browser context, open the copied `/accept-invite?code=…` link. Fill **"Your name (optional)"** "Liza", **"Password"** (random), tick terms, click **"Accept invite"** (as invite.spec).
  9. Observe Liza's landing.
  10. As Liza, add a transaction on `/transactions` attributed to herself (Member = Liza) against a shared expense line.
  11. As Chris, refresh `/people` and read the members table (income shares, "Shared this month").
  12. As Chris, run **"Allocate {month}"** on `/allocation`; then open `/accounts` reconciliation.
- **Expected:**
  - CP1: `/people` shows the "You"-tagged owner row only; **Allocation** nav is absent (isShared requires ≥2 members).
  - CP2-CP3: after the add, `HouseholdContext.refresh()` makes `isShared` true → the **Allocation** nav item appears live without reload; combined-income hero updates.
  - CP5-CP6: the profile saves; the preview reproduces the waterfall (Cover shared costs → Fund the jars → Pocket money → Split remainder to savings) with By-income cost split; the two hero tiles ("Shared spending" + "To savings") reconcile to the pool by construction.
  - CP7: the link modal returns the raw token **once**; the pending membership shows the amber **"Invited"** badge on Liza's row; re-opening cannot retrieve the token again.
  - CP8-CP9: acceptance creates Liza's login with `ConsentedUtc` stamped (terms on the form) — **no** ConsentModal later — and the server sets Liza's active household to Chris's (`SetActiveHouseholdAsync`). Liza lands via full reload on `/?joined=1` showing the **"You've joined this household…"** greeting and Chris's shared budget (Remaining-to-budget matches Chris's), NOT an own empty budget (PR #156). Liza is a **pure invitee**: `ownsHousehold=false` → her `/account` shows the "Your own budget" card.
  - CP10: Liza (Admin) can add/attribute a transaction; the actual lands on the shared line the moment it's read (tx-derived).
  - CP11: Liza's spending appears attributed to her member row; income shares compute over active members (Chris 60% / Liza 40% by 3000/2000; rounded display may not sum to exactly 100%).
  - CP12: Allocate writes one `Transfer` per member with `Residual > 0` and a valid savings account (`BankReference = "alloc:{y}-{m}:{memberId}"`), moving money Joint → each personal savings; reconciliation on `/accounts` now shows the Joint float against any jars it backs. Re-running Allocate replaces, never doubles.
- **Automated:** Partial (`client/e2e-journey/invite.spec.ts` covers owner-adds-person → invite link → accept → lands-in-household; allocation/reconciliation legs unautomated against a real backend)

### JRN-004 - Direct temp-password invite: first sign-in hits the consent gate, then limited daily use
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Chris owns a shared household with a budget-person "Robin" (no login yet). Robin has a real email but no AllotJar account.
- **Steps:**
  1. As Chris, `/people` → Robin's row → **"Invite to sign in"** → switch **"How should they get access?"** to **"Set a temporary password"**, set **"Access level"** = "Limited", type a temporary password (≥8, HIBP-safe), submit **"Create login"** (people suite).
  2. Read the success box.
  3. In a signed-out context, go to `/login`, sign in as Robin with the email + temporary password.
  4. Observe the very first authed screen.
  5. Click **"I agree"** in the blocking dialog.
  6. Observe onboarding / dashboard.
  7. As Robin, on `/transactions` record a transaction and mark a bill **"Paid"** on `/`.
  8. As Robin, attempt to add a budget group (**"+ Add group"**) and to open `/accounts` add-account.
  9. As Robin, go to `/account` and use **"Change password"** to replace the temp password.
- **Expected:**
  - CP1-CP2: a login is created with membership Active, role Limited, and `ConsentedUtc = null`; the success box reads "Login created … They'll accept the terms on their first sign-in…".
  - CP3-CP4: Robin signs in and is immediately blocked by the **ConsentModal** ("One thing before you start") — Onboarding is NOT mounted underneath (App gates it on `!needsConsent`); the modal is non-dismissible (only "I agree" / "Sign out") and disappears if Robin navigates to `/terms`//`/privacy` so it never covers the text.
  - CP5-CP6: `POST /auth/consent` stamps `ConsentedUtc`; `needsConsent` flips false; the onboarding welcome may then appear; the dashboard shows the shared household's budget (Robin acts in Chris's household).
  - CP7: Limited role CAN record transactions and toggle Paid on bill lines (`[AllowLimited]`); the AppShell shows the amber "limited access" banner.
  - CP8: structure edits are hidden client-side and 403 server-side ("Your access level (Limited) does not permit this action."); `/accounts` shows a read-only register (no "+ Add account"), and account create 403s.
  - CP9: change-password succeeds for THIS device (fresh token + rotated cookie) and revokes all other refresh tokens; analytics `password_changed`.
- **Automated:** No

### JRN-005 - Invited-first user with no account: accept → start own budget → switch households → leave
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A fresh person (no account) has been sent a valid 7-day invite **link** into Chris's shared household (role Admin). Chris's household has a populated month.
- **Steps:**
  1. Open the `/accept-invite?code=…` link signed-out. Complete the anonymous form ("Your name (optional)", "Password", terms), **"Accept invite"**.
  2. Confirm the landing household and greeting.
  3. Open the account menu — check whether a household **switcher** section exists yet.
  4. Go to `/account`; on the **"Your own budget"** card click **"Start my own budget"**.
  5. Observe the landing after start-own.
  6. Open the account menu again; switch back to the shared household via the **"Household"** section (✓ marks active).
  7. Observe the reload + greeting.
  8. Return to `/account`; on the **"Leave this household"** card click **"Leave household"** → **"Yes, leave"**.
  9. Observe the final landing.
- **Expected:**
  - CP1-CP2: new login created with consent stamped; server sets active household to Chris's; full reload to `/?joined=1` with the joined greeting; the invitee sees Chris's shared budget. `ownsHousehold=false` at this point.
  - CP3: with only ONE household the account menu shows **no** "Household" switcher section.
  - CP4-CP5: `POST /households/start-own` bootstraps the invitee's OWN household with `seedSampleBudget:false` and switches into it → full reload to `/?started=1` with the **"This is your own budget…"** greeting and a **create-month hero** (never seeded samples, PR #170). If they later add a jar, a fresh blank month lands over-budgeted, not empty (PR #172).
  - CP6-CP7: now `households.length > 1`, so the switcher section appears; switching to Chris's household `POST /households/switch` then full `window.location.assign('/')` re-bootstrap; MonthContext resets to the current calendar month; the active-household label in the user chip flips.
  - CP8-CP9: leaving (`POST /households/leave {ownerId}`) hard-deletes the membership row, re-materialises the invitee's own household without samples, and resets `ActiveOwnerId` → full reload to `/?left=1` with **"You've left that household — … Nothing was deleted…"**; the invitee lands in their own (never-seeded) budget. Their attributed data in Chris's household is untouched.
- **Automated:** Partial (`client/e2e-journey/invite.spec.ts` covers accept → lands-in-household → leave-lands-in-own-never-seeded; the start-own + switch legs are unautomated)

---

## Import-led onboarding

### JRN-006 - Import-first power user: HSBC statement → categorise/split/transfer → re-import dedup → generic CSV mapping
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** A registered user (empty account, so no prior references) with at least two accounts ("Everyday", "Savings") and a current month that has expense + savings lines to categorise into. An HSBC transaction-history CSV (Date, Details, Amount) and a non-HSBC generic bank CSV are on hand.
- **Steps:**
  1. From `/transactions` click the **"Import"** link → `/import` ("Import transactions").
  2. Choose **"File format"** = "Bank CSV (auto-detect)", pick the HSBC file, set **"Add to account (optional)"** = "Everyday", submit **"Review transactions"**.
  3. Read the summary strip and any sniff notice.
  4. Categorise a debit row via its **"Category"** select; **Split** another row across two expense lines (Split editor, amounts must total, **"Done"**); mark an internal-looking row as a **Transfer** to "Savings".
  5. Untick a **"Possibly already imported"** row (should already be unticked). Use **"Apply to expenses"** bulk category on the remaining debits.
  6. Click **"Import {n} transactions"**.
  7. Read the **"Import complete"** tiles.
  8. Re-upload the **identical** HSBC file and **"Review transactions"** again.
  9. Now upload the **generic** CSV (non-HSBC shape) with auto-detect; on the review screen open the **"Column mapping"** card, change the **"Description column"** to a wrong column, then re-scan.
  10. Fix the mapping back, **"Apply changes & re-scan"**, then commit.
  11. Cross-check `/transactions` and `/accounts` balances.
- **Expected:**
  - CP2-CP3: because the generic upload is sniffed as HSBC, it is parsed by the HSBC parser (clean payees, `hsbc:` references) and shows the sniff notice "We recognised this file as an HSBC transaction history export…"; NO column-mapping card appears (mapping only for true generic CSV).
  - CP4: the debit's category assign is remembered; the split badge shows "Split · 2" (violet when valid); the transfer row requires a counterparty account (transfers need an import account selected) and shows "Transfer"; the split slice kinds must match the row direction.
  - CP5-CP6: possible-duplicates are default-unticked + amber-tinted (not opacity-faded); commit persists chosen categories/members and split slices; idempotent by `BankReference`.
  - CP7: the success tiles show **real money sums** ("Money in"/"Money out"), not counts (PR #160), plus a Transfers count.
  - CP8: the re-import yields **"You're all caught up"** (0 new rows, all skipped as duplicates) — unique (OwnerId, BankReference) dedup against real SQL; no commit button.
  - CP9-CP10: editing a mapping field marks the mapping **dirty** → Import disabled + "You've changed the column mapping. Re-scan to apply it…"; re-scan re-enables it; per-row edits carry across a re-scan only for rows whose reference is unchanged.
  - CP11: imported transactions appear in the register; the "Everyday" balance reflects imported debits/credits and the marked transfer moved money Everyday→Savings; actuals on the categorised lines are tx-derived on the dashboard.
- **Automated:** Partial (`client/e2e-journey/import.spec.ts` covers the generic-upload→auto-map→commit→success-sums round-trip, identical-file re-import "all caught up", and dirty-mapping block; the split/transfer/HSBC-sniff legs are unautomated at journey level)

---

## Recurring money operations

### JRN-007 - Quarter-long month-end close: jars fill, allocation commits, months roll and jar lines re-seed
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Shared couple household (Chris owner + Liza), Joint account funded, a saved allocation profile, and at least one Goal jar "Holiday" (target 1,200.00, target date ~10 months out, opening 0.00) plus one Recurring jar "Car insurance" (target 600.00, next due ~6 months out). Start on month M1 with income planned and balanced.
- **Steps:**
  1. In M1, confirm the Savings group carries a funded line per jar (accrual-planned) and the month is balanced (Remaining 0).
  2. Record real spending and income transactions for M1 across expense + savings lines.
  3. Run **"Allocate {M1}"** on `/allocation`; note transfers created.
  4. Open `/jars` and read each jar's balance, status chip and pace label.
  5. TopBar **"Next month"** → create M2 with **"Copy {M1}"**.
  6. Inspect M2's re-seeded jar lines vs M1.
  7. Repeat spend/allocate for M2, then create M3 by copy.
  8. In M3, open `/reports` and read the trend + annual overview.
  9. Archive the "Holiday" jar once it's funded (two-click **"Archive jar"** → **"Really archive?"**) and create M4 by copy.
  10. Inspect M4's jar lines.
- **Expected:**
  - CP1: each jar's planned contribution = `RequiredMonthlyContribution` from the accrual calculator (TargetByDate: remaining ÷ whole months to due); month balanced with income > 0 (PR #172).
  - CP2: actuals roll up tx-derived; savings-line "avail." rolls (planned − spend across months ≤ viewed); the Jars-page balance includes opening while the grid "avail." excludes it (two-flavour design).
  - CP3: Allocate creates member transfers (idempotent, `alloc:{M1}:{memberId}`); re-running replaces them; savings-balance tilt excludes this month's own alloc transfers so preview == re-commit.
  - CP5-CP6: M2 copy carries structure + `DueDay` + `SavingsId` + `ExcludeFromAllocation`, resets IsPaid, and **re-seeds** seedable jar lines from the accrual calculator (NOT M1's flat planned) using the as-of-M2 balance (strictly-before months only); archived-jar lines drop, dangling-SavingsId lines copy as-is (BUDG-015/BUDG-017/BUDG-018).
  - CP7-CP8: the trend shows one point per budgeted month (most-recent-N budgets, gaps skipped), annual overview lists M1–M3 with income/spent/net; reports are tx-derived so any deleted historical tx would lower them retroactively (RPT-026).
  - CP9-CP10: archiving Holiday removes it from the jars list, from reconciliation, and from M4's copy (its line is dropped); Car insurance re-arms virtually if its due date passed (recurrence is a pure view — the stored anchor is never rewritten) and reads OnTrack not Behind (JAR-044).
- **Automated:** No (no journey spec covers month rollover / jars / allocation commit against a real backend; component behaviours pinned in `CreateBudgetMonthTests`, `JarLifecycleTests`, `AllocationTests`, `AllocationRerunTests`)

### JRN-008 - Payday allocation routine end-to-end: preview reconciles, commit transfers money, balances and reconciliation update
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Shared couple household with the canonical figures — Chris net 3,000.00, Liza net 2,000.00, Joint EUR source account, each member with a personal savings account, a saved profile (cost split By income, savings split Balance lean 25). Current month has expense + savings planned so the waterfall has real deductions.
- **Steps:**
  1. On `/allocation` read the hero ("Income to allocate" = pool) and the four waterfall steps.
  2. Read each per-member tile (Savings →, residual, Projected balance).
  3. Click **"Allocate {month}"**.
  4. Read the committed banner.
  5. Open `/transactions`, filter to confirm the allocation transfer rows.
  6. Open `/accounts` and read the Joint balance + the **"Jar reconciliation"** float.
  7. Change one member's savings account to blank on `/people`, return to `/allocation`, and re-preview + re-commit.
- **Expected:**
  - CP1-CP2: pool = 3,000 + 2,000 = 5,000.00; the two hero tiles reconcile to the pool by construction; residuals reflect the keep-own / tilt math (golden anchor Chris 1,259.14 / Liza 847.47 when the profile is keep-own; with Balance-tilt the shares differ but sum exactly).
  - CP3-CP4: commit writes one Joint→personal-savings `Transfer` per member with residual > 0 and a valid savings account; banner reads "Allocated {month} — N savings transfer(s) created. Re-running Allocate replaces them, never doubles up." A brand-new equal/zero-balance couple must NOT 500 (WaterFill overflow fix, PR #162 / ALLOC-057).
  - CP5: the register shows the alloc transfers as unsigned grey Transfer rows (excluded from money-in/out).
  - CP6: the Joint balance dropped by the sum of transfers out; personal savings accounts rose; reconciliation float recomputes.
  - CP7: with a member's savings account gone, preview shows "No savings account set — won't transfer on commit." and commit **skips** that member instead of 500-ing (dangling-account fix, ALLOC-047); the stranded surplus note appears; re-commit stays idempotent.
- **Automated:** No (allocation preview/commit + skip-dangling covered by `AllocationTests` + `AllocationRerunTests` at unit/integration level, not as a journey)

---

## Account security & multi-device

### JRN-009 - Password change with other sessions open: device A continues, device B is signed out, B recovers with the new password
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #169 (dead-session prompt) / PR #171 (refresh grace) — change-password revokes all refresh tokens and rotates the security stamp; other devices must recover cleanly, the acting device must not.
- **Preconditions:** One user signed in on two independent browser contexts, **device A** (where the change happens) and **device B**, both with live sessions. B is parked on `/transactions`.
- **Steps:**
  1. On device A, `/account` → **"Change password"**: enter current, a new random password, confirm, submit.
  2. On device A, continue using the app (navigate, edit a planned amount).
  3. On device B, trigger any authenticated action/navigation (e.g. go to `/accounts`).
  4. On device B, observe the redirect and banner.
  5. On device B, sign in with the NEW password and confirm the returnUrl round-trip.
- **Expected:**
  - CP1: `POST /auth/change-password` returns 200 `AuthResponse`; device A adopts the fresh token + rotated cookie and stays signed in seamlessly (the security-stamp rotation would kill A's OLD access token, but A holds the new one).
  - CP2: device A's subsequent requests succeed with no re-prompt.
  - CP3-CP4: device B's next request 401s; the interceptor tries a silent refresh, but its refresh token was revoked → refresh 401 → `sessionExpired()` clears state, broadcasts sign-out, and hard-navigates to `/login?reason=expired&returnUrl=%2Faccounts` showing "Your session has expired…". No zombie UI (PR #169).
  - CP5: signing in with the new password returns device B to `/accounts` (returnUrl honoured, `safeInternalPath`); the old password is rejected.
- **Automated:** Yes (`client/e2e-journey/session-expiry.spec.ts` — change-password from device B signs out device A while B's rotated cookie keeps refreshing; mirror image of this journey)

### JRN-010 - Multi-tab work session survives the refresh race, cross-tab logout, and a genuinely revoked session
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #157 (single-flight refresh) / PR #169 (cross-tab sign-out broadcast, dead-session prompt) / PR #171 (30s refresh-replay grace window)
- **Preconditions:** One user with three app tabs open (T1, T2, T3), all authenticated; browser about to be restored from cold so the access token is memory-only and each tab must bootstrap from the shared `zbb_rt` cookie.
- **Steps:**
  1. Simulate a browser session-restore: reload T1 and T2 near-simultaneously so both race `POST /auth/refresh` with the same just-rotated cookie from the shared jar.
  2. Confirm both tabs end up signed in and usable.
  3. In T3, keep the tab idle past the access-token 15-minute lifetime, then focus it.
  4. In T1, use the account menu → **"Sign out"**.
  5. Observe T2 and T3.
  6. Re-open a fresh tab T4 to the app after the sign-out.
  7. Separately (new login), on tab T5 kill the session server-side (`POST /api/auth/logout` from a raw context sharing the cookie), then trigger any navigation in the still-open SPA tab.
- **Expected:**
  - CP1-CP2: one tab wins the race (200 + rotated cookie); the loser gets a **401 `Superseded` within the 30s grace window with NO Set-Cookie** — the shared cookie is NOT cleared and no family burn occurs (PR #171); the loser retries off the winner's fresh cookie and both tabs are signed in. Each tab issues exactly one `/auth/refresh` (single-flight under StrictMode, PR #157).
  - CP3: the idle tab's focus/visibility revalidation sees the lapsed token, silently refreshes, and re-arms — no prompt for a still-live session.
  - CP4-CP5: `logout()` revokes the refresh token + rotates the security stamp + broadcasts `'signed-out'` on `BroadcastChannel('zbb.auth')`; T2 and T3 receive the broadcast and clear state (receiver only acts `if (getToken())`, no loops), landing signed-out.
  - CP6: T4 cold-loads, its refresh 401s (token revoked) → lands on the landing/login, no zombie authed UI.
  - CP7: the genuinely-revoked SPA tab's next request 401s, silent refresh fails, and it bounces to `/login?reason=expired&returnUrl=…` — a real re-prompt, not a silent dead-end (interceptor exemption is a LIST, PR #169).
- **Automated:** Partial (`client/e2e-journey/concurrent-refresh.spec.ts` covers the same-cookie refresh race grace — origin/main only; `session-expiry.spec.ts` covers the revoked-tab prompt; cross-tab logout pinned in `AuthContext.test.tsx`)

---

## Multi-currency & role-scoped daily use

### JRN-011 - Multi-currency household daily use: per-account currency, blocked cross-currency transfer, foreign import, currency-following reports
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A household whose user prefers EUR (`comma-dot`). `multiCurrency` flag ON. Create two accounts: "Joint" (EUR, opening 1,250.00) and "UK Savings" (GBP, opening 800.00) — currency fixed at create.
- **Steps:**
  1. On `/accounts` confirm each card and its opening caption format in the account's OWN currency, and read the hero mixed-currency footnote.
  2. Attempt to edit "UK Savings" and look for a currency field.
  3. On `/transactions` open **"Record a transfer"**, set From "Joint" (EUR) → To "UK Savings" (GBP), amount 100.00, **"Record transfer"**.
  4. Record a same-currency GBP transaction against "UK Savings" and a EUR one against "Joint".
  5. Import a foreign-currency statement into "UK Savings".
  6. Open `/reports`, then change the **"Breakdown month"** to a month whose `baseCurrency` differs.
- **Expected:**
  - CP1: cards/opening/reconciliation format in `a.currency` (EUR vs GBP), NOT the preferred currency; the hero shows the raw cross-currency sum labelled with `preferredCurrency` + the footnote "Totals shown in {heroCurrency}; some accounts hold another currency." (ACCT-037).
  - CP2: the edit card shows the read-only note "Currency GBP — fixed once created." with no currency input (immutable by API shape).
  - CP3: the transfer is **rejected** with "Both accounts must use the same currency to transfer between them." and moves nothing (PR #167 / TRF-021).
  - CP4: each transaction's amount renders in its own stamped currency; account balances raw-sum amounts (no FX applied — ExchangeRate 1, deferred).
  - CP5: the import stamps each row's own currency; success sums group per currency joined with " + ".
  - CP6: the whole Reports page re-labels into the breakdown month's `baseCurrency` (`?? 'EUR'`), including annual totals — a deliberate currency-follows-breakdown behaviour (RPT-035).
- **Automated:** No

### JRN-012 - Role-scoped daily use: a Limited member works, then is downgraded to Read-only mid-session
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Shared household with an owner (Chris) and a member "Alex" whose login has role **Limited** and is linked to a budget person. Both signed in on separate contexts.
- **Steps:**
  1. As Alex, confirm the AppShell amber "limited access" banner and the nav (Transactions always shown; Import link absent).
  2. As Alex, record a transaction, split it across lines, and mark a bill **"Paid"** on `/`.
  3. As Alex, attempt structure edits: rename a group, add a line, add an account, and (via URL) open `/import`.
  4. As Chris, on `/people` change Alex's **"Access level"** select from "Limited" to "Read-only".
  5. As Alex, WITHOUT reloading, attempt to record another transaction; then reload.
  6. After reload, confirm Alex's affordances and banners.
- **Expected:**
  - CP1-CP2: Limited (`[AllowLimited]`) can create/split/assign transactions and toggle Paid; the amber banner reads "You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings."
  - CP3: structure edit controls are hidden client-side; server commands 403 with the role message; `/import` shows the "available to admins and the household owner" info card and the API 403s even preview (import is Admin+).
  - CP4: `PUT /access/members/{id}/role` succeeds (owner-only); role is server-resolved per request, so enforcement is immediate.
  - CP5: role changes are server-live but client-lazy — Alex's stale tab still shows entry affordances until reload, and the action now 403s ("Your access level (ReadOnly) does not permit this action."). After reload, `/auth/me` resolves ReadOnly.
  - CP6: post-reload Alex sees the "read-only access" banner, no entry affordances anywhere, static assigned-line text, and every command 403s server-side (RoleGating pattern).
- **Automated:** No (role gating pinned per-surface in `RoleGating.test.tsx` + `AuthorizationBehaviourTests`, not as a live-downgrade journey)

---

## Leaving, recovery & empty-state journeys

### JRN-013 - Leaving a household lands you in your own never-seeded budget (and re-invite works)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #170 (start-own/leave never seed samples) / PR #172 (empty ≠ balanced; jar-owning blank month over-budgeted) / PR #156 (accept lands you IN the household)
- **Preconditions:** "Jordan" is an Admin member of Chris's shared household via an accepted link (pure invitee, `ownsHousehold=false`). Jordan has attributed transactions in that household. Jordan owns no jars yet.
- **Steps:**
  1. As Jordan, `/account` → **"Leave this household"** → **"Leave household"** → **"Yes, leave"**.
  2. Observe the landing.
  3. Confirm no sample figures were seeded.
  4. On the create-month hero, **"Start a blank budget"** for a jar-less own household.
  5. Create a jar on `/jars`, then create a fresh month with **"Start a blank budget"** again for a later month.
  6. As Chris, confirm Jordan's attributed data is intact and re-invite Jordan.
  7. As Jordan, accept the new invite.
- **Expected:**
  - CP1-CP2: `POST /households/leave` hard-deletes Jordan's membership, materialises Jordan's own household **without samples**, and resets `ActiveOwnerId` → full reload to `/?left=1` with "You've left that household — … Nothing was deleted…".
  - CP3-CP4: Jordan's own household has zero months, zero jars; the blank month is a **truly empty** month → Hero shows "Plan your income, then give every euro a job", NOT the gold badge and NOT over-budgeted (PR #172).
  - CP5: after Jordan owns a jar, the next blank month is born **over-budgeted** (appended accrual-planned savings line vs 0 income) — "…over-budgeted — trim a line", never the empty prompt (PR #172 corollary / BUDG-028).
  - CP6-CP7: leave/revoke only removed the membership row (Active/Invited are the only statuses — no tombstone); the budget person + attributed data remain in Chris's household; a re-invite is a brand-new membership; accepting it lands Jordan back IN Chris's household (`/?joined=1`) with `SetActiveHouseholdAsync` (PR #156).
- **Automated:** Partial (`client/e2e-journey/invite.spec.ts` pins leave → own-household-without-samples; the jar-owner-over-budgeted and re-invite legs are unautomated)

### JRN-014 - Empty-account explorer: a brand-new opt-out user walks every feature surface and sees honest empty states
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Fresh registration with samples UNTICKED (completely empty account), all feature flags default ON, solo (1 member) household.
- **Steps:**
  1. On `/` read the create-month hero (writer variant).
  2. Visit `/transactions`, `/accounts`, `/jars`, `/reports`, `/people` in turn and read each empty state.
  3. Check the nav for the **Allocation** item; then deep-link `/allocation` by URL.
  4. Open the Getting-started checklist and confirm 0/4.
  5. Build the minimum: add one account, plan one income line, add one expense line to balance, log one transaction.
  6. Re-walk `/reports` and the checklist.
- **Expected:**
  - CP1: create-month hero "No budget for {Month} {Year} yet" with **"Start a blank budget"** + template grid, and NO **"Copy …"** button (first-ever month).
  - CP2: `/transactions` "No transactions yet"; `/accounts` "No accounts yet"; `/jars` "No jars yet"; `/reports` "No budget data yet" (empty, NOT sample figures — PR #170); `/people` shows the solo "You" row (People nav always visible when flag on).
  - CP3: the **Allocation** nav item is hidden (solo, isShared false); deep-linking `/allocation` renders the in-page **"Add people first"** EmptyState with an **"Add people"** button → `/people` (not a hard error).
  - CP4: checklist reads 0 of 4 with the four exact steps.
  - CP5-CP6: as data is created the checklist ticks off in order; `/reports` flips from the empty state to a one-point trend; balancing the month (income > 0 && remaining 0) shows the gold badge and completes checklist step 3 (PR #172).
- **Automated:** Partial (`client/e2e-journey/register.spec.ts` covers the empty landing + `/import` deep-load reload survival; RPT-027 pins the reports empty state; the multi-surface walk is unautomated as one journey)
