# Invites

**ID prefix:** INV | **Scope:** Inviting a login to share a household from the People page (`PeoplePage.tsx` invite modal, opened per person via "Invite to sign in") — the one-time **link** invite and the **direct temporary-password** invite, the access-level chosen at invite time, linking the invite to the clicked budget person, and the "Invited" pill / success boxes. The public `AcceptInvitePage` (`/accept-invite?code=…`; since restyle PR 9 in the signed-out frame of `/login` — the green room (a band on a phone) with the **Dark mode** button and the one line, no staging banner — with the card opening on the eyebrow "Household invite", the title "Join the household" and its (i) **About this invite**): accepting as a brand-new user (login creation + terms consent), as an already-signed-in existing user (join with existing login, own budget untouched — the reconcile path), and as an existing-but-logged-out user (`/login?returnUrl=…` round-trip). Landing IN the joined household after accept (`ActiveOwnerId` set server-side, `?joined=1` banner). Invite/accept validation and error paths: expired / reused / invalid / wrong-email / missing-code links, HIBP-breached and complexity-failing temp passwords, duplicate access, the 1:1 person↔login link, invite rate-limiting, the assigned role the accepter lands with, and revoking a pending invite. | **Out of scope:** People-page member CRUD, the "This is me" self-claim, the "Other sign-ins" orphan-login card, changing a role or removing an already-active member, the solo↔shared flip, the household switcher, and Start-my-own-budget / Leave-household → `16-people-households.md` (PPL-*). Deep role-enforcement matrices across every page → `25-roles-permissions.md`. Auth/session/JWT/refresh mechanics, the `ConsentModal` internals, `safeInternalPath` unit semantics, and generic login/register → `02-registration-login.md` / `03-session-auth-lifecycle.md`. Responsive/dark/a11y sweeps and multi-feature journeys → their dedicated files.

**Test data setup:** Three reusable fixtures unless a case overrides them. **(B) Shared household** — Owner login `alex@x.eu` (household key = Alex's OwnerId, "Your household"), members "Alex" (linked to Alex's login, income 3,000.00) and "Sam" (linked to Active `sam@x.eu`, role Admin), EUR account "Joint". **(R) Invitable person** — household B with an extra budget person "Robin", income 0, **no login** (Sign-in cell shows the dashed "Invite to sign in" pill). **(D) Existing outsider** — `dana@x.eu` already has her own AllotJar account + own household elsewhere, no membership in B. Invite tokens: raw 256-bit URL-safe string returned once; only its hex SHA-256 (`InviteToken.Hash`) is stored in `HouseholdMembership.InviteTokenHash`; `InviteExpiresUtc = now + 7 days`; link membership `Status = Invited`; direct membership `Status = Active`. Enums (client): `InviteMethod = {Direct:0, Link:1}`, `HouseholdRole = {Owner:0, Admin:1, Limited:2, ReadOnly:3}`, `MembershipStatus = {Active:0, Invited:1}`. `canAccess = features.householdAccess && canManageHousehold` (owner only, flag on). Money `decimal(18,4)` server / integer minor client. All exact labels/messages below were read from source at `<local>\Documents\Projects\ZeroBudget` (`PeoplePage.tsx`, `AcceptInvitePage.tsx`, `AuthContext.tsx`, `AppShell.tsx`, `HouseholdAccessController.cs`, `AuthController.cs`, `InviteMemberCommand{Handler,Validator}.cs`, `AcceptInviteCommand{Handler,Validator}.cs`, `RevokeMemberCommandHandler.cs`, `AuthorizationBehaviour.cs`, `InviteToken.cs`, `types.ts`) and re-verified on 2026-07-16.

---

## Invite modal — open, controls & defaults

### INV-001 - Open the invite modal from a person's "Invite to sign in" pill
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture R, signed in as owner (`canAccess` true).
- **Steps:**
  1. Open `/people`; on Robin's row (no login), locate the dashed pill "Invite to sign in".
  2. Click it.
- **Expected:** A Modal opens titled `Invite Robin to sign in` (name resolved from the clicked person; the literal fallback title is "Invite someone to sign in" only if the id no longer resolves — e.g. the person was archived between open and render). It contains: "Email" input (placeholder `sam@example.eu`, aria-label "Invitee email"), "Access level" select (aria-label "Access level"), the "How should they get access?" method control (aria-label "Invite method"), and a submit button. `openInviteFor` seeds the internal display-name state (`iName`) with the person's name "Robin" — this is sent later as the invite's `displayName`; there is **no visible name field** in the invite modal — and it resets Email, temp-password and method to link.
- **Automated:** No

### INV-002 - Modal defaults: method = link, role = Admin, email blank
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture R; invite modal freshly opened for Robin.
- **Steps:**
  1. Inspect the initial control state.
- **Expected:** The "Invite method" segmented control (aria-label "Invite method", legend "How should they get access?") defaults to "Email an invite link" (`iMethod='link'`); the "Access level" select defaults to Admin (`iRole = HouseholdRole.Admin = 1`); Email is empty; no temp-password field is shown (link method shows the explanatory paragraph instead). The submit button reads "Send invite".
- **Automated:** No

### INV-003 - Access-level list offers only Admin / Limited / Read-only; hint tracks the choice
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Fixture R; invite modal open.
- **Steps:**
  1. Open the "Access level" select and read each option and the hint line under it.
- **Expected:** Options are exactly Admin / Limited / Read-only (`GRANTABLE_ROLES = [Admin, Limited, ReadOnly]`; Owner is never listed). The hint reflects `HOUSEHOLD_ROLE_HINTS[iRole]`: Admin → "Everything except managing members and access.", Limited → "Day-to-day entry: transactions, mark bills paid, run allocation.", Read-only → "View everything; cannot make changes."
- **Automated:** No

### INV-004 - Switching to "Set a temporary password" reveals the password field
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture R; invite modal open (link method).
- **Steps:**
  1. Click "Set a temporary password" in the method control.
- **Expected:** A "Temporary password" input appears (placeholder "At least 8 characters", aria-label "Temporary password") with helper "Only works for someone without an account yet."; the link-method explanatory paragraph is replaced; the submit button label flips to "Create login". Switching back to "Email an invite link" hides the field and restores the paragraph "We email them a one-time link. If they already have an account, they accept it while signed in; otherwise they set their own password when they open it."
- **Automated:** No

### INV-005 - Chosen access level persists across modal re-opens; email/method/name reset
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Fixture R; two unlinked people (Robin, Sam).
- **Steps:**
  1. Open the invite modal for Robin, change "Access level" to Read-only, close the modal (X).
  2. Open the invite modal for Sam.
- **Expected:** `openInviteFor` resets email, temp-password, method (`iMethod='link'`) and `iName` (to Sam's name) but **not** `iRole`, so Sam's modal still shows Read-only from the previous selection. Minor state-carryover edge; document so a tester doesn't mistake it for a bug. Email/name/method are correctly reset per person.
- **Automated:** No

### INV-006 - Invite controls hidden when the HouseholdAccess flag is off
- **Priority:** P2
- **Type:** Edge
- **Origin:** PR #76 / feature-gate (`FeatureGate(HouseholdAccess)` → `/api/access/*` 404; client `canAccess=false`)
- **Preconditions:** `HouseholdAccess` flag OFF (HouseholdAllocation ON); owner on `/people`.
- **Steps:**
  1. View any unlinked person's Sign-in cell.
- **Expected:** No "Invite to sign in" pill; the cell shows static "No sign-in". The invite modal is never rendered (`canAccess && inviteOpen`). No error surfaces for the 404 on `/access/members` (PeoplePage `.catch(() => [])`). Member CRUD still works via `/members`.
- **Automated:** No

### INV-007 - Invite controls hidden for a non-owner (Admin) even with the flag on
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Signed in to household B as an **Admin** (`canWrite` true, `canManageHousehold` false).
- **Steps:**
  1. Open `/people`; inspect an unlinked person's cell.
- **Expected:** `canAccess = householdAccess && canManageHousehold` is false → no "Invite to sign in" pill, no role select, no Remove; each person shows static "No sign-in". A direct `POST /api/access/invite` still 403s server-side ("Your access level (Admin) does not permit this action." — the command is `[OwnerOnly]`). Full role matrix → `25-roles-permissions.md`.
- **Automated:** No

---

## Create a one-time invite link

### INV-008 - Email an invite link to an unlinked person (happy path)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture R; owner; invite modal open for Robin.
- **Steps:**
  1. Type Email `robin@x.eu`; leave Access level at Admin; keep method "Email an invite link".
  2. Click "Send invite".
- **Expected:** `POST /access/invite {email:"robin@x.eu", role:1, method:1 (Link), tempPassword:null, displayName:"Robin", memberId:<Robin>}` → 200 `InviteResultDto` `{membership, emailSent:true}` (no token: the link goes only to the invited address, #298 P2-1). If the provider rejects the send, `emailSent` is false and an amber alert says "Invite saved, but the email failed … Remove the invite and send it again later." Outside Development, with no email provider configured, the invite is refused with 400 "Email isn't set up on this server yet, so invites can't be sent." and nothing is created (#298 R2-P2-1). The app emails robin@x.eu "You're invited to a household on AllotJar" with `{AppBaseUrl}/accept-invite?code=<token>` alone on its own line. `member_invited {method:"link"}` fires. A brand status box appears: "Invite sent" + "We've emailed robin@x.eu a one-time link. It expires in 7 days." No link and no Copy button are shown. Server persists the membership with `Status=Invited`, `InviteTokenHash=SHA-256(token)`, `InviteExpiresUtc=now+7d`; `reloadAll()` refreshes so Robin's row now shows the amber "Invited" badge.
- **Automated:** Yes (`client/e2e-journey/invite.spec.ts` reads the link from the email; `client/src/pages/PeoplePage.catalog.test.tsx` INV-008; `HouseholdAccessTests.cs::Invite_link_creates_a_pending_membership_and_returns_the_token_once` covers the handler, which still hands the token to the API to email)

### INV-009 - (Retired) Copy the invite link
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** None.
- **Steps:**
  1. None.
- **Expected:** Retired by #298: the owner is no longer shown the link, so there is nothing to copy. The link reaches the invitee only by email (INV-008).
- **Automated:** No

### INV-010 - Invite link URL shape and token are URL-safe
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** INV-008; a created link.
- **Steps:**
  1. Read the link line from the invitation email.
- **Expected:** Exactly `${origin}/accept-invite?code=<token>` (no trailing slash, single `?code=`). The token is base64url (`InviteToken.Generate` trims `=` padding and maps `+`→`-`, `/`→`_`), so it is URL-safe with no percent-encoding needed and round-trips through `?code=` without mangling.
- **Automated:** No

### INV-011 - The raw token is shown once and is never retrievable again
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** INV-008; the link box is visible.
- **Steps:**
  1. Reload `/people` (or close and re-open the invite modal for Robin).
- **Expected:** The "Invite sent" box does not reappear and no link is ever shown to the owner: the raw token goes only into the invitee's email and only its hash is stored. Robin's row still shows "Invited". To hand out a fresh link the owner must Remove the pending invite (INV-051) and invite again (which mints a new token).
- **Automated:** Yes (`tests/AllotJar.IntegrationTests/Http/DirectInviteFirstSignInTests.cs` asserts the invite response carries no token and the link arrives by email; `client/src/pages/PeoplePage.catalog.test.tsx` INV-008)

### INV-012 - A pending link marks the person's row with the amber "Invited" badge
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Fixture R after INV-008.
- **Steps:**
  1. Open `/people`; inspect Robin's Sign-in cell.
- **Expected:** The email `robin@x.eu` shows with an amber Badge "Invited" (`login.status === MembershipStatus.Invited`). The owner still sees the role `<select>` (aria "Access level for Robin") and a "Remove" button on the pending row (re-role or revoke while pending). The row now occupies Robin's memberId slot, blocking re-invite of the same person (INV-031).
- **Automated:** No

---

## Direct temporary-password invite

### INV-013 - Create a login directly with a temporary password
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture R; owner; invite modal open for Sam (unlinked person, no account anywhere).
- **Steps:**
  1. Switch method to "Set a temporary password".
  2. Enter Email `sam@x.eu`, Temporary password `Aa1-longpass`, Access level Limited.
  3. Click "Create login".
- **Expected:** `POST /access/invite {method:0 (Direct), tempPassword:"Aa1-longpass", role:2, memberId:<Sam>}`. Server creates the Identity login (`consented` NOT set → `ConsentedUtc=null`) and a membership with `Status=Active`, `UserId` set. A `role="status"` box appears: heading "Login created" + "We've emailed sam@x.eu a link to choose their own password. Until they do, the temporary password you set only lets them sign in to see that prompt." Sam's row flips to Active. The login has `MustChangePassword = true` (S-P2-3) and the app emails sam@x.eu "Choose your AllotJar password" with a `/reset-password?` link (2 hours; "Email me the link again" on the prompt calls `POST /auth/password-link`, which sends to the login's own address and answers 503 "We couldn't send the email just now." when the send fails; forgot-password also sends one). On Sam's first sign-in the blocking "Choose your own password" dialog names the address and has no password fields; until the emailed link is used every signed-in endpoint except `/auth/me` answers 403 `password_change_required`, `/auth/change-password` and `/auth/consent` included, so whoever knows the temporary password can neither choose Sam's password nor accept the terms for Sam (#298 P2-1, P3-1). Using the link rotates the security stamp, so a session opened with the temporary password ends, and the temporary password stops working. Then the blocking `ConsentModal` appears (consent flow → `03-session-auth-lifecycle.md`).
- **Automated:** Partial (`HouseholdAccessTests.cs::Invite_direct_creates_an_active_login_membership`, `DirectInviteFirstSignInTests.cs`, `PasswordChangeModal.test.tsx`)

### INV-014 - Direct temp-password to an email that already has an account is rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture D — `dana@x.eu` already has an AllotJar account; invite modal open for a person in B.
- **Steps:**
  1. Method "Set a temporary password", Email `dana@x.eu`, password `Aa1-longpass`, "Create login".
- **Expected:** Server 400, field `Email`: "That email already has an account — use 'Email an invite link' so they can accept it." (curly quotes around 'Email an invite link' in source; `_identity.EmailExistsAsync` true on the Direct branch). The modal surfaces the flattened field text via `inviteError`. No login is created, no membership added. The correct route for an existing account is the link method (INV-037/INV-038).
- **Automated:** No

### INV-015 - Direct temp-password shorter than 8 chars blocked before the request
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture R; direct-invite modal, valid email typed.
- **Steps:**
  1. Enter a 5-char temporary password (`Aa1-x`), click "Create login".
- **Expected:** In-modal ErrorBanner "Set a temporary password of at least 8 characters." from the client guard (`iMethod==='direct' && iTempPassword.length < 8`); **no** `POST /access/invite` is sent. The server validator enforces the same rule (`NotEmpty().MinimumLength(8).When(Direct)`) with the same message as a backstop.
- **Automated:** No

### INV-016 - Direct temp-password of exactly 8 chars is accepted
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Fixture R; direct-invite modal, email `sam@x.eu`.
- **Steps:**
  1. Enter an 8-char password satisfying Identity complexity (e.g. `Zx9qwerT`), "Create login".
- **Expected:** Passes the client `< 8` guard and the server `MinimumLength(8)`; the login is created (subject to the HIBP + complexity checks, INV-017/INV-018). Boundary confirms 8 is inclusive.
- **Automated:** No

### INV-017 - HIBP-breached temporary password is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Fixture R; direct-invite modal, email `sam@x.eu`.
- **Steps:**
  1. Enter a known-breached password (e.g. `Password1`), "Create login".
- **Expected:** `_identity.CreateUserAsync` fails; server 400 field `Password` carrying the breached-password message (`BreachedPasswordValidator`: "This password has appeared in a known data breach. Please choose a different one."). The modal shows the flattened field error; no login created. The HIBP check fails **open** if the range API is unreachable, so on an outage the password is accepted subject to the other policy rules.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/BreachedPasswordValidatorTests.cs`)

### INV-018 - Temp-password meeting length 8 but failing Identity complexity is rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Fixture R; direct-invite modal, email `sam@x.eu`.
- **Steps:**
  1. Enter an 8-char all-lowercase, no-digit password `abcdefgh` (passes the client `<8` guard and server `MinimumLength(8)`), "Create login".
- **Expected:** `_identity.CreateUserAsync` fails the ASP.NET Identity policy (min 8 + `RequireDigit`/`RequireLowercase`/`RequireUppercase` ON, `RequireNonAlphanumeric` OFF) → server 400 field `Password` with the default Identity descriptions (e.g. "Passwords must have at least one digit ('0'-'9').", "Passwords must have at least one uppercase ('A'-'Z')."). No login created. **QA note:** the modal placeholder "At least 8 characters" understates the real requirement — flag the copy gap.
- **Automated:** No

---

## Invite validation & error paths

### INV-019 - Empty email rejected client-side
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Fixture R; invite modal open.
- **Steps:**
  1. Leave Email blank, click "Send invite".
- **Expected:** In-modal ErrorBanner "Enter an email address." (client guard `iEmail.trim() === ''`); no `POST /access/invite`.
- **Automated:** No

### INV-020 - Whitespace-only email is trimmed then rejected
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Fixture R; invite modal open.
- **Steps:**
  1. Type "   " (spaces only) into Email, click "Send invite".
- **Expected:** `iEmail.trim() === ''` → "Enter an email address."; no API call. (Even if a value survived trimming, the server `EmailAddress()` validator would reject a non-email.)
- **Automated:** No

### INV-021 - Malformed email rejected by the server validator
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Fixture R; invite modal open.
- **Steps:**
  1. Enter `not-an-email` and click "Send invite".
- **Expected:** The client only checks non-empty, so the request is sent; server 400 field `Email` from `.EmailAddress()`. The modal surfaces the flattened validator message. No membership created.
- **Automated:** No

### INV-022 - Email longer than 256 chars rejected
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Fixture R; invite modal open.
- **Steps:**
  1. Enter a syntactically-valid address whose length exceeds 256 chars, submit.
- **Expected:** Server 400 field `Email` from `.MaximumLength(256)`; no membership. A 256-char address is accepted (inclusive bound).
- **Automated:** No

### INV-023 - Email already has access to this household is rejected
- **Priority:** P2
- **Type:** Negative
- **Origin:** invite-household-coherence gotcha #14 (an existing membership for that email — Active OR pending Invited, including an expired-but-not-removed link — blocks re-invite; no expiry-cleanup job)
- **Preconditions:** Fixture B; `sam@x.eu` already has a membership in B.
- **Steps:**
  1. Invite `sam@x.eu` again (either method).
- **Expected:** Server 400 field `Email`: "That email already has access to this household." (`AnyAsync(m => m.OwnerId==owner && m.InvitedEmail==email)` where `email = request.Email.Trim()`). The modal shows the flattened error. An expired-but-unremoved link still counts — the owner must Remove that pending row first (INV-051).
- **Automated:** Partial (`HouseholdAccessTests.cs::Invite_rejects_an_email_already_in_the_household`)

### INV-024 - Case-variant of an existing email: prod blocks, InMemory diverges
- **Priority:** P3
- **Type:** Regression
- **Origin:** invite-household-coherence gotcha #13 (the dupe check compares `InvitedEmail == email` trimmed but **not** lowercased; SQL Server default collation is case-insensitive, EF InMemory is case-sensitive)
- **Preconditions:** Fixture B; `sam@x.eu` already has a membership; invite modal open.
- **Steps:**
  1. Invite `Sam@X.eu` (same address, different casing).
- **Expected:** On staging/prod (SQL Server, case-insensitive collation) the dupe check matches → 400 field `Email` "That email already has access to this household." — the intended block. **Divergence to note:** the EF InMemory backend used by the `backend` CI job compares case-sensitively, so the same input would slip past the handler check there (a duplicate-looking membership); the accept path, however, matches emails `OrdinalIgnoreCase`, so a case-variant accept still reconciles. Verify the real behavior against staging, not the unit-test layer.
- **Automated:** No

### INV-025 - Very long display name rejected by the server (API-surface)
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Fixture R. The invite modal has no editable name field — `displayName` is seeded from the member's name (member names are themselves capped at 120), so a 121-char name is only reachable via a crafted `POST /access/invite`.
- **Steps:**
  1. Submit an invite whose `displayName` exceeds 120 chars.
- **Expected:** Server 400 (validator `DisplayName.MaximumLength(120)`); the modal shows the fallback/flattened error. A 120-char name is accepted (inclusive). Unicode/emoji names within the limit are stored verbatim.
- **Automated:** No

### INV-026 - Role = Owner is never grantable via invite
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** Fixture R; the UI only offers Admin/Limited/Read-only, so this is exercised via a crafted `POST /access/invite {role:0}`.
- **Steps:**
  1. Send an invite request with `role: 0` (Owner).
- **Expected:** Server 400 from the validator rule `Role.Must(r => r != Owner)` → "A household can only have one owner." No membership created. Confirms a household cannot mint a second owner through invites.
- **Automated:** No

### INV-027 - Invite endpoint is rate-limited (429)
- **Priority:** P3
- **Type:** Boundary
- **Origin:** gotcha #18 (`/api/access/invite` uses the shared `"auth"` rate policy because direct invites mint logins — 20 req/min/IP fixed window)
- **Preconditions:** Fixture B; owner; a script firing rapid invites from one IP.
- **Steps:**
  1. Send more invite requests than the auth permit limit within the window.
- **Expected:** Excess requests get HTTP 429; the modal surfaces the `inviteError` fallback "Could not complete that request." E2E/journey suites hammering invites must throttle or raise `RateLimiting__AuthPermitLimit`. `accept-invite` shares the same policy (INV-033 note).
- **Automated:** No

### INV-028 - Unmapped server failure shows the generic fallback
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** Fixture R; force `POST /access/invite` to 500 / network error.
- **Steps:**
  1. Submit a valid invite.
- **Expected:** `inviteError` returns "Could not complete that request." (no `errors`/`error`/`title` in the body); the modal shows it in the ErrorBanner; the modal stays open with entered values so the owner can retry.
- **Automated:** No

---

## Linking the invite to a budget person (1:1)

### INV-029 - Invite links the new login to the clicked budget person
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture R; invite modal opened from Robin's row.
- **Steps:**
  1. Create a link invite for `robin@x.eu`.
  2. After Robin accepts (INV-033), open `/people`.
- **Expected:** The invite carried `memberId=<Robin>`; server validated Robin belongs to the household (`HouseholdMembers.AnyAsync(m => m.Id==memberId && m.OwnerId==owner)`). After accept the membership's `MemberId` stays Robin, so Robin's People row shows the login email and role instead of "Invite to sign in". The budget person and the login are joined 1:1.
- **Automated:** Partial (`HouseholdAccessTests.cs::Link_connects_a_login_to_a_budget_person_and_can_unlink`; `client/e2e-journey/invite.spec.ts` covers the end-to-end link+accept)

### INV-030 - Inviting with a person already linked to another login is rejected
- **Priority:** P2
- **Type:** Negative
- **Origin:** gotcha #9 (person↔login link is 1:1, enforced at invite-time, link-time, and by a global filtered unique index on `MemberId`)
- **Preconditions:** Fixture B; "Sam" already linked to `sam@x.eu`.
- **Steps:**
  1. Craft an invite for a new email with `memberId = <Sam>` (or use "Link to a person…" to attach an orphan login to Sam).
- **Expected:** Server 400 field `MemberId`: "That budget person is already linked to another login." (`HouseholdMemberships.AnyAsync(m => m.OwnerId==owner && m.MemberId==memberId)`). The link handler returns the same message. The DB unique index on `MemberId` is global across households, stronger than the per-household check.
- **Automated:** Partial (`HouseholdAccessTests.cs::Invite_rejects_linking_a_budget_person_already_linked_to_another_login`, `Link_rejects_a_budget_person_already_linked_to_another_login`)

### INV-031 - A pending invite blocks re-inviting the same person until removed
- **Priority:** P2
- **Type:** Regression
- **Origin:** gotcha #14 (the pending row occupies the email+memberId slots; no expiry cleanup)
- **Preconditions:** Fixture R after INV-008 (Robin has a pending Invited membership for `robin@x.eu`).
- **Steps:**
  1. Attempt to invite Robin again (same email) via the modal.
  2. Attempt to invite a *different* email but with `memberId=<Robin>`.
- **Expected:** (1) 400 field `Email` "That email already has access to this household." (2) 400 field `MemberId` "That budget person is already linked to another login." Either way the owner must first Remove Robin's pending row (INV-051), then re-invite. An expired-but-unremoved link behaves identically.
- **Automated:** No

### INV-032 - Invite with a memberId not in this household → 404
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Fixture B; a `memberId` belonging to a different household (API-crafted; the UI never produces this).
- **Steps:**
  1. `POST /access/invite {memberId:<foreign>}`.
- **Expected:** 404 "Member {id} was not found." (`HouseholdMembers.AnyAsync(m => m.Id==memberId && m.OwnerId==owner)` false). No cross-household linkage is possible. Purely an API-surface guard.
- **Automated:** No

---

## Accept — brand-new user (anonymous)

### INV-033 - Anonymous accept creates a login, consents, and lands IN the joined household
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #156 (accept sets `ActiveOwnerId` server-side so the accepter LANDS in the joined household — was a silent no-op that looked like "the invite did nothing")
- **Preconditions:** A valid link `/accept-invite?code=<token>` for Fixture R (invited `robin@x.eu`, no account); a signed-out browser.
- **Steps:**
  1. Open the link → the card opens with the eyebrow "Household invite" and the title "Join the household" (the page's only heading, an h1), with an (i) **About this invite** beside the title whose tooltip reads "You've been invited to share a budget on AllotJar — pool income, split shared costs, and each keep your own savings." Then "Your name (optional)", "Password", the terms checkbox and "Accept invite"; at the card's foot "Already have an account? Sign in to accept" and "Not now". Tab order: Dark mode, the (i), Your name, Password, the checkbox, Terms of Service, Privacy Policy, Accept invite, Sign in to accept, Not now.
  2. Fill "Your name (optional)" = "Robin", "Password" = `Aa1-longpass` (≥8), tick "I agree to the Terms of Service and Privacy Policy", click "Accept invite" (busy label "Please wait…").
- **Expected:** `POST /auth/accept-invite {token, password, displayName:"Robin", acceptedTerms:true}` → 200 `AuthResponse` (JWT + rotated refresh cookie). Server: matches the pending membership by token hash where `Status==Invited`, creates the login with `consented:true` (no later ConsentModal), activates the membership (`Status=Active`, token hash + expiry nulled), and calls `SetActiveHouseholdAsync(userId, membership.OwnerId)`. `invite_accepted` fires; the SPA `navigate('/?joined=1', {replace})`. The dashboard shows household B's shared budget with the AppShell banner "You've joined this household — you're viewing its shared budget now. You can switch households anytime from the account menu." Robin is a pure invitee (no own household).
- **Automated:** Yes (`client/e2e-journey/invite.spec.ts`; client `AcceptInvitePage.catalog.test.tsx` INV-033 ×2 — the intro read after hovering its (i); `AuthPages.frame.test.tsx` — the one heading, the (i), Tab order, no staging banner; `client/e2e/a11y.spec.ts` — axe on the form in both themes; `HouseholdAccessTests.cs::Accept_invite_activates_the_membership_and_creates_the_login`)

### INV-034 - Terms must be accepted before a new login is created
- **Priority:** P1
- **Type:** Negative
- **Origin:** PR #156 (GDPR consent gap — invite-created logins never recorded terms; the anonymous form now requires a terms checkbox → `ConsentedUtc`)
- **Preconditions:** Anonymous accept form (Fixture R link), password typed.
- **Steps:**
  1. Leave the "I agree to the Terms of Service and Privacy Policy" checkbox unticked, click "Accept invite".
  2. (API bypass) Send `POST /auth/accept-invite {acceptedTerms:false}` with a valid new-login token.
- **Expected:** (1) The native `required` checkbox blocks submit — no request is sent. (2) The server still enforces it: 400 field `AcceptedTerms` "Please accept the terms and privacy policy to create your login." No login created. The Terms/Privacy links open `/terms` and `/privacy` in a new tab.
- **Automated:** Partial (`AcceptInvitePage.test.tsx::requires accepting the terms before the form submits`; `HouseholdAccessTests.cs::Accept_invite_creating_a_new_login_requires_accepting_the_terms`)

### INV-035 - Anonymous password shorter than 8 chars is rejected
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Anonymous accept form (Fixture R link).
- **Steps:**
  1. Enter a 5-char password, tick terms, click "Accept invite".
  2. (API bypass) POST with a 5-char password.
- **Expected:** (1) The `Input minLength={8}` + `required` blocks form submit client-side. (2) Server handler: `Password null/whitespace or length < 8` → 400 field `Password` "Choose a password of at least 8 characters." (the validator only checks min-8 *when password is non-empty*, so the handler is the real guard for the empty case). An 8-char password is accepted at this gate (then runs Identity policy + HIBP).
- **Automated:** Partial (`HouseholdAccessTests.cs` accept-path facts cover the handler)

### INV-036 - Display name is optional and defaults to the invite's name
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Anonymous accept for Fixture R (membership `DisplayName="Robin"` from the invite).
- **Steps:**
  1. Leave "Your name (optional)" blank, set a valid password, tick terms, "Accept invite".
- **Expected:** The client sends `displayName: undefined` (`displayName || undefined`); the server falls back to `membership.DisplayName` ("Robin") for the created login and the activated membership (`Activate` only overwrites when the name is non-blank). If the invite had no `displayName` either, the login is created with a null display name (email shown elsewhere).
- **Automated:** No

### INV-037 - Anonymous accept when the email already has an account → sign-in prompt
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** A link invite addressed to `dana@x.eu` (Fixture D — she already has an account); signed-out browser opens the link and fills the new-login form.
- **Steps:**
  1. On the anonymous form, enter any password, tick terms, "Accept invite".
- **Expected:** Server Path B sees `EmailExistsAsync(dana@x.eu)` → 400 field `Email` "You already have an account — sign in first, then open this link to join." No second login is created for Dana; her data is untouched. The page shows the error; she should use "Sign in to accept" (INV-043) to reconcile.
- **Automated:** Partial (`HouseholdAccessTests.cs::Accept_invite_anonymously_with_an_existing_email_tells_them_to_sign_in`)

---

## Accept — existing signed-in user (reconcile, no data loss)

### INV-038 - Signed-in existing user joins with their login; own budget untouched; full reload
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #156 / household-sharing-rework Phase 3 (signed-in accept keeps the existing login + own budget, then lands in the joined household)
- **Preconditions:** Signed in as `dana@x.eu` (owns her own household); a valid link invite for B addressed to `dana@x.eu`.
- **Steps:**
  1. Open the link → the authenticated variant: under the title, a muted line "You're signed in as dana@x.eu. Joining adds this household to your account — your own budget stays exactly as it is, and you can switch between them." + an "Accept invite" button (no password/terms fields); only "Not now" at the card's foot.
  2. Click "Accept invite".
- **Expected:** `joinExisting()` → `POST /auth/accept-invite {token: code}` (token-only). Server Path A: matches Dana's email (`OrdinalIgnoreCase`) to the invite, attaches `UserId`, activates, `SetActiveHouseholdAsync(userId, B)`, DisplayName = `me.DisplayName ?? request.DisplayName`. `invite_accepted` fires; the client does a **full** `window.location.assign('/?joined=1')` (so `/auth/me` re-reads the server-set active household). Dana now has 2 households (switcher appears in the account menu); her own budget is unchanged; she lands in B with the joined banner.
- **Automated:** Partial (`AcceptInvitePage.test.tsx::offers an existing account a sign-in path that returns to the invite` covers the sign-in bounce; `HouseholdAccessTests.cs::Accept_invite_by_a_signed_in_existing_user_joins_without_a_new_login`)

### INV-039 - Reconcile: the invited email's existing account keeps ALL its data
- **Priority:** P0
- **Type:** Regression
- **Origin:** invite-household-coherence (existing-user reconcile verified correct — no new login, no data loss)
- **Preconditions:** `dana@x.eu` has her own household with members, accounts, transactions and budget months; accepts a link invite to B while signed in (INV-038).
- **Steps:**
  1. After accepting, switch back to Dana's own household from the account menu and inspect her data.
- **Expected:** No duplicate login is created — the invite reuses Dana's existing `UserId` (Path A attaches it to the pending membership). Her own household's members/accounts/transactions/budget are byte-for-byte unchanged; only a new `HouseholdMembership` row (owner=B, role from the invite) is added. Money and data integrity are preserved across the join.
- **Automated:** Partial (`HouseholdAccessTests.cs::Accept_invite_by_a_signed_in_existing_user_joins_without_a_new_login`)

### INV-040 - Signed-in accept with a mismatched email is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Signed in as `other@x.eu`; open a link invite addressed to `robin@x.eu`.
- **Steps:**
  1. Click "Accept invite" on the authenticated variant.
- **Expected:** Server Path A compares `me.Email` vs `membership.InvitedEmail` (`OrdinalIgnoreCase`) → mismatch → 400 field `Email` "This invite was sent to a different email address." No membership is attached; the page shows the error. `other@x.eu` would need to sign in as the invited address instead.
- **Automated:** Partial (`HouseholdAccessTests.cs::Accept_invite_by_a_signed_in_user_with_a_different_email_is_rejected`)

### INV-041 - Signed-in accept when already a member of that household
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Signed in as `sam@x.eu`, already an Active member of B; someone mints a second pending invite for `sam@x.eu` to B; Sam opens it while signed in.
- **Steps:**
  1. Click "Accept invite".
- **Expected:** Path A finds an existing membership with the same `UserId`+`OwnerId` and `Id != this pending one` → 400 field `Email` "You already have access to this household." The duplicate pending invite is not activated (it lingers until removed). No data change.
- **Automated:** No

### INV-042 - Signed-in Limited / Read-only accepter is blocked by the role pipeline (defect)
- **Priority:** P1
- **Type:** Regression
- **Origin:** gotcha #25 (`AcceptInviteCommand` ends in "Command" with no `[AllowLimited]`; `AuthorizationBehaviour` runs for every request that carries a resolved role)
- **Preconditions:** A signed-in login whose **active** household role is Limited or Read-only (resolved from their current household, not the invited one); a valid link invite to a different household addressed to their email.
- **Steps:**
  1. While signed in with that active role, open the link and click "Accept invite".
- **Expected:** **Observed defect:** `AuthorizationBehaviour` sees a resolved role, treats `AcceptInviteCommand` as a write with no `[AllowLimited]`, and throws before the handler: Limited/Read-only → 403 "Your access level (Limited|ReadOnly) does not permit this action." So the accept fails. Owner/Admin active roles are unaffected (`Admin => !ownerOnly` is true). Anonymous accepts are unaffected (no resolved role → enforcement skipped). **Desired:** accepting an invite should not be gated by the accepter's role in an unrelated household. High-value defect to confirm and file.
- **Automated:** No

---

## Accept — existing logged-out user (returnUrl round-trip)

### INV-043 - "Sign in to accept" round-trips through /login and back to the invite
- **Priority:** P2
- **Type:** Edge
- **Origin:** PR #156 (`safeInternalPath` single-slash-rooted only; rejects `//`, `/\`, control chars → fallback `/`)
- **Preconditions:** Signed out; an existing-account invite link (`dana@x.eu`).
- **Steps:**
  1. On the anonymous accept form, click "Already have an account? Sign in to accept" (at the card's foot, under "Accept invite").
  2. Sign in as `dana@x.eu`.
- **Expected:** Step 1 `navigate` to `/login?returnUrl=${encodeURIComponent('/accept-invite?code=<token>')}`. After a successful sign-in the app returns to `/accept-invite?code=<token>`, now rendering the authenticated variant so Dana can "Accept invite" (INV-038). The token survives the round-trip via `?code=`.
- **Automated:** Partial (client `AcceptInvitePage.catalog.test.tsx` INV-043 — the returnUrl; `AuthPages.frame.test.tsx` — its place after "Accept invite" in the Tab order; `client/src/pages/LoginPage.test.tsx` — sign-in returns to the invite link; `client/src/lib/returnUrl.test.ts`)

### INV-044 - Tampered returnUrl falls back to the app root
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Signed out; manually craft `/login?returnUrl=<malicious>` (scheme-relative `//evil.com`, backslash `/\evil`, or a control-char path).
- **Steps:**
  1. Sign in via that login URL.
- **Expected:** `safeInternalPath` rejects the tampered target and post-login navigation falls back to `/` — no open redirect off-site. A legitimate `/accept-invite?code=…` (single-slash-rooted, no control chars) is preserved. Deep returnUrl semantics → `03-session-auth-lifecycle.md`.
- **Automated:** Partial (`client/src/lib/returnUrl.test.ts`)

---

## Accept — expired / reused / invalid / missing links

### INV-045 - Expired invite link is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** A link whose `InviteExpiresUtc` is in the past.
- **Steps:**
  1. Open the expired link and click "Accept invite" (either variant).
- **Expected:** 403 "This invite link has expired." (`InviteExpiresUtc is null || InviteExpiresUtc < DateTime.UtcNow`). The page shows the message; the pending membership is untouched (still blocks re-invite until removed, INV-023/INV-031). Boundary note: the check is strict `<`, so a link at exactly its expiry instant is still valid; one tick past is expired.
- **Automated:** Partial (`HouseholdAccessTests.cs::Accept_invite_rejects_an_expired_link`)

### INV-046 - Reused / already-redeemed link is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** A link that was already accepted once (its membership is now `Status=Active`, token hash cleared).
- **Steps:**
  1. Open the same link a second time and click "Accept invite".
- **Expected:** 404 "This invite link is invalid or has already been used." — the lookup requires `Status == Invited` AND a matching `InviteTokenHash`, both false after redemption (`Activate` nulls the hash). The link truly works once.
- **Automated:** Partial (`HouseholdAccessTests.cs::Accept_invite_rejects_an_unknown_token`; the reuse case shares the same not-found path)

### INV-047 - Unknown / tampered token is rejected
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** A `/accept-invite?code=<garbage>` that hashes to no stored membership.
- **Steps:**
  1. Open the link and submit.
- **Expected:** 404 "This invite link is invalid or has already been used." (`Hash(token)` matches nothing). The client `extractError` fallback ("This invite link is invalid or has expired.") only shows if the body carries no message; here the server message is surfaced. No enumeration of valid tokens is possible (only the hash is stored).
- **Automated:** Partial (`HouseholdAccessTests.cs::Accept_invite_rejects_an_unknown_token`)

### INV-048 - Missing `?code=` shows an inline alert (no request)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Navigate to `/accept-invite` with no query.
- **Steps:**
  1. Open the bare route.
- **Expected:** `code === ''` short-circuits: the card shows only the eyebrow "Household invite", the title "Join the household" (without its (i)) and, under it, a `role="alert"` line "This invite link is missing its code. Ask the household owner to send you a fresh link."; no form, no `POST`. The intro (i), the sign-in link, "Not now" and the accept controls are not rendered.
- **Automated:** Full (client `AcceptInvitePage.catalog.test.tsx` INV-048; `AuthPages.frame.test.tsx` — the title and the alert only; `client/e2e/a11y.spec.ts` — axe on the missing-code state)

### INV-049 - "Not now" dismisses the invite without accepting
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** A valid invite link; both signed-in and signed-out variants.
- **Steps:**
  1. Open the link and click "Not now" (the last control, at the card's foot).
- **Expected:** No accept request is sent; navigation goes to `/` when authenticated, else `/login` (`navigate(isAuthenticated ? '/' : '/login')`). The pending invite remains redeemable later.
- **Automated:** Partial (client `AcceptInvitePage.catalog.test.tsx` INV-049 ×2 — signed out to `/login`, signed in to `/`; `AuthPages.frame.test.tsx` — last in the Tab order; the invite staying redeemable is not asserted)

---

## Role assigned via invite & revoking a pending invite

### INV-050 - The accepter lands with exactly the role chosen at invite time
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fixture R; owner invites `robin@x.eu` with Access level **Limited** (link method).
- **Steps:**
  1. Create the invite; Robin accepts (anonymous, INV-033).
  2. As owner, open `/people` and read Robin's role; sign in as Robin and check the access banner.
- **Expected:** The membership persists `Role=Limited` from the invite; after accept Robin's People row shows the Limited role and the `AuthResponse`/`/auth/me` gives Robin the Limited role (AppShell shows "You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings."). Owner can later change it via the row role select (`PUT /access/members/{id}/role`) — role-change enforcement → `25-roles-permissions.md`.
- **Automated:** Partial (`HouseholdAccessTests.cs::Change_role_updates_a_member_but_not_the_owner` covers role change; the invite-role landing is exercised in `invite.spec.ts`)

### INV-051 - Revoke a pending invite (hard-deletes the membership)
- **Priority:** P1
- **Type:** Happy
- **Origin:** gotcha #6 (revoke HARD-DELETES the membership row; no Revoked tombstone; the budget person stays)
- **Preconditions:** Fixture R after INV-008 (Robin's row shows amber "Invited").
- **Steps:**
  1. On Robin's Sign-in cell, click "Remove" (aria-label "Remove sign-in for Robin").
- **Expected:** `DELETE /access/members/{id}` → 204; `member_revoked` fires; `reloadAll()` refreshes. The pending membership row is hard-deleted (`_db.HouseholdMemberships.Remove`), so Robin's cell reverts to the dashed "Invite to sign in" pill and the email/memberId slots free up (re-invite now allowed, INV-031). Robin the budget person and all her data remain. On failure the page shows "Could not remove that sign-in."
- **Automated:** Partial (`HouseholdAccessTests.cs::Revoke_removes_a_member_but_never_the_owner`)

### INV-052 - A revoked pending link is no longer redeemable
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** A link invite for `robin@x.eu` created (INV-008), then revoked by the owner (INV-051), before Robin opens it.
- **Steps:**
  1. Robin opens the (now stale) `/accept-invite?code=<token>` and clicks "Accept invite".
- **Expected:** The membership no longer exists, so the token-hash lookup finds nothing → 404 "This invite link is invalid or has already been used." Revoking a pending invite immediately and permanently invalidates its link. Robin must be re-invited (a fresh token) to join.
- **Automated:** No

### INV-053 - Owner's own membership can never be removed via the access API
- **Priority:** P2
- **Type:** Negative
- **Origin:** gotcha #8 (owner is immovable — invite/role/revoke all reject the owner)
- **Preconditions:** Fixture B; owner row.
- **Steps:**
  1. Attempt `DELETE /access/members/{ownerMembershipId}` and `PUT /access/members/{ownerMembershipId}/role`.
- **Expected:** Revoke → 403 "The owner cannot be removed from the household." Role change → 403 "The owner's role cannot be changed." The UI never renders Remove/role controls on the owner's own row (it shows a static role Badge). This guards against an invite/revoke flow orphaning the household. Full owner-immutability coverage → `16-people-households.md`.
- **Automated:** Partial (`HouseholdAccessTests.cs::Revoke_removes_a_member_but_never_the_owner`, `Change_role_updates_a_member_but_not_the_owner`)

### INV-054 - Revoking an accepted pure invitee strands them in an un-seeded own household
- **Priority:** P2
- **Type:** Regression
- **Origin:** invite-household-coherence gotcha #26 (only accept-invite Path B creates a login with NO own household; revoking that login's only membership self-heals via the Owner-of-self middleware fallback but `HouseholdBootstrap` never ran, so no owner member / no months, and `/auth/me` synthesizes an `isOwn:true` entry → the "Start my own budget" card never appears)
- **Preconditions:** Robin accepted a link invite as a brand-new login (INV-033) — she is a pure invitee with exactly one membership and no own household. Owner then Removes Robin's now-Active membership from `/people`.
- **Steps:**
  1. As owner, click "Remove" on Robin's Active row (`DELETE /access/members/{id}` → 204).
  2. Sign in as Robin and inspect the dashboard, `/people`, and `/account`.
- **Expected:** Robin's only membership is hard-deleted, so the next request resolves her as Owner-of-self via `ActiveHouseholdSelector` — but no `HouseholdBootstrap` ever ran for her: no owner budget person (empty People page) and no budget months (create-month hero). Because `/auth/me` synthesizes a lone `isOwn:true` "Your household" entry, `ownsHousehold=true`, so the `/account` "Start my own budget" card does **not** appear — she can only build up manually from the empty dashboard. This is distinct from *leaving* a household (which materializes an own household properly, PR #158). Confirm and file as a data-integrity edge; contrast with the leave flow. General revoke-of-active-member coverage → `16-people-households.md`.
- **Automated:** No
