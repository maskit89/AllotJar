# Account Preferences (/account)

**ID prefix:** PREF | **Scope:** The `/account` page (route always mounted under `RequireAuth`, reached via the UserMenu item "Account settings"; titled "Account settings", restyle PR 12): the "Your account" card — the profile (avatar, the name as a heading with a pencil "Edit name" that turns it into the First name / Last name fields, the access level as a chip with what it allows behind its (i) "About access level", the email) and, under a hairline, Preferences (Currency select — **read-only with a lock once the budget currency is locked** (W08, rule 85), the lock and why behind its (i) — Number format select, and Save, whose accessible name is "Save preferences"; one form, so Save also saves the names) including the currency choice of a household that holds nothing yet (no FX conversion, ever) and the number/money format change with its immediate app-wide effect via `setMoneyFormat`, the Sign-in card (its Password row's "Change", named "Change password", opens the Change password dialog — Current password check, new-password rules incl. Identity policy + HIBP, session continuity on this device; "Set a password" for a passwordless login; the Google row with Disconnect behind its ⋯), the Household card's sharing row as an entry point to `/people`, and theme-toggle persistence (per device/browser, `zbb.theme`). Server side: `PUT /api/auth/preferences` and `POST /api/auth/change-password` on `src/AllotJar.Api/Controllers/AuthController.cs`, normalisation in `src/AllotJar.Infrastructure/Identity/UserPreferences.cs`. | **Out of scope:** currency/format defaults and pickers at sign-up, HIBP at registration, lockout/anti-enumeration on login (02-registration-login.md); refresh mechanics, the cross-device sign-out that a password change causes, replay grace window, cross-tab sign-out broadcast (03-session-auth-lifecycle.md — only the *this-device* side of a password change and the silent-refresh-on-/account regression live here); the Household card's "Your own budget" row and its ⋯ "Leave household" (with the Leave dialog), household switcher, invites, ConsentModal (households & people file); UserMenu general behavior, greetings, onboarding, month TopBar (routing & app shell file); deep role matrices (roles & access file — only the "read-only can still self-serve" area-specific case lives here); dark/responsive/a11y sweeps (cross-cutting files — `/account` is already axe-scanned light+dark by `client/e2e/a11y.spec.ts` and width-guarded by `client/e2e/mobile-layout.spec.ts`). **Do not test for:** a `GET /auth/preferences` endpoint (only PUT exists; reads come via `/auth/me`), password reset / "Forgot password?", email change (no UI or endpoint), avatar upload, per-user theme sync across devices (theme is deliberately device-local).

**Test data setup:** (a) Solo owner login `owner@example.test` / `Sunlit-Meadow-42a` (non-breached, meets digit+upper+lower policy), preferences EUR / `comma-dot` (1,234.56), First name "Alex", Last name "Muscat"; its household has one budget month with income 2,500.00 and planned lines summing 1,234.56, one jar "Emergency Fund" with balance 350.00, and one EUR account "Main" — so format changes are observable on real amounts, and its budget currency (EUR) is **locked** (`/auth/me` → `currencyLocked: true`). (a2) A fresh solo owner `fresh@example.test` (same password shape) whose household holds **nothing** yet — no account, no month, no transaction — so its currency is still changeable (`currencyLocked: false`). (b) A shared household (2 members) owned by `owner2@example.test` with an invited member login `member@example.test` (role Read-only where a case says so; invite display name "Sam", no first/last name). (c) Fresh browser profile per case unless stated; locale `en-GB`. (d) "Direct API" steps: any HTTP client with a valid bearer token (copy from devtools) against the JSON endpoints — the UI selects block invalid values client-side. (e) Local stack (API :5099, `ASPNETCORE_ENVIRONMENT=Development`) or staging (staging.allotjar.com); for token-expiry cases run locally with `Jwt__ExpiryMinutes=1` or genuinely wait >15 min. (f) New passwords in positive cases: random non-breached shape `Aa1-<uuid>` (HIBP rejects fixed common passwords).

## Page access & profile

### PREF-001 - "Account settings" menu item opens /account with full page chrome
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.test`, on the dashboard.
- **Steps:**
  1. Click the user chip (aria-label "Account menu") in the sidebar (or mobile top bar).
  2. Click the menu item "Account settings".
  3. Inspect the page top-to-bottom.
- **Expected:**
  - URL is `/account`; the top bar's title is "Account settings" (the menu item's words; no subtitle, no month).
  - The "Your account" card: the avatar, the name "Alex Muscat" as a heading with a pencil ("Edit name"), the access level chip "Owner" (its (i) "About access level" holds what the role allows) and the email `owner@example.test`; then, under a hairline, "Preferences" (Currency, Number format, Save).
  - Wide screens: two columns on the Dashboard's proportions — "Your account" on the left; "Household" (the sharing row, here "Just you" with "Share this budget") above "Sign-in" (the Password row with "Change") on the right. Phones: the same cards in one column. No "Your own budget" row and no Household ⋯ (Leave household) for an owner viewing their own household; no Google row without a linked Google login.
  - The top bar (with the theme toggle) still renders, and the sidebar's account button (the phone's More tab) is marked as the current page — `/account` is a normal authenticated page.
- **Automated:** Partial (client/src/pages/AccountPage.test.tsx — the title and the rows per role/household shape; client/e2e/account-settings.spec.ts — the two columns and the phone's one column; client/e2e/a11y.spec.ts + mobile-layout.spec.ts — /account rendered in both themes / at 375px)

### PREF-002 - Logged-out deep link to /account bounces to login and returns after sign-in
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Anonymous browser (no `zbb_rt` cookie).
- **Steps:**
  1. Navigate directly to `/account`.
  2. Sign in as `owner@example.test` on the login page shown.
- **Expected:**
  - Step 1: brief auth splash, then redirect to `/login?returnUrl=%2Faccount` (no `reason` param — the user was never signed in).
  - Step 2: after sign-in the app navigates back to `/account`, not the dashboard.
- **Automated:** Partial (client/src/pages/LoginPage.test.tsx — returnUrl honoured after sign-in; the /account-specific bounce is unasserted)

### PREF-003 - Access level shows the active household's role label
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Signed in as `member@example.test`, a Read-only member currently viewing the joined household.
- **Steps:**
  1. Open `/account`.
  2. Read the access level chip beside the name, and hover or focus its (i) ("About access level").
- **Expected:**
  - The chip reads "Read-only" (a screen reader hears "Access level: Read-only"; labels: 0 Owner / 1 Admin / 2 Limited / 3 Read-only from `HOUSEHOLD_ROLE_LABELS`; any unknown numeric falls back to "Member", with no (i)). The (i) says what the role allows: "View everything; cannot make changes." (`HOUSEHOLD_ROLE_HINTS`).
  - On a cold load the value may briefly render from the `zbb.role` localStorage hint and corrects itself once `GET /api/auth/me` resolves — the settled value must match the server role.
- **Automated:** Partial (client/src/pages/AccountPage.test.tsx — each role's chip and (i), and the unknown role)

### PREF-004 - Login without a display name shows the email as the heading and an email-initial avatar
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** A login whose FirstName/LastName/DisplayName are all null (e.g. after PREF-006), signed in.
- **Steps:**
  1. Open `/account` and read the profile's name heading.
  2. Look at the profile avatar and the user-chip avatar in the sidebar.
- **Expected:**
  - The heading is the email (no name to show), and the email is not repeated on a line under it; the pencil still opens empty "First name" / "Last name".
  - The avatars fall back to the first character of the email, uppercased (`initialsOf` fallback chain).
- **Automated:** Partial (client/src/pages/AccountPage.test.tsx — the email heading, shown once, and the profile avatar's initial)

## Profile name editing

### PREF-005 - Edit first and last name and save
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.test` ("Alex" / "Muscat"), on `/account`.
- **Steps:**
  1. Press the pencil ("Edit name") beside the name: the name becomes the "First name" and "Last name" fields (focus in First name). Change them to "Christopher" and "Borg".
  2. Click Save (named "Save preferences"; it shows "Saving…" and is disabled while in flight), or press Enter in a field.
- **Expected:**
  - `PUT /api/auth/preferences` → 200 with `{firstName:"Christopher", lastName:"Borg", displayName:"Christopher Borg", …}`.
  - Success line (`role="status"`, beside Save): "Your preferences have been saved."
  - The fields close; the profile heading and the user chip read "Christopher Borg" immediately, without a reload; avatar initials become "CB". The ✕ ("Cancel edit") or Escape instead puts the saved name back without saving.
  - `localStorage['zbb.displayName']` = "Christopher Borg". Currency and number format are unchanged (the form submits the current number-format value and, while the currency is locked, the stored `preferredCurrency`).
- **Automated:** Partial (client/src/pages/AccountPage.catalog.test.tsx — PREF-005; client/src/pages/AccountPage.test.tsx — the pencil, ✕, Escape and Save closing the fields)

### PREF-006 - Both name fields can be blanked (names are not required)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Signed in as `owner@example.test` with names set.
- **Steps:**
  1. Press the pencil, then clear "First name" and "Last name" completely.
  2. Click "Save preferences".
- **Expected:**
  - Save succeeds (the fields have no `required` attribute, unlike at sign-up).
  - Server nulls both names and the DisplayName; the profile heading shows the email instead (PREF-004); user chip falls back to the email initial; `zbb.displayName` is removed from localStorage.
- **Automated:** No

### PREF-007 - Whitespace-only names are treated as blank
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Signed in as `owner@example.test`.
- **Steps:**
  1. Press the pencil; enter three spaces in "First name" and a tab-like run of spaces in "Last name".
  2. Click "Save preferences".
- **Expected:**
  - The client trims before sending (`pfFirst.trim()`), and the server's `NullIfBlank` nulls anything left — identical outcome to PREF-006: DisplayName null, the heading reads the email. No error.
- **Automated:** No

### PREF-008 - Name length and unicode boundaries
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Signed in as `owner@example.test`.
- **Steps:**
  1. Save First name "Żañlí-Éva 🎉" and Last name "O'Connor-Ħal Għaxaq".
  2. Save a First name of exactly 128 characters.
  3. Save a First name of 200 characters.
- **Expected:**
  - Step 1 (names typed after the pencil): succeeds; the profile heading, user chip and initials render the unicode/emoji correctly.
  - Step 2: succeeds (DB column is nvarchar(128)).
  - Step 3: the save fails server-side (no friendly length validation exists — the DB rejects >128); the UI shows the fallback error line "Could not save your preferences." (the fields stay open with what was typed) and nothing is persisted (re-loading `/account` shows the previous name). No partial save of the other fields.
- **Automated:** No

### PREF-009 - /auth/me hydration overwrites in-progress edits on a cold load
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Signed in; throttle the network (devtools Slow 3G) so `GET /api/auth/me` resolves late.
- **Steps:**
  1. Hard-reload `/account` directly.
  2. Immediately press the pencil and start typing a new first name before `/auth/me` completes.
  3. Wait for `/auth/me` to resolve.
- **Expected:**
  - When `/auth/me` lands, the form re-hydrates from the server values and the keystrokes typed in step 2 are replaced by the saved name (the hydration `useEffect` keys on the auth-context values). This is current, accepted behavior — verify nothing is auto-saved and the user can simply retype and save.
- **Automated:** No

### PREF-010 - Saving preferences recomposes the display name, dropping an invite-provided one
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Signed in as `member@example.test` — invite-created login with DisplayName "Sam" but null First/Last name (the accept-invite form collects only a display name).
- **Steps:**
  1. Open `/account`; note the heading "Sam" and, after the pencil, both name fields empty; press ✕.
  2. Change only the "Number format" select and click "Save preferences".
- **Expected:**
  - The save succeeds, but because DisplayName is recomposed from First + Last on every save (`ComposeDisplayName`) and both are blank (Save sends the names whether or not the fields are open), the heading becomes the email and the chip falls back to the email initial — the invite-provided "Sam" is not preserved. Known quirk of the current implementation: verify the documented behavior and that filling First name "Sam" + saving restores the name.
- **Automated:** No

## Budget currency (fixed once the budget holds anything; no FX)

### PREF-011 - Once the budget holds anything its currency is read-only and nothing is ever relabelled
- **Priority:** P0
- **Type:** Regression
- **Origin:** W08 (rules 42/85) — changing the currency used to relabel recorded money (€350.00 became $350.00), an implicit 1:1 conversion.
- **Preconditions:** Signed in as `owner@example.test`, EUR / comma-dot, with the fixture month (planned 1,234.56), jar (350.00) and EUR account "Main" (so `currencyLocked: true`).
- **Steps:**
  1. On `/account`, read Preferences: the "Currency" field and its (i) ("About the lock").
  2. Change First name (pencil) and click "Save preferences".
  3. Visit `/jars`, `/accounts` and `/` (Budget).
- **Expected:**
  - Step 1: "Currency" is a **read-only input** (not a select; no fill, muted text, a lock icon) showing "Euro (€)", described (for a screen reader) by the note "Your budget currency is fixed once your budget has accounts, months or transactions." Its (i) shows that note, then "Your currency is the one your budget and all its accounts use; number format controls the decimal and grouping separators." (The former intro's "Your name and how money is shown across the app." is gone: the card's title and fields say it.)
  - Step 2: the PUT carries the stored `preferredCurrency: "EUR"`; success message; user chip still "EUR · Personal".
  - Step 3: every amount keeps its currency and number: jar €350.00, "Main" in €, the month in EUR. No FX conversion or relabelling anywhere.
- **Automated:** Yes (client/src/pages/AccountPage.test.tsx — "shows the currency read-only with a note once the budget currency is locked"; tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs — `The_budget_currency_is_fixed_once_the_household_holds_anything`)

### PREF-012 - Currency select offers exactly the curated 24-currency list
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Signed in as `fresh@example.test` (nothing recorded, so the currency is still a select), on `/account`.
- **Steps:**
  1. Open the "Currency" select and read every option.
- **Expected:**
  - Exactly 24 options in `CURRENCY_OPTIONS` order, starting "Euro (€)", "British pound (£)", "US dollar ($)", "Swiss franc (CHF)", … ending "Turkish lira (₺)"; identical list to the sign-up form (labels like "Polish złoty (zł)", "Indian rupee (₹)").
  - The "Number format" select offers exactly 5 worked-example options: `1,234.56`, `1.234,56`, `1 234,56`, `1'234.56`, `1,23,456.78`.
  - Behind the Currency (i) ("About these settings"): "Your currency is the one your budget and all its accounts use; number format controls the decimal and grouping separators." No lock and no "fixed" note while unlocked.
- **Automated:** Full (client/src/pages/AccountPage.catalog.test.tsx — PREF-012)

### PREF-013 - Per-currency decimals: JPY renders with no decimal places
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #125 — formatMoney/currencySymbol dropped the hardcoded 2 fraction digits; each currency uses its ISO minor-unit count
- **Preconditions:** Signed in as `fresh@example.test` (unlocked).
- **Steps:**
  1. Change "Currency" to "Japanese yen (¥)" and save.
  2. Add an account "Wallet" with opening 350 and a jar held in it; visit `/accounts` and `/jars` and read the amounts.
- **Expected:**
  - The account is created in JPY (the budget currency) and amounts render 0-decimal yen style: "¥350" not "¥350.00" (comma-dot format → en-GB locale). The underlying numeric values never change. (The currency is now locked — switching back to EUR is no longer possible, PREF-042.)
- **Automated:** Partial (client/src/lib/money.test.ts — per-currency natural fraction digits; not asserted through the preferences flow)

### PREF-014 - Direct API: any syntactically valid 3-letter code is accepted (e.g. XXX)
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Bearer token for `fresh@example.test` (unlocked — for `owner@example.test` the change is refused, PREF-042); HTTP client.
- **Steps:**
  1. `PUT /api/auth/preferences` with `{"preferredCurrency":"xxx","numberFormat":"comma-dot","firstName":"Alex","lastName":"Muscat"}`.
  2. Reload `/account` in the browser.
- **Expected:**
  - 200 — validation is `^[A-Z]{3}$` after trim+uppercase, so "xxx" normalises to "XXX" and saves (documented lenient behavior; the 24-option picker is only a shortlist).
  - UI consequences are graceful: the Currency select shows no matching option (blank/unmatched); the user chip reads "XXX · …"; tagline nouns fall back to "unit" ("Give every unit a job"); `Intl.NumberFormat` renders amounts with the literal "XXX" code. Saving from the UI select afterwards repairs it.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Infrastructure/UserPreferencesTests.cs — normalizer accepts any 3-letter code; UI fallout unasserted)

## Number format preference

### PREF-015 - Format change takes effect app-wide immediately, without a reload
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.test`, EUR / `comma-dot`; fixture month with planned total 1,234.56.
- **Steps:**
  1. On `/account`, change "Number format" from `1,234.56` to `1.234,56` and click "Save preferences".
  2. Without reloading, navigate to `/` (Budget) and `/transactions`.
- **Expected:**
  - Success message; `localStorage['zbb.numberFormat']` = "dot-comma".
  - Every money figure now renders German-style grouping: the planned total reads "1.234,56 €", the hero Income "2.500,00 €" — including inline-editable plain amounts ("1.234,56"). No reload needed (`setMoneyFormat` swaps the module-level locale and the context change re-renders consumers).
  - The currency itself is untouched — format and currency are independent preferences.
- **Automated:** Partial (client/src/lib/money.test.ts — setMoneyFormat renders all five locale groupings; client/src/pages/AccountPage.test.tsx — the PUT; the immediate cross-page effect is unasserted)

### PREF-016 - All five formats render their worked examples (incl. apostrophe and lakh)
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #122 — `apostrophe` (de-CH) and `lakh` (en-IN) keys added in the currency-agnostic phase 1
- **Preconditions:** Signed in as `owner@example.test`; a budget line planned at 123,456.78 EUR (enter 123456.78) to make grouping differences visible.
- **Steps:**
  1. Save each "Number format" option in turn and check the planned amount on `/`:
     `comma-dot`, `dot-comma`, `space-comma`, `apostrophe`, `lakh`.
- **Expected:**
  - Renders respectively: "€123,456.78" (en-GB), "123.456,78 €" (de-DE), "123 456,78 €" (fr-FR, narrow-space grouping), "€ 123'456.78" (de-CH), "€1,23,456.78" (en-IN lakh grouping).
  - The currency symbol never changes with the format — symbol is a function of the currency, position/grouping of the locale.
- **Automated:** Partial (client/src/lib/money.test.ts — all five groupings + symbol independent of format; not driven through the UI)

### PREF-017 - Saved format survives a hard reload with no flash of the default
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** `owner@example.test` saved `dot-comma` earlier; signed in.
- **Steps:**
  1. Hard-reload `/` and watch the first paint of money amounts (throttle network if needed).
- **Expected:**
  - Amounts render "1.234,56 €"-style from the very first paint — the format is applied on mount from `localStorage['zbb.numberFormat']` before `/auth/me` round-trips; there is no flash of the en-GB default.
- **Automated:** No

### PREF-018 - Failed preferences save changes nothing (no optimistic application)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Signed in; devtools open. Block `PUT /api/auth/preferences` (devtools request blocking) or stop the API.
- **Steps:**
  1. Change "Number format" to `1 234,56` and click "Save preferences".
- **Expected:**
  - Error line (`role="alert"`, above Save): "Could not save your preferences." (network failure path).
  - The active app-wide format is unchanged (amounts still render in the old style — the new format is applied only after a 200); localStorage keys unchanged; the form keeps the selected-but-unsaved value so the user can retry.
- **Automated:** No

### PREF-019 - A second open tab keeps the old format until its next /auth/me
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Signed in as `owner@example.test` in two tabs; tab B sitting on `/` (Budget).
- **Steps:**
  1. In tab A, save "Number format" `dot-comma`.
  2. Observe tab B immediately, then reload tab B.
- **Expected:**
  - Tab B keeps rendering the old format at first — there is no cross-tab broadcast for preferences (only sign-out is broadcast). It catches up on its next `/auth/me` (reload, or after its ≤15-min token expiry triggers a silent refresh → token change → `/auth/me` re-fires). After the reload, tab B renders `1.234,56 €` style. Accepted behavior — verify no errors, no sign-out.
- **Automated:** No

## Preferences server validation (direct API)

### PREF-020 - Invalid currency / number format are rejected with exact messages
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Bearer token for `owner@example.test`; HTTP client.
- **Steps:**
  1. `PUT /api/auth/preferences` with `numberFormat: "european"` (currency valid).
  2. `PUT /api/auth/preferences` with `preferredCurrency: "EU"`, then `"EURO"`, then `"€"` (format valid).
  3. Reload `/account`.
- **Expected:**
  - Step 1: 400 `{"error":"That number format isn't supported."}` (allowed keys: comma-dot, dot-comma, space-comma, apostrophe, lakh).
  - Step 2: 400 `{"error":"That isn't a valid ISO 4217 currency code."}` for each (fails the `^[A-Z]{3}$` shape).
  - Step 3: stored preferences unchanged. (If forced through the UI the same `error` body would be shown verbatim in the error line above Save.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Infrastructure/UserPreferencesTests.cs — normalizer nulls unsupported values; the 400 body/message is unasserted)

### PREF-021 - Blank currency/format mean "leave as is" — a name-only save can't reset them
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `fresh@example.test` has saved USD / `lakh` while unlocked (it may have added an account since — resending the stored code is not a change, so the lock doesn't refuse it). Bearer token; HTTP client.
- **Steps:**
  1. `PUT /api/auth/preferences` with `{"firstName":"Alex","lastName":"Muscat","preferredCurrency":"","numberFormat":""}`.
  2. `GET /api/auth/me`.
- **Expected:**
  - 200; the response echoes `preferredCurrency:"USD"`, `numberFormat:"lakh"` — blank values resolve to the user's stored preference, not the app default (guard in `AuthController.UpdatePreferences`). `/auth/me` confirms USD/lakh; the name change is applied.
- **Automated:** No

## Change password

### PREF-022 - Change password end-to-end: this device stays signed in, credentials swap
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.test` / `Sunlit-Meadow-42a`, on `/account`; a fresh random target password `Aa1-<uuid>` noted.
- **Steps:**
  1. On the Sign-in card's Password row, click "Change" (named "Change password"): the Change password dialog opens (a centred card; a bottom sheet on a phone), focus on its close control.
  2. Fill "Current password" = `Sunlit-Meadow-42a`, "New password" and "Confirm new password" = the new password (side by side on a wide screen, stacked on a phone).
  3. Click the dialog's "Change password" (shows "Saving…" while busy, unavailable but still holding the focus; Cancel, ✕, Escape and the backdrop do nothing until it answers; a refusal leaves the focus on it, so Tab stays in the dialog and Escape closes it), or press Enter in a field.
  4. Keep using the app (open `/transactions`), then sign out and sign back in with the OLD password, then with the NEW one.
- **Expected:**
  - `POST /api/auth/change-password` → 200; the dialog closes and the Password row shows the success line (`role="status"`): "Your password has been changed." (until the next attempt). Opening the dialog again shows the three fields empty.
  - This device stays signed in and fully functional — no bounce to `/login` (the 200 body is a fresh `AuthResponse` the client adopts).
  - Old password → 401 "Invalid email or password."; new password signs in. (GA event `password_changed` fires when analytics is on.)
- **Automated:** Partial (client/src/pages/AccountPage.catalog.test.tsx — PREF-022; client/src/pages/AccountPage.test.tsx — the dialog's focus, Escape, Cancel, busy state and the `password_changed` event; client/e2e/account-settings.spec.ts — Tab trap, Enter, the focus kept after a refusal, the 375x667 sheet; client/e2e-journey/session-security.spec.ts — the UI-driven change; client/e2e-journey/session-expiry.spec.ts — real credential swap, driven from a second device context)

### PREF-023 - Change-password response is adopted: fresh token + rotated cookie on this device
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 / change-password used to return 204 — it now returns 200 `AuthResponse` (all refresh tokens are revoked first) which the client MUST apply or this device dies ~15 min later
- **Preconditions:** Signed in as `owner@example.test`; devtools Network + Application (Cookies) open.
- **Steps:**
  1. Note the current `zbb_rt` cookie value.
  2. Change the password (as PREF-022).
  3. Inspect the change-password response and the cookie; stay on the app past the old token's expiry (locally: `Jwt__ExpiryMinutes=1`, wait 2 min, then navigate).
- **Expected:**
  - The 200 response carries `token`/`expiresAtUtc` and a `Set-Cookie: zbb_rt=<new value>` — the cookie value CHANGED (all prior refresh tokens were revoked, then a fresh one issued for this device).
  - After the old access token's lifetime, silent refresh succeeds off the new cookie — this device never sees the expired-session prompt. (Other signed-in devices bounce to `/login?reason=expired` — covered in 03-session-auth-lifecycle.md.)
- **Automated:** Partial (client/e2e-journey/session-expiry.spec.ts — device B's rotated cookie keeps refreshing after its change-password; the in-page cookie-adoption detail is implicit)

### PREF-024 - Wrong current password is rejected with the Identity message
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Signed in as `owner@example.test`.
- **Steps:**
  1. Open the Change password dialog ("Change"); enter "Current password" = `Wrong-Guess-99z`, a valid new password twice.
  2. Click the dialog's "Change password".
- **Expected:**
  - 400 `{errors:["Incorrect password."]}`; the dialog stays open with "Incorrect password." under the fields (`role="alert"`).
  - The session is untouched (no sign-out, no token revocation — revocation happens only on success); field values are kept for correction; the password is NOT changed (old one still signs in).
- **Automated:** No

### PREF-025 - Mismatched new passwords are blocked client-side, no API call
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Signed in, on `/account`; Network tab open.
- **Steps:**
  1. Open the Change password dialog; fill current password correctly, "New password" = `Aa1-alpha-0001`, "Confirm new password" = `Aa1-alpha-0002`.
  2. Click the dialog's "Change password".
- **Expected:**
  - Under the fields: "The new passwords do not match." — and NO request to `/api/auth/change-password` appears in the network log.
- **Automated:** Yes (client/src/pages/AccountPage.test.tsx — mismatch rejected without an API call)

### PREF-026 - New-password length boundary: 7 blocked, exactly 8 accepted
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Signed in as `owner@example.test`; HTTP client with bearer token for the API step.
- **Steps:**
  1. In the Change password dialog, type a 7-character new password in both fields and submit.
  2. In the dialog, use exactly 8 characters meeting the policy (e.g. `Aa1xyzw2`, confirm it is not HIBP-flagged) and submit.
  3. Direct API: `POST /api/auth/change-password` with a 7-character `newPassword`.
- **Expected:**
  - Step 1: the browser's native constraint bubble blocks submission (`minLength=8` on the input) — no request. (The JS backstop message "Use a new password of at least 8 characters." exists for browsers without constraint validation.)
  - Step 2: succeeds — 8 is the minimum, inclusive.
  - Step 3: 400 `{errors:["Passwords must be at least 8 characters."]}`.
- **Automated:** No

### PREF-027 - Identity complexity rules on the new password (digit/upper/lower)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Signed in as `owner@example.test`.
- **Steps:**
  1. Try new password `alllowercase1` (no uppercase).
  2. Try `ALLUPPERCASE1` (no lowercase).
  3. Try `NoDigitsHere!` (no digit).
- **Expected:**
  - Each is submitted (passes the client's length check) and rejected 400 with the Identity default description shown under the dialog's fields, respectively: "Passwords must have at least one uppercase letter ('A'-'Z').", "Passwords must have at least one lowercase letter ('a'-'z').", "Passwords must have at least one digit ('0'-'9')." Multiple failures join into one line. No special-character rule exists (`RequireNonAlphanumeric=false`) — `Aa1xxxxx` shapes pass.
- **Automated:** No

### PREF-028 - Breached new password is rejected by the HIBP check
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Signed in as `owner@example.test`; HIBP reachable (live envs).
- **Steps:**
  1. Enter current password correctly and new password `Password123` (satisfies length + complexity but is a known-breached password) twice.
  2. Click the dialog's "Change password".
- **Expected:**
  - 400 with "This password has appeared in a known data breach. Please choose a different one." under the dialog's fields. Password unchanged. (Check is k-anonymity — only a 5-char SHA-1 prefix leaves the server; it never runs at login.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BreachedPasswordValidatorTests.cs — rejects a breached password at the validator level; the change-password UI path is unasserted)

### PREF-029 - HIBP outage fails open: the change still succeeds
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Local stack with outbound HIBP traffic blocked (hosts-file or firewall) or an unroutable HIBP base URL.
- **Steps:**
  1. Change the password to a fresh random `Aa1-<uuid>` value.
- **Expected:**
  - The change succeeds despite the validator being unable to reach HIBP (5s timeout, fail-open by design — an HIBP outage must not lock users out of rotating their password). No error surfaced.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/BreachedPasswordValidatorTests.cs — fails open when the HIBP API is unreachable or non-success)

### PREF-030 - Same-as-current, very long, and unicode new passwords are accepted
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Signed in as `owner@example.test`.
- **Steps:**
  1. "Change" the password to the exact current password (current = new = confirm).
  2. Change it to a 128-character random `Aa1-…` string; sign out and back in with it.
  3. Change it to `Pässw0rd-🎉-Ħaġar` (unicode + emoji, meets policy); sign out and back in with it.
- **Expected:**
  - Step 1: succeeds — no "must differ from current" rule exists; success message shown; all other devices are still signed out (revocation runs regardless).
  - Steps 2–3: each succeeds and the subsequent sign-in with the exact string works (no silent truncation or normalisation).
- **Automated:** No

### PREF-031 - Change-password bursts hit the auth rate limit; failures never lock sign-in
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Signed in as `owner@example.test`; scripted client sharing the browser's bearer token; default `RateLimiting:AuthPermitLimit` (20/min per source IP).
- **Steps:**
  1. Submit 10 change-password attempts with a WRONG current password.
  2. Immediately sign in from another tab with the correct password.
  3. Continue submitting until >20 auth requests in the same minute.
- **Expected:**
  - Step 1: each returns 400 "Incorrect password." — wrong current-password attempts do NOT increment the sign-in lockout counter (lockout guards login only).
  - Step 2: sign-in succeeds normally (no lockout).
  - Step 3: 429 with no JSON body once the fixed window trips; the dialog shows the fallback line "Could not change your password." A minute later attempts work again.
- **Automated:** No

## Session & role interplay (area-specific)

### PREF-032 - Stale-token save on /account silently refreshes instead of dead-ending
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 / the 401-interceptor exemption is a LIST — a blanket `/auth/` prefix once made `/account` a dead end that could neither save nor prompt re-login
- **Preconditions:** Local stack with `Jwt__ExpiryMinutes=1`; signed in as `owner@example.test`, sitting idle on `/account` for >2 min (access token expired, refresh cookie alive); Network tab open.
- **Steps:**
  1. Edit the first name (pencil) and click "Save preferences".
  2. Repeat the idle-then-act pattern with the Change password dialog.
- **Expected:**
  - The first `PUT /api/auth/preferences` (and later `POST /api/auth/change-password`) gets a 401, the interceptor runs ONE `POST /api/auth/refresh`, and the original request is retried and succeeds — the user just sees the normal success message. No redirect to `/login`, no error line. (`/auth/preferences` and `/auth/change-password` are deliberately NOT on the credential-endpoint exemption list.)
- **Automated:** Partial (client/src/lib/api.test.ts — refresh-and-retry for non-exempt endpoints incl. /auth/me; the /auth/preferences and /auth/change-password URLs themselves are unasserted)

### PREF-033 - A Read-only member can still manage their own preferences and password
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Signed in as `member@example.test` with role Read-only in the active (joined) household.
- **Steps:**
  1. Open `/account`; confirm the read-only banner shows in the shell.
  2. Save a name/format change ("Edit name", "Preferences", Save).
  3. Change the password ("Change" on the Password row, then the dialog).
- **Expected:**
  - Both succeed — `/api/auth/preferences` and `/api/auth/change-password` are login-scoped, not household-scoped, and carry no role gate. The pencil, the fields, Save and "Change" are fully enabled (no read-only disabling on this page). The member's format change affects only their own rendering, not other members'.
- **Automated:** No

## Sharing entry point

### PREF-034 - Solo household: "Share this budget" invites and navigates to /people
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.test` (solo household, 1 member).
- **Steps:**
  1. Open `/account` and read the Household card's sharing row; hover or focus its (i) ("About sharing").
  2. Click "Share this budget".
- **Expected:**
  - The row reads "Just you" (your face) with an outline button "Share this budget"; its (i) holds: "You're budgeting on your own. If you share money with a partner or housemate, you can add them to split shared costs and divide savings between you."
  - Clicking navigates (SPA) to `/people`. While household data is still loading the sharing row is a quiet placeholder (no flash of the wrong variant, and the rows under it don't move when it arrives); an owner's Household card waits for it, a member's shows its other rows at once.
- **Automated:** Yes (client/src/pages/AccountPage.test.tsx — solo, incl. 0-member API edge, offers to share the budget, and the loading state; client/src/pages/AccountPage.catalog.test.tsx — PREF-034)

### PREF-035 - Shared household: who shares it, and the row that opens People
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner2@example.test` (shared household, 2 members).
- **Steps:**
  1. Open `/account` and read the Household card's sharing row.
  2. Click anywhere on the row (its link is "Manage people", the chevron).
- **Expected:**
  - The row shows the people's faces, overlapping (named for a screen reader "Shared between 2 people"; count = active members), and their names: "Alex & Sam" ("Alex, Sam & Robin" for three). No "Share this budget".
  - The row navigates to `/people` (one link, "Manage people", stretched over the row).
- **Automated:** Yes (client/src/pages/AccountPage.test.tsx — shared 2+ links to manage members, asserts the faces' name "Shared between 2 people" and the names)

## Theme toggle persistence

### PREF-036 - Explicit theme pick applies instantly and persists on this device
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `owner@example.test`; no `zbb.theme` key yet (fresh profile); OS in light mode.
- **Steps:**
  1. On any authenticated page (TopBar, right side), click the "dark" button of the Theme toggle (`role="group"`, aria-label "Theme"; buttons aria-labelled "Light mode"/"Dark mode").
  2. Hard-reload the page; navigate around; sign out and view `/login`.
- **Expected:**
  - Dark theme applies immediately (`<html>` gains class `dark`); the pressed button shows `aria-pressed="true"`; `localStorage['zbb.theme']` = "dark"; GA event `theme_changed {theme:'dark'}` when analytics is on.
  - The choice survives reload AND sign-out — the login page renders dark too (the key is device-wide and never cleared by logout/session-expiry).
- **Automated:** No

### PREF-037 - Theme is per-device/browser, not per-user
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Browser A with `zbb.theme` = "dark" (from PREF-036); a second browser/profile B never used with the app.
- **Steps:**
  1. In browser A, sign out and sign in as a DIFFERENT user (`member@example.test`).
  2. In browser B, sign in as `owner@example.test`.
- **Expected:**
  - Browser A stays dark for the second user (the key is device-scoped, shared across logins).
  - Browser B follows its own OS preference (no stored choice travels with the account). Documented design: theme does not sync per user.
- **Automated:** No

### PREF-038 - Without an explicit pick, the app follows the OS theme live — until the first pick
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Fresh profile (no `zbb.theme`); signed in; OS theme switchable (Windows Settings > Personalization > Colors).
- **Steps:**
  1. With the app open, switch the OS from light to dark and back.
  2. Click "light" on the toggle (explicit pick).
  3. Switch the OS to dark again.
- **Expected:**
  - Step 1: the app follows each OS change live (matchMedia listener active only while unset).
  - Step 3: the app STAYS light — an explicit choice stops OS-following permanently (until localStorage is cleared).
- **Automated:** No

### PREF-039 - No wrong-theme flash on load (pre-paint script under CSP)
- **Priority:** P2
- **Type:** Regression
- **Origin:** CSP is `script-src 'self'` (security review) — the pre-paint theme script must stay the external `public/theme-init.js`; inlining it would be blocked and dark-mode users would get a white flash
- **Preconditions:** `zbb.theme` = "dark"; devtools Network throttled (Slow 3G) to stretch the load.
- **Steps:**
  1. Hard-reload `/` and watch the very first paint.
  2. Check the console for CSP violations and confirm `theme-init.js` loads as a separate same-origin request.
- **Expected:**
  - The document is dark from the first frame — no white flash before React mounts (`theme-init.js` stamps the `dark` class pre-paint: stored "dark", or no stored value + OS dark).
  - No CSP errors in the console; `theme-init.js` returns 200.
- **Automated:** No


### PREF-040 - A passwordless (Google) login gets an add-a-password note, not a change-password form
- **Priority:** P2
- **Type:** UX
- **Preconditions:** A login created via Google sign-in (`/auth/me` returns `hasPassword:false`).
- **Steps:**
  1. Open `/account` as a Google-only login, then as an ordinary password login.
- **Expected:**
  - Google-only: the Sign-in card's "Password" row has no "Change" and no current/new/confirm fields anywhere; its "Set a password" link goes to `/forgot-password` to ADD a password (reset works for passwordless accounts), and its (i) ("About the password") explains: "You sign in with Google, so this account has no password yet. To add one, use Forgot password with this account's email — the emailed link lets you set a password. Signing in with Google keeps working either way."
  - Password login: unchanged — "Change" (named "Change password") opens the Change password dialog with the current-password field; no (i) and no "Set a password".
- **Automated:** Full (client/src/pages/AccountPage.catalog.test.tsx — PREF-040)

### PREF-041 - Disconnect Google from the account page
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** A login with a linked Google identity (`/auth/me` `hasGoogle:true`).
- **Steps:**
  1. Open `/account` with `hasGoogle:true` + a password; open the Google row's ⋯ ("Google: more actions"; a bottom sheet titled "Google" on a phone) and choose **Disconnect**.
  2. Open `/account` with `hasGoogle:true` but NO password.
  3. Open `/account` with `hasGoogle:false`.
- **Expected:**
  - 1: the Sign-in card shows a **Google** row with a "Connected" chip; **Disconnect** (behind its ⋯) is enabled. Disconnect POSTs `/auth/google/unlink` (the chip reads "Disconnecting…" meanwhile); the server removes the login and — because that rotates the security stamp — returns a FRESH session (new token + cookie) the client adopts, so the user stays signed in. `hasGoogle` flips false: the Google row goes, and "Google has been disconnected." shows at the foot of the Sign-in card (it takes the focus); a refusal shows there too ("Could not disconnect Google. Please try again." or the server's reason).
  - 2: Disconnect is **disabled** in the ⋯, with the line under it "Google is your only way to sign in, so it can't be disconnected yet. Set a password first." (the Password row's "Set a password" links to `/forgot-password`) — unlinking is refused server-side (400) too.
  - 3: no Google row (and no ⋯) at all.
- **Automated:** Full (client/src/pages/AccountPage.catalog.test.tsx — PREF-041; client/src/pages/AccountPage.test.tsx — the busy chip, the refusal, the focus and the phone sheet; tests/AllotJar.IntegrationTests/Http/GoogleSignInFlowTests.cs — REG-085 for the server contract incl. the stamp-rotation reissue and the passwordless-refusal)

## Budget currency lock (W08)

### PREF-042 - The API refuses a currency change once the household holds an account, month or transaction
- **Priority:** P0
- **Type:** Negative
- **Origin:** W08 (rules 42/85) — the preference is the own household's budget currency; changing it after money is recorded would relabel that money 1:1.
- **Preconditions:** Bearer token for `owner@example.test` (EUR, locked); HTTP client. For the UI leg, a stale tab opened while unlocked (or a mocked `currencyLocked: false`) so the select is still offered.
- **Steps:**
  1. `PUT /api/auth/preferences` with `preferredCurrency: "USD"` (format valid).
  2. `PUT /api/auth/preferences` with `preferredCurrency: "eur"` and a new first name.
  3. In the stale tab pick "US dollar ($)" and click "Save preferences".
- **Expected:**
  - Step 1: 400 `{"error":"Your budget is in EUR and already has accounts, months or transactions, so its currency can't be changed."}`; nothing is saved (name/format in the same request are not applied either).
  - Step 2: 200 — "eur" normalises to the stored EUR, which is not a change; the name is saved.
  - Step 3: the server's message is shown verbatim in the card's error line above Save (`role="alert"`); the chip and stored currency stay EUR.
  - A household counts as holding something as soon as **any** account (including another login's private one), budget month or transaction exists (`BudgetCurrency.IsFixedAsync` reads past the privacy filters).
- **Automated:** Partial (client/src/pages/AccountPage.test.tsx — "shows the server’s reason when a currency change is refused"; ForeignAmountsTests — `The_budget_currency_is_fixed_once_the_household_holds_anything`; the 400 body of `PUT /auth/preferences` is not asserted)

### PREF-043 - An empty household can still change its currency; the first account, month or transaction fixes it
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed in as `fresh@example.test` (EUR, nothing recorded, `currencyLocked: false`).
- **Steps:**
  1. On `/account`, change "Currency" to "British pound (£)" and save.
  2. Read the user chip; open `/accounts` → **+ Add account**.
  3. Add account "Current"; reload `/account`.
- **Expected:**
  - Step 1–2: success; the chip reads "GBP · Personal" at once (`budgetCurrency` follows the preference while the own household is unlocked); the add form says "The account holds GBP, your budget currency."; the tagline/welcome nouns say "pound".
  - Step 3: the account is GBP; `/auth/me` now returns `currencyLocked: true`, and "Currency" is the read-only "British pound (£)" with its lock and the fixed note behind its (i) (PREF-011). Creating the first budget month instead of an account locks it the same way, and that month is stamped GBP.
- **Automated:** Partial (ForeignAmountsTests — `The_budget_currency_is_the_first_months_else_the_owners_choice`, `The_budget_currency_is_fixed_once_the_household_holds_anything`; the UI flow is not asserted end to end)

### PREF-044 - A member sees the active household's budget currency, whatever their own preference
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** `member@example.test` (own preference **EUR**, own household empty) has joined `owner2@example.test`'s household whose first month is **GBP**; the shared household is active.
- **Steps:**
  1. Read the user chip and `/accounts`, `/transactions`, `/` (Budget).
  2. On `/account`, read "Currency".
  3. Switch to the member's own household and read the chip again.
- **Expected:**
  - Step 1: chip "GBP · {owner2's label}"; amounts, the add-account note ("The account holds GBP, your budget currency.") and "Needs GBP amount" tags use **GBP** (`/auth/me.budgetCurrency` = the active household's). New months/accounts created there are GBP, never the member's EUR.
  - Step 2: "Currency" still shows and edits the member's **own** preference (EUR) — the lock (`currencyLocked`) is about the member's own household, which is empty, so it is a select.
  - Step 3: chip "EUR · Your household".
- **Automated:** No

## Keyboard and small screens (restyle PR 12)

### PREF-045 - The pencil, the dialogs and the ⋯ menus work by keyboard, and fit a phone
- **Priority:** P2
- **Type:** UX
- **Preconditions:** Signed in as `owner@example.test` (password, no Google); for the ⋯ steps, `member@example.test` (joined household, Google only).
- **Steps:**
  1. Tab to the pencil ("Edit name"), press Enter, type, press Escape.
  2. Tab to "Change" (named "Change password"), press Enter; Tab round the dialog; press Escape.
  3. As the member, open the Household ⋯ ("Household: more actions") with Enter, choose "Leave household", then press Escape in the dialog; open the Google ⋯ and read Disconnect.
  4. Repeat 2 on a 375x667 phone.
  5. As the member, view the page 320px wide.
- **Expected:**
  - Step 1: First name takes the focus; Escape puts the saved name back and the focus on the pencil.
  - Step 2: focus opens on the dialog's close control, Tab stays inside the dialog, Escape closes it and the focus returns to "Change".
  - Step 3: the Leave dialog ("Leave {label}’s household?") asks first, with the private-accounts warning when there are any; Escape closes it and the focus returns to the ⋯. Disconnect is disabled with its reason under it; the arrow keys skip it, and the menu itself is described by the reason.
  - Step 4: the dialog is a bottom sheet with a grab handle (its close control, focused); Cancel and "Change password" stay in view, 44px tall, side by side; the fields stack.
  - Step 5: no sideways scroll; the row titles ("Your own budget", "Password", "Google") are whole, and "Set a password" drops to its own line under "Password" rather than cut it.
- **Automated:** Yes (client/src/pages/AccountPage.test.tsx; client/e2e/account-settings.spec.ts — incl. axe scans with each menu and dialog open)
