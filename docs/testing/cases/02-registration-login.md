# Registration & Login

**ID prefix:** REG | **Scope:** The `/login` page in both modes, in the signed-out frame it shares with `/forgot-password`, `/reset-password` and `/accept-invite` (restyle PR 9, `AuthFrame.tsx`: on desktop a green room across the top holding the AllotJar wordmark, the **Dark mode** button and the one line "Give every … a job." over a shelf of four glass jars, with the off-white card in front of it; on a phone a compact green band and the card as a sheet under it down to the bottom of the screen): the quiet "Sign in | Create account" switch at the top of the card, the create-account form (first/last name, email, password, currency picker with its (i), number-format picker, opt-in sample-budget checkbox, terms consent, staging data-loss consent) with every client- and server-side validation rule (`POST /api/auth/register`), HIBP breached-password rejection, duplicate-email handling, the sign-in form (`POST /api/auth/login`) with wrong-credential, anti-enumeration, lockout and rate-limiting behavior, returnUrl navigation at sign-in time, and the first-login landing state for both PR #170 paths (empty account vs seeded sample budget). | **Out of scope:** everything after a session exists — silent refresh, 401 interceptor, `sessionExpired()` production, cross-tab broadcast, logout, refresh-replay grace window (sessions file 03; REG only covers the login-form *rendering* of `?reason=expired` and the sign-in leg of returnUrl); landing-page CTAs, staging banner on public pages, analytics consent banner, SEO (01-landing-public.md); `/accept-invite` registration path and household greetings `?started/?left` (households & people file); `/account` preferences and change-password (account settings file); ConsentModal general behavior and the onboarding welcome/tour (routing & app shell file); full dark/responsive/a11y sweeps (cross-cutting files — `/login` is already axe-scanned in both modes/themes, with the currency (i) and the session-expired (i) open, by `client/e2e/a11y.spec.ts`). **Do not test for:** separate username — none exists (username == email). The forgot/reset-password flow (`/forgot-password`, `/reset-password`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`) IS in scope — see the "Password reset" section (REG-051..REG-066). **Google sign-in** (`POST /api/auth/google`, the "Sign in with Google" button) IS in scope — see the "Google sign-in" section (REG-073..REG-081).

**Test data setup:** (a) A clean anonymous browser profile — no `zbb_rt` cookie, no `zbb.*` localStorage keys. (b) An existing login `owner@example.com` / `Sunlit-Meadow-42a` (non-breached, meets digit+upper+lower policy), Owner of a solo household with at least one budget month. (c) Fresh unique registration emails per case (`reg-<case>@example.test`) and random non-breached passwords of shape `Aa1-<uuid>` (HIBP rejects fixed common passwords — journey-harness gotcha). (d) Unless a case says otherwise, run against a **staging-mode** build (`VITE_APP_ENV=staging`, e.g. staging.allotjar.com or a local staging build) where the staging banner and the required staging data-loss checkbox render; REG-016 covers the GA/default build. (e) Server defaults: rate limit 20 auth requests/min per source IP (`RateLimiting:AuthPermitLimit`), lockout 5 failures → 15 min, HIBP reachable. (f) Browser locale `en-GB` unless the case pins another locale. (g) Password-reset cases: run against a Development-env API with NO `Email:ApiKey` configured — outbound mail is then captured in-memory and readable at `GET /api/dev/emails?to=<email>` (`textBody` carries the reset link); production sends via Resend instead and has no mailbox endpoint. For "direct API" steps use any HTTP client against `POST /api/auth/register` with a JSON body — the UI blocks those inputs client-side.

## Page frame & mode switch

### REG-001 - Login page renders sign-in mode by default with full chrome
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Anonymous browser; navigate cold to `/login`.
- **Steps:**
  1. Load `/login` and wait for the auth bootstrap splash to clear (cold load 401s the cookie refresh).
  2. Inspect the page.
- **Expected:**
  - Staging banner (`role="status"`, one line on the warn tone): "Staging · test data, may be reset" (staging build only), a strip across the top of the page above the green room.
  - Desktop: a green room across the top holds the wordmark (jar logo + "AllotJar", not a heading) at its left, the round **Dark mode** button (`aria-pressed`, a moon in light, a sun in dark) at its right, and the one line "Give every euro a job." with the money word in gold (euro always, whatever the locale, since restyle PR 16 — the app is euro-first, as the landing page already read; see REG-031), over a shelf of four glass jars, two each side of the card (decoration, hidden from assistive tech; under 1180px wide only the two inner jars, under 1000px no shelf). Phone (under 700px wide): the wordmark row, the button and the line in a compact green band with a small shelf of the same four jars, and the card a sheet with rounded top corners from under the band to the bottom of the screen. No tagline "Zero-based budgeting, in your currency." and no Light/Dark "Theme" group (both gone).
  - The off-white card with a gold hairline edge. The page's only heading is a visually hidden h1 "Sign in to AllotJar".
  - At the top of the card, the full-width switch (`role="group"`, `aria-label="Sign in or create an account"`), options "Sign in" (pressed) and "Create account".
  - Only two fields: "Email" (`type=email`, placeholder "you@example.com", autocomplete `email`) and "Password" (`type=password`, placeholder "At least 8 characters", autocomplete `current-password`), with "Forgot password?" on the Password label's line. No name/currency/format/checkbox fields.
  - One submit button, "Sign in", a full-width pill (Google's "or" and button under it only when configured, REG-080). Tab order: Dark mode, the switch's two options, Email, Forgot password?, Password, Sign in.
  - On a 390×844 phone the switch, both fields and the submit are on the first screen without scrolling, and no signed-out page scrolls sideways.
- **Automated:** Partial (client `LoginPage.catalog.test.tsx` REG-001; `LoginPage.frame.test.tsx` — the room, the Dark mode button, the one heading, one submit, Tab order; `AuthPages.frame.test.tsx` — the staging banner; client/e2e/mobile-layout.spec.ts — signed-out pages on a phone; client/e2e/a11y.spec.ts — axe scan of both modes; the drawing itself — jars, glow, gold — is checked by eye)

### REG-002 - Switching to "Create account" reveals all registration fields
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Anonymous browser on `/login` (sign-in mode).
- **Steps:**
  1. Click "Create account" in the switch at the top of the card.
  2. Inspect the form top-to-bottom; hover or focus the (i) beside "Currency".
  3. Click "Sign in" to switch back.
- **Expected:**
  - Registration mode adds, in order: "First name" + "Last name" side by side (both required, autocomplete `given-name`/`family-name`); "Currency" and "Number format" selects side by side, with an (i) button **About these settings** after the Currency label (outside it, so the field keeps its one label) whose tooltip reads "Your budget and its accounts use this currency. You can change it in account settings until you add your first account, month or transaction; the number format any time." (then it is the fixed budget currency, PREF-011/PREF-042); it opens on hover or focus and Escape closes it; unticked sample-figures checkbox ("Start with sample figures to explore — example groups and amounts you can edit or delete anytime. Leave unticked to start with an empty budget."); required terms checkbox ("I agree to the Terms of Service and Privacy Policy."); staging build only: under it, the required data-loss checkbox in an amber box, "I understand this is the AllotJar staging test environment, and that my data may be reset or permanently lost."
  - Password autocomplete switches to `new-password`; submit button label becomes "Create account"; the visually hidden h1 reads "Create your AllotJar account". Still one submit button.
  - Keyboard: from Password, Tab reaches the (i), then Currency, Number format, the terms checkbox, Terms of Service, Privacy Policy and the submit. Space or Enter on a switch option changes the mode and leaves focus on it; the next Tab goes into the new mode's first field.
  - The "Terms of Service" and "Privacy Policy" links open `/terms` and `/privacy` in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).
  - Switching back to "Sign in" hides every registration-only field again; entered email/password values are kept.
- **Automated:** Partial (client `LoginPage.catalog.test.tsx` REG-002 ×2 — the explainer read after hovering its (i); `LoginPage.frame.test.tsx` — the (i) as a tooltip, Escape, the one Currency label, Tab order, Space/Enter on the switch; client/src/pages/LoginPage.test.tsx + `AuthPages.frame.test.tsx` — staging checkbox; client/e2e/a11y.spec.ts — axe with the (i) open)

### REG-003 - Deep link `/login?register=1` opens on Create account
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous browser.
- **Steps:**
  1. Navigate directly to `/login?register=1`.
  2. Also try `/login?register=anything` and `/login?register=` (param present with any/empty value).
- **Expected:**
  - All three land with "Create account" pressed in the switch and registration fields visible (the code checks `searchParams.has('register')`, not its value). Plain `/login` still opens on "Sign in". The switch never changes the URL: switching to "Sign in" from `/login?register=1` (or either way from `/login?returnUrl=…`) leaves the address as it was.
- **Automated:** Full (client `LoginPage.catalog.test.tsx` REG-003; `LoginPage.frame.test.tsx` — the switch and the URL; client/e2e-journey/helpers.ts — register() drives `/login?register=1`; client `LandingPage.catalog.test.tsx` — CTAs point at it)

### REG-004 - Switching tabs clears the current error message
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Anonymous browser on `/login`.
- **Steps:**
  1. Sign in with `owner@example.com` and a wrong password → error "Invalid email or password." appears as one red `role="alert"` line (with an alert icon) directly above the submit.
  2. Click "Create account" in the switch.
  3. Click "Sign in" again.
- **Expected:**
  - Step 2: the error disappears immediately (mode switch calls `setError(null)`).
  - Step 3: still no error; the form is clean.
- **Automated:** Full (client `LoginPage.catalog.test.tsx` REG-004; `LoginPage.frame.test.tsx` — the one alert above the submit)

### REG-005 - Submit button busy state prevents double submission
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Anonymous browser on `/login?register=1`; all registration fields validly filled; network throttled (slow 3G) to widen the window.
- **Steps:**
  1. Click "Create account" and immediately click it again (and mash Enter).
- **Expected:**
  - While the request is in flight the button is disabled and reads "Please wait…".
  - Exactly one `POST /api/auth/register` is sent (check the network log); exactly one account is created.
  - On success the button never re-enables before navigation to `/`.
- **Automated:** No

## Create account — happy paths & the sample-budget choice

### REG-006 - Default registration (sample unticked) creates a completely empty account
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Anonymous browser on `/login?register=1`; fresh email `reg-006@example.test`.
- **Steps:**
  1. Fill "First name" = `Ana`, "Last name" = `Borg`, "Email", "Password" = a fresh `Aa1-<uuid>`.
  2. Leave "Currency" = the preselected value (EUR under en-GB? see REG-031 — pick "Euro (€)" explicitly), "Number format" = "1,234.56".
  3. Leave the sample-figures checkbox **unticked** (its default).
  4. Tick the terms checkbox and (staging build) the data-loss checkbox.
  5. Click "Create account".
- **Expected:**
  - 200 from `POST /api/auth/register` with `includeSampleData: false` in the request body; user is signed in immediately (no email verification step) and navigated to `/`.
  - Dashboard shows the create-month hero: "No budget for {current month} {year} yet." with buttons "Start a blank budget" and the "Or start from a template" template grid. **No** "Copy …" button (no previous month exists).
  - No budget months, no transactions, no accounts; `/jars` shows its empty state (no "Emergency Fund" jar).
  - The account-menu chip shows "Ana Borg" (DisplayName = "First Last").
- **Automated:** Yes (client/e2e-journey/register.spec.ts — default registration lands on an empty budget)

### REG-007 - Opting in to sample figures seeds the exact starter budget
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Anonymous browser on `/login?register=1`; fresh email; currency "Euro (€)", format "1,234.56".
- **Steps:**
  1. Fill all fields as in REG-006 but **tick** "Start with sample figures to explore …".
  2. Tick terms (+ staging) and click "Create account".
  3. Inspect the dashboard, then open `/jars`.
- **Expected:**
  - Request body carries `includeSampleData: true`. Landing = a seeded month for the current UTC month:
    - Income group with line "Take-home Pay" planned €3,000.00 (line names render as textbox *values* — assert via the "Income source name" textbox, not text).
    - Groups: "Housing" (Rent €1,100.00, Utilities €180.00), "Transport" (Fuel €120.00, Public Transport €60.00), "Food" (Groceries €400.00, Dining Out €90.00), Savings group "Savings" with jar-backed line "Emergency Fund" €250.00.
    - Hero: "Remaining to budget" = **€800.00** (3,000.00 − 2,200.00 planned), footnote "€800.00 still to assign" — deliberately positive, never the balanced badge.
  - `/jars` shows a real "Emergency Fund" jar (the savings line's `SavingsId` is an enforced FK to `Jars`).
- **Automated:** Yes (client/e2e-journey/register.spec.ts — sample opt-in leg; tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs — HouseholdBootstrap_WithSampleOptIn_SeedsSavingsGroupBackedByAJar)

### REG-008 - Sample checkbox defaults to unticked and is the only thing that flips the payload
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #170 — sample figures made strictly opt-in; unasked-for pre-filled figures read as real data
- **Preconditions:** Anonymous browser on `/login?register=1`.
- **Steps:**
  1. Open the registration form fresh — verify the sample checkbox starts unticked.
  2. Register without touching it; capture the `POST /api/auth/register` body.
  3. In a second registration, tick it; capture the body.
- **Expected:**
  - Step 1: unchecked by default on every fresh load (no persistence of a previous choice).
  - Step 2: body has `includeSampleData: false` → account has zero budget months.
  - Step 3: body has `includeSampleData: true` → seeded month per REG-007. The checkbox is never required — the form submits either way.
- **Automated:** Yes (client/src/pages/LoginPage.test.tsx — includeSampleData sent only when the box is ticked; tests/AllotJar.Application.Tests/Application/HouseholdBootstrapTests.cs — no-sample bootstrap creates no budget)

### REG-009 - Blank first month prompts for income, never the gold balanced badge
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #172 — empty month is NOT balanced; `IsBalanced` requires `TotalIncome > 0`
- **Preconditions:** Freshly registered default (empty) account from REG-006, sitting on the create-month hero.
- **Steps:**
  1. Click "Start a blank budget".
  2. Inspect the hero.
- **Expected:**
  - A month is created containing only the "Income" group with no planned amounts.
  - Hero shows "Remaining to budget" €0.00, Income €0.00, Allotted €0.00, and the footnote pill "Plan your income, then give every euro a job".
  - The gold badge "Every euro has a job" is **absent** — a 0/0 month must never celebrate as balanced.
- **Automated:** Yes (client/src/pages/DashboardPage.test.tsx — empty month prompts for income instead of celebrating; tests/AllotJar.Application.Tests/Domain/RemainingToBudgetTests.cs — IsBalanced_RequiresIncome_NotJustZeroRemaining; client/e2e-journey/register.spec.ts — start-blank leg)

### REG-010 - Registering across the UTC month boundary seeds the sample into the UTC month
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Browser in a timezone ahead of UTC (e.g. UTC+2); local clock just past midnight on the 1st while UTC is still the 31st of the previous month (or simulate by adjusting the server clock).
- **Steps:**
  1. Register with the sample checkbox ticked.
  2. Note which month the dashboard opens on and where the seeded figures are.
- **Expected:**
  - The sample month is created for the **UTC** current month (`HouseholdBootstrap` receives `DateTime.UtcNow`); the dashboard opens on the browser-local current month. When these differ the user lands on "No budget for {local month} yet." with their sample data one month back — verify the data is reachable via month navigation and nothing is lost. Flag as UX seam if observed (opted-in user should land on their sample figures).
- **Automated:** No

## Create account — required fields & client-side validation

### REG-011 - Every required field blocks submission when empty
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login?register=1`.
- **Steps:**
  1. Click "Create account" with the whole form empty.
  2. Fill fields one at a time (First name → Last name → Email → Password), attempting submit after each, until only the checkboxes remain.
- **Expected:**
  - Each attempt is blocked client-side by native HTML5 validation (the browser focuses/flags the first invalid control: `required` on First name, Last name, Email, Password; then the required terms checkbox, then the required staging checkbox).
  - **No** `POST /api/auth/register` request is sent for any blocked attempt.
- **Automated:** No

### REG-012 - Email format validation (client lenient-server boundary)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login?register=1`; all other fields valid.
- **Steps:**
  1. Try email `notanemail` → submit.
  2. Try `user@` → submit.
  3. Try ` spaced@example.test ` (leading/trailing spaces) → submit.
  4. Try `a@b` → submit.
- **Expected:**
  - Steps 1–3: blocked client-side by `type=email` validation; no request sent.
  - Step 4: `a@b` passes both HTML5 and the server's `[EmailAddress]` annotation (both are deliberately lenient — one `@` with content either side) and the account is created. Document, don't fail: minimal-but-parseable addresses are accepted by design.
- **Automated:** No

### REG-013 - Password shorter than 8 characters is blocked
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Anonymous browser on `/login?register=1`; all other fields valid.
- **Steps:**
  1. Enter a 7-character password `Aa1-xyz` and submit.
  2. Direct API: `POST /api/auth/register` with `"password": "Aa1-xyz"` and otherwise-valid body.
- **Expected:**
  - Step 1: blocked client-side by `minLength=8` (browser message; no request).
  - Step 2: 400 in the ASP.NET **ValidationProblemDetails** shape (`{"errors":{"Password":[…]}}` — `[MinLength(8)]` fires at model binding, a different body shape from the app's `{error:…}`). No account created.
- **Automated:** No

### REG-014 - Terms consent is required (client checkbox + server enforcement)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login?register=1`; all fields valid, terms checkbox unticked.
- **Steps:**
  1. Submit the form.
  2. Direct API: `POST /api/auth/register` with `"acceptedTerms": false` and an otherwise-valid body.
- **Expected:**
  - Step 1: blocked client-side (`required` checkbox); no request.
  - Step 2: 400 `{error: "Please accept the terms and privacy policy to create an account."}`; no account created. This is the **first** server-side check — it fires before currency/format/duplicate checks.
- **Automated:** No

### REG-015 - Staging build requires the data-loss acknowledgment (client-side only)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Staging build (`VITE_APP_ENV=staging`); anonymous browser on `/login?register=1`; everything filled and terms ticked, staging checkbox unticked.
- **Steps:**
  1. Submit.
  2. Tick "I understand this is the AllotJar staging … my data may be reset or permanently lost." and submit again.
  3. Inspect the request body of the successful registration.
- **Expected:**
  - Step 1: blocked client-side (required checkbox).
  - Step 2: registration succeeds.
  - Step 3: the staging acknowledgment is **not** part of the request body — it is a client-side-only gate (no `acknowledgesDataLoss`-style server field on `RegisterRequest`).
- **Automated:** Yes (client/src/pages/LoginPage.test.tsx — staging build adds a required data-loss acknowledgment)

### REG-016 - GA/default build renders neither staging banner nor staging checkbox
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Default (non-staging) build — `VITE_APP_ENV` unset; anonymous browser on `/login?register=1`.
- **Steps:**
  1. Inspect the page and the registration form.
  2. Register with only the terms checkbox ticked.
- **Expected:**
  - No staging banner above the page; no amber data-loss checkbox in the form; registration succeeds with terms alone. Everything else (fields, sample checkbox, validation) is identical to the staging build.
- **Automated:** Partial (client/src/components/StagingBanner.test.tsx — banner renders nothing outside staging; the checkbox absence in default build is untested)

### REG-017 - Server error bodies render in the form's alert
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login?register=1`; a way to force each failure (duplicate email for `{error}`, weak password composition for `{errors:[…]}`, network offline for the fallback).
- **Steps:**
  1. Register with `owner@example.com` (existing) → observe the alert.
  2. Register with password `aaaaaaaa1` (no uppercase; fresh email) → observe the alert.
  3. Go offline and submit → observe the alert.
- **Expected:**
  - Step 1: the one red `role="alert"` line directly above the submit, its own text the exact server string ("An account with that email already exists.").
  - Step 2: the Identity error descriptions joined with spaces (the client renders `data.errors.join(' ')` for the array shape).
  - Step 3: "Something went wrong." (network/unexpected fallback). The form stays filled; the user can correct and resubmit.
- **Automated:** Full (client `LoginPage.catalog.test.tsx` REG-017/REG-023, REG-017/REG-019, REG-017/REG-047; `LoginPage.frame.test.tsx` — one alert, above the submit)

## Create account — password policy & HIBP

### REG-018 - Breached password is rejected with the HIBP message
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login?register=1`; all fields valid; live outbound access to api.pwnedpasswords.com.
- **Steps:**
  1. Use password `Password1!` (known-breached, passes length/composition) and submit.
- **Expected:**
  - 400; alert shows "This password has appeared in a known data breach. Please choose a different one."
  - No account is created; correcting to a random `Aa1-<uuid>` password succeeds. (HIBP check uses k-anonymity — only a 5-char SHA-1 prefix leaves the server — and **never** runs at sign-in.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BreachedPasswordValidatorTests.cs — validator unit only; the register round-trip was verified manually on prod at PR #81)

### REG-019 - Identity composition rules: digit, lowercase, uppercase each enforced
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login?register=1`; fresh email per attempt.
- **Steps:**
  1. Submit with password `Abcdefgh-` (no digit).
  2. Submit with `ABCDEFG1-` (no lowercase).
  3. Submit with `abcdefg1-` (no uppercase).
- **Expected:**
  - Each returns 400 `{errors:[…]}` with the matching Identity default message, rendered in the alert: "Passwords must have at least one digit ('0'-'9').", "…at least one lowercase ('a'-'z').", "…at least one uppercase ('A'-'Z')." (RequireNonAlphanumeric is OFF — no special character required.) Multiple violations list every message joined with spaces.
- **Automated:** No (policy is configuration; only the HIBP validator has unit tests)

### REG-020 - Exactly-8-character compliant password is accepted
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Anonymous browser on `/login?register=1`; fresh email.
- **Steps:**
  1. Register with an 8-character password containing digit+upper+lower and not breached (e.g. `Xq7pLm2v` — verify it against HIBP first or generate randomly).
- **Expected:**
  - Registration succeeds (8 is the inclusive minimum); immediate sign-in works; signing out and back in with the same password works.
- **Automated:** No (journey passwords are always longer than 8)

### REG-021 - Very long and unicode passwords are handled gracefully
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Anonymous browser on `/login?register=1`; fresh email per attempt.
- **Steps:**
  1. Register with a 200-character random password (contains digit+upper+lower).
  2. Register (fresh email) with a unicode password `Pässw0rd-jär-€₺-Aa1` and sign out/in with it.
- **Expected:**
  - Both are accepted (no maximum length or ASCII restriction in the policy) or rejected with a clear 400 — never a 500 or a truncated/corrupted store. Signing back in with the exact same string must succeed (round-trip integrity, incl. unicode normalization — the same bytes typed again must match).
- **Automated:** No

### REG-022 - HIBP outage fails open — registration still completes
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Test environment where api.pwnedpasswords.com is unreachable (block the host / point DNS at a black hole); anonymous browser.
- **Steps:**
  1. Register with a valid random password.
- **Expected:**
  - Registration succeeds after at most the validator's 5s HTTP timeout (breach screening fails OPEN by design — an HIBP outage must never block sign-ups). No error surfaces to the user.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BreachedPasswordValidatorTests.cs — fails open when the HIBP API is unreachable or non-success)

## Create account — email rules & duplicates

### REG-023 - Duplicate email is rejected with the exact message
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** `owner@example.com` exists; anonymous browser on `/login?register=1`.
- **Steps:**
  1. Register with email `owner@example.com`, everything else valid.
- **Expected:**
  - 400; alert shows "An account with that email already exists." No account/household side effects. (Registration deliberately reveals account existence — accepted trade-off, unlike the sign-in path.)
- **Automated:** No

### REG-024 - Duplicate detection is case-insensitive
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `owner@example.com` exists; anonymous browser.
- **Steps:**
  1. Register with `OWNER@Example.COM`.
- **Expected:**
  - Same 400 "An account with that email already exists." (Identity normalized-email lookup). No second account created.
- **Automated:** No

### REG-025 - Overlong email is rejected gracefully
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Anonymous browser; direct API access (HTML5 may allow long values).
- **Steps:**
  1. `POST /api/auth/register` with a syntactically valid email of 300+ characters (`aaaa…@example.test`) and an otherwise-valid body.
- **Expected:**
  - Rejected with a 4xx and no account row (Identity's `AspNetUsers.Email/UserName` columns are nvarchar(256)) — never a 500/DbUpdateException leaking to the client. Whatever the exact message, the response must use one of the JSON error shapes.
- **Automated:** No

### REG-026 - Unicode/IDN email addresses
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Anonymous browser on `/login?register=1`.
- **Steps:**
  1. Try `alex@bücher.example` in the email field and submit.
  2. Direct API: same address.
- **Expected:**
  - Step 1: blocked client-side (browsers reject non-ASCII domains in `type=email` unless punycoded).
  - Step 2: server responds 4xx or accepts consistently — document the behavior; whichever way, the subsequent sign-in with the identical string must behave the same (no register-accepts/login-rejects asymmetry).
- **Automated:** No

## Create account — name boundaries

### REG-027 - Whitespace-only names must not silently fail
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login?register=1`; First name = three spaces, Last name = three spaces, everything else valid.
- **Steps:**
  1. Submit (HTML5 `required` passes — spaces count as content; the client then trims both names to `""` before sending).
  2. Observe the network response and the form.
- **Expected:**
  - Server returns 400 (`[Required]` fails on the empty strings) in the ValidationProblemDetails shape. The form must surface a visible error and stay usable — **known gap to verify:** `LoginPage` only parses `{error}` / `{errors:[…]}`; the ValidationProblemDetails `errors` *object* shape can produce no message (or a console TypeError from `errors.join`). The user must never be left with a re-enabled button and no explanation, and no account may be created.
- **Automated:** No

### REG-028 - Unicode and accented names compose the display name correctly
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Anonymous browser on `/login?register=1`.
- **Steps:**
  1. Register with First name `José-María`, Last name `Żółć 🌱`.
  2. After landing, open the account menu and `/account`.
- **Expected:**
  - Registration succeeds. Account menu chip and the `/account` profile's name heading show `José-María Żółć 🌱` (DisplayName = `"{First} {Last}".Trim()`), rendered without mojibake.
- **Automated:** No

### REG-029 - Very long names don't break registration or the shell
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Anonymous browser on `/login?register=1`; First and Last name of 250 characters each.
- **Steps:**
  1. Register.
  2. Inspect the account-menu chip and `/account`.
- **Expected:**
  - Accepted (no explicit max) or clean 400 — never a 500. If accepted, the shell truncates/wraps the chip without breaking layout, and the full name round-trips on `/account`.
- **Automated:** No

## Currency & number-format pickers

### REG-030 - Picker option lists are exactly the curated sets
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous browser on `/login?register=1`.
- **Steps:**
  1. Open the "Currency" select and read every option.
  2. Open the "Number format" select and read every option.
- **Expected:**
  - Currency: exactly 24 options, EUR first, labels like "Euro (€)", "British pound (£)", "US dollar ($)", "Swiss franc (CHF)", … "Turkish lira (₺)" (full list per `CURRENCY_OPTIONS` in client/src/lib/money.ts).
  - Number format: exactly 5 options labeled `1,234.56`, `1.234,56`, `1 234,56`, `1'234.56`, `1,23,456.78`.
- **Automated:** No

### REG-031 - Browser locale preselects currency and number format
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous browsers pinned to specific locales (e.g. Playwright `locale`).
- **Steps:**
  1. Load `/login?register=1` under `en-US`; read the two selects and the line in the green room (the band on a phone).
  2. Repeat under `en-IN`, `de-CH`, `de-DE`, and `pt-PT`.
- **Expected:**
  - `en-US`: USD + `1,234.56`. The line reads "Give every euro a job." (the money word in gold) under every locale — restyle PR 16: the frame's line is euro always, never the locale's noun ("dollar", "pound", "franc", "rupee" never appear in the room).
  - `en-IN`: INR + `1,23,456.78` (lakh). `de-CH`: CHF + `1'234.56`. `de-DE`: EUR + `1.234,56`. The line still "…every euro…".
  - `pt-PT` (region not in the map): falls back to EUR; number format inferred from the locale's separators (comma decimal + space grouping → `1 234,56`).
  - Both selects remain fully user-overridable; the preselect is computed once on mount.
- **Automated:** Partial (client `LoginPage.catalog.test.tsx` REG-031 — en-GB, de-DE and en-US: the selects, and the line reads euro under each; `AuthPages.frame.test.tsx` — euro on the forgot, reset and accept-invite pages under en-GB, en-US and de-CH; client/src/lib/money.test.ts — detectLocaleDefaults + currencyNoun)

### REG-032 - Chosen currency and format actually govern the app after sign-up
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Anonymous browser (en-GB locale) on `/login?register=1`.
- **Steps:**
  1. Register with Currency = "Polish złoty (zł)" and Number format = "1.234,56", sample figures **ticked**.
  2. Inspect the dashboard hero and the account menu.
  3. Open `/account` → Preferences (under the profile in the "Your account" card).
- **Expected:**
  - Money renders in PLN with dot-comma grouping app-wide (hero "Remaining to budget" shows the seeded 800 as `800,00 zł`-style per the PLN formatter with de-DE grouping).
  - Account-menu chip shows "PLN · Your household" (the budget currency). `/account` Preferences preselects "Polish złoty (zł)" and "1.234,56" while the budget is still empty; once it holds an account, month or transaction the currency shows read-only with a lock, and its (i) "About the lock" reads "Your budget currency is fixed once your budget has accounts, months or transactions. …" (PREF-011), and every month is created in PLN.
  - The signed-out pages' line on later visits aside (it follows the browser locale, REG-031), the in-app "give every złoty a job" surfaces use the noun "złoty".
- **Automated:** Partial (client/src/pages/LoginPage.test.tsx — registration submits the chosen prefs; client/src/lib/money.test.ts — formats render; the end-to-end render isn't tested)

### REG-033 - Invalid currency code is rejected server-side
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Direct API access (the UI select can't produce these).
- **Steps:**
  1. `POST /api/auth/register` with `"preferredCurrency": "EU"` (2 letters), otherwise valid.
  2. Repeat with `"preferredCurrency": "12A"`.
- **Expected:**
  - Both → 400 `{error: "That isn't a valid ISO 4217 currency code."}`; no account created. (Validation = trim + uppercase + regex `^[A-Z]{3}$` only.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Infrastructure/UserPreferencesTests.cs + Domain/CurrencyCodeTests.cs — normalization units; the endpoint path is untested)

### REG-034 - Any three-letter code passes; blank falls back to EUR
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Direct API access.
- **Steps:**
  1. Register with `"preferredCurrency": "XXX"`.
  2. Register (fresh email) with `"preferredCurrency": ""`.
  3. Register (fresh email) with `"preferredCurrency": " eur "` (padded lowercase).
- **Expected:**
  - Step 1: accepted **by design** (regex-only, no ISO table lookup); the app then renders XXX via the generic formatter and `currencyNoun` falls back to "unit".
  - Step 2: accepted, currency defaults to EUR.
  - Step 3: accepted, normalized to `EUR`.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Infrastructure/UserPreferencesTests.cs — blank default + canonicalization)

### REG-035 - Invalid number format is rejected; blank defaults to comma-dot
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Direct API access.
- **Steps:**
  1. `POST /api/auth/register` with `"numberFormat": "euro-style"`.
  2. Register (fresh email) with `"numberFormat": ""`.
- **Expected:**
  - Step 1: 400 `{error: "That number format isn't supported."}` (allowed keys: `comma-dot`, `dot-comma`, `space-comma`, `apostrophe`, `lakh`).
  - Step 2: accepted; format defaults to `comma-dot` (renders `1,234.56`).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Infrastructure/UserPreferencesTests.cs — NormalizeNumberFormat units)

## Sign-in

### REG-036 - Valid credentials sign in and land on the dashboard
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** `owner@example.com` exists with a budget month; anonymous browser on `/login`.
- **Steps:**
  1. Enter "Email" = `owner@example.com`, "Password" = `Sunlit-Meadow-42a`; click "Sign in".
  2. Inspect localStorage and the URL history.
- **Expected:**
  - Navigated to `/` with `replace: true` (Back does not return to `/login`); DashboardPage renders the user's month.
  - localStorage holds only identity *hints* (`zbb.email`, `zbb.displayName`, `zbb.currency`, `zbb.budgetCurrency`, `zbb.numberFormat`, `zbb.role`) — **never** the access token (in-memory only; refresh token is the HttpOnly `zbb_rt` cookie, invisible to JS). Session persistence itself is file 03.
- **Automated:** Yes (client/e2e-journey/session-expiry.spec.ts + helpers sign in against the real backend; client/src/pages/LoginPage.test.tsx — sign-in submit)

### REG-037 - Wrong password shows the generic credential error
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** `owner@example.com` exists; anonymous browser on `/login`.
- **Steps:**
  1. Sign in with the right email and password `WrongPass1x`.
- **Expected:**
  - 401; the one `role="alert"` line directly above the submit reads exactly "Invalid email or password." The user stays on the form with fields intact; no cookie is set; correcting the password immediately succeeds.
  - Keyboard: when the attempt was sent from the focused "Sign in" button (disabled while busy), focus is back on that button once the error shows, so Shift+Tab reaches Password; when it was sent with Enter in a field, focus stays in that field.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/LoginTests.cs — invalid credentials never issue a token; client `LoginPage.catalog.test.tsx` REG-037/REG-038; `LoginPage.frame.test.tsx` — the alert's place and where focus lands; client/e2e/keyboard-a11y.spec.ts — "login: after a failed sign-in from the submit button, focus is back on the button")

### REG-038 - Unknown email returns the identical error (anti-enumeration)
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login`; email `nobody-here@example.test` has no account.
- **Steps:**
  1. Sign in with the unknown email and any ≥8-char password.
  2. Compare the response (status, body, and roughly the latency) against REG-037's wrong-password attempt.
- **Expected:**
  - Same 401 with byte-identical body `{error: "Invalid email or password."}` — the response must never distinguish unknown-email from wrong-password. Latency is deliberately equalized (dummy PBKDF2 verify on the unknown-email path); no gross timing tell (order-of-magnitude).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/LoginTests.cs — identical Invalid outcome; timing equalization untested)

### REG-039 - Sign-in email is case-insensitive
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `owner@example.com` exists; anonymous browser.
- **Steps:**
  1. Sign in as `OWNER@EXAMPLE.COM` with the correct password.
- **Expected:**
  - Success — same account (normalized-email lookup). The account menu shows the canonical stored casing.
- **Automated:** No

### REG-040 - Sign-in client-side validation mirrors the field constraints
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Anonymous browser on `/login`.
- **Steps:**
  1. Submit with both fields empty.
  2. Submit with a valid email and a 5-character password.
- **Expected:**
  - Both blocked by HTML5 (`required`; `minLength=8` applies in sign-in mode too — safe because the policy has always required ≥8). No network request either time.
- **Automated:** No

### REG-041 - returnUrl is honored on sign-in; unsafe values are discarded
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `owner@example.com` exists; anonymous browser.
- **Steps:**
  1. Load `/login?returnUrl=%2Ftransactions` and sign in.
  2. Sign out. Load `/login?returnUrl=https%3A%2F%2Fevil.example` and sign in.
  3. Sign out. Load `/login?returnUrl=%2F%2Fevil.example` (scheme-relative) and sign in.
  4. Sign out. Load `/login?returnUrl=%2F%09%2Fevil.example` (control character) and sign in.
- **Expected:**
  - Step 1: lands on `/transactions`.
  - Steps 2–4: `safeInternalPath` rejects absolute URLs, `//…`/`/\…`, and any 0x00–0x1F/0x7F control character → lands on `/`. The app never navigates off-origin from a returnUrl.
- **Automated:** Yes (client/src/pages/LoginPage.test.tsx — returns to safe internal returnUrl; client/src/lib/returnUrl.test.ts — rejection table incl. control-char smuggling)

### REG-042 - Already-authenticated visitor to /login is bounced into the app
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `owner@example.com` signed in with a live session.
- **Steps:**
  1. Manually navigate to `/login`.
  2. Manually navigate to `/login?returnUrl=%2Freports`.
- **Expected:**
  - Step 1: `AuthedLoginRedirect` sends the user to `/` — the login form never renders for an authenticated session (a brief splash while bootstrapping is allowed).
  2. Step 2: redirected to `/reports` (sanitized returnUrl honored even on the authed path).
- **Automated:** No

### REG-043 - Expired-session notice renders only in sign-in mode
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #169 — genuinely dead sessions bounce to `/login?reason=expired` with an explanation instead of an unexplained sign-out
- **Preconditions:** Anonymous browser.
- **Steps:**
  1. Load `/login?reason=expired&returnUrl=%2Ftransactions`; hover or focus the (i) beside the notice.
  2. Click "Create account" in the switch.
  3. Click "Sign in".
- **Expected:**
  - Step 1: at the top of the card, above the switch, one quiet line in the warning colour with a clock icon (`role="status"`, no box) reading "Your session has expired."; beside it an (i) **Why you were signed out** whose tooltip reads "Your session has expired, so we signed you out to keep your budget safe. Sign back in to pick up where you left off." On a 390×844 phone the switch, both fields and the submit still fit the first screen.
  - Step 2: the notice disappears in Create-account mode (it explains a sign-*in* situation only).
  - Step 3: the notice returns. Signing in then lands on `/transactions` (the sign-in leg of the returnUrl round-trip; the bounce *production* is file 03).
- **Automated:** Full (client `LoginPage.catalog.test.tsx` REG-043 ×2; `LoginPage.frame.test.tsx` — the line, its place and its (i); client/e2e-journey/session-expiry.spec.ts — notice text + returnUrl round-trip; client/e2e/mobile-layout.spec.ts — fits a phone's first screen; client/e2e/a11y.spec.ts — axe with the (i) open)

## Lockout & rate limiting

### REG-044 - Five consecutive failures lock the account for 15 minutes
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Dedicated login `lockme@example.test` (so `owner@` stays usable); anonymous browser on `/login`.
- **Steps:**
  1. Attempt sign-in with a wrong password 4 times — each shows "Invalid email or password."
  2. Attempt a 5th wrong password.
  3. Immediately attempt with the **correct** password.
  4. Wait 15+ minutes, retry the correct password.
- **Expected:**
  - Step 2: 401 with "Your account is temporarily locked after too many failed sign-in attempts. Please try again in a few minutes." (the threshold-crossing failure itself returns the locked message).
  - Step 3: still the locked message — correct credentials are refused while locked, and no token/cookie is issued.
  - Step 4: sign-in succeeds; failure counter is reset.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/LoginTests.cs — locked-out never issues a token; the 5-failure HTTP flow and 15-min expiry are untested)

### REG-045 - A successful sign-in resets the failure counter
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Fresh login `counter@example.test`; anonymous browser.
- **Steps:**
  1. Fail sign-in 4 times.
  2. Sign in successfully; sign out.
  3. Fail sign-in 4 more times, then sign in correctly.
- **Expected:**
  - No lockout at any point — the counter counts *consecutive* failures and step 2 reset it; step 3's 4 failures stay below the threshold and the final correct attempt succeeds.
- **Automated:** No

### REG-046 - Lockout is per-account, not per-browser or per-IP
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `lockme@example.test` currently locked (from REG-044); `owner@example.com` healthy; same browser/IP.
- **Steps:**
  1. While `lockme@` is locked, sign in as `owner@example.com` with correct credentials from the same browser.
- **Expected:**
  - `owner@` signs in normally — the Identity lockout binds to the account, and it is the real brute-force defence (the per-visitor rate limiter is only a coarse flood cap).
- **Automated:** No

### REG-047 - Auth rate limiter returns 429 after 20 requests per minute
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Environment where your client IP reaches the API directly (local/dev — behind the Cloudflare proxy the bucket is shared site-wide); default `RateLimiting:AuthPermitLimit` = 20.
- **Steps:**
  1. Script 21 `POST /api/auth/login` attempts (any body) within one minute from one source IP.
  2. Trigger the same via the UI (rapid sign-in attempts) and observe the form.
- **Expected:**
  - Request 21 gets HTTP 429 with an empty body (fixed window, queue 0). Register/refresh/logout/accept-invite/change-password share the same `auth` policy.
  - The UI surfaces the empty-body failure as "Something went wrong." — not a crash. After the window rolls over, requests succeed again. (E2E runs raise `RateLimiting__AuthPermitLimit` to avoid tripping this — expect it live.)
- **Automated:** No

## First-login landing state & analytics

### REG-048 - Registration records consent up front — no ConsentModal on first login
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Freshly registered account (either sample path).
- **Steps:**
  1. Complete registration and observe the first authenticated render.
  2. Sign out, sign back in, observe again.
- **Expected:**
  - The blocking ConsentModal ("Accept the terms") never appears — `Register` sets `ConsentedUtc` at creation, so `needsConsent` is false. (The modal exists for owner-created/legacy logins — households & people file.) The onboarding welcome dialog *may* appear instead (routing & app shell file).
- **Automated:** Partial (client/src/components/ConsentModal.test.tsx — hidden for consented logins; the register-sets-consent linkage is untested)

### REG-049 - A brand-new registrant is a solo Owner with the matching shell state
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Freshly registered default (empty) account.
- **Steps:**
  1. Open the account menu (aria-label "Account menu").
  2. Inspect the nav.
  3. Open `/account`.
- **Expected:**
  - Chip shows the display name and "{budget currency} · Your household"; no household-switcher section (single household); menu offers "Account settings" and "Sign out".
  - Nav: "People" is visible (always — project invariant); "Allocation" is hidden (solo household of 1 member — the owner is member #1, never a 0-member household).
  - `/account`: the access level chip reads "Owner"; the Household card's sharing row reads the solo variant ("Just you", with "You're budgeting on your own. …" behind its (i), and "Share this budget"); no Household ⋯ (no "Leave household").
- **Automated:** Partial (client/src/components/AppNav.test.tsx — People always/Allocation solo-hidden; client/src/pages/AccountPage.test.tsx — the solo sharing row; client/src/components/HouseholdSwitcher.test.tsx — hidden for single household; not exercised as one post-registration flow)

### REG-050 - Analytics events fire with whitelisted params only
- **Priority:** P3
- **Type:** Regression
- **Origin:** PR #170 gotcha — GA params are whitelisted; `sample_data` had to be added to `ALLOWED_PARAM_KEYS` or it is silently dropped
- **Preconditions:** Staging host with analytics consent **granted** (consent banner accepted — see 01-landing-public.md); GA debug view or network inspection of `google-analytics.com/g/collect`.
- **Steps:**
  1. Register a fresh account with the sample checkbox ticked.
  2. Sign out; sign in with wrong credentials once, then correctly.
- **Expected:**
  - Step 1: one `sign_up` event with `method: "password"` **and** `sample_data: true` (both params present — `sample_data` must not be silently dropped by the redactor).
  - Step 2: one `login_failed {method:"password"}` then one `login {method:"password"}`. No email, name, or other PII in any event payload.
- **Automated:** Partial (client/src/analytics/analytics.test.ts — whitelist forwarding incl. sample_data; the LoginPage → track() wiring is untested)


## Password reset (forgot / reset)

### REG-051 - "Forgot password?" link shows in sign-in mode only
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous browser on `/login` (sign-in mode).
- **Steps:**
  1. Inspect the password field's label row; follow the "Forgot password?" link.
  2. Go back; switch to "Create account"; look again.
- **Expected:**
  - Sign-in mode: a "Forgot password?" link beside the Password label → `/forgot-password`.
  - Register mode: no such link (a brand-new visitor has nothing to reset).
- **Automated:** Full (client/src/pages/LoginPage.catalog.test.tsx — REG-051)

### REG-052 - Forgot-password page requests a link with a non-enumerating confirmation
- **Priority:** P1
- **Type:** Security
- **Preconditions:** Anonymous browser on `/forgot-password`.
- **Steps:**
  1. Submit a registered email; note the exact confirmation copy.
  2. Fresh page: submit an email that has no account; compare.
  3. Fresh page: submit while the API is unreachable.
  4. Fresh page: submit `not-an-email`.
- **Expected:**
  - The page: the same frame as `/login` without the switch. The card opens with its title (the page's h1) "Reset your password" and an (i) **About resetting** beside it holding "Enter your account's email address and we'll send you a link to choose a new password."; then "Email", the submit "Email me a reset link", and "Back to sign in" at the card's foot.
  - Steps 1–2: IDENTICAL confirmation (`role="status"`) in place of the form: the title "Check your inbox" (h1; it takes focus, and the next Tab reaches its (i)) with an (i) **If nothing arrives** holding the spam-folder hint ("No email after a few minutes? Check your spam folder, or try again."), and the visible sentence "If an account exists for {email}, we've emailed it a link to choose a new password. The link is valid for 2 hours." The form is gone (no resubmit loop); "Back to sign in" stays at the card's foot → `/login`. `password_reset_requested` fires.
  - Step 3: generic retryable error as the one alert line above the submit ("We couldn't send the email just now…"), still on the form, no analytics event; sent from the focused button, focus is back on it. The error must not reveal whether the account exists.
  - Step 4: blocked client-side (`type=email` + `required`) — no POST.
- **Automated:** Full (client/src/pages/ForgotPasswordPage.catalog.test.tsx — REG-052 ×3; `AuthPages.frame.test.tsx` — the title and its (i), the sent state's (i), focus, Back to sign in in the card; client/e2e/keyboard-a11y.spec.ts — "Check your inbox" takes focus)

### REG-053 - Server: forgot-password is always 204 and only real accounts get mail
- **Priority:** P1
- **Type:** Security
- **Preconditions:** Direct API access; Development mailbox (setup note g).
- **Steps:**
  1. `POST /api/auth/forgot-password` with a registered email; read the mailbox (`GET /api/dev/emails`).
  2. Same with an unknown email; read the mailbox.
- **Expected:**
  - Both answer **204 No Content** in the same shape/path AND the same TIME (no enumeration oracle by status, body, or latency). Only the registered address has a captured email. The lookup + send run OFF the request path (`DispatchResetEmail`), so the 204 is unconditional — a provider/send failure can never turn into a 500 for existing accounts (which would itself be an oracle); the failure is logged in the background. The Development mailbox endpoint's serialized JSON shape (`subject`/`textBody`) is pinned so the journey specs' contract is gated.
- **Automated:** Full (tests/AllotJar.IntegrationTests/Http/PasswordResetFlowTests.cs — REG-053 async-mailbox capture, unknown-email empty, mailbox JSON shape; send-failure-still-204 is now structural — the send is never awaited)

### REG-054 - The reset email carries the link in both bodies and states the lifetime
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** A captured reset email (setup note g).
- **Steps:**
  1. Inspect subject, text body and HTML body.
- **Expected:**
  - Subject mentions the password reset; the SAME `/reset-password?email=…&token=…` link appears raw in the text body and HTML-encoded in the HTML body (button + copyable fallback); the 2-hour validity and the "if you didn't request this, ignore" note are present. No external images/trackers.
  - Branded layout (`EmailLayout`): AllotJar text wordmark + gold lid bar on a card, hidden preheader, and a footer stating why the recipient got the email — still with zero external requests (the reset link remains the only URL; the footer domain is schemeless; HTML5 doctype, no xmlns, no `<link>`/`@import`/`url(`/webfonts). The text body keeps the reset link as the single http-starting line (the link-extraction contract for integration + journey suites) and gains a schemeless "Why did I get this?" line.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-054 + branding sibling; EmailLayoutTests pin the shared chrome)

### REG-055 - The Resend adapter posts the provider shape; a rejection throws (and is logged)
- **Priority:** P3
- **Type:** Contract
- **Preconditions:** Unit level (stubbed HTTP handler).
- **Steps:**
  1. Send a message through `ResendEmailSender`; capture the HTTP request.
  2. Make the stub answer 422.
- **Expected:**
  - One `POST https://api.resend.com/emails` with JSON `from/to/subject/text/html` and the configured From address. A non-2xx throws `HttpRequestException` — which the controller catches, logs, and still answers 204 (REG-053).
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-055)

### REG-068 - The Cloudflare Email Service adapter posts the account-scoped provider shape
- **Priority:** P3
- **Type:** Contract
- **Preconditions:** Unit level (stubbed HTTP handler); `Email:Provider=cloudflare`, `AccountId=acct-123`.
- **Steps:**
  1. Send a message with a display-name `FromAddress` ("AllotJar <no-reply@allotjar.com>"); capture the HTTP request.
  2. Repeat with a bare `FromAddress` ("no-reply@allotjar.com").
- **Expected:**
  - One `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/email/sending/send` with JSON `to` (string), `subject`, `text`, `html` (values, not just keys).
  - **`from` must NOT be the RFC5322 `Name <addr>` string** Resend accepts — Cloudflare rejects that as an invalid request schema, and since sends are off-request/best-effort the rejection is SILENT (user still gets 204, no email ever arrives). Step 1 ⇒ `"from":{"address":"no-reply@allotjar.com","name":"AllotJar"}` (REST key is `address`; the Workers binding uses `email`). Step 2 ⇒ the bare string, with no `name`.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-068 ×2)

### REG-069 - A Cloudflare 200 that reports `success: false` is treated as a failure
- **Priority:** P2
- **Type:** Negative
- **Origin:** Cloudflare's `client/v4` API answers HTTP 200 with `{"success": false, "errors":[…]}` for a rejected send — a status-code-only check would swallow it.
- **Preconditions:** Unit level (stubbed HTTP handler).
- **Steps:**
  1. Stub a 200 whose body is `{"success":false,…}`; send.
  2. Stub a non-2xx; send.
  3. Stub a 200 whose body carries no `success` field (or isn't JSON); send.
- **Expected:**
  - 1 and 2 throw `HttpRequestException` (logged; the controller's dispatch is off-request so the caller still sees 204 — REG-053).
  - 3 does NOT throw — a healthy send must not be turned into a false alarm by a terse body.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-069 ×2)

### REG-070 - The configured provider resolves to the right sender at startup
- **Priority:** P2
- **Type:** Contract
- **Origin:** The provider is chosen ONCE at startup; a config typo silently degrades password reset to log-only instead of failing loudly.
- **Preconditions:** The real `AddInfrastructure` container over an in-memory `Email` configuration.
- **Steps:**
  1. Resolve `IEmailSender` for each config combination (no key; key with no provider; resend; cloudflare with/without AccountId; unknown provider name; provider with no key).
  2. For the resolved sender, inspect the typed `HttpClient` the container configured.
  3. Ask each configuration to describe its own misconfiguration.
- **Expected:**
  - No key → `LoggingEmailSender`. Key with **no** provider → `ResendEmailSender` (back-compat with pre-switch configs). `resend` → `ResendEmailSender`. `cloudflare` **with** AccountId → `CloudflareEmailSender`; **without** one (or blank) → `LoggingEmailSender`. Unknown provider name → `LoggingEmailSender`. Provider names are case/whitespace tolerant.
  - Step 2: base address `https://api.cloudflare.com/` or `https://api.resend.com/` per provider, `Authorization: Bearer <ApiKey>`, 10s timeout — a wrong base URL or missing header would otherwise ship silently (every send fails at the provider, off-request, unseen).
  - Step 3: each failure mode names ITSELF (missing `Email:ApiKey` / missing `Email:AccountId` / unrecognised provider), because "set Email:ApiKey" is misleading for the two modes that already have one. A complete config describes no problem.
- **Automated:** Full (EmailProviderSelectionTests — REG-070: 10 selection cases + 2 HttpClient cases + 6 remediation-text cases)

### REG-071 - Startup states which email provider resolved
- **Priority:** P2
- **Type:** Ops
- **Origin:** A misconfigured provider degrades to log-only instead of failing loudly, so "is email live?" was previously only answerable by sending a test email and waiting.
- **Preconditions:** Production-like host (IIS/ANCM), API restarted.
- **Steps:**
  1. Restart the API and read the startup log.
- **Expected:**
  - Either `Outbound email provider: CloudflareEmailSender` / `ResendEmailSender`, or `Outbound email is NOT configured … : <reason>` naming the specific problem.
  - Both are logged at **Warning** deliberately: on the production host the Console provider writes to ANCM stdout (disabled by default, and the deploy re-mirrors the folder) and the EventLog provider filters below Warning, so an Information line would have no reachable sink and this check would be unfollowable.
- **Automated:** None — log emission on a real IIS host is out of reach of the suites (the *content* of the reason string is covered by REG-070 step 3). Verify manually per `docs/deployment/staging-prod.md` step 5.

### REG-072 - A malformed Cloudflare account id is flagged at startup, not at send time
- **Priority:** P2
- **Type:** Regression
- **Origin:** Live incident 2026-07-19 — the truncated id `49033e69c8021025…` (ellipsis included) was pasted into production config. It passed every not-empty check, startup reported a healthy `CloudflareEmailSender`, and every send then failed `404 … could not route … perhaps your object identifier is invalid?` — off-request, so the user saw only the normal confirmation and no email.
- **Preconditions:** `Email:Provider=cloudflare` with a key present.
- **Steps:**
  1. Set `AccountId` to each of: the ellipsis paste, a 16-char truncation, 33 chars, 32 chars containing a non-hex letter, a dash-formatted GUID.
  2. Set it to a canonical 32-hex id (and an upper-case/whitespace-padded variant).
  3. With a malformed id, resolve `IEmailSender`.
- **Expected:**
  - 1: each is reported by `DescribeSuspiciousConfiguration()` naming "32 hex characters" and the actual length; startup logs `Outbound email configuration looks wrong: …` **in addition to** the healthy provider line.
  - 2: no complaint (case-insensitive, trimmed).
  - 3: the Cloudflare sender STILL resolves — the check warns, it never disables sending (if Cloudflare changes the id format, an over-strict check must not turn email off).
  - Non-Cloudflare providers, and a missing id, say nothing (absence is `DescribeMisconfiguration`'s job).
- **Automated:** Full (EmailProviderSelectionTests — REG-072, 11 cases)

### REG-056 - A reset token sets the new password
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Unit level (real UserManager, production Identity options).
- **Steps:**
  1. Generate a reset token; redeem it with a fresh strong password.
- **Expected:**
  - Reset succeeds; the old password no longer verifies; the new one does.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-056)

### REG-057 - A reset rotates the security stamp (issued access tokens die)
- **Priority:** P1
- **Type:** Security
- **Preconditions:** As REG-056; over HTTP, a bearer token minted before the reset.
- **Steps:**
  1. Reset the password; compare the security stamp; replay the pre-reset bearer on `GET /auth/me`.
- **Expected:**
  - Stamp differs after the reset; the pre-reset access token is 401 (JWT sstamp check); all refresh tokens are revoked server-side (`RevokeAllForUserAsync`) — presenting the registration-time refresh cookie to `/auth/refresh` after the reset is a 401.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-057 stamp rotation; PasswordResetFlowTests — stale pre-reset BEARER 401 AND stale pre-reset refresh-COOKIE 401)

### REG-058 - A redeemed reset link is single-use
- **Priority:** P1
- **Type:** Security
- **Preconditions:** A link that has just been redeemed successfully.
- **Steps:**
  1. Replay the same token (API and/or the emailed link in a browser).
- **Expected:**
  - Generic invalid-link 400 ("That reset link is invalid or has expired…"); the once-set password stays in force. (The token embeds the pre-reset security stamp.)
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-058; PasswordResetFlowTests replay leg; e2e-journey/password-reset.spec.ts replay spec)

### REG-059 - A token minted for one account is useless against another
- **Priority:** P1
- **Type:** Security
- **Preconditions:** Two accounts; a valid token for one of them.
- **Steps:**
  1. Redeem account B's token against account A; also try a garbage token.
- **Expected:**
  - Both fail `InvalidToken`; account A's password is untouched.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-059)

### REG-060 - The emailed link expires after 2 hours
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Unit level; token lifespan shrunk to zero for determinism (production: 2h via `DataProtectionTokenProviderOptions`, `DependencyInjection.cs`).
- **Steps:**
  1. Generate a token; let it expire; redeem.
  2. Separately, assert the REAL application container's configured lifespan is 2h (guards against the DI registration being dropped, which would silently revert to Identity's 24h default).
- **Expected:**
  - Step 1: `InvalidToken` — surfaced to the user as the same generic invalid-link message (no hint whether the token was expired, tampered or foreign).
  - Step 2: `IOptions<DataProtectionTokenProviderOptions>.Value.TokenLifespan == 2h` resolved from the booted app.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-060 expiry; PasswordResetFlowTests — real-container 2h lifespan)

### REG-061 - A policy-failing new password does not burn the token
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** A valid, unredeemed token.
- **Steps:**
  1. Redeem with a too-short password; then retry the SAME token with a strong one.
- **Expected:**
  - First attempt fails `PasswordTooShort` (the 400 carries the helpful Identity errors — the ONE non-generic reset failure); the retry with the same link succeeds.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-061)

### REG-062 - The new password is screened against HIBP
- **Priority:** P1
- **Type:** Security
- **Preconditions:** As REG-056 (HIBP stubbed to report a breach).
- **Steps:**
  1. Redeem a valid token with a breached password.
- **Expected:**
  - Fails `PwnedPassword` — the same BreachedPasswordValidator as registration/change-password runs on the reset path.
- **Automated:** Full (AuthPasswordResetCoverageTests — REG-062)

### REG-063 - Full journey: forgot → emailed link → reset → signed in, old credentials dead
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Registered account; signed-out browser; Development mailbox.
- **Steps:**
  1. `/login` → "Forgot password?" → submit the email → confirmation.
  2. Open the exact link from the captured email; set a new password (matching confirmation).
  3. Try the old password; then the new one.
- **Expected:**
  - The reset page's card is titled "Choose a new password" (its h1) and, in a visible line under the title, names the account being reset and warns "This signs you out everywhere else." A successful reset signs THIS device straight in (fresh token + `zbb_rt` cookie) and lands on the dashboard; `password_reset_completed` fires. The old password is refused ("Invalid email or password."); the new one signs in.
- **Automated:** Full (e2e-journey/password-reset.spec.ts; PasswordResetFlowTests — REG-063; ResetPasswordPage.catalog.test.tsx client leg; `AuthPages.frame.test.tsx` — the title and the visible line)

### REG-064 - Reset failures are indistinguishable for unknown email vs bad token
- **Priority:** P1
- **Type:** Security
- **Preconditions:** Direct API access.
- **Steps:**
  1. `POST /api/auth/reset-password` with an unknown email + any token.
  2. Same with a shape-valid email + garbage token.
- **Expected:**
  - Byte-identical generic 400 bodies — the reset endpoint must not become the enumeration oracle forgot-password avoids being.
- **Automated:** Full (PasswordResetFlowTests — REG-064)

### REG-065 - Reset page client behaviour: mismatch guard, dead-link recovery, incomplete link
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** `/reset-password` opened with various query shapes.
- **Steps:**
  1. Valid link, mismatched confirmation → submit.
  2. Valid link, server answers the generic invalid-link 400.
  3. Valid link, server answers Identity password-policy `errors`.
  4. Open with the token missing from the query.
- **Expected:**
  - 1: the one alert line above the submit reads "Those passwords don't match."; the "Confirm new password" field is marked invalid (red edge, `aria-invalid`) and described by that line ("New password" is not) — no POST.
  - 2: the generic message verbatim in the alert line + a "Request a new link" button (a secondary pill under the alert, above the submit) → `/forgot-password`. A server error never marks the confirm field invalid.
  - 3: the joined Identity errors; NO new-link button (the link is still redeemable).
  - 4: the incomplete-link state (no doomed form): the card's title "This link isn't complete" with an (i) **About this link** holding "The reset link is missing some of its details — it may have been split across two lines in the email. You can request a fresh one below.", the same recovery button (here the primary pill), and "Back to sign in" at the card's foot.
- **Automated:** Full (client/src/pages/ResetPasswordPage.catalog.test.tsx — REG-065 ×4; `AuthPages.frame.test.tsx` — the confirm field marked invalid on a mismatch only, the incomplete link's title and (i))

### REG-066 - Forgot/reset pages pass axe in both themes
- **Priority:** P2
- **Type:** A11y
- **Preconditions:** Stubbed-API e2e build.
- **Steps:**
  1. Scan `/forgot-password` (form + confirmation state) and `/reset-password` (form, the mismatch alert with the confirm field marked invalid, incomplete-link state) in light and dark.
- **Expected:**
  - No WCAG 2.x A/AA violations in any of the five states × two themes.
- **Automated:** Full (client/e2e/a11y.spec.ts — REG-066)

### REG-067 - A successful reset clears an active lockout
- **Priority:** P2
- **Type:** Negative
- **Origin:** Adversarial review of the password-reset PR — reset didn't clear lockout, so a user who reset *because* they were locked out still couldn't sign in.
- **Preconditions:** A registered account; direct API access (Development mailbox, setup note g).
- **Steps:**
  1. Fail sign-in 5 times to trip the 15-minute lockout; confirm even the correct old password is refused ("temporarily locked").
  2. Forgot-password → reset via the emailed link → set a new password.
  3. Immediately sign in with the new password.
- **Expected:**
  - Step 3 succeeds — the reset cleared `LockoutEnd` + `AccessFailedCount` (`SetLockoutEndDateAsync(null)` + `ResetAccessFailedCountAsync`), so the new password isn't refused as locked. Without the fix, the reset signs the device in but login elsewhere stays locked for the rest of the window.
- **Automated:** Full (tests/AllotJar.IntegrationTests/Http/PasswordResetFlowTests.cs — REG-067)


## Google sign-in

Setup for this section: the server runs the Development-only fake validator
(`Google:UseFakeValidator=true` on a Development host — set in the HTTP-integration fixture and the
journey webServer). A fake credential is `fake-google:{json}`, e.g.
`fake-google:{"sub":"g-1","email":"a@b.test","emailVerified":true,"givenName":"Ana"}`. The fake
rejects anything else, INCLUDING a real Google token — production uses `GoogleIdTokenValidator`
(audience-pinned to `Google:ClientId`). The client button needs a build-time `VITE_GOOGLE_CLIENT_ID`.

### REG-073 - First Google sign-in creates a working passwordless account
- **Priority:** P1
- **Type:** Happy
- **Steps:**
  1. `POST /api/auth/google` with a fresh-`sub` verified credential.
  2. Inspect the response, the Set-Cookie, and `GET /auth/me`.
  3. Do an authorized write (create a month).
- **Expected:**
  - 200 `AuthResponse` with a token, `isNewAccount:true`, and a `zbb_rt` cookie. `/auth/me`: `needsConsent:true` (deferred terms), `hasPassword:false`, a non-empty households list. The write succeeds — the full `HouseholdBootstrap` (Owner membership + member #1) ran, and NO sample budget was seeded.
- **Automated:** Full (tests/AllotJar.IntegrationTests/Http/GoogleSignInFlowTests.cs — REG-073; journey e2e-journey/google-sign-in.spec.ts for the cookie→reload→ConsentModal lifecycle)

### REG-074 - The permanent Google sub keys the account, not the email
- **Priority:** P1
- **Type:** Security
- **Steps:**
  1. Sign in with a `sub`; note the userId.
  2. Sign in again with the SAME `sub` but a DIFFERENT email (as after a Google address change).
- **Expected:**
  - Same userId, `isNewAccount:false`. The app account's stored email is NOT rewritten from the token.
- **Automated:** Full (GoogleSignInFlowTests — REG-074; journey returning-user spec)

### REG-075 - A verified-email match auto-links, and neutralizes the pre-existing password (pre-hijacking defence)
- **Priority:** P1
- **Type:** Security
- **Steps:**
  1. Register a password account for an email (registration never verifies the email).
  2. Sign in with Google using a verified credential for the SAME email.
  3. Then try the original password; check `/auth/me`.
- **Expected:**
  - Google sign-in lands in the SAME account (same userId, `isNewAccount:false`) — no duplicate fork. **The old password no longer signs in (401) and `hasPassword` is now false.** Because the app never verified the email at registration, an attacker could have pre-registered the victim's address with a known password; the moment Google attests ownership, that pre-existing password is REMOVED and existing sessions revoked. The legitimate owner keeps Google sign-in and can re-add a password via **Forgot password** (which re-proves email control).
- **Automated:** Full (GoogleSignInFlowTests — REG-075)

### REG-076 - An unverified Google email is rejected
- **Priority:** P1
- **Type:** Security
- **Steps:**
  1. `POST /api/auth/google` with `emailVerified:false`.
- **Expected:**
  - 401 naming the unverified email — no account created, no link. (Auto-linking on an unverified address would let an attacker who registers an unverified Google identity for a victim's email walk into the victim's account.)
- **Automated:** Full (GoogleSignInFlowTests — REG-076)

### REG-077 - Invalid credentials are a clean generic 401
- **Priority:** P1
- **Type:** Negative
- **Steps:**
  1. POST a garbage credential, a malformed fake, a fake missing `sub`, and a real-JWT-shaped string.
- **Expected:**
  - Each is a generic 401 (`could not be verified`) — no 500, no enumeration. The fake validator rejects a real Google token too, so a harness pointed at it can't be satisfied by accident.
- **Automated:** Full (GoogleSignInFlowTests — REG-077; GoogleSignInValidatorTests — the validator grammar)

### REG-078 - Locale hints apply to new accounts; garbage falls back
- **Priority:** P2
- **Type:** Negative
- **Steps:**
  1. First Google sign-in sending `preferredCurrency:"GBP"`, `numberFormat:"dot-comma"`.
  2. Another first sign-in sending garbage currency/format.
- **Expected:**
  - 1: `/auth/me` shows GBP / dot-comma (register-form parity — the client sends its locale detection). 2: sign-in still succeeds (200); prefs fall back to EUR / comma-dot — bad hints never fail sign-in.
- **Automated:** Full (GoogleSignInFlowTests — REG-078)

### REG-079 - The fake validator is double-gated
- **Priority:** P1
- **Type:** Security
- **Steps:**
  1. Resolve `IGoogleIdTokenValidator` from the real container for {flag on/off} × {Development/Production}.
- **Expected:**
  - Fake ONLY when the flag is on AND the host is Development. Flag-on + Production → the REAL validator. So production configuration alone can never disable real Google verification.
- **Automated:** Full (GoogleSignInValidatorTests — REG-079)

### REG-080 - The Google button renders only when configured, and degrades silently
- **Priority:** P2
- **Type:** UX
- **Steps:**
  1. Render the login page with a client id, without one, and with the GSI script failing.
  2. With a client id, press **Dark mode** in the green room, then again.
- **Expected:**
  - With a client id: an "or" divider and Google's own button appear under the submit (the divider follows the button's readiness). Google draws it as its large pill ("Continue with Google", logo centred), as wide as the card's column up to Google's 400px: `outline` (white, grey edge) on the light page, `filled_black` on the dark one; a theme change redraws it. Without a client id, or on script failure: nothing — the card ends with the submit, as the password-only experience (no orphaned divider, no dead button).
- **Automated:** Full (client/src/components/GoogleSignInButton.catalog.test.tsx — REG-080 ×3 and the pill/outline → filled_black redraw; client/src/lib/googleAuth.test.ts — the options passed to Google, one initialise, redraw in place; LoginPage.catalog.test.tsx — REG-080)

### REG-081 - The Google credential round-trip on the login page
- **Priority:** P1
- **Type:** Happy
- **Steps:**
  1. Complete the Google flow; the button's callback fires with a credential.
  2. Server answers `isNewAccount` true, then false; then a 401.
- **Expected:**
  - POSTs `/auth/google` with the credential AND the locale-detected currency/format; applies the session and navigates to `returnUrl ?? '/'`. Fires `sign_up {method:'google'}` when `isNewAccount`, else `login {method:'google'}`. A 401 surfaces the server's error string inline (no bounce, no spurious session-expired redirect) and fires `login_failed {method:'google'}`.
- **Automated:** Full (client/src/pages/LoginPage.catalog.test.tsx — REG-081)


### REG-082 - Google link ignores lockout and neutralizes a pre-existing password + sessions
- **Priority:** P1
- **Type:** Security
- **Origin:** Adversarial review of the Google SSO PR — the verified-email auto-link left the pre-existing password and sessions intact (account pre-hijacking), and the lockout-exempt property was unpinned.
- **Steps:**
  1. Register a password account; capture its session token.
  2. Trip the 5-strike lockout with wrong-password sign-ins; confirm the correct password is now refused as locked.
  3. Sign in with Google using a verified credential for the SAME email.
  4. Replay the pre-link session token; try the old password again.
- **Expected:**
  - Step 3 succeeds (200) despite the lockout — a valid Google token proves account control, so lockout (which throttles password *guessing*) is not honoured. Step 4: the pre-link token is 401 (sessions revoked by the stamp rotation) and the old password is 401 (removed). Password login is simply gone until re-added via forgot-password.
- **Automated:** Full (tests/AllotJar.IntegrationTests/Http/GoogleSignInFlowTests.cs — REG-082)

### REG-083 - The real validator pins the token audience to the configured client id
- **Priority:** P1
- **Type:** Security
- **Origin:** Adversarial review — audience pinning is the feature's core control but `GoogleJsonWebSignature.ValidateAsync` is a static call with no seam, so a dropped pin would go unnoticed.
- **Steps:**
  1. Build the validator's `ValidationSettings` for a client id and inspect the accepted audience.
- **Expected:**
  - `Audience` contains exactly the configured client id — an ID token minted for any OTHER Google OAuth app is rejected. (The wiring is asserted directly via `GoogleIdTokenValidator.BuildValidationSettings`; the live signature/expiry/issuer checks are Google.Apis.Auth's, exercised only against the real Google keys in production.)
- **Automated:** Full (tests/AllotJar.Application.Tests/Application/GoogleSignInValidatorTests.cs — REG-083)

### REG-084 - The production CSP allows Google Identity Services and keeps its baseline hardening
- **Priority:** P2
- **Type:** Security
- **Origin:** Adversarial review — the CSP is deploy infra (not compiled), so stripping the GIS allowances would silently break the button with no failing test.
- **Steps:**
  1. Parse `deploy/web/web.config`'s Content-Security-Policy header.
- **Expected:**
  - `script-src` includes `accounts.google.com/gsi/client`; `frame-src` and `connect-src` include `accounts.google.com/gsi/`; `style-src` includes `accounts.google.com/gsi/style`. Baseline intact: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, no `unsafe-eval`.
- **Automated:** Full (tests/AllotJar.IntegrationTests/ContentSecurityPolicyTests.cs — REG-084)


## Email verification & safe reclaim

Setup: a Development-env API with NO `Email:ApiKey` so verification/reclaim emails land in the sink
(`GET /api/dev/emails?to=<email>`; `textBody` carries the link). Registration now sends a
"confirm your email" link; the account is usable immediately behind a persistent banner.

### REG-086 - A fresh registration is unverified until the emailed link is confirmed
- **Priority:** P1
- **Type:** Happy
- **Steps:**
  1. Register a new account; check `/auth/me`.
  2. Open the confirmation link from the mailbox; check `/auth/me` again.
- **Expected:**
  - After register: signed in, `emailConfirmed:false`, and a confirmation email present. After
    `POST /auth/confirm-email` with the emailed token: 204, and `/auth/me` `emailConfirmed:true`.
- **Automated:** Full (tests/AllotJar.IntegrationTests/Http/EmailVerificationFlowTests.cs — REG-086; journey email-verification.spec.ts)

### REG-087 - Confirm-email rejects bad tokens and is idempotent
- **Priority:** P2
- **Type:** Negative
- **Steps:**
  1. POST a garbage token, and an unknown email.
  2. Confirm with the real token, then confirm again.
- **Expected:**
  - Garbage/unknown → generic 400 ("invalid or has expired"). A valid token → 204; a second confirm of the now-verified account → idempotent 204 (no confirmation-state leak).
- **Automated:** Full (EmailVerificationFlowTests — REG-087)

### REG-088 - Safe reclaim: registering an UNVERIFIED email emails a claim link that takes it over
- **Priority:** P1
- **Type:** Security
- **Origin:** Closes the email-squatting residual left by the Google pre-hijacking work.
- **Steps:**
  1. A "squatter" registers an email (unverified) and holds a session.
  2. The true owner registers the SAME email.
  3. The owner redeems the emailed link; then check the squatter's session + password.
- **Expected:**
  - Step 2: a neutral `{ verificationPending: true }` 200 with NO session, and a reset/claim link emailed to the address. Step 3: redeeming it (reset-password) signs the owner in, sets `emailConfirmed:true`, and revokes the squatter's session + password (both now 401). The account is reclaimed with no data loss.
- **Automated:** Full (EmailVerificationFlowTests — REG-088; journey reclaim spec)

### REG-089 - A VERIFIED existing email still returns the honest "already exists"
- **Priority:** P1
- **Type:** Negative
- **Steps:**
  1. Register + confirm an email; then register it again.
- **Expected:**
  - 400 "An account with that email already exists." — a confirmed account genuinely belongs to someone; no reclaim, no session. (Registration revealing existence for VERIFIED emails is the accepted trade-off; UNVERIFIED ones get the neutral reclaim instead.)
- **Automated:** Full (EmailVerificationFlowTests — REG-089)

### REG-090 - Resend-verification resends while unverified and no-ops once verified
- **Priority:** P2
- **Type:** Happy
- **Steps:**
  1. Register (unverified); `POST /auth/resend-verification`.
  2. Confirm; resend again.
- **Expected:**
  - Both calls are 204; step 1 produces a fresh confirmation email, step 2 (already verified) sends nothing — same 204 shape either way, so confirmation state never leaks through the response.
- **Automated:** Full (EmailVerificationFlowTests — REG-090)

### REG-091 - The verification email is self-contained
- **Priority:** P2
- **Type:** Happy
- **Steps:**
  1. Inspect the `EmailVerificationEmail` text + HTML bodies.
- **Expected:**
  - The confirm link in both bodies, the 2-hour lifetime, the "didn't create an account — ignore" note, and NO external images/trackers (only the confirm link is an external URL).
- **Automated:** Full (tests/AllotJar.Application.Tests/Application/EmailVerificationEmailTests.cs — REG-091)

### REG-092 - The confirm-email page: confirm, dead link, incomplete link
- **Priority:** P2
- **Type:** Negative
- **Steps:**
  1. Open `/confirm-email?email=&token=` with a good link, a dead link, and no token; watch the page while the request is in flight.
- **Expected:**
  - Restyle PR 16: the page is a card in the signed-out frame (`AuthFrame`, as `/login`: the green room with the wordmark, the round **Dark mode** button and the line "Give every euro a job." over the shelf of jars on desktop; the compact band and the sheet on a phone; the staging build's banner above the room). No big logo, no "Confirm your email." subtitle, no Light | Dark group (the segmented `ThemeToggle` is deleted). One short state at a time, one primary (green pill) per screen:
    - Working: the h1 "Confirming your email…" (`role="status"`), nothing else but the quiet "Back to sign in" → `/login` at the card's foot.
    - Good: POSTs the decoded email+token once (StrictMode-safe) and calls `markEmailConfirmed()`; the h1 "Email confirmed" (`role="status"`, takes focus), one line "You're all set.", the primary "Go to AllotJar" → `/` (a client-side link). No foot link: the primary already leads out.
    - Dead (the POST fails): the h1 "This link has expired", one line "Sign in and use Resend in the banner to get a fresh one.", the primary "Sign in" → `/login`. No foot link: the primary is the way back.
    - No token (or no email): the h1 "This link isn't complete" with an (i) **"Why"** beside it holding "The confirmation link is missing some of its details — it may have been split across two lines in the email.", the same recovery line, the primary "Sign in" → `/login`; no API call. Tab order: the theme button, the (i), Sign in.
  - Light and dark, desktop and phone, all finished; no sideways scroll on a phone; the band's line sits where it does on every other frame page.
- **Automated:** Full (client/src/pages/ConfirmEmailPage.catalog.test.tsx — REG-092 and the frame: the four states, one primary each, the (i), the keyboard path, the theme button, the staging banner; client/e2e/a11y.spec.ts — axe on all four states and the (i) open, both themes; client/e2e/mobile-layout.spec.ts — no overflow and the band's height at 390px; client/e2e-journey/email-verification.spec.ts — the real emailed link, "Email confirmed", "Go to AllotJar")

### REG-093 - Register on an unverified email shows the client claim panel
- **Priority:** P1
- **Type:** Happy
- **Steps:**
  1. Submit the register form for an email the server answers with `verificationPending:true`.
  2. Click "Use a different email".
- **Expected:**
  - Step 1: in the card, the switch, the form and Google's button are replaced by a `role="status"` block: the title "Check your inbox" (an h2 under the page's hidden h1; it takes focus, and the next Tab reaches its (i)) with an (i) **What to do next** holding "If that's you, follow the link to take it over. If not, you can ignore this.", the visible sentence naming the email ("An account with {email} already exists but hasn't been confirmed. …"), and "Use a different email" at the card's foot. The app is NOT navigated to (no session). No sign_up analytics fires (no account was created for this caller).
  - Step 2: the Create account form returns (still on Create account, the address kept) with the caret in "Email".
- **Automated:** Full (client/src/pages/LoginPage.catalog.test.tsx — REG-093; `LoginPage.frame.test.tsx` — the (i), focus on the title, back to the Email field)

### REG-094 - Emailed links open the site the API runs on, not the other one
- **Priority:** P1
- **Type:** Ops / Negative
- **Origin:** 12 October 2026: a password reset requested on staging emailed a link that opened production. `Email:AppBaseUrl` is config-only (never the request's Host header, REG-053) and its built-in default is the production origin, so a staging `appsettings.Staging.json` that omits it mails production links — and the token inside, signed with staging's own DataProtection keys, is not valid there.
- **Preconditions:** Unit level for the check; a VPS stack for the deploy preflight.
- **Steps:**
  1. Ask `EmailSettings.DescribeEnvironmentMismatch(env)` about the production origin on `Staging`, the staging origin on `Production`, each stack's own origin (any case, trailing slash; production is public at www and the apex, so both fit it), a non-URL, and `Development`.
  2. Run `Get-StackSettingsProblems` (deploy/ProvisionHelpers.psm1) over a staging file without `AppBaseUrl`, with the production one, naming the production database, and a production file naming staging.
  3. Deploy a stack whose settings file fails step 2.
- **Expected:**
  - 1: the other site's origin and a non-URL are described (naming the origin the links would open, the right value and the file to set it in); the stack's own origin passes; `Development` and the test hosts are never judged. Startup logs `Links in emails open the wrong site: …` at **Error** (so it reaches the error alerts), otherwise `Links in emails open <origin>` at Warning.
  - 2: staging must set `Email:AppBaseUrl` (missing = the production default) and both stacks must name their own database and origin (www or the apex for production); a commented-out line counts for nothing; two entries are refused.
  - 3: `Deploy.ps1` stops in its preflight, before the API is taken offline, listing the problems; the stack keeps running its old build.
- **Automated:** Full (EmailProviderSelectionTests — REG-094: 6 mismatch + 6 accept + 3 malformed + 3 unjudged cases; deploy/tests/Test-DeployHelpers.ps1 — 18 settings-fit + 5 origin cases). Step 3 is manual (a VPS deploy).
