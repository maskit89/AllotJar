# Subsystem map: Auth (server + client), registration, session, account prefs

Source of truth: worktree `C:\Users\Laptop\Documents\Projects\ZeroBudget-wt-test-catalog` (branch `docs/functional-test-catalog`, includes PRs #169, #170, #171, #172 — commit `99ec47f` and earlier). NOTE: the main clone `C:\Users\Laptop\Documents\Projects\ZeroBudget` is 1 commit behind (missing #171); all citations below are from the worktree. Paths below are repo-relative.

---

## 1. Screens & routes

Routing lives in `client/src/App.tsx`.

| Route | Component | When shown / guard |
|---|---|---|
| `/login` | `LoginPage` | While `bootstrapping` → `AuthSplash` spinner (`role="status"`, sr-only "Loading…"); if already authenticated → `AuthedLoginRedirect` (navigates to sanitized `?returnUrl` or `/`); else the page (App.tsx:63-68). |
| `/login?register=1` | `LoginPage` register tab | Any `register` param pre-selects the "Create account" tab (LoginPage.tsx:21-23). Deep-linked from the landing page. |
| `/login?reason=expired[&returnUrl=…]` | `LoginPage` + amber expiry banner | Produced by `sessionExpired()` in `lib/api.ts` when a session is genuinely dead (PR #169). Banner shows only in **login** mode (LoginPage.tsx:109-117). |
| `/` | `LandingPage` (anon) / `DashboardPage` (authed) | Splash while bootstrapping so authed users never flash the landing (App.tsx:73-81). |
| `/account` | `AccountPage` | Wrapped in `RequireAuth` (App.tsx:153-160). |
| `/accept-invite` | `AcceptInvitePage` | Public (no guard) — both anonymous invite redemption and signed-in join (App.tsx:69). |
| `/privacy`, `/terms` | Legal pages | Public, available signed in or out (App.tsx:71-72). |
| `*` | `Navigate to /` | Catch-all (App.tsx:179). |

Guard mechanics:
- `RequireAuth` (App.tsx:38-48): splash while `bootstrapping`; if unauthenticated → `<Navigate to="/login?returnUrl=<encoded pathname+search>">` (suffix omitted when current location is exactly `/`).
- `AuthedLoginRedirect` (App.tsx:51-54): honours `?returnUrl` via `safeInternalPath` (see §4).
- Feature-flagged routes (from `useFeatures`, server `GET /api/features` → `Features` config section, all default ON in `appsettings.json:22-27`): `/accounts`, `/accounts/:id` (accounts), `/jars` (jars), `/people`, `/allocation` (householdAllocation), `/reports` (reports), `/import` (camtImport). Flag off ⇒ route not registered ⇒ falls to catch-all → `/`.
- `ConsentModal` renders whenever `isAuthenticated` (App.tsx:184) but self-hides unless `needsConsent`, and also self-hides on `/terms` and `/privacy` so it never covers the text being consented to (ConsentModal.tsx:20-22). Not dismissible — only "I agree" or "Sign out".
- `Onboarding` mounts only when `isAuthenticated && !needsConsent` (App.tsx:183) so its focus-trap can't sit under the consent prompt.

---

## 2. UI controls & user actions (exact labels)

### LoginPage (`client/src/pages/LoginPage.tsx`)
- `StagingBanner` (staging build only, `role="status"`): "**Staging** — this is the AllotJar test environment. Features may change and your data can be reset or lost without notice." (StagingBanner.tsx:29-31; gated on `IS_STAGING` = `VITE_APP_ENV === 'staging'`, env.ts:16).
- ThemeToggle top-right. Jar logo + heading "AllotJar", tagline "Zero-based budgeting, in your currency."
- Expired-session banner (`role="status"`): "Your session has expired, so we signed you out to keep your budget safe. Sign back in to pick up where you left off." — only when `?reason=expired` AND mode is login.
- `SegmentedControl` aria-label "Sign in or create an account", options **"Sign in"** / **"Create account"**. Switching tabs clears the error (LoginPage.tsx:47-50).
- Shared fields: label "Email" (`type=email`, required, placeholder "you@example.com"); label "Password" (`type=password`, required, `minLength=8`, placeholder "At least 8 characters", autocomplete `current-password` vs `new-password`).
- Register-only fields:
  - "First name" / "Last name" (both `required`, side by side).
  - "Currency" select — 24 options from `CURRENCY_OPTIONS` (money.ts:69-94), labels like "Euro (€)", "British pound (£)", … "Turkish lira (₺)". Pre-selected from browser locale (`detectLocaleDefaults`, money.ts:191-195), fallback EUR.
  - "Number format" select — 5 options from `NUMBER_FORMAT_OPTIONS` (money.ts:55-61): `1,234.56` (comma-dot), `1.234,56` (dot-comma), `1 234,56` (space-comma), `1'234.56` (apostrophe), `1,23,456.78` (lakh). Pre-selected from locale.
  - Hint text: "You can change your currency and number format anytime in account settings."
  - Sample-data checkbox (NOT required, default **unchecked** — PR #170): "Start with sample figures to explore — example groups and amounts you can edit or delete anytime. Leave unticked to start with an empty budget."
  - Terms checkbox (`required`): "I agree to the **Terms of Service** and **Privacy Policy**." (links open `/terms`, `/privacy` in new tab).
  - Staging-only checkbox (`required`, only when `IS_STAGING`): "I understand this is the AllotJar **staging** test environment, and that my data may be reset or permanently lost." — client-side only; not sent to the server.
- Submit button: "Sign in" / "Create account" / "Please wait…" while busy (disabled).
- Error `role="alert"` in rose text (see §4 for content resolution).
- Footer tagline: "Give every {currencyNoun} a job." — noun follows the **locale-detected** currency (e.g. "every euro", "every rupee"; unknown → "unit") (LoginPage.tsx:313-315, money.ts:130-133).
- On success: `navigate(returnUrl ?? '/', { replace: true })`; analytics `login {method:'password'}` or `sign_up {method:'password', sample_data:bool}`; on failure `login_failed {method:'password'}` (LoginPage.tsx:71-78, analytics/events.ts:8-12).

### AccountPage (`client/src/pages/AccountPage.tsx`, route `/account`)
- `PageHeader` title "Account", subtitle "Your details, preferences and password."
- Read-only card: "Email", "Name" (displayName or "—"), "Access level" (`HOUSEHOLD_ROLE_LABELS`: 0 Owner / 1 Admin / 2 Limited / 3 Read-only, fallback "Member"; types.ts:445-450).
- "Your own budget" card — only when `!ownsHousehold` (login joined others but owns nothing): body "You're a member of a shared household. Want a budget of your own too? …" Button **"Start my own budget"** → "Setting up…"; error banner "Could not start your budget. Please try again." On success → full navigation to `/?started=1` (AuthContext.tsx:306-310).
- "Sharing" card — hidden while `householdLoading`. If `isShared` (≥2 members): "This budget is shared between N people. …" + link **"Manage people →"** to `/people`. Else: "You're budgeting on your own. …" + Button **"Share this budget"** → navigates `/people`.
- "Leave this household" card — only when the ACTIVE household is one the user joined (`viewingJoined` = active household not own; AccountPage.tsx:33-34). Button **"Leave household"** → inline confirm "Are you sure?" + **"Yes, leave"** ("Leaving…") + **"Cancel"**. Error "Could not leave this household. Please try again." Success → full navigation to `/?left=1` (AuthContext.tsx:312-318).
- "Preferences" card: "First name", "Last name" (not required — can be blanked), "Currency" and "Number format" selects (same option lists as sign-up), Button **"Save preferences"** ("Saving…"), success `role="status"`: "Your preferences have been saved."
- "Change password" card: "Current password" (required), "New password" (required, minLength 8, placeholder "At least 8 characters"), "Confirm new password" (required, minLength 8). Button **"Change password"** ("Saving…"), success `role="status"`: "Your password has been changed." Fields cleared on success; analytics `password_changed`.

### AppShell account menu (`client/src/components/AppShell.tsx`)
- User chip (aria-label "Account menu") shows displayName + "{preferredCurrency} · {household label}". Menu (`role="menu"`):
  - Household section (only when >1 household): each household as a menuitem, active marked "✓"; clicking a non-active one calls `switchHousehold` → `POST /households/switch` → full nav to `/` (AuthContext.tsx:300-304).
  - **"Account settings"** → `/account`.
  - **"Sign out"** → analytics `logout`, then `logout()` (fire-and-forget `POST /auth/logout`, clear state, cross-tab broadcast; AuthContext.tsx:347-352).
- Role banners (AppShell.tsx:165-169): read-only → "You have read-only access — you can view everything but cannot make changes."; limited → "You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings."

### ConsentModal (`client/src/components/ConsentModal.tsx`)
- Heading "One thing before you start"; body "Your login was set up for you, so we need your own agreement to the Terms of Service and Privacy Policy before you continue."
- Buttons **"I agree"** ("Please wait…") and **"Sign out"**. Error `role="alert"`: "Something went wrong saving your agreement — please try again."
- Shown for logins with `MeResponse.NeedsConsent == true` (i.e. `ConsentedUtc == null` — owner-created logins with temp passwords, or legacy accounts). Registration and invite acceptance record consent up front, so most users never see it.

### AcceptInvitePage (`client/src/pages/AcceptInvitePage.tsx`) — auth-relevant parts
- Anonymous path: "Display name" (placeholder "e.g. Liza") + "Password" (placeholder "At least 8 characters") + terms; signed-in path: heading "Join the household" + join button. Calls `POST /api/auth/accept-invite` (full page detail belongs to the invites subsystem map).

---

## 3. API endpoints

All under `api/auth` in `src/AllotJar.Api/Controllers/AuthController.cs` unless noted. `[EnableRateLimiting("auth")]` = fixed-window **20 requests/min per source IP**, queue 0, reject **429** (Program.cs:57-70; configurable via `RateLimiting:AuthPermitLimit` / env `RateLimiting__AuthPermitLimit`; behind the IIS/Cloudflare proxy `RemoteIpAddress` is the proxy, so it is effectively a per-site cap — the per-account Identity lockout is the real defence).

| Verb + route | Auth | Rate-limited | Success | Failures |
|---|---|---|---|---|
| `POST /api/auth/register` | anonymous | yes | 200 `AuthResponse` + sets `zbb_rt` cookie | 400 (see §4) |
| `POST /api/auth/login` | anonymous | yes | 200 `AuthResponse` + cookie | 401 invalid / 401 locked-out |
| `POST /api/auth/accept-invite` | `[AllowAnonymous]` (works signed-in too — bearer picked up for Path A) | yes | 200 `AuthResponse` + cookie | 400 / 403 / 404 |
| `POST /api/auth/refresh` | `[AllowAnonymous]`, cookie-driven | yes | 200 `AuthResponse` + rotated cookie | 401 (cookie cleared EXCEPT on grace-window supersede — PR #171, AuthController.cs:176-187) |
| `POST /api/auth/logout` | `[AllowAnonymous]` | yes | 204, revokes refresh token, **rotates security stamp** (kills the access token instantly), clears cookie | — (idempotent; no cookie → still 204) |
| `POST /api/auth/change-password` | `[Authorize]` | yes | 200 `AuthResponse` (fresh token + cookie for THIS device; **revokes ALL refresh tokens** first) | 400 `{errors:[…]}` / 401 |
| `GET /api/auth/me` | `[Authorize]` | no | 200 `MeResponse` (userId, email, displayName, role, ownerId, memberId, firstName, lastName, preferredCurrency, numberFormat, households[], needsConsent) | 401 |
| `POST /api/auth/consent` | `[Authorize]` | no | 204 (idempotent — only sets `ConsentedUtc` when null) | 401 |
| `PUT /api/auth/preferences` | `[Authorize]` | no | 200 `PreferencesResponse` | 400 / 401 |
| `POST /api/households/switch` | `[Authorize]` (HouseholdsController.cs:39) | no | 204 (sets `ActiveOwnerId`, null = own; effect on NEXT request) | 404 `{error:"You don't have access to that household."}` / 401 |
| `POST /api/households/start-own` | `[Authorize]` | no | 204 (bootstraps own household with `seedSampleBudget:false`, switches into it; idempotent) | 401 |
| `POST /api/households/leave` | `[Authorize]` | no | 204 (removes membership; re-bootstraps own household **without samples**; resets active if needed) | 400 "You can't leave your own household." / 400 "The owner can't leave their own household." / 404 "You don't have access to that household." / 401 |
| `GET /health` | anonymous | no | 200 liveness (Program.cs:139) | — |

No per-role gating on any auth endpoint — role is resolved per request by `HouseholdResolutionMiddleware` (Middleware/HouseholdResolutionMiddleware.cs) from active memberships + `ActiveOwnerId`, so revokes/downgrades/switches take effect immediately (role is NOT baked into the JWT).

Refresh cookie (`AuthController.cs:446-465`): name `zbb_rt`, HttpOnly, `SameSite=Strict`, `Path=/api/auth`, expires +30 days, `Secure = !Development`, IsEssential.

JWT (`Infrastructure/Identity/JwtTokenGenerator.cs`, `DependencyInjection.cs:106-172`): HS256 only (`ValidAlgorithms` pinned), issuer `ZeroBudget`, audience `ZeroBudgetClient`, **ExpiryMinutes 15** (appsettings.json:17; class default is 60 if unset — prod template doesn't override), ClockSkew 30s, claims: `sub`, `nameidentifier`, `email`, `jti`, `sstamp` (security stamp). `OnTokenValidated` re-checks `sstamp` against `Users.SecurityStamp` every request: no-stamp legacy token → allowed; DB error → **fail open**; definite mismatch → 401 "This session has been revoked." Key must be ≥32 bytes or startup throws.

---

## 4. Validation rules & exact error messages

### Server — registration (`AuthController.Register`, in order)
1. `AcceptedTerms == false` → 400 `{error: "Please accept the terms and privacy policy to create an account."}`
2. Invalid currency → 400 `{error: "That isn't a valid ISO 4217 currency code."}` — validation is `CurrencyCode.From`: trim, uppercase, regex `^[A-Z]{3}$` (Domain/ValueObjects/CurrencyCode.cs:40) — **any 3 letters pass** (e.g. "XXX" is accepted); blank falls back to EUR (UserPreferences.cs:41-56).
3. Invalid number format → 400 `{error: "That number format isn't supported."}` — allowed keys: `comma-dot`, `dot-comma`, `space-comma`, `apostrophe`, `lakh`; blank → `comma-dot` (UserPreferences.cs:31-35, 62-71).
4. Duplicate email → 400 `{error: "An account with that email already exists."}` (case-insensitive via Identity normalized email).
5. Identity create failure → 400 `{errors: ["…", …]}` (array). Password policy (DependencyInjection.cs:64-75): min length 8, `RequireNonAlphanumeric=false`, but Identity defaults **RequireDigit / RequireLowercase / RequireUppercase remain ON** (default messages e.g. "Passwords must have at least one digit ('0'-'9')."). Plus HIBP `BreachedPasswordValidator`: → "This password has appeared in a known data breach. Please choose a different one." (code `PwnedPassword`; k-anonymity 5-char SHA-1 prefix + Add-Padding; 5s timeout; **fails OPEN** on outage; never runs at login) (Identity/BreachedPasswordValidator.cs).
- DataAnnotations on `RegisterRequest` (`Contracts/Auth/AuthContracts.cs:10-18`): `[Required, EmailAddress] Email`, `[Required, MinLength(8)] Password`, `[Required] FirstName/LastName` — model-binding failures return the standard ASP.NET **ValidationProblemDetails** shape (`{"errors":{"Email":[…]}}`, different from the app's `{error:…}` shape). Note: `[Required]` allows whitespace-only names; `NullIfBlank` then nulls them → DisplayName becomes null.

### Server — login (`AuthController.Login` + `LoginCommandHandler` + `IdentityService.CheckCredentialsAsync`)
- Unknown email AND wrong password both → 401 `{error: "Invalid email or password."}` (anti-enumeration; unknown-email path burns a dummy PBKDF2 verify for timing equalization, IdentityService.cs:14-16, 83-90).
- Locked out → 401 `{error: "Your account is temporarily locked after too many failed sign-in attempts. Please try again in a few minutes."}` Lockout: **5 consecutive failures → 15 min** (DependencyInjection.cs:72-74); `LockoutEnabled` self-heals to true on first check for legacy logins; a failure that crosses the threshold returns LockedOut immediately; successful login resets the counter.

### Server — refresh (`AuthController.Refresh` + `RefreshTokenService.RotateAsync`)
- No cookie → 401 (no body), cookie NOT cleared (there is nothing to clear; `ClearRefreshCookie` not called on this path — AuthController.cs:170-174).
- Unknown/expired token, or admin-revoked (logout/password change) replay → 401, cookie cleared.
- **Rotated token replayed within 30s of rotation** (`ReplayGraceWindow`, RefreshTokenService.cs:26) → 401 `Superseded`, **cookie NOT cleared** (would evict the winning tab's fresh cookie from the shared jar) and **NO family burn** (PR #171).
- Rotated token replayed after 30s → theft response: `RevokeAllForUserAsync` burns every active refresh token, 401, cookie cleared.
- Valid → rotate: old token revoked + `ReplacedByTokenHash` set, new 30-day token issued (sliding session — every refresh re-extends 30 days, BY DESIGN), fresh JWT returned.
- User deleted since issue → 401, cookie cleared (AuthController.cs:183-188 in worktree numbering).

### Server — change password
- Wrong current password → 400 `{errors: ["Incorrect password."]}` (Identity default `PasswordMismatch`). New password runs the full policy incl. HIBP → same messages as registration. Success revokes all refresh tokens (other devices' next refresh 401s → sign-in prompt) and the stamp rotation inside `ChangePasswordAsync` kills outstanding access tokens.

### Server — preferences (`AuthController.UpdatePreferences`)
- Blank `preferredCurrency`/`numberFormat` = "leave as is" (a name-only save can't reset them, AuthController.cs:390-403). Invalid values → the same 400 `{error:…}` messages as registration. First/Last may be blanked (nulls the DisplayName).

### Server — accept-invite (thrown as `ValidationException`/`NotFoundException`/`ForbiddenAccessException` → `ExceptionHandlingMiddleware` shapes: 400 `{status,title:"Validation failed",errors:{Field:["msg"]}}`, 404/403 `{status,title:"msg"}`)
- Invalid/used token → 404 "This invite link is invalid or has already been used."
- Expired → 403 "This invite link has expired."
- Signed-in, wrong email → 400 Email: "This invite was sent to a different email address."
- Signed-in, already a member → 400 Email: "You already have access to this household."
- Anonymous but account exists → 400 Email: "You already have an account — sign in first, then open this link to join."
- Password missing/<8 → 400 Password: "Choose a password of at least 8 characters."
- Terms not accepted (anonymous path) → 400 AcceptedTerms: "Please accept the terms and privacy policy to create your login."
- Identity create failure (incl. HIBP) → 400 Password: [descriptions].
(`Application/HouseholdAccess/Commands/AcceptInvite/AcceptInviteCommandHandler.cs`.)

### Client-side
- LoginPage: HTML5 `required`/`minLength=8` on inputs; required checkboxes (terms, staging). Submit error text = `data.error ?? data.errors.join(' ') ?? 'Something went wrong.'` (LoginPage.tsx:79-84). Note: the middleware's `errors` object shape (accept-invite) is NOT parsed here — LoginPage only handles login/register whose bodies are `{error}` or `{errors:[…]}`.
- AccountPage change password (pre-submit): "The new passwords do not match."; "Use a new password of at least 8 characters." Server failure fallback: "Could not change your password." Preferences fallback: "Could not save your preferences."
- Unexpected/network error: "Something went wrong."

---

## 5. State variants

- **Cold-load bootstrap**: no in-memory token ⇒ `bootstrapping=true` ⇒ one `refreshSession()` attempt from the HttpOnly cookie; splash on `/login` and `/` and inside `RequireAuth` until done (AuthContext.tsx:118-204). StrictMode double-mount is covered by the module-level single-flight.
- **Signed-out**: `/` shows LandingPage; guarded routes bounce to `/login?returnUrl=…`.
- **Session expired mid-use**: any non-credential 401 → silent refresh → retry once; refresh fails ⇒ `sessionExpired()` → state cleared, cross-tab broadcast, hard nav `/login?reason=expired&returnUrl=…` (api.ts:47-78, 140-158). Credential endpoints exempt from retry: `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/accept-invite`, `/auth/logout` — a LIST, not the `/auth/` prefix (api.ts:136; `/auth/me`, `/auth/preferences`, `/auth/change-password`, `/auth/consent` DO refresh-retry — PR #169).
- **Idle tab returns**: `focus`/`visibilitychange` revalidation when `isAccessTokenExpired()` (expiry epoch tracked from `AuthResponse.expiresAtUtc`); silent re-arm on success, `sessionExpired()` on failure (AuthContext.tsx:162-178).
- **Cross-tab**: BroadcastChannel `zbb.auth`, message `'signed-out'`; receiver clears state only `if (getToken())` (ignores its own broadcast; no loops). Degrades silently without BroadcastChannel (authChannel.ts).
- **Multi-tab refresh race** (session restore): per-tab single-flight + server 30s grace (§4) means losers get 401-without-cookie-clear and retry off the winner's cookie.
- **localStorage persistence** (identity hints only, never the token): `zbb.email`, `zbb.role`, `zbb.displayName`, `zbb.currency`, `zbb.numberFormat`. On a fresh tab before `/auth/me` resolves, role falls back to **Owner** (`storedRole()`, AuthContext.tsx:96-100) — UI chrome may briefly over-render; server enforces real role per request. `/auth/me` refires on every token change and re-syncs role/prefs/households/needsConsent; malformed `/auth/me` payloads are ignored (never downgrade, AuthContext.tsx:237-251).
- **Role variants**: Owner(0)/Admin(1)/Limited(2)/ReadOnly(3). Derived: `canManageHousehold` = Owner only; `canWrite` = ≤Admin; `canEnterData` = ≤Limited; `isReadOnly` = ReadOnly (AuthContext.tsx:365-368). Read-only/limited banners in AppShell.
- **Solo vs shared**: Sharing card swaps copy/CTA on `isShared` (≥2 members); card hidden entirely while household data loads. People nav always visible (project invariant).
- **Multi-household**: switcher section in the account menu only when `households.length > 1`; `MeResponse.Households` labels own as "Your household", others by owner displayName ?? email ?? "Household", ordered own-first then label; a login with zero membership rows still gets a synthesized own-household entry (AuthController.cs:333-368).
- **needsConsent**: blocking ConsentModal (see §2); `/auth/me` computes it as `ConsentedUtc is null`.
- **Staging vs GA build**: `IS_STAGING` gates the banner + the extra data-loss checkbox; GA build renders neither.
- **Empty new account (PR #170 default)**: register without the sample checkbox ⇒ NO months seeded ⇒ dashboard create-month hero ("No budget for … yet" / plan-your-income prompt per PR #172), not the gold badge. With checkbox ⇒ sample month (Income "Take-home Pay" 3000 planned, Housing/Transport/Food/… groups, real "Emergency Fund" jar) with positive Remaining-to-budget on purpose (BudgetSeeder.cs:9-12,49).
- **`?started=1` / `?left=1`** greetings after start-own / leave (full navigations; AppShell renders the greeting).
- **Deleted user with live cookie**: refresh → user lookup fails → 401 + cookie cleared.
- **Legacy JWT without `sstamp`**: allowed until natural expiry (SecurityStampValidation.cs:17-21).
- **HIBP outage**: registration/change-password proceed (fail open).
- **Rate-limit burst**: >20 auth calls/min from one source → 429 (no body configured). E2E can raise via `RateLimiting__AuthPermitLimit`.

---

## 6. Computed/derived values & money rules

- `DisplayName = ($"{FirstName} {LastName}").Trim()`, null when empty; First/Last are `NullIfBlank`-trimmed (AuthController.cs:421-431). Recomputed on every preferences save.
- `AuthResponse.Role` (login/register/refresh/change-password) = **first active membership row's role** (`FirstOrDefault`, no explicit ordering) or Owner if none (AuthController.cs:467-477, LoginCommandHandler.cs:41-44) — for multi-household logins this is *a* role, not necessarily the active household's; `/auth/me` returns the resolved active-household role (`_currentUser.Role ?? Owner`) and refreshes the client shortly after.
- Active household resolution: `ActiveOwnerId` on the user (null = own household) → `ActiveHouseholdSelector.Pick` over active memberships per request (HouseholdResolutionMiddleware.cs). No membership rows ⇒ caller owns their own household with role Owner.
- Refresh tokens: 32 bytes CSPRNG → base64url (no padding); stored only as hex SHA-256; lifetime 30 days from each issue/rotation (`RefreshTokenService.LifetimeDays`, sliding). Reuse categories: revoked+replaced = rotation replay (grace/theft), revoked-without-replacement = admin-revoked (plain refuse).
- Access token expiry client-side: `accessTokenExpiresAt = Date.parse(expiresAtUtc)`; `isAccessTokenExpired()` = token present && now ≥ expiry (api.ts:23-32).
- Client money: integer minor units at scale 4 (`FACTOR = 10_000`), matching server decimal(18,4); all sums integer; conversion only at API boundary/display (money.ts:1-32).
- Number-format key → render locale: comma-dot→en-GB, dot-comma→de-DE, space-comma→fr-FR, apostrophe→de-CH, lakh→en-IN (money.ts:46-52); `setMoneyFormat` sets a module-level locale applied app-wide (called on mount, on `/auth/me`, on prefs save, reset to default on logout/state-clear).
- Locale detection at sign-up (money.ts:145-195): browser region → currency via 24-entry map (unlisted → EUR); number format: IN→lakh, CH/LI→apostrophe, else inferred from `Intl.NumberFormat` group/decimal separators; SSR-safe fallback EUR/comma-dot.
- `currencyNoun`: per-currency singular ("euro", "pound", "złoty"…; unknown → "unit") for the "Give every ___ a job" tagline.
- `safeInternalPath` (lib/returnUrl.ts): accepts only single-slash-rooted paths; rejects null, non-`/`-prefixed, `//…`, `/\…`, and any control char 0x00-0x1F/0x7F (WHATWG-parser strip attack).
- `loginRedirectPath` (api.ts:66-71): null when already on `/login`; `returnUrl` omitted when at `/`; always carries `reason=expired`.

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **`refreshSession()` is the ONE single-flight for `/auth/refresh`** (PR #157) — never POST it directly; React StrictMode double-mount would replay a rotated cookie. Regression test mounts AuthProvider under StrictMode and asserts exactly one POST (`client/src/auth/AuthContext.test.tsx`).
2. **Grace 401 must NOT clear the cookie** (PR #171) — `RefreshRotationResult.Superseded` skips `ClearRefreshCookie()`; the browser cookie jar is shared across tabs, so clearing would evict the winning tab's fresh cookie and sign it out ~15 min later. Don't widen/narrow `ReplayGraceWindow` (30s) casually; outside-window replay MUST still burn the family (theft response), and admin-revoked replays must NOT burn (a stale signed-out device would nuke fresh sessions).
3. **Interceptor exemption is a LIST, not the `/auth/` prefix** (PR #169) — re-broadening it makes `/account` a dead end that can never prompt re-login.
4. **Logout rotates the security stamp** (PR #169) — the current access token dies immediately; other devices recover silently via their own cookies. Change-password revokes ALL refresh tokens and returns 200 `AuthResponse` (used to be 204) which the client must `apply()`.
5. **Sample budget is opt-in** (PR #170) — `HouseholdBootstrap.EnsureOwnHouseholdAsync` takes a required `seedSampleBudget`; register passes `RegisterRequest.IncludeSampleData`; `/households/start-own` and `/households/leave` ALWAYS pass false. `BudgetSeeder.SeedDefaultMonthAsync` guard is **owner-has-ANY-month** (not per-month) — a late seed can never inject samples into an established budget. Owner membership + owner member #1 remain unconditional (never a 0-member household).
6. **PR #172 interaction**: default (no-sample) registration lands on an empty month — `IsBalanced` now requires `TotalIncome > 0`, so the hero shows the plan-your-income prompt, never the gold "every euro has a job" badge; blank month for a jar-owning household lands over-budgeted (accrual savings lines). Registration tests asserting the landing must match sample vs blank (`client/e2e-journey/helpers.ts` `register(sampleBudget?)`).
7. **Session is a sliding 30-day window BY DESIGN** — every refresh re-extends cookie+DB row 30 days; "still signed in next day" is correct behavior, not a bug.
8. **Anti-enumeration invariants**: identical 401 body for unknown-email vs wrong-password; dummy-hash timing equalization on unknown email. Registration DOES reveal account existence ("An account with that email already exists.") — accepted trade-off.
9. **HIBP fails OPEN and never runs on login**; passwords like "password"/"Password1" are rejected at register/change-password in live envs — e2e must use non-breached passwords (journey-e2e gotcha).
10. **Rate limiter is effectively per-site behind Cloudflare/IIS** (RemoteIpAddress = proxy); serial e2e runs can trip it — raise `RateLimiting__AuthPermitLimit` for test runs.
11. **Client tests**: `vi.mock('../lib/api')` factories MUST spread `...(await importOriginal())` (Vitest 4 throws on missing exports); jsdom's `window.location` is unforgeable — spy on the exported `navigation.assign` seam instead; `client/src/test/setup.ts` polyfills BroadcastChannel.
12. **GA params are whitelisted** — auth events: `login`, `sign_up` (+`sample_data`), `login_failed`, `logout`, `password_changed`, `password_reset_requested`, `password_reset_completed` (the reset pair carries no params); any new `track()` param must be added to `ALLOWED_PARAM_KEYS` in `client/src/analytics/redact.ts` or it is silently dropped.
13. **JWT config fail-fast**: missing/short (<32-byte) `Jwt:Key` throws at startup; running the published DLL from the wrong cwd loses appsettings → must pass `Jwt__Issuer/Jwt__Audience/Jwt__Key` env vars (IDX10208 audience errors otherwise).
14. **Security-stamp check fails OPEN on DB errors** (a blip must not log everyone out) and legacy stampless tokens pass — only a definite mismatch revokes ("This session has been revoked.").
15. **Password reset (built 2026-07, auth-roadmap Phase 2)**: `POST /auth/forgot-password` is always 204 and **constant-time** — the account lookup + provider send run OFF the request path (`AuthController.DispatchResetEmail`, `Task.Run` + a fresh DI scope), so a real vs unknown address are indistinguishable by status, body AND latency, and a slow/failing Resend call can neither hang the caller nor turn into a 500-for-existing-accounts oracle (background failures logged only). It emails `{Email:AppBaseUrl}/reset-password?email=…&token=…` — base URL is CONFIG-ONLY (never Host headers). Tokens are Identity DataProtector tokens, **2h lifespan** (`DataProtectionTokenProviderOptions` in `DependencyInjection.cs`; pinned against the real container, not just a test-local Configure); single-use via the security-stamp rotation inside `ResetPasswordAsync`. `POST /auth/reset-password` answers the generic invalid-link 400 for unknown-email AND real-user-bad-token (byte-identical — no oracle), passes Identity password-policy/HIBP errors through (the one helpful 400), and on success **clears any lockout** (`SetLockoutEndDateAsync(null)` + `ResetAccessFailedCountAsync` — a locked-out user is the common reset trigger), revokes ALL refresh tokens (access token AND refresh cookie die — both pinned over HTTP) + signs the device in (200 `AuthResponse` + fresh cookie, change-password style). Email: `IEmailSender` is **provider-selectable by config** (`Email:Provider`) — `CloudflareEmailSender` (Cloudflare Email Service REST API, account-scoped, **also needs `Email:AccountId`**; its `client/v4` API can return **HTTP 200 with `success:false`**, so the envelope is checked as well as the status) or `ResendEmailSender` (the default when `Provider` is blank, for back-compat). No/incomplete config → `LoggingEmailSender` → `DevEmailSink`; the choice is made ONCE at startup and Program.cs logs which provider resolved (or warns that email is log-only), because a bad provider config degrades silently rather than taking the API down. The sink is readable at the **Development-only** `GET /api/dev/emails?to=…` (journey tests POLL it — the send is async — and follow the real link; `Email__AppBaseUrl` → app origin in `playwright.journey.config.ts`). **Prod prerequisites: `DataProtection:KeysPath`** (else an app-pool recycle invalidates every outstanding link) **encrypted at rest with `ProtectKeysWithDpapi(protectToLocalMachine)`** on Windows (the no-profile app pool has no CurrentUser DPAPI, so keys would otherwise be plaintext — forgeable reset tokens). **Still not built**: Google SSO, GET /auth/preferences (only PUT exists; reads via /auth/me). Username == email.
16. **`AuthResponse.Role` may differ from the active household's role** for multi-household logins (FirstOrDefault, see §6) — the client treats it as provisional and corrects from `/auth/me`.
17. Journey harness (`client/e2e-journey/`, real API :5099 + SQL) is the only full-stack layer: `session-expiry.spec.ts` (revoked tab → prompt → returnUrl round-trip; password change signs out device A, device B unaffected), `concurrent-refresh.spec.ts` (same-cookie race over HTTP; fresh `request.newContext()` per call with explicit cookie header), `register.spec.ts`, `invite.spec.ts` (leave leg pins never-seed), `password-reset.spec.ts` (follows the actual emailed link via the dev mailbox; replay leg). `page.request.post('/api/auth/logout')` shares the browser cookie jar — handy to kill a session mid-test.
18. Cookie `Path=/api/auth` — the refresh cookie rides only on auth endpoints; XSS cannot read it (HttpOnly) and the access token is in-memory only (never localStorage).

---

## 8. File index (read for this map)

Server:
- `src/AllotJar.Api/Controllers/AuthController.cs` — all /api/auth endpoints, cookie handling
- `src/AllotJar.Api/Controllers/HouseholdsController.cs` — switch / start-own / leave
- `src/AllotJar.Api/Contracts/Auth/AuthContracts.cs` — Register/Login/AcceptInvite/ChangePassword/UpdatePreferences/Me/HouseholdSummary DTOs
- `src/AllotJar.Api/Program.cs` — rate limiter, pipeline order, startup backfills, health check
- `src/AllotJar.Api/Middleware/HouseholdResolutionMiddleware.cs`, `src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs`
- `src/AllotJar.Api/appsettings.json`, `src/AllotJar.Api/appsettings.Production.json.example`
- `src/AllotJar.Infrastructure/DependencyInjection.cs` — Identity options, JWT bearer + sstamp validation, HIBP/FX HttpClients
- `src/AllotJar.Infrastructure/Identity/{RefreshTokenService,BreachedPasswordValidator,IdentityService,JwtTokenGenerator,JwtSettings,SecurityStampValidation,UserPreferences,ApplicationUser}.cs`
- `src/AllotJar.Infrastructure/Persistence/{HouseholdBootstrap,BudgetSeeder}.cs`
- `src/AllotJar.Application/Auth/Commands/Login/LoginCommandHandler.cs`
- `src/AllotJar.Application/Common/Interfaces/IRefreshTokenService.cs` (`Superseded` flag)
- `src/AllotJar.Application/HouseholdAccess/Commands/AcceptInvite/AcceptInviteCommandHandler.cs`
- `src/AllotJar.Domain/ValueObjects/CurrencyCode.cs`

Client:
- `client/src/lib/api.ts` — axios instance, token store, single-flight refresh, 401 interceptor, sessionExpired, loginRedirectPath
- `client/src/lib/authChannel.ts` — cross-tab BroadcastChannel `zbb.auth`
- `client/src/lib/returnUrl.ts`, `client/src/lib/env.ts`, `client/src/lib/money.ts`
- `client/src/auth/AuthContext.tsx` — provider, bootstrap, focus revalidation, login/register/acceptInvite/changePassword/updatePreferences/logout/switch/start-own/leave
- `client/src/App.tsx` — routes, RequireAuth, AuthedLoginRedirect, consent/onboarding mounting
- `client/src/pages/LoginPage.tsx`, `client/src/pages/AccountPage.tsx`, `client/src/pages/AcceptInvitePage.tsx` (labels only)
- `client/src/components/{ConsentModal,StagingBanner,AppShell}.tsx`
- `client/src/analytics/events.ts`, `client/src/analytics/redact.ts` (auth event names + param whitelist)
- `client/src/types.ts` (HouseholdRole labels/hints)
- `client/e2e-journey/` spec names (session-expiry, concurrent-refresh, register, invite)

Memory/audit notes cross-checked: `auth-refresh-single-flight.md`, `security-review.md`, `auth-registration-roadmap.md`, `session-expiry-login-prompt.md`, `refresh-replay-grace.md`, `optional-sample-budget.md` (all under `C:\Users\Laptop\.claude\projects\C--Users-Laptop-Documents-Projects\memory\`). All behavioral claims above were verified against the worktree code.
