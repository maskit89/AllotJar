# Landing & Public Pages

**ID prefix:** LAND | **Scope:** The anonymous-facing surface of AllotJar: the public landing page at `/` (the sign-in pages' look since restyle PR 15: the green room, the line, one primary, the theme button, three feature cards, the closing line, the quiet footer; euro always), the auth-state branching of `/` (splash → landing vs dashboard), the public legal pages `/privacy` and `/terms`, SEO artifacts observable in the served app (head title/meta/canonical/OG/JSON-LD, `robots.txt`, `sitemap.xml`, the prerendered landing HTML, `theme-init.js`), the analytics consent banner + GA Consent Mode gating, the staging banner + staging signup data-loss consent, and the (retired) coming-soon page expectations. | **Out of scope:** login/registration form mechanics, session refresh, returnUrl handling and `?reason=expired` (auth & sessions file); AppShell nav, onboarding welcome/tour/checklist, ConsentModal general behavior, theme toggle control (routing & app shell file); ReportsPage (reports file); household greeting banners `?joined/started/left` (households & people file); full responsive/dark/a11y sweeps and role matrices (cross-cutting files) — only the landing/legal-specific contrast regressions and the coming-soon reduced-motion behavior are covered here because they are area-specific past bugs.

**Test data setup:** (a) A clean anonymous browser profile — no `zbb_rt` cookie, empty `localStorage` (no `zbb.*` keys). (b) One existing login `owner@example.com` (Owner of a solo household) for auth-branching cases. (c) Access to the live **production** deployment `www.allotjar.com`/apex (built with `VITE_APP_ENV=production`, GA measurement ID `G-55WS48MJ91` inlined, server flag `Features:Analytics=true`) and/or the **staging** deployment `staging.allotjar.com` (built with `VITE_APP_ENV=staging`, NO GA measurement ID — analytics disabled; reachable only from allowlisted IPs via a Cloudflare WAF rule), and to a **local/default** build (`VITE_APP_ENV` unset, `Features:Analytics=false` by default; flip the flag via the `Features` section of `appsettings.json` — `IOptionsSnapshot`, no restart needed). (d) The coming-soon page was RETIRED at the 2026-07 GA cutover (`www`/apex now serve the production app); its source remains archived in `marketing/coming-soon/`.

## Landing page — anonymous visit

### LAND-001 - Landing page renders the hero for an anonymous visitor
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Clean anonymous browser (refresh cookie absent); default (non-staging) build or staging build.
- **Steps:**
  1. Navigate to `/`.
  2. Wait for the page to settle (the auth bootstrap 401s).
  3. Inspect the first screen.
- **Expected:**
  - The sign-in pages' green room across the top of the sage page (on a phone, the compact green band), the soft gold glow, and the shelf of four glass jars (two each side of the card on desktop, a small row of four in the band on a phone). The jars are decoration (no name, no figure, no percent text).
  - Exactly one `<h1>`: "Give every euro a job." (euro always — see LAND-005).
  - The off-white card with the gold hairline in front of the shelf holds one sentence "Zero-based budgeting for households: plan the month to zero, with jars for the big bills and a budget you share.", the page's one primary (green) button "Create your free account" with a quiet "Sign in" link beside it, and the muted note "Free to start · No card required".
  - No invented figure anywhere ("€2,480", "set aside across 3 jars" are gone), no eyebrow, no "crafted in Europe" copy.
- **Automated:** Yes (client/src/pages/LandingPage.catalog.test.tsx LAND-001; client/e2e/landing.spec.ts — H1 "Give every euro a job." + axe, one primary on the first screen; client/e2e/mobile-layout.spec.ts — the line, the primary and Sign in on a phone's first screen)

### LAND-002 - Header and footer chrome and links
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous visitor on `/` (landing rendered).
- **Steps:**
  1. Inspect the header (the room's top row): the wordmark link, the `nav` with `aria-label="Primary"`, the theme button.
  2. Scroll to the footer (`nav` with `aria-label="Footer"`).
  3. Click the logo link.
- **Expected:**
  - Header logo link has `aria-label="AllotJar home"`, `href="/"`; wordmark reads "AllotJar" in the room's pale ink. The Primary nav holds one quiet link "Sign in" → `/login`; beside it the theme button (a toggle named "Dark mode", `aria-pressed`), as on the sign-in page. There is no filled "Get started" button in the header.
  - Footer: one quiet line "© 2026 AllotJar · Privacy · Terms" (year = current year): "Privacy" → `/privacy`, "Terms" → `/terms`, nothing else (no sign-in or register links there).
  - Clicking the logo goes back to `/` in place, with no reload. The landing's links are plain `<a href>` in the prerendered HTML and in-app links once the app is running (`PublicLink`), so "Sign in" and "Create your free account" also open the sign-in page without a reload or the boot splash.
- **Automated:** Yes (client/src/pages/LandingPage.catalog.test.tsx LAND-002; client/e2e/landing.spec.ts — footer links, theme button)

### LAND-003 - Every CTA lands on the correct login tab, one primary per screen
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Anonymous visitor on `/`.
- **Steps:**
  1. Click the hero card's "Create your free account".
  2. Go back; click the "Sign in" beside it.
  3. Go back; scroll to the closing line "Ready to give every euro a job?" and click its "Create your free account".
  4. Go back; click the header's "Sign in".
- **Expected:**
  - Both "Create your free account" links go to `/login?register=1` and LoginPage opens with the **Create account** tab of the segmented control "Sign in or create an account" selected.
  - Both "Sign in" links go to `/login` with the **Sign in** tab selected.
  - No CTA requires JavaScript state — each is a plain `<a href>` (works middle-click/new-tab).
  - One primary (filled green) button per screen: the hero card's on the first screen, the closing line's below the fold; "Sign in" is a link everywhere (never a second button), and nothing else on the page is filled green or pure white.
- **Automated:** Yes (client/src/pages/LandingPage.catalog.test.tsx LAND-003; client/e2e/landing.spec.ts — the CTAs open the right tab, one primary in view)

### LAND-004 - Feature cards, the promises line and the closing line
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous visitor on `/`.
- **Steps:**
  1. Scroll under the room.
- **Expected:**
  - Three off-white feature cards in a row (stacked as rows on a phone), each one glyph in a tinted square, a short title and one line: "Budget to zero" — "Plan the month until Remaining to budget reads zero."; "Jars for the big bills" — "Set a little aside each month for insurance, the car and the holiday."; "Budget together" — "One shared budget for everyone in your household." The section's heading "What AllotJar does" is visually hidden.
  - One muted line under them: "In your currency, the way you write it · Your data is never sold." (on a phone, the two promises on two lines).
  - The closing line, an `<h2>` "Ready to give every euro a job?", with the same primary button under it.
  - The old six-card grid, the three step cards and the five FAQ cards are gone, as are "Sinking-fund jars" and "Members" (the app's words are Jars and People).
- **Automated:** Yes (client/src/pages/LandingPage.catalog.test.tsx LAND-004)

## Euro always (the line never follows the locale)

### LAND-005 - The line says euro whatever the visitor's locale
- **Priority:** P1
- **Type:** Happy
- **Origin:** Restyle PR 15 — the app is euro-first; the old page's mount-only noun swap (a UK browser read "pound" three times, and the prerendered "euro" flipped after hydration) is gone
- **Preconditions:** Anonymous browser with language set to `en-US` (e.g. Playwright `locale: 'en-US'`), then `en-GB`.
- **Steps:**
  1. Navigate to `/` with JavaScript enabled.
  2. Read the H1 and the closing line after the app mounts.
- **Expected:**
  - H1 reads "Give every euro a job." and the closing line "Ready to give every euro a job?" under every locale (`en-US`, `en-GB`, `de-CH`, `en-IN`, `pl-PL`, …); "dollar", "pound", "franc", "rupee", "złoty" never appear on this page. The page's text is the same before and after the SPA mounts.
- **Automated:** Yes (client/src/pages/LandingPage.catalog.test.tsx LAND-005; client/e2e/landing.spec.ts — H1 "Give every euro a job." under the config's en-US locale)

### LAND-006 - Unmapped or missing locale: still euro, never "unit"
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Anonymous browser with (a) a locale whose region is not in `REGION_CURRENCY` (e.g. `pt-PT`), and (b) a context where `navigator.language` is empty/undefined.
- **Steps:**
  1. Load `/` under locale `pt-PT`; read the H1.
  2. Load `/` with `navigator.language` stubbed to `''`; read the H1.
- **Expected:**
  - Both cases read "Give every euro a job."; no case may ever display "Give every unit a job." from the landing (the page never calls `currencyNoun`).
- **Automated:** Yes (client/src/pages/LandingPage.catalog.test.tsx LAND-006)

### LAND-007 - Prerendered/crawled HTML always says "euro"
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #117 — LandingPage must stay SSR-safe (no `window`, `document` or `navigator` during render); restyle PR 15 — the line is euro always, so the static HTML is the client's first render
- **Preconditions:** A production build (`npm run build` in `client/`, which runs `scripts/prerender.mjs`), or the deployed production host.
- **Steps:**
  1. Check the build log for the line `prerender: injected landing page (N chars) into dist/index.html`.
  2. Fetch `/` with JavaScript disabled (e.g. `curl -s https://www.allotjar.com/`) from any locale.
  3. Search the raw HTML for the H1 text.
- **Expected:**
  - The static markup inside `<div id="root">` contains "Give every euro a job." regardless of the fetching client's locale/headers, plus both "Create your free account" links, the "Sign in" links, the theme button (`aria-label="Dark mode"`) and the three feature cards. Crawler-visible copy is deterministic and on-brand (euro-first), and nothing changes after the SPA mounts. The static theme button is neutral (restyle PR 20, #351 P3-1): no `aria-pressed` and both icons, the moon `dark:hidden` and the sun `hidden dark:block`, so the page's `.dark` class (theme-init.js) shows the right one and a dark visitor's first paint never shows the light state; once mounted the button reads the theme (`aria-pressed`, one icon).
- **Automated:** Partial (client/src/pages/LandingPage.catalog.test.tsx LAND-007 — `renderToStaticMarkup` holds the line, the CTAs, the theme button and the cards, and equals a second render; "the theme button before mount" — the neutral static button, the same markup whatever the stored theme, and the mounted state; the build's console line and dist/index.html are checked by hand)

## Route `/` auth branching & catch-all

### LAND-008 - Authenticated user at `/` gets the dashboard, never the landing
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `owner@example.com` signed in with a live session (valid `zbb_rt` refresh cookie).
- **Steps:**
  1. From inside the app, navigate to `/`.
  2. Hard-reload the browser on `/` (cold load — in-memory access token gone, cookie present).
- **Expected:**
  - Step 1: DashboardPage renders (month view), no landing content.
  - Step 2: while `refreshSession()` runs, the `AuthSplash` shows (the quiet warm page with the wordmark and a slim loading line, `role="status"`, sr-only "Loading…"; restyle PR 20); when the refresh succeeds the dashboard renders. The marketing landing never flashes at any point (the splash exists precisely to prevent it).
- **Automated:** Partial (client/e2e/a11y.spec.ts — authed `/` renders the dashboard for the axe scan; no explicit no-flash assertion)

### LAND-009 - Anonymous cold load: splash then landing on refresh 401
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Clean anonymous browser (no refresh cookie).
- **Steps:**
  1. Navigate to `/` with dev tools network tab open.
  2. Observe the bootstrap sequence.
- **Expected:**
  - Exactly one `POST /api/auth/refresh` fires (single-flight, StrictMode-safe) and returns 401.
  - During the request the AuthSplash renders; afterwards the LandingPage renders. No redirect to `/login`, no error surfaced — a 401 bootstrap is the normal anonymous path.
- **Automated:** Partial (client/e2e/landing.spec.ts — landing renders when `/auth/refresh` 401s; client/src/auth/AuthContext.test.tsx — single refresh + stays signed out)

### LAND-010 - Unknown paths and query-string visits land safely on `/`
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Anonymous browser; separately, `owner@example.com` signed in.
- **Steps:**
  1. Anonymous: navigate to `/pricing`, then `/signup`, then `/index.html`-style junk like `/foo/bar?x=1`.
  2. Anonymous: navigate to `/?utm_source=newsletter&utm_campaign=beta`.
  3. Signed in: navigate to `/pricing`.
- **Expected:**
  - Steps 1 & 3: the `*` catch-all replaces the URL with `/` — anonymous users see the landing, authed users the dashboard. No 404 screen exists; the query string of the junk URL is dropped by the redirect.
  - Step 2: path is exactly `/`, so the landing renders normally with the `utm_*` params left in the URL and ignored (greeting params like `?joined=1` only have meaning in the authed AppShell).
- **Automated:** No

## Legal pages — /privacy & /terms

### LAND-011 - Privacy Policy renders complete and correct
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Anonymous browser.
- **Steps:**
  1. Navigate to `/privacy` directly (deep link, cold load).
  2. Read the header, date line and body sections.
- **Expected:**
  - H1 "Privacy Policy"; line "Last updated: 1 July 2026".
  - Body identifies the data controller as Christopher Muscat (individual, Malta); covers what data is collected, how it is used, cookies and analytics (GA4, denied-by-default Consent Mode v2, hashed user id), sharing (hosting, Cloudflare, Google), international transfers, retention, protection, the 6 GDPR data-subject rights + right to complain to the Malta IDPC (link to `idpc.org.mt`), children (16+), changes, contact.
  - `mailto:privacy@allotjar.com` links present.
  - No auth redirect occurs — the page is fully public.
  - Restyle PR 16, the approved warm look: the landing page's header row on the sage page (the wordmark → `/`, a quiet "Sign in" → `/login`, the round **Dark mode** button; no green room, no line), then one off-white card with the gold hairline (max-width 46rem) holding the H1, the "Last updated" line and the text (`.legal-prose`: slate text, brand-green links), then the landing's footer "© {year} AllotJar · Privacy · Terms". Light and dark, desktop and phone (the card at the phone's width, 16px gutters, no sideways scroll). Not one word of the policy, its headings, the date or the contact address changed.
- **Automated:** Yes (client/src/pages/LegalPages.test.tsx — H1, contact address, data controller, GDPR rights, the header, the card's order, the footer, the skip link, the staging banner; client/src/pages/LandingPage.catalog.test.tsx LAND-011; client/e2e/legal.spec.ts — axe in both themes, the header/card/footer, the theme button across a reload, the skip link; client/e2e/mobile-layout.spec.ts — no horizontal overflow at 390px)

### LAND-012 - Terms of Service renders complete and correct
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Anonymous browser.
- **Steps:**
  1. Navigate to `/terms` directly.
  2. Read the header, date line and numbered sections.
- **Expected:**
  - H1 "Terms of Service"; "Last updated: 1 July 2026"; 13 numbered sections.
  - Governing law = Malta with exclusive jurisdiction of Maltese courts; eligibility 16+; a "Not financial advice" section exists.
  - In-body link to `/privacy` labelled "Privacy Policy" works.
  - The same chrome as LAND-011 (restyle PR 16): the header row, the one card with the H1, the date line and the 13 sections, the footer. Not one word of the terms, their headings or the date changed.
- **Automated:** Yes (client/src/pages/LegalPages.test.tsx — H1, `/laws of Malta/`, privacy link, the header, the footer, the theme button; client/src/pages/LandingPage.catalog.test.tsx LAND-012; client/e2e/legal.spec.ts — axe in both themes, the theme button on /terms kept across a reload and on /privacy; client/e2e/mobile-layout.spec.ts — no horizontal overflow at 390px)

### LAND-013 - LegalLayout chrome and document-title lifecycle
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous browser starting on `/` (tab title "AllotJar — Zero-Based Budgeting App").
- **Steps:**
  1. Click footer "Privacy"; note the browser tab title.
  2. From the legal footer click "Terms"; note the title.
  3. Click the wordmark (the way home); note the title.
  4. Inspect the legal header and footer; press the theme button.
- **Expected:**
  - Step 1: tab title becomes "Privacy Policy — AllotJar". Step 2: "Terms of Service — AllotJar". Step 3: title restored to the SPA default (unmount effect restores the previous title).
  - Header (restyle PR 16: the landing page's header row, `PublicHeader`): the brand link `aria-label="AllotJar home"` → `/`, the `Primary` nav's one "Sign in" link → `/login`, and the round **Dark mode** button (`aria-pressed`), which turns dark mode on for the page and keeps it across a reload and on the other legal page; on the sage it wears a hairline ring, which in dark mode takes the fields' edge (softened) so it reads at 3:1 or more against the page (restyle PR 20, #352 P3-3). Footer `nav aria-label="Footer"` (`PublicFooter`, the landing's): "© {year} AllotJar", "Privacy", "Terms" — no "Home" (the wordmark is the way home) and no second "Sign in". A "Skip to main content" link whose target takes focus. No app shell, no month bar; the staging build's banner above the header, as on the landing.
- **Automated:** Yes (client/src/pages/LandingPage.catalog.test.tsx LAND-013 — the title lifecycle, the header and footer; client/src/pages/LegalPages.test.tsx; client/src/components/PublicHeader.test.tsx — the landing and a legal page draw the same header row and footer; client/e2e/legal.spec.ts — the theme button, the skip link, the dark ring's 3:1)

### LAND-014 - Legal pages access variants: signed in, case-variant path, cold deep link
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `owner@example.com` signed in; separately, an anonymous browser.
- **Steps:**
  1. Signed in: type `/privacy` in the URL bar and load it.
  2. Signed in: load `/TERMS` (uppercase).
  3. Anonymous: paste `/terms` into a fresh tab (no prior visit).
- **Expected:**
  - Step 1: the Privacy page renders in LegalLayout (no AppShell, no redirect); the static header still shows "Sign in" (known cosmetic quirk of the shared public chrome — acceptable).
  - Step 2: Terms renders — React Router path matching is case-insensitive by default (`caseSensitive` unset).
  - Step 3: the page renders after the normal anonymous bootstrap; no bounce to `/login`.
- **Automated:** No

### LAND-015 - ConsentModal never covers the legal pages it links to
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #156/#158 consent-gap work — `ConsentModal` suppresses itself on `/terms` and `/privacy` (ConsentModal.tsx path check)
- **Preconditions:** A login with `needsConsent = true` from `/auth/me` (e.g. an owner-created login that has never agreed to terms), signed in.
- **Steps:**
  1. Land anywhere in the app; confirm the blocking dialog "Accept the terms" is up.
  2. Click its "Terms of Service" link (opens `/terms`).
  3. Navigate to `/privacy` in the same tab.
  4. Return to `/`.
- **Expected:**
  - On `/terms` and `/privacy` the modal is NOT rendered — the user can actually read the documents they are being asked to accept.
  - Back on `/` the blocking modal reappears (consent still pending).
- **Automated:** Yes (client/src/components/ConsentModal.test.tsx — "never covers the legal pages it links to")

### LAND-016 - Dark-mode AA contrast on landing accent and legal muted text
- **Priority:** P3
- **Type:** Regression
- **Origin:** PR #117 (accent `text-brand-600` must pair `dark:text-brand-500` on the dark background) and PR #120 (legal footer muted text must be `slate-500`, not `slate-400` at 2.55:1)
- **Preconditions:** Anonymous browser; ability to switch OS/emulated color scheme.
- **Steps:**
  1. Load `/` in dark mode; inspect the hero card's sentence and note, the "Sign in" link beside the primary, the feature cards' lines and the footer.
  2. Load `/privacy` and `/terms` in dark mode; inspect the footer "© 2026 AllotJar" and "Last updated" muted text.
- **Expected:**
  - The landing rides the warm tokens (restyle PR 15): the card and the feature cards are the dark `--color-card`, the muted lines `slate-500` of the inverted ramp, the "Sign in" link the brightened brand-500 green; the room's pale ink ("Sign in", the wordmark) and the gold word clear AA/3:1 on the green in both modes.
  - Legal muted text renders at slate-500 or better; an axe scan of both pages in both themes reports no A/AA contrast violations.
- **Automated:** Yes (client/e2e/landing.spec.ts + client/e2e/legal.spec.ts — axe WCAG A/AA in light and dark)

## SEO artifacts — head, robots, sitemap, prerender

### LAND-017 - Served HTML head: title, description, canonical, robots meta, JSON-LD
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Any built deployment of the app (production or staging host works); fetch tool (curl/view-source).
- **Steps:**
  1. Fetch `/` and inspect `<head>` of the raw response.
  2. Parse the `application/ld+json` block.
- **Expected:**
  - `<title>AllotJar — Zero-Based Budgeting App</title>` (em dash).
  - Meta description starting "AllotJar is a zero-based budgeting app crafted in Europe…".
  - `<link rel="canonical" href="https://www.allotjar.com/">`; `<meta name="robots" content="index, follow, max-image-preview:large">`; `<meta name="theme-color" content="#1F6B4D">`; favicon links to `/brand/allotjar-favicon.svg` + PNG sizes.
  - JSON-LD parses as valid JSON: `@type: SoftwareApplication`, `applicationCategory: FinanceApplication`, `offers.price: "0"` / `priceCurrency: "EUR"`, `url: https://www.allotjar.com/`. Being a data block it is NOT blocked by the CSP (`script-src 'self'` doesn't apply to `type="application/ld+json"`), and no CSP violation appears in the console.
- **Automated:** No

### LAND-018 - Open Graph and Twitter card tags plus share image asset
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Built deployment; fetch tool.
- **Steps:**
  1. Inspect the OG/Twitter meta tags in the served `/` HTML.
  2. `GET /og/allotjar-og.png` on the app host.
- **Expected:**
  - `og:type=website`, `og:site_name=AllotJar`, `og:title=AllotJar — Zero-Based Budgeting App`, `og:url=https://www.allotjar.com/`, `og:image=https://www.allotjar.com/og/allotjar-og.png` with `og:image:width=1200`/`height=630`, `og:image:alt`, `og:locale=en_GB`.
  - `twitter:card=summary_large_image` + title/description/image/alt tags present.
  - The image asset exists on the app host and is a 1200×630 PNG. (The absolute `www` URL inside the tags resolves now that `www` serves the production app — see LAND-040.)
- **Automated:** No

### LAND-019 - robots.txt and sitemap.xml served correctly
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Built deployment (fetch from `www.allotjar.com` — these are static files under `client/public/`, served ahead of the SPA fallback).
- **Steps:**
  1. `GET /robots.txt`.
  2. `GET /sitemap.xml`.
- **Expected:**
  - robots.txt: `User-agent: *`, `Allow: /`, and exactly these Disallow lines: `/account`, `/accounts`, `/transactions`, `/reports`, `/jars`, `/people`, `/allocation`, `/import`, `/help`, `/accept-invite`; `Sitemap: https://www.allotjar.com/sitemap.xml`. `/login`, `/privacy`, `/terms` are NOT disallowed (crawlable).
  - sitemap.xml: valid urlset with exactly 3 URLs — `https://www.allotjar.com/` (priority 1.0, changefreq weekly), `/privacy` and `/terms` (0.3, yearly), all `lastmod 2026-07-01`. Every listed URL is allowed by robots.txt and actually renders (cross-check LAND-001/011/012).
- **Automated:** No

### LAND-020 - Prerendered landing is fully indexable without JavaScript
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Production build output (`client/dist/index.html` after `npm run build`) or the production host; JS-disabled fetch.
- **Steps:**
  1. Fetch `/` without executing JavaScript.
  2. Search the HTML inside `<div id="root">`.
  3. Load the same URL with JS enabled and watch the console.
- **Expected:**
  - The static markup contains the full landing content: H1 "Give every euro a job.", the sentence, the three feature card titles and lines, the closing line, the footer links — enough for crawlers and link scrapers.
  - With JS on, `createRoot` (not `hydrateRoot`) replaces the static markup on mount: no React hydration-mismatch warnings in the console; the interactive landing (or splash → landing) appears seamlessly.
- **Automated:** No

### LAND-021 - Prerender failure is non-fatal and leaves the CSR shell intact
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #117 — `scripts/prerender.mjs` must never break the build/deploy; it also rejects suspicious markup < 100 chars
- **Preconditions:** Local checkout of `client/`; ability to sabotage the prerender (e.g. temporarily break an import in `src/prerender/landing-entry.tsx`) — do this in a scratch worktree, not the user's tree.
- **Steps:**
  1. Break the prerender entry and run `npm run build`.
  2. Inspect the build exit code, its log, and `dist/index.html`.
- **Expected:**
  - The build exits 0. The log contains a warning matching "prerender: skipped, CSR index.html left intact - …".
  - `dist/index.html` keeps the empty `<div id="root"></div>` but retains all Phase-0 head SEO (title/meta/OG/JSON-LD) — degraded but shippable.
  - Also: a stub entry returning markup shorter than 100 chars is rejected the same way (treated as suspicious, CSR shell kept).
- **Automated:** No

### LAND-022 - Non-JS scrape of a legal page sees the landing head (accepted trade-off)
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Built deployment; JS-disabled fetch.
- **Steps:**
  1. Fetch `/privacy` without JavaScript and inspect `<title>` and OG tags.
  2. Fetch `/privacy` with JavaScript (or via a JS-rendering crawler) and inspect the rendered content.
- **Expected:**
  - Step 1: the response is the SPA shell — title "AllotJar — Zero-Based Budgeting App" and the landing OG tags, with the prerendered landing markup (legal pages are deliberately CSR-only). This is the documented, accepted behavior — not a bug to "fix" in test reporting.
  - Step 2: the rendered page shows the Privacy Policy and `document.title` "Privacy Policy — AllotJar" (what Google's JS rendering indexes via the sitemap).
- **Automated:** No

### LAND-023 - theme-init.js applies the theme pre-paint under the strict CSP
- **Priority:** P2
- **Type:** Regression
- **Origin:** CSP hardening (security review) — `script-src 'self'` forbids inline scripts, so the pre-paint theme snippet must remain the external `/theme-init.js`
- **Preconditions:** Anonymous browser with `localStorage['zbb.theme'] = 'dark'` set for the app origin; OS in light mode (to prove the stored key wins).
- **Steps:**
  1. Hard-reload `/` and observe the very first painted frame (throttle CPU/network if needed).
  2. Check the network tab for `/theme-init.js` and the console for CSP violations.
  3. Repeat with `zbb.theme` removed and the OS in dark mode.
- **Expected:**
  - Step 1: the landing paints dark from the first frame — no white flash (the script is render-blocking in `<head>`).
  - Step 2: `/theme-init.js` is fetched as an external same-origin script with HTTP 200; zero CSP violations.
  - Step 3: with no stored key, the OS `prefers-color-scheme: dark` applies pre-paint instead.
- **Automated:** No

## Analytics consent banner & GA consent-mode gating

### LAND-024 - Consent banner shows when the flag is on and no choice is stored
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Server `Features:Analytics=true`; browser with no `zbb.analyticsConsent` key; anonymous visitor (banner is auth-independent).
- **Steps:**
  1. Navigate to `/` (landing, signed out).
  2. Inspect the bottom of the viewport after `/api/features` resolves.
  3. Sign in and navigate around; check the banner persists until a choice is made.
- **Expected:**
  - A non-modal region `role="region" aria-label="Analytics consent"` is pinned to the bottom with the exact copy: "We use **Google Analytics** to understand how the app is used and improve it. We never send your name, email, account names or any amounts — only anonymous usage. You can change this anytime under **Help**." and two buttons "Decline" / "Accept".
  - It appears only after the features fetch returns `analytics:true` (client default is `analytics:false`, so there is no flash-on before the fetch).
  - No focus trap — the page behind stays fully usable; the banner shows on the anonymous landing, on `/login`, and inside the authed app alike.
- **Automated:** Partial (client/e2e/a11y.spec.ts — banner rendered with the flag forced on, axe-only assertions)

### LAND-025 - Accept: consent persisted and GA starts with Consent Mode v2 sequence
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Production deployment (flag on + measurement ID `G-55WS48MJ91` in the bundle — GA ships ONLY in the production bundle; the staging build omits the measurement ID, so analytics is inert there); no stored consent; dev tools open on network + `window.dataLayer`.
- **Steps:**
  1. Load `/` and click "Accept" on the banner.
  2. Inspect `localStorage`, the injected scripts, and the `dataLayer` sequence.
- **Expected:**
  - `localStorage['zbb.analyticsConsent'] = 'granted'`; the banner disappears immediately and never returns on later loads.
  - gtag start order: Consent Mode v2 default with everything denied → GA script injected (only now does a request to googletagmanager.com occur) → `config` with `send_page_view:false`, `anonymize_ip:true`, `allow_google_signals:false`, `allow_ad_personalization_signals:false` → `consent update { analytics_storage: 'granted' }`.
  - A synthetic initial `page_view` fires for the current path (redacted `page_path` + origin-prefixed `page_location`), plus a `consent_updated` event with param `consent: 'granted'`.
- **Automated:** Partial (client/src/analytics/analytics.test.ts — start gating, idempotent start, consent persistence; not the DOM banner flow)

### LAND-026 - Decline: choice persisted and GA never loads
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Production deployment; no stored consent; network tab open.
- **Steps:**
  1. Load `/` and click "Decline".
  2. Browse several pages, sign in, reload.
  3. Filter network requests for `googletagmanager.com` / `google-analytics.com`.
- **Expected:**
  - `localStorage['zbb.analyticsConsent'] = 'denied'`; banner gone and does not reappear on reload.
  - Zero requests to any Google Analytics host at any point — the script is never injected; `track()` calls are inert no-ops.
- **Automated:** Partial (client/src/analytics/analytics.test.ts — nothing loads/fires before start; consent persistence)

### LAND-027 - Analytics flag off (default): no banner anywhere
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Local/default deployment with `Features:Analytics=false` (the code default); clean browser.
- **Steps:**
  1. Load `/`, `/login`, `/privacy`; sign in and visit the dashboard.
- **Expected:**
  - The consent banner never renders on any page (`available=false`); no `zbb.analyticsConsent` key is created; no GA network traffic. (The Help page's "Privacy" card and its "Google Analytics" switch are also absent — LAND-043.)
- **Automated:** No

### LAND-028 - Flag on but no measurement ID: banner shows, Accept is inert
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Build without `VITE_GA_MEASUREMENT_ID` (e.g. local dev) but server `Features:Analytics=true`; clean browser.
- **Steps:**
  1. Load `/`; confirm the banner shows.
  2. Click "Accept"; inspect storage and network.
- **Expected:**
  - Banner shows on the flag alone (by design, so it is testable without real GA).
  - Accept persists `granted` and dismisses the banner, but `isConfigured()` is false so nothing starts: no script injection, no dataLayer, no GA requests — silently inert, no console error.
- **Automated:** Partial (client/src/analytics/analytics.test.ts — gtag bridge inert without measurement id)

### LAND-029 - Corrupted or unavailable consent storage degrades to "undecided"
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Analytics flag on. Case A: `localStorage['zbb.analyticsConsent'] = 'yes'` (garbage). Case B: storage blocked (private-mode/permission context where `localStorage` access throws).
- **Steps:**
  1. Case A: load `/` and observe the banner.
  2. Case B: load `/`, click "Accept", reload.
- **Expected:**
  - Case A: any value other than exactly `granted`/`denied` reads as undecided → the banner shows; no crash.
  - Case B: the banner shows, Accept works for the session (state updates in memory) but cannot persist; after reload the banner reappears. All storage access is try/caught — no unhandled exception either way.
- **Automated:** No

### LAND-030 - No PII ever reaches GA: redacted paths and hashed user id
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #77 — GA4 shipped PII-safe by design (redactPath, safeParams whitelist, hashUserId)
- **Preconditions:** Production deployment with consent granted; signed in as `owner@example.com`; network tab capturing GA `collect` requests.
- **Steps:**
  1. Navigate to a parameterized route (e.g. an account detail page `/accounts/{id}`).
  2. Trigger a failed API call (e.g. a 404) to fire `api_error`.
  3. Inspect every outgoing GA request payload.
- **Expected:**
  - `page_view` for the detail route carries the collapsed template (`/accounts/:id`), never the real id; query strings/hashes are stripped from `page_path`/`page_location`.
  - `api_error` carries only whitelisted params (`api_endpoint` as a collapsed template, `api_status`).
  - The GA User-ID is a 32-hex SHA-256 derivative of the email — the raw email, display name, account names or any money amount appear in NO payload.
- **Automated:** Yes (client/src/analytics/analytics.test.ts — redactPath, apiEndpointTemplate, safeParams whitelist, hashUserId no-raw-email)

### LAND-031 - GA param whitelist: sample_data passes, unknown keys are silently dropped
- **Priority:** P2
- **Type:** Regression
- **Origin:** PR #170 gotcha — a new `track()` param key must be added to `ALLOWED_PARAM_KEYS` in `redact.ts` or it silently vanishes (bit the team with `sample_data`; nothing errors and tests stay green)
- **Preconditions:** Production deployment with consent granted; network tab capturing GA requests.
- **Steps:**
  1. Register a fresh account with "Start with sample figures to explore…" ticked; capture the `sign_up` event.
  2. Register another with the box unticked; capture again.
- **Expected:**
  - Both `sign_up` events reach GA and include the whitelisted `sample_data` param reflecting the checkbox (true/false).
  - No event ever carries a non-whitelisted key (spot-check payloads against the whitelist: method, line_type, direction, report_type, destination, theme, row_bucket, count_bucket, status, kind, split, step, source, context, api_endpoint, api_status, error_kind, consent, sample_data) — anything else is dropped client-side before send.
- **Automated:** Partial (client/src/analytics/analytics.test.ts — only whitelisted events/params forwarded; client/src/pages/LoginPage.test.tsx — includeSampleData wiring)

### LAND-032 - In-session opt-out does not stop gtag until the next reload
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Production deployment; consent previously granted and GA live in the current tab; Help page reachable.
- **Steps:**
  1. On `/help`, switch off the "Google Analytics" switch in the "Privacy" card.
  2. Without reloading, navigate between pages and watch GA traffic.
  3. Reload the app and repeat.
- **Expected:**
  - Step 2 (documented current behavior — `gtag.ts` has no stop path): `isStarted()` stays true, so events continue to emit for the remainder of the page lifetime; no `consent update: denied` is sent in-session.
  - Step 3: the persisted `denied` prevents the next session from starting — zero GA traffic after reload. Any change to the in-session behavior is a product decision, not a silent regression.
- **Automated:** No

## Staging banner & staging signup data-loss consent

### LAND-033 - Staging build shows the staging banner on landing, login and app shell
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Staging bundle (`VITE_APP_ENV=staging`, i.e. `staging.allotjar.com` — requires an allowlisted IP); anonymous browser.
- **Steps:**
  1. Load `/` (landing); inspect the top strip and scroll.
  2. Load `/login`.
  3. Sign in and inspect the app shell.
  4. Fetch `/` without JavaScript and search the raw HTML.
- **Expected:**
  - A sticky strip on the warn tone with `role="status"` reads exactly: "Staging · test data, may be reset" It stays pinned on scroll.
  - Present on the landing, on `/login`, and above `<main>` in the authed shell.
  - Step 4: the banner markup is inside the prerendered landing HTML (StagingBanner is SSR-safe and included in the staging prerender).
- **Automated:** Partial (client/src/components/StagingBanner.test.tsx — staging variant text; the staging build is not exercised in CI e2e, no prerender assertion)

### LAND-034 - Production/local build renders no staging banner
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Default build with `VITE_APP_ENV` unset (local dev) or `production` (the production deploy job).
- **Steps:**
  1. Load `/`, `/login` and the authed shell.
  2. Open `/login?register=1`.
- **Expected:**
  - No staging strip anywhere (`IS_STAGING` false → component returns null).
  - The registration form has NO staging data-loss checkbox — only the Terms checkbox (gating is build-time; there is no runtime toggle).
- **Automated:** Yes (client/src/components/StagingBanner.test.tsx — renders nothing in production/default build)

### LAND-035 - Staging registration requires the data-loss acknowledgment
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Staging bundle; anonymous visitor on `/login?register=1` with all other fields validly filled (names, email, password ≥ 8, currency/format, Terms ticked, sample-figures unticked).
- **Steps:**
  1. Leave the checkbox "I understand this is the AllotJar **staging** test environment, and that my data may be reset or permanently lost." unticked and submit.
  2. Tick it and submit again.
- **Expected:**
  - Step 1: submission is blocked client-side by native `required` validation on the checkbox — no `POST /api/auth/register` fires.
  - Step 2: registration proceeds normally (account created; the checkbox value itself is NOT sent to the API).
- **Automated:** Partial (client/src/pages/LoginPage.test.tsx — staging build adds the required acknowledgment `/my data may be reset or permanently lost/i`; the journey layer never runs a staging build)

### LAND-036 - Staging acknowledgment is client-gated only, never persisted
- **Priority:** P2
- **Type:** Edge
- **Origin:** PR #121 design (as the then-beta consent) — matches the existing `AcceptedTerms` pattern (validated, not stored) so the live DB needed no schema migration
- **Preconditions:** Staging deployment; API access (e.g. curl/Postman) and DB read access (or the ops query pack).
- **Steps:**
  1. Inspect the `POST /api/auth/register` payload sent by the staging form.
  2. Call the register endpoint directly with a valid payload (no staging-consent field exists to send).
  3. Check the created user record.
- **Expected:**
  - The request body carries no staging-acknowledgment field; the API accepts direct registrations without it (enforcement is client-side only — a documented, accepted limitation, not a defect).
  - No column/claim stores the staging acknowledgment; nothing breaks on the production build where the checkbox does not exist.
- **Automated:** No

## Host topology — production, staging, retired coming-soon

### LAND-037 - Host topology: www/apex serve the production app, staging is IP-allowlisted, app is retired
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Live DNS as deployed after the 2026-07 GA cutover (`www`+apex → proxied A to the VPS production site; `staging.allotjar.com` → proxied A to the VPS staging site behind a Cloudflare WAF IP-allowlist rule; the `app` record deleted; the coming-soon Worker retired from the zone).
- **Steps:**
  1. Load `https://www.allotjar.com/` and `https://allotjar.com/`.
  2. Load `https://www.allotjar.com/api/features`.
  3. From an ALLOWLISTED IP, load `https://staging.allotjar.com/` and `/api/features`.
  4. From a NON-allowlisted IP (e.g. a phone on mobile data), load `https://staging.allotjar.com/`.
  5. Load `https://app.allotjar.com/`.
- **Expected:**
  - Step 1: both serve the production app (public landing, NO staging banner); production and staging are separate IIS stacks with separate SQL databases — accounts do not cross over.
  - Step 2: the flags JSON — the production API on its own port answers through the same host.
  - Step 3: the staging app (landing WITH the staging banner); its `/api/features` answers.
  - Step 4: blocked by the Cloudflare WAF rule (Cloudflare block page / 403 — never the app).
  - Step 5: DNS no longer resolves (record deleted) — the old `app.allotjar.com` beta hostname is retired.
- **Automated:** No

### LAND-038 - [RETIRED] Coming-soon works with zero JavaScript under CSP script-src 'none'
- **Priority:** P3 (retired — the coming-soon page no longer serves on any host; applies only if `marketing/coming-soon/` is ever redeployed)
- **Type:** Happy
- **Preconditions:** A deployment of `marketing/coming-soon/` (none live since the 2026-07 GA cutover); browser with JS disabled; header-inspection tool.
- **Steps:**
  1. Inspect the response headers of `/`.
  2. Load the page with JavaScript disabled.
- **Expected:**
  - Headers include the strict CSP with `script-src 'none'` (the `_headers` file is honored on the Worker) plus the frame protections; no scripts are served or executed.
  - The page renders fully without JS: the currency word still cycles (CSS-only animation), the mailto CTA works, Hanken Grotesk loads from Google Fonts (allowed by the style/font CSP directives), OG meta present (canonical `https://www.allotjar.com/`).
- **Automated:** No

### LAND-039 - [RETIRED] Currency rotator shows exactly one word from the very first frame
- **Priority:** P3 (retired with the coming-soon page — the archived source keeps the fix; re-verify only on redeploy)
- **Type:** Regression
- **Origin:** PR #134 (`0386c62`) — first-paint pile-up: all 18 absolutely-stacked words painted at once as a gold block before the opacity animation settled; final fix is a slot-machine track inside a one-line `overflow:hidden` window (geometric clipping, `margin-top` scroll)
- **Preconditions:** `marketing/coming-soon/index.html` served locally (no live deployment since the GA cutover); Chromium and WebKit; ability to capture the first rendered frame (e.g. Playwright screenshot on `domcontentloaded`).
- **Steps:**
  1. Capture frame 1 of a cold load and count the visible rotator words.
  2. Watch a full cycle of the animation.
  3. Reload with `prefers-reduced-motion: reduce` emulated.
  4. Inspect the accessibility output of the H1.
- **Expected:**
  - Frame 1 shows exactly one word ("euro"); at no point are two or more words visible simultaneously (clipping guarantees it, including first paint) — never a gold block.
  - The track cycles through all 18 words (euro, pound, dollar, franc, yen, rupee, krona, krone, złoty, koruna, forint, leu, rand, real, peso, dirham, riyal, lira — one per distinct `CURRENCY_NOUNS` noun, euro first; verify the list is still in sync with `client/src/lib/money.ts`); descenders (złoty, riyal) are not clipped.
  - Reduced motion: no distracting cycling. Screen readers get the stable sr-only text — the H1 reads "Give every euro a job." (rotator is `aria-hidden`).
- **Automated:** No (verified manually on Chromium + WebKit at fix time; nothing in CI)

### LAND-040 - OG share image resolves on the production host after GA cutover
- **Priority:** P1
- **Type:** Happy
- **Origin:** staging/beta split (PR #121/#124) — the app's OG URL was deliberately GA-facing and 404'd during beta (Worker-only `/og.png` was the share surface then); at GA cutover the app took over `www`, so its `og:image` URL MUST now resolve
- **Preconditions:** Live post-cutover topology (`www` = the production app).
- **Steps:**
  1. `GET https://www.allotjar.com/og/allotjar-og.png`.
  2. Paste `https://www.allotjar.com/` into a link-preview debugger (e.g. an OG scraper).
- **Expected:**
  - Step 1: 200, a 1200×630 PNG (the brand-mark share card from `client/public/og/`).
  - Step 2: the preview uses the app's landing title and the `og/allotjar-og.png` image (the old Worker-era `/og.png` path is gone with the Worker — a 404 there is fine).
- **Automated:** No

## Gap-fill additions — Help page (guide & analytics controls)

> Scope note: `HelpPage` (`/help`, behind `RequireAuth`, always mounted) is documented in the routing-shell map §2 but was not owned by any case file — 05-onboarding cedes "the Help page's topic rows and analytics consent switch" to a routing/shell sibling that does not exist, and LAND-027 defers the "Privacy" card to that same non-existent file. This file owns the analytics-consent surface, so the guide-link event and the Google Analytics switch belong here; the topic-row render + route load sit here too (they may alternatively be exercised from 26-ux-states). Onboarding's "Replay welcome tour" action stays owned by ONBD-027; the in-session opt-out/gtag behavior stays owned by LAND-032 — this section adds only the untested surfaces.

### LAND-041 - Help page route loads with the hero, the Topics card and its topic rows
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** `owner@example.com` signed in (Help is an authed AppShell page); default/local build with `Features:Analytics=false` (so the "Privacy" card is absent and the Topics card spans the page under the hero). Budget currency EUR for the noun spot-check.
- **Steps:**
  1. From inside the app, navigate to `/help` (or deep-link `/help` while signed in — RequireAuth passes it straight through).
  2. Read the top bar, the green hero and the Topics card's header.
  3. Enumerate the topic rows (`h3` headings holding a button) in document order; open one with the mouse and another with the keyboard (Enter, then Space).
  4. Open the hero's (i) and read it; open "Good to know" and read its bullets.
- **Expected:**
  - Exactly one `<h1>` "Help & guide" (the top bar's, from AppShell `title`); no subtitle, no month switcher, no page action. The AppShell chrome wraps the page with `active="help"` (Help nav item current; on a phone the More tab).
  - The green hero leads the page in the KPI row's place (150px tall on desktop, 112px on a phone): a `region` named "Zero-based budgeting" (its label, with the (i) "About zero-based budgeting"), the white headline "Give every euro a job" using the budget-currency noun (noun = `currencyNoun(budgetCurrency)`, the active household's currency from `/auth/me`; a member of a USD household reads "Give every dollar a job" — same mapping as LAND-005), and a decorative glass jar (gold lid) at its right. The (i) holds "Allot all your income until **Remaining to budget** reaches zero: assign it across spending lines, savings and jars before the month begins. **Spent** fills in automatically from your transactions, so there’s nothing to total by hand." (mounted only while open: hover, focus or click).
  - The Topics card (h2 "Topics"): header link "Replay welcome tour" (ONBD-027; "Replay tour" on a phone), and no user guide link (LAND-042); with every flag on, exactly eleven rows (icon tile | name | chevron), each an `h3 > button[aria-expanded][aria-controls]`, in this order: "Months & appearance", "Accounts", "Saving with jars", "Transactions", "Importing a statement", "Bills & due dates", "Reports", "People & allocation", "Your account", "Install the app", "Good to know". Accounts, Saving with jars, Importing a statement, Reports and People & allocation each show only while their page's flag is on. All closed on load; no "Privacy" card renders (flag off → `useAnalytics().available === false`).
  - A row opens in place (mouse, Enter or Space; focus stays on the row) to the panel it controls (`aria-controls`; no landmark of its own, so open topics add no regions) holding its facts as bullets, the chevron turns, the rows below move down; a second activation closes it (the panel keeps the `hidden` attribute while closed). Rows are independent: opening one leaves the others as they were.
  - "Good to know" holds exactly: "Edits happen in place: Enter saves, Escape cancels.", "Deleting a line or account never deletes its transactions.", "Amounts accept “12.50” or “12,50”, and sums like “20+30”; every figure is exact to the cent.". "Bills & due dates" says a line gets a **Bill due day**, **Mark paid** "ticks it off for the month you’re viewing", both in the line's ⋯ (there is no Paid checkbox); "Saving with jars" says a jar sits in one of your accounts, names **Repeats**, **Fixed amount each month** and **Move money**, and that AllotJar puts what to set aside "on the jar’s line in your **Savings** group"; "Your account" says more than one household is switched from "the same menu" (the account menu).
- **Automated:** Yes (client/src/pages/HelpPage.test.tsx — the h1, the hero region + noun, the nine rows in order, opening/closing by mouse and keyboard, every topic's facts; client/e2e/help.spec.ts — the hero over the full-width Topics card, rows by mouse and keyboard with the layout moving, phone stacking; the AppShell/nav-active chrome is covered by AppShell.test)

### LAND-042 - Retired: the "User guide" link (removed 19 Oct 2026)

The link pointed at docs/USER_GUIDE.md on GitHub, which no longer opens for users since the repository turned private, so the Help page no longer shows it and `help_guide_opened` is gone. Automated: HelpPage.test.tsx and e2e/help.spec.ts check that no user guide link renders. The original case, for reference:

- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Signed in on `/help`. To observe the GA event on the wire: production bundle (`G-55WS48MJ91`) with consent granted and a GA `collect` capture; the link is present and clickable on any build.
- **Steps:**
  1. In the Topics card's header, locate the "User guide ↗" link (accessible name "Complete user guide (opens in a new tab)") and inspect its attributes.
  2. Click it and observe the new browser tab and the GA network traffic.
  3. Repeat the click with analytics declined (or the flag off).
- **Expected:**
  - The link `href` is exactly `https://github.com/maskit89/AllotJar/blob/main/docs/USER_GUIDE.md` with `target="_blank"` and `rel="noreferrer"` — it opens the doc in a new tab with no opener/referrer leak, leaving the `/help` tab in place. Its arrow icon is `aria-hidden`.
  - When tracking is live (step 2: production + consent granted), the click fires exactly one `help_guide_opened` GA event (`track(EVENTS.helpGuideOpened)`), a whitelisted event name carrying no extra params.
  - Step 3: with consent denied or the flag off, the click still navigates to the guide but sends nothing — `track()` is an inert no-op when tracking has not started (no console error, no `collect` request).
- **Automated:** Yes (client/src/pages/HelpPage.test.tsx — the href, `target="_blank"`, `rel="noreferrer"` and the `help_guide_opened` call; client/e2e/help.spec.ts — the name, visible text and attributes in a browser; the GA wire itself is not observed)

### LAND-043 - "Privacy" card: the "Google Analytics" switch's three states
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** `Features:Analytics=true` (flag on so `available === true`); `owner@example.com` signed in on `/help`. Each consent state is reached by seeding `localStorage['zbb.analyticsConsent']` (`granted` / `denied` / key absent) before load. Production bundle (with `G-55WS48MJ91`) to also observe GA start; a flag-on build with no measurement ID (e.g. the staging bundle) to prove the inert path.
- **Steps:**
  1. With the key absent (undecided), load `/help`; read the "Privacy" card, its (i) and the switch row.
  2. Click the switch; inspect `localStorage`, the switch and the bottom consent banner.
  3. Reload with `zbb.analyticsConsent = 'denied'`; read the switch; then click it.
  4. With `zbb.analyticsConsent = 'granted'`, read the switch; then click it (also from the keyboard: Space / Enter).
- **Expected:**
  - The card renders only because the flag is on (`available`): on desktop (content 940px and wider) the right-hand column beside the Topics card, sticky while the page scrolls; on a phone the last card. Its title is "Privacy" with the (i) "About privacy" holding the blurb: "We use Google Analytics to understand how AllotJar is used, so we can improve it. We never send your name, email, account or category names, or any amounts: only anonymous page views and feature-usage events. You can change this at any time."
  - Its one row is a `button role="switch"` named "Google Analytics" (chart tile | name | track) whose `aria-checked` tracks the stored consent exactly: `granted` → `true`; `denied` → `false`; undecided → `false` with the sub-line "Not chosen yet" under the name (the switch's accessible description). No "Status: …" sentence and no Turn on / Turn off buttons.
  - A click when `aria-checked` is false calls `accept()`; when true, `decline()`.
  - Opt-IN (steps 2 & 3): `accept()` persists `localStorage['zbb.analyticsConsent'] = 'granted'`, the switch turns on and "Not chosen yet" goes. If the bottom consent banner was showing (it shows only when consent is `null`), it disappears now that consent is no longer null. On the production bundle this starts GA with the Consent Mode v2 sequence (cross-ref LAND-025); on a flag-on build without a measurement ID (e.g. staging) it persists `granted` but starts nothing (`isConfigured()` false — cross-ref LAND-028).
  - Opt-OUT (step 4): `decline()` persists `'denied'` (the value is set, NOT cleared to `null`); the switch turns off without a sub-line. The bottom consent banner does NOT reappear (it needs `consent === null`, and this is `'denied'`). The provider's `reset()` is not wired to the UI, so the choice persists rather than reverting to undecided. In-session gtag keeps emitting until the next reload (cross-ref LAND-032).
  - Cross-check: on a default build with the flag off, this whole card is absent (LAND-027) and no consent key is created.
- **Automated:** Yes (client/src/pages/HelpPage.privacy.test.tsx — the card only when `available`, the (i) blurb, the switch's three states and which of `accept`/`decline` a click or a key calls; client/e2e/help.spec.ts — the real provider: undecided + banner → accept persists `granted` and the banner goes → Space declines and persists `denied`, the sticky column, and axe with the card; client/e2e/a11y.spec.ts — axe with the banner and the switch, light and dark)
