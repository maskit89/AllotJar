# AllotJar 🫙

A **zero-based budgeting** (ZBB) web app: give every unit of income a job until
**"Remaining to Budget" reaches 0**. Born as a euro-first tool, AllotJar is now
**currency- and country-agnostic** — pick any currency, number format and date
style at sign-up, and the whole app speaks your money ("give every _dollar_ /
_rupee_ / _euro_ a job").

- **Live:** <https://www.allotjar.com> (production) · `staging.allotjar.com` (IP-allowlisted staging)
- **New to the app?** The **[User Guide](docs/USER_GUIDE.md)** walks through every
  page — budgets, jars, bills, transactions, accounts, imports, people, reports
  and feature flags.

## Stack

- **Backend:** ASP.NET Core Web API (clean architecture) on **.NET 10**
- **Data:** EF Core + SQL Server; every money column is `decimal(18,4)`
- **Auth:** ASP.NET Core Identity issuing short-lived JWTs + a rotating HttpOnly refresh cookie
- **Patterns:** CQRS via MediatR, FluentValidation pipeline, Dependency Inversion
- **Frontend:** React 19 + TypeScript (Vite) + TailwindCSS v4, with dark mode and WCAG 2.2 AA
- **Money:** integer minor units at scale 4 on both ends — no floating-point drift
- **CI/CD:** GitHub Actions → native Windows Server VPS behind Cloudflare (IIS + SQL Server)

---

## Solution layout

```
AllotJar/
├─ AllotJar.slnx
├─ src/
│  ├─ AllotJar.Domain          # Entities + pure ZBB calculation logic (no deps)
│  ├─ AllotJar.Application     # CQRS (MediatR), DTOs, abstractions, validation
│  ├─ AllotJar.Infrastructure  # EF Core DbContext, Identity, JWT/refresh, migrations
│  └─ AllotJar.Api             # Controllers, auth endpoints, DI, Swagger
├─ tests/
│  └─ AllotJar.Application.Tests  # xUnit: ZBB math + handler behaviour
├─ client/                     # Vite + React + TS + Tailwind SPA
├─ deploy/                     # IIS/SQL bootstrap + deploy PowerShell scripts
├─ docs/                       # User guide, deployment runbook, ops queries
└─ brand/                      # Logo / jar / favicon assets (see brand/README)
```

The `Application` project is organised by feature — `Budgets`, `Transactions`,
`Accounts`, `Imports`, `Jars`, `Reports`, `Allocation`, `Household`,
`HouseholdAccess` — each holding its commands, queries, DTOs and the read-time
calculators (`BudgetActuals`, `AccountBalances`).

> The GitHub repo is `maskit89/AllotJar`. A handful of internal identifiers still
> carry the original **ZeroBudget** name by design — the physical database name,
> the IIS/pool/deploy paths under `deploy/**`, the JWT issuer, the `zbb_rt` cookie
> and `zbb.*` client keys. These are stable infrastructure names, not a rename we
> left half-done.

### Dependency rule (clean architecture)

```
Domain  ←  Application  ←  Infrastructure
                       ↖        ↑
                          Api (composition root)
```

`Domain` depends on nothing. `Application` depends only on `Domain` and defines
abstractions (`IApplicationDbContext`, `ICurrentUser`, `IJwtTokenGenerator`,
`IStatementParser`, `ICsvImporter`, `IExchangeRateProvider`) that
`Infrastructure` / `Api` implement.

---

## Core domain logic

The whole point of ZBB lives in `BudgetMonth` and is pure, testable C#. A month is
a tree of `BudgetCategory` groups (each tagged with a `CategoryKind` — `Income`,
`Expense` or `Savings`) holding `BudgetItem` lines:

```csharp
// Income is the pool to allocate — the sum of the Income-group lines.
public decimal TotalIncome =>
    Categories.Where(c => c.Kind == CategoryKind.Income).Sum(c => c.TotalPlanned);

// Everything that has been given a job: every NON-income group, i.e. expense
// spending plus savings/jar contributions (funding a jar is a job too).
public decimal TotalPlanned =>
    Categories.Where(c => c.Kind != CategoryKind.Income).Sum(c => c.TotalPlanned);

public decimal RemainingToBudget => TotalIncome - TotalPlanned;
public bool    IsBalanced        => RemainingToBudget == 0m;
```

`RemainingToBudget` is computed server-side, shipped in the DTO, and returned again
on every edit so the banner updates dynamically. It handles zero/absent income
gracefully (it simply returns the negated total planned, never dividing).

A line's **`ActualAmount`** is likewise never authored directly — it is always derived
at read time (see `AllotJar.Application.Budgets.BudgetActuals`) from the transactions
assigned to the line: whole transactions of the line's own kind (income lines roll up
income, expense/savings lines roll up expenses) plus any split slices. A line with no
transactions reads zero. There is no manual entry — recomputing from the register every
load keeps a single source of truth that can't drift.

---

## Building a month

- `GET /api/budget/{year}/{month}` (and `GET /api/budget/current`) returns the
  recomputed month tree; `GET /api/budget/months` lists which months exist (for the
  navigator).
- `POST /api/budget` creates a month **from a quick-start template, by copying the
  previous month, or blank** (`CreateBudgetMonthRequest { Year, Month,
  CopyFromPrevious, TemplateKey }`; precedence is template → copy → blank).
- `GET /api/budget/templates` lists the built-in starters (`Essentials`, `Student`,
  `Family`); new accounts start empty unless the sign-up form's sample-figures
  opt-in was ticked (`RegisterRequest.IncludeSampleData`), which seeds a default month.
- Category groups and lines have full CRUD plus drag-reorder:
  `POST /api/budget/categories` (pass `Kind: Savings` for a savings group; defaults to `Expense`),
  `PUT /api/budget/categories/{id}` (rename), `DELETE /api/budget/categories/{id}`,
  `PUT /api/budget/categories/order`, `POST /api/budget/categories/{categoryId}/items`,
  `PUT /api/budget/items/{id}`, `DELETE /api/budget/items/{id}`, and
  `PUT /api/budget/categories/{categoryId}/items/order`.
- The single `Income` group is rendered first and can't be deleted.

---

## Currency, formats & localisation

AllotJar keeps its euro soul but welcomes everyone — currency is a **display and
labelling** choice, not a rate conversion.

- **Sign-up & preferences** let a user pick a **currency**, a **number format** and a
  **date style**. The picker offers ~24 curated currencies (euro and its neighbours
  first, then the major world currencies), but the engine accepts **any ISO 4217
  code**.
- **Number formats** are independent of the currency (a euro user may still prefer
  `1,234.56`): `comma-dot`, `dot-comma`, `space-comma`, `apostrophe` (Swiss) and
  `lakh` (Indian grouping). The neutral default is `comma-dot`.
- **Per-currency decimals** — zero-decimal currencies (JPY, etc.) render and round
  correctly, not forced to two places.
- **Locale-aware dates** throughout the SPA.
- The **"give every ___ a job" tagline** adapts to the signed-in user's currency
  noun ("euro", "dollar", "rupee", …), defaulting to euro on anonymous / logged-out
  surfaces.

### Foreign-currency transactions & FX (`MultiCurrency` flag)

- A `BudgetMonth` has a **`BaseCurrency`** (`CurrencyCode` value object, ISO 4217,
  default `EUR`). Every planned/actual amount in the tree is in that currency, so
  totals stay summable and `RemainingToBudget` is unambiguous.
- A `Transaction` can carry its **own `Currency` + `ExchangeRate`** and exposes
  `BaseAmount = Amount × ExchangeRate` — converting foreign spending (e.g. GBP
  abroad) into the budget's base currency. On import the rate is **resolved from real
  ECB reference rates** (the free, key-less Frankfurter API, behind
  `IExchangeRateProvider`, historical by booking date, cached) and falls back to 1 if
  a rate can't be fetched — FX never blocks an import.
- `Money` (`decimal Amount` + `CurrencyCode`) **forbids cross-currency arithmetic** —
  adding EUR to GBP throws rather than silently producing nonsense.

---

## Jars & savings

Two distinct concepts, both money you set aside:

- **Savings lines** — a `CategoryKind.Savings` budget group whose lines behave like
  expenses but whose **balance rolls over** month to month. Each line carries a stable
  **`SavingsId`** shared by every month's instance; `BudgetActuals` derives each line's
  transient **`SavingsAvailable`** as `Σ(planned − spent)` across every month up to and
  including the one viewed. Contributions count as planned money, so the budget only
  balances once savings are funded.
- **Jars** (`Jar` entity, `/jars`, `JarsController`, behind the `Jars` flag) — named
  savings targets with a due date, target amount and accrual method. A **`JarKind`** is
  either `Recurring` (refills every cycle — insurance, road tax, holidays; renews
  automatically) or `Goal` (saved toward once, then done — a sofa, a wedding).
  `JarAccrualCalculator` projects how much to set aside per period to hit the target on
  time.

---

## Bills & reminders

Any expense line can be tracked as a **bill**:

- `PUT /api/budget/items/{id}/bill` sets or clears a `DueDay` (1–31); a line with a
  due day is a bill (`BudgetItem.IsBill`). `PUT /api/budget/items/{id}/paid` toggles
  this month's `IsPaid`.
- The `DueDay` recurs (it's copied when a month is created); `IsPaid` resets each
  month.
- The client derives **due-soon / overdue** reminders from the due day and paid
  state for the current month (clamped to the month length).

---

## Accounts & balances

`Account` is a "where my money is" view alongside the budget (a current account,
savings pot, cash, or credit card — `AccountType`).

- An account's balance is **never stored**: `AccountBalances` derives it at read time
  as `OpeningBalance + Σ(income) − Σ(expense)` of the transactions assigned to it, in
  the account's own currency. (The opening balance can be negative — e.g. a credit
  card's debt.)
- `GET /api/accounts` returns accounts with their current balances;
  `POST/PUT/DELETE /api/accounts/{id}` manage them (currency is immutable once set;
  deleting an account unlinks its transactions rather than removing them). The account
  detail page shows that account's own register.
- A transaction's `AccountId` is independent of its budget-line attribution — a
  transaction can move an account balance, fill a budget line, both, or neither.

---

## Transactions, splits & actual spending

- `GET /api/transactions` lists the user's transactions (filterable by month /
  unassigned); the **Transactions** page assigns each to a budget line.
  `POST /api/transactions` adds a manual one and `PUT`/`DELETE /api/transactions/{id}`
  edit and remove it (each carrying an optional `AccountId`).
- `PUT /api/transactions/{id}/assignment` sets/clears a line (ownership checked
  on both the transaction and the target line).
- `PUT /api/transactions/{id}/transfer` edits a transfer in place (accounts, amount,
  departure/receipt/return dates, payee, fee and its budget line, jar answers). A leg
  confirmed by a bank statement keeps the bank's account, date and amount. A transfer
  can be marked returned (`returnedOn`) and can carry a fee, recorded as a separate
  expense row on the source account.
- `PUT /api/transactions/{id}/splits` **splits a transaction across two or more
  lines** (`TransactionSplit`). A transaction is whole-assigned **xor** split (its
  `BudgetItemId` is cleared and the slices carry the attribution, summing exactly to
  the total) **xor** unassigned, so it never double-counts.
- **Auto-categorization (zero-config):** there are no user-managed rules. When a
  transaction is logged without a line, `AutoCategorizer` quietly assigns it to the
  budget line of the user's **most recent earlier transaction with the same
  description** (payee, matched case- and whitespace-insensitively), flipping that
  line to `Tracked`. It runs on manual creation and on the import path.
- Transactions can also be tagged to a **household member** and marked as internal
  **transfers** between accounts (a transfer heuristic pairs the two sides so it isn't
  double-counted as spending).

---

## Bank statement import

The **Import** page (behind the `CamtImport` flag) turns a bank export into
transactions, with a review step so nothing is saved blindly.

- **Formats** (`StatementFormat`): `Camt053` (ISO 20022 CAMT.053 SEPA XML),
  `HsbcCsv` (HSBC personal-banking CSV) and **`GenericCsv`** — any bank CSV, driven by
  a **column-mapping UI** (date / signed amount / description / optional currency) that
  auto-detects columns on first upload and lets the user confirm.
- **Preview → commit flow:** `POST /api/import/preview` parses the file and returns the
  not-yet-imported rows for review (nothing persisted); the user categorises/attributes
  them and posts the kept rows to `POST /api/import/commit`. These two are the only
  import endpoints.
- **Idempotent:** rows are de-duplicated per user on the bank reference
  (`AcctSvcrRef`, falling back to `EndToEndId`), so re-importing the same statement
  imports nothing new.
- Passing an `accountId` stamps every imported transaction with it, so the account
  balance moves.
- `Camt053StatementParser` reads `<Ntry>` elements **by local name**, so it handles
  every `camt.053.001.xx` namespace version.

---

## People, households & allocation

AllotJar works **solo by default** and reveals sharing only when you need it.

- **People** (`/people`) is the unified place to add household members and manage
  logins. A member is a person in the budget; a login is an account that can sign in.
- **Households** — a login can belong to several households and switch between them.
  The owner is always **member #1**, so a household is never "0 members": solo is a
  household of one, shared is two or more. Sharing-only UI (allocation, member
  splits) stays hidden until a second person joins.
- **Multi-user access** (`HouseholdAccess` flag) — invite additional logins with a
  role (`Owner` / `Admin` / `Limited` / `Read-only`). Invites are either a **direct
  temp-password** account or a **one-time link** redeemed at `/accept-invite`. Every
  control and endpoint is role-gated.
- **Income allocation** (`HouseholdAllocation` flag, `/allocation`) — an
  `AllocationProfile` of `AllocationRule`s (`IncomeAllocator`) splits each pay-in
  across members/savings by fixed amount, percentage or balance-tilt, so shared
  budgets stay fair.

All reads/writes are scoped to the active household's `OwnerId` — defence in depth
against IDOR.

---

## Reports & trends

`ReportsController` (behind the `Reports` flag) exposes read-only, owner-scoped
analytics:

- `GET /api/reports/trends?months=N` rolls up the most recent N budgets into an
  income / income-received / planned / spent series (spent reuses `BudgetActuals`).
- `GET /api/reports/annual/{year}` returns a 12-month overview (income / planned /
  spent + totals) for one calendar year.

The Reports page renders these as plain CSS bar charts (no charting library).

---

## Onboarding, landing & legal

- **Marketing landing page** at `/` for anonymous visitors (the dashboard for signed-in
  users), with static-head SEO (canonical / OG / Twitter / JSON-LD), `robots.txt`,
  `sitemap.xml`, an OG share image, and a browser-less prerender that injects the
  landing HTML into `dist/index.html`.
- **Onboarding** — a first-run welcome, a guided tour and a getting-started checklist
  (per-user, stored in `localStorage`).
- **Legal** — `/privacy` and `/terms` pages.
- **Analytics** (`Analytics` flag, **default OFF**) — consent-gated, PII-safe GA4 that
  only loads after the user consents and a build-time measurement ID is present.

---

## Feature flags

Capabilities beyond core zero-based budgeting sit behind flags
(`src/AllotJar.Api/Features/FeatureFlags.cs`):

| Flag | Default | What it gates |
|------|---------|---------------|
| `Accounts` | on | Accounts & derived balances |
| `MultiCurrency` | on | Foreign-currency transactions & FX |
| `CamtImport` | on | Bank statement / CSV import |
| `Reports` | on | Trends & annual overview |
| `Jars` | on | Named savings targets (jars) |
| `HouseholdAllocation` | on | Members + income allocation engine |
| `HouseholdAccess` | on | Extra logins with per-role permissions |
| `Analytics` | **off** | Consent-gated GA4 |

- `GET /api/features` exposes the current flags. It's **anonymous** (non-sensitive),
  so the SPA reads it before deciding which nav links, routes and controls to show.
- `[FeatureGate(nameof(...))]` is an action filter that **404s** a disabled feature's
  endpoints, so a flagged-off feature can't be reached even though the UI already hides
  it. Turning the page flags off gives a stripped-back, core-budgeting-only mode.

---

## Running the backend

**Prerequisites:** .NET 10 SDK and SQL Server (LocalDB works out of the box on
Windows). The connection string is in `src/AllotJar.Api/appsettings.json`.

```bash
# from the repo root
dotnet build
dotnet run --project src/AllotJar.Api --launch-profile http
```

- API: <http://localhost:5029>
- Swagger UI (Development): <http://localhost:5029/swagger>
- In Development the API **creates the database and applies migrations on startup**.

You must supply a JWT signing key (see [Security notes](#security-notes)) — the API
**fails fast** without one.

### Database / migrations

```bash
dotnet ef migrations add <Name> \
  --project src/AllotJar.Infrastructure \
  --startup-project src/AllotJar.Api \
  --output-dir Persistence/Migrations

dotnet ef database update \
  --project src/AllotJar.Infrastructure \
  --startup-project src/AllotJar.Api
```

The first migration `InitialCreate` creates the Identity tables plus the budget core.
Later migrations grew the model as features landed — multi-currency, transaction bank
references, income-as-a-category-group, splits, savings/jars, bill tracking, accounts,
household members + memberships + multi-household, allocation profiles, refresh tokens,
and user profile/preference fields — and retired dead ones (`SimplifyRemovePaychecksAndRules`,
`RemoveManualActualEntry`). The `RenameFundsToSavingsAndJars` and
`RemapJarKindToRecurringGoal` migrations performed the Fund→Savings/Jars rename
non-destructively (`sp_rename`, no data loss).

The current `DbContext` exposes `BudgetMonths`, `BudgetCategories`, `BudgetItems`,
`Transactions`, `TransactionSplits`, `Accounts`, `Jars`, `HouseholdMembers`,
`HouseholdMemberships`, `AllocationProfiles`, `AllocationRules` and `RefreshTokens`.

---

## Running the frontend

```bash
cd client
npm install
npm run dev      # http://localhost:5173
```

The Vite dev server proxies `/api` → `http://localhost:5029`, so run the API too.
Register a new account and tick "Start with sample figures to explore" (accounts start
empty by default), then drag a line's planned amount until the banner turns green at
your currency's 0.00.

---

## Tests

```bash
dotnet test                 # backend: xUnit (+ FluentAssertions, NSubstitute, EF InMemory)
cd client && npm run test   # frontend: Vitest + React Testing Library
cd client && npm run test:e2e  # end-to-end: Playwright
```

- **Backend** — ~300 xUnit tests across ~46 suites. `RemainingToBudgetTests` cover
  positive / zero / negative / over-budget cases (including zero income) and
  four-decimal precision; `Money` / `CurrencyCode` guard the cross-currency rules.
  Handler suites prove the budgeting behaviour and that a user **cannot mutate another
  user's** data — budget CRUD/reorder, month create (template/copy/blank), jars &
  savings, bills, accounts, actuals, splits, reports, the import parsers + FX
  resolution + preview/commit flow, allocation, household membership/access and
  auto-categorization.
- **Frontend** — 160+ Vitest tests across the pages and shared libs (`money`,
  `budgetModel`, `transactions` precision + selectors; optimistic-update/rollback on the
  dashboard; page tests for every route; role-gating), plus **Playwright e2e**
  (`a11y`, `landing`, `legal`, `mobile-layout`).

Both suites — plus an **axe accessibility** check — run in CI on every push and PR;
`a11y` is a required check on `main`.

> FluentAssertions is pinned to **7.2.0** — the last Apache-2.0 release (8.x is
> commercially licensed).

---

## Security notes

- Every budgeting endpoint is `[Authorize]`d; handlers additionally scope all
  reads/writes to the active household's `OwnerId` (defence in depth — no IDOR).
- **Tokens:** login/register returns a short-lived (15-min) access token held **in
  memory** by the SPA, plus a rotating **HttpOnly refresh cookie** (`zbb_rt`, `Secure`
  in prod, `SameSite=Strict`, scoped to `/api/auth`) that the client silently exchanges
  for a fresh access token. JWTs are **revocable** via the Identity security stamp, so a
  password change or forced sign-out invalidates outstanding tokens.
- **Account protection:** login returns the **same message** for unknown email and
  wrong password (no enumeration); auth endpoints are **rate-limited**; repeated
  failures trigger **lockout**; new/changed passwords are checked against the **Have I
  Been Pwned** breach list (`BreachedPasswordValidator`, k-anonymity).
- **JWT signing key** is never committed. `appsettings.json` carries no key, and the
  API **fails fast at startup** if `Jwt:Key` is missing or shorter than 32 bytes (HS256
  needs ≥ 256 bits). Supply it via user-secrets (or the `Jwt__Key` environment variable
  in deployment):

  ```bash
  dotnet user-secrets set "Jwt:Key" "<a long random secret, 32+ bytes>" --project src/AllotJar.Api
  ```

  Generate one quickly, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
- **Transport & headers:** production sits behind **Cloudflare** (Full TLS, HSTS at the
  edge, firewall locked to Cloudflare IPs); security headers and CSP are applied in the
  IIS layer (`deploy/web/web.config`) — the CSP allowlists Google Fonts.
- **Dependencies** are scanned (Dependabot) and the app is kept **out of PCI scope**
  (no card data is ever handled).

---

## Deployment

Production runs on a **native Windows Server VPS** (no Docker): IIS serves the React
build and reverse-proxies `/api` to the ASP.NET Core API (ANCM), backed by SQL Server.
See **[docs/deployment/README.md](docs/deployment/README.md)** for the full runbook and
**[docs/deployment/staging-prod.md](docs/deployment/staging-prod.md)** for the
staging/production split.

- **`.github/workflows/ci.yml`** builds and tests backend + frontend (with the axe
  a11y gate) on every push/PR.
- **`deploy.yml`** is the release pipeline: every merge to `main` auto-deploys
  **staging** (`staging.allotjar.com`, IP-allowlisted via a Cloudflare WAF rule,
  `VITE_APP_ENV=staging` with the amber banner + data-loss signup consent), then the
  **production** job (`allotjar.com` / `www`, `VITE_APP_ENV=production`) waits for a
  manual approval on the `production` GitHub environment.
- **`provision-production.yml`** is the manual, reviewer-gated infra workflow that
  stood up (and can re-shape) the production IIS/SQL stack on the VPS.
- Both stacks share one VPS: separate IIS sites/pools, API on `:5000` (staging) and
  `:5001` (production), separate SQL databases (`ZeroBudget` / `ZeroBudgetProd`).
- The `deploy/` folder holds the PowerShell bootstrap/setup/deploy/backup scripts.
