# Catalog Automation — Coverage, Bugs, and Residual

This tracks the effort to automate the manual functional test catalog (`docs/testing/`, 1,342 cases).
Goal: automate every case that maps to a real test layer; for the minority that genuinely can't be
automated, write the closest proxy and **flag the rest here** rather than pretend.

## Test suites after automation

| Layer | Location | Run | Tests | New |
|---|---|---|---|---|
| Backend unit (xUnit, EF InMemory) | `tests/AllotJar.Application.Tests` | `dotnet test tests/AllotJar.Application.Tests` | **659** | +206 |
| Client component (Vitest + RTL) | `client/src/**/*.catalog*.test.tsx` | `cd client && npm run test` | **602** | +350 |
| Journey e2e (live API + real SQL) | `client/e2e-journey` | `cd client && npm run test:e2e:journey` | **36** | +25 |
| a11y / responsive / UX (stubbed API) | `client/e2e` | `cd client && npm run test:e2e` | **98** | +46 |
| HTTP integration (in-process API + real SQL) | `tests/AllotJar.IntegrationTests` | `dotnet test tests/AllotJar.IntegrationTests` | **36** | +15 |
| **Total** | | | **1,431** | **+642** |

Delivered as four PRs, each independently verified green and CI-passing: **#178** (backend, merged),
**#179** (client, merged), **#180** (journey), **#181** (a11y). Every added test cites the catalog case
id(s) it automates; coverage was cross-checked against `maps/automated-tests.md` to avoid duplication.
The Tests column is the current measured count (2026-07-18) — it has since grown past the four-PR
delivery via the #183 bug-fix un-skips, the #184 regression pins, the residual-gap closure
(`ExcludeFromAllocationCoverageTests` +2 backend; the UX-036 account-detail and OS-live theme
e2e specs +3), and the password-reset feature (REG-051..067: +11 backend, +9 Vitest, +6 HTTP
integration, +2 journey, +2 a11y scans); the New column still documents the original automation drive. The HTTP integration
row is the out-of-slnx SQL Server project (CI `integration` job): its 15 pre-existing FK crash-path
tests (previously untracked here) plus the 15-test HTTP harness (`tests/AllotJar.IntegrationTests/Http/`)
that boots the real API in-process via `WebApplicationFactory` — an anonymous per-endpoint 401
sweep with a curated known-anonymous allowlist, a four-role (Owner/Admin/Limited/ReadOnly)
write/read matrix over real logins and bearer tokens, and a real rate-limit 429.

Each layer catches a different class of defect: backend = money/domain logic; client = rendering,
validation copy, optimistic UI; journey = whole-stack integration (FK cascades, derived actuals, cookie
auth, the preview→commit contract); a11y = keyboard/contrast/overflow. A case is automated at the
lowest layer that can actually observe its behaviour.

## Bugs surfaced by the automation

Automating a spec is a forcing function: writing an honest assertion against real behaviour finds bugs a
green catalog never would. Each was pinned by a **skipped test** (not a weakened one) at discovery time.
**All six were fixed in [PR #183](https://github.com/maskit89/AllotJar/pull/183) (2026-07-18)** — every
pinned test is now un-skipped and passing (the un-skip is the fix's proof), and the "Fix:" notes below
describe the fix that shipped. The table stays as the historical register.

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
| Email delivery (actual SMTP/Resend transport) | No mail server in any test environment; Resend only sends from the DNS-verified production domain | Invite *flow* covered via the returned token/link (journey `invite` specs); password-reset email **content and flow** fully covered via `DevEmailSink` + the Development mailbox (`AuthPasswordResetCoverageTests`, `PasswordResetFlowTests`, journey `password-reset` specs) — only the provider hop itself stays manual |
| Real GA / analytics network payloads, Consent Mode v2 wire format | External endpoint, consent-gated; asserting the actual gtag network call needs a live GA | `sign_up`/consent **event firing** unit-tested (`LoginPage.catalog.test.tsx`) |
| Pixel-exact visuals (hero gold gradient, exact brand focus-ring values, precise dark palette) | Needs visual-regression tooling / human eye; not a functional contract | axe (WCAG A/AA) + token-inversion + contrast + overflow all automated |
| No-flash-under-CSP theme init | Depends on the CSP'd production bundle (dev serves no CSP, so the "no console error" half can't be observed in the harness) | Dark-mode toggle + persisted theme covered; the OS-live `prefers-color-scheme` half is now automated (`client/e2e/theme-os-live.spec.ts` via `page.emulateMedia`) |
| Offline-mid-action optimistic rollback; throttled-network stale-render races | Require fault injection that contradicts the real-stack journey premise | Optimistic commit/rollback covered at the Vitest layer |

Two former residuals were **closed 2026-07-18** by the HTTP integration harness
(`tests/AllotJar.IntegrationTests/Http/`), which boots the real API in-process and so isn't bound by
the journey harness's constraints:

- *Rate-limit 429* — a dedicated factory sets `RateLimiting:AuthPermitLimit = 3` and asserts the real
  429 from the real limiter (`RateLimit429Tests`); the journey suite keeps its raised limit.
- *Full per-endpoint role 403 API sweep* — real logins for all four roles exercise a representative
  write per controller against real bearer tokens (`RoleMatrixTests`), and an ApiExplorer-driven
  anonymous sweep 401-checks every endpoint outside a curated allowlist
  (`AnonymousEndpointSweepTests`), guarding against a forgotten `[Authorize]`.

## Running the suites in a session (output thrift)

The full suites are CI's job. When running tests interactively — especially in an agent/Claude session,
where every line of test output consumes context — default to **targeted, quiet** runs and save the
full sweep for one pre-PR pass:

- **Mid-development:** run only what the change touches.
  - Vitest, single spec: `cd client && npx vitest run src/pages/JarsPage.catalog.test.tsx`
  - Backend, filtered: `dotnet test tests/AllotJar.Application.Tests --filter "FullyQualifiedName~Allocation" -v q`
  - Playwright, single spec: `cd client && npx playwright test e2e/a11y.spec.ts` (journey: add
    `--config playwright.journey.config.ts`)
- **Pre-PR full pass:** use the quiet reporters — failures still print in full, passes cost one character.
  - `cd client && npm run test:quiet` (dot reporter + `--silent`; drop `--silent` only when you need a
    test's console output to debug)
  - `dotnet test tests/AllotJar.Application.Tests -v q`
- **CI is the real gate** (`backend` + `frontend` + `a11y` + `integration`) — don't re-run the full
  matrix locally to prove what CI will prove anyway.

## Maintaining

- New/changed behaviour → add the case to the catalog **and** a test at the lowest observing layer; flip
  the case's `Automated` field.
- A bug is fixed → un-skip its pinned test (it should then pass).
- Keep suites green before merge: `dotnet test`, `npm run test`, `npm run test:e2e`, and (with LocalDB)
  `dotnet test tests/AllotJar.IntegrationTests` + `npm run test:e2e:journey`.
- A new deliberately-anonymous endpoint → add it to `KnownAnonymous` in `AnonymousEndpointSweepTests`
  (the sweep fails until you do); a new controller → add its representative write to `RoleMatrixTests`.
