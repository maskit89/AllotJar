# AllotJar 💶

A **Zero-Based Budgeting** (ZBB) web application for the European market. Every
Euro of income is given a job until **"Remaining to Budget" reaches €0.00**.

> 📖 **New to the app?** The **[User Guide](docs/USER_GUIDE.md)** explains every
> page and feature of the portal — budgets, funds, bills, transactions, accounts,
> reports and feature flags.

- **Backend:** ASP.NET Core Web API (clean architecture) + EF Core + SQL Server
- **Auth:** ASP.NET Core Identity issuing JWTs
- **Patterns:** CQRS via MediatR, FluentValidation pipeline
- **Frontend:** React + TypeScript (Vite) + TailwindCSS v4
- **Currency:** single-currency today (EUR). The multi-currency engine — per-budget
  `BaseCurrency`, per-transaction currency + FX rate, all amounts `decimal(18,4)` —
  is **retained in the backend (dormant)** for future expansion; no currency UI is
  exposed.

> Targets **.NET 10** (the SDK installed on this machine). The original brief
> asked for .NET 8; only the `TargetFramework` string differs — the architecture,
> packages and code are identical.

---

## Solution layout

```
AllotJar/
├─ AllotJar.slnx
├─ src/
│  ├─ AllotJar.Domain          # Entities + pure ZBB calculation logic (no deps)
│  ├─ AllotJar.Application     # CQRS (MediatR), DTOs, abstractions, validation
│  ├─ AllotJar.Infrastructure  # EF Core DbContext, Identity, JWT, migrations
│  └─ AllotJar.Api             # Controllers, auth endpoints, DI, Swagger
├─ tests/
│  └─ AllotJar.Application.Tests  # xUnit: ZBB math + handler behaviour
└─ client/                       # Vite + React + TS + Tailwind dashboard
```

The `Application` project is organised by feature — `Budgets`, `Transactions`,
`Accounts`, `Imports`, `Reports` — each holding its commands, queries, DTOs and the
read-time calculators (`BudgetActuals`, `AccountBalances`). (`Imports` is retained but
dormant — see [Bank statement import](#bank-statement-import-iso-20022--camt053).)

### Dependency rule (clean architecture)

```
Domain  ←  Application  ←  Infrastructure
                       ↖        ↑
                          Api (composition root)
```

`Domain` depends on nothing. `Application` depends only on `Domain` and defines
abstractions (`IApplicationDbContext`, `ICurrentUser`, `IJwtTokenGenerator`,
`IStatementParser`, `IExchangeRateProvider`) that `Infrastructure` / `Api`
implement (Dependency Inversion).

---

## Core domain logic

The whole point of ZBB lives in `BudgetMonth` and is pure, testable C#. A month is
a tree of `BudgetCategory` groups (each tagged with a `CategoryKind` — `Income`,
`Expense` or `Fund`) holding `BudgetItem` lines:

```csharp
// Income is the pool to allocate — the sum of the Income-group lines.
public decimal TotalIncome =>
    Categories.Where(c => c.Kind == CategoryKind.Income).Sum(c => c.TotalPlanned);

// Everything that has been given a job: every NON-income group, i.e. expense
// spending plus sinking-fund contributions (funding a fund is a job too).
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
income, expense/fund lines roll up expenses) plus any split slices. A line with no
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
  `Family`) defined in `Application/Budgets/Templates`; new accounts are seeded with a
  default month on registration.
- Category groups and lines have full CRUD plus drag-reorder:
  `POST /api/budget/categories` (pass `IsFund: true` for a sinking-fund group),
  `PUT /api/budget/categories/{id}` (rename), `DELETE /api/budget/categories/{id}`,
  `PUT /api/budget/categories/order`, `POST /api/budget/categories/{categoryId}/items`,
  `PUT /api/budget/items/{id}`, `DELETE /api/budget/items/{id}`, and
  `PUT /api/budget/categories/{categoryId}/items/order`.
- The single `Income` group is rendered first and can't be deleted.

---

## Multi-currency model

> **Dormant today.** The app runs as a single-currency (EUR) product — no currency
> UI is exposed. The engine below is kept intact and tested in the backend so a
> future OpenBanking / multi-market rollout can switch it back on without rework.

- A `BudgetMonth` has a **`BaseCurrency`** (`CurrencyCode` value object, ISO 4217,
  default `EUR`). Every planned/actual amount in the tree is in that currency, so
  totals stay summable and `RemainingToBudget` is unambiguous.
- A `Transaction` carries its **own `Currency` + `ExchangeRate`** (decimal(18,6))
  and exposes `BaseAmount = Amount × ExchangeRate` — converting foreign spending
  (e.g. GBP abroad) into the budget's base currency. On import the rate is
  **resolved from real ECB reference rates** (the free, key-less Frankfurter API,
  behind `IExchangeRateProvider`, historical by booking date, cached) and falls
  back to 1 if a rate can't be fetched — FX never blocks an import.
- `Money` (`decimal Amount` + `CurrencyCode`) is a value object that **forbids
  cross-currency arithmetic** — adding EUR to GBP throws rather than silently
  producing nonsense. Convert through an explicit rate first.
- The client formats every amount with the budget's currency symbol and never
  does money math in floating point (integer minor units at scale 4).

---

## Sinking funds

A `CategoryKind.Fund` group holds **sinking funds** — expense-like lines whose
balance rolls over month to month (e.g. "Car repairs", "Christmas").

- Each fund line carries a stable **`FundId`** shared by every month's instance of
  the same fund, generated when the line is first created and preserved when a month
  is copied.
- The running balance is **derived at read time**: `BudgetActuals` sets each fund
  line's transient `FundAvailable` to `Σ(planned − spent)` for that `FundId` across
  every month up to and including the one being viewed.
- Fund contributions count as planned money (they're a non-income group), so the
  budget only balances once the funds are funded.

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
  the account's own currency, so the transaction register stays the single source of
  truth. (The opening balance can be negative — e.g. a credit card's debt.)
- `GET /api/accounts` returns the accounts with their current balances;
  `POST /api/accounts`, `PUT /api/accounts/{id}` and `DELETE /api/accounts/{id}`
  manage them (currency is immutable once set; deleting an account unlinks its
  transactions rather than removing them). Every handler is owner-scoped.
- A transaction's `AccountId` is independent of its budget-line attribution — a
  transaction can move an account balance, fill a budget line, both, or neither.

---

## Bank statement import (ISO 20022 / CAMT.053)

> **Backend-only / dormant.** There is no statement-upload UI today. The parser and
> endpoint below are retained, fully tested, and gated by the `CamtImport` flag so an
> upcoming OpenBanking integration can feed them programmatically. End users add
> transactions by hand on the Transactions page.

A CAMT.053 XML statement's entries become `Transaction`s.

- `POST /api/import/camt053` (multipart `file`, optional `accountId`, `[Authorize]`d)
  → import summary (`TotalEntries`, `Imported`, `SkippedDuplicates`, `Credits`,
  `Debits`, `Iban`, `AutoCategorized`).
- `Camt053StatementParser` (Infrastructure, behind the `IStatementParser`
  abstraction) reads `<Ntry>` elements **by local name**, so it handles every
  `camt.053.001.xx` namespace version. `CdtDbtInd` maps to income/expense, the
  entry keeps its own `Ccy`, and the payee comes from the creditor/debtor name.
- Re-importing is **idempotent**: entries are de-duplicated per user on their
  bank reference (`AcctSvcrRef`, falling back to `EndToEndId`).
- Passing an `accountId` **imports the statement into that account** (owner-validated
  up front), stamping every imported transaction with it so the account balance moves.

---

## Transactions, splits & actual spending

- `GET /api/transactions` lists the user's transactions (filterable by month /
  unassigned); the **Transactions** page assigns each to a budget line.
  `POST /api/transactions` adds a manual one and `PUT`/`DELETE /api/transactions/{id}`
  edit and remove it (each carrying an optional `AccountId`).
- `PUT /api/transactions/{id}/assignment` sets/clears a line (ownership checked
  on both the transaction and the target line).
- `PUT /api/transactions/{id}/splits` **splits a transaction across two or more
  lines** (`TransactionSplit`). A transaction is whole-assigned **xor** split (its
  `BudgetItemId` is cleared and the slices carry the attribution, summing exactly to
  the total) **xor** unassigned, so it never double-counts.
- A line's **`ActualAmount` is derived at read time** from the expense transactions
  (and split slices) assigned to it, summed in base currency via `Amount ×
  ExchangeRate` — no denormalized total to keep in sync. This fills the dashboard's
  "Actual" / "Remaining" columns; assigning or splitting a transaction flips its
  target line(s) to `Tracked` mode.
- **Auto-categorization (zero-config):** there are no user-managed rules. When a
  transaction is logged without a line, `AutoCategorizer` quietly assigns it to the
  budget line of the user's **most recent earlier transaction with the same
  description** (payee, matched case- and whitespace-insensitively), flipping that
  line to `Tracked`. It runs on manual creation and on the (dormant) import path; the
  import summary still reports how many were auto-categorized.

---

## Reports & trends

`ReportsController` exposes read-only, owner-scoped analytics:

- `GET /api/reports/trends?months=N` rolls up the most recent N budgets into an
  income / income-received / planned / spent series (spent reuses `BudgetActuals`).
- `GET /api/reports/annual/{year}` returns a 12-month overview (income / planned /
  spent + totals) for one calendar year.

The Reports page renders these as plain CSS bar charts (no charting library).

---

## Feature flags

Four capabilities sit behind flags (`src/AllotJar.Api/Features/FeatureFlags.cs`),
all **default ON**: `Accounts`, `MultiCurrency`, `CamtImport`, `Reports`.
`Accounts` and `Reports` toggle a whole page (nav link + routes + endpoints).
`MultiCurrency` and `CamtImport` now gate **dormant, backend-only** capabilities
(the single-currency UI and the removal of the import button mean they have no
user-facing surface today) — they remain so those features can be switched back on
later without rework. Turning the page flags OFF gives a "pure EveryDollar" mode.

- `GET /api/features` exposes the current flags. It's **anonymous** (non-sensitive),
  so the SPA reads it before deciding which nav links, routes and controls to show.
- `[FeatureGate(nameof(...))]` is an action filter that **404s** a disabled feature's
  endpoints (applied to `AccountsController`, `ReportsController` and
  `ImportController`), so a flagged-off feature can't be reached even though the UI
  already hides it.

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

The first migration `InitialCreate` creates the Identity tables plus
`BudgetMonths`, `BudgetCategories`, `BudgetItems`, `Transactions` — all currency
columns as `decimal(18,4)`, with a unique `(OwnerId, Year, Month)` index. Later
migrations grew the model as features landed: multi-currency, transaction bank
references, income-as-a-category-group, manual actuals and the actual-entry mode,
transaction splits, fund ids, bill tracking, and accounts (with `Transaction.AccountId`
on delete set null). When the paychecks and rules features were retired,
`SimplifyRemovePaychecksAndRules` dropped the `Paychecks`, `PaycheckAllocations` and
`CategorizationRules` tables (the multi-currency schema was deliberately preserved).
Later, when per-line actuals became transaction-only, `RemoveManualActualEntry` dropped
the `ManualActualAmount` and `ActualEntryMode` columns.
The current `DbContext` exposes `BudgetMonths`, `BudgetCategories`, `BudgetItems`,
`Transactions`, `TransactionSplits` and `Accounts`.

---

## Running the frontend

```bash
cd client
npm install
npm run dev      # http://localhost:5173
```

The Vite dev server proxies `/api` → `http://localhost:5029`, so run the API too.
Register a new account (you get a seeded starter budget), then drag a line's
planned amount until the banner turns green at €0.00.

---

## Tests

```bash
dotnet test                 # backend: xUnit (+ FluentAssertions, NSubstitute)
cd client && npm run test   # frontend: Vitest + React Testing Library
```

**Backend** — **172 xUnit tests**. `RemainingToBudgetTests` cover positive / zero /
negative / over-budget cases, **including zero income** and four-decimal precision;
`Money`/`CurrencyCode` value-object tests guard the (dormant) cross-currency rules.
Handler suites prove the budgeting behaviour and that a user **cannot mutate another
user's** data — `UpdateBudgetItemHandlerTests`, the category/line CRUD and reorder
tests, `CreateBudgetMonthTests` (template / copy / blank), `FundsTests`,
`BillTrackingTests`, `AccountsTests`, `BudgetActualsTests`, `SplitTransactionTests`,
`ManualActualTests`, `BudgetTrendsTests` / `AnnualSummaryTests`, and the CAMT.053
parser, import and FX-resolution tests (kept alive even though both are dormant).
`AutoCategorizationTests` cover the description-based fallback (inherits the most-recent
same-description line, never across owners, applied on manual create and import).
NSubstitute and EF InMemory isolate handlers from collaborators.

> FluentAssertions is pinned to **7.2.0** — the last Apache-2.0 release (8.x is
> commercially licensed).

**Frontend** — **81 Vitest tests** across the pages and shared libs:
`money` / `budgetModel` / `transactions` precision + selector tests, a `DashboardPage`
test asserting **optimistic update + rollback** on a failed save, and page tests for
Transactions, Accounts and Reports plus the shared `AppNav` (four nav items) and the
Help page. Both suites run in CI on every push and PR.

---

## Security notes

- Every budgeting endpoint is `[Authorize]`d; handlers additionally scope all
  reads/writes to the caller's `OwnerId` (defence in depth — no IDOR).
- Login returns the **same message** for unknown email and wrong password (no
  account enumeration).
- The JWT signing key is **never committed**. `appsettings.json` carries no key,
  and the API **fails fast at startup** if `Jwt:Key` is missing or shorter than
  32 bytes (HS256 needs ≥ 256 bits). Supply it once via user-secrets (or the
  `Jwt__Key` environment variable in deployment):
```
dotnet user-secrets set "Jwt:Key" "<a long random secret, 32+ bytes>" --project src/AllotJar.Api
```
  Generate one quickly, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
