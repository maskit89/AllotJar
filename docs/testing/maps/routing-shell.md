# AllotJar subsystem map — Client routing, shell, gating, onboarding, analytics

Ground truth as of 2026-07-15, read from `<local>\Documents\Projects\ZeroBudget` (repo `maskit89/AllotJar`; client under `client/`). All paths below are repo-relative unless absolute. Line numbers cited as `path:line`.

Provider mount order (`client/src/main.tsx:12-28`): `StrictMode > BrowserRouter > AuthProvider > FeatureProvider > HouseholdProvider > AnalyticsProvider > OnboardingProvider > App`. `MonthProvider` wraps the `<Routes>` inside `App` itself (`client/src/App.tsx:61`).

---

## 1. Screens & routes

All routes declared in `client/src/App.tsx`. Feature-flag-gated routes are **conditionally mounted** — when the flag is off the `<Route>` element does not exist, so the URL falls through to the `*` catch-all and silently redirects to `/`.

| Path | Element | Guard / gating | Notes |
|---|---|---|---|
| `/login` | `LoginPage` | Public. While `bootstrapping` → `AuthSplash`; if already authenticated → `AuthedLoginRedirect` (App.tsx:51-54,63-68) | Query params: `?register=1` opens the Create-account tab (LoginPage.tsx:21-23); `?returnUrl=` (sanitised by `safeInternalPath`) is honoured after sign-in AND by the already-authed redirect; `?reason=expired` shows the session-expired notice (login mode only, LoginPage.tsx:109-117) |
| `/accept-invite` | `AcceptInvitePage` | Public, **no guard at all** (App.tsx:69) | `?code=` invite token; missing code → inline alert. Signed-in users get a "join with existing login" variant (AcceptInvitePage.tsx:105-120); anonymous users set a password. Success → `navigate('/?joined=1')` or `window.location.assign('/?joined=1')` |
| `/privacy` | `PrivacyPage` | Public, signed in or out (App.tsx:71) | Crawlable legal page |
| `/terms` | `TermsPage` | Public (App.tsx:72) | Crawlable legal page |
| `/` | `bootstrapping ? AuthSplash : isAuthenticated ? DashboardPage : LandingPage` | Split by auth state (App.tsx:73-81) | Landing = public marketing page (CTAs `/login?register=1`, `/login`); splash prevents authed users flashing the landing |
| `/transactions` | `TransactionsPage` | `RequireAuth` | |
| `/accounts` | `AccountsPage` | `RequireAuth` + `features.accounts` (App.tsx:90-99) | Flag off ⇒ route unmounted ⇒ `*` redirect to `/` |
| `/accounts/:id` | `AccountDetailPage` | `RequireAuth` + `features.accounts` | Way back: the top bar's "Back to Accounts" chevron link (AppShell `back`) |
| `/jars` | `JarsPage` | `RequireAuth` + `features.jars` | |
| `/people` | `PeoplePage` | `RequireAuth` + `features.householdAllocation` | People is always in nav (when flag on) regardless of solo/shared |
| `/members` | `<Navigate to="/people" replace/>` | **Unconditionally mounted** (App.tsx:131) | Legacy redirect (old Members page) |
| `/access` | `<Navigate to="/people" replace/>` | Unconditionally mounted (App.tsx:132) | Legacy redirect (old Members & access page) |
| `/allocation` | `AllocationPage` | `RequireAuth` + `features.householdAllocation`; **plus in-page solo guard**: `!householdLoading && !isShared` → EmptyState "Add people first" with an "Add people" button → `navigate('/people')` (AllocationPage.tsx:643-655) | |
| `/reports` | `ReportsPage` | `RequireAuth` + `features.reports` | |
| `/account` | `AccountPage` | `RequireAuth` (always mounted) | Account settings; reached from UserMenu "Account settings" |
| `/import` | `ImportPage` | `RequireAuth` + `features.camtImport` | |
| `/help` | `HelpPage` | `RequireAuth` (always mounted) | |
| `*` | `<Navigate to="/" replace/>` | — (App.tsx:179) | Unknown URLs AND flag-off URLs land here |

**`RequireAuth`** (App.tsx:38-48): while `bootstrapping` renders `AuthSplash` (spinner, `role="status"`, sr-only "Loading…"); unauthenticated → `<Navigate to="/login?returnUrl=<encoded pathname+search>">` (the `returnUrl` suffix is omitted when the target was exactly `/`).

**Overlays mounted outside `<Routes>`** (App.tsx:181-184):
- `{isAuthenticated && !needsConsent && <Onboarding/>}` — onboarding deliberately waits for consent so the focus-trapped welcome can never sit under the blocking consent prompt.
- `{isAuthenticated && <ConsentModal/>}` — z-index `z-[70]`, above onboarding's `z-[60]`.

**AppShell page registrations** (`active` NavKey / sr-only `title`): Dashboard `budget`/"Budget"; Allocation `allocation`/"Income allocation" (both branches); AccountPage `account`/"Account settings" (restyle PR 12: marks the sidebar's account button and the phone More tab); Jars `jars`/"Jars"; Help `help`, no title (renders its own visible header); Accounts `accounts`/"Accounts"; Import `transactions`, no title; AccountDetail `accounts`/`account?.name ?? 'Account'`, with `back={{ to: '/accounts', label: 'Accounts' }}` (the top bar's 40px chevron link "Back to Accounts" before the title, in place of the logo on a phone; the only page with `back`, every other page keeps the logo); People `people`/"People"; Transactions `transactions`/"Transactions"; Reports `reports`/"Reports".

---

## 2. UI controls & user actions (exact labels)

### AppShell (`client/src/components/AppShell.tsx`)
- Skip link **"Skip to main content"** → `#main-content` (main has `tabIndex={-1}`), WCAG 2.4.1 (AppShell.tsx:188-193).
- **Desktop sidebar** (visible ≥900px, `min-[900px]:flex`, `data-tour="sidebar"`): JarLogo + "AllotJar" wordmark, vertical `AppNav`, `UserMenu` pinned bottom (opens upward).
- **Mobile top bar** (<900px): compact logo, horizontally scrollable nav pills, compact `UserMenu` (opens downward).
- **UserMenu** (AppShell.tsx:24-138): trigger button `aria-label="Account menu"`, `aria-haspopup="menu"`, `aria-expanded`; avatar = 2-letter initials. Non-compact chip shows name + `"{budgetCurrency} · {householdLabel}"` (active household's budget currency, W08) (label of active household, fallback `'Personal'`). Dropdown (`role="menu"`) closes on outside `mousedown` or Escape. Items:
  - When `households.length > 1`: header **"Household"** + one `menuitem` button per household (active one bold with `✓`); clicking a non-active one calls `switchHousehold(ownerId)` → `POST /households/switch` then `window.location.assign('/')` (full re-bootstrap).
  - Link **"Account settings"** → `/account`.
  - Button **"Sign out"** → `track(EVENTS.logout)` then `logout()`.
- **One-time greeting banner** (`role="status"`, AppShell.tsx:171-183,237-258) driven by URL params, param stripped immediately via `history.replaceState` so refresh doesn't repeat:
  - `?joined=1`: "You've joined this household — you're viewing its shared budget now. You can switch households anytime from the account menu."
  - `?started=1`: "This is your own budget — set up your first month below. You can switch back to the shared household anytime from the account menu."
  - `?left=1`: "You've left that household — you're viewing your own budget now. Nothing was deleted; you can be invited back anytime." (added by PR #170 so a pure invitee's empty own household doesn't read as data loss)
  - Dismiss button `aria-label="Dismiss"` (✕).
- **Access banner** (`role="status"`, AppShell.tsx:164-169,259-266):
  - `isReadOnly`: "You have read-only access — you can view everything but cannot make changes."
  - `!canWrite && canEnterData` (Limited): "You have limited access — you can record transactions, mark bills paid and run allocation, but not change the budget structure or settings."

### AppNav (`client/src/components/AppNav.tsx:31-40`)
Items (label / to / show condition / `data-tour`):
| Label | to | show | data-tour |
|---|---|---|---|
| Budget | `/` | always | `nav-budget` |
| Transactions | `/transactions` | always | `nav-transactions` |
| Accounts | `/accounts` | `features.accounts` | `nav-accounts` |
| Jars | `/jars` | `features.jars` | `nav-jars` |
| Reports | `/reports` | `features.reports` | `nav-reports` |
| People | `/people` | `features.householdAllocation` | `nav-people` |
| Allocation | `/allocation` | `features.householdAllocation && isShared` | `nav-allocation` |
| Help | `/help` | always | `help` |
Active item gets `aria-current="page"` (filled marker in sidebar, filled pill in topbar). Every click fires `track(EVENTS.navClick, { destination: to })`. Both variants are `nav aria-label="Primary"`.

### TopBar (`client/src/components/TopBar.tsx`, `data-tour="topbar"`)
- Buttons `aria-label="Previous month"` (‹) and `aria-label="Next month"` (›); month label `<h2>` e.g. "July 2026" (from MonthContext); **"Zero-based"** pill; `ThemeToggle` on the right. Rendered by AppShell on **every** authenticated page (including non-month pages like Help/Account).

### ThemeToggle (`client/src/components/ThemeToggle.tsx`)
- `role="group" aria-label="Theme"`; two buttons, visible text "light"/"dark" (capitalized via CSS), `aria-label` "Light mode"/"Dark mode", `aria-pressed` on selected. Choosing persists `localStorage['zbb.theme']`, toggles `document.documentElement.classList 'dark'`, fires `track(EVENTS.themeChanged, { theme })`. Until an explicit choice exists it follows OS `prefers-color-scheme` **live** (matchMedia change listener active only while `zbb.theme` unset). Also rendered on LoginPage and AcceptInvitePage (top-right).

### StagingBanner (`client/src/components/StagingBanner.tsx`)
- Renders **only when `IS_STAGING`** (`VITE_APP_ENV === 'staging'`, `client/src/lib/env.ts:9-16`); GA/prod build renders nothing. Sticky amber strip, `role="status"`: "**Staging** — this is the AllotJar test environment. Features may change and your data can be reset or lost without notice." Mounted in AppShell (above `<main>`), LoginPage, and LandingPage (SSR-safe: no hooks/browser globals, included in the landing prerender).

### ConsentModal (`client/src/components/ConsentModal.tsx`)
- Blocking dialog for logins created FOR someone (owner-set password / legacy pre-terms accounts) with `needsConsent` from `/auth/me`. Title "**One thing before you start**"; body links **Terms of Service** (`/terms`) and **Privacy Policy** (`/privacy`) opening in new tabs; buttons **"Sign out"** and **"I agree"** ("Please wait…" while busy). Error (`role="alert"`): "Something went wrong saving your agreement — please try again." Not dismissible (no X, no backdrop close). **Suppressed on `/terms` and `/privacy` paths** so it never covers the text being consented to (ConsentModal.tsx:20-22). Agree → `POST /auth/consent` → `needsConsent=false`.

### Onboarding — WelcomeDialog (`client/src/onboarding/WelcomeDialog.tsx`)
- `role="dialog" aria-modal="true"`, focus-trapped via `useDialogA11y` (Escape closes = dismiss, focus restored on close). Title "**Welcome to AllotJar**". Copy branches on `joined` (active household exists and `!isOwn`): member-joining copy ("You've joined a shared household budget…") vs owner copy ("…Setting up your first month takes a few minutes…"); both use `currencyNoun(budgetCurrency)` ("give every euro a job"; W08 — the active household's budget currency, not the login's preference). Three bullets each variant. Buttons: **"Skip for now"** (dismiss) and **"Take the tour"** (start tour). Close X `aria-label="Close"`; backdrop click also dismisses.

### Onboarding — SpotlightTour (`client/src/onboarding/SpotlightTour.tsx`, steps in `tourSteps.tsx`)
- **9 steps** (`TOUR_STEP_COUNT`): `nav` (→`[data-tour="sidebar"]`), `month` (→`topbar`), `goal` (→`remaining-banner` on the Dashboard hero), `transactions` (→`nav-transactions`), `accounts` (→`nav-accounts`), `jars` (→`nav-jars`), `reports` (→`nav-reports`), `people` (→`nav-people`), `done` (no selector, centred). Header "**Step {n} of 9**". Buttons: **"Skip tour"** (endTour), **"Back"** (only when step>0), **"Next"** / **"Finish"** (last step). Progress dots. Target missing or off-screen (mobile top bar hides the sidebar; flag-off nav item; no budget yet) → centred card fallback (`onScreen` check, tooltipStyle placement below/above/side/centre). Focus moves to the step heading on each step change. Escape ends the tour. The `goal` step body speaks the user's currency noun.
- Note: the dimmed backdrop catches clicks (page inert), and step navigation is linear (next clamps to last, prev to 0).

### Onboarding — GettingStartedChecklist (`client/src/onboarding/GettingStartedChecklist.tsx`)
- `section aria-label="Getting started"`, pinned bottom-right (`fixed bottom-4 right-4 z-40`, w-80). Header "**Getting started**" + "{n} of 5 done"; `role="progressbar"` `aria-label="Onboarding progress"` (valuemin 0, valuemax 5). Buttons: `aria-label="Collapse getting started"` (chevron → collapsed pill "**Getting started · {n}/5**" which re-opens) and `aria-label="Dismiss getting started"` (X → persists `checklistDismissed`).
- 5 steps (label / hint / link target / done condition):
  1. **"Create your first month"** / "Start blank or pick a template — later months can copy the previous one." / `/` / any row from `GET /budget/months`
  2. **"Plan your income"** / "Add what you expect to earn this month." / `/` / `totalIncome > 0` on `GET /budget/{currentYear}/{currentMonth}`
  3. **"Add a jar"** / "A yearly bill, a holiday or a rainy-day pot." / `/jars` / any row from `GET /jars` (jar setup plan, PR 3; left out while the `jars` flag is off, which leaves 4 steps)
  4. **"Give every {noun} a job"** / "Assign it all until Remaining reaches zero." / `/` / `income > 0 && remainingToBudget === 0` (PR #172 semantics)
  5. **"Log your first transaction"** / "Record real spending and assign it to a line." / `/transactions` / any row from `GET /transactions`
- All done: "**All set — every {noun} has a job! 🎉**" + button **"Hide this checklist"** (dismiss).
- Refreshes progress on mount, on every `location.pathname` change, and on window focus (4 GET calls each time: `/budget/months`, `/budget/{y}/{m}`, `/jars`, `/transactions`).
- **Hidden entirely when the active household is one the user joined** (`activeHousehold && !activeHousehold.isOwn` → `return null`, lines 74-75) — an owner-oriented checklist.
- The "current month" for steps 2 and 4 is today's month, read on every check (`currentMonth(new Date())`), so a tab left open over a month's end asks about the new one.

### Analytics — ConsentBanner (`client/src/analytics/ConsentBanner.tsx`)
- Non-modal `role="region" aria-label="Analytics consent"` pinned bottom (`z-50`). Text: "We use **Google Analytics** to understand how the app is used and improve it. We never send your name, email, account names or any amounts — only anonymous usage. You can change this anytime under **Help**." Buttons **"Decline"** / **"Accept"**. Shown only when `features.analytics && consent === null` (AnalyticsProvider.tsx:106) — i.e. on the flag alone, even with no measurement ID.

### HelpPage (`client/src/pages/HelpPage.tsx`)
- PageHeader title "**Help & guide**", subtitle "How each part of AllotJar works."; action button **"Replay welcome tour"** → `onboarding.replay()` (re-opens welcome + restores checklist; fires `tour_replayed`).
- 10 topic cards: "Zero-based budgeting", "Months & appearance", "Transactions", "Bills & due dates", "Accounts", "Saving with jars", "Reports", "People & allocation", "Your account", "Good to know". "Good to know" contains external link **"complete user guide"** → `https://github.com/maskit89/AllotJar/blob/main/docs/USER_GUIDE.md` (new tab, fires `help_guide_opened`).
- **"Privacy & analytics"** card only when `features.analytics` (`available`): status text "Status: **Analytics is on** / **Analytics is off** / **Not chosen yet**. You can change this at any time."; button **"Turn off analytics"** (when granted → `decline()`) or **"Turn on analytics"** (otherwise → `accept()`).

### LoginPage (route-relevant controls; `client/src/pages/LoginPage.tsx`)
- Segmented control `aria-label="Sign in or create an account"` with options **"Sign in"** / **"Create account"**.
- Session-expired notice (`role="status"`, only when `?reason=expired` and mode=login): "Your session has expired, so we signed you out to keep your budget safe. Sign back in to pick up where you left off." (PR #169)
- Register-only controls: First name / Last name (required), Currency + Number format selects (locale-detected defaults), opt-in checkbox "**Start with sample figures to explore — example groups and amounts you can edit or delete anytime. Leave unticked to start with an empty budget.**" (default **unchecked**, PR #170); required terms checkbox ("I agree to the Terms of Service and Privacy Policy."); **staging-only** required checkbox "I understand this is the AllotJar **staging** test environment, and that my data may be reset or permanently lost." (rendered only when `IS_STAGING`; client-gated only, not persisted server-side).
- Submit button "Sign in" / "Create account" / "Please wait…" (busy). Footer tagline "Give every {noun} a job."

### AccountPage household/gating rows (`client/src/pages/AccountPage.tsx`; restyle PR 12)
- Profile: the name, the email and the **access level** chip (`HOUSEHOLD_ROLE_LABELS[role] ?? 'Member'` → Owner/Admin/Limited/Read-only; what it allows behind its (i)).
- Household card, "**Your own budget**" row only when `!ownsHousehold`: button **"Start"** (named "Start my own budget"; "Setting up…" busy) → `POST /households/start-own` → `window.location.assign('/?started=1')`. Never seeds sample data (PR #170).
- Household card, sharing row gated on `!householdLoading`: shared → faces ("Shared between {N} people") + names, the row one link **"Manage people"** (`/people`); solo → "Just you" ("You're budgeting on your own…" behind its (i)) + button **"Share this budget"** → `/people`.
- Leave household only when the active household is joined (`!isOwn`): the Household card's ⋯ → **"Leave household"** → the Leave dialog "Leave {label}’s household?" — **"Yes, leave"** (tinted danger, "Leaving…" busy) / **"Cancel"** → `POST /households/leave {ownerId}` → `window.location.assign('/?left=1')`.

### Orphan: HouseholdSwitcher (`client/src/components/HouseholdSwitcher.tsx`)
- A `select aria-label="Active household"` (hidden when `households.length < 2`). **Not imported by any page/shell** — only its own test references it; live switching happens in the AppShell UserMenu. Treat as dead UI (do not write E2E against it).

---

## 3. API endpoints touched by this subsystem

| Verb + route | Auth / gating | Consumer |
|---|---|---|
| `GET /api/features` | **Anonymous** (`FeaturesController.cs:12-26`) | `FeatureProvider` fetches once on mount; merges `{...ALL_ON, ...data}`; fetch failure silently keeps defaults (everything on, `analytics: false`) |
| `GET /api/members` | `[Authorize]` + `[FeatureGate(HouseholdAllocation)]` → **404 when flag off** (`MembersController.cs:19-32`) | `HouseholdProvider` (on auth change + `refresh()`); non-array/error → `[]` (solo) |
| `GET /api/auth/me` | `[Authorize]` | `AuthProvider` on every token change; supplies role, names, prefs, `households[]`, `ownerId`, `needsConsent`. Malformed response (no numeric `role`) is ignored — never downgrades role (AuthContext.tsx:239-240) |
| `POST /api/auth/refresh` | `[AllowAnonymous]`, rate-limit "auth" | `refreshSession()` single-flight only (`lib/api.ts:100-129`); cold-load bootstrap, 401-retry interceptor, focus/visibility revalidation. Server has a 30s replay-grace window (PR #171); the grace 401 must not clear the cookie |
| `POST /api/auth/login` / `POST /api/auth/register` | Anonymous, rate-limit "auth" | LoginPage (register carries `includeSampleData`) |
| `POST /api/auth/logout` | `[AllowAnonymous]` | `logout()` — fire-and-forget (`.catch(() => {})`), UI clears state immediately + broadcasts sign-out |
| `POST /api/auth/consent` | `[Authorize]` | ConsentModal "I agree" |
| `POST /api/auth/accept-invite` | `[AllowAnonymous]`, rate-limit | AcceptInvitePage (with password for new logins; token-only for signed-in joins) |
| `POST /api/auth/change-password` | `[Authorize]`, rate-limit | AccountPage; response carries fresh token+cookie which the client adopts |
| `PUT /api/auth/preferences` | `[Authorize]` | AccountPage preferences form |
| `POST /api/households/switch` | `[Authorize]` (`HouseholdsController.cs:19-41`) | UserMenu household item → then `window.location.assign('/')` |
| `POST /api/households/start-own` | `[Authorize]` | AccountPage → `'/?started=1'` |
| `POST /api/households/leave` | `[Authorize]` (400 possible) | AccountPage → `'/?left=1'` |
| `GET /api/budget/months`, `GET /api/budget/{year}/{month}`, `GET /api/transactions` | `[Authorize]` | GettingStartedChecklist progress polling |

**401 interceptor contract** (`lib/api.ts:136-168`): on 401 from any endpoint NOT in `CREDENTIAL_ENDPOINTS = ['/auth/login','/auth/register','/auth/refresh','/auth/accept-invite','/auth/logout']` (matched by `url.includes`, an explicit LIST not a prefix — PR #169), refresh once via single-flight and retry once (`__retried` flag); refresh failure → `sessionExpired()` → clear token, notify AuthContext (`expired` handler clears localStorage identity + `broadcastSignOut()`), redirect to `/login?reason=expired[&returnUrl=…]` (no redirect if already on `/login`, `loginRedirectPath` lib/api.ts:66-71). Every failed request also fires `track('api_error', { api_endpoint: <redacted template>, api_status })`.

**Server feature gate**: `FeatureGateAttribute` (`src/AllotJar.Api/Features/FeatureGateAttribute.cs`) returns **404** (not 403) for any action whose flag is off — so a flag-off feature is unusable even by direct API call. Flags: Accounts, MultiCurrency (since W08 it only hides the Transactions add form's "Paid in another currency" option and the account currency labels; waiting rows can still be confirmed with it off), CamtImport, Reports, Jars, HouseholdAllocation, HouseholdAccess (all default **true**), Analytics (default **false**) — `src/AllotJar.Api/Features/FeatureFlags.cs`.

---

## 4. Validation rules & exact error messages

- **`safeInternalPath`** (`client/src/lib/returnUrl.ts`): a `returnUrl` is accepted only if it starts with `/`, does NOT start with `//` or `/\`, and contains no control chars (0x00–0x1F, 0x7F — WHATWG parsers strip them, enabling `//evil` smuggling). Otherwise `null` ⇒ fallback `/`. Applied at: AuthedLoginRedirect (App.tsx:53), LoginPage post-auth navigate (LoginPage.tsx:25).
- **LoginPage**: email `type=email required`; password `required minLength={8}` placeholder "At least 8 characters"; register also requires firstName/lastName (`required`), terms checkbox (`required`), staging checkbox (`required`, only rendered when `IS_STAGING`). Sample-data checkbox never required. API error display (`role="alert"`): `data.error ?? data.errors.join(' ') ?? 'Something went wrong.'`.
- **ConsentModal** error (`role="alert"`): "Something went wrong saving your agreement — please try again."
- **AccountPage change password** (client-side, before POST): "The new passwords do not match." / "Use a new password of at least 8 characters."; server fallback "Could not change your password."; success `role="status"` "Your password has been changed."
- **AccountPage preferences**: fallback "Could not save your preferences."; success "Your preferences have been saved."
- **AccountPage household actions**: "Could not start your budget. Please try again." / "Could not leave this household. Please try again."
- **AcceptInvitePage**: missing code → "This invite link is missing its code. Ask the household owner to send you a fresh link."; server error extraction: field errors → `data.error` → `data.title` → "This invite link is invalid or has expired."; non-axios → "Something went wrong."
- **Session expiry** (PR #169): login-page notice text in §2; the expired redirect always carries `reason=expired`, plus `returnUrl` when the user wasn't at `/`.
- **Silent-failure contexts**: FeatureProvider, HouseholdProvider, checklist fetches, and `logout()`'s POST all swallow errors with no user-visible message (by design).

---

## 5. State variants

- **Bootstrapping**: cold load with no in-memory token → `AuthSplash` on `/`, `/login`, and every RequireAuth route while `refreshSession()` runs once (single-flight; StrictMode-safe). Success re-hydrates auth; failure lands on login/landing.
- **`/` duality**: anonymous → LandingPage (marketing, prerendered, StagingBanner on staging); authed → DashboardPage.
- **Solo vs shared** (`client/src/features/HouseholdContext.tsx`): `isShared = members.length >= 2` (`SHARED_THRESHOLD = 2`; 0 and 1 members are both solo). No-provider default: `{isShared:false, loading:true}` — loading stays true so multi-member UI never flashes in tests. Effects: Allocation nav item hidden; `/allocation` in-page EmptyState; AccountPage's sharing row ("Just you" vs faces); TransactionsPage member selects (elsewhere). There is **no 0-member state in real data** — registration materialises the owner as member #1 (`OwnerMemberSeeder`, PR #97); an empty `/members` reply still behaves as solo.
- **Feature flag off**: nav item absent + SPA route unmounted (URL redirects to `/`) + server endpoints 404. **Flash caveat**: client defaults are all-on, so between first paint and the `/features` response, flag-off nav items are visible and their routes mounted; they disappear when flags load (tests assert with `waitFor` removal — `AppNav.test.tsx:71-83`).
- **`analytics` flag variants**: flag off (default) → no banner, no Help card, `useAnalytics().available=false`. Flag on + no `VITE_GA_MEASUREMENT_ID` → banner and Help card show, Accept persists but nothing loads (gtag inert). Flag on + ID + consent granted → tracking live. Consent stored in `localStorage['zbb.analyticsConsent']` (`granted`/`denied`; anything else = undecided → banner).
- **Role variants** (`AuthContext`): `role` numeric — Owner 0, Admin 1, Limited 2, ReadOnly 3. Derived: `canManageHousehold = role===0`, `canWrite = role<=1`, `canEnterData = role<=2`, `isReadOnly = role===3`. Role is seeded from `localStorage['zbb.role']` (malformed → Owner) and corrected when `/auth/me` resolves — write-gated controls can be visible for a moment on cold load and must disappear once `/auth/me` lands (this is exactly what `RoleGating.test.tsx` asserts). Read-only/Limited get the AppShell banner (§2).
- **needsConsent**: blocks the whole app behind ConsentModal (Onboarding not even mounted); exits: "I agree" (POST /auth/consent) or "Sign out". Invisible on `/terms` & `/privacy`.
- **Onboarding phases**: `idle | welcome | tour` + independent `checklistVisible`. Per-user record `localStorage['zbb.onboarding:{email}']` = `{v:1, welcomeSeen, tourDone, checklistDismissed}` (missing/malformed → defaults). Welcome auto-opens only while `welcomeSeen=false`; re-evaluated whenever the signed-in email changes. `replay()` (Help) reopens welcome + un-dismisses checklist but keeps `welcomeSeen=true`. Checklist renders only in phase `idle`; collapse (session-only `open` state) ≠ dismiss (persisted). Checklist hidden when viewing a joined household. No email (null) → record can't persist (`persist` skips), welcome would re-open each mount.
- **Theme**: `localStorage['zbb.theme']` = `light`/`dark`; unset ⇒ follow OS live. `client/public/theme-init.js` applies the class pre-paint (external script for CSP `script-src 'self'`). The key is device-wide, not per-user.
- **Staging vs GA build**: `IS_STAGING` is build-time (`VITE_APP_ENV=staging` set by deploy.yml); banner + register staging-checkbox cannot be toggled at runtime. Local dev is non-staging.
- **Month context** (`client/src/features/MonthContext.tsx`): in-memory only — resets to the current calendar month on every full reload (including household switch / start-own / leave / session-expiry bounce); not in the URL. All month-scoped pages move together. No min/max clamp: prev/next roll over years indefinitely.
- **Households list variants**: 0 or 1 households → no "Household" section in UserMenu; `ownsHousehold = households.some(h => h.isOwn)` gates the "Your own budget" row; `activeHousehold.isOwn` gates checklist + Leave household (the Household ⋯) + welcome copy.
- **Greeting params**: joined/started/left — each shows once, stripped from the URL immediately.
- **Empty/loading/error in shell**: greeting/access banners are independent; Dashboard's `notFound` create-month heroes differ by `canWrite` ("Ask an admin or the owner to set this month up." for non-writers, DashboardPage.tsx:485-494).

---

## 6. Computed/derived values & money rules

- **`isBalanced(m) = totalIncome(m) > 0 && remainingToBudget(m) === 0`** (`client/src/budgetModel.ts:105-106`, mirrors Domain `BudgetMonth.IsBalanced` — PR #172). `remainingToBudget = totalIncome − monthPlanned`, all integer minor units.
- **Dashboard hero footnote** (DashboardPage.tsx:558-598): `empty = incomeMinor === 0 && allottedMinor === 0`; `balanced` → gold badge "Every {noun} has a job"; `empty` → "Plan your income, then give every {noun} a job"; `remaining < 0` → "{amount} over-budgeted — trim a line"; else "{amount} still to assign". The hero carries `data-tour="remaining-banner"` (tour step 3 anchor).
- **Checklist progress**: step dones per §2; bar width = `(doneCount / 4) * 100%`.
- **`initialsOf(name, email)`** (AppShell.tsx:12-16): first letters of the first two whitespace-separated words, uppercased; fallback = first char of email uppercased; fallback `'?'`.
- **`currencyNoun(code)`** (`client/src/lib/money.ts:130-133`): ISO code → singular noun (EUR→euro, USD→dollar, …), unknown/empty → `'unit'`. Used in welcome, tour step 3, checklist, hero badge, Help, login tagline. Tour step count is invariant to the noun.
- **Month label** = `MONTH_NAMES[month-1] + ' ' + year`; `goPrev`/`goNext` roll over Dec↔Jan adjusting year (MonthContext.tsx:53-60); each fires `month_navigated {direction}`.
- **Analytics redaction** (`client/src/analytics/redact.ts`):
  - `redactPath`: strip query/hash + trailing slashes; each segment replaced with `:id` if pure-number, UUID-prefix, ≥16-char hex, or >16 chars containing a digit.
  - `apiEndpointTemplate(url)`: same collapsing for axios-relative URLs; `undefined` → `'unknown'`.
  - `safeParams`: only whitelisted keys with primitive values pass — `method, line_type, direction, report_type, destination, theme, row_bucket, count_bucket, status, kind, split, step, source, context, api_endpoint, api_status, error_kind, consent, sample_data`. Everything else silently dropped.
  - `bucketCount(n)`: `0`, `1`, `2-10`, `11-50`, `51-200`, `200+` (non-finite/≤0 → `0`).
- **`hashUserId(email)`** (`client/src/analytics/hash.ts`): SHA-256 of `"zbb.analytics.v1:" + trimmed-lowercased-email`, first 32 hex chars; falls back to double FNV-1a (16 hex) when `crypto.subtle` is unavailable. Raw email never sent.
- **gtag start sequence** (`client/src/analytics/gtag.ts:68-91`): Consent Mode v2 default all-denied → inject script → `config` with `send_page_view:false, anonymize_ip:true, allow_google_signals:false, allow_ad_personalization_signals:false` → `consent update analytics_storage:'granted'`. Page views are synthetic (`page_path` + origin-prefixed `page_location` from the redacted path) — real URLs (ids, `?token=`) never reach GA.
- **Access-token expiry**: `isAccessTokenExpired()` = in-memory token exists AND `Date.now() >= expiresAtUtc` (lib/api.ts:30-32); drives focus/visibility revalidation (AuthContext.tsx:162-178).
- Money in this subsystem is display-only: minor-unit integers formatted via `formatMoney`; no float math anywhere.

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **Single-flight refresh (guardrail, PR #157/#171)**: `refreshSession()` in `lib/api.ts` is the ONLY legal way to hit `POST /auth/refresh`. Any second concurrent POST presents a just-rotated cookie and trips server reuse detection, burning the whole session family. Server-side 30s grace (PR #171) covers a restored second tab replaying with the stale cookie; that grace 401 must NOT clear the shared cookie. Regression tests: two tabs + refresh race must not sign the user out.
2. **Session-expiry flow (PR #169)**: genuinely dead session → `sessionExpired()` → in-memory token cleared, localStorage identity (`zbb.email`, `zbb.role`, `zbb.displayName`) cleared, `BroadcastChannel('zbb.auth')` message `'signed-out'` to other tabs (receive-only handler, no re-broadcast loops), redirect `/login?reason=expired&returnUrl=…`. `loginRedirectPath` returns null when already on `/login` (no loop). Tabs also revalidate on window focus/visibilitychange when the token's lifetime lapsed. Environments without BroadcastChannel degrade to per-tab.
3. **Credential-endpoint 401 exemption is a LIST** (PR #169): `/auth/me`, `/auth/preferences`, `/auth/change-password` MUST refresh-and-retry; a blanket `/auth/` prefix once made `/account` a dead end. Test: expired token on `/account` actions should silently refresh, not error.
4. **Sample budget is opt-in (PR #170)**: register checkbox default OFF ⇒ completely empty account; `households/start-own` and `households/leave` never seed. `sign_up` GA event carries `sample_data` (whitelisted param). The empty default makes the Dashboard create-month hero the standard first-run landing.
5. **Empty month ≠ balanced (PR #172)**: `IsBalanced` requires `TotalIncome > 0` on both domain and client selector; empty-month hero shows "Plan your income…" instead of the gold badge; checklist step 3 requires income > 0. A blank month for a jar-owning household lands **over-budgeted** (accrual-planned savings lines), showing the rose "over-budgeted — trim a line" pill. Don't regress to bare `remaining == 0`.
6. **GA param whitelist**: any new `track()` param key must be added to `ALLOWED_PARAM_KEYS` in `redact.ts` or it is **silently dropped** (bit the team with `sample_data`; nothing errors, tests stay green).
7. **Analytics triple gate**: tracking starts only when `features.analytics` (server, ships OFF) AND `VITE_GA_MEASUREMENT_ID` (build-time; ONLY the production build has `G-55WS48MJ91` injected by deploy.yml — the staging build omits it, so analytics is inert there) AND stored consent `granted`. The banner shows on the flag alone. Observed implementation detail (QA-relevant): `gtag.ts` has no stop path — after **"Turn off analytics"** in Help, `isStarted()` stays true for the current page lifetime, so `track()` calls keep emitting until the next full reload (the persisted `denied` prevents the NEXT session from starting; no `consent update: denied` is sent in-session). Also `startTracking` is once-per-page-load: decline→accept in one session re-runs only the provider effect (idempotent `start()`).
8. **Onboarding vs consent z-order**: Onboarding is not mounted while `needsConsent` (App.tsx:183) AND ConsentModal is z-70 over onboarding's z-60 — a focus-trapped welcome must never sit unreachable under the consent prompt.
9. **Onboarding persistence is per-user AND per-browser**: key `zbb.onboarding:{email}` — a returning user on a new device sees the welcome again; two users on one device each get their own record; household switching does not reset it (email unchanged). Replay keeps `welcomeSeen: true` (no auto-reopen next visit).
10. **Checklist is owner-only**: hidden when the active household is joined (`!isOwn`) — otherwise it would nag about a budget that isn't theirs or show pre-ticked. Also note it re-fires 3 API calls on every route change and window focus.
11. **Flag-off flash**: FeatureContext defaults all-on (except analytics) until `/features` responds; `/features` failure keeps all-on permanently for the session. Nav items/routes for genuinely-off flags therefore appear briefly and then vanish. Server-side FeatureGate 404s are the real enforcement.
12. **Household switch is a full reload**: `switchHousehold`/`startOwnBudget`/`leaveHousehold` end in `window.location.assign` — every context re-bootstraps, month view resets to current month, greeting param explains the landing. The greeting is stripped via `history.replaceState` so back/refresh won't repeat it.
13. **Solo threshold is exactly 2** (`SHARED_THRESHOLD`, PR #97): 1 member = solo (a person IS a member; no 0-member state exists in real data — owner is materialised as member #1 at registration). `HouseholdContext.refresh()` must be called after member add/archive for the Allocation nav item to reveal/hide live (PeoplePage does this).
14. **Role display gating is client-side cosmetics**: role seeds from `zbb.role` localStorage (default Owner) until `/auth/me` corrects it; malformed `/auth/me` never downgrades. Real enforcement is server-side; QA should verify both the eventual UI hiding (RoleGating.test.tsx pattern: controls disappear after `/auth/me` resolves) and server 403/404s.
15. **Staging gating is build-time**: `IS_STAGING` from `VITE_APP_ENV=staging` — banner + register data-loss checkbox exist only in the staging bundle (staging.allotjar.com). The checkbox is client-required only, never persisted. production build (the `deploy-production` job) has neither. Local dev/tests are non-staging unless the env var is mocked (`vi.mock('../lib/env')`).
16. **Theme pre-paint script**: `public/theme-init.js` is an external same-origin script because the CSP is `script-src 'self'` (no inline). Dark = stored `'dark'` OR (no stored value AND OS dark). ThemeToggle then follows OS changes live only until an explicit pick.
17. **returnUrl open-redirect defence**: `safeInternalPath` rejects absolute/scheme-relative/backslash/control-char values (see §4) — used on both the login redirect and the already-authed `/login` visit. `/accept-invite?code=…` round-trips through it for the "sign in first" path.
18. **Tour anchors are a contract**: `data-tour` values `sidebar`, `topbar`, `remaining-banner`, `nav-transactions`, `nav-accounts`, `nav-jars`, `nav-reports`, `nav-people`, `help` (AppNav renders `nav-{key}` except Help). Removing/renaming any leaves that tour step gracefully centred (not broken) — but the spotlight is lost; on mobile (<900px) the sidebar steps always centre.
19. **`onboarding_step_completed`** is defined in `events.ts:62` but never fired anywhere — dead event; don't write assertions expecting it.
20. **`/members` and `/access` legacy redirects** are always mounted (even with `householdAllocation` off, they land on `/people`'s absent route → `*` → `/`).
21. **Test-mock invariant** (PR #169): any `vi.mock('../lib/api')` must spread `importOriginal` first — AuthProvider guards `typeof setSessionHandlers/isAccessTokenExpired/refreshSession !== 'function'` against incomplete mocks, so an unspread mock silently disables session plumbing in tests.
22. **HelpPage has no AppShell `title`** — it renders its own visible header via PageHeader; every screen must expose exactly one h1 (AppShell renders `title` as sr-only h1 for the others).
23. **`zbb.*` localStorage keys kept post-rebrand** (rebrand #123): `zbb.theme`, `zbb.email`, `zbb.role`, `zbb.displayName`, `zbb.currency`, `zbb.budgetCurrency` (W08), `zbb.numberFormat`, `zbb.analyticsConsent`, `zbb.onboarding:{email}`, BroadcastChannel `zbb.auth`. Don't rename in tests.
24. **Access token lives only in memory** (never localStorage) — any hard navigation requires the cookie bootstrap; `zbb.email`/`zbb.role`/`zbb.displayName` are display-hydration caches only, not credentials.

---

## 8. File index (read for this map)

Client (all under `<local>\Documents\Projects\ZeroBudget\client\`):
- `index.html` (theme-init hookup, SEO/OG head), `public/theme-init.js`
- `src/main.tsx`, `src/App.tsx`
- `src/auth/AuthContext.tsx`
- `src/lib/api.ts`, `src/lib/authChannel.ts`, `src/lib/env.ts`, `src/lib/returnUrl.ts`, `src/lib/money.ts` (currencyNoun/defaults excerpt)
- `src/features/FeatureContext.tsx`, `src/features/HouseholdContext.tsx`, `src/features/MonthContext.tsx`
- `src/components/AppShell.tsx`, `src/components/AppNav.tsx`, `src/components/TopBar.tsx`, `src/components/ThemeToggle.tsx`, `src/components/StagingBanner.tsx`, `src/components/ConsentModal.tsx`, `src/components/HouseholdSwitcher.tsx` (`Hero.tsx` was removed in restyle PR 11)
- `src/onboarding/Onboarding.tsx`, `src/onboarding/OnboardingContext.tsx`, `src/onboarding/WelcomeDialog.tsx`, `src/onboarding/SpotlightTour.tsx`, `src/onboarding/tourSteps.tsx`, `src/onboarding/GettingStartedChecklist.tsx`, `src/onboarding/useDialogA11y.ts`
- `src/analytics/AnalyticsProvider.tsx`, `src/analytics/analytics.ts`, `src/analytics/gtag.ts`, `src/analytics/consent.ts`, `src/analytics/events.ts`, `src/analytics/redact.ts`, `src/analytics/hash.ts`, `src/analytics/RouteAnalytics.tsx`, `src/analytics/ConsentBanner.tsx`, `src/analytics/index.ts`
- `src/pages/HelpPage.tsx`, `src/pages/LoginPage.tsx`, `src/pages/AcceptInvitePage.tsx`, `src/pages/AccountPage.tsx`, `src/pages/AllocationPage.tsx` (solo guard), `src/pages/DashboardPage.tsx` (create-month heroes + balanced/empty hero), `src/pages/LandingPage.tsx` (link/banner grep)
- `src/budgetModel.ts` (isBalanced/remainingToBudget), `src/types.ts` (FeatureFlags, HouseholdRole, HouseholdSummary, MeResponse, HouseholdMemberDto)
- Tests consulted: `src/pages/RoleGating.test.tsx`, `src/components/AppNav.test.tsx`, `src/budgetModel.test.ts` (empty-month case)
- E2E present (not read in depth): `e2e/a11y.spec.ts`, `e2e/mobile-layout.spec.ts`, `e2e/landing.spec.ts`, `e2e/legal.spec.ts`, `e2e/mocks.ts`; journey layer `e2e-journey/`

Server (under `<local>\Documents\Projects\ZeroBudget\src\AllotJar.Api\`):
- `Features/FeatureFlags.cs`, `Features/FeatureGateAttribute.cs`, `Controllers/FeaturesController.cs`
- `Controllers/AuthController.cs` (route/auth attributes), `Controllers/HouseholdsController.cs` (switch/start-own/leave), `Controllers/MembersController.cs` (Authorize + FeatureGate)

Memory/audit notes cross-checked (claims verified against code above): `solo-friendly-household.md`, `staging-beta-coming-soon.md`, `analytics-ga4.md`, `optional-sample-budget.md` (all under `<local>\.claude\projects\C--Users-Laptop-Documents-Projects\memory\`).
