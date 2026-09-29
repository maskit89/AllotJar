# Concurrency & multi-user

**ID prefix:** CONC | **Scope:** The seams that only exist when two logins share one household — or one login rides two tabs/devices — and their actions collide in time: concurrent month creation, simultaneous edits to the same budget line, a transaction added against a line/account the other user is deleting, invite-accept while the owner edits members, member removal or role change mid-session, allocation and import commit races, token-refresh races (cold-load multi-tab, StrictMode double-mount single-flight, the 30s replay grace window), cross-tab sign-out, household switching across tabs of the same login, and the stale UI a client shows after the *other* user changed the data underneath it. Every case here asserts a behaviour that emerges from timing/overlap, not from a single actor. | **Out of scope:** single-actor optimistic-rollback and role-gating *mechanics* live in their area files — categories/lines `08-categories-budget-lines.md`, bills `09-bills.md`, transactions `10-transactions.md`, transfers `11-transfers.md`, accounts `12-accounts-reconciliation.md`, jars `13-jars.md`, allocation `14-allocation.md`, import `15-import.md`, people/households `16-people-households.md`, invites `17-invites.md`, the role→action matrix `25-roles-permissions.md`, and single-tab session lifecycle `03-session-auth-lifecycle.md`. Cross-feature *data* seams (a change in one feature reshaping another) live in `21-feature-interactions.md`; whole-user stories in `20-journeys.md`. CONC cases isolate a single **timing collision** and reference the area case they build on rather than repeating its single-actor assertion.

**Test data setup:** unless a case says otherwise, assume a shared household `OwnerId=H1` with two **logins** — **Alex** (Owner) and **Sam** (Admin) — both signed in at once (two browsers, or two devices). Two active budget members Alex (net income 1,200.50) and Sam (800.25), base currency EUR, number format `comma-dot` (`1,234.56`), two EUR accounts **Joint** (opening 1,250.00) and **Savings** (opening 0.00); the `HouseholdAllocation`, `HouseholdAccess`, `Accounts`, `Jars`, `Reports`, `MultiCurrency` and `CamtImport` flags all **on**; one existing budget month (2026-07) with an "Expenses" group holding a **Groceries** line (planned 400.00). "Single-login two-tab" cases use one login (Alex) with the app open in tab A and tab B. Money is integer minor units at scale 4 on the client, `decimal(18,4)` server-side; actuals/balances are always transaction-derived at read time. The server resolves household + role **per request** (`HouseholdResolutionMiddleware`), so a revoked/downgraded membership or a household switch takes effect on the very next call — the JWT never carries the role. There is **no live push** (no websocket/SSE): a page shows what it fetched on mount until it refetches. All routes and server behaviour below were verified against the worktree source (branch `docs/functional-test-catalog`, PRs #169/#170/#171/#172 present).

---

## Section A — Concurrent month creation & structural edits

### CONC-001 - Two logins create the same month at once → exactly one month, loser gets a friendly 400
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR month-race / `CreateBudgetMonthCommandHandler` — the `AnyAsync` existence pre-check can't stop a concurrent insert, so the `catch (DbUpdateException)` re-checks and re-throws the *same* friendly `ValidationException`, turning the unique `(OwnerId, Year, Month)` index trip into a 400, never a raw 500 or a duplicate month.
- **Preconditions:** Shared household H1; month 2026-08 does **not** exist yet. Alex and Sam both viewing 2026-08 on the dashboard (route `/`), each seeing the empty-month hero.
- **Steps:**
  1. Alex and Sam click the create control ("Start a blank budget", or copy-previous) at effectively the same instant, both firing `POST /budget {year:2026, month:8, copyFromPrevious:…}`.
  2. Let the two requests interleave so both pass the `AnyAsync` existence pre-check before either `SaveChangesAsync` commits.
- **Expected:** Exactly one `BudgetMonths` row for `(H1, 2026, 8)`. One request returns 200 with the new month DTO. The loser's `SaveChangesAsync` trips `IX_BudgetMonths_OwnerId_Year_Month`; the handler's catch re-runs `AnyAsync`, finds the row now exists, and throws `ValidationException` "A budget for 2026-08 already exists." → HTTP 400 (not 500). The loser's DashboardPage shows the generic create banner and refetches, landing on the one real month. No orphaned categories/jars from the losing attempt (its whole `SaveChanges` rolled back).
- **Automated:** Yes (`tests/AllotJar.IntegrationTests/BudgetMonthConcurrencyTests.cs` — `Concurrent_create_of_the_same_month_is_a_validation_error_not_a_500`)

### CONC-002 - Double-click / StrictMode double-fire of create-month by one login → one month
- **Priority:** P1
- **Type:** Regression
- **Origin:** Same `(OwnerId, Year, Month)` unique-index recovery — a double-submit from a single client is the same race as two logins.
- **Preconditions:** Single login Alex; 2026-09 does not exist; a `creating` guard exists but a fast double-click can still queue two POSTs before it flips.
- **Steps:**
  1. Alex double-clicks the copy-previous button on the 2026-09 empty-month hero (two `POST /budget` in flight).
- **Expected:** One month persists. The second POST 400s ("already exists") via the same index-recovery path and is swallowed into the generic create banner if it lands after the first; the visible state converges on the single created month with the copied lines/jars. No duplicate categories.
- **Automated:** Partial (`tests/AllotJar.IntegrationTests/BudgetMonthConcurrencyTests.cs` covers the server race; the double-click UI guard is not asserted)

### CONC-003 - Two logins add a category group to the same month concurrently → both persist
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared H1, month 2026-07 loaded by both. No unique constraint on group name (see the categories file's duplicate-name case).
- **Steps:**
  1. Alex adds an expense group "Subscriptions"; Sam adds "Kids" at the same time, each `POST`-ing a new `BudgetCategory` to month 2026-07 (`POST /budget/categories`).
- **Expected:** Both groups persist and both render after each client refetches. `DisplayOrder` is assigned per request from the count at read time, so the two may land on the same order value; ordering ties break deterministically (by insert) and neither insert fails. Duplicate names, if both chose the same, are allowed. Neither client sees the other's group until it reloads (see CONC-031). No 500.
- **Automated:** No

### CONC-004 - Add a transaction to a line the other login is deleting → 404, no orphan
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Shared H1; Groceries line present; Alex has the Add-transaction modal open with Category = Groceries.
- **Steps:**
  1. Sam deletes the Groceries line (`DELETE /budget/items/{id}`).
  2. Alex submits the add form (`POST /transactions {budgetItemId: <Groceries>, …}`).
- **Expected:** `CreateTransactionCommandHandler` looks the line up, finds it gone, and throws `NotFoundException` → HTTP 404. No transaction is created (nothing is written with a dangling `BudgetItemId`). Alex's TransactionsPage surfaces the generic add error and the form stays open; a refetch shows Groceries gone. Contrast the *already-committed* case where deleting a line detaches its existing transactions (transactions file, detach-on-delete) rather than blocking.
- **Automated:** No

### CONC-005 - Add a transaction tagging an account the other login is deleting → 404
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Shared H1; account "Joint" present; Alex has the Add-transaction modal open with Account = Joint.
- **Steps:**
  1. Sam deletes the Joint account via the confirm modal (`DELETE /accounts/{id}`).
  2. Alex submits `POST /transactions {accountId: <Joint>, …}`.
- **Expected:** The handler's account lookup returns null → `NotFoundException` → 404; nothing persists. Add error shown; on reload the Account select no longer offers Joint. Contrast an already-saved transaction, which survives its account's deletion with a "—" account (transactions/accounts files — deleted account unlinks, keeps the transaction).
- **Automated:** No

### CONC-006 - Assign an unassigned transaction to a line the other login just deleted → assign refused
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Shared H1; an unassigned transaction in the register; Groceries line present; Alex opens the inline assign picker on that row.
- **Steps:**
  1. Sam deletes Groceries.
  2. Alex picks "Groceries" in the still-open picker (`PUT /transactions/{id}/assignment {budgetItemId:<Groceries>}`).
- **Expected:** `AssignTransactionCommandHandler` re-fetches the target line, finds it gone → `NotFoundException` "Budget item {id} was not found." → 404. The transaction stays **unassigned**: although the handler removes any existing splits in-memory before the line lookup, the throw happens before `SaveChangesAsync`, so *nothing* is committed. The register shows the generic assign error and, on reload, the stale option is gone. No partial write.
- **Automated:** No

---

## Section B — Simultaneous line edits (last-write-wins + optimistic rollback)

### CONC-007 - Two logins set different planned amounts on the SAME line → last write wins, no conflict detection
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** Shared H1; Groceries planned 400.00; both Alex and Sam have month 2026-07 open, both editing the Groceries planned field.
- **Steps:**
  1. Alex commits Groceries → 450.00 (`PUT /budget/items/{id} {plannedAmount:450}`); the optimistic UI shows 450,00.
  2. A moment later Sam commits Groceries → 380.00 (`PUT …{plannedAmount:380}`).
- **Expected:** `commitItem` sends only `{plannedAmount}` and `UpdateBudgetItemCommandHandler` stores exactly that value — a **blind whole-value write** with no version/ETag/If-Match. The *last* PUT to land wins the stored value (here 380.00). Both writes return 200, so **neither client rolls back**: Alex's screen still shows 450,00 (now stale) while the database holds 380,00. Alex sees 380,00 only after his page refetches (navigate away/back, month reload). No 409, no merge, no warning — this is accepted last-write-wins. Remaining-to-budget on each client is computed from its own stale/fresh view until refetch.
- **Automated:** Partial (`client/src/pages/DashboardPage.test.tsx` — `optimistically drives Remaining to €0,00 on a successful edit` covers the single-actor optimistic path; the two-writer staleness is manual)

### CONC-008 - Edit a line the other login deletes mid-edit → PUT 404 → optimistic rollback + error
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Shared H1; Groceries planned 400.00; Alex typing a new amount into Groceries.
- **Steps:**
  1. Sam deletes the Groceries line.
  2. Alex commits 450.00 (`PUT /budget/items/{id}`).
- **Expected:** `commitItem` applied the optimistic 450,00, captured the pre-edit `snapshot`, then the PUT 404s (line gone → `NotFoundException`). The `catch` restores `snapshot` and shows **"Could not save that change — reverted to the previous value."** No stale line is re-created by the PUT. A reload shows Groceries absent. This is the multi-user trigger for the single-actor rollback covered in the categories file.
- **Automated:** Partial (`DashboardPage.test.tsx` — `rolls back to the previous value and shows an error when the save fails`)

### CONC-009 - Concurrent bill-due edit and paid-toggle on the same line don't clobber each other
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared H1; an expense line "Rent" that is a bill. Alex opens its Bill tag; Sam opens its Paid toggle.
- **Steps:**
  1. Alex sets DueDay = 5 (`PUT /budget/items/{id}/bill {dueDay:5}`).
  2. Sam marks it paid (`PUT /budget/items/{id}/paid {isPaid:true}`).
- **Expected:** The two attributes live on **separate field-scoped endpoints** (`/bill` writes only `DueDay`, `/paid` writes only `IsPaid`), so both persist independently — the line ends up due-day 5 **and** paid. Neither optimistic write reverts the other's field, and on failure each shows "Could not update that bill — reverted." Note the whole-resource update PUT (`/budget/items/{id}`) also never touches `DueDay`/`IsPaid` (it writes only `PlannedAmount` + optional `Name`), so it cannot clear a bill flag either. Contrast CONC-010, where the shared planned/rename endpoint *is* whole-value on the amount.
- **Automated:** No

### CONC-010 - Rename vs planned-amount race on one line: the rename PUT silently reverts a just-saved amount
- **Priority:** P1
- **Type:** Edge
- **Origin:** `DashboardPage.renameItem` re-sends the whole resource — the new name *and the line's locally-loaded planned value* — because the update endpoint takes `plannedAmount` too (comment: "the update endpoint takes the planned amount too, so we send the line's current planned value alongside the new name").
- **Preconditions:** Shared H1; Groceries planned 400.00; Alex renaming Groceries → "Food", Sam changing its planned amount → 500.00. Alex's page still holds the pre-Sam 400.00.
- **Steps:**
  1. Sam commits planned 500.00 (`PUT /budget/items/{id} {plannedAmount:500}`) — stored value now 500.00.
  2. Alex commits the rename. `renameItem` sends `{name:"Food", plannedAmount:400}` (400 read from his stale `month` state).
- **Expected:** The rename PUT overwrites planned back to **400.00**, silently undoing Sam's 500.00 — a genuine lost update, because the rename path re-sends a stale amount rather than a name-only patch (`PlannedAmount` is written unconditionally by the handler). Both requests return 200; no client sees an error. Sam's 500,00 reappears only if she re-enters it after refetch. Flag as the money-adjacent hazard of the whole-value rename PUT (contrast the field-scoped `/bill` and `/paid` PUTs in CONC-009).
- **Automated:** No

---

## Section C — Import concurrency & dedup

### CONC-011 - Same statement committed by two logins simultaneously → each row imported once, no 500
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #159 — the per-request dedup snapshot is memory-only; the unique `(OwnerId, BankReference)` index turns the overlap into a recoverable `DbUpdateException` inside `CommitImportCommandHandler` (retry loop, `attempt < 3`).
- **Preconditions:** Real SQL Server. The identical statement (rows A, B, C, each with a `BankReference`) staged in both Alex's and Sam's import review grids for household H1.
- **Steps:**
  1. Both click "Import 3 transactions" so the two commits interleave — each reads the same empty dedup snapshot, both try to insert A/B/C.
  2. One `SaveChangesAsync` commits first; the other trips `IX_Transactions_OwnerId_BankReference`.
- **Expected:** The loser catches the `DbUpdateException` (matched by index name), re-reads the now-taken references **case-insensitively** (`OrdinalIgnoreCase`, matching the column collation), removes the collided Added rows via `Remove`, decrements `imported` and adjusts `skipped`/`credits`/`debits`/`transfers`, and saves the rest — retrying up to 3 attempts. Net across both commits: A, B, C each persist **exactly once**; the combined `Imported` + `SkippedDuplicates` reconciles; no duplicates, no 500. Builds on the import file's race-recovery case.
- **Automated:** Yes (`tests/AllotJar.IntegrationTests/UniqueBankReferenceTests.cs` — `Commit_recovers_when_a_concurrent_commit_wins_the_race`)

### CONC-012 - One login double-submits the same import → net imported once
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #159 — the dedup snapshot is per-request memory; a second submit from the same client is caught by the index recovery or the pre-loop `seen` set.
- **Preconditions:** Alex on the import review screen with rows A, B, C.
- **Steps:**
  1. Alex double-clicks "Import 3 transactions" (or re-imports the same file after success).
- **Expected:** First commit imports 3; the second finds all references already present and reports the **all-caught-up** state (0 imported, 3 skipped) — no duplicates. Matches the journey re-import.
- **Automated:** Yes (`client/e2e-journey/import.spec.ts` re-import path; unit `UniqueBankReferenceTests.Sequential_resubmit_still_skips_everything_without_touching_the_recovery_path`)

### CONC-013 - Import commit while the other login deletes the chosen import account → whole commit refused
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Shared H1; Alex's review grid targets Account = Joint; some rows flagged as transfers (so `AccountId` is mandatory).
- **Steps:**
  1. Sam deletes Joint.
  2. Alex commits (`POST /import/commit {accountId:<Joint>, items:[…]}`).
- **Expected:** `EnsureAccountOwnedAsync` looks up Joint at the top of the handler, finds it gone → `NotFoundException` → 404 **before any row is written**; nothing imports (the commit's FK pre-checks run before the insert loop). Alex sees the import error; re-selecting a live account and re-committing works. No partial import.
- **Automated:** No

### CONC-014 - Retired (W07: endpoint removed) - Raced one-shot import has no recovery loop
- **Priority:** P3 (retired)
- **Type:** Edge
- **Preconditions:** None.
- **Steps:**
  1. None: `POST /api/import/hsbc-csv` and `POST /api/import/camt053` no longer exist.
- **Expected:** Retired (W07: endpoint removed, together with `ImportStatementCommandHandler`). Every import goes through preview then commit, so the only raced-import path is `/import/commit` with its recovery loop (CONC-011); there is no longer an asymmetry between import surfaces.
- **Automated:** No

---

## Section D — Allocation commit races

### CONC-015 - Two logins commit allocation for the same month at once → one set of transfers, never doubled
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** Shared H1 with an allocation profile (source = Joint), month 2026-07, members Alex & Sam each with a personal savings account and a positive residual.
- **Steps:**
  1. Both click "Allocate" so two `AllocateIncome` commits interleave. Each `RemoveRange`s this month's prior `alloc:2026-7:*` transfers, then inserts one transfer per member keyed `BankReference = "alloc:2026-7:{memberId}"`.
- **Expected:** The unique `(OwnerId, BankReference)` index makes the per-member reference unique, so two concurrent inserts of `alloc:2026-7:{Alex}` cannot both persist. If the commits truly interleave at `SaveChanges`, the loser hits a `DbUpdateException` — and `AllocateIncomeCommandHandler` has a **single `SaveChangesAsync` with no recovery loop** (unlike import), so it surfaces as the generic allocation error banner (500). Net effect: exactly **one** set of member transfers exists, **never doubled**; the money is correct either way (re-run is idempotent — allocation file re-run case). If the commits serialize, the second simply deletes-and-recreates the same set (last-write-wins, single set). Retrying the failed commit succeeds.
- **Automated:** Partial (`tests/AllotJar.IntegrationTests/AllocationRerunTests.cs` — `Rerunning_an_allocation_recreates_the_same_references_without_tripping_the_unique_index` covers sequential idempotency; the concurrent-500 path is manual)

### CONC-016 - Allocation commit while the other login edits the profile → commit uses the profile as-of its read
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared H1; existing profile (split = Equally, source = Joint). Alex about to commit; Sam opening the allocation set-up to change the split to "By income".
- **Steps:**
  1. Sam saves the profile change (`PUT /allocation/profile`).
  2. Alex commits (`AllocateIncome`); `AllocationPlanner.PlanAsync` reads the profile fresh at commit time.
- **Expected:** The planner reads the profile at the moment of the commit, so Alex's transfers reflect whichever profile version is committed when his read runs — there is no snapshot of the preview he was staring at. If Sam's save landed first, Alex allocates By-income even though his on-screen preview said Equally; his result banner and any re-preview reconcile to the committed profile. No crash, no mixed half-Equally/half-By-income split (a single planner read drives the whole waterfall). Alex's stale preview is a display-only artifact until he re-previews.
- **Automated:** No

### CONC-017 - Allocation commit while the other login archives a member holding a residual
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared H1; both members have residuals and savings accounts. Alex about to commit; Sam archiving member "Sam".
- **Steps:**
  1. Sam archives her budget member (`PUT /members/{id}/archive` — removed from the allocation pool).
  2. Alex commits allocation.
- **Expected:** The planner reads members at commit time; if the archive committed first, the archived member is excluded from the split (her share redistributes per the profile) — no transfer is written for her. If Alex's read preceded the archive, her transfer is written to her still-valid savings account. Either way: no divide-by-zero, no negative-residual transfer, no crash (mirrors the deleted-savings-account skip in the integration suite). Totals still reconcile to the pool.
- **Automated:** No

---

## Section E — Token refresh & session races

### CONC-018 - Cold-load multi-tab refresh: winner rotates, losers refused within the 30s grace, no family burn
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #171 — a browser restoring several app tabs fires simultaneous `/auth/refresh` with the SAME cookie (the client single-flight is per-tab); the loser's 401 must **not** clear the shared cookie or burn the session family.
- **Preconditions:** One login (Alex), several tabs of the app, all cold-loaded at once so each posts `/auth/refresh` presenting the same `zbb_rt` cookie value.
- **Steps:**
  1. Tab 1 wins: `RotateAsync` succeeds, the cookie rotates to a fresh value, response 200.
  2. Tabs 2..n present the now-rotated (revoked-with-replacement) cookie milliseconds later.
- **Expected:** For each loser, `RotateAsync` sees a token revoked **with** a `ReplacedByTokenHash` **within** the 30s `ReplayGraceWindow` → returns the `Superseded` outcome. The controller returns **401 without** calling `ClearRefreshCookie()`, so the winner's fresh cookie stays in the shared jar (a deletion would sign the winning tab out ~15 min later when its access token lapses). No `RevokeAllForUserAsync` (no theft/family burn); the winner's rotated cookie still refreshes fine afterward. Each losing tab re-arms via the winner's live session on its next call.
- **Automated:** Yes (`client/e2e-journey/concurrent-refresh.spec.ts`; unit `tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs` — `Replaying_a_just_rotated_token_is_refused_without_burning_the_chain`, `Repeated_replays_within_the_grace_window_stay_refused_without_burning`)

### CONC-019 - StrictMode double-mount / 401 burst → exactly one `/auth/refresh`
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #157 — `refreshSession()` in `lib/api.ts` is the single shared in-flight promise; StrictMode double-invokes the bootstrap effect and a burst of expired requests 401 together, and two concurrent `/auth/refresh` would present the just-rotated cookie and trip server reuse detection, burning every refresh token.
- **Preconditions:** One tab; cold load (no in-memory access token) with a valid refresh cookie, OR several queued requests 401 at once when the access token lapses.
- **Steps:**
  1. Trigger the bootstrap (mount) and/or fire multiple API calls that 401 simultaneously.
- **Expected:** Exactly **one** POST `/auth/refresh` is sent; all callers await the same `sessionRefresh` promise and receive the same result; `sessionRefresh` is nulled in `finally` so the next genuine need can refresh again. The cookie rotates once. No random sign-outs.
- **Automated:** Yes (`client/src/auth/AuthContext.test.tsx` — `issues exactly one /auth/refresh even when StrictMode double-mounts the provider`)

### CONC-020 - Replay of a rotated cookie AFTER the grace window → theft response burns the family (boundary of CONC-018)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #171 boundary — a genuinely stolen cookie is replayed far later than the 30s race; only that must trip the reuse/theft response.
- **Preconditions:** A refresh cookie value that was rotated **more than 30s** ago (its token is revoked with a replacement), presented again.
- **Steps:**
  1. Rotate the cookie (normal refresh). Wait past `ReplayGraceWindow` (>30s).
  2. Present the old, rotated value to `/auth/refresh`.
- **Expected:** `RotateAsync` sees revoked-with-replacement **outside** the grace window → calls `RevokeAllForUserAsync` (burns the whole chain) and returns the failure outcome. The controller `ClearRefreshCookie()`s and returns 401. Both the attacker and the legitimate holder must sign in again — the intended anti-theft outcome. Confirms the 30s boundary that CONC-018 sits *inside*.
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs` — `Replaying_a_token_rotated_outside_the_grace_window_burns_the_whole_chain`)

### CONC-021 - Cross-tab sign-out: logout in one tab clears the other tab's in-memory token
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 — `authChannel.ts` BroadcastChannel `zbb.auth`; without it, another tab keeps a working in-memory access token for up to 15 min after sign-out.
- **Preconditions:** One login (Alex), tabs A and B both signed in and on app pages.
- **Steps:**
  1. Alex signs out in tab A (or tab A's session dies → `sessionExpired()`), which calls `broadcastSignOut()` posting `"signed-out"`.
  2. Observe tab B.
- **Expected:** Tab B's `onSignOutBroadcast` handler fires and, since it still holds a token, runs `clearAuthState()` — tearing down auth state without re-broadcasting (receive-only, no loops). Tab B's next guarded view bounces to `/login`; it does not keep rendering as signed in. Tabs without `BroadcastChannel` degrade to per-tab behaviour (no crash).
- **Automated:** Yes (`client/src/auth/AuthContext.test.tsx` — `signs this tab out when another tab broadcasts a sign-out`)

### CONC-022 - Password change on device B signs out device A; B's stale-cookie recheck must not trip theft
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #169/#171 — `change-password` revokes **all** refresh tokens + rotates the security stamp (kills every already-issued access token), while returning a fresh token+cookie so the changing device carries on.
- **Preconditions:** One login on device A (browser tab, on the dashboard) and device B (separate cookie jar).
- **Steps:**
  1. Device B changes the password (`POST /auth/change-password`) → `RevokeAllForUserAsync` + stamp rotation; B adopts the fresh token/cookie from the 200 `AuthResponse`.
  2. Device A navigates (e.g. clicks "Transactions").
- **Expected:** Device A's in-memory access token now fails the security-stamp check and its refresh token is revoked → its 401 can't refresh → `sessionExpired()` → redirect to **`/login?reason=expired`** with the "Your session has expired" copy. Device A signs back in with the **new** password. Device B's rotated cookie still refreshes fine — A's stale-cookie recheck must not fire the theft/family-burn against B (it's an administratively-revoked-*without*-replacement token → refused *without* the theft response). Signing A back in returns it to where it was headed.
- **Automated:** Yes (`client/e2e-journey/session-expiry.spec.ts` password-change scenario; unit `RefreshTokenServiceTests.Replaying_an_administratively_revoked_token_is_refused_without_the_theft_response`)

### CONC-023 - Dead session discovered mid-edit on a long-lived tab → prompt, then return to where you were
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 — genuinely-dead sessions prompt a fresh sign-in instead of a broken view; `loginRedirectPath` carries a safe `returnUrl`.
- **Preconditions:** Alex on `/transactions` in a tab left open long enough that the session was revoked server-side (logout elsewhere, admin revoke, expiry).
- **Steps:**
  1. Alex performs a data action (add/edit) or navigates — the request 401s.
  2. The 401 interceptor calls `refreshSession()`, which fails (cookie revoked).
- **Expected:** `sessionExpired()` drops the in-memory token, tears down auth state, and redirects to **`/login?reason=expired&returnUrl=%2Ftransactions`**; the login page explains why. After signing in, Alex lands back on `/transactions`, not the dashboard. No half-applied edit (the failed write never committed; any optimistic change is on a page being navigated away). This is the CONC trigger for the cross-page dead-session cases in `21-feature-interactions.md` / `20-journeys.md`.
- **Automated:** Yes (`client/e2e-journey/session-expiry.spec.ts` — the revoked-tab-returns-to-returnUrl scenario)

### CONC-024 - Idle tab, access token lapsed: focus revalidation re-arms or prompts
- **Priority:** P2
- **Type:** Edge
- **Origin:** PR #169 — on focus/visibility, `isAccessTokenExpired()` → `refreshSession()`; success re-arms silently, failure prompts sign-in, so the user finds out on return, not on a failed save.
- **Preconditions:** Alex's tab backgrounded overnight; the in-memory access token's `expiresAtUtc` has passed but the refresh cookie may still be valid.
- **Steps:**
  1. Alex re-focuses the tab (window `focus` / `visibilitychange` to visible).
- **Expected:** If the refresh cookie is still live → a single silent `refreshSession()` re-arms the session, no prompt. If the cookie is dead → `sessionExpired()` prompts sign-in (`/login?reason=expired`). If the token is still within its lifetime, focus does nothing (no needless refresh). A hidden tab does not revalidate.
- **Automated:** Yes (`client/src/auth/AuthContext.test.tsx` — `revalidates an expired token on tab focus and silently re-arms a live session`, `prompts sign-in … when focus revalidation finds a dead session`, `does nothing on focus while the access token is still within its lifetime`)

---

## Section F — Membership, roles & switching in-session

### CONC-025 - Role downgraded Admin→Read-only mid-session: server refuses writes immediately, UI catches up on next `/auth/me`
- **Priority:** P0
- **Type:** Regression
- **Origin:** Role resolved per-request (`HouseholdResolutionMiddleware`) — never baked into the JWT — so a downgrade takes effect on the next call; the client role is cached until the next `/auth/me`.
- **Preconditions:** Shared H1; Sam signed in as **Admin**, editing budget lines. Alex (Owner) opens People and changes Sam's role to **Read-only** (`PUT /access/members/{id}/role {role:3}`).
- **Steps:**
  1. Alex commits the role change.
  2. Before her client refetches `/auth/me`, Sam attempts a write (e.g. edit a planned amount → `PUT /budget/items/{id}`).
- **Expected:** The server resolves Sam's role as ReadOnly this request; `AuthorizationBehaviour` throws `ForbiddenAccessException` (403 "Your access level (ReadOnly) does not permit this action.") for the Command. Sam's optimistic edit rolls back with "Could not save that change — reverted to the previous value." (CONC-008-style). Her UI still shows edit affordances until `/auth/me` refetches (it refires on token change — next silent refresh/reload), after which `canWrite`/`isReadOnly` flip and the affordances vanish. No stale-role write ever succeeds server-side. Queries still work for all roles (read stays allowed).
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/AuthorizationBehaviourTests.cs` — ReadOnly blocked from commands; `HouseholdAccessTests.Change_role_updates_a_member_but_not_the_owner`; the client-cache-lag is manual)

### CONC-026 - Role upgraded Limited→Admin mid-session: server allows immediately, UI reveals affordances on next `/auth/me`
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared H1; Sam signed in as **Limited** (day-to-day data entry only). Alex upgrades her to **Admin**.
- **Steps:**
  1. Alex commits the upgrade.
  2. Sam attempts an Admin-only action (e.g. create an account) before her `/auth/me` refetches.
- **Expected:** The server already resolves her as Admin, so the write **succeeds** even though her UI hasn't yet shown the control (she'd reach it by URL/refresh). Once her `/auth/me` refires (token change/reload), `canWrite` turns on and the Admin affordances appear. No spurious 403. Mirror of CONC-025; the grant is never *blocked* by the stale client cache, only *hidden*.
- **Automated:** No

### CONC-027 - Owner removes a member's sign-in while that member has the app open → they lose H1, not their login
- **Priority:** P1
- **Type:** Edge
- **Origin:** `RevokeMember` hard-deletes the `HouseholdMembership`; `HouseholdResolutionMiddleware` re-resolves per request, and `ActiveHouseholdSelector.Pick` falls back to the login's own household when the active one is gone.
- **Preconditions:** Shared H1; Sam is an Admin member of H1 who **also owns her own household** (so she has a real fallback), app open and scoped to H1. Alex (Owner) removes Sam's access (`DELETE /access/members/{id}`).
- **Steps:**
  1. Alex commits the removal.
  2. Sam's client makes its next request (any navigation or `/auth/me`).
- **Expected:** Sam is **not force-signed-out** (her JWT and refresh cookie are still valid). Her next request resolves memberships → H1 is gone; `Pick` returns her own household (or her first remaining membership). H1's data disappears from her view and her `/auth/me` `households` list no longer includes H1; the switcher drops it. She is never left viewing H1's data without access. Contrast a *logout* (CONC-021), which tears the session down entirely; and CONC-034, the pure-invitee variant with no own household.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/HouseholdAccessTests.cs` — `Revoke_removes_a_member_but_never_the_owner`; `ActiveHouseholdSelectorTests` covers the fallback; the live in-session re-scope is manual)

### CONC-028 - The Owner's own membership can't be removed, even in a race
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Shared H1; two Owner-side sessions (or a double-submit) both trying to remove the owner's own membership row.
- **Steps:**
  1. Fire `DELETE /access/members/{ownerMembershipId}` (twice / concurrently).
- **Expected:** `RevokeMember` returns 403 "The owner cannot be removed from the household." for the Owner row; both attempts are rejected without ever deleting it. No "0-member / owner-less household" state is reachable. Reinforces the invites/people files' owner-immovable invariant under contention.
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Application/HouseholdAccessTests.cs` — `Revoke_removes_a_member_but_never_the_owner`)

### CONC-029 - Invite accept while the owner is editing the members list
- **Priority:** P1
- **Type:** Edge
- **Origin:** Accept reconciles the pending membership to Active and links the member; a pending/active invite for that email blocks a re-invite ("already has access").
- **Preconditions:** Shared H1; Alex (Owner) created a one-time invite link for budget person "Robin" (pending membership). Alex is on `/people`; the invitee opens the link.
- **Steps:**
  1. The invitee accepts (`POST /auth/accept-invite`) — the membership flips to Active, the login links to Robin, and (for an anonymous accepter) a login is created; the server sets the accepter's active household to H1.
  2. Concurrently, Alex — whose list is stale — tries to create **another** invite for Robin (same email), or edit Robin's row.
- **Expected:** The accept succeeds and the invitee lands **inside** H1 (auto-switch + full reload to `/?joined=1`). Alex's `/people` still shows Robin as "Invited" until it refetches; a re-invite of that email while a pending/now-active membership exists is rejected 400 "That email already has access to this household.", not silently duplicated. No duplicate membership rows for Robin (unique `(OwnerId, UserId)` filtered index + the handler check). Alex sees the linked, Active login after his list refetches.
- **Automated:** Partial (`client/e2e-journey/invite.spec.ts` — owner invites a new person who accepts and lands in the shared household; the concurrent-edit collision is manual)

### CONC-030 - Household switch in one tab silently re-scopes the other tab of the same login
- **Priority:** P1
- **Type:** Edge
- **Origin:** The active household is `ApplicationUser.ActiveOwnerId` — a **per-login** field the middleware reads every request — so switching in one tab changes the active household for *every* tab of that login; the switch is NOT broadcast to other tabs.
- **Preconditions:** Alex belongs to two households H1 and H2; tab A and tab B both signed in as Alex, both currently scoped to H1.
- **Steps:**
  1. Tab A switches to H2 (account menu → H2, `POST /households/switch {ownerId:H2}` then a full reload to `/`).
  2. Tab B (still showing H1) makes its next request — a data fetch or a write.
- **Expected:** Because `ActiveOwnerId` is now H2 server-side, tab B's next request resolves to **H2** even though its UI still renders H1's data. A read returns H2's data (mismatch until B reloads); a write targets H2, not the H1 the user thought they were in. Tab B's `/auth/me` (on its next token change) reports `ownerId = H2` and re-scopes. Flag the cross-tab surprise: same-login tabs do not hold independent active households, and `authChannel` carries sign-outs only, not switches. (Two *different* logins are unaffected — each has its own `ActiveOwnerId`.)
- **Automated:** No

---

## Section G — Stale UI after the other user changes data

### CONC-031 - No live push: a loaded page shows stale data until it refetches
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Shared H1; Alex and Sam both viewing month 2026-07 / the register / the accounts page.
- **Steps:**
  1. Sam adds a transaction, edits a planned amount, or adds an account.
  2. Alex does nothing (no navigation, no refresh).
- **Expected:** Alex's already-loaded view does **not** update — there is no websocket/SSE; each page fetches on mount (and the register deliberately doesn't even refetch on month change — see the transactions file). Alex sees Sam's change only after a refetch (navigate away/back, reload, or an action that reloads the month). This is accepted behaviour, not a bug; it sets up the stale-write collisions in CONC-007/010/032. No stale-data banner is shown.
- **Automated:** No

### CONC-032 - Acting on a row the other user already deleted surfaces a clean error, not a crash
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Shared H1; Alex's page still shows a line / account / transaction that Sam has since deleted.
- **Steps:**
  1. Alex edits/deletes/assigns against the stale row.
- **Expected:** The server returns 404 (gone) or 403 (no longer owned/visible); the client maps it to the page's generic error banner and, for optimistic actions, rolls back to the pre-action snapshot (CONC-008). No unhandled exception, no partial write, no duplicate/orphan. A reload reconciles Alex's view to reality. Consolidates the delete-race outcomes of CONC-004/005/006/008.
- **Automated:** No

### CONC-033 - Two logins archive the last remaining member near-simultaneously → empty state, no crash
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Shared H1 down to a single **budget member**; both Alex and Sam (Owner/Admin) on `/people`.
- **Steps:**
  1. Both fire the archive on the last member at once (the "✕" hover action — no confirm dialog).
- **Expected:** There is no guard against archiving the last member, so the household reaches the solo-friendly **empty People state** ("Budgeting on your own?"); the second archive is a no-op / already-archived rather than a crash. Note this is the *budget member* list, distinct from the Owner's sign-in membership, which CONC-028 protects — the household still has its Owner login. No 500, no negative headcount.
- **Automated:** No

### CONC-034 - Owner revokes a pure invitee mid-session → phantom own-household, no start-own card
- **Priority:** P2
- **Type:** Edge
- **Origin:** Only accept-invite Path B creates a login **without** an own household. `RevokeMember` hard-deletes that login's only membership, leaving zero membership rows; middleware fallback makes it Owner-of-self, but `HouseholdBootstrap` never ran for it — no owner member, no months — and `/auth/me` synthesizes an `isOwn:true` entry, so `ownsHousehold=true` and the "Start my own budget" card does not appear.
- **Preconditions:** Shared H1; Sam is a **pure invitee** (accepted a link with a brand-new login; `ownsHousehold=false`, member of H1 only), app open on H1. Alex (Owner) removes her access (`DELETE /access/members/{id}`).
- **Steps:**
  1. Alex commits the removal.
  2. Sam's client makes its next request / `/auth/me` refetch.
- **Expected:** Sam is not signed out; her next request resolves zero memberships → middleware fallback = Owner of her own (empty) household. But because that household was never bootstrapped, she lands on an **empty dashboard / People page with no owner member and no months**, and — unlike the *leave* flow, which materializes her household properly — the AccountPage "Start my own budget" card stays hidden (`ownsHousehold=true` from the synthesized `isOwn` entry). She is not stuck viewing H1's data, but she is left in a bare state she can only build up manually. Distinct from CONC-027 (revokee who already owned a household). Flag as the known revoke-a-pure-invitee gap (see `16-people-households.md`).
- **Automated:** No
