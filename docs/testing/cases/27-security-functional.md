# Security-Functional Behaviors

**ID prefix:** SEC | **Scope:** User-observable security behaviour that spans features — not a penetration test, but the black-box functional contract of the app's security controls: account lockout after repeated failures + recovery, the 429 rate-limit UX on the auth endpoints, Have-I-Been-Pwned breached-password rejection and the server password policy at register + change-password, the in-memory-only access token, the HttpOnly `zbb_rt` refresh cookie's flags + rotation + reuse detection + the 30-second replay grace, mid-session expiry that re-authenticates cleanly without losing the destination, sign-out-everywhere on password change, cross-tab logout, owner-scoping / cross-household IDOR probes (a direct API call for another household's id returns 404/403 and the UI never leaks it), invite-link single-use enforcement, the enforced security headers + CSP (which must not break Google Fonts or GA), consent-gated analytics (zero GA before consent, hashed ids after), no sensitive data in URLs / open-redirect protection, and the `autocomplete`/`type=password` attributes on credential fields. Where a security control is really a role or concurrency behaviour this file states the *security-observable* assertion and cross-references the owning file rather than re-testing it. | **Out of scope:** the full role→action matrix and per-endpoint 403/404 sweep live in `25-roles-permissions.md`; refresh-rotation / grace / cross-tab races in the multi-tab context live in `22-concurrency-multiuser.md`; invite creation/accept functional depth lives in `17-invites.md` and household isolation-on-switch in `16-people-households.md`; session-expiry-in-a-form UX detail lives in `26-ux-states.md`; per-area validation copy lives in each area file (`08`–`18`); the auth screens' field-level behaviour lives in `02-registration-login.md` and `03-session-auth-lifecycle.md`.

**Test data setup:** A registered login **U1** (`u1@allotjar.eu`, password `Sunflower8x`, which meets the server policy — ≥8 chars + digit + upper + lower and is not HIBP-breached) owning household **H1** with a July 2026 month, an EUR account **"Joint"** and one jar **"Car"**. A second, unrelated login **U2** (`u2@allotjar.eu`) owning household **H2** with its own account, month and jar — used only for cross-household probes; U1 and U2 share no membership. All feature flags default **ON** (`accounts, multiCurrency, camtImport, reports, jars, householdAllocation, householdAccess`, plus `analytics`). Server money is `decimal(18,4)`; the wire role enum is numeric (0 Owner / 1 Admin / 2 Limited / 3 Read-only). Auth endpoints live under `/api/auth/*`; the SPA credential screens are `/login` (Sign in + Create account tabs), `/accept-invite?code=…`, and `/account` (Change password card). Prod is served over HTTPS by Cloudflare in front of IIS/ARR → Kestrel, so the API's `RemoteIpAddress` is the proxy (the real client is in `CF-Connecting-IP`, not yet read by the limiter). Build-time `VITE_GA_MEASUREMENT_ID = G-55WS48MJ91` is present in beta/prod and absent in dev/test/CI. The prod auth rate-limit is 20 requests/minute per source; the journey e2e harness raises it to 1000 via `RateLimiting__AuthPermitLimit`.

---

## Account lockout & login hardening

### SEC-001 - Five consecutive wrong passwords lock the account with a distinct message
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Login U1 exists and is not currently locked; lockout config = 5 attempts → 15-minute window (`DependencyInjection.cs`: `MaxFailedAccessAttempts = 5`, `DefaultLockoutTimeSpan = 15 min`).
- **Steps:**
  1. On `/login` (Sign in tab) enter `u1@allotjar.eu` with a wrong password and submit. Repeat until five failures are recorded (attempts 1–5 each show "Invalid email or password.").
  2. On the submit that crosses the threshold supply the wrong password again, then also try the CORRECT password `Sunflower8x`.
- **Expected:** After the 5th failure the account is locked. Both a further wrong password AND the correct password now return `401` with the lockout copy: "Your account is temporarily locked after too many failed sign-in attempts. Please try again in a few minutes." A valid password does NOT bypass the lock (`IsLockedOutAsync` is checked before the password verify). No token is ever issued while locked.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/LoginTests.cs` → `Locked_out_returns_locked_and_never_issues_a_token`; the UI threshold flow is not automated)

### SEC-002 - A success before the threshold resets the failed-attempt counter
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Login U1, not locked, zero recent failures.
- **Steps:**
  1. Submit 4 wrong passwords (one short of the limit).
  2. Submit the correct password `Sunflower8x` and sign in.
  3. Sign out, then submit 4 more wrong passwords.
- **Expected:** Step 2 succeeds (still under 5) and calls `ResetAccessFailedCountAsync`, so the counter returns to zero. Step 3's 4 failures do NOT lock the account — the pre-success failures don't carry over; a 5th *new* failure would be needed. No premature lockout.
- **Automated:** No

### SEC-003 - No account enumeration: unknown email and wrong password are indistinguishable
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** U1 exists; `nobody@allotjar.eu` does not.
- **Steps:**
  1. POST `/api/auth/login` with the nonexistent email `nobody@allotjar.eu` + any password.
  2. POST `/api/auth/login` with U1's email + a wrong password.
  3. Compare the response bodies, status codes and rough timings.
- **Expected:** Both return `401` with the identical body `{ "error": "Invalid email or password." }` — the unknown-email path never says "no such account". The unknown-email path still runs a throwaway PBKDF2 verify (`IdentityService.DummyPasswordHash`) so response timing doesn't reveal whether the email exists. No `WWW-Authenticate` or header difference leaks the distinction. (Registration DOES reveal existence via "An account with that email already exists." — an accepted trade-off, tested at register in `02-registration-login.md`.)
- **Automated:** Partial (`LoginTests.cs` → `Invalid_credentials_returns_invalid_and_never_issues_a_token`; the timing-equalization dummy-hash is not asserted at this layer)

### SEC-004 - Lockout self-heals for pre-lockout-era logins on first sign-in
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A legacy login whose `LockoutEnabled` is false (created before lockout shipped).
- **Steps:**
  1. Attempt to sign in as the legacy login once, triggering `CheckCredentialsAsync`.
  2. Then drive 5 consecutive wrong passwords.
- **Expected:** The first credential check opts the login in (`GetLockoutEnabledAsync` false → `SetLockoutEnabledAsync(true)`), so the subsequent failures accumulate and the account locks at 5 exactly like a modern login — no login is permanently un-lockable, and no migration is required.
- **Automated:** No

## Rate limiting on the auth endpoints

### SEC-005 - Bursting the login endpoint returns 429 after the per-minute cap
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Prod-equivalent limit of 20/min per source (`RateLimiting:AuthPermitLimit` default 20, fixed 1-minute window, `QueueLimit = 0`, `RejectionStatusCode = 429`; `Program.cs`).
- **Steps:**
  1. From one source, POST `/api/auth/login` more than 20 times inside a single minute (mixing valid/invalid is fine).
  2. Observe the 21st+ responses, then wait for the window to roll over and retry.
- **Expected:** Requests past the cap short-circuit with HTTP `429 Too Many Requests` BEFORE authentication runs, so they neither count toward per-account lockout nor reveal credential validity. After the fixed window elapses, requests are served again. The SPA surfaces the failure through its generic error copy ("Something went wrong."), never a crash.
- **Automated:** No (the journey harness deliberately sets the cap to 1000 via `RateLimiting__AuthPermitLimit` so serial runs never trip it — `playwright.journey.config.ts`)

### SEC-006 - Only the sensitive auth endpoints are rate-limited (the "auth" policy)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** The `[EnableRateLimiting("auth")]` policy is applied per endpoint.
- **Steps:**
  1. Enumerate which endpoints carry the limiter: `/auth/register`, `/auth/login`, `/auth/accept-invite`, `/auth/refresh`, `/auth/logout`, `/auth/change-password`.
  2. Confirm data endpoints (`/auth/me`, `/auth/preferences`, `/auth/consent`, `/api/budget/*`, `/api/transactions`, …) are NOT under this policy.
- **Expected:** A burst on any of the six auth endpoints can 429; a burst on `/auth/me` or ordinary data endpoints does not hit the auth limiter (they are gated by JWT auth instead). `/auth/refresh` being limited is intentional — a stolen-cookie replay flood is throttled — but 20/min is high enough that the cold-load multi-tab refresh race (SEC-016, CONC-018) never trips it.
- **Automated:** No

### SEC-007 - Behind Cloudflare the IP bucket is shared; per-account lockout is the real defence
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Prod topology — Cloudflare → IIS/ARR → Kestrel; the API reads `RemoteIpAddress` = the proxy, not the client.
- **Steps:**
  1. Note that in prod the rate-limit partition key collapses toward one shared bucket (the real client IP is in `CF-Connecting-IP`, not yet read by the limiter).
  2. Verify a single attacker cannot lock out OTHER users, only the specific account they target, and that legitimate concurrent households are not throttled by ordinary use.
- **Expected:** The coarse IP limiter is a best-effort flood cap only; the precise, IP-independent brute-force defence is the per-account 5-attempt lockout (SEC-001), unaffected by the shared bucket. Legitimate household traffic (well under 20 auth calls/min) is never throttled. Documented known limitation, not a defect.
- **Automated:** No

## Breached & weak-password rejection

### SEC-008 - A breached password is rejected at registration with clear copy
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Create-account tab on `/login`; `BreachedPasswordValidator` screens against the HIBP Pwned-Passwords range API (k-anonymity: 5-char SHA-1 prefix + `Add-Padding`).
- **Steps:**
  1. Open the Create account tab; fill First/Last name, email, currency, tick Terms (and, on beta, the data-loss acknowledgement).
  2. Enter a well-known breached password (e.g. `Password1`, which satisfies length + composition) and submit.
- **Expected:** Registration fails `400` with the Identity validator message "This password has appeared in a known data breach. Please choose a different one." (surfaced from `result.errors`). No account, household, owner-member or refresh cookie is created. Choosing a non-breached policy-compliant password then succeeds.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/BreachedPasswordValidatorTests.cs` → `Rejects_a_breached_password` unit-tests the validator + `PwnedPassword` code; the register-form round-trip is not automated — journeys use random non-breached passwords precisely to avoid this gate)

### SEC-009 - A breached password is rejected at change-password too
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Signed in as U1 on `/account`; current password known.
- **Steps:**
  1. In the Change password card enter the correct Current password, then a breached New password (e.g. `Qwerty123`) in New + Confirm.
  2. Submit "Change password".
- **Expected:** Server returns `400` and the card's error banner shows the breach rejection (from `result.errors`). The existing password stays in force, other devices are NOT signed out (no successful change → no security-stamp rotation / revoke-all), and the current session continues unbroken.
- **Automated:** No (the client-only mismatch guard is covered by `AccountPage.test.tsx`; the server breach path at change-password is not e2e-automated)

### SEC-010 - Server composition policy rejects an 8-char password the client accepts
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Register or change-password screen. The client only enforces `minLength={8}`; the server policy = length 8 + `RequireDigit` + `RequireUppercase` + `RequireLowercase` (Identity defaults kept; only `RequireNonAlphanumeric` disabled).
- **Steps:**
  1. Enter an 8-character all-lowercase-letters password like `sunflower` (passes the browser `minLength`, so the form submits).
  2. Submit register (or change-password).
- **Expected:** The client length gate passes and the request is sent, but the SERVER rejects it `400` with the Identity composition errors (e.g. "Passwords must have at least one digit ('0'-'9')." and "…at least one uppercase ('A'-'Z')."). The failure is surfaced in the form, not swallowed — `minLength` is a convenience, never the security boundary.
- **Automated:** No

### SEC-011 - HIBP never runs on login, sends only the 5-char prefix, and fails open on outage
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `BreachedPasswordValidator` uses a named `"hibp"` HttpClient (5-second timeout) to `api.pwnedpasswords.com`.
- **Steps:**
  1. Sign IN as U1 with the correct (possibly-since-breached) password while HIBP is reachable.
  2. Simulate the HIBP API being down/slow, then REGISTER a fresh, non-breached password.
- **Expected:** Login never calls HIBP (breach screening runs only on set/change, not verify), so a user whose password later appeared in a breach can still sign in. Only the 5-char SHA-1 prefix ever leaves the server (`…/range/5BAA6` for "password"), never the full hash or the password. When HIBP is unreachable the validator fails OPEN — registration/change still succeeds on an otherwise-valid password rather than blocking sign-ups on a third-party outage.
- **Automated:** Partial (`BreachedPasswordValidatorTests.cs` → `Fails_open_when_the_api_is_unreachable`, `Fails_open_on_a_non_success_status`; `Rejects_a_breached_password` asserts the request path ends with `range/5BAA6` — only the prefix is sent)

## Session tokens, rotation & revocation

### SEC-012 - The access token lives in memory only — never in web storage
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Signed in as U1 in a browser tab.
- **Steps:**
  1. After sign-in, inspect `localStorage` and `sessionStorage`.
  2. Look for any JWT / bearer token key (historically `zbb.token`).
- **Expected:** No durable access token exists in web storage — the JWT is held in a module variable in `lib/api.ts` (`accessToken`). Only non-secret UI hints persist (`zbb.email`, `zbb.role`, `zbb.displayName`, `zbb.currency`, `zbb.numberFormat`, `zbb.analyticsConsent`). A successful XSS therefore cannot exfiltrate a long-lived credential from storage; the durable session sits only in the JS-unreadable HttpOnly refresh cookie. A full page reload drops the in-memory token and the session is rebuilt from the cookie (SEC-013 / SEC-019).
- **Automated:** Partial (`client/e2e-journey/register.spec.ts` → "the session survives a full page reload via the refresh cookie" exercises the in-memory + cookie split)

### SEC-013 - The refresh cookie carries the correct security flags
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Fresh sign-in / register / accept-invite over HTTPS (prod) issues `zbb_rt`.
- **Steps:**
  1. Sign in and inspect the `Set-Cookie: zbb_rt=…` response header.
  2. Check `HttpOnly`, `Secure`, `SameSite`, `Path`, `Max-Age/Expires`.
- **Expected:** `zbb_rt` is `HttpOnly` (JS cannot read it), `Secure` in prod (`Secure = !IsDevelopment()`; plain in local dev only, which is why the journey harness runs `ASPNETCORE_ENVIRONMENT=Development` over http), `SameSite=Strict`, scoped `Path=/api/auth` (sent only to the auth endpoints, not every request), `IsEssential`, and expires in 30 days (`RefreshTokenService.LifetimeDays`). The stored value is opaque; the DB holds only its hex SHA-256, never the raw token.
- **Automated:** Partial (`client/e2e-journey/concurrent-refresh.spec.ts` reads the `zbb_rt` Set-Cookie value; the individual flag assertions are not automated)

### SEC-014 - A session that died mid-use bounces to /login with a reason and returns you there
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #169 (genuinely-dead sessions prompt a fresh sign-in; the interceptor's credential-endpoint exemption is a LIST, not the whole `/auth/` prefix)
- **Preconditions:** Signed in as U1 with a tab open on the dashboard; the session is revoked server-side (logout elsewhere or refresh-token expiry).
- **Steps:**
  1. With the tab still looking signed-in (in-memory token intact), have the session killed server-side.
  2. Click a data-bearing nav link, e.g. "Transactions".
- **Expected:** The 401 triggers one `/auth/refresh`; it fails (cookie revoked), so `sessionExpired()` tears down auth state and navigates to `/login?reason=expired&returnUrl=%2Ftransactions`. The login page shows the amber "Your session has expired, so we signed you out to keep your budget safe. Sign back in to pick up where you left off." status (not a misleading page-level error). Signing back in lands on `/transactions`, the intended destination. A 401 from `/auth/me`, `/auth/preferences` or `/auth/change-password` also refresh-and-retries (they are NOT credential-exempt); only `/auth/login|register|refresh|accept-invite|logout` skip the refresh.
- **Automated:** Yes (`client/e2e-journey/session-expiry.spec.ts` → "a tab whose session was revoked is prompted to sign in and returns to where it was"; interceptor exemption list in `client/src/lib/api.test.ts`)

### SEC-015 - Refresh rotation with reuse detection burns the family outside the grace window
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** U1 signed in; one valid `zbb_rt` cookie value captured.
- **Steps:**
  1. POST `/api/auth/refresh` with the cookie → it rotates to a new value (old token revoked with `ReplacedByTokenHash` set).
  2. Wait past the 30-second grace window, then replay the ORIGINAL (now-rotated) cookie value.
- **Expected:** Rotation issues a fresh token and revokes the old (`RotateAsync`). Replaying the superseded token more than 30s later is treated as theft: `RevokeAllForUserAsync` burns every active refresh token for the user, the replay returns `401` and the cookie is cleared. Both the attacker and the legitimate holder are forced to re-authenticate — a stolen cookie cannot ride alongside the victim. Boundary partner: replay *inside* the grace is refused WITHOUT a burn (SEC-016). An administratively-revoked token (logout / password change) with no replacement is refused WITHOUT the theft response and DOES clear its own cookie (a stale signed-out device must not nuke fresh sessions).
- **Automated:** Yes (`RefreshTokenServiceTests.cs` → `Replaying_a_token_rotated_outside_the_grace_window_burns_the_whole_chain`, `Replaying_an_administratively_revoked_token_is_refused_without_the_theft_response`, `RevokeAllForUser_ends_the_session_on_every_device_but_leaves_other_users_alone`)

### SEC-016 - Sibling-tab replay inside the 30s grace is refused without clearing the shared cookie
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #171 (30s server-side grace so a second restored tab replaying a just-rotated cookie doesn't burn the family; the grace 401 must NOT clear the shared cookie)
- **Preconditions:** A single browser cookie jar; two tabs cold-loading at once fire `/auth/refresh` with the SAME `zbb_rt`.
- **Steps:**
  1. Register / sign in to capture the original cookie value.
  2. POST `/auth/refresh` with it (winner) → rotates, sets a fresh cookie.
  3. Within 30s POST `/auth/refresh` again with the SAME original value (loser).
  4. POST `/auth/refresh` with the winner's rotated value.
- **Expected:** The winner returns `200` with a new `zbb_rt`. The loser returns `401` with `RefreshRotationResult.Superseded` and, critically, sends NO `Set-Cookie` deletion — clearing here would evict the winner's fresh cookie from the shared jar and sign the winning tab out ~15 min later. No family burn: the winner's rotated cookie still refreshes to `200`. Repeated replays inside the window stay refused-without-burn.
- **Automated:** Yes (`client/e2e-journey/concurrent-refresh.spec.ts` → "two tabs racing refresh with one cookie: loser refused, winner survives, no burn"; `RefreshTokenServiceTests.cs` → `Replaying_a_just_rotated_token_is_refused_without_burning_the_chain`, `Repeated_replays_within_the_grace_window_stay_refused_without_burning`. See CONC-018.)

### SEC-017 - Changing your password signs out every other device but keeps this one
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #93 (SecurityStamp-based JWT revocation) — the security-observable of `22-concurrency-multiuser.md` CONC-022
- **Preconditions:** U1 signed in on device A (browser tab) and device B (separate cookie jar / API session).
- **Steps:**
  1. On device B, change U1's password via the `/account` Change password card (or `POST /auth/change-password`).
  2. On device A, click a data-bearing nav link.
  3. On device B, POST `/auth/refresh`.
- **Expected:** The change revokes ALL of U1's refresh tokens (`RevokeAllForUserAsync`) and rotates the security stamp (inside `ChangePasswordAsync`), so device A's in-memory JWT fails the per-request `sstamp` check immediately (not after its 15-min lifetime) and A is bounced to `/login?reason=expired`. Device B carries on: the change response returns a fresh token + rotated cookie (200, which the client must `apply()`), and B's later refresh returns `200` — B's own stale-cookie recheck must NOT trip the theft response against itself. Device A signs back in with the NEW password only.
- **Automated:** Yes (`client/e2e-journey/session-expiry.spec.ts` → "changing the password signs out other devices but keeps the changing device signed in"; `SecurityStampValidationTests.cs` → `Rotated_stamp_revokes_the_token`; `RefreshTokenServiceTests.cs` → `Replaying_an_administratively_revoked_token_is_refused_without_the_theft_response`)

### SEC-018 - Logout in one tab clears the other tab's in-memory session
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 (cross-tab logout broadcast via `client/src/lib/authChannel.ts`)
- **Preconditions:** U1 signed in in two tabs of the same browser; `BroadcastChannel` available.
- **Steps:**
  1. In tab A, open the account menu and click "Sign out" (or have the session die → `sessionExpired`).
  2. Observe tab B without manually reloading it, then interact with it.
- **Expected:** Tab A posts `signed-out` on the `zbb.auth` channel; tab B's handler clears its auth state only if it currently holds a token, so B stops rendering as signed in and `RequireAuth` bounces it to `/login` on its next interaction — it does NOT keep a working in-memory access token for up to 15 more minutes. The receive handler never re-broadcasts (no loops). Environments without `BroadcastChannel` degrade to per-tab behaviour (no crash).
- **Automated:** Partial (`client/src/auth/AuthContext.test.tsx` → "another tab's sign-out broadcast signs this tab out"; the true two-tab broadcast is not e2e-automated — see CONC-021 / UX-047)

### SEC-019 - An idle tab whose token lapsed revalidates on focus, not on a failed save
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** U1 signed in; the tab left idle (backgrounded / laptop lid) long enough for the 15-min access token to expire while the 30-day refresh cookie is still valid.
- **Steps:**
  1. Leave the tab idle past the access-token lifetime.
  2. Return focus to the tab (window focus or `visibilitychange` to visible).
- **Expected:** On focus/visible, if `isAccessTokenExpired()` is true the app silently `refreshSession()`s against the cookie: success re-arms the session with a fresh token (the user never sees a prompt); failure calls `sessionExpired()` → `/login?reason=expired`. The user finds out the moment they return, not when a stale page's save 401s. Hidden tabs skip revalidation until shown.
- **Automated:** Partial (`client/src/auth/AuthContext.test.tsx` → focus revalidation re-arms a live session / prompts on a dead one; `client/src/lib/api.test.ts` → `isAccessTokenExpired` tracking. See CONC-024.)

### SEC-020 - The access JWT is HS256-pinned and revocable by security stamp
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Any authenticated request carries a bearer JWT.
- **Steps:**
  1. Present a token signed with a different algorithm or `alg:none`, or with a tampered header alg.
  2. Present a valid-signature token whose `sstamp` claim no longer matches the user's current stamp (e.g. after a password change).
- **Expected:** Only `HS256` is accepted (`ValidAlgorithms` pinned) — an algorithm-substitution / `alg:none` token is rejected `401`. Issuer (`ZeroBudget`), audience (`ZeroBudgetClient`), lifetime and signing key are all validated (30s clock skew). On each request `OnTokenValidated` re-checks the token's `sstamp` against `Users.SecurityStamp`: a definite mismatch fails the token (`401` "This session has been revoked."); a legacy token with no stamp claim is allowed (rollout grace); a transient DB error fails OPEN (a blip must not log everyone out). The JWT signing key must be ≥32 bytes or the app refuses to start.
- **Automated:** Partial (`SecurityStampValidationTests.cs` → `Legacy_token_without_a_stamp_is_allowed`, `Matching_stamp_is_allowed`, `Rotated_stamp_revokes_the_token`, `A_stamped_token_against_a_missing_current_stamp_is_rejected`; the algorithm pinning + JWT-bearer wiring are not directly asserted at this layer)

## Owner-scoping & cross-household isolation (IDOR)

### SEC-021 - Fetching another household's resource by id returns 404, never its data
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** U1 signed in; a real id `X` belonging to U2's household H2 (an account id, budget month, jar or transaction).
- **Steps:**
  1. As U1, call the read endpoint for H2's resource directly, e.g. `GET /api/accounts/{H2-account-id}`, `GET /api/budget/2026/7` for a month only H2 owns, or a foreign jar/transaction id.
- **Expected:** Read handlers scope every query with `.Where(x => x.OwnerId == currentUser.OwnerId)`, so a foreign id simply doesn't match — the caller gets `404 Not Found` (e.g. `GetBudgetMonthQueryHandler` throws `NotFoundException`) or an own-only/empty list, never H2's rows. Ownership lives in the query predicate itself, so U1 can never project U2's budget "regardless of the month asked for". No amount, name or member of H2 is disclosed.
- **Automated:** Partial (handler unit tests assert OwnerId scoping across Accounts/Budget/Jars/Transactions; there is no dedicated cross-household HTTP probe suite)

### SEC-022 - Mutating another household's resource by id returns 403 for a real foreign id
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** U1 signed in; a real account id `X` owned by U2's H2.
- **Steps:**
  1. As U1, `PUT /api/accounts/{X}` (rename) or `DELETE /api/accounts/{X}`.
  2. Also try a truly-nonexistent id `00000000-0000-0000-0000-000000000000`.
- **Expected:** The command loads the row, finds `account.OwnerId != currentUser.OwnerId` and throws `ForbiddenAccessException` → `403` (`UpdateAccountCommandHandler` / `DeleteAccountCommandHandler`); a truly-missing id throws `NotFoundException` → `404`. Either way U1 cannot read, rename or delete H2's account, and the resource is unchanged. (The 403-vs-404 split is by design: on the write path an id that exists-but-isn't-yours is 403; on the read path it is absent → 404.)
- **Automated:** Partial (handler-level OwnerId checks are unit-tested per writer)

### SEC-023 - Role and household are re-resolved server-side each request; a forged client role can't escalate
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** U1 is a Read-only (or Limited) member somewhere; the client caches the numeric role in `zbb.role`.
- **Steps:**
  1. Tamper with the client `zbb.role` in localStorage (e.g. set it to `0`/Owner) to unlock UI affordances.
  2. Attempt a privileged write from the now-unlocked UI (or replay it directly against the API).
- **Expected:** The server ignores the client's claimed role entirely — `HouseholdResolutionMiddleware` re-resolves the caller's active household + role from `HouseholdMemberships` every request and `AuthorizationBehaviour` enforces it. A forged client role only reveals UI controls locally; the actual command is rejected `403` by the server. Role is never baked into the JWT, so a revoke/downgrade takes effect on the very next request. (Full matrix: `25-roles-permissions.md` ROLE-005/033/036.)
- **Automated:** Partial (`AuthorizationBehaviourTests.cs` covers the server-side pipeline enforcement per role; client tampering is not automated)

### SEC-024 - Switching household re-scopes every screen; no foreign data lingers in the UI
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A login that belongs to both H1 and H2 (multi-household), currently viewing H1.
- **Steps:**
  1. Switch active household via the account-menu switcher; the app re-bootstraps (`window.location.assign('/')`).
  2. Inspect dashboard, accounts, transactions, jars, reports.
- **Expected:** All data re-scopes to the newly active household — the server resolves `ActiveOwnerId` and every query filters on it, so no H1 amount/account/member is visible while viewing H2 (and vice-versa). This is the isolation contract; the switch mechanics and the stale-second-tab window live in `16-people-households.md` (PPL-057/058/060) and `22-concurrency-multiuser.md` (CONC-030). No cross-household leakage survives the re-bootstrap.
- **Automated:** No

## Invite-link security

### SEC-025 - Invite links are single-use, hashed at rest, high-entropy and time-boxed
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** U1 (Owner) creates an invite link for a person in H1.
- **Steps:**
  1. Create the link; note the raw `?code=` token is shown once.
  2. Redeem it once (accept), then try to redeem the SAME link again.
  3. Try a tampered/unknown token, and a link older than its expiry.
- **Expected:** The token is 256-bit CSPRNG (`RandomNumberGenerator.GetBytes(32)`), URL-safe, and stored ONLY as its SHA-256 hash (`InviteTokenHash`) — the DB never holds the raw value. On accept the hash + expiry are cleared (`InviteTokenHash = null`), so a second redemption finds no match and is refused `404` "This invite link is invalid or has already been used."; a tampered/unknown token never matches (same 404); a token past its expiry is refused `403` "This invite link has expired." One redemption per link, period. (Accept UX + copy: `17-invites.md` INV-010/011/045/046/047.)
- **Automated:** Partial (`client/e2e-journey/invite.spec.ts` covers the happy accept + land-in-household; reuse/expiry/unknown rejection at the handler unit level in `HouseholdAccessTests.cs`)

### SEC-026 - Accept-invite is anonymous but rate-limited, and only an Owner can mint links
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** `/auth/accept-invite` is `[AllowAnonymous]`; link creation (`POST /access/invite`) is Owner-only.
- **Steps:**
  1. As a non-owner (Admin) attempt to create an invite from the People page / API.
  2. Flood `/auth/accept-invite` with token guesses.
- **Expected:** Link creation is Owner-only — an Admin gets `403` and the UI never shows the invite controls (see `25-roles-permissions.md` ROLE-023/024, `17-invites.md` INV-007). Anonymous accept is throttled by the "auth" rate limiter (429 on a flood — INV-027), and each guess must match a stored SHA-256 hash of a 256-bit token, making brute-force infeasible even without the throttle.
- **Automated:** No

## Security headers & Content-Security-Policy

### SEC-027 - CSP is enforced and its allow-list keeps GA + Google Fonts working
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #80 (CSP flipped Report-Only → enforced) + the Google-Fonts gotcha (CSP must allowlist `fonts.googleapis.com` + `fonts.gstatic.com` or Inter breaks) — see also `security-review.md`
- **Preconditions:** App served by IIS with `deploy/web/web.config` custom headers.
- **Steps:**
  1. Load any SPA route and read the `Content-Security-Policy` response header (the header name is `Content-Security-Policy`, not `-Report-Only`).
  2. Confirm the Inter font renders and (after consent) GA loads, with no CSP violations in the console.
- **Expected:** Header is enforced and reads exactly: `default-src 'self'; script-src 'self' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://*.google-analytics.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`. Inter loads (fonts allowlisted), gtag.js + beacons work post-consent, and no legitimate app resource is blocked. `'unsafe-inline'` applies to styles only (React inline style attributes), never to scripts.
- **Automated:** No

### SEC-028 - Clickjacking is blocked: X-Frame-Options DENY + frame-ancestors 'none'
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Enforced headers present.
- **Steps:**
  1. Attempt to embed any app page in an `<iframe>` on a third-party origin.
- **Expected:** The response carries `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`, so the browser refuses to render the app inside a frame — a clickjacking overlay cannot wrap the budgeting UI. `base-uri 'self'` and `form-action 'self'` further prevent base-tag hijacking and off-site form posts.
- **Automated:** No

### SEC-029 - The hardening header set is present on every response
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** IIS front site serving the SPA.
- **Steps:**
  1. Read response headers on an SPA route and on an `/api/*` proxied response.
- **Expected:** `X-Content-Type-Options: nosniff` (no MIME sniffing), `Referrer-Policy: strict-origin-when-cross-origin` (no full-URL referrer leakage across origins), and `Permissions-Policy` switching off accelerometer/camera/geolocation/gyroscope/magnetometer/microphone/payment/usb (features the app never uses). Combined with CSP `object-src 'none'`. HSTS is applied at the Cloudflare edge (not in web.config), so it need not appear on the origin response.
- **Automated:** No

### SEC-030 - No inline scripts: the theme bootstrap is an external file so script-src stays 'self'
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #79 (theme bootstrap externalized to `/theme-init.js` so `script-src 'self'` covers pre-paint theming with no `'unsafe-inline'` on scripts)
- **Preconditions:** CSP `script-src 'self' https://www.googletagmanager.com` (no `'unsafe-inline'`, no nonce).
- **Steps:**
  1. View source and confirm the pre-paint theme init is loaded as `/theme-init.js`, not an inline `<script>`.
  2. Confirm no CSP script violations on cold load (including no flash of unthemed content).
- **Expected:** The only script origins are same-origin bundles and `googletagmanager.com`; there is NO inline `<script>` that would require `'unsafe-inline'` on scripts. Theme is applied before paint via the external file, so a strict script policy holds without weakening it. Adding an inline script later would be blocked (this case is the regression guard).
- **Automated:** No

## Consent-gated analytics & PII safety

### SEC-031 - Zero GA script, cookies or hits before consent is granted
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Analytics flag ON, measurement id built in, no stored consent (`zbb.analyticsConsent` unset) → the consent banner shows.
- **Steps:**
  1. Load the app signed-in as U1 with no prior consent choice; the "Analytics consent" banner appears at the bottom (Decline / Accept).
  2. Before touching the banner, inspect the network (no `googletagmanager.com/gtag/js` request), `document.cookie` (no `_ga*`), and `window.gtag` / `dataLayer`.
- **Expected:** Tracking starts only when ALL of {flag on, measurement id present, consent granted} hold. Before consent: gtag.js is never injected (`injectScript` runs only via `start()`), no GA cookie is set, no page_view/event fires. `track()` / `pageView()` / `setUser()` are all no-ops while `isStarted()` is false. Navigating around pre-consent sends nothing to GA.
- **Automated:** Partial (`client/src/analytics/analytics.test.ts` → nothing loads or fires before `start()`, even when configured)

### SEC-032 - Accepting initialises Consent Mode v2 and starts a privacy-safe stream
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Banner visible; measurement id present.
- **Steps:**
  1. Click "Accept" on the consent banner.
  2. Inspect the `dataLayer` / gtag calls and the first page view.
- **Expected:** `zbb.analyticsConsent = 'granted'` is persisted; `start()` loads gtag.js exactly once (idempotent), sets Consent Mode v2 defaults denied-by-default (`ad_storage` / `ad_user_data` / `ad_personalization` / `analytics_storage` all `denied`), configures the stream with `send_page_view:false`, `anonymize_ip:true`, `allow_google_signals:false`, `allow_ad_personalization_signals:false`, THEN flips `analytics_storage:'granted'`. Only after that is a redacted `page_view` sent (SEC-039). Ad/remarketing storage stays denied throughout.
- **Automated:** Partial (`analytics.test.ts` → loads GA and forwards only whitelisted events after `start()`; `start()` is idempotent — one script tag)

### SEC-033 - Declining keeps analytics fully inert and remembers the choice
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Banner visible.
- **Steps:**
  1. Click "Decline".
  2. Navigate around, then reload the app.
- **Expected:** `zbb.analyticsConsent = 'denied'` persists; the banner disappears and does not reappear on reload; GA is never loaded and no event / page_view / user-id is ever sent. Declining is a hard opt-out, not a "not yet".
- **Automated:** Partial (`analytics.test.ts` → consent storage persists/reads the choice)

### SEC-034 - After consent the GA User-ID is a one-way hash; the raw email never leaves the browser
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Consent granted; U1 signed in.
- **Steps:**
  1. With tracking live, inspect the value passed to `gtag('set', { user_id })`.
  2. Confirm no GA call carries `u1@allotjar.eu` or any raw email.
- **Expected:** The User-ID is `hashUserId(email)` — a peppered SHA-256 (`${PEPPER}:${normalized-email}`, sliced to 32-char hex) computed client-side; the raw, normalised (trim+lowercase) email is only an input to the hash and is never transmitted. The `user_role` user-property is a non-PII label ("Owner"/"Admin"/…), never the email or name. The hash is deterministic (same email → same id) and non-reversible, so sessions stitch without exposing identity. (In a non-secure context where `crypto.subtle` is unavailable, a deterministic FNV-1a fallback is used — still never the raw email.)
- **Automated:** Partial (`analytics.test.ts` → `hashUserId` is deterministic, case/space-insensitive, reveals no raw email, null for empty)

### SEC-035 - The redaction net drops ids, amounts and free text from every GA payload
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Consent granted.
- **Steps:**
  1. Trigger events that carry contextual data (e.g. an `api_error` after a failed `/api/budget/2026/7` call, a nav click, a transaction add).
  2. Inspect the parameters actually sent to GA.
- **Expected:** Only whitelisted, primitive-valued keys survive `safeParams` — exactly `method, line_type, direction, report_type, destination, theme, row_bucket, count_bucket, status, kind, split, step, source, context, api_endpoint, api_status, error_kind, consent, sample_data`. Any non-whitelisted key, object, raw amount, name or free-text value is dropped. `api_error` reports only the redacted endpoint TEMPLATE (`/budget/:id/:id`) + numeric status — never ids, query strings or bodies. Counts are coarse buckets (`bucketCount`: `0` / `1` / `2-10` / `11-50` / `51-200` / `200+`), so exact figures never leave the browser.
- **Automated:** Partial (`analytics.test.ts` → `safeParams` keeps only whitelisted primitive-valued keys; `apiEndpointTemplate` collapses resource ids to a shape; `bucketCount` coarse ranges)

### SEC-036 - Without a build-time measurement id, analytics is completely inert (dev/test/CI)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `VITE_GA_MEASUREMENT_ID` absent (dev/test/CI builds).
- **Steps:**
  1. Run the app in a build with no measurement id; grant consent on the banner.
  2. Inspect the network and cookies for any GA script/hit.
- **Expected:** `isConfigured()` is false, so the whole module is inert: `start()` no-ops, the script is never injected, no hit is sent — even after Accept. The consent banner may still be shown (it is gated on the flag alone so the UI works before an id is deployed), but granting simply starts nothing. Dev/test/CI never load GA or set a cookie.
- **Automated:** Partial (`analytics.test.ts` → the gtag bridge is inert without a measurement id)

### SEC-037 - Consent can be reset from Help, and logout clears the GA identity
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Consent previously granted; U1 signed in.
- **Steps:**
  1. Use the Help "Privacy & analytics" opt-out/in control to reset the consent choice.
  2. Separately, sign out while tracking is live.
- **Expected:** Reset clears `zbb.analyticsConsent` (choice back to null), so the consent banner reappears and the user can re-decide — a genuine, revocable opt-out. On logout `clearUser()` sets GA's `user_id` and `user_role` to null so a subsequent user on the same browser is not stitched to the previous identity.
- **Automated:** No

## URLs, redirects & credential-field autofill

### SEC-038 - The post-login returnUrl can only ever be an internal path (open-redirect blocked)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** `/login` reached with a `?returnUrl=` (from an expired-session bounce or an invite sign-in round-trip).
- **Steps:**
  1. Visit `/login?returnUrl=https://evil.example` and sign in.
  2. Repeat with `//evil.example`, `/\evil.example`, and a value containing a control character (e.g. a tab) that URL parsers strip.
- **Expected:** `safeInternalPath` accepts only a single-slash-rooted path (`/transactions`, `/accept-invite?code=…`); it rejects absolute URLs, scheme-relative `//…`, backslash `/\…`, and any value with a control char (0x00–0x1F / 0x7F) that could resolve to scheme-relative downstream. A rejected returnUrl falls back to the app root — a fresh session can never be bounced to an attacker's site. The invite `returnUrl` round-trip (`/login?returnUrl=/accept-invite?code=…`) is preserved because it is a rooted internal path.
- **Automated:** Yes (`client/src/lib/returnUrl.test.ts` → accepts a rooted internal path with query, rejects absolute/scheme-relative/non-rooted, rejects control chars; `LoginPage.test.tsx` returns to the safe internal returnUrl after sign-in)

### SEC-039 - SPA page views strip tokens and ids from the path before they reach GA
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Consent granted; navigation to id-bearing and token-bearing routes.
- **Steps:**
  1. Visit `/accounts/{guid}` and `/accept-invite?code={rawToken}` with tracking live.
  2. Inspect the `page_path` / `page_location` sent to GA.
- **Expected:** `redactPath` drops the query/hash and collapses id-like segments to `:id` (`/accounts/:id`), and the synthetic `page_location` is built from `origin + redacted path`, so the real URL — including any `?code=` / `?token=` / `?returnUrl=` or record id — never reaches GA. The invite raw token appears only in the address bar (over HTTPS) and in the single-use link; it is never logged to analytics.
- **Automated:** Partial (`analytics.test.ts` → `redactPath` strips query strings and hashes with no token leakage, and replaces id-like segments with `:id`)

### SEC-040 - Credential fields use type=password and correct autocomplete tokens
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** `/login` (both tabs), `/account` Change password card, `/accept-invite`.
- **Steps:**
  1. Inspect each password input's `type` and `autoComplete`.
- **Expected:** Every credential input is `type="password"` (masked). Autocomplete tokens are correct so password managers behave: sign-in password = `current-password`, register password = `new-password` (LoginPage's password field uses `registering ? 'new-password' : 'current-password'`); accept-invite password = `new-password`; the Change password card = `current-password` (Current) + `new-password` (New and Confirm). Email = `email`; names = `given-name` / `family-name`; the accept-invite display name = `name`. No password field autofills as text or omits the token. All password fields also carry `minLength={8}` as a client convenience (the real policy is server-side — SEC-010).
- **Automated:** No
