# UX states — responsive, dark, accessibility, errors (cross-feature sweep)

**ID prefix:** UX | **Scope:** The holistic, cross-feature layer of the QA catalog: the presentation-state conventions that every page must obey rather than any single feature's behaviour. It covers the automated axe WCAG 2.2 AA sweep (light + dark) on every route, keyboard-only navigation and focus management through the shared shell, screen-reader structure (one h1 per page, landmark labelling, live regions), token-level dark-mode inversion (including the import-page slate-remap gotcha), the 375 px mobile no-horizontal-scroll guarantee (tables scroll inside their own container), empty/loading/error-state conventions built on the shared `EmptyState` / `ErrorBanner` / `role="status"` primitives, network-failure / offline-mid-action handling, `prefers-reduced-motion`, and banner/status/overlay stacking and z-order. These cases assert the *convention* and its cross-page consistency; they reference the per-feature functional cases by ID instead of re-testing them. | **Out of scope:** per-feature empty/loading/error behaviour lives in the owning area files — dashboard hero + budget grid in `06-dashboard-budget-view.md`, accounts/reconciliation in `12-accounts-reconciliation.md`, jars in `13-jars.md`, import in `15-import.md`, transfers in `11-transfers.md`, reports in `18-reports.md`; theme-toggle mechanics + no-flash + preferences in `04-account-preferences.md`; onboarding/consent dialog mechanics in `05-onboarding.md`; session-expiry/refresh internals in `03-session-auth-lifecycle.md`; role-gated banners in `25-roles-permissions.md`; landing/legal a11y in `01-landing-public.md`.

**Test data setup:** Two worlds are assumed. (1) *Real backend* — a signed-in Owner of a seeded EUR household "Home" with a budget for the current month (one Income group + at least one expense group with a bill line), two EUR accounts ("Joint" 1,250.00 and "Cash" 40.00), and at least one active jar ("Emergency Fund"). (2) *Stubbed Playwright* — `client/e2e/mocks.ts` `authedSetup(page, theme)` with every feature flag ON, `AUTHED_ROUTES = ['/', '/transactions', '/accounts', '/jars', '/people', '/allocation', '/reports', '/import', '/help', '/account']`, fixtures always the happy path. Shared UI primitives under test: `client/src/components/ui.tsx` (`Card`, `Button`, `Input`, `Select`, `Badge`, `PageHeader`, `SegmentedControl`, `ErrorBanner` `role="alert"`, `EmptyState`), the design tokens + `.dark` slate-ramp inversion + `:focus-visible` ring + `prefers-reduced-motion` reset in `client/src/index.css`, and the shell in `client/src/components/AppShell.tsx`.

---

## Accessibility — axe WCAG 2.2 AA sweep (light + dark)

### UX-001 - Every authenticated route is axe-clean (WCAG A/AA through 2.2) in light theme
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Stubbed Playwright, all flags on, `zbb.theme='light'`.
- **Steps:**
  1. For each path in `AUTHED_ROUTES` run `authedSetup(page, 'light')` and `page.goto(path)`.
  2. Wait for the first `heading level 1` to appear.
  3. Run `AxeBuilder` with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`.
- **Expected:** `violations` is `[]` for `/`, `/transactions`, `/accounts`, `/jars`, `/people`, `/allocation`, `/reports`, `/import`, `/help`, `/account`. Each route exposes exactly one level-1 heading (the `waitFor` on `heading level 1 .first()` presumes it).
- **Automated:** Yes (`client/e2e/a11y.spec.ts`)

### UX-002 - Every authenticated route is axe-clean in dark theme
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Stubbed Playwright, `zbb.theme='dark'` (so `<html class="dark">`).
- **Steps:**
  1. Repeat UX-001 with `authedSetup(page, 'dark')` for every `AUTHED_ROUTES` path.
- **Expected:** Zero violations on every route in dark theme. Because the whole palette flips at the token level (`.dark` reassigns the slate ramp + `--color-surface`), contrast criteria (1.4.3/1.4.11) must pass with no per-element `dark:` fixes on the bulk of the page.
- **Automated:** Yes (`client/e2e/a11y.spec.ts`)

### UX-003 - Public routes are axe-clean in both themes
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Signed out (refresh 401), then `/login` (both modes), `/`, `/privacy`, `/terms`.
- **Steps:**
  1. Scan `/login` sign-in mode, then click "Create account" and scan the registration form.
  2. Scan `/` (LandingPage — H1 matches `/give every \S+ a job/i`).
  3. Scan `/privacy` and `/terms`.
- **Expected:** No WCAG A/AA violations, light + dark. Registration adds First/Last name, currency + number-format selects, and consent checkboxes without introducing label or contrast failures.
- **Automated:** Yes (`client/e2e/a11y.spec.ts`, `landing.spec.ts`, `legal.spec.ts`)

### UX-004 - Overlay / transient surfaces are axe-clean in both themes
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Stubbed Playwright, both themes.
- **Steps:**
  1. `/import`: choose an account, upload a CSV, "Review transactions"; scan the review table, then an opened split editor ("Split AUTOMARKET on 2026-06-17"), then a marked transfer ("Mark WOLT on 2026-06-15 as a transfer") with its counterparty picker.
  2. `/jars`: open "New jar" — the form asks no Type: "Repeats" starts at "Doesn’t repeat", so "Needed by" and "Repeats" (with its "What repeating means" hint) render; select "Yearly" in Repeats (the date becomes "Next due date"); back to "Doesn’t repeat", fill Target `300` + "Needed by" `2026-12-15` (the mocked `POST /jars/schedule` preview renders), click "More options" (the "Include the deadline month" tick box renders, with its "What including the deadline month means" hint, and "Already set aside" with its "What setting money aside does" hint); tick "Set aside a fixed amount each month" (visible text "Fixed amount each month", with its "What a fixed amount means" hint; "Monthly amount" replaces the date and Repeats); then "Edit Home insurance" (two-step Archive).
  3. `/help` with `analytics` flag on: the "Analytics consent" region + "Privacy & analytics" control.
  4. `/` for a brand-new user: welcome dialog, every spotlight tour step through "Finish", the "Getting started" checklist region.
- **Expected:** Zero violations on every overlay in light and dark — dialogs carry `role="dialog" aria-modal`, the consent banner is a labelled `role="region"`, the checklist a labelled `section`/region, tour steps announce "Step n of 9".
- **Automated:** Yes (`client/e2e/a11y.spec.ts`)

### UX-005 - Focus-visible ring meets contrast on every interactive element, both themes
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, keyboard only.
- **Steps:**
  1. Tab through the shell (nav links, user menu, month arrows, theme toggle, buttons, inputs, selects, reorder arrows).
  2. Observe the focus indicator in light then dark.
- **Expected:** Each focused control shows the global `:focus-visible` ring — `2px solid var(--color-brand-600)` at `outline-offset: 2px` (index.css) — clearly visible against `--color-surface` in both themes, satisfying WCAG 2.4.7 (focus visible) and 2.4.13 (focus appearance). No control relies on colour-only hover with no focus ring.
- **Automated:** No

### UX-006 - Routes and states excluded from the automated axe sweep (coverage gap)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Manual axe run.
- **Steps:**
  1. Manually axe-scan `/accept-invite?code=…`, `/accounts/:id` (AccountDetailPage), the staging build (`VITE_APP_ENV=staging`, banner rendered), and error/empty renders (fetch failures, empty month, all-caught-up import) in both themes.
- **Expected:** These are NOT in `AUTHED_ROUTES` and the e2e fixtures are always happy-path, so they are unscanned by CI. They must be checked manually and be violation-free; document any finding — the automated `a11y` gate does not protect them.
- **Automated:** No

## Keyboard navigation & focus management

### UX-007 - The skip link is the first tab stop and moves focus to main content
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, on any authenticated page (e.g. `/`).
- **Steps:**
  1. Load the page, press Tab once.
  2. Observe the revealed control; press Enter.
- **Expected:** The first focusable element is the visually-hidden "Skip to main content" link (`href="#main-content"`); focus reveals it (`focus:not-sr-only focus:fixed left-4 top-3`). Activating it moves focus to `<main id="main-content" tabIndex={-1}>`, past the sidebar/topbar nav (WCAG 2.4.1 bypass blocks). The skip link exists only inside `AppShell` — `/login`, `/`(landing), `/privacy`, `/terms` have no skip link by design.
- **Automated:** No

### UX-008 - The main landmark is programmatically focusable but shows no persistent outline
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Real backend, authenticated page.
- **Steps:**
  1. Activate the skip link (UX-007), then interact with the page.
- **Expected:** `<main>` receives focus (`tabIndex={-1}`) yet renders no lingering outline (`focus:outline-none` on main), because a `-1` programmatic target is not a `:focus-visible` keyboard stop — the ring belongs on the controls inside it, not the container.
- **Automated:** No

### UX-009 - A focused/scrolled-to element is never hidden under the sticky header
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Real backend, a long page (e.g. `/` with many budget lines) scrolled down.
- **Steps:**
  1. Tab to a control low in the page, or follow an in-page anchor.
- **Expected:** `html { scroll-padding-top: 5rem }` (index.css) keeps the focused target clear of the sticky top bar/staging banner — WCAG 2.4.11 (Focus Not Obscured). The control is fully visible, not tucked behind the 4rem header.
- **Automated:** No

### UX-010 - The user menu is a keyboard-operable popup menu
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, single-household Owner, focus on the "Account menu" trigger.
- **Steps:**
  1. Press Enter/Space to open; Tab through items; press Escape.
  2. Reopen, then click outside the menu.
- **Expected:** Trigger has `aria-haspopup="menu"`, `aria-expanded` toggling true/false, `aria-label="Account menu"`. Open reveals `role="menu"` with `menuitem` "Account settings" and "Sign out" (plus a "Household" section only when `households.length > 1`). Escape closes it; an outside `mousedown` closes it. The avatar initials are `aria-hidden`.
- **Automated:** No

### UX-011 - Modals trap focus, restore it on close, and lock background scroll
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Real backend; open any `Modal` (Add account, Add transaction, New jar, Invite).
- **Steps:**
  1. Open the modal from its trigger button.
  2. Tab repeatedly past the last control; Shift+Tab past the first.
  3. Press Escape (and separately, click the dimmed backdrop, and the ✕).
- **Expected:** On open, focus moves into the dialog and autofocuses (via `useDialogA11y`); Tab cycles within `role="dialog" aria-modal="true"` and never reaches page content behind it; `document.body.style.overflow='hidden'` locks background scroll. Escape, backdrop click (`bg-black/40`), and the `aria-label="Close"` ✕ all close it, and focus is restored to the element that opened it.
- **Automated:** Partial (`client/e2e/a11y.spec.ts` scans open dialogs; trap/restore behaviour via `useDialogA11y` is covered indirectly by onboarding tests in `05-onboarding.md`)

### UX-012 - Reorder arrows are labelled buttons, unique per row, disabled at the ends
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, `/` with ≥2 expense groups ("Food", "Utilities") each with ≥2 lines.
- **Steps:**
  1. Tab to a group's move controls; read the accessible names.
  2. Activate "Move Food up" via keyboard; check the top group's up arrow.
- **Expected:** Each control is a real `<button>` with a unique `aria-label` — `Move {category.name} up/down` (CategoryAccordion) and `Move {item.name} up/down` (BudgetItemRow) — plus a `title` tooltip. The first group's up arrow and last group's down arrow are disabled (end of list). Income is always ordered first and cannot be reordered above/below (see 07-month-lifecycle BUDG cases).
- **Automated:** Partial (`client/src/pages/DashboardPage.test.tsx` clicks `Move Food up` / `Move Utilities up`)

### UX-013 - Segmented / toggle controls use aria-pressed, not a tablist
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** ThemeToggle (any page), the "Sign in / Create account" control (`/login`), and any `SegmentedControl`.
- **Steps:**
  1. Focus a segment; toggle with Enter/Space; read state.
- **Expected:** The control is a `role="group"` with an `aria-label` ("Theme", "Sign in or create an account") wrapping plain `<button>`s that carry `aria-pressed` (true on the selected one), operable by Enter/Space. It is deliberately NOT an ARIA tablist, so no roving-tabindex is required — each button is an ordinary tab stop.
- **Automated:** Partial (contrast/labels via `client/e2e/a11y.spec.ts`; state via page tests)

### UX-014 - The month navigator is keyboard-operable with labelled arrows
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, any month-scoped page.
- **Steps:**
  1. Tab to the "Previous month" (‹) and "Next month" (›) buttons; activate each.
- **Expected:** Both are `<button aria-label="Previous month"/"Next month">`; activating them moves the app-wide viewed month (the `<h2>` label like "July 2026" updates). The TopBar renders on every authenticated page including non-month pages (Help/Account), and the arrows have no min/max clamp.
- **Automated:** No

### UX-015 - Tab order flows skip-link → nav → user menu → content in a logical sequence
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Real backend, desktop ≥900px, keyboard only.
- **Steps:**
  1. From page load, Tab repeatedly and note the visiting order.
- **Expected:** Skip link → sidebar brand/nav links (in visual order, active gets `aria-current="page"`) → user menu → TopBar (month arrows, "Zero-based" pill is non-interactive, theme toggle) → in-page content. DOM order matches visual order (no positive `tabindex` reordering).
- **Automated:** No

### UX-016 - The onboarding tour is keyboard-operable and makes the page inert
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Brand-new user on `/`, welcome → "Take the tour".
- **Steps:**
  1. Drive the tour with keyboard: "Next"/"Back"/"Skip tour"/"Finish"; press Escape.
- **Expected:** Focus moves to each step's heading; the dimmed backdrop catches clicks so the page behind is inert; Escape ends the tour. Sidebar-anchored steps that are off-screen on mobile fall back to a centred card. (Tour mechanics owned by `05-onboarding.md`; this asserts the keyboard/inertness convention.)
- **Automated:** Partial (`client/e2e/a11y.spec.ts` walks every step via keyboard-reachable buttons)

## Screen-reader structure

### UX-017 - Every page exposes exactly one h1
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Every route, authed and public.
- **Steps:**
  1. On each route, enumerate `<h1>` elements.
- **Expected:** Exactly one h1 per page. AppShell renders the `title` prop as a visually-hidden `<h1 class="sr-only">` for data screens (the visible header is the TopBar); pages with their own visible h1 omit the prop — HelpPage ("Help & guide"), LandingPage ("Give every {noun} a job"), Legal pages (page title). `/login` and `/accept-invite` render the brand wordmark "AllotJar" as their single h1 (the "Sign in" / "Join the household" headings are lower-level). No page renders zero or two h1s.
- **Automated:** Partial (`a11y.spec.ts` waits on `heading level 1 .first()`; `LandingPage.test.tsx` asserts a single H1)

### UX-018 - Primary navigation is a labelled landmark with a current-page marker
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, desktop then mobile widths.
- **Steps:**
  1. Inspect the nav landmark in the sidebar (≥900px) and the top-bar pills (<900px).
- **Expected:** Both variants render `<nav aria-label="Primary">`; the active item carries `aria-current="page"` (filled square marker in the sidebar, filled pill on mobile); decorative markers are `aria-hidden`. Flag-off items (Accounts/Jars/Reports/People/Allocation gating) are simply absent from the list, not hidden with CSS.
- **Automated:** Partial (`client/src/components/AppNav.test.tsx` covers item visibility + gating)

### UX-019 - The cold-load splash announces itself politely
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Cold load with a valid refresh cookie but no in-memory token.
- **Steps:**
  1. Load `/` (or any RequireAuth route) and observe while `refreshSession()` runs.
- **Expected:** `AuthSplash` renders a centred spinner container with `role="status" aria-live="polite"` and an sr-only "Loading…"; it is replaced by the real page once auth hydrates (or by the landing/login on failure). No route content flashes before the splash resolves.
- **Automated:** Partial (`client/src/auth/AuthContext.test.tsx` asserts single refresh + bootstrap; the role/aria-live markup is not asserted)

### UX-020 - Success confirmations are announced via role="status"
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, `/account`.
- **Steps:**
  1. Save preferences; separately change the password; separately run an allocation action.
- **Expected:** Each success renders a polite `role="status"` message — "Your preferences have been saved.", "Your password has been changed." (AccountPage), and the AllocationPage status region — so assistive tech announces the outcome without stealing focus. (Functional detail in `04-account-preferences.md` / `14-allocation.md`; this asserts the announcement convention.)
- **Automated:** Partial (`client/src/pages/AccountPage.test.tsx` asserts the success copy)

### UX-021 - Errors are announced via role="alert" through the shared ErrorBanner
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Real backend; trigger a save/fetch failure on several pages.
- **Steps:**
  1. Force a failing action (e.g. failed planned-edit on `/`, failed add on `/accounts`, failed import preview on `/import`).
- **Expected:** Every user-visible error uses `role="alert"` so it is announced immediately — the shared `ErrorBanner` (rose card, dark-tuned) or an equivalent inline `role="alert"`. The rose tint has explicit `dark:` variants (`dark:bg-rose-500/10 dark:text-rose-200`) so it stays legible in dark mode. Login/consent/change-password errors likewise use `role="alert"`.
- **Automated:** Partial (per-page failure tests assert the copy; the `role="alert"` primitive is shared)

### UX-022 - Icon-only controls are labelled; decorative graphics are hidden
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Every page.
- **Steps:**
  1. Enumerate icon-only buttons (✕ dismiss, Close, month arrows, reorder arrows, theme buttons) and decorative graphics (avatar initials, nav markers, JarLogo).
- **Expected:** Every icon-only actionable control has a text `aria-label` ("Dismiss", "Close", "Previous month", "Move {name} up", "Light mode"/"Dark mode"). Purely decorative graphics carry `aria-hidden` (avatar span, nav square marker, the "Zero-based" pill is text). No control announces as an unlabelled "button".
- **Automated:** Partial (axe catches unlabelled controls in `a11y.spec.ts`)

### UX-023 - Greeting and access banners are polite status regions, not alerts
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Real backend; land via `?joined=1` / `?started=1` / `?left=1`; and separately a Read-only or Limited login.
- **Steps:**
  1. Observe the one-time greeting banner and the access-level banner.
- **Expected:** Both use `role="status"` (polite), not `role="alert"` — the greeting (brand-tinted, dismiss button `aria-label="Dismiss"`, param stripped via `history.replaceState`) and the access banner (amber, read-only / limited copy). They are informational, not errors, so they announce without interrupting.
- **Automated:** No

## Dark mode — token-level inversion

### UX-024 - One .dark class inverts the whole slate ramp app-wide
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Real backend, any page, explicit dark pick.
- **Steps:**
  1. Toggle the theme to Dark; inspect backgrounds, borders and text across cards, tables and forms.
- **Expected:** `document.documentElement` gains `.dark`, which reassigns `--color-slate-50…950` (inverted), `--color-surface` (#0f172a), `--color-surface-2`, shadows and the hero gradient in index.css. The bulk of the UI — which styles itself off the slate ramp + `bg-surface` — flips without any per-element `dark:` class. Body background goes `#fafcfa` → `#0e1311`. (Persistence/no-flash owned by `04-account-preferences.md` PREF-036/039.)
- **Automated:** Partial (`client/e2e/a11y.spec.ts` renders every route in dark)

### UX-025 - The import mapping-preview table flips to dark with no dark: overrides (slate-remap gotcha)
- **Priority:** P1
- **Type:** Regression
- **Origin:** Import coherence (I1/I2) dark-mode slate-remap gotcha — plain slate classes must flip automatically; adding a `dark:` override to the sample table double-remaps and washes it out.
- **Preconditions:** Stubbed/real, `/import`, generic CSV uploaded so the "csv-mapping" panel + sample-rows table render, dark theme.
- **Steps:**
  1. Upload a generic CSV, reach the mapping panel with the sample-rows table (`bg-slate-50 text-slate-500`, `divide-slate-100`, `text-slate-600` cells).
  2. Toggle Dark.
- **Expected:** The sample table and mapping labels invert correctly using ONLY the remapped slate ramp — there are deliberately NO `dark:` overrides on the preview table (ImportPage comment: "the slate scale is remapped for dark mode in index.css, so plain slate classes flip automatically"). Header row, zebra dividers and cell text stay legible; nothing renders light-on-light or a double-inverted grey. Axe dark scan of `/import` (incl. review table) is clean.
- **Automated:** Partial (`client/e2e/a11y.spec.ts` dark scan of `/import` + review table)

### UX-026 - Accent tints add explicit dark: variants where the slate remap is insufficient
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Dark theme, pages using accent chips/badges/active-nav.
- **Steps:**
  1. Inspect `Badge` tones, the active nav item, brand links, greeting/access banners in dark.
- **Expected:** Accent-on-tint surfaces carry paired `dark:` classes because they don't ride the slate ramp — e.g. `Badge` brand/violet/rose/amber/teal each add `dark:bg-*-500/15 dark:text-*-200/300`; active nav `dark:bg-brand-500/15 dark:text-brand-200`; brand links `dark:text-brand-200`. The `neutral` badge tone intentionally has no `dark:` variant (it rides the inverted slate ramp). All remain AA-legible.
- **Automated:** Partial (axe dark scans)

### UX-027 - Category hues, gold and chart marks brighten and stay readable on dark surfaces
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Dark theme; `/` (category dots/bars, jar lids), `/reports` (charts), `/jars`.
- **Steps:**
  1. View category colour dots/bars, jar bodies, report bars/lines and legends in dark.
- **Expected:** `.dark` brightens `--color-cat-emerald/amber/teal/indigo/rose` and `--color-gold` (index.css) so graphic marks keep ≥3:1 against the dark surface; pill TEXT stays on the slate `--ink` ramp (never the hue). Charts, axes and legends remain readable; no mark disappears into the background.
- **Automated:** Partial (axe dark scan of `/reports`; hue values not directly asserted)

### UX-028 - The gold-number / hero gradient only ever appear on the dark-green hero
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Both themes; dashboard hero (balanced month shows the gold badge/number).
- **Steps:**
  1. Confirm the metallic `.gold-number` and `.hero-surface` gradient render only inside the hero band, in both themes.
- **Expected:** `.gold-number` (clipped metallic gradient text) and the `--hero-grad` band render only on the dark-green hero, where large white/gold text clears AA; they are never placed on a light card surface (index.css warns against it). The hero white text passes AA over the gradient in light and dark.
- **Automated:** No

### UX-029 - No wrong-theme flash on hard load, under a strict CSP
- **Priority:** P2
- **Type:** Regression
- **Origin:** Theme pre-paint script — CSP is `script-src 'self'`, so the initializer is the external same-origin `public/theme-init.js`, not an inline script.
- **Preconditions:** `zbb.theme='dark'` (or OS dark, no stored value); hard reload any route.
- **Steps:**
  1. Hard-refresh and watch the first paint.
- **Expected:** `theme-init.js` applies `.dark` before first paint, so there is no light-then-dark flash; dark = stored `'dark'` OR (no stored value AND OS dark). Note: `index.css` `@import`s Google Fonts, so the CSP must also allowlist Google Fonts — verify no CSP console error blocks fonts or the theme script. (No-flash detail also in `04-account-preferences.md` PREF-039.)
- **Automated:** No

### UX-030 - Theme is device-wide and follows the OS live until the first explicit pick
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Fresh browser profile, no `zbb.theme`, OS set to dark.
- **Steps:**
  1. Load the app (should be dark by OS); flip the OS to light and observe.
  2. Click "Light mode" explicitly, then flip the OS again.
- **Expected:** With `zbb.theme` unset, `ThemeToggle` follows OS `prefers-color-scheme` live via a `matchMedia` change listener. After an explicit pick the listener stops honouring OS changes and the choice persists in `localStorage['zbb.theme']` (device-wide, not per-user, kept across household switches).
- **Automated:** Yes (`client/e2e/theme-os-live.spec.ts` — system mode follows an emulated OS flip live; a theme pinned via the real ThemeToggle ignores OS flips and survives a reload)

## Responsive / mobile (375 px)

### UX-031 - No route scrolls the document horizontally at 375 px
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #95 mobile-layout fix — wide/column-dense content must scroll inside its own container, never push the document past the viewport.
- **Preconditions:** Stubbed Playwright, `viewport 375×812`.
- **Steps:**
  1. For each `AUTHED_ROUTES` path, `authedSetup(page,'light')`, `goto(path)`, wait for the h1, `waitForLoadState('networkidle')`.
  2. Assert `document.documentElement.scrollWidth <= clientWidth + 1`.
- **Expected:** Every authed route passes on a 375 px phone — no sideways page scroll (±1px sub-pixel tolerance). This is the regression net for the "columns collide / icons spill" class of bug.
- **Automated:** Yes (`client/e2e/mobile-layout.spec.ts`)

### UX-032 - The budget grid scrolls inside its own container, not the page
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #95 mobile-layout fix.
- **Preconditions:** `/` at 375 px with several groups/lines including a wide savings/fund row.
- **Steps:**
  1. Attempt to scroll the budget rows horizontally; then check the page.
- **Expected:** Wide budget rows scroll within their own `overflow-x-auto` container; the document itself does not gain horizontal scroll (UX-031 holds). Row controls (planned editor, actual, reorder arrows, bill/paid) stay within the row and don't overflow the next column.
- **Automated:** Yes (`client/e2e/mobile-layout.spec.ts` covers `/` no-overflow)

### UX-033 - Import mapping + review tables scroll inside their own container at 375 px
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #95 mobile-layout fix.
- **Preconditions:** `/import` at 375 px, generic CSV → mapping panel + review table shown.
- **Steps:**
  1. Reach the sample-rows table and the review table; scroll each sideways; check the page.
- **Expected:** Both wide tables are wrapped in `overflow-x-auto rounded-lg border` containers and scroll internally; the page does not scroll horizontally. The mapping selects stack rather than force a wide layout.
- **Automated:** Yes (`client/e2e/mobile-layout.spec.ts` covers `/import`)

### UX-034 - The sidebar collapses to a scrollable top-bar pill row below 900 px
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, resize across the 900 px breakpoint.
- **Steps:**
  1. At ≥900px confirm the left sidebar (brand, vertical nav, pinned user menu).
  2. Shrink below 900px.
- **Expected:** The `min-[900px]:flex` sidebar hides and the `<header … min-[900px]:hidden>` mobile bar appears: compact logo + horizontally-scrollable `nav aria-label="Primary"` pills (`overflow-x-auto`, ≥40px tap targets) + compact user menu (opens downward). Nav parity is preserved; no items are lost.
- **Automated:** Partial (`client/e2e/mobile-layout.spec.ts` runs at 375px so the mobile bar is active on every scanned route)

### UX-035 - Dialogs fit a phone screen without overflow
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `/jars` at 375 px.
- **Steps:**
  1. Open "New jar" (a 2-column grid inside a dialog); check for horizontal overflow.
- **Expected:** The modal (`max-w-md`, `p-4` outer, scrollable `overflow-y-auto`) fits 375 px with no sideways scroll; the 2-col field grid reflows/stays within the dialog. Long content scrolls vertically inside the dialog, not the page.
- **Automated:** Yes (`client/e2e/mobile-layout.spec.ts` "the jar modal fits a phone screen")

### UX-036 - Account-detail and reconciliation tables at 375 px
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** `/accounts/:id` and the `/accounts` reconciliation table at 375 px.
- **Steps:**
  1. Load a busy account detail register and the reconciliation panel; scroll and check page overflow.
- **Expected:** Both scroll inside their own containers with no page horizontal scroll. Note `/accounts/:id` (AccountDetailPage) is NOT in `AUTHED_ROUTES`, so the per-route 375px sweep skips it — it has its own dedicated spec instead.
- **Automated:** Yes (`client/e2e/responsive-dark.spec.ts` — "the account-detail register scrolls inside its own container (UX-036)" + the reconciliation-table UX-031 test)

### UX-037 - Tour steps that target the hidden sidebar centre gracefully on mobile
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Mobile (<900px), onboarding tour running.
- **Steps:**
  1. Advance through the sidebar-anchored steps (nav/accounts/jars/reports/people) on a phone.
- **Expected:** With the sidebar hidden, `data-tour` targets are off-screen, so the spotlight falls back to a centred card (the `onScreen` check) rather than pointing at nothing — the tour remains usable and never breaks layout.
- **Automated:** No

## Empty states

### UX-038 - Zero-data surfaces use the shared EmptyState primitive consistently
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** A brand-new opt-out account (empty per PR #170) plus individually emptied features.
- **Steps:**
  1. Visit each zero-data surface: no accounts (`/accounts`), no jars (`/jars` + shelf), empty register (`/transactions`), no-data reports (`/reports`), solo People (`/people`), no-profile allocation (`/allocation`), all-caught-up import (`/import`).
- **Expected:** Each renders the shared `EmptyState` look — a dashed-border card (`border-dashed border-slate-300 bg-surface`), optional icon medallion, a semibold title, muted description, and a centred actions row — so empty states look intentional and consistent, not ad-hoc "nothing here" divs. Per-feature copy/CTAs are verified in the owning files (ACCT-003, JAR-001, IMP-082, etc.).
- **Automated:** Partial (per-page empty-state tests assert copy; `a11y.spec.ts` does not scan empty fixtures)

### UX-039 - The empty month uses the plan-your-income hero, not EmptyState and never the gold badge
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #172 — an empty month is NOT balanced (`IsBalanced` requires `TotalIncome > 0`).
- **Preconditions:** A created month with no income and nothing planned (jar-less household).
- **Steps:**
  1. Open `/` on that month; read the hero footnote.
- **Expected:** The hero shows "Plan your income, then give every {noun} a job" (income prompt), NOT the gold "Every {noun} has a job" badge and NOT a generic dashed EmptyState. A jar-owning household's blank month instead lands over-budgeted ("{amount} over-budgeted — trim a line", rose) due to accrual-planned savings lines. (Full hero matrix in `06-dashboard-budget-view.md` DASH-014..020.)
- **Automated:** Yes (`client/src/pages/DashboardPage.test.tsx` empty-month prompt; `budgetModel.test.ts` empty ≠ balanced)

### UX-040 - EmptyState is theme-aware and mobile-safe
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** An empty surface in dark theme at 375 px.
- **Steps:**
  1. View e.g. empty `/jars` in dark on a phone.
- **Expected:** The dashed border and muted text ride the remapped slate ramp so the card inverts cleanly in dark; the card is width-capped (`max-w-md` description) and centred with no horizontal overflow on mobile.
- **Automated:** No

## Loading states

### UX-041 - Cold-load splash then per-route loading placeholder, never a flash of wrong content
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, throttled network to make fetches observable.
- **Steps:**
  1. Hard-load `/`, then navigate to `/accounts`, `/jars`, `/reports`, `/import`, `/allocation`.
- **Expected:** Cold load shows `AuthSplash` (UX-019) before any route paints. After auth, each data page shows its own loading placeholder while its GET is in flight, then swaps to content — never rendering the empty-state or an error before the fetch resolves (e.g. AccountsPage/JarsPage loading placeholders per ACCT-004 / JAR-003). Switching months clears the previous month before fetching so no stale data shows under the new label (DASH-002).
- **Automated:** Partial (per-page loading tests; `budget-months`/dashboard stale-guard in `06-dashboard-budget-view.md`)

### UX-042 - The optimistic "saving" pulse dot appears during an in-flight edit and clears on settle
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Real backend, `/` editing a planned amount or income line.
- **Steps:**
  1. Edit a planned amount and blur; watch the row while the PUT is in flight.
- **Expected:** The banner/number updates optimistically and a small `animate-pulse` brand dot (BudgetItemRow / IncomeLineRow) marks the in-flight save; it disappears once the server reconciles, and on failure the value rolls back with a `role="alert"` (DASH-037/038). Under `prefers-reduced-motion` the pulse animation is neutralised (see UX-049).
- **Automated:** Partial (`client/src/pages/DashboardPage.test.tsx` optimistic commit + rollback)

## Error & network-failure handling

### UX-043 - A data-fetch failure surfaces a load-error strip with a retry where offered
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Real backend; force the page's primary GET to fail (500 / network error).
- **Steps:**
  1. On `/` (budget), `/accounts`, `/jars`, `/reports` in turn, break the fetch and load the page.
- **Expected:** Pages that own a visible failure path show a `role="alert"` load-error strip (e.g. Dashboard's budget-fetch strip DASH-003, AccountsPage/JarsPage load-error ACCT-004/JAR-004) with the page's retry affordance where one exists. The strip is dark-legible (rose `dark:` variants) and does not leave a half-rendered page.
- **Automated:** Partial (per-page load-error tests in the area files)

### UX-044 - Deliberately silent-failure contexts swallow errors without a banner and never crash
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Real backend; break each background fetch independently.
- **Steps:**
  1. Fail `GET /features`, `GET /members` (household), the checklist polls (`/budget/months`, `/budget/{y}/{m}`, `/jars`, `/transactions`), `/accounts/reconciliation`, and `POST /auth/logout`.
- **Expected:** By design these show NO user-visible error (FeatureProvider keeps all-on defaults; HouseholdProvider falls back to solo `[]`; checklist just doesn't advance; reconciliation leaves the last table (ACCT-050); logout is fire-and-forget and clears UI regardless). The app stays interactive — a failed background fetch must never white-screen or throw to the user.
- **Automated:** Partial (`analytics`/`AuthContext` tests; reconciliation silent-fail ACCT-050)

### UX-045 - Offline mid-action rolls back optimistic UI and writes nothing
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Real backend, `/` editing a planned amount; go offline just before submit.
- **Steps:**
  1. Change a planned amount, take the network offline, blur to trigger the PUT.
  2. Restore network and re-read the value from the server.
- **Expected:** The optimistic value reverts to the last server value and a `role="alert"` explains the failure (shared rollback message, DASH-038); no partial write persists. On reconnect the server value is authoritative — the money is never left in an inconsistent optimistic state. Same contract for optimistic bill/paid toggles and inline renames.
- **Automated:** Partial (`client/src/pages/DashboardPage.test.tsx` failed-save rollback simulates the failure path)

### UX-046 - Every failed request emits a redacted api_error analytics event
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Analytics enabled (flag + measurement id + consent granted); force a failing request.
- **Steps:**
  1. Trigger any non-2xx response and inspect the analytics payload.
- **Expected:** `track('api_error', { api_endpoint, api_status })` fires with the endpoint collapsed to a template (ids → `:id`, query/hash stripped) — raw URLs, ids and amounts never reach GA. `api_endpoint`/`api_status` are whitelisted params; anything unlisted is silently dropped. No PII leaves the client.
- **Automated:** Partial (`client/src/analytics/analytics.test.ts` redaction; `lib/api.test.ts` interceptor)

### UX-047 - A genuinely dead session on any long-lived tab prompts a fresh sign-in
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169 — dead sessions prompt re-login; cross-tab logout broadcast via `client/src/lib/authChannel.ts`.
- **Preconditions:** Signed in on `/transactions` (or any authed route) in a tab left open long enough for the refresh token to be revoked.
- **Steps:**
  1. Revoke the session server-side (logout/rotate), then act in the stale tab (navigate or fire a request).
- **Expected:** The 401 interceptor's single refresh fails, `sessionExpired()` clears the in-memory token + `zbb.email/role/displayName`, broadcasts `'signed-out'` to other tabs, and redirects to `/login?reason=expired&returnUrl=%2Ftransactions` showing "Your session has expired…". Signing back in returns to the original route. This holds on every authed page, not just one (e.g. ACCT-058 asserts it for `/accounts`).
- **Automated:** Yes (`client/e2e-journey/session-expiry.spec.ts`; `AuthContext.test.tsx` cross-tab broadcast)

### UX-048 - A second tab replaying the just-rotated refresh cookie is not signed out
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #171 — 30s server-side grace window; the grace 401 must NOT clear the shared `zbb_rt` cookie.
- **Preconditions:** Two tabs sharing one refresh cookie; both revalidate on focus near the same moment.
- **Steps:**
  1. Focus tab A (wins the refresh, rotates the cookie), then immediately focus tab B (replays the now-stale cookie within 30s).
- **Expected:** Tab A gets 200 + rotated cookie; tab B's replay is refused with a 401 that carries NO `Set-Cookie`, so the winner's cookie survives in the shared jar and neither tab is signed out (no session-family burn). Outside the 30s window a genuine replay still burns the chain (theft response). Never POST `/auth/refresh` directly — only via `refreshSession()` single-flight.
- **Automated:** Yes (`client/e2e-journey/concurrent-refresh.spec.ts` — origin/main `99ec47f` only, not the local checkout)

## Motion & banner/status stacking

### UX-049 - prefers-reduced-motion collapses all non-essential motion app-wide
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** OS/browser "reduce motion" enabled.
- **Steps:**
  1. Trigger the sidebar/mobile transitions, the "saving" pulse dot, tour step transitions, and smooth scroll.
- **Expected:** The global `@media (prefers-reduced-motion: reduce)` reset in index.css forces `animation-duration`/`transition-duration` to `0.01ms`, `animation-iteration-count: 1`, and `scroll-behavior: auto` on `*`, `::before`, `::after` — WCAG 2.3.3. The saving pulse and hover transitions become effectively instant; no essential state is lost (the dot still shows, just unanimated).
- **Automated:** No

### UX-050 - The e2e a11y sweep runs under reduced motion to avoid mid-transition contrast flakes
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Stubbed Playwright config.
- **Steps:**
  1. Confirm the Playwright context sets `reducedMotion: 'reduce'` before axe scans.
- **Expected:** `client/playwright.config.ts` uses `contextOptions: { reducedMotion: 'reduce' }`, so axe never samples an element mid-fade (which used to flake contrast). This documents why the automated a11y results are stable and that motion-on contrast should also be spot-checked manually.
- **Automated:** Yes (`client/playwright.config.ts` context option; enforced across `client/e2e/*.spec.ts`)

### UX-051 - The staging banner stacks above main content on every screen (staging build only)
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Staging build (`VITE_APP_ENV=staging`); signed in and signed out.
- **Steps:**
  1. Load an authed page, `/login`, and the landing `/`; look above the content.
- **Expected:** A sticky amber `role="status"` strip renders above `<main>` in AppShell and on LoginPage/LandingPage: "Staging — this is the AllotJar test environment. Features may change and your data can be reset or lost without notice." The production build (the `deploy-production` job) renders nothing. It does not overlap the skip link or steal focus.
- **Automated:** Partial (`client/src/components/StagingBanner.test.tsx` renders-nothing-in-prod / warns-in-staging; not axe-scanned since CI has no staging build)

### UX-052 - Simultaneous banners stack in a stable order without overlap or duplicate landmarks
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Staging build, Limited/Read-only login, landing via `?joined=1`, plus a page-level error.
- **Steps:**
  1. Load an authed page in the state above and read top-to-bottom.
- **Expected:** Banners stack in document order without covering each other: staging strip (above main) → one-time greeting (`role="status"`) → access-level banner (`role="status"`) → any page `role="alert"` error → page content. Each is a distinct region; there is no z-index overlap and no more than one h1 (UX-017). Dismissing the greeting (`aria-label="Dismiss"`) reflows the rest upward.
- **Automated:** No

### UX-053 - The consent modal sits above onboarding and never covers the pages it links to
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A login with `needsConsent` (owner-set/legacy account).
- **Steps:**
  1. Sign in (blocking consent dialog appears); follow its "Terms of Service" / "Privacy Policy" links.
- **Expected:** `ConsentModal` is `z-[70]`, above onboarding's `z-[60]`, and onboarding is not even mounted while `needsConsent` — a focus-trapped welcome can never sit unreachable beneath the consent prompt. The modal is suppressed on `/terms` and `/privacy` so it never covers the text being consented to. It is not dismissible (no X, no backdrop close); "I agree" or "Sign out" are the only exits; errors use `role="alert"`.
- **Automated:** Partial (`client/src/components/ConsentModal.test.tsx` — blocks until agree, never covers legal pages)

### UX-054 - The analytics consent region is non-modal, bottom-pinned and never traps focus
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** `analytics` flag on, consent undecided.
- **Steps:**
  1. With the banner up, Tab through the page and into/out of the banner; use the app behind it.
- **Expected:** The banner is a `role="region" aria-label="Analytics consent"` pinned bottom (`z-50`), NOT a modal — it does not trap focus or block interaction with the app; "Decline"/"Accept" are ordinary tab stops. It coexists with (sits below) any other banners and is axe-clean in both themes.
- **Automated:** Partial (`client/e2e/a11y.spec.ts` scans the region + Help control with the flag forced on)

### UX-055 - Focusing a filled numeric input selects its value so typing replaces it
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Any numeric/money field holding a value (typically a prefilled `0`): budget planned editors, bill due-day, transaction/transfer/split amounts, account opening balances, jar target, monthly amount and "Already set aside" (under More options), allocation pocket money and balance lean, member incomes, import split amounts.
- **Steps:**
  1. Click (or Tab) into a numeric field showing an existing value, e.g. `0`.
  2. Type `50` without clearing first.
- **Expected:** Focus selects the whole current value (the shared `selectOnFocusProps` in `client/src/lib/selectOnFocus.ts`), so the field reads exactly `50` — never `050` or `500`. The selection survives the focusing click's mouseup (Chrome/Safari collapse guard); a second click inside the already-focused field places the caret normally for fine editing. Free-text fields (payee, names) deliberately keep normal caret behavior.
- **Automated:** Yes (`client/src/lib/selectOnFocus.test.tsx` — select-on-focus, single-mouseup guard, type-replaces; `client/src/pages/DashboardPage.test.tsx` "typing into the planned editor replaces the selected value")

### UX-056 - Typing over a prefilled always-mounted numeric field replaces the value end-to-end
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** A form field prefilled from saved data, e.g. the allocation settings "Balance lean percent" holding `25`.
- **Steps:**
  1. Open Allocation settings; click straight into the lean field and type `50` without clearing.
  2. Save.
- **Expected:** The field holds `50` (not `255`/`525`) and the PUT carries `balanceLeanPercent: 50`. The same applies to every always-mounted numeric input in the sweep (accounts opening balance, jar target, member income, split amounts).
- **Automated:** Yes (`client/src/pages/AllocationPage.catalog.test.tsx` UX-056)
