# AllotJar — Functional Test Catalog

An exhaustive, code-grounded catalog of **manual functional test cases** for AllotJar (the
zero-based household budgeting app in this repo). It aims to cover **every page, control,
validation rule, state, and money calculation** — individually *and* holistically (feature
interactions, end-to-end journeys, concurrency, roles, currency/locale, and UX states).

- **1,342 test cases** across **26 files** (18 per-area + 8 cross-cutting suites).
- Each case is grounded in the **current source** (exact labels, routes, validators, formulas)
  and cross-referenced to the **automated tests** that already cover it, so this doubles as a
  gap map for future automation.
- Authored against `main` @ `99ec47f` (includes PRs #167–#172). Re-verify a case against the
  code before trusting it if the app has moved on.

> **Scope.** This catalog is **functional** (does the behaviour work, alone and in combination).
> It is not a performance, load, penetration, or visual-pixel test plan — though it does include
> user-observable security behaviour (`27`) and responsive/dark/a11y expectations (`26`).

---

## How it's organised

```
docs/testing/
├── README.md          ← you are here (index, conventions, execution guide)
├── maps/              ← 10 subsystem "feature maps": the ground-truth inventory the
│                        cases were written from (routes, controls, endpoints, invariants)
└── cases/             ← 26 test-case files (see the table below)
```

Read a **map** when you want the full inventory of a subsystem (every endpoint, every
validation message, every invariant with its PR origin). Read a **case file** to actually test.

### Per-area suites (one feature area each)

| File | Prefix | Cases | Area |
|------|--------|------:|------|
| [01-landing-public.md](cases/01-landing-public.md) | `LAND` | 43 | Public landing, legal pages, SEO, consent/beta banners |
| [02-registration-login.md](cases/02-registration-login.md) | `REG` | 50 | Create-account + sign-in, validation, HIBP, lockout, sample-budget opt-in |
| [03-session-auth-lifecycle.md](cases/03-session-auth-lifecycle.md) | `SESS` | 42 | Token/refresh lifecycle, silent refresh, expiry prompt, cross-tab logout |
| [04-account-preferences.md](cases/04-account-preferences.md) | `PREF` | 39 | Profile, currency label, number format, change password, theme |
| [05-onboarding.md](cases/05-onboarding.md) | `ONBD` | 31 | Welcome, tour, getting-started checklist |
| [06-dashboard-budget-view.md](cases/06-dashboard-budget-view.md) | `DASH` | 70 | Budget month view, planned edits, actuals, remaining/balanced hero |
| [07-month-lifecycle.md](cases/07-month-lifecycle.md) | `BUDG` | 56 | Create/copy/template months, rollover, navigation, duplicates |
| [08-categories-budget-lines.md](cases/08-categories-budget-lines.md) | `CAT` | 52 | Category & line CRUD, reorder, savings-line jar link |
| [09-bills.md](cases/09-bills.md) | `BILL` | 35 | Due days, Paid toggle, overdue/due-soon, copy semantics |
| [10-transactions.md](cases/10-transactions.md) | `TX` | 95 | Transaction CRUD, splits, assignment, auto-categorizer |
| [11-transfers.md](cases/11-transfers.md) | `TRF` | 40 | Transfer flow, guards, signed rows, `Type=Transfer` injection |
| [12-accounts-reconciliation.md](cases/12-accounts-reconciliation.md) | `ACCT` | 60 | Account CRUD, derived balances, register, reconciliation |
| [13-jars.md](cases/13-jars.md) | `JAR` | 72 | Jar CRUD, Recurring/Goal, accrual math, archive, shelf |
| [14-allocation.md](cases/14-allocation.md) | `ALLOC` | 63 | Income split modes, savings pooling, waterfall, reconciling tiles |
| [15-import.md](cases/15-import.md) | `IMP` | 90 | Format sniffing, column mapping, dedup, parser robustness |
| [16-people-households.md](cases/16-people-households.md) | `PPL` | 77 | Member CRUD, solo↔shared, multi-household switch, leave/start-own |
| [17-invites.md](cases/17-invites.md) | `INV` | 54 | Direct + link invites, accept flows, reconcile, roles, revoke |
| [18-reports.md](cases/18-reports.md) | `RPT` | 37 | Trends, annual overview, spending-by-category, sums |

### Cross-cutting suites (holistic — behaviour no single area file can see)

| File | Prefix | Cases | Suite |
|------|--------|------:|------|
| [20-journeys.md](cases/20-journeys.md) | `JRN` | 14 | End-to-end life journeys (checkpointed multi-feature scripts) |
| [21-feature-interactions.md](cases/21-feature-interactions.md) | `CMB` | 56 | Pairwise/three-way feature-interaction matrix |
| [22-concurrency-multiuser.md](cases/22-concurrency-multiuser.md) | `CONC` | 34 | Two users / two tabs, races, stale UI, refresh single-flight |
| [23-time-date-lifecycle.md](cases/23-time-date-lifecycle.md) | `TIME` | 36 | Year rollover, leap Feb, due-day clamping, out-of-order months |
| [24-currency-locale.md](cases/24-currency-locale.md) | `CURR` | 49 | ~25 currencies × number formats across every money surface |
| [25-roles-permissions.md](cases/25-roles-permissions.md) | `ROLE` | 53 | Owner/Admin/Limited/Read-only × every action (UI + API) |
| [26-ux-states.md](cases/26-ux-states.md) | `UX` | 54 | Empty/loading/error, mobile 375px, dark mode, keyboard/a11y |
| [27-security-functional.md](cases/27-security-functional.md) | `SEC` | 40 | Lockout, rate-limit, owner-scoping, consent-gated analytics |

*(File numbers 19 is intentionally unused; cross-suites start at 20.)*

---

## Case conventions

Every case follows the same shape:

```
### <PREFIX>-<NNN> - <title>
- **Priority:** P0 | P1 | P2 | P3
- **Type:** Happy | Edge | Negative | Boundary | Regression
- **Origin:** PR #<n> / <gotcha>        (Regression cases only)
- **Preconditions:** <concrete data + auth state>
- **Steps:** numbered, concrete UI steps quoting exact labels/routes
- **Expected:** observable outcome(s), with concrete values where computable
- **Automated:** No | Partial (<test file>) | Yes (<test file>)
```

**Priority**
- **P0** — money integrity or a core daily flow. A failure corrupts data or blocks everyday use. Run every regression cycle.
- **P1** — important feature correctness. Run every release.
- **P2** — edge/boundary behaviour. Run on change to the area or a full pass.
- **P3** — rare or cosmetic. Run in a full/annual pass.

**Type**
- **Happy** — intended path with valid input.
- **Edge** — unusual-but-valid state (empty data, first-ever use, archived referents).
- **Negative** — invalid input / error path; asserts the guard and message.
- **Boundary** — limits: 0, negative, huge, many decimals, 31st-of-month, empty, very long, unicode.
- **Regression** — pins a specific past bug so it can't come back; carries an **Origin** (PR # / gotcha).

**Automated** tells you whether an existing test already covers the behaviour:
`Yes` (fully), `Partial` (touches it — read the note for the gap), or `No` (manual-only today →
an automation candidate). The referenced test layers are inventoried in
[maps/automated-tests.md](maps/automated-tests.md): client unit (`client/src/**/*.test.tsx`),
Playwright a11y/mobile e2e (`client/e2e/`), full-stack journey e2e (`client/e2e-journey/`),
backend unit (`tests/AllotJar.Application.Tests`), and SQL-Server integration
(`tests/AllotJar.IntegrationTests`).

---

## How to run a pass

1. **Pick a scope.** A smoke pass = every **P0** across all files (the core money + daily flows).
   A release pass = **P0 + P1**. A full pass = everything, including the cross-cutting suites.
2. **Stand up the app.** Local: API on `:5099`
   (`ASPNETCORE_ENVIRONMENT=Development dotnet run -c Release --no-launch-profile --project
   src/AllotJar.Api --urls http://localhost:5099`) + the Vite client; or test against beta
   (`app.allotjar.com`). Each file's **Test data setup** block lists the fixtures it assumes.
3. **Work a file top-to-bottom.** Cases are ordered so preconditions build up naturally within
   a section. Cross-suite steps often say "as `TX-012`" — that references an area case rather
   than repeating it.
4. **Record** pass/fail against the case ID. A failing case ID (e.g. `ALLOC-021`) is a precise,
   reproducible bug report on its own.
5. **Holistic coverage** lives in `20`–`27`. Don't skip them: most real bugs in this app have
   been *interaction* bugs (allocation × savings, transfers × months, import × dedup), which the
   per-area files deliberately don't chase.

### Suggested order for a first full pass
Auth & entry (`02`,`03`,`04`,`05`,`01`) → core budgeting (`06`,`07`,`08`,`09`) →
money movement (`10`,`11`,`12`) → savings (`13`,`14`) → import (`15`) →
sharing (`16`,`17`) → reports (`18`) → then the holistic suites (`20`–`27`).

---

## Maintaining this catalog

- **New feature / changed behaviour** → update the relevant map first, then add/adjust cases.
  Keep the map accurate; it's the ground truth the cases lean on.
- **A bug is found and fixed** → add a **Regression** case with an **Origin** line, so it's pinned.
- **A case gets automated** → flip its **Automated** field from `No`/`Partial` to the test path.
- **IDs are stable.** Never renumber; append new cases with the next free number in that file's
  prefix. Verified invariant across the catalog: no duplicate IDs, one prefix per file.
