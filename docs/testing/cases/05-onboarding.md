# Onboarding (welcome dialog, spotlight tour, getting-started checklist)

**ID prefix:** ONBD | **Scope:** The first-run onboarding layer mounted once inside the authenticated app (`client/src/App.tsx:181-184` — `{isAuthenticated && !needsConsent && <Onboarding/>}`): the auto-opening "Welcome to AllotJar" dialog (`client/src/onboarding/WelcomeDialog.tsx`) with its owner vs joined-member copy branches; the 9-step SpotlightTour (`SpotlightTour.tsx` + `tourSteps.tsx`) with spotlight anchoring, centred-card fallback and linear navigation; the pinned "Getting started" checklist (`GettingStartedChecklist.tsx`) with its 4 auto-detected steps polled from `GET /budget/months`, `GET /budget/{y}/{m}` and `GET /transactions`; the per-user persistence record `localStorage['zbb.onboarding:{email}']` = `{v:1, welcomeSeen, tourDone, checklistDismissed}` (`OnboardingContext.tsx`); the "Replay welcome tour" action on `/help`; the accounts-first start (rule 81: no sample data; the Budget page's "Set up your budget" checklist — accounts, month, jar); and behavior for invite-created users landing in an existing household (joined copy, owner-only checklist). | **Out of scope:** the registration form itself, the "Start with sample figures" checkbox mechanics and the `includeSampleData` payload (02-registration-login.md); session expiry, cross-tab sign-out and refresh races (03-session-auth-lifecycle.md); the `/account` page including the Start-my-own-budget and Leave-household buttons themselves (04-account-preferences.md and the households/people case file — only their *onboarding after-effects* live here); ConsentModal content and the consent POST (households/people file — only the onboarding-vs-consent mounting rule lives here); dashboard budgeting behaviors, the create-month hero, IsBalanced hero badge and PR #172 dashboard cases (budget-months case file — only the *checklist's* balanced detection lives here); the Help page's topic cards and analytics consent controls (routing/shell and analytics files); GA event delivery/redaction (analytics file — expected `track()` calls are noted but not asserted here); dark/responsive/a11y sweeps (cross-cutting file — `client/e2e/a11y.spec.ts` already axe-scans the welcome dialog, every tour step and the checklist region in both themes). **Do not test for:** an `onboarding_step_completed` analytics event (defined in `events.ts` but never fired — dead code); any server-side persistence of onboarding progress (there is none — it is purely per-browser localStorage); a "resume tour at step N" feature (replay always restarts at the welcome).

**Test data setup:** (a) Fresh browser profile per case unless stated (empty localStorage — the onboarding record is per-browser); locale `en-GB`, desktop viewport ≥ 900 px unless stated. (b) Owner login `onbd-owner@example.test`, registered through `/login?register=1` with defaults (sample checkbox UNTICKED, currency EUR → noun "euro"), password random `Aa1-<uuid>` shape (HIBP rejects fixed common passwords). (c) Sample-start login `onbd-sample@example.test`, registered identically but with "Start with sample figures to explore…" TICKED — its seeded current month (from `BudgetSeeder.SeedDefaultMonthAsync`): income "Take-home Pay" 3,000.00; planned lines Housing (Rent 1,100.00, Utilities 180.00), Transport (Fuel 120.00, Public Transport 60.00), Food (Groceries 400.00, Dining Out 90.00), Savings ("Emergency Fund" 250.00 backed by a real jar) — planned total 2,200.00, Remaining to budget **800.00** (deliberately unbalanced), zero transactions. (d) Shared household owned by `onbd-inviter@example.test` (registered WITH samples so the joined budget has content) with a pending invite link for `onbd-member@example.test`. (e) Local stack (API :5099, `ASPNETCORE_ENVIRONMENT=Development`) or staging (staging.allotjar.com). (f) Where a case inspects localStorage, key names are exact: `zbb.onboarding:{email}`, `zbb.email`.

## Welcome dialog — first-run trigger & content

### ONBD-001 - Welcome dialog auto-opens once for a brand-new owner with the exact owner copy and controls
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fresh browser; `onbd-owner@example.test` just completed registration (default empty account) and landed authenticated on `/`.
- **Steps:**
  1. Observe the screen immediately after landing on the dashboard.
  2. Read the dialog content top to bottom without clicking anything.
- **Expected:**
  - A focus-trapped modal (`role="dialog" aria-modal="true"`) opens over a dimmed backdrop, z-order above the page but below any consent prompt.
  - Jar logo, heading "Welcome to AllotJar", body copy (owner branch): "AllotJar is a **zero-based** budget — every month you give **every euro a job** before you spend it. Setting up your first month takes a few minutes. Want a quick 60-second tour to see how it fits together?"
  - Three check-bulleted lines: "Plan a month and assign your income" / "Track real spending against each line" / "Save toward goals with jars".
  - Buttons: secondary "Skip for now" and primary "Take the tour"; a close button `aria-label="Close"` top-right.
  - Focus is inside the dialog (first focusable element); Tab cycles within the dialog only.
  - `localStorage['zbb.onboarding:onbd-owner@example.test']` does not yet exist (nothing persisted until an action is taken).
- **Automated:** Partial (client/src/onboarding/Onboarding.test.tsx — auto-open for a brand-new user; client/e2e/a11y.spec.ts — dialog axe-scanned both themes; exact copy/bullets unasserted)

### ONBD-002 - "Skip for now" dismisses the welcome, reveals the checklist and persists welcomeSeen
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Welcome dialog open as in ONBD-001.
- **Steps:**
  1. Click "Skip for now".
  2. Inspect the bottom-right corner of the page.
  3. Inspect `localStorage['zbb.onboarding:onbd-owner@example.test']`.
- **Expected:**
  - Dialog closes; no tour starts; the "Getting started" checklist panel (section `aria-label="Getting started"`) appears pinned bottom-right.
  - Stored record is `{"v":1,"welcomeSeen":true,"tourDone":false,"checklistDismissed":false}`.
  - (When analytics is live, an `onboarding_dismissed {context:'welcome'}` event fires — asserted in the analytics file.)
- **Automated:** Yes (client/src/onboarding/Onboarding.test.tsx — "skips cleanly, shows the checklist, and never auto-opens again")

### ONBD-003 - Close X, backdrop click and Escape all count as a skip; focus is restored
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Welcome dialog open as in ONBD-001. Run three variants (fresh profile or cleared `zbb.onboarding:*` key each time).
- **Steps:**
  1. Variant A: click the close button (`aria-label="Close"`).
  2. Variant B: click the dimmed backdrop outside the dialog.
  3. Variant C: press Escape while focus is inside the dialog.
  4. After each, inspect the checklist and the localStorage record; note where keyboard focus landed (variant C).
- **Expected:**
  - All three variants behave identically to "Skip for now": dialog closes, checklist appears, record persists `welcomeSeen:true` (tour NOT marked done).
  - Focus returns to the element focused before the dialog opened (`useDialogA11y` restore).
  - No variant leaves a stuck backdrop or blocks interaction with the page.
- **Automated:** No

### ONBD-004 - Currency noun flows through welcome, tour step 3, checklist step 3 and the all-done line
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** A user registered with currency USD (fresh profile); a second fresh user whose currency is a valid ISO code outside the noun map (e.g. ISK), set via API `PUT /auth/preferences` while the budget is still empty (once it holds an account, month or transaction the currency is locked — PREF-042; a blank value is stored as EUR). The noun comes from the **budget currency** (`/auth/me` `budgetCurrency`), which for a new household is the chosen currency.
- **Steps:**
  1. As the USD user, read the welcome body, then take the tour to step 3, then skip to the checklist and read step 3's label.
  2. As the ISK user, repeat.
- **Expected:**
  - USD: "give **every dollar a job**" in the welcome body; tour step 3 titled "Give every dollar a job"; checklist step 3 labeled "Give every dollar a job"; all-done message (when reached) "All set — every dollar has a job! 🎉".
  - ISK (no noun mapped): the noun falls back to "unit" ("give every unit a job") — no crash, no empty string.
  - Tour step count stays 9 regardless of noun.
- **Automated:** Partial (client/src/lib/money.test.ts — `currencyNoun` mapping incl. `unit` fallback; the onboarding surfaces themselves unasserted)

### ONBD-005 - Invite-created user sees the joined-member welcome copy
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `onbd-member@example.test` just redeemed an invite link (`/accept-invite?code=…`, new login, terms accepted) and landed on `/?joined=1` inside `onbd-inviter@example.test`'s household. Fresh browser.
- **Steps:**
  1. Dismiss nothing; read the welcome dialog that auto-opens.
- **Expected:**
  - Heading is still "Welcome to AllotJar" but the body uses the joined branch: "You've joined a shared household budget. AllotJar is **zero-based** — the household gives **every euro a job** before spending it, and you're now part of that plan. Want a quick 60-second tour to see how it fits together?"
  - Bullets are the member set: "See the month's plan and where money goes" / "Record spending as it happens" / "Watch jars fill toward shared goals".
  - Buttons identical to the owner variant ("Skip for now" / "Take the tour").
  - The `?joined=1` greeting banner in the AppShell coexists behind the dialog and is readable after dismissal.
- **Automated:** No

### ONBD-006 - Onboarding never mounts under the blocking consent prompt
- **Priority:** P1
- **Type:** Regression
- **Origin:** routing-shell gotcha — onboarding is not mounted while `needsConsent` (App.tsx:183) and ConsentModal (z-70) sits above onboarding (z-60); a focus-trapped welcome must never be unreachable under the consent prompt
- **Preconditions:** A login with `needsConsent=true` from `/auth/me` (owner-created member password or legacy pre-terms account) that has never seen onboarding, signing in on a fresh browser.
- **Steps:**
  1. Sign in; observe which dialog is present.
  2. Attempt to Tab around — confirm only the consent dialog's controls are reachable.
  3. Click "I agree".
  4. Observe what appears next.
- **Expected:**
  - Step 1-2: only the ConsentModal ("One thing before you start") renders; the welcome dialog is NOT in the DOM at all (not merely hidden underneath).
  - Step 3-4: after consent resolves (`needsConsent=false`), the onboarding layer mounts and the welcome dialog auto-opens normally (first time for this user), fully focusable.
- **Automated:** Partial (client/src/components/ConsentModal.test.tsx — consent blocks until agreed; the onboarding-suppression half is unasserted)

## Spotlight tour

### ONBD-007 - Full 9-step tour walk with exact titles, spotlights and Finish → checklist
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `onbd-sample@example.test` (sample data, so every anchor incl. the dashboard hero exists), welcome dialog open, on `/`, desktop ≥ 900 px, all feature flags on.
- **Steps:**
  1. Click "Take the tour".
  2. Click "Next" through every step, reading the header, title and spotlight each time.
  3. On the last step click "Finish".
- **Expected:**
  - Header reads "Step {n} of 9"; 9 progress dots with the current one elongated.
  - Steps in order (title → spotlighted element): 1 "Find your way around" → sidebar; 2 "Pick the month you're planning" → month top bar; 3 "Give every euro a job" → the dashboard hero remaining banner; 4 "Track what you actually spend" → Transactions nav item; 5 "Know where your money sits" → Accounts nav item; 6 "Save up with jars" → Jars nav item; 7 "See the bigger picture" → Reports nav item; 8 "Sharing money with someone?" → People nav item; 9 "You're all set" → centred card (no spotlight).
  - Spotlighted element shows a ring cut-out with the rest of the page dimmed; the tooltip card sits adjacent (below/above/side) without covering the spotlight.
  - Step 9 body mentions the pinned "Getting started" checklist and replaying from Help.
  - "Finish" (replaces "Next" on step 9 only) closes the tour; the checklist appears; record persists `{welcomeSeen:true, tourDone:true, checklistDismissed:false}`.
  - Focus moves to the step heading on every step change (screen-reader announcement).
- **Automated:** Partial (client/src/onboarding/Onboarding.test.tsx — welcome→tour→checklist walk with step titles in jsdom; client/e2e/a11y.spec.ts — every step axe-scanned through Finish; spotlight geometry/anchoring unasserted)

### ONBD-008 - Back/Next navigation is linear and clamped; Back hidden on step 1
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Tour open at step 1 (any account).
- **Steps:**
  1. On step 1, look for a "Back" button.
  2. Click "Next" twice, then "Back" twice.
  3. From step 1, click "Back"-equivalent (none) then advance to step 9 and confirm no "Next" remains.
- **Expected:**
  - Step 1 has no "Back" button (only "Skip tour" and "Next"); "Back" appears from step 2 onward.
  - Next/Back move exactly one step; returning to step 1 re-renders it identically (dots update).
  - On step 9 the primary button is "Finish"; there is no way to advance past it. Step index never exceeds 8 or goes below 0.
- **Automated:** No

### ONBD-009 - "Skip tour" mid-way ends the tour cleanly and it never auto-resumes
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Tour open at step 4 of 9, `onbd-owner@example.test`.
- **Steps:**
  1. Click "Skip tour".
  2. Inspect the page and localStorage.
  3. Reload the page and sign-in state.
- **Expected:**
  - Tour closes immediately (no confirmation); the "Getting started" checklist appears.
  - Record persists `{welcomeSeen:true, tourDone:true, …}` — skipping marks the tour done; there is deliberately no "resume at step 4" state.
  - After reload: no welcome, no tour; checklist still present.
- **Automated:** No

### ONBD-010 - Escape ends the tour from any step
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Tour open at step 2.
- **Steps:**
  1. Press Escape.
- **Expected:**
  - Identical outcome to "Skip tour" (ONBD-009): tour closes, checklist appears, `tourDone:true` persisted, focus restored to the pre-tour element.
- **Automated:** No

### ONBD-011 - Missing or off-screen anchors fall back to a centred card (mobile, flag-off, no month, non-dashboard page)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Four variants: (A) viewport 375×812 (mobile top bar, sidebar hidden); (B) `accounts` feature flag off server-side; (C) `onbd-owner@example.test` with NO budget month yet (empty default start); (D) welcome taken from a deep-loaded non-dashboard page, e.g. `/transactions`.
- **Steps:**
  1. Start the tour in each variant and step to the affected step(s): A → step 1 (sidebar) and nav-item steps; B → step 5 "Know where your money sits"; C and D → step 3 "Give every euro a job".
- **Expected:**
  - In every variant the affected step renders as a centred card over a fully dimmed backdrop — same title/body/buttons, no spotlight ring, no crash, no skipped step; the tour stays 9 steps.
  - Unaffected steps still spotlight normally (e.g. variant C steps 1-2 anchor fine).
  - Variant B: the step still describes Accounts even though the nav item is absent (copy is static).
- **Automated:** No

### ONBD-012 - The dimmed page is inert during the tour
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Tour open at step 4 (Transactions nav item spotlighted), sample account.
- **Steps:**
  1. Click the spotlighted "Transactions" nav item through the overlay.
  2. Click elsewhere on the dimmed page (e.g. a budget line).
- **Expected:**
  - Neither click reaches the page: no navigation happens, no control activates — the full-viewport overlay catches all clicks while the tour is open.
  - The tour dialog itself stays interactive (Skip tour / Back / Next).
- **Automated:** No

### ONBD-013 - Spotlight re-measures on resize and scroll
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Tour open at step 1 (sidebar spotlighted), desktop.
- **Steps:**
  1. Resize the window narrower (still ≥ 900 px), then below 900 px, then back.
  2. On a step anchored to an in-page element (step 3 on a sample account), scroll the page.
- **Expected:**
  - The spotlight ring and tooltip follow the target's new position on every resize/scroll frame (no stale ring floating over empty space).
  - Crossing below 900 px (sidebar unmounts/hides) degrades that step to the centred card; growing back restores the spotlight.
- **Automated:** No

## Getting-started checklist — rendering & progress detection

### ONBD-014 - Initial checklist for an empty account: 0 of 4 with exact steps, hints and links
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `onbd-owner@example.test` (empty account), welcome skipped, on `/`.
- **Steps:**
  1. Read the checklist panel bottom-right.
  2. Hover/click each step row and note its link target.
- **Expected:**
  - Header "Getting started" + "0 of 4 done"; progress bar `role="progressbar"` `aria-label="Onboarding progress"` with `aria-valuenow=0`, `aria-valuemin=0`, `aria-valuemax=4`, visually 0% filled.
  - Steps in order (label / hint / link): 1 "Create your first month" / "Start blank or pick a template — later months can copy the previous one." / `/`; 2 "Plan your income" / "Add what you expect to earn this month." / `/`; 3 "Give every euro a job" / "Assign it all until Remaining reaches zero." / `/`; 4 "Log your first transaction" / "Record real spending and assign it to a line." / `/transactions`.
  - Every circle is empty (sr-only "To do:"); no strikethrough.
  - Header buttons present: `aria-label="Collapse getting started"` (chevron) and `aria-label="Dismiss getting started"` (X).
- **Automated:** Partial (client/src/onboarding/Onboarding.test.tsx — region renders after skip; client/e2e/a11y.spec.ts — region axe-scanned; labels/links/progressbar values unasserted)

### ONBD-015 - Steps tick off automatically as the first month is built, ending in the all-done state
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** ONBD-014 state (0 of 4). Current calendar month = July 2026.
- **Steps:**
  1. On `/`, click "Start a blank budget"; observe the checklist (it refreshes on navigation/focus — if needed, click any nav item and return).
  2. In the Income group, add an income source with planned 2,500.00; observe.
  3. Add an expense group/line and assign planned amounts until "Remaining to budget" shows exactly 0.00; observe.
  4. Go to `/transactions` via checklist step 4's link and add a transaction (e.g. Groceries 45.30 assigned to a line); observe.
- **Expected:**
  - After step 1: "Create your first month" ticks (filled circle, sr-only "Done:", label struck through) — "1 of 4 done", bar 25%.
  - After step 2: "Plan your income" ticks — "2 of 4 done" (detection: `totalIncome > 0` on `GET /budget/2026/7`).
  - After step 3: "Give every euro a job" ticks — "3 of 4 done" (detection: income > 0 AND remaining === 0).
  - After step 4: "Log your first transaction" ticks — "4 of 4 done", bar 100%, and a footer appears: "All set — every euro has a job! 🎉" with button "Hide this checklist" which dismisses it (same persistence as the X).
  - Ticks appear without a manual reload (progress re-polls on every route change and window focus).
- **Automated:** No

### ONBD-016 - A month with zero income never ticks "Give every euro a job"
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #172 — `IsBalanced` requires `TotalIncome > 0`; an empty 0/0 month must not read as balanced
- **Preconditions:** `onbd-owner@example.test` with a blank current month created (Income group only, no amounts): totalIncome = 0, remaining = 0.
- **Steps:**
  1. Read the checklist.
- **Expected:**
  - "Create your first month" is ticked; "Plan your income" is NOT ticked; "Give every euro a job" is NOT ticked even though remaining is exactly 0 — "1 of 4 done".
  - (The dashboard hero simultaneously shows the "Plan your income…" prompt, not the gold badge — asserted in the budget-months file.)
- **Automated:** Partial (client/src/budgetModel.test.ts — empty month not balanced; client/src/onboarding/GettingStartedChecklist.tsx wiring `income > 0 && remaining === 0` has no direct test)

### ONBD-017 - Balanced detection boundary: exactly zero ticks, one cent either side does not
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Current month with income 1,000.00 and one expense line.
- **Steps:**
  1. Set the expense planned to 999.99 (remaining +0.01); focus away and read the checklist.
  2. Set it to 1,000.01 (remaining −0.01, over-budgeted); read the checklist.
  3. Set it to exactly 1,000.00 (remaining 0.00); read the checklist.
- **Expected:**
  - Steps 1 and 2: "Give every euro a job" stays unticked (remaining ≠ 0; over-budgeted is not balanced).
  - Step 3: it ticks. Comparison is on integer minor units — no float tolerance window.
  - A jar-owning household whose blank month landed over-budgeted via accrual-planned savings lines (PR #172 side effect) therefore shows step 3 unticked until trimmed to zero.
- **Automated:** No

### ONBD-018 - Collapse is session-only; Dismiss is persisted
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Checklist visible at "1 of 4 done".
- **Steps:**
  1. Click the chevron (`aria-label="Collapse getting started"`).
  2. Click the resulting pill.
  3. Reload the page; observe the checklist.
  4. Click the X (`aria-label="Dismiss getting started"`).
  5. Reload again; also sign out and back in.
- **Expected:**
  - Step 1: panel collapses to a bottom-right pill "Getting started · 1/4".
  - Step 2: pill expands back to the full panel (collapse state is component-local).
  - Step 3: after reload the checklist is OPEN again (collapse was not persisted).
  - Step 4: panel disappears entirely; record persists `checklistDismissed:true`.
  - Step 5: checklist stays hidden across reload and re-login; the welcome does not reappear either.
- **Automated:** Partial (client/src/onboarding/Onboarding.test.tsx — dismissal hides + persists `checklistDismissed`; collapse/pill behavior unasserted)

### ONBD-019 - Progress refreshes on route change and window focus (cross-tab/second-client edits picked up)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Checklist visible at "1 of 4 done"; same user signed in on a second tab or API client.
- **Steps:**
  1. In the second tab, add an income line of 2,000.00 to the current month.
  2. In the first tab, without reloading, click "Transactions" in the nav then back to "Budget" (route change) — or simply refocus the first tab's window.
  3. Watch the network panel while doing so.
- **Expected:**
  - On the route change (and again on window focus) the checklist re-issues its 3 GETs (`/budget/months`, `/budget/{y}/{m}`, `/transactions`) and "Plan your income" ticks to "2 of 4 done" without a reload.
  - No visible flicker to 0/4 while refreshing (previous state is kept until responses land).
- **Automated:** No

### ONBD-020 - Month rollover with the tab left open: progress stays pinned to the load-time month until reload
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Checklist visible late on the last day of a month (e.g. 31 July 23:55), current July month balanced (steps 1-3 ticked). Simulate by adjusting the system clock or a long-lived tab.
- **Steps:**
  1. Keep the SPA open (no reload) past midnight into 1 August.
  2. Trigger a refresh (focus the window) and read the checklist.
  3. Hard-reload the page and read it again.
- **Expected:**
  - Step 2: the checklist still evaluates JULY (`const now` is captured at module load — `GettingStartedChecklist.tsx:19`), so steps 1-3 remain ticked even though August has no month yet. Document as current behavior, not a failure.
  - Step 3: after the reload the checklist evaluates August — "Create your first month"/"Plan your income"/"Give every euro a job" untick (August month absent), "Log your first transaction" stays ticked (transactions list is not month-scoped).
- **Automated:** No

### ONBD-021 - Checklist renders only for the user's OWN household
- **Priority:** P1
- **Type:** Regression
- **Origin:** routing-shell gotcha — checklist is owner-oriented; a joined household would show it pre-ticked or nagging about someone else's budget (GettingStartedChecklist.tsx:74-75)
- **Preconditions:** `onbd-member@example.test` belongs to two households: the joined one (inviter's, active) and their own (started via "Start my own budget"). Welcome already skipped; checklist never dismissed.
- **Steps:**
  1. While viewing the JOINED household, look for the checklist on `/` and `/transactions`.
  2. Via the account menu, switch to the own household (full reload).
  3. Look again.
- **Expected:**
  - Step 1: no checklist anywhere — not collapsed, absent from the DOM — even though `checklistDismissed` is false.
  - Step 3: checklist renders for the own household, with progress evaluated against the OWN household's data (0 of 4 for a fresh own budget).
- **Automated:** No

### ONBD-022 - Checklist polling failures are silent and safe
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** `onbd-owner@example.test` with no month for the current calendar month (the `/budget/{y}/{m}` GET returns 404); optionally block `/transactions` at the network layer.
- **Steps:**
  1. Open `/` with the checklist visible and devtools network open.
  2. Observe the UI while the 404/failed requests occur.
- **Expected:**
  - The current-month 404 sets "Plan your income" and "Give every euro a job" to unticked (explicit catch); failures on `/budget/months` or `/transactions` leave those steps at their previous value.
  - No error toast, no console-crash, no blank checklist — the panel keeps rendering with whatever progress it has.
- **Automated:** Partial (client/src/onboarding/Onboarding.test.tsx — runs with the current-month GET rejecting 404 and the checklist rendering; the blocked-endpoint variants unasserted)

## Persistence, re-trigger & multi-user/device

### ONBD-023 - Logout and sign back in on the same browser: onboarding does not re-trigger
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `onbd-owner@example.test` has skipped the welcome and dismissed the checklist on this browser.
- **Steps:**
  1. Sign out via the account menu.
  2. Sign back in as the same user.
- **Expected:**
  - No welcome dialog, no tour, no checklist — the record `zbb.onboarding:onbd-owner@example.test` survives logout (sign-out clears identity keys `zbb.email`/`zbb.role`/`zbb.displayName` but NOT the onboarding record).
  - Dashboard is immediately interactive.
- **Automated:** Partial (client/src/onboarding/Onboarding.test.tsx — fresh mount for the same user does not re-open the welcome; a real logout/login cycle unasserted)

### ONBD-024 - Persistence is per-user AND per-browser: new device re-welcomes; two users on one device stay independent
- **Priority:** P2
- **Type:** Regression
- **Origin:** routing-shell gotcha — key is `zbb.onboarding:{email}`, so a returning user on a new device sees the welcome again and each user on a shared device gets their own record
- **Preconditions:** `onbd-owner@example.test` has completed onboarding on browser A. Browser B is a fresh profile. A second login `onbd-second@example.test` exists and has never onboarded.
- **Steps:**
  1. Sign in as `onbd-owner@example.test` on browser B.
  2. Back on browser A, sign out and sign in as `onbd-second@example.test`.
  3. Sign out and sign in as `onbd-owner@example.test` again on browser A.
- **Expected:**
  - Step 1: the welcome auto-opens on browser B (no server-side onboarding state — per-browser by design).
  - Step 2: the welcome auto-opens for `onbd-second` on browser A (own key, unaffected by the first user's record).
  - Step 3: NO welcome for `onbd-owner` on browser A (their record intact); localStorage now holds two `zbb.onboarding:*` keys side by side.
- **Automated:** No

### ONBD-025 - Malformed or partial onboarding records degrade to defaults without crashing
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** Signed in as `onbd-owner@example.test`. Three variants set via devtools before a reload: (A) `zbb.onboarding:onbd-owner@example.test` = `not-json{{{`; (B) = `{"v":1,"welcomeSeen":true}` (partial); (C) key deleted entirely.
- **Steps:**
  1. Reload the app in each variant and observe.
- **Expected:**
  - A: unparseable JSON is swallowed — defaults apply, welcome auto-opens, no error UI/console crash; the next action overwrites the key with a valid record.
  - B: missing fields merge with defaults — welcome stays closed (`welcomeSeen:true`), checklist visible (`checklistDismissed` defaults false).
  - C: full first-run behavior (welcome opens).
- **Automated:** No

### ONBD-026 - Switching households does not reset onboarding
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `onbd-member@example.test` (two households, welcome seen, checklist not dismissed) viewing their own household.
- **Steps:**
  1. Via the account menu "Household" section, switch to the joined household (full page reload).
  2. Switch back to the own household.
- **Expected:**
  - Neither switch re-opens the welcome or the tour — the record key is email-based and the email did not change.
  - Checklist visibility flips with the active household per ONBD-021 (hidden on joined, shown on own) while `checklistDismissed` stays false throughout.
- **Automated:** No

### ONBD-027 - "Replay welcome tour" from Help re-runs the flow without re-arming auto-open
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `onbd-owner@example.test` with onboarding fully done and the checklist dismissed (`{welcomeSeen:true, tourDone:true, checklistDismissed:true}`).
- **Steps:**
  1. Open `/help`; click the header action button "Replay welcome tour".
  2. In the reopened welcome, click "Take the tour", advance one step, then "Skip tour".
  3. Inspect the checklist and localStorage.
  4. Reload the page.
- **Expected:**
  - Step 1: the welcome dialog reopens immediately (owner copy) and the record becomes `{welcomeSeen:true, tourDone:false, checklistDismissed:false}` — the checklist is restored by the replay itself.
  - Step 2-3: skipping re-persists `tourDone:true`; the checklist shows bottom-right with live progress (likely 4/4 or partial per real data — including the all-done footer if complete).
  - Step 4: after reload NOTHING auto-opens — `welcomeSeen` was kept true, so replay never re-arms the first-run trigger.
  - (Fires `tour_replayed` when analytics is live.)
- **Automated:** Partial (client/src/pages/HelpPage.test.tsx — the "Replay welcome tour" button exists; the replay behavior itself unasserted)

## Empty-account vs sample-budget start (PR #170)

### ONBD-028 - Default (empty) registration: onboarding sits over the create-month hero and the checklist starts at 0/4
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #170 — sample figures are opt-in; the empty default makes the create-month hero the standard first-run landing
- **Preconditions:** Fresh browser; register `onbd-owner@example.test` with the sample checkbox UNTICKED.
- **Steps:**
  1. Land on `/`; note the welcome dialog and what is visible behind it.
  2. Click "Skip for now"; read the dashboard and the checklist.
  3. Click "Take the tour" via Help replay (or on a second fresh account, take the tour directly) and advance to step 3.
- **Expected:**
  - Behind the welcome: the create-month hero ("No budget for July 2026 yet" with "Start a blank budget" and template options) — no sample groups, no "Take-home Pay", no Emergency Fund jar, zero transactions.
  - Checklist reads "0 of 4 done" — nothing pre-ticked.
  - Tour step 3 ("Give every euro a job") renders as a centred card — the remaining-banner anchor does not exist yet (no month). Steps 1-2 and 4-8 spotlight normally.
- **Automated:** Partial (client/e2e-journey/register.spec.ts — default registration lands on the EMPTY budget with the create-month hero, but with onboarding suppressed via `suppressOnboarding()`; the onboarding-over-empty combination unasserted)

### ONBD-029 - Opted-in sample start: checklist pre-ticks exactly 2 of 4 and the tour spotlights real data
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #170 — sample month seeds income 3,000.00 over 2,200.00 planned, deliberately leaving 800.00 to assign
- **Preconditions:** Fresh browser; register `onbd-sample@example.test` with "Start with sample figures to explore…" TICKED.
- **Steps:**
  1. Land on `/`; skip the welcome (owner copy — sample data does not change the copy branch).
  2. Read the checklist state and each step's tick.
  3. Replay the tour from Help and advance to step 3.
- **Expected:**
  - Checklist reads "2 of 4 done": "Create your first month" ✓ (seeded month exists), "Plan your income" ✓ (3,000.00 > 0), "Give every euro a job" ✗ (remaining 800.00 ≠ 0 — the seed is intentionally unbalanced so the user finishes the job), "Log your first transaction" ✗ (no seeded transactions).
  - Tour step 3 spotlights the real hero showing 800.00 still to assign (anchor exists).
  - Assigning the remaining 800.00 (e.g. raise Groceries to 1,200.00) ticks step 3 → "3 of 4 done".
- **Automated:** Partial (client/e2e-journey/register.spec.ts — sample opt-in lands on the seeded budget incl. the Emergency Fund jar, onboarding suppressed; checklist tick-state unasserted)

### ONBD-030 - Invitee who starts their own budget (or leaves) gets a fresh, never-seeded onboarding surface
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #170 — `households/start-own` and `households/leave` always pass `seedSampleBudget:false`; a background path must never inject sample figures
- **Preconditions:** `onbd-member@example.test` created via invite (fresh browser, welcome shown with joined copy per ONBD-005 and skipped); currently inside the inviter's household; no own household yet.
- **Steps:**
  1. Confirm no checklist is visible (joined household — ONBD-021).
  2. Go to `/account`, click "Start my own budget" and wait for the full reload landing on `/?started=1`.
  3. Read the dashboard, greeting, welcome state and checklist.
  4. (Variant: from a joined-only login, use "Leave household" → "Yes, leave" instead and land on `/?left=1`.)
- **Expected:**
  - Step 3: the "started" greeting banner shows; NO welcome dialog re-opens (record persists across the reload — email unchanged); the checklist NOW appears at "0 of 4 done" over the create-month hero — the own household is completely empty: no sample month, no Emergency Fund jar, regardless of whether the INVITER's household was sample-seeded.
  - Step 4 variant: identical empty-own-household landing with the "left that household" greeting — leaving never seeds sample data and never re-triggers the welcome.
- **Automated:** Partial (client/e2e-journey/invite.spec.ts — the leave leg asserts the `?left` banner + create-month hero with NO sample figures, onboarding suppressed; tests/AllotJar.Application.Tests/Application/HouseholdBootstrapTests.cs — no-sample bootstrap creates no budget; the checklist/welcome behavior on this path unasserted)

## Gap-fill additions

### ONBD-031 - Checklist regresses when the budget is torn back down (undo lifecycle, not a stuck high-water mark)
- **Priority:** P1
- **Type:** Regression
- **Origin:** The checklist is a pure live recompute from the user's own data on every route change / window focus (`GettingStartedChecklist.tsx:34-69`, ONBD-019), so removing data must UN-tick steps exactly as adding it ticked them (ONBD-015) — the panel must not ratchet forward and stick on its high-water mark. Exercises the PR #172 `income > 0 && remaining === 0` guard (ONBD-016) and CAT-042 line/income-source deletion in reverse; the mirror of the build-only ONBD-015 and the live-edit CMB-043.
- **Preconditions:** `onbd-owner@example.test`, own household (checklist rendered — ONBD-021), current calendar month = July 2026, checklist visible and fully built to **"4 of 4 done"** per ONBD-015 (month created; income "Take-home Pay" 2,500.00; expenses assigned so "Remaining to budget" = 0.00; one transaction logged and assigned to a line). The all-done footer "All set — every euro has a job! 🎉" is showing. Each teardown leg below is read AFTER a checklist refresh — click any nav item and return, or refocus the window; the panel re-polls only on route change / window focus, never on the in-place mutation itself (same cadence as the build direction, ONBD-015/019).
- **Steps:**
  1. In the transactions register, delete the only transaction (✕ per the transactions case, no confirm); refresh the checklist and read it.
  2. Back on `/`, delete an expense line (✕ "Delete {name}", CAT-042) — or lower its planned — so "Remaining to budget" is no longer 0.00 while income is untouched; refresh and read.
  3. Zero the planned income to 0.00, or delete the income line via its ✕ ("Delete income source", CAT-042); refresh and read.
  4. Read the final checklist state, progressbar (`aria-valuenow`) and footer.
- **Expected:**
  - After step 1: `GET /transactions` now returns `[]` → step 4 "Log your first transaction" un-ticks — "3 of 4 done", bar 75%, `aria-valuenow=3`. The all-done footer (heading + "Hide this checklist" button) disappears the instant `doneCount < 4` (`allDone` false).
  - After step 2: `remainingToBudget(vm) !== 0` with income still > 0 → step 3 "Give every euro a job" un-ticks — "2 of 4 done", bar 50%, `aria-valuenow=2`. This is the ONBD-015/CMB-043 balanced tick run in reverse.
  - After step 3: `totalIncome(vm)` drops to 0 → step 2 "Plan your income" un-ticks; step 3 STAYS un-ticked — the PR #172 `income > 0 && remaining === 0` guard means a zero-income month never re-ticks step 3 even though Remaining is once again technically 0 with nothing planned (ONBD-016) — "1 of 4 done", bar 25%, `aria-valuenow=1`.
  - Final floor: step 1 "Create your first month" stays ✓ and the panel settles at **"1 of 4 done", NOT 0/4** — the month itself still exists and `/budget/months` still returns it; there is no delete-month action anywhere in the app (only line/category/transaction deletes), so `monthExists` cannot fall away by user action within the same calendar month (that step only un-ticks via the module-load month rollover + reload of ONBD-020, out of scope here). The point of the case is that the checklist genuinely descends from 4/4 to 1/4 rather than remaining pinned at its 4/4 high-water mark.
  - Across all three legs `doneCount`, `aria-valuenow` and the bar width strictly DECREASE (no ratchet, no stale high-water mark); no step stays ticked once its underlying data is gone. The detection re-derives on every refresh — step 2 `hasIncome = totalIncome(vm) > 0`; step 3 `balanced = income > 0 && remainingToBudget(vm) === 0`; step 4 `hasTransaction = /transactions` non-empty — so removal flips each false exactly as addition flipped it true (`GettingStartedChecklist.tsx:38-55`).
  - No flicker down through a spuriously-lower count while a refresh is in flight: `refresh()` merges partial results into the previous state (`setProgress((prev) => ({ ...prev, ...p }))`), so each step holds its prior value until its own GET resolves (ONBD-019). A bare in-place delete with no navigation leaves the stale tick until the next route change / focus.
- **Automated:** Partial (client/src/budgetModel.test.ts — "removing an income line lowers the pool" drops `totalIncome` to 0 and "an empty month … is not balanced" keeps `isBalanced` false, i.e. the exact selectors the checklist reads regress correctly when data is removed; the checklist component's live down-tick on route-change/focus refresh, and the all-done-footer teardown, are unasserted — Onboarding.test.tsx only exercises the build and 404 directions)

## Accounts-first start (rule 81)

Sample data no longer exists: the register form has no "Start with sample figures" checkbox and `RegisterRequest` has no `includeSampleData`. ONBD-029 and every "sample account" precondition above are superseded; seed those states through the UI (add accounts, create the month, add a jar).

### ONBD-081 - The Budget page's "Set up your budget" checklist tracks accounts, month and jar
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fresh owner, no accounts, no months, no jars.
- **Steps:**
  1. Land on `/`. 2. Add an account. 3. Create the month. 4. Add a jar from that account.
- **Expected:** A "Set up your budget" card lists three steps with their done state: "Add your accounts with their opening balances" (link `/accounts`), "Create this month's budget" (opens the create-month flow), "Add a jar from an account" (opens the jar form; disabled until an account exists). Each step ticks as it is completed; the card disappears once all three are done.
- **Automated:** Yes (DashboardPage tests)
