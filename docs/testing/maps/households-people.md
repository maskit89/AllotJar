# Subsystem map: Households, members, invites, roles

Ground-truth feature inventory for QA test design. All paths relative to repo root `<local>\Documents\Projects\ZeroBudget`. Verified against source on 2026-07-15 (post PR #156/#158/#170/#171/#172, all live on beta).

**Two distinct concepts (never conflate):**
- **Budget person** = `HouseholdMember` (src/AllotJar.Domain/Entities/HouseholdMember.cs) — name, `NetMonthlyIncome` decimal(18,4), optional `PersonalSavingsAccountId` (soft hint, NO FK), `DisplayOrder`, `IsArchived`. No login required.
- **Login access** = `HouseholdMembership` (src/AllotJar.Domain/Entities/HouseholdMembership.cs) — `OwnerId` (household partition key = creator's Identity user id), nullable `UserId` (null while link invite pending), `Role`, `Status` (Active=0/Invited=1), `InvitedEmail`, `DisplayName`, `InviteTokenHash` (SHA-256 hex), `InviteExpiresUtc`, optional `MemberId` (soft 1:1 link to the budget person, no FK), `CreatedUtc`.

Roles (`src/AllotJar.Domain/Enums/HouseholdRole.cs`): Owner=0, Admin=1, Limited=2, ReadOnly=3.

---

## 1. Screens & routes

| Route | Component | Guard / gating | Notes |
|---|---|---|---|
| `/people` | `PeoplePage` (client/src/pages/PeoplePage.tsx) | `RequireAuth` + mounted only when `features.householdAllocation` (client/src/App.tsx:120-129) | Unified people page (budget persons + sign-ins). Nav item "People" ALWAYS shown when flag on — NOT gated on isShared (client/src/components/AppNav.tsx:37) |
| `/members` | redirect → `/people` (App.tsx:131) | none | legacy |
| `/access` | redirect → `/people` (App.tsx:132) | none | legacy |
| `/accept-invite` | `AcceptInvitePage` (client/src/pages/AcceptInvitePage.tsx) | PUBLIC — no RequireAuth (App.tsx:69) | Reads `?code=` query param. Renders differently for signed-in vs anonymous |
| `/account` | `AccountPage` (client/src/pages/AccountPage.tsx) | `RequireAuth` (App.tsx:153-160) | Its Household card hosts the sharing row, "Your own budget" (start-own) and, behind its ⋯, Leave household |
| `/login?returnUrl=…&reason=expired` | `LoginPage` | if already authed → `AuthedLoginRedirect` honours `returnUrl` via `safeInternalPath` (App.tsx:51-54, 63-68) | returnUrl round-trip for invite links (LoginPage.tsx:25, 76) |
| `/` + `?joined=1` / `?started=1` / `?left=1` | DashboardPage inside `AppShell` | authed | One-time greeting banner in AppShell (client/src/components/AppShell.tsx:171-258); param stripped via `history.replaceState` so refresh doesn't repeat it (AppShell.tsx:181-183) |

Other chrome in this subsystem:
- **Household switcher** — lives in the **account/user menu** (`UserMenu` in AppShell.tsx:24-138): a "Household" section listed only when `households.length > 1` (AppShell.tsx:88-112). The standalone `client/src/components/HouseholdSwitcher.tsx` component exists and is unit-tested but is **NOT rendered anywhere in the app** (only its test imports it) — dead component; test the UserMenu instead.
- **ConsentModal** (client/src/components/ConsentModal.tsx) — blocking, non-dismissible dialog when `/auth/me` returns `needsConsent: true` (invite-created / legacy logins with `ConsentedUtc == null`). Rendered for any authed route EXCEPT `/terms` and `/privacy` (never covers the text being consented to). Onboarding is suppressed until consent is given (App.tsx:183-184).
- **Access banner** (AppShell.tsx:164-169): read-only → "Read-only access: you can view everything, not change it." (the full explanation behind its (i) "About your access"); limited → "Limited access: you can record transactions, mark bills paid and run allocation." (what an admin keeps behind its (i) "About your access")

## 2. UI controls & user actions (exact labels)

### PeoplePage (`/people`)
Hero: eyebrow "Combined income" (formatted total), tiles "People" (count) and "Shared this month" (sum of member spending) (PeoplePage.tsx:364-372).

Section header "Your household".
- **"+ Add person"** button — shown only when `canWrite` (Admin+) (PeoplePage.tsx:382-386). Opens modal **"Add a person"**: fields "Name" (placeholder "First name"), "Net monthly income" (placeholder "0.00", Enter submits), "Savings account" select (only rendered when `accounts.length > 0`; option "None"); buttons "Cancel" / "Add person" (PeoplePage.tsx:607-664).
- Members table columns: Person / Income / Share / Spent / Savings / "Sign-in & access". "You" sub-label on the row whose person is linked to the current login (PeoplePage.tsx:435).
- **Row hover actions** (canWrite only): "✎" (aria `Edit {name}`, title "Edit person") switches the row to inline edit (name, income, savings-account select incl. "None"); then "Save" / "Cancel". "✕" (aria `Archive {name}`, title "Archive person") archives immediately — **no confirm dialog** (PeoplePage.tsx:545-592).
- **Sign-in & access cell** per person:
  - Person has a linked login: shows the login email; amber Badge "Invited" when status=Invited; role control:
    - owner login → brand Badge with role label;
    - self (current login) → static bordered role label;
    - other logins, when `canAccess` (= `features.householdAccess && canManageHousehold`, PeoplePage.tsx:99) → role `<select>` (aria `Access level for {name}`) with options Admin/Limited/Read-only + **"Remove"** button (aria `Remove sign-in for {name}`) (PeoplePage.tsx:480-517).
  - Person without login, `canAccess`: **"Invite to sign in"** dashed pill; plus **"This is me"** button (title "Connect your sign-in to this person") shown on every unlinked person row when the current login itself is unlinked (`myUnlinked`) (PeoplePage.tsx:519-539).
  - Person without login, NOT canAccess: static text "No sign-in" (PeoplePage.tsx:540-542).
- Empty state (0 members — practically unreachable, see §7): title "Budgeting on your own?" with copy about adding partner/housemate (PeoplePage.tsx:389-394).

### Invite modal (owner-only; opened from a person row, so `memberId` is always pre-bound to that person)
Title `Invite {person} to sign in` (PeoplePage.tsx:667-672). Controls:
- "Email" input (placeholder "sam@example.eu")
- "Access level" select — options **Admin / Limited / Read-only only** (`GRANTABLE_ROLES`, PeoplePage.tsx:28; Owner is never grantable); hint line under it from `HOUSEHOLD_ROLE_HINTS` (types.ts:453-458: Owner "Full control, including managing who has access."; Admin "Everything except managing members and access."; Limited "Day-to-day entry: transactions, mark bills paid, run allocation."; Read-only "View everything; cannot make changes.")
- SegmentedControl "How should they get access?": **"Email an invite link"** (default) | **"Set a temporary password"**
- direct mode: "Temporary password" input (placeholder "At least 8 characters") + helper "Only works for someone without an account yet."
- link mode: helper paragraph "A one-time link is created for you to copy and send. If they already have an account, they accept it while signed in; otherwise they set a password when they open it."
- Submit button: "Send invite" / "Create login" (busy: "Inviting…")
- Success (link): status box "Invite sent" + "We've emailed {email} a one-time link. It expires in 7 days." The link (`{AppBaseUrl}/accept-invite?code=${token}`) is emailed to the invited address by `AccountEmails.SendInviteLink` and never shown to the owner (#298).
- Success (direct): box "Login created" + "We've emailed {email} a link to choose their own password. Until they do, the temporary password you set only lets them sign in to see that prompt." (S-P2-3: the login is marked `MustChangePassword` and gets a "Choose your AllotJar password" email.)

### "Other sign-ins" card (PeoplePage.tsx:780-839)
Shown only when `canAccess` and there exist memberships with `memberId == null` and `!isSelf` (orphan logins). Per row: displayName/email, Badge "Invited"/"Active", role Badge, select **"Link to a person…"** (options = members not already claimed), **"Remove"** button (hidden for owner/self).

### AcceptInvitePage (`/accept-invite?code=…`)
- No code: alert "This invite link is missing its code. Ask the household owner to send you a fresh link."
- Header: "Household invite" / "Join the household" + pitch copy.
- **Signed-in path**: note "You're signed in as {email}. Joining adds this household to your account — your own budget stays exactly as it is, and you can switch between them." + button **"Accept invite"** ("Please wait…" while busy). POSTs `{token}` only; on success `window.location.assign('/?joined=1')` (full reload so /auth/me picks up the server-side active-household change) (AcceptInvitePage.tsx:56-71).
- **Anonymous path** form: "Your name (optional)" (placeholder "e.g. Sam"), "Password" (required, minLength 8, placeholder "At least 8 characters"), required terms checkbox "I agree to the Terms of Service and Privacy Policy" (links open in new tab), button **"Accept invite"**, link **"Sign in to accept"** → `/login?returnUrl=/accept-invite?code=…` (AcceptInvitePage.tsx:38, 122-205). On success SPA-navigates to `/?joined=1`.
- **"Not now"** button → `/` if authed else `/login` (AcceptInvitePage.tsx:208-214).

### AccountPage (`/account`, "Account settings"; restyle PR 12)
- Profile ("Your account" card): name, email, and the access level chip (role label; what it allows behind its (i) "About access level").
- **Household** card: the sharing row (a quiet aria-hidden placeholder row while household loading): shared → the people's faces (`role="img"` "Shared between N people") and names ("Alex & Sam"), the row one link **"Manage people"** → `/people`; solo → "Just you" ("You're budgeting on your own…" behind its (i) "About sharing") + outline button **"Share this budget"** → `/people`.
- **"Your own budget"** row (Household card) — only when `!ownsHousehold` (`households.some(h => h.isOwn)` false, i.e. pure invitee): copy behind its (i) "About your own budget" ("You're a member of a shared household. Want a budget of your own too? …") + button **"Start"** (named "Start my own budget"; "Setting up…" busy). Doesn't wait for `/members`.
- **Leave household** — only when the ACTIVE household is a joined one (`activeHousehold && !activeHousehold.isOwn`): the Household card's ⋯ **"Household: more actions"** → **"Leave household"** → the Leave dialog "Leave {label}’s household?" ("Leave this household?" when the owner has no name and the server's label is the generic "Household") ("You’ll no longer see its budget, and the owner isn’t needed to do this. You can be invited back anytime." + the private-accounts warning when there are any) with **"Cancel"** and tinted-danger **"Yes, leave"** ("Leaving…" busy; nothing closes the dialog meanwhile).

### UserMenu (AppShell)
Avatar chip shows `{budgetCurrency} · {active household label}` (the ACTIVE household's budget currency from `/auth/me`, W08 — a member of a GBP household sees GBP whatever their own preference) (label = "Your household" for own, else owner displayName/email, fallback "Personal") (AppShell.tsx:47, AuthController.cs:354). Menu: "Household" section (only when >1 household) — one button per household, active one bold with "✓"; clicking a non-active one triggers `switchHousehold` → full `window.location.assign('/')` re-bootstrap (AuthContext.tsx:300-304); then "Account settings", "Sign out".

### Greeting banners (AppShell.tsx:242-247), all dismissible via "✕" (aria "Dismiss"):
- joined: "You’ve joined the household."
- started: "Your own budget is ready."
- left: "You’re back on your own budget."

### Analytics events fired (client/src/analytics/events.ts): `member_added`, `member_edited`, `member_invited` (+method), `member_role_changed` (+kind), `member_revoked`, `invite_accepted`.

## 3. API endpoints

All under `/api`. Numeric enum serialization on the wire (role, status, method).

### HouseholdsController (src/AllotJar.Api/Controllers/HouseholdsController.cs) — `[Authorize]`, `api/households`, NO feature gate
| Verb+route | Body | Auth/role | Behavior |
|---|---|---|---|
| POST `/households/switch` | `{ownerId}` | any authed login | 404 `{error:"You don't have access to that household."}` unless target is own household OR caller has an **Active** membership there. Sets `user.ActiveOwnerId` (null when switching to own). Returns 204; takes effect next request — client must refetch/reload (lines 39-73) |
| POST `/households/start-own` | none | any authed login | `HouseholdBootstrap.EnsureOwnHouseholdAsync(seedSampleBudget:false)`; idempotent (already-own = just switch back); sets `ActiveOwnerId=null`. 204 (lines 82-112). **Never seeds sample budget** (PR #170) |
| POST `/households/leave` | `{ownerId}` (Required) | any authed login | 400 `{error:"You can't leave your own household."}` when `ownerId==userId`; 404 `{error:"You don't have access to that household."}` when no Active membership; 400 `{error:"The owner can't leave their own household."}` belt-and-braces on Owner-role row; **hard-deletes** the membership row; then idempotently materializes caller's own household (no samples) and resets `ActiveOwnerId` to null if they were viewing the left household. 204 (lines 119-174) |

### MembersController (src/AllotJar.Api/Controllers/MembersController.cs) — `[Authorize]`, `[FeatureGate(HouseholdAllocation)]` (flag off → **404**), `api/members`
| Verb+route | Body | Role gate (MediatR AuthorizationBehaviour) | Behavior |
|---|---|---|---|
| GET `/members?includeArchived=` | — | any role (query) | Active members of the ACTIVE household ordered `DisplayOrder, Name`; archived included only when `includeArchived=true` |
| GET `/members/spending` | — | any role | Per-active-member attributed expense totals. Split tx counted via slices (`slice.MemberId`), unsplit tx via `t.MemberId` — never both. **NO month/date filter** — all-time (GetMemberSpendingQueryHandler.cs) |
| POST `/members` | `{name, netMonthlyIncome, personalSavingsAccountId?}` | **Admin+ (default command rule)** | Trims name; validates savings account belongs to household (else 404 `Account {id} was not found.`); `DisplayOrder = max+1`; 201 with `HouseholdMemberDto` |
| PUT `/members/{id:guid}` | same | Admin+ | 404 `Household member {id} was not found.`; 403 if `member.OwnerId != currentOwner` |
| PUT `/members/{id:guid}/archive` | `{archived:bool=true}` | Admin+ | Soft archive/restore. Same 404/403 rules |

### HouseholdAccessController (src/AllotJar.Api/Controllers/HouseholdAccessController.cs) — `[Authorize]`, `[FeatureGate(HouseholdAccess)]` (flag off → 404), `api/access`
| Verb+route | Body | Role gate | Behavior |
|---|---|---|---|
| GET `/access/members` | — | **any role** (query — even Read-only sees the full membership list incl. emails) | Memberships of active household ordered `Role, CreatedUtc` → `MembershipDto{id,email,displayName,role,status,memberId,isOwner,isSelf,createdUtc}` |
| POST `/access/invite` | `{email, role, method, tempPassword?, displayName?, memberId?}` | **[OwnerOnly]** — Admin gets 403 | Rate-limited (`[EnableRateLimiting("auth")]` — 20/min/IP fixed window, Program.cs:57-67, 429 on excess). See §4 for validation. Direct: creates login (ConsentedUtc=null → consent modal on first sign-in), membership Active. Link: 256-bit token, SHA-256 hash stored, `InviteExpiresUtc = now+7d`, Status=Invited. Returns `InviteResponse{membership, emailSent}` (the email is sent before answering; `emailSent:false` shows a one-line warn-tone `Notice` alert "… but the email failed" with the retry behind its (i), restyle PR 20). Outside Development, with only the logging email fallback, it answers 400 "Email isn't set up on this server yet…" before creating anything. A link invite's raw token is emailed to the invited address only; a direct invite emails a set-password link (#298) |
| PUT `/access/members/{id:guid}/role` | `{role}` | [OwnerOnly] | 404 `Membership {id} was not found.` (scoped to own household); 403 `The owner's role cannot be changed.` on the Owner row; validator rejects role=Owner |
| PUT `/access/members/{id:guid}/link` | `{memberId?}` (null = unlink) | [OwnerOnly] | Member must exist in household (404); 1:1 — 400 `That budget person is already linked to another login.` if claimed by another membership |
| DELETE `/access/members/{id:guid}` | — | [OwnerOnly] | 403 `The owner cannot be removed from the household.`; else **hard-deletes** the membership row. 204 |

### AuthController endpoints in scope (src/AllotJar.Api/Controllers/AuthController.cs)
| Verb+route | Notes |
|---|---|
| POST `/auth/accept-invite` | `[AllowAnonymous]` + auth rate limit. Body `{token, password?, displayName?, acceptedTerms}`. Dual path (see §4). Returns full `AuthResponse` (JWT) + sets refresh cookie (lines 143-160) |
| POST `/auth/register` | Seeds own household via `HouseholdBootstrap` with `seedSampleBudget: request.IncludeSampleData` (**opt-in**, PR #170) (lines 106-107) |
| GET `/auth/me` | Returns `MeResponse` incl. `role` (resolved active-household role), `ownerId` (active household), `memberId`, `households[]` (`{ownerId,label,role,isActive,isOwn}` — own first, then by label; synthesizes a lone "Your household" entry when the login has zero membership rows), `needsConsent` (`ConsentedUtc is null`) (lines 260-294, 333-368) |
| POST `/auth/consent` | `[Authorize]`; idempotently stamps `ConsentedUtc`. 204 (lines 301-330) |

**Role enforcement pipeline** (src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs): requests ending "Query" → all roles; "...Command" → Admin+ by default; `[AllowLimited]` opens to Limited (only on: Create/Update/Delete/Split/Assign Transaction, CreateTransfer, SetBudgetItemPaid, AllocateIncome — none in this subsystem); `[OwnerOnly]` → Owner only; **ReadOnly can execute NO command**. Failure → 403 `Your access level ({role}) does not permit this action.` When `Role` is null (middleware bypassed) enforcement is skipped and only per-handler OwnerId scoping protects data.

**Household resolution** (src/AllotJar.Api/Middleware/HouseholdResolutionMiddleware.cs): per request, after authentication; loads all Active memberships for the login, picks via pure `ActiveHouseholdSelector.Pick` (src/AllotJar.Application/Common/Households/ActiveHouseholdSelector.cs): `ActiveOwnerId` match → own household → first membership. Zero memberships → caller owns their own household with Owner role. Role is resolved server-side per request (NOT baked in JWT), so revoke/downgrade/switch takes effect immediately on the next request.

**Exception→HTTP mapping** (src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs): ValidationException → 400 `{status,title:"Validation failed",errors:{Field:[...]}}`; NotFoundException → 404; ForbiddenAccessException → 403; other → 500 "An unexpected error occurred.".

**Feature flags** (src/AllotJar.Api/Features/FeatureFlags.cs): `HouseholdAllocation` and `HouseholdAccess` both default ON; configurable via `Features` config section; `GET /api/features` is anonymous; flag off → controller 404s (FeatureGateAttribute.cs). Client `FeatureContext` defaults all-on (client/src/features/FeatureContext.tsx:10-19).

## 4. Validation rules & exact error messages

### Server — InviteMemberCommand (Validator + Handler, src/AllotJar.Application/HouseholdAccess/Commands/InviteMember/)
- Email: NotEmpty, EmailAddress format, max 256.
- Role: in enum AND `!= Owner` → "A household can only have one owner."
- Method: in enum (Direct=0, Link=1).
- TempPassword (when Method=Direct): NotEmpty + min 8 → "Set a temporary password of at least 8 characters."
- DisplayName: max 120.
- Handler: email (trimmed) already has ANY membership row in household (incl. pending Invited) → 400 field `Email`: "That email already has access to this household."
- `memberId` set: must exist in household → 404 `Member {id} was not found.`; already claimed → 400 field `MemberId`: "That budget person is already linked to another login."
- Direct + email already has an account → 400 field `Email`: "That email already has an account — use 'Email an invite link' so they can accept it."
- Direct + Identity/HIBP create failure → 400 field `Password` with Identity error descriptions (e.g. "This password has appeared in a known data breach. Please choose a different one." — BreachedPasswordValidator.cs:59; password policy: min 8, no non-alphanumeric requirement — Infrastructure/DependencyInjection.cs:67-68).

### Server — AcceptInviteCommand (src/AllotJar.Application/HouseholdAccess/Commands/AcceptInvite/)
- Token NotEmpty (validator); Password min 8 only when provided; DisplayName max 120.
- Lookup by token hash where `Status == Invited` → else 404 "This invite link is invalid or has already been used." (used links have hash nulled by `Activate`).
- Expired (`InviteExpiresUtc` null or past) → **403** "This invite link has expired." (expired row keeps Status=Invited, still blocks re-inviting the same email until the owner Removes it).
- **Path A (signed-in caller)**: invite email must equal caller's email, `OrdinalIgnoreCase` → 400 field `Email`: "This invite was sent to a different email address."; already a member of that household (another membership row) → 400 "You already have access to this household."; success: sets `UserId`, Status=Active, nulls token hash + expiry, DisplayName = `me.DisplayName ?? request.DisplayName`, then **server-side `SetActiveHouseholdAsync(userId, ownerId)`** so the accepter lands IN the joined household (PR #156). Own budget untouched.
- **Path B (anonymous)**: email already has an account → 400 field `Email`: "You already have an account — sign in first, then open this link to join."; password null/blank/<8 → 400 field `Password`: "Choose a password of at least 8 characters."; `AcceptedTerms` false → 400 field `AcceptedTerms`: "Please accept the terms and privacy policy to create your login."; create login with `consented: true` (ConsentedUtc stamped — no consent modal later); Identity failure → 400 field `Password`. Sets active household to the joined one. **Does NOT create an own household** — pure invitees have `ownsHousehold=false`.

### Server — Member CRUD (src/AllotJar.Application/Household/Commands/*)
- Name: NotEmpty → "A member needs a name."; max 120.
- NetMonthlyIncome: InclusiveBetween 0 and 99,999,999,999,999.9999 → "Net monthly income is out of range."
- PersonalSavingsAccountId: must be an account with matching OwnerId → 404 `Account {id} was not found.` (guards cross-household leak / dangling id later booked by allocation transfers).
- Update/Archive: member not found → 404 `Household member {id} was not found.`; other household's member → 403 (empty message).

### Server — Households
- switch/leave errors as tabled in §3 (exact strings there).

### Server — auth-adjacent
- register: `AcceptedTerms` false → 400 "Please accept the terms and privacy policy to create an account."

### Client-side (exact strings)
PeoplePage: 'Could not load your household.' (initial load), 'Give the person a name.', 'Enter a valid monthly income.', 'Could not add that person.', 'Could not save that person.', 'Could not archive that person.', 'Enter an email address.', 'Set a temporary password of at least 8 characters.' (pre-submit, <8 chars), 'Could not change that role.', 'Could not remove that sign-in.'; invite/link errors surface server field errors flattened, fallback 'Could not complete that request.' (PeoplePage.tsx:844-851). Error banner renders inside whichever modal is open, else at page top (PeoplePage.tsx:374).
AcceptInvitePage: server field errors flattened; axios fallback 'This invite link is invalid or has expired.'; non-axios 'Something went wrong.' (AcceptInvitePage.tsx:11-18). HTML-level: password `required minLength={8}`, terms checkbox `required` (browser blocks submit before the server sees it).
AccountPage: 'Could not start your budget. Please try again.', 'Could not leave this household. Please try again.'
ConsentModal: 'Something went wrong saving your agreement — please try again.'

## 5. State variants

- **Loading**: PeoplePage "Loading…" text; AccountPage's sharing row is a quiet placeholder while `householdLoading` (an owner's Household card waits for it), and the profile avatar a placeholder circle until the person's colour is known; app-level `AuthSplash` spinner during `bootstrapping`.
- **Solo vs shared**: `isShared = members.length >= 2` (client/src/features/HouseholdContext.tsx:27, `SHARED_THRESHOLD=2`). People nav ALWAYS visible (flag permitting); Allocation nav only when `isShared` (AppNav.tsx:37-38). PeoplePage calls `refreshHousehold()` after add/archive so nav reveals/hides live (PeoplePage.tsx:184, 241).
- **No 0-member state**: owner is materialized as member #1 at registration/start-own (`OwnerMemberSeeder.EnsureOwnerMemberAsync`; name fallback firstName → displayName → email local-part → "You", income 0) plus startup backfills `MembershipSeeder.BackfillOwnerMembershipsAsync` and `OwnerMemberSeeder.BackfillOwnerMembersAsync` (Program.cs:104-107, both idempotent + non-fatal). The PeoplePage empty state IS still reachable, though: nothing prevents archiving the owner's own person (no guard in `ArchiveHouseholdMemberCommandHandler`, and the "✕" shows on every row including your own), so archiving all members yields `GET /members` → `[]` → "Budgeting on your own?" empty state with `isShared=false`. It's also reachable via API errors or pre-backfill data.
- **Feature flag off**: `HouseholdAllocation` off → `/people` + `/allocation` routes not mounted, `/api/members*` 404. `HouseholdAccess` off → `/api/access/*` 404; PeoplePage still renders but `canAccess=false` → no invite/role/remove/link controls, "No sign-in" placeholders (the page tolerates `/access/members` failing via `.catch(() => [])`, PeoplePage.tsx:104-106).
- **Role variants on /people**: Owner → everything. Admin → member CRUD only (`canWrite`), sees "No sign-in" texts, no invite/role controls (server would 403 anyway). Limited/ReadOnly → no Add/Edit/Archive buttons; member CRUD commands 403 server-side; both still see the table and (any role) can GET `/access/members`.
- **Invited (pending) membership**: shows amber "Invited" badge; role still changeable and removable by owner; occupies the email + memberId slots (blocks re-invite of same email and re-link of same person until removed).
- **Orphan login**: membership with `memberId=null` — shows in "Other sign-ins" (owner view only) unless `isSelf`.
- **Unlinked self**: current login with `memberId=null` → "This is me" buttons appear on all unlinked person rows (common for imported/pre-existing households, PR #107 follow-up).
- **Archived member**: excluded from GET `/members` default, allocation pool, and spending. **PeoplePage never passes `includeArchived=true` — there is NO restore-UI**; restore is API-only (`PUT /members/{id}/archive {archived:false}`). ⚠ Contrary to the handler's comment ("archived members get a 0 share"), the `ToDto(totalActiveNet)` mapping does NOT zero an archived member's `IncomeSharePct` — it computes `income / totalActiveNet` for every member, so with `includeArchived=true` an archived earner shows a nonzero share and the shares across the full list can exceed 100% (src/AllotJar.Application/Household/Dtos/HouseholdMemberDto.cs mapping vs GetHouseholdMembersQueryHandler.cs comment).
- **Login linked to an archived member**: appears NOWHERE on PeoplePage — not in the members table (person filtered out) and not in "Other sign-ins" (`memberId != null`). Access can't be seen or revoked from the UI in this state. Real edge case to test.
- **Pure invitee** (accepted a link with a new login): no own household, `ownsHousehold=false` → "Your own budget" row on /account; leaving their only household triggers server-side own-household materialization so they never land nowhere.
- **Multi-household login**: switcher section in UserMenu; active household drives ALL data scoping; `ActiveOwnerId` cleared to null when switching to own household. Revoked-while-viewing: next request resolution falls back own → first (ActiveHouseholdSelector), no error.
- **Stale/removed access mid-session**: role re-resolved every request; a revoked membership 404s/403s immediately; `/auth/me` refetch on token change updates client role (AuthContext.tsx:230-256; guards against malformed responses downgrading role).
- **needsConsent**: blocking ConsentModal (temp-password-created + legacy logins). Direct-invite logins consent on first sign-in; link-accept and register consent up front.

## 6. Computed/derived values & money rules

- `NetMonthlyIncome`: decimal(18,4) server-side (HouseholdMemberConfiguration.cs `HasPrecision(18,4)`); client edits in minor units via `parseMinor`/`toAmount` (`parseAmount`: '' → 0, invalid → null → validation error; PeoplePage.tsx:35-39). No floats anywhere.
- `IncomeSharePct` = `Math.Round(member.NetMonthlyIncome / totalActiveNet, 4, MidpointRounding.AwayFromZero)`; 0 when `totalActiveNet <= 0`; **denominator = active (non-archived) members only** (HouseholdMemberDto.cs mapping; GetHouseholdMembersQueryHandler). ⚠ The mapping applies the same formula to archived members too — an archived member fetched with `includeArchived=true` (or returned by the archive endpoint itself) carries `income / activeTotal`, NOT 0, despite the handler comment. Client renders `Math.round(pct*100)%` (PeoplePage.tsx:41-43) — shares may not sum to exactly 100%.
- Combined income (hero) = Σ `fromAmount(netMonthlyIncome)` over the returned (active) members (PeoplePage.tsx:146-149).
- Member spending = per-member Σ of Expense transactions: split tx contribute per-slice amounts to `slice.MemberId`; unsplit tx contribute full `t.Amount` to `t.MemberId`; unattributed tx count for no one; members outside the active set are dropped. **All-time, not month-scoped** — despite the hero tile label "Shared this month" (see §7).
- `DisplayOrder` for a new member = `max(existing)+1` (starts at 0); list order `DisplayOrder, Name`.
- Household label: own → "Your household"; joined → owner's `DisplayName ?? Email ?? "Household"`; list ordered own-first then label (AuthController.cs:349-359).
- Invite token: 32 random bytes → URL-safe base64 (no padding, `+`→`-`, `/`→`_`); stored as hex SHA-256 (InviteToken.cs). Expiry now+7 days.
- Uniqueness (HouseholdMembershipConfiguration.cs): unique `(OwnerId, UserId)` filtered `UserId IS NOT NULL` (one membership per login per household; multi-household OK); unique `MemberId` filtered NOT NULL (**global** 1:1 person↔login); indexes on OwnerId, UserId, InviteTokenHash.

## 7. Known invariants, gotchas & recent-fix regressions

1. **OwnerId is the household key** — never re-keyed; all budget data carries it. Member CRUD handlers scope by `_currentUser.OwnerId` (the ACTIVE household), so an Admin viewing a joined household adds/edits persons in THAT household, not their own.
2. **Accept-invite must land you IN the joined household** (PR #156): server sets `ActiveOwnerId` in both accept paths; client does a full reload (`window.location.assign('/?joined=1')`) for the signed-in path. Regression check: after accept, dashboard shows the invitér's budget + "You’ve joined the household." banner, and the invite "did nothing" symptom must not return.
3. **Consent gap (GDPR, PR #156)**: link-accept form requires terms; direct-invite logins get `ConsentedUtc=null` → blocking ConsentModal at first sign-in (`/auth/me needsConsent`); modal never covers `/terms`//`/privacy`; onboarding waits for consent. Registration/link-accept record consent up front.
4. **Start-own / leave never seed sample budgets** (PR #170 + `HouseholdsController` comments): `seedSampleBudget:false` in start-own AND the defensive bootstrap inside leave. Only register with explicit `IncludeSampleData=true` seeds. Regression: leaving a household or starting an own budget must land on the create-month flow, never pre-filled figures.
5. **`HouseholdBootstrap.EnsureOwnHouseholdAsync` is idempotent** (Infrastructure/Persistence/HouseholdBootstrap.cs): guarded membership insert; owner-member seeding no-ops when household already has ANY member. Register + start-own + leave all share it.
6. **Leave/revoke HARD-DELETE the membership row** (`MembershipStatus` has only Active/Invited — no Revoked/Left tombstone). The budget person (HouseholdMember) and all their attributed data stay — "Nothing was deleted" banner is about budget data only. Re-invite = brand-new membership.
7. **Empty month is NOT balanced** (PR #172, context): after start-own/leave a fresh own household with jars lands "over-budgeted" via accrual-planned savings lines, not the gold balanced badge — relevant when journey-testing the post-leave landing.
8. **Owner is immovable**: can't be demoted (403 "The owner's role cannot be changed."), removed (403), invited (validator "A household can only have one owner."), or leave their own household (400). Exactly one Owner per household by construction.
9. **1:1 person↔login link enforced 3 ways**: invite-time check, link-time check, filtered unique DB index (self-healed dups in the PR #98 migration). Note the DB index is global (any OwnerId), stronger than the per-household handler checks.
10. **"This is me" claim** (PR #107): imported/pre-existing households can have an unlinked owner login; auto-inference is impossible so it's a manual one-time claim; the current login is excluded from "Other sign-ins".
11. **HouseholdSwitcher.tsx is dead code** — the shipped switcher is inside `UserMenu`. E2E selectors must target the account-menu buttons, not an `Active household` select.
12. **"Shared this month" tile mislabels all-time data**: `GetMemberSpendingQueryHandler` has NO date filter, but PeoplePage's hero tile and code comment say "this month". Either a copy bug or a latent scope bug — flag in QA.
13. **Invite dupe-check collation**: handler compares `m.InvitedEmail == email` (trimmed, not lowercased). On prod SQL Server (CI collation) it's case-insensitive; under the EF InMemory CI job it's case-SENSITIVE — tests asserting case-variant dupes will diverge between environments. Accept-path email match is explicitly `OrdinalIgnoreCase`.
14. **Expired link invites linger**: expiry doesn't flip Status, so the pending row still blocks re-inviting that email ("That email already has access to this household.") until the owner clicks Remove. There is no expiry cleanup job.
15. **`AuthResponse.Role` is approximate for multi-household logins**: `BuildResponseAsync` takes the FIRST active membership without deterministic ordering (AuthController.cs:469-472); the authoritative role arrives via `/auth/me` (resolved active household). Client applies both in sequence — brief role flicker possible.
16. **Role changes are server-live, client-lazy**: enforcement is per-request server-side, but the SPA's `canWrite`/`canAccess` refresh only on `/auth/me` refetch (token change/reload). A demoted Admin keeps seeing edit buttons until reload; actions then 403.
17. **`switch` returns 204 not the new context** — the request's household ctx is already resolved/stale; client MUST full-reload (it does).
18. **Rate limiting**: `/access/invite` and all `/auth/*` share the `auth` policy — 20 req/min/IP → 429. Journey tests hammering invites will trip it (configurable via `RateLimiting__AuthPermitLimit`).
19. **Greeting params use `history.replaceState(history.state, …)`** to strip `?joined/started/left` without losing router state (AppShell.tsx:181-183); refresh must not re-show the banner.
20. **returnUrl safety**: `safeInternalPath` accepts only single-slash-rooted paths, rejects `//`, `/\` and control chars (client/src/lib/returnUrl.ts) — invite round-trip (`/login?returnUrl=/accept-invite?code=…`) is the main consumer; open-redirect attempts must fall back to `/`.
21. **PeoplePage archive has no confirmation** — one hover-click archives a person (excluding them from allocation + share math). No undo in UI (restore is API-only).
22. **Add-person savings select renders only when accounts exist**; accounts fetch failure silently degrades (`.catch → []`), so savings column shows "—" and the select vanishes — not an error state.
23. **Journey e2e coverage exists**: `client/e2e-journey/invite.spec.ts` ("an owner invites a new person who accepts and lands in the shared household") against the real API on :5099 — extend there for full-stack invite scenarios (HIBP-safe passwords required; see journey-e2e-harness note).
24. **Registration always bootstraps own household** BEFORE issuing tokens; a brand-new login with zero membership rows still resolves to Owner-of-self via middleware fallback (HouseholdResolutionMiddleware.cs:52-57) and `/auth/me` synthesizes the household list entry — no "no household" state is reachable.
25. **Probable defect — role check blocks signed-in invite acceptance for Limited/Read-only accepters**: `AcceptInviteCommand` ends in "Command", carries no `[AllowLimited]`/`[OwnerOnly]`, and `AuthorizationBehaviour` is registered for every request (Application/DependencyInjection.cs:22). A SIGNED-IN user whose ACTIVE household role is Limited or ReadOnly (role resolved from their current household, not the invited one) who clicks "Accept invite" on a link to a DIFFERENT household gets 403 `Your access level (Limited|ReadOnly) does not permit this action.` before the handler runs. Anonymous accepts are unaffected (no resolved role → enforcement skipped). High-value QA case: Limited member of household X accepting an invite to household Y.
26. **Revoked pure invitee → phantom 0-member own household**: only accept-invite Path B creates logins WITHOUT an own household. If the owner then REVOKES (not leaves — leave self-heals) that login's only membership, it has zero membership rows: middleware fallback makes it Owner-of-self, but `HouseholdBootstrap` never ran for it — no owner member (violates the "no 0-member state" invariant; `OwnerMemberSeeder.BackfillOwnerMembersAsync` iterates OwnerIds from memberships, so it skips them too), no months. Worse, `/auth/me`'s synthesized entry has `isOwn:true`, so `ownsHousehold=true` and the "Start my own budget" card does NOT appear — the user can only build up from the empty dashboard/People page manually. Distinct from the leave flow, which materializes the household properly.
27. **Multi-tab household switch is not broadcast**: switch/start-own/leave re-bootstrap only the acting tab (`window.location.assign`); the cross-tab channel (client/src/lib/authChannel.ts, PR #169) carries sign-outs only. Because `ActiveOwnerId` is server-side, OTHER open tabs keep rendering the old household's cached UI while every subsequent API call they make resolves to the NEW active household — a stale-tab data-mixing window until that tab reloads. Multi-tab switch test recommended.

## 8. File index (read)

Backend:
- src/AllotJar.Api/Controllers/HouseholdsController.cs
- src/AllotJar.Api/Controllers/MembersController.cs
- src/AllotJar.Api/Controllers/HouseholdAccessController.cs
- src/AllotJar.Api/Controllers/AuthController.cs
- src/AllotJar.Api/Controllers/FeaturesController.cs
- src/AllotJar.Api/Contracts/Auth/AuthContracts.cs
- src/AllotJar.Api/Features/FeatureFlags.cs, FeatureGateAttribute.cs
- src/AllotJar.Api/Middleware/HouseholdResolutionMiddleware.cs, ExceptionHandlingMiddleware.cs
- src/AllotJar.Api/Services/CurrentUser.cs, HouseholdContext.cs
- src/AllotJar.Api/Program.cs (rate limiter, middleware order, backfills)
- src/AllotJar.Application/Household/Commands/{CreateHouseholdMember,UpdateHouseholdMember,ArchiveHouseholdMember}/* (commands+handlers+validators)
- src/AllotJar.Application/Household/Queries/{GetHouseholdMembers,GetMemberSpending}/*
- src/AllotJar.Application/Household/Dtos/HouseholdMemberDto.cs, MemberSpendingDto.cs
- src/AllotJar.Application/HouseholdAccess/{InviteMethod.cs, InviteToken.cs}
- src/AllotJar.Application/HouseholdAccess/Commands/{InviteMember,AcceptInvite,ChangeMemberRole,RevokeMember,LinkMembershipMember}/*
- src/AllotJar.Application/HouseholdAccess/Dtos/MembershipDto.cs
- src/AllotJar.Application/HouseholdAccess/Queries/GetMemberships/*
- src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs
- src/AllotJar.Application/Common/Security/OwnerOnlyAttribute.cs (+ AllowLimited usage sites)
- src/AllotJar.Application/Common/Households/ActiveHouseholdSelector.cs
- src/AllotJar.Application/Common/Interfaces/IIdentityService.cs
- src/AllotJar.Domain/Entities/HouseholdMember.cs, HouseholdMembership.cs
- src/AllotJar.Domain/Enums/HouseholdRole.cs, MembershipStatus.cs
- src/AllotJar.Infrastructure/Persistence/HouseholdBootstrap.cs, OwnerMemberSeeder.cs, MembershipSeeder.cs
- src/AllotJar.Infrastructure/Persistence/Configurations/HouseholdMembershipConfiguration.cs, HouseholdMemberConfiguration.cs
- src/AllotJar.Infrastructure/Identity/IdentityService.cs, BreachedPasswordValidator.cs (error string)
- src/AllotJar.Infrastructure/DependencyInjection.cs (password/lockout policy)

Frontend:
- client/src/App.tsx (routes, RequireAuth, AuthedLoginRedirect)
- client/src/pages/PeoplePage.tsx
- client/src/pages/AcceptInvitePage.tsx
- client/src/pages/AccountPage.tsx
- client/src/pages/LoginPage.tsx (returnUrl consumption)
- client/src/auth/AuthContext.tsx
- client/src/features/HouseholdContext.tsx, FeatureContext.tsx
- client/src/components/AppShell.tsx (UserMenu switcher, greetings, access banners), AppNav.tsx, HouseholdSwitcher.tsx (unmounted), ConsentModal.tsx
- client/src/lib/returnUrl.ts
- client/src/types.ts (role labels/hints, MembershipDto, InviteResultDto, HouseholdSummary, MeResponse)
- client/src/analytics/events.ts (event names)
- client/e2e-journey/invite.spec.ts (test name only)
- client/src/pages/RoleGating.test.tsx (test names only)

Memory notes consulted (verified against code): invite-household-coherence.md, household-sharing-rework.md, household-multiuser-access.md, solo-friendly-household.md.
