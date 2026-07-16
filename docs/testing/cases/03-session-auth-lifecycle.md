# Session & Auth Lifecycle

**ID prefix:** SESS | **Scope:** Everything that happens to a session *after* credentials succeed: the 15-minute in-memory access token (`Jwt:ExpiryMinutes` 15) and its silent refresh, the rotating 30-day HttpOnly refresh cookie `zbb_rt` (`Path=/api/auth`, `SameSite=Strict`), cold-load bootstrap from the cookie, the module-level single-flight `refreshSession()` (PR #157), the 401 interceptor with its credential-endpoint exemption LIST (PR #169), session expiry mid-form, the genuinely-dead-session sign-in prompt at `/login?reason=expired&returnUrl=…` (PR #169), deep links while logged out + `returnUrl` sanitizing, multi-tab behavior incl. the `zbb.auth` BroadcastChannel sign-out signal, session persistence across browser restart (sliding 30-day window BY DESIGN), the server-side 30-second refresh-replay grace window that keeps restored tabs from burning the session family (PR #171), logout (token revoked + security-stamp rotation + cookie cleared), and revoke-all-on-password-change. | **Out of scope:** the login/registration forms themselves — field validation, lockout, anti-enumeration, per-endpoint rate limiting on login/register, the *rendering details* of the `?reason=expired` banner and the sign-in leg of returnUrl (02-registration-login.md); landing page and public pages (01-landing-public.md); household switcher, start-own-budget, leave-household, ConsentModal, invite acceptance (households & people file); the `/account` preferences and change-password *form* — only the session side-effects of a password change live here (account settings file); feature-flag route registration, catch-all routing, onboarding mounting (routing & app shell file); role gating per request (roles & access file); dark/responsive/a11y sweeps (cross-cutting files — the expired-banner login page is already axe-scanned by `client/e2e/a11y.spec.ts`). **Do not test for:** "remember me" checkbox (none exists — every session is the 30-day sliding cookie), password reset, refresh-token config knob (`RefreshTokenService.LifetimeDays = 30` is a compile-time const).

**Test data setup:** (a) Existing login `owner@example.com` / `Sunlit-Meadow-42a` (non-breached), Owner of a solo household with at least one budget month and a few transactions, already consented/onboarded (no modal in the way). (b) A second browser or machine ("device B") signed in as the same login where a case says so. (c) Unless stated otherwise, environments: beta (`app.allotjar.com`) or a local full stack (API :5099 + Vite, `ASPNETCORE_ENVIRONMENT=Development` — required for the `Secure` cookie flag to be dropped over http). (d) For 15-minute-expiry cases, either genuinely wait 16 minutes or run locally with `Jwt__ExpiryMinutes=1`; the JWT validator adds 30 s clock skew. (e) To kill a session server-side *without* the app knowing (simulating revocation from elsewhere), run `fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })` in the devtools console — it revokes the refresh token, rotates the security stamp and clears the cookie, but bypasses the client's `logout()` (no state clear, no broadcast). (f) `zbb_rt` is HttpOnly but visible in devtools → Application → Cookies; its value can be copied there for raw-replay cases via `curl -X POST https://<host>/api/auth/refresh -H "Cookie: zbb_rt=<value>" -i`. (g) Raise `RateLimiting__AuthPermitLimit` for scripted runs — 20 auth requests/min per source IP returns 429.

## Cold-load bootstrap & session restore

### SESS-001 - Hard reload restores the session from the HttpOnly refresh cookie
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.com`, sitting on `/transactions`; devtools Network tab open.
- **Steps:**
  1. Press F5 (hard reload) on `/transactions`.
  2. Watch the network log during load.
- **Expected:**
  - A brief loading splash (`role="status"`, sr-only "Loading…") — never a flash of the login page or landing page.
  - Exactly one `POST /api/auth/refresh` → 200 with an `AuthResponse` body and a `Set-Cookie: zbb_rt=<new value>` (rotated — value differs from before the reload).
  - The page lands back on `/transactions` fully signed in; user chip shows the display name.
  - `GET /api/auth/me` fires after the token is applied and re-syncs role/preferences.
- **Automated:** Yes (client/e2e-journey/register.spec.ts — "session survives full page reload" deep-loads /import off the cookie; client/src/auth/AuthContext.test.tsx — bootstrap path)

### SESS-002 - Session survives a full browser restart (within 30 days)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.com`; browser configured to NOT clear cookies on exit.
- **Steps:**
  1. Quit the browser completely (all windows).
  2. Reopen it and navigate to the app root `/`.
- **Expected:**
  - The in-memory access token is gone, but `zbb_rt` persisted (cookie `Expires` ≈ +30 days from last refresh, not session-scoped).
  - Cold-load bootstrap refreshes silently and lands on the dashboard — no sign-in prompt. This "still signed in next day/week" behavior is BY DESIGN (sliding 30-day session).
- **Automated:** No

### SESS-003 - Cold load with no cookie lands signed out, with no zombie UI
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Fresh browser profile (or cookies cleared): no `zbb_rt`, no `zbb.*` localStorage keys.
- **Steps:**
  1. Navigate to `/`.
  2. Navigate to `/transactions`.
- **Expected:**
  - Step 1: one `POST /api/auth/refresh` → 401 with no body and **no** `Set-Cookie` (nothing to clear); the public landing page renders.
  - Step 2: `RequireAuth` bounces to `/login?returnUrl=%2Ftransactions` (no `reason` param — the user was never signed in). No authenticated chrome ever flashes.
- **Automated:** Partial (client/src/auth/AuthContext.test.tsx — "stays signed out without a cookie session"; client/e2e/landing.spec.ts — signed-out landing; the no-Set-Cookie detail is unasserted)

### SESS-004 - Exactly one /auth/refresh on cold load under StrictMode double-mount
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #157 / StrictMode double-mount replayed the just-rotated cookie and tripped reuse detection, burning every refresh token
- **Preconditions:** Local dev build (`npm run dev` — React StrictMode active), signed in previously so a valid `zbb_rt` exists.
- **Steps:**
  1. Hard reload the app with the Network tab open.
  2. Count `POST /api/auth/refresh` requests during the load.
  3. Repeat the reload 5 times.
- **Expected:**
  - Exactly ONE `/auth/refresh` per load, every time — the module-level single-flight in `refreshSession()` (lib/api.ts) absorbs the double-invoked bootstrap effect.
  - No spurious sign-outs across the 5 reloads (the second effect never presents the rotated token).
- **Automated:** Yes (client/src/auth/AuthContext.test.tsx — mounts AuthProvider under StrictMode and asserts exactly one POST)

### SESS-005 - Bootstrap splash covers /login and guarded routes; authed users never see the landing
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Signed in with a valid cookie; network throttled (slow 3G) so the bootstrap window is visible.
- **Steps:**
  1. Cold-load `/` and observe the interval before the refresh resolves.
  2. Cold-load `/login` the same way.
  3. Cold-load `/account` the same way.
- **Expected:**
  - Step 1: splash → dashboard. The anonymous LandingPage is never painted for the authed user.
  - Step 2: splash → redirect away from /login (already authenticated → `AuthedLoginRedirect` to `/`). The login form is never painted.
  - Step 3: splash inside `RequireAuth` → AccountPage. No bounce to /login during bootstrap.
- **Automated:** No

### SESS-006 - Access token is memory-only; localStorage holds identity hints, never a credential
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Signed in as `owner@example.com`.
- **Steps:**
  1. In devtools → Application → Local Storage, list all `zbb.*` keys.
  2. Search localStorage and sessionStorage for the JWT value (copy a fragment from the `Authorization` header of any request in the Network tab).
  3. In the console run `document.cookie`.
- **Expected:**
  - localStorage holds only `zbb.email`, `zbb.role`, `zbb.displayName`, `zbb.currency`, `zbb.numberFormat` (plus unrelated theme/onboarding keys). The JWT appears NOWHERE in storage.
  - `document.cookie` does not include `zbb_rt` (HttpOnly).
  - Bonus check: on a brand-new tab before `/auth/me` resolves, chrome may briefly render from the stored role (fallback Owner) — the server still enforces the real role per request; UI corrects itself when `/auth/me` lands.
- **Automated:** No

### SESS-007 - Refresh cookie attributes are locked down
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Signed in on the beta host (production-mode API); devtools open.
- **Steps:**
  1. Inspect the `Set-Cookie` header on the `POST /api/auth/login` (or `/auth/refresh`) response.
  2. Inspect the cookie in Application → Cookies.
  3. Navigate around non-auth API calls (e.g. `GET /api/budget/current`) and check request cookies.
- **Expected:**
  - `zbb_rt`: `HttpOnly`, `Secure` (non-Development only), `SameSite=Strict`, `Path=/api/auth`, `Expires` ≈ now + 30 days.
  - Because of `Path=/api/auth`, the cookie rides ONLY on `/api/auth/*` requests — step 3's budget calls carry no `zbb_rt`.
- **Automated:** No

## Silent refresh & the 401 interceptor

### SESS-008 - 15-minute access-token expiry mid-use is invisible (silent refresh + retry)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Signed in on `/` (dashboard); local run with `Jwt__ExpiryMinutes=1` (or wait 16 min on beta). Network tab open.
- **Steps:**
  1. Leave the tab open and idle past the access-token lifetime WITHOUT switching away (no focus event).
  2. Perform any data action, e.g. edit a planned amount on a budget line.
- **Expected:**
  - The action's API call gets 401 → the interceptor calls the single-flight `refreshSession()` → `POST /auth/refresh` 200 (cookie rotated) → the original request is retried once with the new bearer and succeeds.
  - The UI shows no error, no sign-out, no navigation — the edit just saves.
  - `/auth/me` refires afterwards (token changed), keeping role/prefs in sync.
- **Automated:** Partial (client/src/lib/api.test.ts — 401→refresh→retry interceptor with mocks; the real-clock expiry leg is manual)

### SESS-009 - Returning to an idle tab silently re-arms a live session (focus revalidation)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in; access token lapsed while the tab was in the background (use `Jwt__ExpiryMinutes=1` locally); the refresh cookie is still valid.
- **Steps:**
  1. Switch to another application/tab for longer than the token lifetime.
  2. Switch back (fires `focus`/`visibilitychange`).
- **Expected:**
  - `isAccessTokenExpired()` is true, so the provider calls `refreshSession()` immediately on focus — one `POST /auth/refresh` 200, no user-visible change.
  - If the token has NOT lapsed yet, returning to the tab fires NO refresh (no-op while within lifetime).
  - No revalidation fires while the document stays hidden.
- **Automated:** Yes (client/src/auth/AuthContext.test.tsx — focus revalidation re-arms live session; no-op while token in lifetime)

### SESS-010 - A burst of simultaneous 401s produces exactly one refresh
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Signed in on a page that fires several API calls at once (e.g. `/reports` loads trends + annual + budget); token expired (`Jwt__ExpiryMinutes=1` locally).
- **Steps:**
  1. With the token lapsed, load `/reports` via in-app navigation so all its data calls fire together and 401 together.
  2. Count `/auth/refresh` POSTs in the network log.
- **Expected:**
  - Exactly one `POST /auth/refresh`; all failed calls retry with the same new token and succeed. The page renders normally.
  - No reuse-detection trip (only one rotation happened).
- **Automated:** Partial (client/src/lib/api.test.ts covers single retry; the shared-promise fan-in for concurrent 401s is exercised implicitly, not asserted for N callers)

### SESS-011 - A retried request that 401s again is not retried a second time
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Signed in; ability to make a request that stays 401 even after refresh (e.g. locally stub an endpoint, or hit `GET /api/auth/me` with a token whose stamp was just rotated in a race).
- **Steps:**
  1. Trigger an API call that returns 401, where refresh succeeds but the retry also returns 401.
- **Expected:**
  - The `__retried` flag stops the loop: exactly one refresh + one retry; the second 401 is surfaced to the caller (page-level error state), never an infinite refresh loop.
  - The failed request is reported once to analytics as an `api_error` (endpoint shape + status only).
- **Automated:** Partial (client/src/lib/api.test.ts — retry-once contract; the retry-also-401 branch is implied by the flag but not directly asserted)

### SESS-012 - Credential endpoints are exempt from refresh-retry as a LIST, not a prefix
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 / the blanket `/auth/` prefix exemption made `/account` a dead end that could never prompt re-login
- **Preconditions:** Signed in; a second scenario with a dead session on `/account`.
- **Steps:**
  1. On `/login`, submit a wrong password. Observe the network log.
  2. Sign in, go to `/account`, kill the session server-side (console `fetch('/api/auth/logout', {method:'POST', credentials:'include'})`), then click "Save preferences".
- **Expected:**
  - Step 1: the 401 from `POST /auth/login` triggers NO `/auth/refresh` and no redirect — the form shows "Invalid email or password." (exempt list: `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/accept-invite`, `/auth/logout`).
  - Step 2: the 401 from `PUT /auth/preferences` (NOT exempt) triggers refresh → refresh fails (cookie revoked) → hard navigation to `/login?reason=expired&returnUrl=%2Faccount` with the amber expired-session notice. `/account` is never a silent dead end.
- **Automated:** Yes (client/src/lib/api.test.ts — auth endpoints never refreshed but /auth/me IS refresh-and-retried)

### SESS-013 - Interceptor-driven refresh re-syncs AuthContext (role changes picked up without reload)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Shared household: `owner@example.com` plus member login `member@example.test` with role Admin, both signed in (member on device B).
- **Steps:**
  1. As owner, change the member's role to "Read-only" on `/people`.
  2. On device B (member), let the access token lapse, then trigger any API call (or refocus the tab) so a silent refresh runs.
- **Expected:**
  - After the refresh, `sessionHandlers.refreshed` re-applies the session → the token change refires `GET /auth/me` → the client adopts role 3: read-only banner "You have read-only access — you can view everything but cannot make changes." appears and edit controls disappear, with no hard reload.
  - (Server-side the downgrade was already enforced per request from the moment of the change.)
- **Automated:** Partial (client/src/lib/api.test.ts — refreshed-handler notification keeps AuthContext in sync; the end-to-end role swap is manual)

### SESS-014 - 429 rate-limited refresh is treated as a dead session
- **Priority:** P3
- **Type:** Negative
- **Preconditions:** Local run with default `RateLimiting__AuthPermitLimit=20`; signed in.
- **Steps:**
  1. From the console, burn the auth rate window: `for (let i=0;i<25;i++) fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})`.
  2. With the window exhausted, force a silent refresh (lapsed token + any API action).
- **Expected:**
  - `POST /auth/refresh` returns 429; `refreshSession()` resolves null → `sessionExpired()` → bounce to `/login?reason=expired&returnUrl=…`.
  - Signing back in after the window resets (≤1 min) works; no tokens were burned (the 429 never reached rotation). Defensive sign-out is accepted behavior; document if product wants a friendlier retry.
- **Automated:** No

## Session expiry mid-form

### SESS-015 - Token lapses while filling a form; submit still succeeds silently
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Signed in on `/transactions`; token lifetime shortened locally (`Jwt__ExpiryMinutes=1`); refresh cookie valid.
- **Steps:**
  1. Start adding a transaction (payee, amount, line assignment) but do not submit.
  2. Wait past the access-token lifetime.
  3. Click "Add transaction".
- **Expected:**
  - The `POST /transactions` 401s → silent refresh → retry → 201; the transaction appears in the register. Nothing typed is lost; no redirect, no error flash.
- **Automated:** No

### SESS-016 - Session genuinely dead mid-form: bounced with returnUrl, unsaved input is lost
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Signed in on `/transactions` with a half-filled add-transaction form.
- **Steps:**
  1. Kill the session server-side via console `fetch('/api/auth/logout', {method:'POST', credentials:'include'})` (revokes token + rotates stamp; the page doesn't know).
  2. Click "Add transaction".
  3. Sign back in from the prompt.
- **Expected:**
  - Step 2: the save 401s (stamp mismatch: "This session has been revoked.") → refresh attempt 401s (no valid cookie) → `sessionExpired()` hard-navigates to `/login?reason=expired&returnUrl=%2Ftransactions`. The amber notice explains the sign-out.
  - Step 3: after signing in, the user lands back on `/transactions`. The unsaved form content is gone (hard navigation) — accepted behavior; the transaction was never created (no partial write).
- **Automated:** Partial (client/e2e-journey/session-expiry.spec.ts — revoked tab → prompt → returnUrl round-trip; the mid-form data-loss detail is manual)

## Genuinely-dead sessions & the sign-in prompt

### SESS-017 - A revoked session prompts a fresh sign-in on the very next action — no zombie UI
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #169 / dead sessions used to strand the user on stale pages with failing saves instead of prompting re-login
- **Preconditions:** Signed in as `owner@example.com` on `/transactions`.
- **Steps:**
  1. Revoke server-side: console `fetch('/api/auth/logout', {method:'POST', credentials:'include'})`.
  2. Click any in-app navigation that loads data (e.g. the "Budget" nav item).
  3. On the login page, verify the URL and the notice, then sign back in with the same password.
- **Expected:**
  - Step 2: within one round-trip the app hard-navigates to `/login?reason=expired&returnUrl=<encoded origin route>` — the stamp rotation killed the access token instantly, so there is no 15-minute zombie window.
  - Step 3: URL carries `reason=expired`; the amber `role="status"` notice reads "Your session has expired, so we signed you out to keep your budget safe. Sign back in to pick up where you left off." Signing in returns to the `returnUrl` route, not the dashboard.
- **Automated:** Yes (client/e2e-journey/session-expiry.spec.ts — revoked tab bounces to /login?reason=expired&returnUrl=%2Ftransactions and returns there after sign-in)

### SESS-018 - Focus revalidation of a dead session prompts sign-in
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 / overnight-dead sessions surfaced only when a save failed
- **Preconditions:** Signed in; access token lapsed (short lifetime locally); refresh token revoked server-side while the tab was backgrounded (console logout trick from another tab of the same profile, or wait for a real 30-day expiry).
- **Steps:**
  1. Background the tab past the access-token lifetime; revoke the session server-side meanwhile.
  2. Refocus the tab without clicking anything.
- **Expected:**
  - The `focus`/`visibilitychange` handler sees `isAccessTokenExpired()`, calls `refreshSession()` → null → `sessionExpired()` → immediate bounce to `/login?reason=expired&returnUrl=…` without waiting for the user to touch anything.
- **Automated:** Yes (client/src/auth/AuthContext.test.tsx — focus revalidation on dead session prompts sign-in with session-expired reason)

### SESS-019 - loginRedirectPath boundaries: /login no-op, bare /, deep path with query
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Understanding checks on the expiry redirect URL builder; reproduce each with the console-revoke trick.
- **Steps:**
  1. Kill the session while sitting on `/login` (e.g. an expired bounce already happened) and force another `sessionExpired()` (trigger any stray API call from the console).
  2. Kill the session while on `/` (dashboard) and trigger a call.
  3. Kill the session while on `/reports?year=2026` (or any route with a query string) and trigger a call.
- **Expected:**
  - Step 1: no navigation happens (already on `/login` → path builder returns null; no redirect loop).
  - Step 2: navigates to `/login?reason=expired` with NO `returnUrl` (redundant for `/`).
  - Step 3: navigates to `/login?reason=expired&returnUrl=%2Freports%3Fyear%3D2026` — pathname AND search survive, percent-encoded.
- **Automated:** Yes (client/src/lib/api.test.ts — loginRedirectPath carries returnUrl + reason, omits redundant returnUrl for /, no-ops on /login)

### SESS-020 - Sliding 30-day session: daily use never re-prompts (BY DESIGN)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.com`; devtools access to the cookie's expiry timestamp.
- **Steps:**
  1. Note the `zbb_rt` `Expires` value in devtools.
  2. Use the app the next day (any silent refresh fires).
  3. Re-check the cookie's `Expires`.
- **Expected:**
  - Every successful refresh rotates the token AND re-extends both the cookie and the DB row a full 30 days from now — step 3's expiry is ~24 h later than step 1's. A returning user is only ever signed out after 30 days of total absence (or explicit revocation). This is the designed behavior — do NOT file "still signed in next day" as a bug.
- **Automated:** No

## Deep links while logged out & returnUrl

### SESS-021 - Deep link while logged out round-trips through login
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed out (no cookie); target deep link `/accounts` (accounts flag on).
- **Steps:**
  1. Paste `/accounts` into the address bar.
  2. Sign in as `owner@example.com` from the resulting page.
- **Expected:**
  - Step 1: `RequireAuth` renders `/login?returnUrl=%2Faccounts` (no `reason` param, so no amber banner).
  - Step 2: after "Sign in", `navigate(returnUrl)` lands on `/accounts` directly — never via the dashboard.
- **Automated:** Partial (client/src/pages/LoginPage.test.tsx — returns to safe internal returnUrl after sign-in; the RequireAuth production of the URL is asserted only for the expired journey)

### SESS-022 - Bare / bounce carries no returnUrl; an authed visit to /login honours returnUrl
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** One signed-out browser and one signed-in browser.
- **Steps:**
  1. Signed out, load `/` — then, from the landing page, click through to sign in.
  2. Signed in, paste `/login` into the address bar.
  3. Signed in, paste `/login?returnUrl=%2Ftransactions`.
- **Expected:**
  - Step 1: the landing renders (no bounce, `/` is public); no stray `returnUrl` appears anywhere.
  - Step 2: `AuthedLoginRedirect` immediately replaces to `/` — an authed user never sees the login form.
  - Step 3: immediately replaces to `/transactions` (used by the invite flow to return to `/accept-invite?...`).
- **Automated:** Partial (route logic exercised by client/src/pages/LoginPage.test.tsx and journey specs; the authed-/login redirect itself has no dedicated test)

### SESS-023 - Malicious returnUrl values are neutralized to /
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Signed in (so `AuthedLoginRedirect` resolves immediately); also repeat signed-out + sign-in for the LoginPage leg.
- **Steps:**
  1. Visit each of: `/login?returnUrl=https%3A%2F%2Fevil.example`, `/login?returnUrl=%2F%2Fevil.example`, `/login?returnUrl=%2F%5Cevil.example`, `/login?returnUrl=%2F%09%2Fevil.example` (embedded TAB control char), `/login?returnUrl=transactions` (not slash-rooted), `/login?returnUrl=`.
- **Expected:**
  - Every case lands on `/` — `safeInternalPath` accepts only single-slash-rooted internal paths and rejects absolute URLs, `//` and `/\` scheme-relative forms, any control character 0x00-0x1F/0x7F (WHATWG-parser strip attack), non-rooted values and empty strings. The browser NEVER navigates off-origin.
- **Automated:** Yes (client/src/lib/returnUrl.test.ts — accept/reject table incl. control-char smuggling)

## Multi-tab behavior & cross-tab sign-out broadcast

### SESS-024 - Signing out in one tab signs out every other tab
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #169 / other tabs used to keep a working in-memory token for up to 15 minutes after logout
- **Preconditions:** Signed in as `owner@example.com` with two tabs open: tab 1 on `/` (dashboard), tab 2 on `/transactions`.
- **Steps:**
  1. In tab 1, open the account menu (aria-label "Account menu") and click "Sign out".
  2. Switch to tab 2 without reloading it.
- **Expected:**
  - Tab 1: signed out (see SESS-037 for full logout expectations).
  - Tab 2: receives `'signed-out'` on BroadcastChannel `zbb.auth`, clears its auth state instantly and `RequireAuth` bounces it to `/login?returnUrl=%2Ftransactions` — it does NOT keep rendering budget data, and its next API call cannot succeed anyway (stamp rotated).
- **Automated:** Partial (client/src/auth/AuthContext.test.tsx — another tab's sign-out broadcast signs this tab out, via the BroadcastChannel polyfill; no real two-tab browser test)

### SESS-025 - A session dying in one tab broadcasts to the others too
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 / `sessionExpired()` broadcasts, not just explicit logout
- **Preconditions:** Two tabs signed in; session revoked server-side (console logout trick in tab 1 — note this trick itself does not broadcast; the *detection* must).
- **Steps:**
  1. Revoke server-side from tab 1's console.
  2. In tab 1, trigger any API action so the dead session is detected (`sessionExpired()` fires).
  3. Observe tab 2.
- **Expected:**
  - Tab 1 bounces to `/login?reason=expired&returnUrl=…`; its `expired` handler also broadcasts `'signed-out'`.
  - Tab 2 clears state and bounces to `/login` promptly — both tabs converge on the sign-in prompt instead of tab 2 lingering as a zombie.
- **Automated:** Partial (client/src/auth/AuthContext.test.tsx covers broadcast-on-expired via the handlers; the two-real-tabs choreography is manual)

### SESS-026 - The broadcasting tab ignores its own signal; environments without BroadcastChannel degrade
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Signed in, one tab.
- **Steps:**
  1. Sign out via the account menu and watch the console for errors / repeated state churn.
  2. (Environment leg) In a browser context without `BroadcastChannel` (or with it stubbed to `undefined` locally), sign in and out.
- **Expected:**
  - Step 1: the receiver guards on `getToken()` — by the time its own message would arrive, the token is already null, so nothing re-fires; no loops, no errors.
  - Step 2: everything works per-tab (sign-out completes normally); cross-tab propagation is silently absent — no crash (`broadcastSignOut`/`onSignOutBroadcast` no-op when the API is missing).
- **Automated:** Partial (client/src/auth/AuthContext.test.tsx — receiver guard; the no-BroadcastChannel degrade path is untested)

### SESS-027 - Logout on device A leaves device B signed in (and B self-heals its access token)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Same login on two separate browsers/machines (separate cookie jars): device A and device B, both mid-session.
- **Steps:**
  1. On device A, "Sign out".
  2. On device B, immediately perform an API action (within its token's remaining lifetime).
  3. On device B, wait past the access-token lifetime and act again.
- **Expected:**
  - Step 2: device B's current access token now fails the security-stamp check (logout rotated the stamp) → its call 401s → silent refresh via B's OWN still-valid cookie → retried and succeeds. At most a one-round-trip hiccup, no sign-out, no prompt.
  - Step 3: business as usual. Logout revokes only A's refresh token — B's session family is untouched.
- **Automated:** No (the analogous password-change device-A/device-B split is covered by client/e2e-journey/session-expiry.spec.ts; the logout variant is not)

## Refresh rotation & the 30-second replay grace window

### SESS-028 - Browser session-restore with multiple app tabs survives the same-cookie refresh race
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #171 / restored tabs racing /auth/refresh with one cookie burned the whole session family
- **Preconditions:** Signed in with 3+ app tabs open (mix of `/`, `/transactions`, `/reports`); browser set to restore tabs on launch.
- **Steps:**
  1. Quit the browser fully; reopen it so all tabs cold-load simultaneously.
  2. Watch each tab settle; check the network log in a couple of them.
  3. Keep using the app for 20+ minutes (past at least one more silent refresh).
- **Expected:**
  - Every tab ends up signed in on its original route. Per tab there is one `/auth/refresh` (per-tab single-flight); across tabs they race the same cookie — one wins 200 + rotated cookie, the losers get 401 flagged Superseded server-side.
  - No tab shows the expired-session prompt, and — critically — the session is NOT burned: step 3's later refreshes keep succeeding.
- **Automated:** Partial (client/e2e-journey/concurrent-refresh.spec.ts races two raw refresh POSTs over real HTTP; the full multi-tab browser restore is manual)

### SESS-029 - The grace 401 must NOT clear the shared cookie jar
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #171 / the losing tab's Set-Cookie deletion evicted the WINNER's fresh cookie, signing it out ~15 min later
- **Preconditions:** Copy the current `zbb_rt` value from devtools (call it T0); the app is signed in.
- **Steps:**
  1. Trigger a rotation (hard reload → refresh 200; jar now holds T1).
  2. Within 30 seconds, replay T0 raw: `curl -X POST https://<host>/api/auth/refresh -H "Cookie: zbb_rt=<T0>" -i`.
  3. Inspect the replay response headers; then leave the browser tab open >15 minutes and act in it.
- **Expected:**
  - Step 2: 401 with NO `Set-Cookie` header at all — the response must not delete `zbb_rt` (in the real multi-tab case that header lands in the shared jar and would evict T1).
  - Step 3: the browser's next silent refresh (using T1) still succeeds — the winning session was untouched and no family burn occurred.
- **Automated:** Yes (client/e2e-journey/concurrent-refresh.spec.ts — loser 401 with no Set-Cookie, winner's rotated cookie still refreshes; tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs — grace-window rotation trio)

### SESS-030 - Replaying a rotated token OUTSIDE the 30s window still burns the family (theft response)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #171 / the grace window must not weaken real theft detection
- **Preconditions:** Captured pre-rotation token T0 as in SESS-029; a second device (B) signed in to the same login.
- **Steps:**
  1. Rotate (reload the app; jar holds T1).
  2. Wait >30 seconds.
  3. Replay T0 via curl and inspect the response.
  4. In the browser (holding T1), wait past the access-token lifetime and act; also act on device B.
- **Expected:**
  - Step 3: 401 AND the cookie is cleared (`Set-Cookie` deleting `zbb_rt`), AND `RevokeAllForUserAsync` burns every active refresh token for the user.
  - Step 4: both the original browser and device B fail their next refresh → both bounce to `/login?reason=expired…`. Neither the thief nor the legitimate sessions can continue — by design.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs — replay outside the grace window burns the chain)

### SESS-031 - Repeated replays inside the window never yield a credential and never burn
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Captured pre-rotation token T0; rotation just happened.
- **Steps:**
  1. Within the 30s window, replay T0 five times in quick succession via curl.
  2. Continue using the signed-in browser afterwards.
- **Expected:**
  - Every replay: 401, no `AuthResponse` body, no Set-Cookie — a replayed cookie NEVER yields a token, grace or not.
  - The browser session keeps working (no burn from any of the five).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs — repeated replays within the grace window stay refused without burning)

### SESS-032 - Replay of an admin-revoked (logout) token is a plain refusal, not a theft response
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 / a stale signed-out device replaying its token used to nuke the user's fresh sessions
- **Preconditions:** Device A signed out via "Sign out" (its token revoked WITHOUT a replacement); its old `zbb_rt` value captured beforehand. User has since signed in again (fresh session, device B or same browser).
- **Steps:**
  1. Replay device A's old token via curl (any time later — the grace window is irrelevant here).
  2. Check the fresh session still works.
- **Expected:**
  - Step 1: 401 + cookie cleared — plain refusal. Because the token has `RevokedUtc` set but NO `ReplacedByTokenHash`, the theft branch is skipped.
  - Step 2: the user's current session is untouched (no `RevokeAllForUser`) — a stale signed-out device can never kill live sessions.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs — administratively revoked replay refused WITHOUT the theft response)

## Refresh endpoint negatives & boundaries

### SESS-033 - Refresh with no cookie is a bare 401
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Any HTTP client, no cookie header.
- **Steps:**
  1. `curl -X POST https://<host>/api/auth/refresh -i` with no Cookie header.
- **Expected:**
  - 401 with an empty body and NO `Set-Cookie` header (nothing to clear — `ClearRefreshCookie` is not called on this path). This is also the normal signed-out cold-load response the SPA sees.
- **Automated:** Partial (client/e2e/mocks.ts stubs this as the signed-out default; no direct server assertion)

### SESS-034 - Refresh with a garbage/unknown cookie value clears the cookie
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Any HTTP client.
- **Steps:**
  1. `curl -X POST https://<host>/api/auth/refresh -H "Cookie: zbb_rt=not-a-real-token-🙂" -i` (also try an empty value and a 5,000-character value).
- **Expected:**
  - 401 in every case, with a `Set-Cookie` deleting `zbb_rt` (unknown token → hard clear so the browser stops re-presenting junk). No 500 on the huge or emoji-laden values — the value is only hashed, never parsed.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs — unknown token rejected at service level; the HTTP Set-Cookie clearing is unasserted)

### SESS-035 - A 30-day-old (expired) refresh token prompts a fresh sign-in
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** A refresh token past its `ExpiresUtc` (backdate the row in a local DB: `UPDATE RefreshTokens SET ExpiresUtc = DATEADD(day,-1,GETUTCDATE()) WHERE ...`, or keep a profile untouched for 30+ days).
- **Steps:**
  1. Cold-load the app with the expired cookie.
- **Expected:**
  - `POST /auth/refresh` → 401 + cookie cleared; the bootstrap resolves signed-out; `/` shows the landing page and guarded routes bounce to `/login` (plain, no `reason=expired` — the bounce comes from RequireAuth, not `sessionExpired()`). No token is issued for an expired row even if un-revoked.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/RefreshTokenServiceTests.cs — expired rejected; the browser-side landing behavior is manual)

### SESS-036 - Deleted user with a live cookie cannot refresh
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Local environment; a signed-in user whose `AspNetUsers` row is then deleted directly in the DB while their `zbb_rt` remains valid.
- **Steps:**
  1. Cold-load the app with the orphaned cookie.
- **Expected:**
  - The rotation itself succeeds at the token level, but the user lookup fails → 401 + cookie cleared. The app lands signed out; no crash, no half-authenticated state.
- **Automated:** No

## Logout

### SESS-037 - Sign out end-to-end: token revoked, stamp rotated, cookie cleared, state wiped
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.com` on `/transactions`; note the current `zbb_rt` value and copy the current bearer token from a request header.
- **Steps:**
  1. Open the account menu (aria-label "Account menu") and click "Sign out".
  2. Inspect network, cookies and localStorage.
  3. Replay the OLD bearer token: `curl https://<host>/api/auth/me -H "Authorization: Bearer <old JWT>" -i`.
  4. Replay the OLD cookie against `/auth/refresh` via curl.
- **Expected:**
  - Step 1: fire-and-forget `POST /auth/logout` → 204 with `Set-Cookie` deleting `zbb_rt`; client state clears instantly (no waiting on the response); `RequireAuth` bounces the tab to `/login?returnUrl=%2Ftransactions` (no `reason=expired` — this was a chosen sign-out); analytics `logout` event fires.
  - Step 2: `zbb_rt` gone; `zbb.email`, `zbb.role`, `zbb.displayName` removed; `zbb.currency`/`zbb.numberFormat` reset to the defaults ("EUR"/"comma-dot") and the money format resets.
  - Step 3: 401 — the security-stamp rotation killed the access token immediately, not after its remaining ≤15 min.
  - Step 4: 401 (revoked; and per SESS-032 this replay does NOT burn any future sessions).
- **Automated:** Partial (client/e2e-journey/session-expiry.spec.ts exercises server logout semantics + revoked-tab behavior; the menu-driven client flow incl. localStorage wipe has no test)

### SESS-038 - Logout is resilient: network failure still signs out locally; endpoint is idempotent
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Signed in; devtools able to simulate offline.
- **Steps:**
  1. Set the network to Offline in devtools, then click "Sign out".
  2. Restore the network; verify what the server thinks (try refreshing the app cold).
  3. Separately, test idempotency: `curl -X POST https://<host>/api/auth/logout -i` with NO cookie header.
- **Expected:**
  - Step 1: the failed `POST /auth/logout` is swallowed (`.catch(() => {})`); local state clears, other tabs are broadcast-signed-out, the UI lands on /login. No error surfaces.
  - Step 2: because the server never revoked, the cookie still restores a session on cold load — known trade-off of fire-and-forget; the user can sign out again online. Document, don't "fix" silently.
  - Step 3: 204 even with no cookie (idempotent), plus a clearing Set-Cookie.
- **Automated:** No

### SESS-039 - Logout kills the access token instantly (security-stamp rotation)
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 / logout used to leave the stateless JWT valid for its remaining lifetime
- **Preconditions:** Signed in; current bearer JWT copied from a request header.
- **Steps:**
  1. Sign out.
  2. Immediately replay the old JWT against `GET /api/auth/me` and against a data endpoint (`GET /api/budget/current`).
- **Expected:**
  - Both replays 401 with the bearer challenge (server-side reason: "This session has been revoked." — definite `sstamp` mismatch after `UpdateSecurityStampAsync`). No 15-minute grace for a signed-out token.
  - Legacy stamp-less tokens (pre-#93) are the only tokens allowed to ride out their natural expiry; current builds always embed `sstamp`.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/SecurityStampValidationTests.cs — rotated stamp revokes the token; journey session-expiry.spec.ts exercises the full path)

## Password change & session revocation

### SESS-040 - Changing the password ends every other session; the current device continues seamlessly
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #169 / change-password now revokes ALL refresh tokens and returns 200 AuthResponse (was 204) which the client must apply
- **Preconditions:** Same login on device A (browser, on `/account`) and device B (second browser, signed in on `/`).
- **Steps:**
  1. On device A: "Change password" card → fill "Current password", "New password", "Confirm new password" (new random non-breached value) → click "Change password".
  2. Still on device A: keep using the app past the old access token's lifetime (force a silent refresh).
  3. On device B: trigger any API action (or refocus the tab).
  4. From device B's login prompt, sign in with the NEW password.
- **Expected:**
  - Step 1: `POST /auth/change-password` → 200 `AuthResponse`; success notice "Your password has been changed." The response's fresh token + rotated cookie are applied client-side (`apply()`), so device A is now on a brand-new session family.
  - Step 2: device A's silent refresh succeeds with its NEW cookie — no sign-out, no theft response tripped (its old token was admin-revoked, not rotated-replayed; see SESS-032).
  - Step 3: device B's access token fails the stamp check → 401 → refresh with its revoked cookie → 401 → bounce to `/login?reason=expired&returnUrl=…` with the amber notice. Device B cannot continue on the old password's session.
  - Step 4: the new password signs in; the old password now fails with "Invalid email or password."
- **Automated:** Yes (client/e2e-journey/session-expiry.spec.ts — password change signs out device A's counterpart everywhere while the changing device's rotated cookie still refreshes, and re-login uses the new password)
