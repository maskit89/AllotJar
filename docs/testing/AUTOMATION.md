# Catalog Automation — Coverage, Bugs, and Residual

This tracks the effort to automate the manual functional test catalog (`docs/testing/`, 1,342 cases).
Goal: automate every case that maps to a real test layer; for the minority that genuinely can't be
automated, write the closest proxy and **flag the rest here** rather than pretend.

## Test suites after automation

| Layer | Location | Run | Tests | New |
|---|---|---|---|---|
| Backend unit (xUnit, EF InMemory) | `tests/AllotJar.Application.Tests` | `dotnet test tests/AllotJar.Application.Tests` | **643** | +206 |
| Client component (Vitest + RTL) | `client/src/**/*.catalog*.test.tsx` | `cd client && npm run test` | **591** | +350 |
| Journey e2e (live API + real SQL) | `client/e2e-journey` | `cd client && npm run test:e2e:journey` | **34** | +25 |
| a11y / responsive / UX (stubbed API) | `client/e2e` | `cd client && npm run test:e2e` | **92** | +46 |
| **Total** | | | **1,360** | **+627** |

Delivered as four PRs, each independently verified green and CI-passing: **#178** (backend, merged),
**#179** (client, merged), **#180** (journey), **#181** (a11y). Every added test cites the catalog case
id(s) it automates; coverage was cross-checked against `maps/automated-tests.md` to avoid duplication.

Each layer catches a different class of defect: backend = money/domain logic; client = rendering,
validation copy, optimistic UI; journey = whole-stack integration (FK cascades, derived actuals, cookie
auth, the preview→commit contract); a11y = keyboard/contrast/overflow. A case is automated at the
lowest layer that can actually observe its behaviour.

## Bugs surfaced by the automation

Automating a spec is a forcing function: writing an honest assertion against real behaviour finds bugs a
green catalog never would. Each is pinned by a **skipped test** (not a weakened one) that will pass once
the bug is fixed — un-skipping is the fix's proof.

| # | Case | Severity | Defect |
|---|---|---|---|
| 1 | `ALLOC-010/018` | **High** | First-time allocation setup is impossible via the UI. `GET /api/allocation/profile` returns 204 (not JSON `null`) for a profile-less household → axios yields `''` → `prof?.data ?? null` keeps `''` → clicking "Set up allocation" throws a `TypeError` in `syncFormFromProfile`, modal never opens. A brand-new shared household can't set up allocation at all. Fix: return JSON `null` server-side (or normalize falsy→null client-side). |
| 2 | `INV-042` | Medium | A signed-in Limited/Read-only user can't accept an invite to *another* household — `AcceptInviteCommand` lacks `[AllowLimited]`, so the Admin-by-default command gate blocks it. Fix: exempt accept-invite from the household-role gate. |
| 3 | `REG-027` | Medium | Registration failures with ASP.NET's `ValidationProblemDetails` (`errors` as an object, e.g. whitespace-only names) make `LoginPage`'s `data?.errors?.join(' ')` throw; the throw escapes the catch, **no error renders**, and the submit button silently re-enables. Fix: `Object.values(errors).flat()` / guard `Array.isArray`. |
| 4 | `TX` (split/assign) | Low | `SplitTransactionCommandHandler` / `AssignTransactionCommandHandler` re-read the saved tx without `.Include(t => t.Account)`, so their response DTOs return `accountName = null` and the register's Account cell blanks to "—" until the next full `GET /transactions`. Fix: add the include. |
| 5 | `TX-094` | Low | The add-transaction modal keeps its Category selection across successive adds (only payee/amount clear) and across an Expense→Income flip, so a "quick add" silently inherits the previous line and the auto-categorizer never runs. Fix: reset `assignTo` after each add. |
| 6 | `UX-022` | Low (a11y) | Budget reorder arrows render at 16×14 / ~12.6×15 CSS px — below the WCAG 2.5.8 (AA) 24×24 minimum, adjacent with no spacing exemption and no keyboard-accessible reorder alternative. Fix: enlarge the hit target and/or add a keyboard reorder path. |

None were "fixed" by weakening a test. Fixing them is a product decision; each fix un-skips exactly one
pinned test.

## Residual — genuinely not automated (and why)

These stay manual (or covered only by the closest proxy noted). They are a small, deliberate minority.

| Area | Why not automated | Proxy in place |
|---|---|---|
| SEO meta / canonical / OG, prerendered landing HTML, `robots.txt` / `sitemap.xml` | Produced by the Vite build/prerender step, not a running route; exact-tag assertions are brittle and low-value | Landing render + route behaviour covered (`LandingPage.catalog.test.tsx`) |
| Email delivery (invite / temp-password emails) | No mail server in any test environment | Invite *flow* covered via the returned token/link (journey `invite` specs) |
| Real GA / analytics network payloads, Consent Mode v2 wire format | External endpoint, consent-gated; asserting the actual gtag network call needs a live GA | `sign_up`/consent **event firing** unit-tested (`LoginPage.catalog.test.tsx`) |
| Rate-limit **429** UX | The journey harness raises `RateLimiting:AuthPermitLimit` to 1000 so a serial suite can't self-throttle | Lockout message + recovery covered; 429 mapping is unit-level |
| Pixel-exact visuals (hero gold gradient, exact brand focus-ring values, precise dark palette) | Needs visual-regression tooling / human eye; not a functional contract | axe (WCAG A/AA) + token-inversion + contrast + overflow all automated |
| No-flash-under-CSP theme init; OS-live `prefers-color-scheme` change at runtime | Depends on the CSP'd production bundle / a live OS theme switch mid-session | Dark-mode toggle + persisted theme covered |
| Offline-mid-action optimistic rollback; throttled-network stale-render races | Require fault injection that contradicts the real-stack journey premise | Optimistic commit/rollback covered at the Vitest layer |
| `ExcludeFromAllocation` actuals (`TX-095`, `ALLOC-036`) | The flag has no UI control and no API writer — set only by a data migration + the Excel seeder tool | Domain rule verified by inspection; catalog kept `Automated: No` |
| Full per-endpoint role **403** API sweep | The journey bearer token is in-memory, so raw `page.request` calls 401 rather than exercising the role pipeline | `AuthorizationBehaviour` + `RoleGating` unit tests cover the matrix |

## Maintaining

- New/changed behaviour → add the case to the catalog **and** a test at the lowest observing layer; flip
  the case's `Automated` field.
- A bug is fixed → un-skip its pinned test (it should then pass).
- Keep suites green before merge: `dotnet test`, `npm run test`, `npm run test:e2e`, and (with LocalDB)
  `npm run test:e2e:journey`.
