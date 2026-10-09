# Subsystem map: Reports, Landing page, Legal pages, Feature flags

Ground-truth feature inventory for QA test design. All paths are relative to the repo root
`<local>\Documents\Projects\ZeroBudget` unless stated otherwise. Verified against the
working tree on 2026-07-15.

---

## 1. Screens & routes

### 1.1 Client routes (client/src/App.tsx)

| Path | Component | Shown when | Guard / gating |
|---|---|---|---|
| `/` | `LandingPage` | anonymous visitor, after auth bootstrap finishes | none (public). While `bootstrapping`, an `AuthSplash` spinner renders instead so an authed user never flashes the landing (App.tsx:73-81) |
| `/` | `DashboardPage` | authenticated | same route; branches on `isAuthenticated` |
| `/privacy` | `PrivacyPage` (wrapped in `LegalLayout`) | always - public, available signed in or out (App.tsx:71) | none |
| `/terms` | `TermsPage` (wrapped in `LegalLayout`) | always - public (App.tsx:72) | none |
| `/reports` | `ReportsPage` | authenticated AND `features.reports === true` | route is **conditionally registered** (App.tsx:143-152): flag off => the route does not exist => falls to `*` => `Navigate to "/"` (dashboard for authed users). Also `RequireAuth` (redirect to `/login?returnUrl=...`) |
| `*` | `Navigate to "/"` | any unknown path | replace navigation (App.tsx:179) |

Other flag-gated client routes (context for sections 3/5): `/accounts`, `/accounts/:id` (`features.accounts`),
`/jars` (`features.jars`), `/people`, `/allocation` (`features.householdAllocation`; `/allocation`
additionally only in nav when `isShared`), `/import` (`features.camtImport`). `/members` and `/access`
are unconditional redirects to `/people` (App.tsx:131-132).

### 1.2 Nav gating (client/src/components/AppNav.tsx:31-40)

Sidebar/topbar items with exact labels: `Budget` (always), `Transactions` (always), `Accounts`
(`features.accounts`), `Jars` (`features.jars`), `Reports` (`features.reports`), `People`
(`features.householdAllocation`), `Allocation` (`features.householdAllocation && isShared`), `Help`
(always). Note: contrary to the file's doc comment, the People nav item IS hidden when
`householdAllocation` is off - the code gates it on the flag (AppNav.tsx:37); "always visible"
applies only to solo-vs-shared gating, not the feature flag.

### 1.3 SEO / prerender / static assets

- `client/index.html` head: title `AllotJar - Zero-Based Budgeting App` (em dash in source), meta
  description, canonical `https://www.allotjar.com/`, `robots: index, follow, max-image-preview:large`,
  full Open Graph (og:image `https://www.allotjar.com/og/allotjar-og.png`, 1200x630, locale en_GB) +
  Twitter `summary_large_image` card, `SoftwareApplication` JSON-LD (price "0", EUR). `theme-init.js`
  loads externally (not inline) so CSP `script-src 'self'` covers it, and applies the dark class
  before paint from `localStorage['zbb.theme']` or `prefers-color-scheme`.
- Prerender: `client/package.json` build = `tsc -b && vite build && node scripts/prerender.mjs`.
  `scripts/prerender.mjs` builds an SSR bundle of `client/src/prerender/landing-entry.tsx`
  (`renderToStaticMarkup(<LandingPage/>)`) and replaces `<div id="root"></div>` in `dist/index.html`.
  **Deliberately NON-FATAL**: any failure logs `prerender: skipped, CSR index.html left intact - ...`
  and the deploy still ships (prerender.mjs:57-61). It rejects markup < 100 chars as suspicious.
  The SPA mounts with `createRoot` (NOT `hydrateRoot`) so there is no hydration mismatch; the static
  landing markup is simply replaced on mount (main.tsx:12).
- `client/public/robots.txt`: `Allow: /`; Disallow: `/account`, `/accounts`, `/transactions`,
  `/reports`, `/jars`, `/people`, `/allocation`, `/import`, `/help`, `/accept-invite`; sitemap ref
  `https://www.allotjar.com/sitemap.xml`. `/login`, `/privacy`, `/terms` are crawlable.
- `client/public/sitemap.xml`: exactly 3 URLs - `/` (priority 1.0, weekly), `/privacy` and `/terms`
  (0.3, yearly), all `lastmod 2026-07-01`.
- OG image exists at `client/public/og/allotjar-og.png` (generated one-off by
  `client/scripts/make-og-image.mjs`, committed, not part of the build).
- Legal pages are **CSR only** (not prerendered): a non-JS scrape of `/privacy` sees the landing
  shell's head/OG. `LegalLayout` sets `document.title = "{title} - AllotJar"` in a mount effect and
  restores the previous title on unmount (LegalLayout.tsx:22-28).

---

## 2. UI controls & user actions (exact visible labels)

### 2.1 ReportsPage (client/src/pages/ReportsPage.tsx)

Rendered inside `AppShell active="reports" title="Reports"`.

- Loading text: `Loading your reports...` (ellipsis char; line 128).
- Error banner (role="alert"): `Could not load your reports.` (only for the trends fetch, line 51).
- Empty state (icon medallion + dashed card): title `No budget data yet`, description
  `Once you've built a budget or two, your trends will appear here.` (lines 132-138).
- **Hero** (gold number band): eyebrow `Saved this month`, big amount = formatted saved-this-month;
  aria-label `Saved this month: {amount}`. Tiles: `Avg monthly spend` -> amount; `Savings rate` -> `{n}%`.
- **Card "Income vs spending"**: legend swatches labelled `Income` (solid brand) and `Spent`
  (ghost/bordered). One column per trend point; each column wrapper has
  `aria-label="Trend for {Mon YYYY}"` (e.g. `Trend for Jun 2026`); bars carry `title="Income {money}"` /
  `title="Spent {money}"`; month tick label is the short month (`Jan`...`Dec`), the last (current)
  point tinted brand.
- **Card "Annual overview"** (renders only when `annual?.months` non-empty): year navigator -
  buttons with aria-labels `Previous year` and `Next year` (glyphs: left/right triangles) around the
  year number. Table headers: `Month | Income | Spent | Net`; rows show an em dash in all three
  money cells when `hasBudget === false`; footer row `Total`.
- **Card "Average monthly spending by category"** (renders only when `annual?.categories`
  non-empty): subtitle `Each category's spend averaged over the {n} budgeted month(s) of {year}.`
  (singular/plural switch on `budgetedMonths === 1`). Rows: category name, optional violet `Fund`
  badge when `kind === 'Savings'`, right side `{avg}/mo · {total} total`, sky-blue bar with
  `aria-label="Average for {name}"`; row wrapper `aria-label="Average spending for {name}"`.
- **Card "Spending by category"**: month `<select>` with `aria-label="Breakdown month"`, options =
  the trend window's months newest-first, labelled `{Mon YYYY}` (values are keys like `2026-05`).
  Empty text: `No spending recorded for this month yet.` Rows: name (+ `Fund` badge for Savings),
  `{money} · {pct}%` (share of the month's category total, `0%` when total is 0), hue-coloured bar
  (`role="img"`, `aria-label={name}`); row wrapper `aria-label="Spending for {name}"`.
- Analytics: `track(EVENTS.reportViewed = 'report_viewed', { report_type: 'annual' })` on either
  year button; `{ report_type: 'breakdown' }` on month-select change. No event fires for the
  initial default view.

### 2.2 LandingPage (client/src/pages/LandingPage.tsx)

All navigation is plain `<a>` (no router) - required for SSR-safety.

- `StagingBanner` at top (only when `VITE_APP_ENV === 'staging'`): role="status", text
  `Staging - this is the AllotJar test environment. Features may change and your data can be reset or lost without notice.`
- Header: logo link (aria-label `AllotJar home`, href `/`), nav (aria-label `Primary`): `Sign in`
  -> `/login`; primary CTA `Get started` -> `/login?register=1`.
- Hero: eyebrow `Zero-based budgeting · crafted in Europe, at home anywhere`; H1
  `Give every {noun} a job.` - noun initialises to `euro` (SSR/prerender output) and a mount-only
  effect swaps in the visitor's locale currency noun via `currencyNoun(detectLocaleDefaults().currency)`
  (lines 149-152; e.g. en-US browser -> "dollar", unknown -> "unit"). CTAs:
  `Create your free account` -> `/login?register=1`; `Sign in` -> `/login`. Sub-copy:
  `Free to start · No card required`.
- Hero right panel ("Your jars" shelf): `€2,480`, `set aside across 3 jars this year`, three
  decorative jars - `Insurance` 90%, `Holiday` 70%, `New car` 40% - each with accessible label
  `{label}: {pct}% funded`, no in-jar percent text (a11y contrast).
- Features section (heading `Everything you need to budget with confidence`): 6 cards -
  `Zero-based budgeting`, `Sinking-fund jars`, `All your accounts`, `Reports & trends`,
  `Budget as a household`, `Private & secure`.
- How-it-works (heading `How AllotJar works`, `Three simple steps, every month.`): `1 Plan the month`,
  `2 Track as you spend`, `3 Adjust and save`.
- FAQ (heading `Frequently asked questions`), 5 Q/As: `What is zero-based budgeting?`,
  `Can I use AllotJar outside Europe?`, `What makes AllotJar different?`,
  `Can I share my budget with my partner?`, `How much does AllotJar cost?`.
- Closing CTA band: `Ready to give every {noun} a job?`, button `Create your free account`
  -> `/login?register=1`.
- Footer (nav aria-label `Footer`): `© {currentYear} AllotJar · Give every {noun} a job.`; links
  `Privacy` -> `/privacy`, `Terms` -> `/terms`, `Sign in` -> `/login`, `Create account` -> `/login?register=1`.

### 2.3 LegalLayout / PrivacyPage / TermsPage

- LegalLayout header: brand link (aria-label `AllotJar home`) + `Sign in` -> `/login`. H1 = page
  title; `Last updated: {lastUpdated}` line. Footer nav: `Home`, `Privacy`, `Terms`, `Sign in`,
  `© {year} AllotJar`.
- PrivacyPage: title `Privacy Policy`, lastUpdated `1 July 2026`. Sections: Who we are (controller =
  Christopher Muscat, individual, Malta), What data we collect, How and why we use your data,
  Cookies and analytics (GA4, denied-by-default Consent Mode v2, hashed user id), Who we share data
  with (hosting, Cloudflare, Google), International transfers, How long we keep it, How we protect
  your data, Your rights (6 GDPR rights + complaint to Malta IDPC, link `idpc.org.mt`), Children
  (16+), Changes, Contact. `mailto:privacy@allotjar.com` links throughout.
- TermsPage: title `Terms of Service`, lastUpdated `1 July 2026`. 13 numbered sections; governing
  law = Malta, exclusive jurisdiction Maltese courts; eligibility 16+; "Not financial advice"
  section; links to `/privacy` as `Privacy Policy`.

---

## 3. API endpoints

| Verb + route | Auth | Feature flag | Notes |
|---|---|---|---|
| `GET /api/reports/trends?months={n}` | `[Authorize]` (any household role incl. Read-only - no role gate) | `Reports` (controller-level `[FeatureGate(nameof(FeatureFlags.Reports))]`, ReportsController.cs:17) | `months` defaults to 6, server clamps to 1..24 (GetBudgetTrendsQueryHandler.cs:27). Returns `BudgetTrendsDto`. Client always calls `/reports/trends?months=6` (ReportsPage.tsx:41) |
| `GET /api/reports/annual/{year:int}` | `[Authorize]` | `Reports` | `year` has an `:int` route constraint (non-int -> 404) but NO range validation - year 0/9999/negative returns 12 empty months. Returns `AnnualSummaryDto` |
| `GET /api/features` | **anonymous** (no `[Authorize]`, FeaturesController.cs:12-26) | none (never gated by itself) | Returns the bound `FeatureFlags` options snapshot, camelCase JSON: `{accounts, multiCurrency, camtImport, reports, jars, householdAllocation, householdAccess, analytics}` |
| `GET /api/budget/{year:int}/{month:int}` | `[Authorize]` | none | Used by ReportsPage for the spending-by-category breakdown (full `BudgetMonthDto`); 404 when the month doesn't exist |

FeatureGate behaviour (src/AllotJar.Api/Features/FeatureGateAttribute.cs): an `IAsyncActionFilter`
that short-circuits with **404 NotFound** (empty body) when the named flag is off. Action filters
run after authentication/authorization, so an unauthenticated request to a gated+authorized
endpoint gets **401 first**; an authenticated request with the flag off gets **404**.

Full flag-to-controller map (grep of `[FeatureGate`):
- `Reports` -> ReportsController (all actions)
- `Accounts` -> AccountsController
- `CamtImport` -> ImportController
- `Jars` -> JarsController
- `HouseholdAllocation` -> MembersController AND AllocationController
- `HouseholdAccess` -> HouseholdAccessController
- `MultiCurrency` and `Analytics` gate **no controller** - MultiCurrency is client-behaviour only
  (e.g. AccountsPage currency picker), Analytics gates the GA consent banner/loading in the SPA.

Flag defaults (src/AllotJar.Api/Features/FeatureFlags.cs): everything `true` except
`Analytics = false`. `IsEnabled(unknownName)` returns `true` (switch default, line 50).
Config binding: `Features` section, `IOptionsSnapshot` (Program.cs:37) - flags are re-read per
request, so an appsettings edit applies without an app restart. `appsettings.json` explicitly sets
only Accounts/MultiCurrency/CamtImport/Reports (all true); the rest ride on code defaults.

Owner scoping: both report handlers use `ICurrentUser.OwnerId` - the household partition key
resolved by HouseholdResolutionMiddleware (falls back to the login's own id;
src/AllotJar.Api/Services/CurrentUser.cs:28, ICurrentUser.cs:23). So every member of a household
(any role) sees the same household-wide report data. Handlers throw
`ForbiddenAccessException("No authenticated user on the request.")` if no user (unreachable behind
`[Authorize]`).

---

## 4. Validation rules & exact error messages

Server:
- `GET /reports/trends`: `months` clamped via `Math.Clamp(request.Months, 1, 24)` - 0, negative and
  >24 are silently clamped, never a 400. Non-numeric `months` fails MVC model binding -> 400
  ProblemDetails (framework default).
- `GET /reports/annual/{year}`: `:int` constraint only; no year bounds; no 400 path.
- No FluentValidation validators exist for either report query (none under
  src/AllotJar.Application/Reports/).
- Feature-gated endpoint with flag off: bare `404 NotFound`, no body.

Client (ReportsPage):
- Trends fetch failure (network / 401-exhausted / 404-from-flag-off) -> error banner text
  `Could not load your reports.` - the only client-side error surface on the page.
- Breakdown-month fetch (`/budget/{y}/{m}`) failure -> **silently swallowed** (`.catch(() => {})`,
  line 66); the previously loaded month's breakdown stays on screen while the select shows the new
  month - a known stale-UI variant to test.
- Annual fetch failure -> silently swallowed (line 79); the Annual overview + Average-spending cards
  simply do not render (or keep showing the previous year's data if a later fetch fails -
  `setAnnual` only fires on success, so navigating to a failing year leaves the OLD year's table
  visible while the navigator shows the NEW year number).

Landing/legal pages have no forms and no validation.

---

## 5. State variants

### ReportsPage
- **Loading**: `Loading your reports...` paragraph (trends request in flight).
- **Error**: banner `Could not load your reports.` - replaces all content.
- **Empty** (`points.length === 0`, e.g. brand-new opt-out-of-sample account per PR #170): the
  `No budget data yet` EmptyState. `hasData` requires at least one point; hero/cards never render.
- **Partial**: trends OK but annual/breakdown fetch fails -> those cards absent/stale (see section 4).
- **Breakdown month with no spending** (all non-income actuals <= 0): text
  `No spending recorded for this month yet.`
- **Currency**: the entire page formats in `breakdownMonth.baseCurrency ?? 'EUR'`
  (ReportsPage.tsx:85). Until the breakdown month loads, the hero/annual figures render in EUR;
  they re-render in the month's currency afterwards. Selecting a breakdown month whose
  `baseCurrency` differs re-labels ALL cards, including annual totals. Since W08 every new month is
  created in the household's one budget currency (`BudgetCurrency.ResolveAsync`), so a differing
  month can only be legacy data from before W08. The ForeignAmounts migration never restamps a month,
  and it refuses to run while any household's months are in more than one currency (CURR-056), so
  on a migrated database a mixed history can only be seeded by hand.
- **Flag off (server `Features:Reports=false`)**: `/api/features` reports `reports:false` -> nav
  link hidden, `/reports` route unregistered (deep link -> redirect to `/`), and the API 404s as
  defence-in-depth. If the SPA's `/features` fetch *fails* (FeatureContext falls back to all-on,
  FeatureContext.tsx:36-39), the UI shows the Reports nav but every reports call 404s -> error banner.
- **Solo vs shared**: no difference on ReportsPage itself (data is household-scoped by OwnerId;
  every role incl. Read-only can view). Shared members see identical numbers.
- **Read-only role**: page fully functional (GET-only).
- **Session expiry mid-view** (PR #169/#171 context): reports calls ride the shared axios instance;
  a dead session redirects to `/login?...reason=expired` via the interceptor rather than leaving
  the page's own error banner.
- **Year navigation beyond data**: `Next year`/`Previous year` are unbounded; any year returns 12
  `hasBudget:false` months -> `annual.months` is always length 12, so the Annual card still renders
  with all-dash rows and 0 totals; the Average-spending card disappears (categories list empty).

### Landing / auth branch on `/`
- `bootstrapping` -> AuthSplash spinner (`role="status"`, sr-only `Loading...`).
- Anonymous -> LandingPage; authed -> DashboardPage.
- Signed-in visit to `/login` -> redirect honouring `?returnUrl` (safe-internal-path checked).
- Staging build (`VITE_APP_ENV=staging`, i.e. staging.allotjar.com) -> StagingBanner shows on the landing
  (SSR-safe, part of prerendered markup for staging builds); GA/prod build renders nothing.
- Currency-noun swap: prerendered/static HTML always says "euro"; after JS mounts, the noun follows
  browser locale (REGION_CURRENCY map in client/src/lib/money.ts:146-151; unlisted regions stay EUR;
  no `navigator` -> EUR). Footer tagline and closing CTA use the same noun.
- Dark/light: theme applied pre-paint by /theme-init.js; landing + legal pages are axe-scanned in
  both themes (client/e2e/landing.spec.ts, legal.spec.ts). Known past regressions: accent text must
  be `text-brand-600 dark:text-brand-500` for AA contrast on dark (PR #117 gotcha); legal footer
  text must be slate-500 not slate-400 (PR #120 gotcha).

### FeatureContext (client/src/features/FeatureContext.tsx)
- Defaults `ALL_ON` with `analytics: false` until `/features` responds; response is spread over the
  defaults (`{ ...ALL_ON, ...data }`) so missing keys stay on. Fetch errors ignored -> permanent
  all-on (analytics stays off). Loaded once per app mount, anonymously - flags are known even on the
  landing/login screens. There is a brief flag-flap window: a user with `Accounts` off sees the
  default all-on nav until the fetch resolves.

### Archived/deleted referents
- Annual "categories" are grouped by `(Name, Kind)` string across per-month category entities -
  renaming a category mid-year splits it into two rows; deleting it stops accumulation but past
  actuals still count. There is no id-stable category concept in reports
  (GetAnnualSummaryQueryHandler.cs:36-38 comment).
- Breakdown uses `BudgetMonthDto.categories[].totalActual`, which is transaction-derived at read
  time - deleting transactions retroactively changes historical reports.

---

## 6. Computed/derived values & money rules (as implemented)

Server (all decimal(18,4); actuals ALWAYS derived at read time via
`BudgetActuals.ApplyAsync` - src/AllotJar.Application/Budgets/BudgetActuals.cs):
- Per line: ActualAmount = sum(assigned whole transactions of the line's kind: BudgetAmount ?? Amount)
  + sum(split slices: Split.BudgetAmount ?? Split.Amount); `BudgetAmount` is set only on a row on a
  legacy account kept in another currency (its budget figure; the account keeps `Amount`), and the
  uncategorised figures in `ReportFigures` read the same. There is no exchange rate (W08 dropped `ExchangeRate`/`BaseAmount`):
  a row still waiting for its budget-currency amount (`FxPending`) and its slices count nowhere, and
  every report (trends, annual, month breakdown — all via `ReportFigures.ForMonthAsync`) leaves it out
  and only counts it in `fxPendingCount` on the DTOs, which ReportsPage does not display (RPT-042). Income lines roll up Income transactions; all other
  lines roll up Expense transactions. Split parents have `BudgetItemId == null` so no double count.
- Trend point (GetBudgetTrendsQueryHandler.cs:52-72):
  - `Income` = `month.TotalIncome` = sum of planned on Income-kind groups (BudgetMonth.cs:44-45).
  - `IncomeReceived` = sum of `TotalActual` over Income-kind categories.
  - `Planned` = `month.TotalPlanned` = sum of planned on non-Income groups (includes Savings).
  - `Spent` = sum of `TotalActual` over non-Income categories (includes Savings spending).
  - Window = the user's most recent N **budgets** (ordered Year desc, Month desc, take N) - NOT the
    last N calendar months; gaps are skipped, so points may be non-contiguous. Output sorted
    chronologically. Totals = simple sums over the points.
- Annual (GetAnnualSummaryQueryHandler.cs):
  - Always 12 `AnnualMonthDto` entries Jan-Dec, `Key = "{year:D4}-{month:D2}"`, `HasBudget` flag.
  - `TotalIncome/TotalPlanned/TotalSpent` = sums over the 12 entries.
  - `BudgetedMonths` = count of months with a budget (the averaging denominator).
  - `Categories`: accumulate each non-Income category's `TotalActual` keyed by `(Name, Kind)`;
    drop zero totals (`!= 0m` - negatives kept); `AveragePerMonth = Round(total / budgetedMonths, 2,
    MidpointRounding.AwayFromZero)` (0 when no budgeted months); ordered by AveragePerMonth desc.
  - DTO carries `TotalPlanned` but the client's annual table displays only Income/Spent/Net.

Client (integer minor units, scale 4 - client/src/lib/money.ts:14-27; `fromAmount = Math.round(x*10000)`):
- Hero `Saved this month` = `latest.incomeReceived - latest.spent` (minor units; can be negative -
  formats as negative money, no special styling).
- `Avg monthly spend` = `Math.round(totalSpentMinor / points.length)` (window average).
- `Savings rate` = `latestReceived > 0 ? Math.round(saved/received x 100) : 0` - % of the latest
  month only, 0% when nothing received (can be negative when overspent).
- Income-vs-spending bars plot `incomeReceived` (actually received) and `spent`, although the
  legend just says "Income"; bar heights scale to `max(income, incomeReceived, spent)` across the
  window - budgeted `income` participates in the max even though it isn't drawn
  (ReportsPage.tsx:88-94), so bars can look shorter than expected when budgeted > received.
- `pct(value, max)`: 0 when either <= 0, else `max(2, round(value/max*100))` - a 2% minimum sliver
  for any non-zero value (ReportsPage.tsx:394-397).
- Spending-by-category: rows = non-Income categories, `hueIndex` assigned by position BEFORE
  filtering out zero-spend rows (so hues match the Budget screen's group order,
  ReportsPage.tsx:97-104), then filter `spentMinor > 0`, sort desc. Percentage = share of the
  month's summed category spend (rounded); bar width = relative to the LARGEST category, not the
  total. Categories with negative net actuals are excluded (`> 0` filter).
- Annual table `Net` = `income - spent` per row (budgeted income vs actual spend - deliberately
  mixed bases); negative -> rose text, >= 0 -> emerald; dash in non-budgeted rows. Footer Net =
  `totalIncome - totalSpent`.
- Money formatting: `formatMoney` uses `Intl.NumberFormat(activeLocale, {style:'currency'})`;
  locale follows the signed-in user's number-format preference (`setMoneyFormat`), default en-GB.
  Currency minor-digit rules per ISO (JPY 0dp etc.).

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **FeatureGate = 404, not 403** (FeatureGateAttribute.cs:26). UI-hidden features must also 404 at
   the API. Auth still wins first: unauthenticated -> 401 even when the flag is off.
2. **`GET /api/features` is anonymous by design** - the SPA reads it before login to decide nav.
   Response casing is camelCase; client merges over all-on defaults, so a *missing* key silently
   enables (only `analytics` defaults off in both places).
3. **Analytics triple-gate** (AnalyticsProvider.tsx:44-57): tracking only when server flag
   `Analytics` on AND build-time measurement ID present AND user consent granted; the consent banner
   shows on the flag alone. Server default is OFF (FeatureFlags.cs:38).
4. **`IsBalanced` requires `TotalIncome > 0`** (BudgetMonth.cs:75, PR #172 - merged `7fd79a7`).
   Empty month != balanced; do not regress to bare `remaining == 0`. Reports don't use IsBalanced,
   but the trends `Income` figure comes from the same `TotalIncome` derived property.
5. **Blank months for jar-owning households land over-budgeted** (PR #172): accrual-planned savings
   lines give a fresh month non-zero `TotalPlanned` with zero income - in trends this shows as
   `Planned > 0, Income = 0` points; annual Net for such a month = `0 - spent`.
6. **Opt-in sample budget (PR #170)**: default new accounts are completely empty -> first visit to
   Reports must show the `No budget data yet` empty state, not sample figures.
7. **Trends window is "most recent N budgets", not last N months** - a user with budgets only in
   Jan and Jun gets 2 points labelled Jan/Jun side by side; test month-gap rendering.
8. **Annual categories keyed by (Name, Kind)** - rename splits history; the same name in Expense and
   Savings kinds makes separate rows (the Savings one gets the `Fund` badge).
9. **Silent partial failures on ReportsPage**: only the trends call surfaces an error; annual and
   breakdown failures leave stale or missing cards (see section 4) - including the year navigator
   showing a year whose data failed to load while the table still shows the old year.
10. **Currency of the page follows the breakdown month** (`?? 'EUR'`) - transient EUR formatting
    before that fetch resolves, and cross-currency households can flip all cards by changing the
    breakdown month.
11. **Prerender is non-fatal and CSR-replaced** - never switch `main.tsx` to `hydrateRoot` (the
    client first paints AuthSplash during bootstrap, which wouldn't match the prerendered landing;
    seo-landing memory, PR #117). LandingPage must stay SSR-safe: no router hooks, no browser
    globals in first render; the currency-noun swap must remain a mount-only effect so
    `renderToStaticMarkup` output stays "euro".
12. **Dark-mode AA contrast gotchas** (caught by axe CI, PRs #117/#120): accent text needs
    `dark:text-brand-500`; muted text must be >= slate-500. `client/e2e/landing.spec.ts` and
    `legal.spec.ts` scan both themes for WCAG 2.x A/AA.
13. **robots.txt disallows `/reports` etc. but allows `/`, `/login`, `/privacy`, `/terms`**;
    sitemap lists exactly the 3 public URLs. Legal pages are CSR-only - crawlers that don't run JS
    see the landing head for them (accepted trade-off, seo-landing memory).
14. **`months` query clamp** (1..24) is silent; `year` is unvalidated - the annual endpoint happily
    serves year 1 or 9999 with 12 empty months.
15. **Reports has no role gate** - Read-only members can view everything on /reports (by design;
    controller doc: "Read-only analytics over the user's own budgets", owner-scoped per handler).
16. **`IsEnabled` returns true for unknown flag names** (FeatureFlags.cs:50) - a typo'd
    `[FeatureGate("Reprots")]` would never 404; flag names are compile-checked via `nameof` today.
17. **IOptionsSnapshot** means flags are per-request live-reloadable - a mid-session server config
    flip 404s in-flight app usage without a deploy (client flags refresh only on full page reload).
18. Existing test coverage to mirror in QA: `tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs`
    (chronological points, received-vs-budgeted income split, window cap, owner scoping, empty) and
    `AnnualSummaryTests.cs` (12 months with gaps, per-category averages, year+owner scoping, empty
    year). Client: `client/src/pages/ReportsPage.test.tsx` (trend labels, breakdown month select,
    year nav, average card, empty state), `LandingPage.test.tsx` (single H1 shape, CTAs ->
    /login?register=1), `LegalPages.test.tsx` (H1s, controller, Malta law, /privacy link).

---

## 8. File index (read for this map)

Server:
- src/AllotJar.Api/Controllers/ReportsController.cs
- src/AllotJar.Api/Controllers/FeaturesController.cs
- src/AllotJar.Api/Controllers/BudgetController.cs (GetMonth route only)
- src/AllotJar.Api/Features/FeatureFlags.cs
- src/AllotJar.Api/Features/FeatureGateAttribute.cs
- src/AllotJar.Api/Program.cs (Features binding, line 37)
- src/AllotJar.Api/appsettings.json (Features section, lines 22-27)
- src/AllotJar.Api/Services/CurrentUser.cs, Services/HouseholdContext.cs
- src/AllotJar.Application/Reports/Dtos/BudgetTrendsDto.cs, AnnualSummaryDto.cs
- src/AllotJar.Application/Reports/Queries/GetBudgetTrends/GetBudgetTrendsQuery.cs + Handler
- src/AllotJar.Application/Reports/Queries/GetAnnualSummary/GetAnnualSummaryQuery.cs + Handler
- src/AllotJar.Application/Budgets/BudgetActuals.cs
- src/AllotJar.Application/Common/Interfaces/ICurrentUser.cs
- src/AllotJar.Domain/Entities/BudgetMonth.cs (TotalIncome/TotalPlanned/IsBalanced)
- tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs, AnnualSummaryTests.cs

Client:
- client/src/App.tsx, client/src/main.tsx
- client/src/pages/ReportsPage.tsx (+ ReportsPage.test.tsx)
- client/src/pages/LandingPage.tsx (+ LandingPage.test.tsx)
- client/src/pages/LegalLayout.tsx, PrivacyPage.tsx, TermsPage.tsx (+ LegalPages.test.tsx)
- client/src/features/FeatureContext.tsx
- client/src/components/AppNav.tsx, Hero.tsx, StagingBanner.tsx, ui/index.tsx (ErrorBanner/EmptyState)
- client/src/lib/money.ts, categoryColors.ts, env.ts, api.ts (base/interceptor context)
- client/src/analytics/AnalyticsProvider.tsx, analytics/events.ts (reportViewed)
- client/src/types.ts (BudgetTrendsDto/AnnualSummaryDto/FeatureFlags)
- client/src/prerender/landing-entry.tsx, client/scripts/prerender.mjs, client/scripts/make-og-image.mjs
- client/index.html, client/public/robots.txt, client/public/sitemap.xml, client/public/theme-init.js,
  client/public/og/allotjar-og.png (existence)
- client/e2e/landing.spec.ts, client/e2e/legal.spec.ts

Memory/audit notes consulted: <local>\.claude\projects\C--Users-Laptop-Documents-Projects\memory\seo-landing.md
(claims re-verified against current code above).
