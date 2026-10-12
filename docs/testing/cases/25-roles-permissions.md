# Roles & permissions matrix

**ID prefix:** ROLE | **Scope:** The cross-feature authorization surface for the four household roles — **Owner (0), Admin (1), Limited (2), Read-only (3)** — across every page and every mutating action (budget structure, planned lines, bills, transactions, transfers, accounts, jars, allocation profile + commit, import, member CRUD, invites/role/link/revoke, household leave/switch/start-own, preferences, reports). This file owns **the permission matrix itself** and asserts, for every denied cell, BOTH the UI gate (control hidden/disabled) AND the server enforcement (403/404 on a direct API call), plus the mechanics that make role gating work: the MediatR `AuthorizationBehaviour` pipeline (Query = all roles, Command = Admin+ default, `[AllowLimited]` = Limited+, `[OwnerOnly]` = Owner only, no-resolved-role = skip), the feature-gate-404 vs role-403 vs auth-401 precedence, per-request role re-resolution from the ACTIVE household, role-change-takes-effect, invite-assigned roles, the sole-owner invariants, and Read-only view parity. | **Out of scope:** the *area-internal* mechanics of each feature live in their own files and are only referenced here — people/member management detail in `16-people-households.md` (PPL), invite lifecycle in `17-invites.md` (INV), the multi-user/concurrency timing of role changes in `22-concurrency-multiuser.md` (CONC), session/JWT/refresh in `03-session-auth-lifecycle.md` (SESS), feature-flag on/off routing in `01-landing-public.md`/routing, transactions in `10-transactions.md` (TX), transfers in `11-transfers.md` (TRF), accounts in `12-accounts-reconciliation.md` (ACCT), jars in `13-jars.md` (JAR), allocation in `14-allocation.md` (ALLOC), import in `15-import.md` (IMP), budget structure in `08-categories-budget-lines.md` (CAT) / `06-dashboard-budget-view.md` (DASH), bills in `09-bills.md` (BILL), reports in `18-reports.md` (RPT).

**Test data setup:** One shared household **H1** (owner id = Olivia's user id) with four Members each linked to a login:
- **Olivia** — role **Owner (0)**, the household creator (immovable owner membership).
- **Adam** — role **Admin (1)**, linked login `adam@h1.eu`.
- **Lena** — role **Limited (2)**, linked login `lena@h1.eu`. Lena ALSO owns her own household **H2** (so in H2 she is Owner) — used for the multi-household / accept-invite cases.
- **Rhea** — role **Read-only (3)**, linked login `rhea@h1.eu`.

H1 has: EUR account **"Joint"** (balance 1,250.00) and EUR account **"Savings"** (balance 400.00); a current BudgetMonth with an Income group (line "Salary" 3,000.00 planned), an Expense group **"Housing"** with line **"Rent"** (1,000.00 planned, DueDay 1, a bill), and a Savings group line **"Emergency Fund"** backed by a jar. All feature flags default **ON** (`accounts, multiCurrency, camtImport, reports, jars, householdAllocation, householdAccess`). "Direct API call" = an authenticated request carrying the acting login's bearer/refresh so `HouseholdResolutionMiddleware` resolves their H1 role; role is resolved **per request** from the active household, never baked into the JWT. Exact server refusal string: `Your access level ({Role}) does not permit this action.` where `{Role}` is the enum name (`Admin` / `Limited` / `ReadOnly`).

---

## The permission matrix (the spec)

### ROLE-001 - The role → action permission matrix (the spec every other case verifies)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Source of truth: `AuthorizationBehaviour.IsPermitted` (Owner⇒always, Admin⇒`!ownerOnly`, Limited⇒`!ownerOnly && allowLimited`, ReadOnly⇒false), the `[AllowLimited]` markers (9 Transaction cmds — Create, Update, Delete, Split, Assign, CreateTransfer, ConfirmTransferLegs, LinkRefund and, since W08, `ConfirmConvertedAmountCommand` — + `SetBudgetItemPaidCommand` + `AllocateIncomeCommand`) and `[OwnerOnly]` markers (`InviteMember`, `ChangeMemberRole`, `LinkMembershipMember`, `RevokeMember`). All other Commands are Admin+ by default; all Queries are all-role.
- **Steps:**
  1. Treat this table as the canonical spec. Y = allowed, `403` = ForbiddenAccessException, `-` = n/a. Every ROLE-nnn case below asserts one or more cells of it against the live UI and/or API.

  | Action (server request) | Owner | Admin | Limited | Read-only | Gate |
  |---|---|---|---|---|---|
  | View any page / GET any Query (budget, tx, accounts, jars, members, memberships, allocation profile+preview, reports) | Y | Y | Y | Y | Query ⇒ all roles |
  | Create/copy month (`POST /budget`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Category add/rename/delete/reorder (`POST/PUT/DELETE /budget/categories…`, `PUT …/order`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Planned line add/edit/delete/reorder (`POST …/items`, `PUT/DELETE /budget/items/{id}`, `PUT …/items/order`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Set/clear a line's bill due-day (`PUT /budget/items/{id}/bill`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Mark a bill paid/unpaid (`PUT /budget/items/{id}/paid`) | Y | Y | **Y** | 403 | `[AllowLimited]` |
  | Transaction add/edit/delete/split/assign (`POST /transactions`, `PUT/DELETE …/{id}`, `PUT …/splits`, `PUT …/assignment`) | Y | Y | **Y** | 403 | `[AllowLimited]` |
  | Transfer between accounts / edit a transfer in place (`POST /transactions/transfer`, `PUT /transactions/{id}/transfer`) | Y | Y | **Y** | 403 | `[AllowLimited]` |
  | Enter a waiting row's budget-currency amount (`PUT /transactions/{id}/converted-amount`, W08); its **Suggest** (`GET /transactions/conversion-suggestion`) is a Query | Y | Y | **Y** | 403 | `[AllowLimited]` |
  | Account create/update/delete (`POST/PUT/DELETE /accounts…`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Jar create/update/archive (`POST/PUT /jars…`, `PUT …/archive`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Allocation profile upsert (`PUT /allocation/profile`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Allocation commit / run (`POST /allocation/commit/{y}/{m}`) | Y | Y | **Y** | 403 | `[AllowLimited]` |
  | Import preview / commit (`POST /import/preview|commit`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Member create/update/archive (`POST /members`, `PUT /members/{id}`, `PUT …/archive`) | Y | Y | 403 | 403 | Command (Admin+) |
  | Household access: invite/role-change/link/revoke (`POST /access/invite`, `PUT …/role`, `PUT …/link`, `DELETE /access/members/{id}`) | Y | **403** | 403 | 403 | `[OwnerOnly]` |
  | Accept an invite while signed-in (`POST /auth/accept-invite`, `AcceptInviteCommand`) | Y | Y | **403** | **403** | Command (Admin+) — defect, see ROLE-037 |
  | Leave / start-own / switch household (`POST /households/leave|start-own|switch`) | Y¹ | Y | Y | Y | `[Authorize]` only, no role gate |
  | Change password / save preferences / consent (`/auth/*`) | Y | Y | Y | Y | `[Authorize]` only |
  | View reports (`GET /reports/trends`, `/reports/annual/{y}`) | Y | Y | Y | Y | Query ⇒ all roles |

  ¹ Owner cannot leave their OWN household (400 business rule, not a role denial — ROLE-030).
- **Expected:** The table matches `AuthorizationBehaviour` + attribute markers exactly. Note the three non-obvious cells: **mark-bill-paid is Limited+ but set-bill-due-day is Admin+** (ROLE-011/012); **allocation commit is Limited+ but the profile is Admin+** (ROLE-020/021); **import preview is Admin+ despite being read-only in spirit** (ROLE-016/017).
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/AuthorizationBehaviourTests.cs` proves the pipeline rule generically; no per-endpoint sweep exists)

---

## Authorization pipeline mechanics

### ROLE-002 - Every Query is readable by every role, including Read-only
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Rhea signed in to H1 as Read-only.
- **Steps:**
  1. As Rhea, GET each read endpoint directly: `/budget/current`, `/budget/{y}/{m}`, `/budget/months`, `/transactions`, `/accounts`, `/accounts/reconciliation`, `/jars`, `/members`, `/members/spending`, `/access/members`, `/allocation/profile`, `/allocation/preview/{y}/{m}`, `/reports/trends`, `/reports/annual/{year}`.
- **Expected:** Every call returns **200** with the household's live data. `AuthorizationBehaviour` only guards requests whose type name ends in `Command`; requests ending in `Query` bypass the role switch entirely, so Read-only reads everything H1 owns (owner-scoped by `OwnerId`, not filtered by role).
- **Automated:** Yes (`AuthorizationBehaviourTests.cs` — "every role can run queries" [Theory across all four roles])

### ROLE-003 - Read-only can execute NO command — even the `[AllowLimited]` ones
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Rhea signed in to H1 as Read-only.
- **Steps:**
  1. As Rhea, POST `/transactions` (an `[AllowLimited]` command) with a valid body.
  2. As Rhea, PUT `/budget/items/{rentId}/paid` (also `[AllowLimited]`).
  3. As Rhea, POST `/allocation/commit/{y}/{m}` (also `[AllowLimited]`).
- **Expected:** All three return **403** `Your access level (ReadOnly) does not permit this action.` The `HouseholdRole.ReadOnly => false` arm short-circuits before `allowLimited` is even consulted — Read-only is denied every Command, including the ones Limited may run.
- **Automated:** Yes (`AuthorizationBehaviourTests.cs` — "ReadOnly blocked from commands")

### ROLE-004 - A command with no resolved role skips role enforcement (data still owner-scoped)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A request path where `HouseholdResolutionMiddleware` never set a role (e.g. an internal/anonymous dispatch, or the MediatR pipeline exercised outside the API middleware). `ICurrentUser.Role` is null.
- **Steps:**
  1. Dispatch any Command with `_currentUser.Role == null`.
- **Expected:** `AuthorizationBehaviour` returns `next()` immediately (the `role is null ⇒ skip` guard) — no 403 is thrown. Security does not collapse: every handler still scopes reads/writes by `_currentUser.OwnerId`, so a role-less caller can only touch their own household's data. This is why anonymous `POST /auth/accept-invite` (no resolved role) is NOT blocked by the pipeline, whereas a signed-in Limited accepter IS (ROLE-037).
- **Automated:** Yes (`AuthorizationBehaviourTests.cs` — "no resolved role skips enforcement")

### ROLE-005 - Forbidden commands surface as 403 with the role-named message (not 401, not 404)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Lena signed in to H1 as Limited.
- **Steps:**
  1. As Lena, POST `/budget/categories` (Admin+ command) with `{name:"Fun"}`.
  2. Inspect the HTTP status and body.
- **Expected:** **403** with `ExceptionHandlingMiddleware`'s ForbiddenAccessException shape `{status:403, title:"Your access level (Limited) does not permit this action."}`. It is NOT a 401 (the caller is authenticated) and NOT the generic 404 the handler would raise for a missing entity — the role check runs in the MediatR pipeline **before** the handler, so it fires even when the target id does not exist.
- **Automated:** No

### ROLE-006 - Client role-derivation truth table drives every UI gate
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Ability to sign in as each of Olivia/Adam/Lena/Rhea.
- **Steps:**
  1. For each role, after `/auth/me` resolves, inspect the `useAuth()` derived booleans consumed across pages.
- **Expected:** From `AuthContext` (`role` numeric): `canManageHousehold = role === 0` (Owner only), `canWrite = role <= 1` (Owner+Admin), `canEnterData = role <= 2` (Owner+Admin+Limited), `isReadOnly = role === 3`. Every write control keys off exactly one of these: budget/accounts/jars/import/allocation-settings/member-CRUD → `canWrite`; transaction & allocation-commit → `canEnterData`; invite/role/link/revoke → `canManageHousehold` (`canAccess = features.householdAccess && canManageHousehold`).

  | role | canManageHousehold | canWrite | canEnterData | isReadOnly |
  |---|---|---|---|---|
  | Owner 0 | true | true | true | false |
  | Admin 1 | false | true | true | false |
  | Limited 2 | false | false | true | false |
  | Read-only 3 | false | false | false | true |
- **Automated:** Partial (`client/src/pages/RoleGating.test.tsx` exercises roles 0/2/3 across Transactions + Accounts; Admin (1) is not exercised there)

### ROLE-007 - Access-level banner: shown for Read-only and Limited, hidden for Owner/Admin
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Sign in as each role in turn.
- **Steps:**
  1. On any authenticated page, read the AppShell access banner (`role="status"`).
- **Expected:**
     - **Read-only:** "You have read-only access — you can view everything but cannot make changes."
     - **Limited:** "You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings."
     - **Owner / Admin:** no banner. The banner is driven by `isReadOnly` then `!canWrite && canEnterData`; Admin has `canWrite` so neither branch fires.
- **Automated:** Partial (`RoleGating.test.tsx` asserts the `/read-only access/` banner for role 3; the Limited banner text is not directly asserted)

### ROLE-008 - Feature-gate 404 vs role 403 vs auth 401 precedence
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Rhea (Read-only) in H1; the `Jars` feature flag can be toggled off server-side for one variant.
- **Steps:**
  1. Unauthenticated (no bearer/cookie) POST `/jars` → observe status.
  2. Authenticated as Rhea, flag ON, POST `/jars` → observe status.
  3. Authenticated as Rhea, `Jars` flag OFF, POST `/jars` → observe status.
- **Expected:**
     1. **401** — `[Authorize]` (authentication middleware) rejects first, before any role or feature logic.
     2. **403** — `FeatureGate(Jars)` passes (flag on); the MediatR role check inside the action then denies Read-only.
     3. **404** — `FeatureGateAttribute` (an action filter) returns Not Found for the disabled feature **before** the action body runs, so the role check is never reached. Precedence is therefore **401 (unauth) → 404 (feature off) → 403 (role)**. Budget and Transactions controllers carry no `FeatureGate`, so they never 404 on this basis.
- **Automated:** No

---

## Budget structure & planned edits (Admin+)

### ROLE-009 - Budget structure editing denied to Limited & Read-only — UI hidden + API 403 sweep
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H1 current month populated. Test as Lena (Limited) and Rhea (Read-only).
- **Steps:**
  1. On the Dashboard (`/`), as Lena then Rhea, look for the structure-editing affordances: "Add category group", "Add income source", the per-line planned-amount inputs, rename-in-place group/line textboxes, delete-group control, and the move/reorder buttons.
  2. Bypassing the UI, as Lena, direct-call each: `POST /budget/categories`, `PUT /budget/categories/{id}` (rename), `DELETE /budget/categories/{id}`, `PUT /budget/categories/order`, `POST /budget/categories/{id}/items`, `PUT /budget/items/{id}`, `DELETE /budget/items/{id}`, `PUT /budget/categories/{id}/items/order`.
  3. Repeat step 2 as Rhea.
- **Expected:** UI — every structure control is gated behind `canWrite`, so none render for Lena or Rhea; the budget renders read-only (planned amounts as static text, names as text not textboxes). API — every call in steps 2 and 3 returns **403** `Your access level (Limited|ReadOnly) does not permit this action.` (all are plain Admin+ commands, no `[AllowLimited]`). No planned figure or group changes.
- **Automated:** Partial (`RoleGating.test.tsx` proves Limited/ReadOnly cannot manage a different Admin+ surface (accounts); DashboardPage structure gating not asserted per-role)

### ROLE-010 - Month creation is Admin+; the create-month hero is read-only for non-writers
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Navigate H1 to a month with no BudgetMonth (`notFound`). Test as Adam (Admin), Lena (Limited), Rhea (Read-only).
- **Steps:**
  1. As Adam, on the empty month, confirm the create-month hero offers "Start a blank budget" / "Or start from a template" (and "Copy …" when a prior month exists).
  2. As Lena then Rhea, view the same empty month.
  3. As Lena, direct-call `POST /budget` (blank/copy/template) for that month.
- **Expected:** Adam sees and can use the create controls (`canWrite`). For Lena and Rhea the non-writer hero renders instead: "Ask an admin or the owner to set this month up." with no create buttons (`notFound && !canWrite`). Direct `POST /budget` as Lena → **403**. Only Owner/Admin can materialize a month.
- **Automated:** No

### ROLE-011 - Mark bill paid: Limited allowed, Read-only denied (the one budget write Limited holds)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** H1 current month, "Rent" is a bill (DueDay 1), currently unpaid.
- **Steps:**
  1. As Lena (Limited) on the Dashboard, click "Mark Rent paid".
  2. As Rhea (Read-only), attempt the same (control should be absent) then direct-call `PUT /budget/items/{rentId}/paid {paid:true}`.
- **Expected:** Lena — the paid toggle is available (it is `[AllowLimited]`, and the Limited banner explicitly promises "mark bills paid"); `PUT …/paid` returns 200 and the bills summary updates. Rhea — control hidden; direct call returns **403** (ReadOnly runs no command). This is the *only* line under `/budget/items` that Limited may write.
- **Automated:** Partial (`AuthorizationBehaviourTests.cs` — "Limited only AllowLimited commands"; `BillTrackingTests.cs` covers SetPaid semantics but not per-role at the HTTP layer)

### ROLE-012 - Set/clear a bill's due day is Admin+, NOT part of Limited's Paid privilege
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** H1 current month, line "Rent". Test as Lena (Limited).
- **Steps:**
  1. As Lena, look for the "mark as bill / set due day" control on a line (the affordance behind `canWrite`).
  2. As Lena, direct-call `PUT /budget/items/{rentId}/bill {dueDay:15}`.
- **Expected:** UI control absent (structure edit, `canWrite`). API → **403**: `SetBudgetItemBillCommand` carries NO `[AllowLimited]` (unlike `SetBudgetItemPaidCommand`), so making a line a bill or moving its due day is Admin+. Limited can toggle *paid* but cannot define *what* the bill is — a deliberate structure/data-entry split.
- **Automated:** No

---

## Transactions & transfers (Limited+)

### ROLE-013 - The six transaction commands are Limited+; Read-only 403 on each (UI hidden + API sweep)
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H1 with existing transaction "Tesco" assigned to "Groceries". Test as Lena (Limited) and Rhea (Read-only).
- **Steps:**
  1. As Rhea on `/transactions`, confirm the register still lists "Tesco" but there is no "Add transaction" button, no "Transaction payee" input, no "Edit transaction: Tesco", no "Assign Tesco" control; the assigned line shows as static text.
  2. As Rhea, direct-call each: `POST /transactions`, `PUT /transactions/{id}`, `DELETE /transactions/{id}`, `PUT /transactions/{id}/splits`, `PUT /transactions/{id}/assignment`.
  3. As Lena, confirm the same controls ARE present and each command succeeds (200/201).
- **Expected:** Rhea — every entry/edit affordance is hidden behind `canEnterData`; all five direct calls return **403** (ReadOnly runs no command). Lena — full transaction entry works (all five carry `[AllowLimited]`, and `canEnterData` is true for Limited). Read-only never mutates a transaction; Limited does day-to-day entry.
- **Automated:** Partial (`RoleGating.test.tsx` — "read-only access hides transaction entry and edit controls" (role 3) and "limited access keeps transaction entry available" (role 2))

### ROLE-014 - Recording a transfer follows the transaction gate: Limited yes, Read-only 403
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H1 with EUR accounts "Joint" (1,250.00) and "Savings" (400.00). Test as Lena and Rhea.
- **Steps:**
  1. As Lena on `/transactions`, use "Record transfer" to move 100.00 from "Joint" to "Savings".
  2. As Rhea, attempt the same (control hidden) then direct-call `POST /transactions/transfer {sourceAccountId, destinationAccountId, amount:100}`.
- **Expected:** Lena — transfer succeeds (`CreateTransferCommand` is `[AllowLimited]`); Joint 1,150.00 / Savings 500.00 (balances derived at read). Rhea — control absent; direct call **403**. Note the asymmetry vs ROLE-018: Limited can *move money between* accounts but cannot *create/delete* an account.
- **Automated:** Partial (`AuthorizationBehaviourTests.cs` pipeline; `TransfersTests.cs` covers transfer semantics but not per-role HTTP)

### ROLE-015 - Read-only sees the full transaction register live, just no controls
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** H1 register with assigned, unassigned, split, transfer, income rows. Rhea (Read-only).
- **Steps:**
  1. As Rhea, open `/transactions`; use the "Unassigned" / "All" filters.
- **Expected:** All rows render with current amounts, payees, assigned line names (as static text), member attribution and account tags; filters work (they are client-side view state, no command). Rhea sees exactly what the household sees — view parity — but with zero write affordances and the read-only banner present.
- **Automated:** Partial (`RoleGating.test.tsx` asserts the "Tesco" row still renders for role 3 with controls removed)

---

## Import (Admin+, even preview)

### ROLE-016 - Import entry point tracks canWrite (Admin+), not canEnterData
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** `camtImport` flag on. Test as Adam (Admin), Lena (Limited), Rhea (Read-only).
- **Steps:**
  1. On `/transactions`, look for the "Import" link (`to="/import"`) for each role.
  2. As Lena, navigate directly to `/import`.
- **Expected:** The Import link renders only when `features.camtImport && canWrite` — visible to Owner/Admin only; **absent for Lena (Limited) despite her having transaction entry rights**, and absent for Rhea. Navigating directly to `/import` as Lena loads the page shell but every action she attempts is server-denied (ROLE-017). The code comment on `TransactionsPage` states it: "Recording/editing transactions is day-to-day entry (Limited+); importing needs Admin+."
- **Automated:** No

### ROLE-017 - Import preview AND commit are Admin+; Limited gets 403 even for the read-only preview
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Lena (Limited) with a valid CSV/CAMT file and an H1 account.
- **Steps:**
  1. As Lena, direct-call `POST /import/preview` (multipart).
  2. As Lena, direct-call `POST /import/commit`. (The former `POST /import/camt053` and `POST /import/hsbc-csv` were removed in W07 and no longer exist.)
- **Expected:** Both return **403**. Although preview only reads/parses and persists nothing, `PreviewImportCommand` is named `…Command` and carries no `[AllowLimited]`, so the pipeline treats it as an Admin+ write — Limited (and Read-only) cannot even preview a statement. Import is Admin+ end to end.
- **Automated:** No

---

## Accounts (Admin+)

### ROLE-018 - Account create/update/delete are Admin+; Limited & Read-only get 403 (but Limited can still transfer)
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H1 with account "Everyday". Test as Adam (Admin), Lena (Limited), Rhea (Read-only).
- **Steps:**
  1. On `/accounts`, as Adam confirm "Add account", "Edit Everyday", and "Confirm delete Everyday" are present.
  2. As Lena then Rhea, confirm those controls are absent (`canWrite`), while the account cards + net-total hero still render.
  3. As Lena, direct-call `POST /accounts`, `PUT /accounts/{id}`, `DELETE /accounts/{id}`.
  4. As Rhea, direct-call the same three.
- **Expected:** UI — management controls only for Owner/Admin; Lena/Rhea see a read-only account list. API — all six direct calls (steps 3+4) return **403** (all three commands are plain Admin+). Reconciliation GET stays 200 for every role. Contrast ROLE-014: Limited can move money via a transfer but cannot own the account lifecycle.
- **Automated:** Partial (`RoleGating.test.tsx` — "limited access cannot manage accounts (admin-only)" and "owner sees full account management")

---

## Jars (Admin+)

### ROLE-019 - Jar create/update/archive are Admin+; UI hidden for non-writers + API 403 for Limited & Read-only
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** H1 with a jar "Emergency Fund". Test as Adam, Lena, Rhea.
- **Steps:**
  1. On `/jars`, as Adam confirm "New jar", per-jar "Edit …" and the two-step "Archive …" → "Confirm archive …" are present.
  2. As Lena then Rhea, confirm those are absent (jars still list with balances + funded %); `canManage={canWrite}` is false so `Jar` rows render read-only.
  3. As Lena, direct-call `POST /jars`, `PUT /jars/{id}`, `PUT /jars/{id}/archive`.
- **Expected:** UI management only for Owner/Admin; non-writers get a read-only jar shelf. Direct calls as Lena → **403** each (`CreateJar`/`UpdateJar`/`ArchiveJar` are plain Admin+). The `JarsPage` comment confirms: "Managing jars needs Admin+ (canWrite); others see them read-only."
- **Automated:** No (JarsPage.test covers CRUD as an implicit owner; no per-role jar test)

---

## Allocation (profile = Admin+, commit = Limited+)

### ROLE-020 - Allocation profile upsert is Admin+; Limited & Read-only 403 (config vs run split)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** H1 is shared (≥2 members, so `/allocation` is reachable). Test as Adam, Lena, Rhea.
- **Steps:**
  1. On `/allocation`, as Adam confirm the Steps card's **Settings** button (named "Allocation settings") is present and opens the settings dialog, whose **Save** is named "Save allocation settings" (`canWrite`).
  2. As Lena then Rhea, confirm the settings/edit affordances are absent: no **Settings** button, no **Link account** chip on a Savings row, and no action on the "No account to pay from" or pocket-money strips.
  3. As Lena, direct-call `PUT /allocation/profile` with a rule spec.
- **Expected:** Only Owner/Admin can open/save the profile (`showSettings && canWrite`). Lena's direct `PUT /allocation/profile` → **403** (`UpsertAllocationProfileCommand` is plain Admin+). Read-only likewise 403. Configuring *how* income splits is an admin act.
- **Automated:** No

### ROLE-021 - Allocation commit is Limited+; Read-only 403, Limited succeeds
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Shared H1 with a saved allocation profile and a source account set (so "Allocate" is enabled). Test as Lena (Limited) and Rhea (Read-only).
- **Steps:**
  1. As Lena on `/allocation`, press **Allocate** (named "Allocate {month}"; rendered under `canEnterData`), tick **I’ve completed these transfers** and press **Record transfers**.
  2. As Rhea, confirm the Allocate button is absent, then direct-call `POST /allocation/commit/{y}/{m}`.
- **Expected:** Lena — the **Allocate** button is present (`canEnterData`) and `POST /allocation/commit/{y}/{m}` returns 200, creating the member savings transfers (idempotent on rerun). Rhea — control hidden; direct call **403**. `AllocateIncomeCommand` is `[AllowLimited]`, so running the waterfall is day-to-day entry even though editing the profile (ROLE-020) is not.
- **Automated:** Partial (`AuthorizationBehaviourTests.cs` — "Limited only AllowLimited commands"; `AllocationTests.cs` covers commit semantics, not per-role HTTP)

### ROLE-022 - Allocation profile GET and preview are readable by every role incl. Read-only
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Shared H1 with a profile. Rhea (Read-only).
- **Steps:**
  1. As Rhea, GET `/allocation/profile` and `/allocation/preview/{y}/{m}`.
- **Expected:** Both return **200** — `GetAllocationProfileQuery` and `PreviewIncomeAllocationQuery` are Queries, so all roles read the preview (the KPI row, the Steps card and each person's share on the Savings card). Only the mutations (profile save = Admin+, commit = Limited+) are gated.
- **Automated:** No

---

## People / members (Admin+)

### ROLE-023 - Member create/update/archive are Admin+; Limited & Read-only 403 (UI hidden + API)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** `householdAllocation` on so `/people` is reachable. Test as Adam (Admin), Lena (Limited), Rhea (Read-only). Area detail: see PPL-001..PPL-020.
- **Steps:**
  1. On `/people`, as Adam confirm "+ Add person", the row "✎" edit and "✕" archive controls render (`canWrite`).
  2. As Lena then Rhea, confirm those are absent; the members table still lists everyone with income/share/spent.
  3. As Lena, direct-call `POST /members`, `PUT /members/{id}`, `PUT /members/{id}/archive`.
- **Expected:** Member CRUD affordances only for Owner/Admin; Lena/Rhea get a read-only people table. Direct calls as Lena → **403** each (plain Admin+ commands under `MembersController` + `FeatureGate(HouseholdAllocation)`). Managing budget *persons* is Admin-level; managing their *logins/access* is Owner-only (ROLE-025).
- **Automated:** Partial (`HouseholdMembersTests.cs` covers member CRUD semantics/ownership; PeoplePage.test covers add-person as owner; no per-role HTTP sweep)

### ROLE-024 - Membership + spending lists are readable by every role incl. Read-only (emails visible)
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** H1 with several linked logins. Rhea (Read-only).
- **Steps:**
  1. As Rhea, GET `/access/members` and `/members/spending`.
- **Expected:** Both **200**. `GetMembershipsQuery` returns the full membership list including each login's email, role and status — a Read-only user can see who has access (query, all roles) even though they cannot change any of it. This is an intentional transparency choice; flag in review only if email exposure to Read-only is unwanted.
- **Automated:** No

---

## Household access (Owner-only)

### ROLE-025 - Household-access mutations are Owner-only; an Admin gets 403 on invite / role / link / revoke
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H1. Test as Adam (Admin). Area detail: INV-007, PPL-035..PPL-037.
- **Steps:**
  1. As Adam, direct-call `POST /access/invite` (valid body).
  2. As Adam, direct-call `PUT /access/members/{id}/role {role:2}`.
  3. As Adam, direct-call `PUT /access/members/{id}/link {memberId}`.
  4. As Adam, direct-call `DELETE /access/members/{id}`.
- **Expected:** All four return **403** `Your access level (Admin) does not permit this action.` — every `HouseholdAccess` command carries `[OwnerOnly]`, and `AuthorizationBehaviour` denies even Admin (`Admin => !ownerOnly`). Managing *who has access* is the one power reserved exclusively to the Owner. (`HouseholdAccessController` also has `FeatureGate(HouseholdAccess)`, so a flag-off variant would 404 first — ROLE-008.)
- **Automated:** Partial (`AuthorizationBehaviourTests.cs` — "Admin all commands except owner-only"; `HouseholdAccessTests.cs` covers change-role/revoke never-owner)

### ROLE-026 - Invite / role / link / remove UI controls appear only for the Owner
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** `householdAccess` on. Test as Olivia (Owner) vs Adam (Admin).
- **Steps:**
  1. On `/people`, as Olivia confirm the "Sign-in & access" cell offers the role `<select>`, "Remove", "Invite to sign in", and the "Other sign-ins" card.
  2. As Adam, view the same cells.
- **Expected:** Olivia sees all access controls (`canAccess = features.householdAccess && canManageHousehold` = true). Adam — despite `canWrite` letting him do member CRUD — sees NO role select, NO "Remove", NO invite pill, and the "Other sign-ins" card does not render (`canAccess` false because `canManageHousehold` is Owner-only). Non-owner logins show "No sign-in" placeholders. The UI mirrors the server `[OwnerOnly]` gate exactly.
- **Automated:** No (INV-007 asserts invite controls hidden for a non-owner Admin in the invites file)

---

## Sole-owner invariants

### ROLE-027 - The Owner's role can never be changed (API 403 with the dedicated message)
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H1, Olivia is Owner. Acting as Olivia (the only login who could even reach this command).
- **Steps:**
  1. As Olivia, direct-call `PUT /access/members/{oliviaMembershipId}/role {role:1}` (demote self to Admin).
  2. Also attempt `{role:0}` on any non-owner row.
- **Expected:** Step 1 → **403** `The owner's role cannot be changed.` (handler-level guard on the Owner membership row, distinct from the pipeline denial). Step 2 → **400** validation `A household can only have one owner.` (`role == Owner` is rejected by the validator). Exactly one Owner is preserved; the owner cannot be demoted, and no second Owner can be minted.
- **Automated:** Partial (`HouseholdAccessTests.cs` — "change-role updates a member but never the owner")

### ROLE-028 - The Owner can never be removed from the household (API 403)
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H1, Olivia is Owner.
- **Steps:**
  1. As Olivia, direct-call `DELETE /access/members/{oliviaMembershipId}`.
- **Expected:** **403** `The owner cannot be removed from the household.` (handler guard before the hard-delete). The owner membership row is immovable; there is no code path — UI or API — that deletes it. See CONC-028 for the concurrent-race variant and INV-053 for the invites-file assertion.
- **Automated:** Partial (`HouseholdAccessTests.cs` — "revoke removes a member but never the owner")

### ROLE-029 - `role = Owner` is never grantable via invite or role change
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** H1, Olivia is Owner. `householdAccess` on.
- **Steps:**
  1. On `/people`, open the invite modal; inspect the "Access level" options.
  2. As Olivia, direct-call `POST /access/invite {email, role:0, method:1}` (bypassing the UI to request Owner).
  3. As Olivia, direct-call `PUT /access/members/{someId}/role {role:0}`.
- **Expected:** UI — the invite "Access level" list is `GRANTABLE_ROLES` = Admin / Limited / Read-only only; Owner is never offered. API — both direct attempts to assign Owner return **400** validation `A household can only have one owner.` The single-owner invariant holds by construction across both entry points. (See INV-026, PPL-049.)
- **Automated:** Partial (`HouseholdAccessTests.cs` invite/role validators; UI list asserted in INV-003/PPL-049)

### ROLE-030 - The Owner cannot leave their own household (400, not a role denial)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Olivia is Owner of H1; H1 is her active household.
- **Steps:**
  1. As Olivia, on `/account`, confirm Leave household is absent: the Household card has no ⋯ (it renders only when the active household is one she *joined*, `!isOwn`).
  2. As Olivia, direct-call `POST /households/leave {ownerId: <H1 owner id = her own id>}`.
- **Expected:** UI — no Leave household (no Household ⋯) for an owner viewing their own household. API — **400** `You can't leave your own household.` (and the belt-and-braces `The owner can't leave their own household.` on the Owner-role row). This is a *business-rule* refusal (400), not the role-pipeline 403 — `/households/leave` is `[Authorize]`-only with no role gate; every role may call it, but the owner-of-active-household is refused on the merits.
- **Automated:** No (journey `invite.spec.ts` exercises a *joined* member leaving, not the owner-refusal path)

### ROLE-031 - "Exactly one Owner" holds across the full household lifecycle
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** H1 from registration through invites, role changes, revokes, leaves.
- **Steps:**
  1. Register Olivia → owner membership + owner member #1 seeded.
  2. Invite Adam/Lena/Rhea with Admin/Limited/Read-only; accept.
  3. Change roles among the three; revoke one; have another leave.
  4. Throughout, query `/access/members` and count `isOwner:true` rows.
- **Expected:** There is always exactly one `isOwner:true` membership (Olivia). No invite can create a second (ROLE-029); the owner cannot be demoted (ROLE-027), removed (ROLE-028), or leave (ROLE-030). Revoke/leave hard-delete non-owner rows only. `OwnerId` is the household key and never re-keyed.
- **Automated:** Partial (`MembershipSeederTests.cs` — "exactly one owner membership per user, idempotent"; lifecycle not asserted end-to-end)

---

## Self-service actions open to every role

### ROLE-032 - Change own password / preferences / consent works for every role incl. Read-only
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Rhea signed in to H1 as Read-only.
- **Steps:**
  1. As Rhea on `/account`, use "Change" on the Password row (the "Change password" dialog: current + new + confirm).
  2. Save "Preferences" (name via the pencil, currency, number format).
  3. If `needsConsent`, click "I agree" in the ConsentModal.
- **Expected:** All succeed (200/204). These are `[Authorize]`-only `/auth/*` endpoints, not MediatR household commands, so the role pipeline never touches them — a Read-only member fully controls their own login, display name and money-format preferences. Role gating governs *household* data, never *self* settings. (The currency part of the save is the login's own household's budget currency: it is refused once that household holds an account, month or transaction — PREF-042 — whatever the role; re-sending the same code is fine.)
- **Automated:** Partial (`AccountPage.test.tsx` covers change-password + preferences; `AccountPage.catalog.test.tsx` PREF-033 asserts the pencil, Save and "Change" enabled and a preferences save under a Read-only role)

### ROLE-033 - Switch / start-own / leave household are available to every role (not role-gated)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Rhea (Read-only in H1) who also belongs to another household, or is a pure invitee.
- **Steps:**
  1. As Rhea, use the account-menu "Household" switcher to switch to another household.
  2. If Rhea has no own budget, on `/account` use "Start" on the Household card's "Your own budget" row (named "Start my own budget").
  3. As Rhea (a joined member), use the Household card's ⋯ → "Leave household" → "Yes, leave".
- **Expected:** All succeed regardless of Rhea's Read-only role in H1. `/households/switch|start-own|leave` are `[Authorize]`-only controller actions with no role check — a Read-only member is not a prisoner: they can leave, start their own (Owner-of-self) budget, or switch away. `start-own`/`leave` never seed sample figures (PR #170). In her own new household she is Owner.
- **Automated:** Partial (journey `invite.spec.ts` — a joined member leaves via the Household ⋯ `Leave household`/`Yes, leave`; that member happened to be a fresh accepter, role-agnostic; journey `households-roles.spec.ts` — a Limited member starts their own budget and later leaves)

### ROLE-034 - Reports are viewable by every role incl. Read-only (owner-scoped, no role gate)
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** H1 with several months of data. Rhea (Read-only).
- **Steps:**
  1. As Rhea, open `/reports`; view trends, spending-by-category, the "Saved this month"/"Avg monthly spend"/"Savings rate" tiles, switch the breakdown month, page the annual overview year.
- **Expected:** Everything renders with live H1 figures. `GetBudgetTrendsQuery` and `GetAnnualSummaryQuery` are Queries → all roles (subject to `FeatureGate(Reports)`). No write exists on this page, so there is nothing to gate beyond the flag.
- **Automated:** No (`ReportsPage.test.tsx` covers content, not per-role access)

---

## Role resolution & multi-household

### ROLE-035 - Role is resolved per request from the ACTIVE household — one login, two roles
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** Lena's login is **Limited in H1** and **Owner in H2** (her own). Both households in her switcher.
- **Steps:**
  1. As Lena with H1 active, GET `/auth/me` and read `role`; attempt `POST /budget/categories`.
  2. Switch to H2 (active), GET `/auth/me`; attempt `POST /budget/categories` in H2.
- **Expected:** With H1 active, `role = 2 (Limited)` and the category POST → **403**. With H2 active, `role = 0 (Owner)` and the same POST → **201**. `HouseholdResolutionMiddleware` resolves the role per request from `ActiveOwnerId` via `ActiveHouseholdSelector.Pick` — the JWT carries no role, so the *same login* has different permissions depending on which household is active.
- **Automated:** Partial (`ActiveHouseholdSelectorTests.cs` covers the selection logic; the per-role HTTP effect is not journey-tested)

### ROLE-036 - Switching households changes effective permissions live (next request)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Lena as in ROLE-035 (Limited in H1, Owner in H2). See CONC-030 for the multi-tab stale-scope variant.
- **Steps:**
  1. As Lena with H1 active on `/`, note write controls hidden (Limited).
  2. Use the account-menu switcher to select H2 → full `window.location.assign('/')` re-bootstrap.
  3. After reload, observe controls on `/` and re-check `useAuth()` gates.
- **Expected:** After the switch + reload, `/auth/me` returns `role = 0` for the now-active H2, so `canWrite`/`canManageHousehold` become true and the budget-editing affordances appear. The switch itself returns 204 and takes effect on the *next* request; the client's full reload guarantees fresh role resolution. `ActiveOwnerId` is cleared to null when switching to her own household.
- **Automated:** No

### ROLE-037 - AcceptInvite is gated by the accepter's CURRENT active-household role (Limited/Read-only 403)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #156 (accept must land you IN the joined household) + `AuthorizationBehaviour` gotcha #25 — `AcceptInviteCommand` ends in "Command", carries neither `[AllowLimited]` nor `[OwnerOnly]`, so a signed-in accepter whose *current* active role is Limited/ReadOnly is 403'd before the handler runs. Also covered as PPL-054 / INV-042.
- **Preconditions:** Lena is signed in with an active household where her role is **Limited or Read-only** (e.g. H1). Olivia (or another owner) sends Lena a link invite to a *different* household H3.
- **Steps:**
  1. As Lena (active role Limited), open `/accept-invite?code=…` for H3 and click "Accept invite" (signed-in path, POSTs token only).
  2. Repeat with Lena's active role set to Read-only.
  3. As a control, repeat with Lena's active role Owner/Admin.
  4. As a second control, accept the SAME invite anonymously (fresh browser, new login).
- **Expected:** Steps 1–2 → **403** `Your access level (Limited|ReadOnly) does not permit this action.` — the pipeline resolves Lena's role from her *current* active household (not the household she's trying to join) and blocks the command. Step 3 → success (lands in H3, `?joined=1`). Step 4 → success (anonymous accept has no resolved role, so ROLE-004's skip applies). This is a **known defect**: a Limited/Read-only member of one household cannot accept an invite to another without first switching to a household where they are Admin/Owner. Assert the current behavior and flag it.
- **Automated:** Partial (`HouseholdAccessTests.cs` covers signed-in accept happy paths; the role-blocked path is not directly asserted)

---

## Role changes taking effect

### ROLE-038 - Demote Admin → Read-only mid-session: server refuses immediately, UI lags until /auth/me
- **Priority:** P0
- **Type:** Regression
- **Origin:** Gotcha #16 — role changes are server-live but client-lazy (`canWrite`/`canAccess` refresh only on `/auth/me`). Also covered as CONC-025.
- **Preconditions:** Adam is Admin in H1 with the app open on `/`. Olivia demotes him to Read-only.
- **Steps:**
  1. Olivia: on `/people`, change Adam's role to "Read-only" (`PUT /access/members/{adamId}/role {role:3}`).
  2. Adam (without reloading): click an existing write control, e.g. submit a planned-line edit (`PUT /budget/items/{id}`).
  3. Adam: trigger a `/auth/me` refetch (reload, tab focus after token change, or navigation that refires it).
- **Expected:** Step 2 → **403** immediately — the server re-resolves Adam's role every request, so the very next write is refused even though his stale SPA still shows the button (`canWrite` cached from the old `/auth/me`). Step 3 → `/auth/me` returns `role=3`; the write affordances disappear and the read-only banner appears. No data is written in the interim. UI is cosmetically stale; the server is authoritative.
- **Automated:** No (CONC-025 documents the manual scenario; no automated coverage of live role downgrade)

### ROLE-039 - Upgrade Limited → Admin mid-session: server allows immediately, UI reveals affordances on next /auth/me
- **Priority:** P1
- **Type:** Regression
- **Origin:** Gotcha #16 (server-live, client-lazy). Also covered as CONC-026.
- **Preconditions:** Lena is Limited in H1 with the app open. Olivia promotes her to Admin.
- **Steps:**
  1. Olivia: change Lena's role to "Admin" (`PUT /access/members/{lenaId}/role {role:1}`).
  2. Lena (without reloading): direct-call `POST /budget/categories`.
  3. Lena: after a `/auth/me` refetch, look for the budget-structure controls on `/`.
- **Expected:** Step 2 → **201** immediately — the server already sees Lena as Admin on the next request, even before her SPA knows. Step 3 → once `/auth/me` returns `role=1`, `canWrite` flips true and the structure-editing affordances (Add group, planned inputs, Import link, account/jar management) appear. The privilege is live server-side; the UI merely catches up.
- **Automated:** No

### ROLE-040 - The invite-assigned role governs the accepter immediately, end-to-end
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Olivia invites a new person "Robin" to H1 with "Access level" = **Read-only** (link method). Robin accepts anonymously. Also covered as INV-050.
- **Steps:**
  1. Olivia: `/people` → invite Robin as Read-only → "Send invite" (the link arrives in Robin's email).
  2. Robin: open the link in a fresh browser, set a password, accept terms, "Accept invite".
  3. Robin (now in H1): GET `/auth/me`; attempt `POST /transactions`.
- **Expected:** Robin lands inside H1 (`?joined=1`) with `role=3`. His first write attempt (`POST /transactions`) → **403**, and the read-only banner shows. The role chosen at invite time is the role stamped on the membership and resolved on Robin's very first authenticated request — no delay, no default-to-something-else.
- **Automated:** Partial (`HouseholdAccessTests.cs` — accept activates membership with the invited role; INV-050 asserts the landed role)

### ROLE-041 - Revoked membership → immediate 403/404 and graceful fallback to own household
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** Rhea is Read-only in H1 (which is her active household) with the app open. Olivia revokes Rhea's sign-in. Also covered as CONC-027.
- **Steps:**
  1. Olivia: on `/people`, "Remove" Rhea's sign-in (`DELETE /access/members/{rheaId}`, hard-delete).
  2. Rhea (without reloading): make any H1 request, e.g. GET `/members` or attempt any command.
  3. Rhea: reload / next `/auth/me`.
- **Expected:** After revoke, Rhea has no Active membership in H1. Her next request re-resolves via `ActiveHouseholdSelector`: `ActiveOwnerId` no longer matches → falls back to her own household (or a synthesized Owner-of-self entry). She does NOT get stuck or see an error page — she silently lands in her own budget; H1's data is no longer visible to her. Her login is untouched (leave/revoke hard-delete only the membership row; "Nothing was deleted" concerns budget data). If she had zero own household seeded, note the phantom-own-household edge (CONC-034 / PPL-064).
- **Automated:** No

---

## UI / enforcement divergence & client fallbacks

### ROLE-042 - Fresh tab renders provisional Owner chrome before /auth/me corrects the role
- **Priority:** P1
- **Type:** Regression
- **Origin:** `AuthContext` seeds `role` from `localStorage['zbb.role']` with a **default of Owner** on a fresh tab (`storedRole()`); `RoleGating.test.tsx` pattern — write controls may flash then vanish once `/auth/me` resolves.
- **Preconditions:** Rhea (Read-only) opens a brand-new tab / hard navigation (access token is in-memory only, so a cold load bootstraps from the refresh cookie).
- **Steps:**
  1. As Rhea, hard-load `/transactions` (or `/`); observe the first paint before `/auth/me` resolves.
  2. Observe again after `/auth/me` returns `role=3`.
- **Expected:** On first paint the role may fall back to Owner (localStorage hint absent/stale → `storedRole()` default Owner), so write affordances can briefly appear. Once `/auth/me` resolves `role=3`, the controls disappear and the read-only banner shows. Crucially the **server never honors the provisional role** — any write attempted during the flash still 403s. The client gate is cosmetics; correctness lives server-side. Malformed `/auth/me` payloads are ignored and never downgrade a resolved role.
- **Automated:** Partial (`RoleGating.test.tsx` asserts controls disappear after `/auth/me` resolves for roles 2/3)

### ROLE-043 - AuthResponse.Role is provisional for multi-household logins; /auth/me is authoritative
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Lena (Limited in H1, Owner in H2) signs in via `POST /auth/login`.
- **Steps:**
  1. Inspect the `AuthResponse.role` returned by login/register/refresh.
  2. Inspect the `role` from the subsequent `/auth/me`.
- **Expected:** `AuthResponse.Role` is the FIRST active membership's role (`FirstOrDefault`, no deterministic ordering) — for a multi-household login it may not match the active household. The client treats it as provisional and corrects from `/auth/me` (resolved active-household role), which may cause a brief role flicker in the chrome. The server always enforces the *resolved* role per request, so the provisional value never grants extra power.
- **Automated:** Partial (`LoginTests.cs` — "success resolves member role"; the multi-household FirstOrDefault ambiguity is not asserted)

### ROLE-044 - Read-only sees fully live, current data on every page (view parity)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** H1 with rich data. Rhea (Read-only). Owner/Admin make a change concurrently.
- **Steps:**
  1. As Rhea, visit `/`, `/transactions`, `/accounts`, `/accounts/{id}`, `/jars`, `/people`, `/allocation`, `/reports`.
  2. Have Adam add a transaction / edit a planned line; Rhea re-loads the relevant page.
- **Expected:** Every page renders the household's real, current figures (budget planned/actual, derived balances, jar funded %, member shares, allocation preview, reports). Rhea's view reflects Adam's changes on refresh. Read-only is a *view* restriction, not a *data* restriction — she sees everything the writers see, only without the controls and with the read-only banner.
- **Automated:** Partial (`RoleGating.test.tsx` shows the transaction row still renders for role 3; whole-app parity not automated)

### ROLE-045 - Client canWrite mirrors the server, but the server is authoritative
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Any state where a client shows a write control it shouldn't (stale role after demotion — ROLE-038; provisional Owner flash — ROLE-042; a hand-crafted request).
- **Steps:**
  1. Force a client into showing a write control for a role that the server denies (e.g. demoted Admin pre-`/auth/me`).
  2. Click it / replay the request.
- **Expected:** The request reaches the server and is refused with **403** by `AuthorizationBehaviour` using the freshly resolved role. No optimistic client update persists (failed writes roll back and surface an error). The rule for QA: **never trust the presence of a UI control as proof of permission** — always assert the API status too. Client gates reduce noise; the pipeline is the enforcement boundary.
- **Automated:** No

---

## Role personas end-to-end

### ROLE-046 - Read-only across every page: no write affordance anywhere, banner present
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Rhea (Read-only) in H1, all flags on.
- **Steps:**
  1. As Rhea, walk `/` (budget), `/transactions`, `/accounts` (+ detail), `/jars`, `/people`, `/allocation`, `/reports`, `/import` (direct URL), `/account`.
  2. On each, enumerate every mutating control.
- **Expected:** Zero write affordances render: no add/edit/delete/reorder on budget; no "Add transaction"/edit/assign/split/transfer; no account or jar management; no member CRUD, invite, role, remove, or "Other sign-ins"; no allocation Settings, Allocate or Link account; no Import link. The read-only banner shows on every authenticated page. `/account` self-service (password/prefs/consent/switch/start-own/leave) remains fully available (ROLE-032/033). Any direct API mutation → 403.
- **Automated:** Partial (`RoleGating.test.tsx` covers Transactions + banner for role 3; not a full-page sweep)

### ROLE-047 - Admin has full write parity EXCEPT household-access management and owner ops
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Adam (Admin) in H1, all flags on.
- **Steps:**
  1. As Adam, exercise: create month, category/line CRUD + reorder, set-bill + mark-paid, transaction CRUD/split/assign/transfer, account CRUD, jar CRUD, allocation profile save + commit, import preview + commit, member add/edit/archive.
  2. As Adam, attempt: invite, change role, link, revoke, and demoting/removing the owner.
- **Expected:** Step 1 — all succeed (Admin = `!ownerOnly`, so every non-owner-only command runs). Step 2 — all **403** (every `HouseholdAccess` command is `[OwnerOnly]`); Adam sees none of those controls on `/people`. Admin is "everything except managing members and access" — exactly the `HOUSEHOLD_ROLE_HINTS` text. Admin CAN do member (person) CRUD, but NOT access/login management.
- **Automated:** Partial (`AuthorizationBehaviourTests.cs` — "Admin all commands except owner-only"; UI parity not automated)

### ROLE-048 - Limited "data entry" scope, end-to-end (the exact allow/deny set)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Lena (Limited) in H1, all flags on.
- **Steps:**
  1. As Lena, confirm she CAN: add/edit/delete/split/assign transactions, record transfers, mark a bill paid/unpaid, and run allocation commit.
  2. As Lena, confirm she CANNOT (403 + control hidden): create a month; category/line CRUD or reorder; set/clear a bill's due day; account CRUD; jar CRUD; import (even preview); allocation profile save; member CRUD; any invite/role/link/revoke.
- **Expected:** Lena's allow-set is exactly the `[AllowLimited]` commands — the 6 transaction commands + `SetBudgetItemPaidCommand` + `AllocateIncomeCommand` — matching her banner ("record transactions, mark bills paid and run allocation, but not change the budget structure or settings") and hint ("Day-to-day entry: transactions, mark bills paid, run allocation."). Everything else is Admin+ or Owner-only and 403s server-side with the control hidden client-side. This is the definitive Limited boundary.
- **Automated:** Partial (`RoleGating.test.tsx` — "limited access keeps transaction entry available" + "cannot manage accounts"; `AuthorizationBehaviourTests.cs` — "Limited only AllowLimited commands")

### ROLE-049 - Household-access controls vanish for the Owner too when the HouseholdAccess flag is off (404, not role)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** H1 with `householdAccess` flag OFF (but `householdAllocation` ON). Olivia (Owner).
- **Steps:**
  1. As Olivia on `/people`, look for the role select / "Remove" / "Invite to sign in" / "Other sign-ins".
  2. As Olivia, direct-call `POST /access/invite` and `GET /access/members`.
- **Expected:** UI — `canAccess = features.householdAccess && canManageHousehold` is false, so even the Owner sees no access controls; PeoplePage tolerates `/access/members` failing and shows "No sign-in" placeholders. API — `HouseholdAccessController` has `FeatureGate(HouseholdAccess)`, so both calls return **404** (feature off), not 403. Feature availability is orthogonal to role: a disabled feature is invisible to everyone including the Owner, and the 404 masks the role check entirely (ROLE-008 precedence).
- **Automated:** No

---

## Gap-fill additions

### ROLE-050 - Switching to a household you have no ACTIVE membership in is refused (404, not a role denial)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Lena (Limited in H1, Owner in H2). A third household **H3** owned by someone else that Lena either has no membership in at all, or holds only an *Invited* (pending, not-yet-accepted) membership in. `/households/switch` is `[Authorize]`-only, no role gate.
- **Steps:**
  1. As Lena, direct-call `POST /households/switch {ownerId: <H3 owner id>}` where she has no membership in H3.
  2. As Lena holding only an *Invited* (unaccepted) membership in H3, repeat the switch.
  3. As Lena, `POST /households/switch {ownerId: <Lena's own user id>}` (her own household).
- **Expected:** Steps 1–2 → **404** `{error:"You don't have access to that household."}`. `HouseholdsController.Switch` requires `isOwn || an Active membership` at the target (`m.Status == MembershipStatus.Active` only) — an *Invited* row does NOT qualify, so a pending invitee must accept the invite (ROLE-037/040) before they can switch in. Step 3 → **204** (your own `userId` always qualifies via `isOwn`, even with no membership row — the self-owner fallback of ROLE-052). This is an **access-scope** refusal (you may only act inside households you actually belong to), orthogonal to the role pipeline: switch carries no role gate (ROLE-033), but the target must be one of your active households. On the 404 nothing is persisted — `ActiveOwnerId` is left unchanged (the NotFound returns before the user update).
- **Automated:** No (`ActiveHouseholdSelectorTests.cs` covers the `Pick` selection logic; the controller's `hasAccess`→404 refusal for a non-/pending-member is not asserted)

### ROLE-051 - Leaving a household you never joined is refused (404); leave is bounded to your own active memberships
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Rhea (Read-only in H1). A household **H4** Rhea has no Active membership in — never joined, or only *Invited*. `/households/leave` is `[Authorize]`-only, no role gate.
- **Steps:**
  1. As Rhea, direct-call `POST /households/leave {ownerId: <H4 owner id>}` where she has no Active membership there.
  2. As Rhea holding only an *Invited* membership in H4, repeat.
- **Expected:** Both → **404** `{error:"You don't have access to that household."}`. `Leave` looks up an **Active** membership for `(userId, ownerId)`; finding none it returns 404 and removes nothing. Leave is self-service (any role may call it — ROLE-033) but bounded: you can only leave a household you are an *active* member of, and an unaccepted invite is not a membership you can "leave". Contrast ROLE-030 (owner leaving their OWN household → **400** business rule) and ROLE-041 (a valid non-owner leave hard-deletes only that membership row and falls back to your own household). No `HouseholdMembership` row is deleted on this 404 path.
- **Automated:** No (journey `invite.spec.ts` exercises a valid member leave; the non-member 404 path is not asserted)

### ROLE-052 - A login with zero active memberships resolves as Owner of its own household (self-owner fallback)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A login with **no** `Active` `HouseholdMembership` rows — e.g. a brand-new registrant in the instant before its owner-membership row is seeded, legacy pre-membership data, or a member whose sole membership was just revoked and whose own household is not yet materialized. `HouseholdResolutionMiddleware` runs after authentication on every request.
- **Steps:**
  1. As such a login, make any authenticated request and read the resolved context (`/auth/me` `role`).
  2. Attempt an Admin+ command against their OWN data, e.g. `POST /budget/categories`.
  3. Attempt to read or write ANOTHER household's data by id.
- **Expected:** With zero Active memberships the middleware takes its `else` branch: `household.OwnerId = userId`, `household.Role = HouseholdRole.Owner`, `household.Resolved = true` — the caller is treated as **Owner of their own household**, so `role = 0` and step 2 → **201** (Owner ⇒ always permitted). This is distinct from ROLE-004's `role is null ⇒ skip`: here a role IS resolved (Owner), so `AuthorizationBehaviour` runs and *permits* rather than being bypassed. Step 3 → still only their own `OwnerId`-scoped data is reachable (every handler is owner-scoped; no Active membership grants any other household), so the self-owner role confers power over self only, never a foreign household. This fallback is why a freshly-registered or just-revoked login is never locked out of its own budget — it dovetails with ROLE-041's graceful post-revoke fallback and the phantom-own-household edge (PPL-064).
- **Automated:** Partial (`MembershipSeederTests.cs` / `HouseholdBootstrapTests.cs` cover the seeded owner membership + idempotency; the middleware's zero-membership⇒Owner resolution is not directly asserted)

### ROLE-053 - The role gate triggers only on the "Command" type-name suffix, and fails closed on an unrecognized role
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Source: `AuthorizationBehaviour.Handle` computes `isCommand = type.Name.EndsWith("Command", Ordinal)` and calls `IsPermitted` **only** when `isCommand`; the role `switch` in `IsPermitted` carries a `_ => false` default arm. Every MediatR request in the codebase is named `…Command` (writes) or `…Query` (reads).
- **Steps:**
  1. Enumerate the MediatR requests dispatched from every controller; confirm each mutating one ends in `Command` and each read ends in `Query`.
  2. Reason through a hypothetical request whose type name ends in neither (e.g. `…Request`, `…Job`) as it passes `AuthorizationBehaviour`.
  3. Reason through a resolved role value outside {Owner, Admin, Limited, ReadOnly} (a corrupt/out-of-range persisted role) dispatching a Command vs a Query.
- **Expected:** (1) The naming convention is **load-bearing enforcement** — only `…Command` requests are role-checked; `…Query` requests bypass the gate entirely (as ROLE-002 asserts for reads). (2) A request ending in *neither* suffix is treated like a Query: `isCommand` is false, `IsPermitted` is never consulted, and **no role check fires** — a state-changing request not named `…Command` would silently escape role gating. QA/security invariant: audit that every mutating request type ends in `Command` (not a bare `…Request`/handler that writes), because the suffix, not the effect, is what the pipeline keys on. (3) An unrecognized role hitting a Command falls through `_ => false` ⇒ **403** (fails **closed** — denies, never grants), while the same role on a Query still passes (queries never reach `IsPermitted`). The pipeline never fails open on an unknown role, but it *does* depend on the suffix convention to recognize a write as a write.
- **Automated:** Partial (`AuthorizationBehaviourTests.cs` proves the Command/Query split and the four defined role arms; the non-Command/non-Query bypass and the `_ => false` fail-closed default arm are not separately asserted)
