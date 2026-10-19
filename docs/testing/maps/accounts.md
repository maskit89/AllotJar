# Subsystem map: Accounts, balances, reconciliation, account detail

Ground-truth feature inventory for QA test design. All paths relative to repo root `<local>\Documents\Projects\ZeroBudget`. Verified against source on 2026-07-15 (main working tree). PR #167/#168 (months/accounts coherence, merged + live on beta 2026-07-09) are the most recent changes touching this subsystem.

---

## 1. Screens & routes

| Route | Component | Shown when | Guards / gating |
|---|---|---|---|
| `/accounts` | `AccountsPage` (`client/src/pages/AccountsPage.tsx`) | Signed in | Route only registered when `features.accounts` is true (`client/src/App.tsx:90-99`); wrapped in `RequireAuth` (redirects to `/login?returnUrl=...` when unauthenticated; splash while bootstrapping). With the flag off the path falls through to the `*` catch-all → redirect to `/` (`App.tsx:179`). |
| `/accounts/:id` | `AccountDetailPage` (`client/src/pages/AccountDetailPage.tsx`) | Signed in | Same `features.accounts` + `RequireAuth` gating (`App.tsx:100-109`). Any `:id` string is accepted client-side; unknown id → in-page "Account not found" empty state (no 404 route). |
| Nav entry | `AppNav` "Accounts" item | Always in primary nav when `features.accounts` (`client/src/components/AppNav.tsx:34`) | Hidden entirely when the flag is off. Active-state key `accounts` is set by both pages via `AppShell active="accounts"`. |

Notes:
- `client/src/pages/AccountPage.tsx` (singular, route `/account`) is the **user profile/"My account" page** — NOT part of this subsystem. Do not confuse.
- There is no per-account GET endpoint: `AccountDetailPage` fetches the full `GET /accounts` list and `find`s the id client-side (`AccountDetailPage.tsx:31-43`).
- `AccountDetailPage` additionally fetches `GET /transactions` (full register, server-ordered date-descending — `GetTransactionsQueryHandler.cs:53`), `GET /budget/current` (for category chip hues and which lines are jar lines), `GET /jars/ledger` (which account holds each jar, for the jar chip — #344 P3-2) and, since the restyle (PR 11), `GET /accounts/reconciliation` (the account's row: what its jars hold, for the In jars tile — the same read-only endpoint the Accounts page uses). All are tolerant, so their failure never breaks the page. Opened from an Accounts card (a PUSH navigation), the page takes that card's reconciliation row from router state (`reconState`/`reconFromState`, `client/src/lib/accountJars.ts`) and skips the reconciliation GET; a reload, Back/Forward or a direct open (POP) asks the server as before. The first two share the `Promise.all` with `/accounts` (the page shows "Loading…" until they answer); the reconciliation is asked for at the same time but never waited on: the balance and the list show without it and In jars joins them when it answers (a late answer for an account the page has left is dropped).

## 2. UI controls & user actions (exact visible labels)

### AccountsPage (`client/src/pages/AccountsPage.tsx`)

**Hero** (top): eyebrow "Total balance", big amount = net across all accounts; tiles "Available" (sum of positive balances) and "Owed" (−sum of negative balances, displayed positive). All three are labelled in the household's **budget currency** (`useAuth().budgetCurrency`) and count **only accounts whose currency equals the budget currency** (`inBudgetCurrency`, W08). An older account kept in another currency is left out of every hero figure and called out by a footnote pill: "{N} account(s) in another currency is/are not counted.".

**Section header**: "Your accounts" + button "+ Add account" (aria-label `Add account`) — rendered only when `canWrite` (Admin+; line 321).

**Add-account modal** (title "Add an account", shown only when `canWrite`):
- "Name" — text `Input`, placeholder "e.g. Everyday current", aria-label `Account name`.
- **No currency picker** (W08; removed whatever the `multiCurrency` flag says). A note reads "The account holds {budgetCurrency}, your budget currency." and the POST always sends `currency: budgetCurrency` (never the login's `preferredCurrency`).
- "Type" — `Select` aria-label `Account type`, options from `ACCOUNT_TYPE_LABELS`: Current / Savings / Cash / Credit card / Other (numeric values 0–4, `client/src/types.ts:88-102`). Default Current.
- "Opening balance" — text `Input` `inputMode=decimal`, placeholder "0.00", aria-label `Opening balance`; Enter submits.
- Buttons: "Cancel" (ghost) and "Add account" (disabled while `adding`).
- Errors render as an `ErrorBanner` inside the modal; the page-level banner is suppressed while the modal is open (`error && !showAdd`, line 213).

**Account card** (grid, `auto-fit minmax(240px,1fr)`):
- Whole card is an overlay `Link` to `/accounts/{id}` (aria-label `View {name}`).
- Type-hue icon tile (hue mapping: Savings→emerald, Cash→amber, CreditCard→rose, Current→indigo, other→teal — `client/src/lib/categoryColors.ts:34-46`).
- Currency chip (e.g. "EUR") shown when `multiCurrency` is on, **or** whenever the account's currency differs from the budget currency (so a legacy other-currency account is always labelled); type badge (label from `ACCOUNT_TYPE_LABELS`, fallback "Other").
- Name; balance formatted **in the account's own currency** (`formatMoney(balanceMinor, a.currency)`), rose text when negative; caption "Opening {formatted amount}" also in account currency (lines 396-402).
- Hover/focus reveals (only when `canWrite`): "✎" button (aria `Edit {name}`, title "Edit account") and "✕" button (aria `Delete {name}`, title "Delete account"; disabled while that id is saving). Buttons are `opacity-0` until `group-hover`/`focus-within` — a QA target for keyboard access.

**Inline edit card** (replaces the card when editing):
- Name `Input` (aria `Name for {name}`), Type `Select` (aria `Type for {name}`), Opening `Input` (aria `Opening balance for {name}`; pre-filled via `toEditString(fromAmount(openingBalance))` — plain non-localized decimal).
- When `multiCurrency` (or the account is in another currency than the budget): read-only note "Currency {code} — fixed once created." — there is **no currency input on edit** (immutability surfaced in UI; server request body has no currency field).
- Buttons: "Save" (aria `Save {name}`, disabled while saving) and "Cancel" (ghost, aria `Cancel edit`).

**Delete confirmation modal** (shown only when `canWrite`; opened by ✕):
- Title `Delete {name}?`
- Body: "The account is removed, but its transactions are kept — they simply become unassigned from any account. This can’t be undone."
- Buttons: "Cancel" (ghost) and "Delete account" (aria `Confirm delete {name}`, disabled while deleting). Note: the modal body does NOT display the account's currency or balance — only the name in the title.

**Empty state** (no accounts): icon + title "No accounts yet", description "Use + Add account, then tag transactions to it to track its balance."

**Loading**: paragraph "Loading…". Load error: `ErrorBanner` "Could not load your accounts."

**"Jar reconciliation" card** (bottom): rendered only when `reconciliation.some(r => r.backedJarCount > 0)` (line 434) — i.e. hidden for users with no jar backed by any account.
- Header "Jar reconciliation", sub-text "Each account’s balance against the jars it holds — the float is what’s not yet earmarked."
- Table columns: Account / Balance / In jars / Float. Rows filtered to `backedJarCount > 0`. All three money cells formatted in the account's own currency, looked up client-side via `currencyById[r.accountId] ?? budgetCurrency` (the DTO carries no currency — PR #168). Negative float renders rose.
- Reconciliation is re-fetched whenever the `accounts` state array changes (initial load + after add/edit/delete; effect at lines 72-81). Its fetch errors are silently swallowed (`.catch(() => {})`).

**Read-only / Limited roles**: `canWrite = role <= HouseholdRole.Admin` (`client/src/auth/AuthContext.tsx:366`). Non-Admin members see the cards, hero and reconciliation but no "+ Add account", no ✎/✕, no modals — a read-only register.

### AccountDetailPage (`client/src/pages/AccountDetailPage.tsx`)

Restyle PR 11: the account's own page in the app frame, built from the shared pieces (KpiTile/KpiRow, the Accounts
page's `TypeTile`/`HolderAvatars` in `client/src/components/accounts/AccountParts.tsx` and `accountJars` in
`client/src/lib/accountJars.ts`, the Transactions row look from `client/src/components/transactions/TxParts.tsx`,
StatusChip, InfoHint).

- Top bar: `AppShell back={{ to: '/accounts', label: 'Accounts' }}` — a 40px chevron link named **"Back to Accounts"** → `/accounts` before the title (the account's name; "Loading…" while it loads, "Account" when not found); on a phone it replaces the logo. The sidebar's "Accounts" stays the current page.
- KPI row (`KpiRow onGrid`, on the body's three columns):
  - Hero **"Balance"** with an (i) "About balance" (how the balance is worked out); value = current balance in the account's currency, accessible name "{name} balance: {money}" (or "not available"). "Not available" when `currentBalance` is null, with the reason under it: "Set an opening date to calculate the balance." (`openingDateMissing`) or "No balance before the opening date.". Lines under the number: "{inTransitOut + inTransitIn} in transit" when either is non-zero, and "{pendingReceiptTotal} pending review" when `pendingReceiptCount` > 0 (both as money in the account's currency).
  - **"In jars"** (only when the account's reconciliation row has `backedJarCount > 0`; until the reconciliation answers, the tile's room is held by a quiet placeholder `data-testid="in-jars-pending"` (aria-hidden) when the jar ledger says the account holds jars or has not answered yet, so the row does not jump — #344 P3-6): `backedJarsTotal`, the Accounts card's bar, and the rest with its (i): "€X not in jars" / "€X over" (red) / "Jars exceed account money" (`accountJars`, the Accounts card's figures). Without it the hero spans the row.
- **Transactions** card (a region named by its h2 "Transactions" + count badge `data-testid="account-tx-count"`, shown only when there are rows; the region's name reads "Transactions, {N}" — a visually hidden comma, #344 P3-6):
  - Rows: every transaction where `t.accountId === id` **or** `t.transferAccountId === id` — transfers into the account appear too — sorted newest-first by the date this account posts the row (the departure for the source, the receipt for the destination; a transfer that left before the opening date and came back after it shows on its return date — `registerRows`, `client/src/lib/accountRegister.ts`), grouped under one h3 per month ("October"; "December 2025" for another year — `monthHeading`).
  - Each row (`data-testid="tx-row"`): date (`shortDate`), a tile icon (transfer, income, refund, jar line, else purchase), payee (falls back to "Transfer" for transfers, "—" otherwise), then: for a transfer the route `[data-tx-route]` — an arrow and "To {other}" / "From {other}" with `(removed account)` fallback; a split → "Split"; an assigned row → a coloured chip with the budget line name (a jar chip when the line has a `savingsId` and the account holds jars); unassigned → an "Unassigned" label. Status chips: **In transit**, **Returned** (red), **Pending review** (amber).
  - Chip hues keyed by **budget line NAME** from `/budget/current` (Income → emerald, Savings/Expense → indexed hues, as on Transactions), with a deterministic name-hash fallback so lines not in the current month never render grey.
  - Amount `[data-tx-amount]`: transfers signed by direction — "−" when this account is the source, "+" when destination; income "+", expense "−". Transfer amounts render slate (muted), income green (`text-ok`), expense dark. Each row formats with `t.currency` (the transaction's own stamped currency), not the account currency. Under it: "Needs {budget currency} amount" (amber tag, with an (i) after it "About {payee} on {date}: needs {X} amount" → "In another currency. Not counted anywhere until you enter the amount in {X}."; below 360px on a phone the tag and its (i) move to the row's second line), the foreign amount ("USD 25.00", title "Paid in USD") or "Counts as {money} in the budget" (on a phone these small lines wrap within 112px).
  - Came back (#344 P3-1): a transfer out that left before the opening date and was returned after it is listed on its return date as money in ("+"), not struck through, with the **Returned** chip and an (i) "About {payee} on {date}: returned" → "Left on {departed}, before the opening balance of {opening}, and came back on {returned}: the return adds it to the balance." (the server's account ledger counts the return leg; the listed rows add up to the balance less the opening balance — `accountRegister.test.ts`).
  - Struck through (they never move the balance): a **Returned** transfer, and a row dated before the opening date (by this account's own leg; not a transfer that left before it and came back after it), which is muted and says **"Before opening"** with an (i) "About {payee} on {date}: before opening" → "Dated before the opening balance of {date}, which already includes it: kept as history, it doesn’t change the balance."
  - Empty: "No transactions on this account yet." (no count badge: the line says it).
  - Phone (< 700px): two lines a row — payee and amount; then the category or route, the date (once; after a route, "· {date}" wraps as one piece) and the status chip. A Split/Unassigned label gives way (truncates) when its line is short of room.
- **Account details** card (a region named by its h2): the type icon and the type in words, the holders' avatars ("Held by …" for screen readers), "Opening balance" with "On {date}" when an opening date is set, then one row per recorded identifier (IBAN, BIC, Sort code, Account number). An IBAN stored without spaces shows in groups of four (`[data-iban]`, the gaps are margins so copying gives the stored value; a stored value with spaces shows as stored — #344 P3-5). Values are 14px; a long one wraps at its own spaces. On a phone it comes after the transactions.
- Not-found state (id not in list, or `GET /accounts` failed): title "Account not found", description "It may have been deleted. Head back to your accounts." Loading: "Loading…".
- Page is entirely read-only — no add/edit/delete/transfer affordances; its only controls are the back link and the (i) hints.

### Related (balance-affecting) controls elsewhere
- **Transfers** are recorded from TransactionsPage's add modal, mode select "Transfer" → title "Record a transfer": fields aria `Transfer date`/`Transfer amount`/`Transfer from account`/`Transfer to account`/`Transfer note` (placeholder "Transfer"), button "Record transfer". Client-side errors: "Enter a valid transfer amount greater than zero." and "A transfer needs two different accounts."; API failure → "Could not record that transfer." (`client/src/pages/TransactionsPage.tsx:146-178`). Analytics `transfer_created`.
- **Jar → account backing** is set on JarsPage's jar form: "Held in" `Select` (aria `Funding account`), first option "No account" (`client/src/pages/JarsPage.tsx:453-467`). This drives which accounts appear in the reconciliation table.
- Transactions can be assigned an account at create/edit on TransactionsPage (Account select) — that is the transactions subsystem, but it is what moves account balances.

## 3. API endpoints

Controller: `src/AllotJar.Api/Controllers/AccountsController.cs`. All actions: `[Authorize]` (JWT bearer) + `[FeatureGate(nameof(FeatureFlags.Accounts))]` — **the whole controller returns 404 when the `Features:Accounts` config flag is off** (`src/AllotJar.Api/Features/FeatureGateAttribute.cs`). Flags default ON (`FeatureFlags.cs`).

Role enforcement is the MediatR `AuthorizationBehaviour` (`src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`): request types ending "Query" allowed for every role; types ending "Command" require **Admin+** unless attributed. None of the three account commands carry `[AllowLimited]`/`[OwnerOnly]`, so **Limited and Read-only logins get 403** ("Your access level ({role}) does not permit this action.") on create/update/delete. All handlers additionally scope data by `ICurrentUser.OwnerId` (household key).

| Verb + route | Handler | Success | Errors |
|---|---|---|---|
| `GET /api/accounts` | `GetAccountsQueryHandler` | 200 `AccountDto[]` ordered by `DisplayOrder` then `Name`; balances derived via `AccountBalances.ApplyAsync` | 401 unauth; 404 flag off |
| `GET /api/accounts/reconciliation` | `GetAccountReconciliationQueryHandler` | 200 `AccountReconciliationDto[]` (same ordering; empty array when no accounts) | 401; 404 flag off |
| `POST /api/accounts` body `{name, type, currency, openingBalance}` | `CreateAccountCommandHandler` | 201 `AccountDto` (CreatedAtAction → List); `DisplayOrder` = max existing + 1 (0 for first); name trimmed; currency normalized upper-case via `CurrencyCode.From` and **must equal the household's budget currency** (`BudgetCurrency.ResolveAsync`, W08) | 400 validation (incl. `Currency`: "This budget is in {X}, so its accounts are too. A bank converts payments in other currencies into {X} itself."); 403 role < Admin; 404 flag off |
| `PUT /api/accounts/{id:guid}` body `{name, type, openingBalance}` — **no currency field: immutable by API shape** | `UpdateAccountCommandHandler` | 200 `AccountDto` with recomputed balance | 400 validation; 403 role or other household's account (`account.OwnerId != userId`); 404 "Account {id} was not found." |
| `DELETE /api/accounts/{id:guid}` | `DeleteAccountCommandHandler` | 204; explicitly nulls `AccountId` on the account's transactions and `TransferAccountId` on transfers-in (that FK is Restrict) before removing — register survives | 403 role/ownership; 404 unknown id |
| `POST /api/transactions/transfer` body `{date, amount, fromAccountId, toAccountId, payee?}` (TransactionsController; feature-gated on **Accounts**? — no: TransactionsController is not account-gated; command is `[AllowLimited]` so Limited may transfer) | `CreateTransferCommandHandler` | 201 `TransactionDto`; single Transfer row, `Currency` stamped from the source account; a transfer is never `FxPending` | 400 (see §4); 403 either account in another household; 404 "Account {fromId/toId} was not found." |

Error payload shape (`src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs`): `ValidationException` → 400 `{status, title:"Validation failed", errors:{Field:[msg,...]}}`; `NotFoundException` → 404 `{status, title}`; `ForbiddenAccessException` → 403; anything else → 500 "An unexpected error occurred.".

## 4. Validation rules & exact error messages

### Server (FluentValidation, run by ValidationBehaviour before handlers)

`CreateAccountCommandValidator` (`src/AllotJar.Application/Accounts/Commands/CreateAccount/CreateAccountCommandValidator.cs`):
- Name: NotEmpty → "An account needs a name."; MaximumLength(120).
- Type: `IsInEnum()` (0–4).
- Currency: NotEmpty → "An account needs a currency."; regex `^[A-Za-z]{3}$` → "Currency must be a 3-letter ISO 4217 code." (case-insensitive input; stored upper-cased). Any 3-letter string passes the validator — but the **handler** then refuses any code other than the budget currency (W08, rules 63/85): `Currency` → "This budget is in {X}, so its accounts are too. A bank converts payments in other currencies into {X} itself." The budget currency is the household's earliest budget month's `BaseCurrency`, else the owner's `PreferredCurrency`, else EUR (`src/AllotJar.Application/Budgets/BudgetCurrency.cs`).
- OpeningBalance: InclusiveBetween(−99 999 999 999 999.9999, +99 999 999 999 999.9999) → "Opening balance exceeds the supported range." **Negative opening balances are valid** (credit-card debt).

`UpdateAccountCommandValidator`: Id NotEmpty; Name/Type/OpeningBalance same as create; no currency rule (field doesn't exist).

`DeleteAccountCommand`: no validator; handler throws NotFound/Forbidden as above.

`CreateTransferCommandValidator` (`.../CreateTransfer/CreateTransferCommandValidator.cs`):
- Amount > 0 → "A transfer amount must be greater than zero."; ≤ max → "Transfer amount is out of range."
- From/To NotEmpty; To ≠ From → "Choose two different accounts for a transfer."
- Payee max 200.
- Handler (PR #167): `from.Currency != to.Currency` → ValidationException keyed `ToAccountId`: "Both accounts must use the same currency to transfer between them." (`CreateTransferCommandHandler.cs:40-49`; `CurrencyCode` is a record → value equality).

Handler-thrown messages: "No authenticated user on the request." (Forbidden, 403 — only reachable without middleware); "Account {guid} was not found." (404).

### Client (AccountsPage; shown in ErrorBanner)
- Empty name on add or save: "Give the account a name."
- Invalid opening amount: "Enter a valid opening balance." (`parseSignedAmount`: empty string → 0; optional single leading "−"; rest must parse via `parseMinor` — digits with one `.`/`,` decimal separator, European grouping tolerated when both separators present, >4 dp rounded half-up; `AccountsPage.tsx:23-30`, `client/src/lib/money.ts:264-299`).
- API failures: "Could not load your accounts." / "Could not add that account." / "Could not save that account." / "Could not delete that account." (generic — server field errors are not surfaced).

## 5. State variants

- **Loading**: "Loading…" text on both pages (detail page loads accounts+transactions+budget in one `Promise.all`).
- **Empty**: AccountsPage `EmptyState` "No accounts yet"; detail register "No transactions on this account yet."; reconciliation card entirely absent until ≥1 account backs ≥1 active jar.
- **Error**: page-level `ErrorBanner` (hidden while add-modal open — the modal shows its own copy); reconciliation fetch failure is silent (table just doesn't refresh/appear).
- **Feature flag off** (`Features:Accounts=false` server config): nav item gone, routes unregistered (URL → redirect to `/`), API 404s. Client flag state comes from `GET /features` merged over an all-on default (`client/src/features/FeatureContext.tsx` — note: if `/features` fails, the client assumes all-on while the server still 404s → UI shows pages whose API calls fail; edge case worth a test).
- **`multiCurrency` flag off**: currency chips and "fixed once created" notes hidden **except on an account whose currency differs from the budget currency** (those keep both); per-account formatting still uses `a.currency`. The add form has no currency picker either way (always the budget currency).
- **Solo vs shared household**: no difference on these pages (no member attribution on accounts). Role matters instead: Owner/Admin get full CRUD; Limited/Read-only get read-only UI (`canWrite`) and server 403s on account commands. Limited CAN record transfers (`[AllowLimited]` on `CreateTransferCommand`).
- **Archived/deleted referents**:
  - Deleted account: its transactions survive with `AccountId=null` (unassigned); transfers referencing it as destination get `TransferAccountId=null`; register rows then render "(removed account)" in transfer direction text (detail + transactions pages, PR #168). Visiting a deleted account's stale URL → "Account not found" state.
  - Archived jars are **excluded** from reconciliation (`GetAccountReconciliationQueryHandler.cs:44` filters `!f.IsArchived && f.FundingAccountId != null`).
  - A jar whose funding account was deleted: `Jar.FundingAccountId` — check FK behavior in JarConfiguration if testing; reconciliation only shows jars with non-null FundingAccountId matched to existing accounts, so orphaned backings simply drop out.
- **Account in another currency** (legacy data only — create now refuses it): hero totals leave it out entirely and show the "{N} account(s) in another currency … not counted." pill; its own card still shows its balance in its own currency with the currency chip. No raw cross-currency sum is ever shown (W08). Its rows keep their amount in its currency; a row in another currency than the budget's waits until the user enters its budget figure on Transactions, which is stored beside the amount as `Transaction.BudgetAmount` (Christopher's "Support them", 29 Sep 2026) and shown on the detail register as a grey caption "Counts as {€X} in the budget" (`AccountDetailPage`, only when the row is not waiting).
- **Negative balances**: rose-colored on card, hero "Owed" tile aggregates them.

## 6. Computed/derived values & money rules (as implemented)

- **Account balance** (never stored; `Ignore(a => a.CurrentBalance)` in EF): `CurrentBalance = OpeningBalance + Σincome − Σexpense − ΣtransferOut(AccountId=this) + ΣtransferIn(TransferAccountId=this)` over the household's transactions assigned to the account (`src/AllotJar.Application/Accounts/AccountBalances.cs:65`). Income/expense legs are grouped server-side per (account, type); transfer rows are fetched for the whole owner (not filtered by account ids) and matched in memory.
- **Raw amounts, no FX**: `AccountBalances` sums `t.Amount` verbatim. There is no exchange rate anywhere any more (W08 dropped `Transaction.ExchangeRate`/`BaseAmount`): a row on an account is in that account's currency. A row on a legacy account kept in another currency (or a foreign row on a budget-currency account from before #210) may carry `BudgetAmount` — what it counts in the budget, set by the `ForeignAmounts` migration or by the user's Enter amount (`ConfirmConvertedAmount` stores it there and leaves `Amount`/`Currency` alone for any row on an account). Budget, report, People and refund figures read `BudgetAmount ?? Amount`; balances never read `BudgetAmount`, so confirming never moves an account. Editing such a row's amount clears `BudgetAmount` and the row waits again.
- **Splits don't matter to balances**: split slices are budget-line attribution only; the whole transaction amount moves the account (class doc, `AccountBalances.cs:8-16`).
- **Create**: balance short-circuits to `OpeningBalance` (no tx possible yet, `CreateAccountCommandHandler.cs:47`). Update re-runs the derivation and returns it.
- **Reconciliation** (`GetAccountReconciliationQueryHandler`): for each account, `BackedJarsTotal = Σ over active jars backing it of (jar.OpeningBalance + trackedBalance)`, where trackedBalance = all-time `JarBalances.ComputeAsync` = Σ over savings-kind budget lines linked to the jar of `PlannedAmount − spent`, spent = assigned expense tx (`Amount`, budget currency; rows still `FxPending` are excluded) + split slices (`src/AllotJar.Application/Jars/JarBalances.cs`). `Float = CurrentBalance − BackedJarsTotal` (positive = unallocated cash, negative = shortfall). `BackedJarCount` = number of active jars naming the account.
- **As-of balance logic**: `JarBalances.ComputeAsync` takes an optional `(Year, Month)? asOf` — strictly-before month filter used by **month creation** to seed savings lines (PR #167); reconciliation and the jars page call it WITHOUT asOf (all-time). The EF-translatability trick (hoisted `hasAsOf`/`asOfYear`/`asOfMonth` locals, `JarBalances.cs:28-41`) is an invariant — do not inline a nullable-tuple check.
- **Client money**: integer minor units at scale 4 (`FACTOR = 10_000`), converted at the API boundary (`fromAmount`/`toAmount`); sums are integer sums (`AccountsPage.tsx:168-179`); display via `Intl.NumberFormat` currency style with the user's `numberFormat` preference locale (per-currency fraction digits: JPY 0dp etc.). Server money is `decimal(18,4)` (`AccountConfiguration.cs:33-34`).
- **Net footers / hero tiles**: `netMinor` = Σ balances of budget-currency accounts with an available balance; `availableMinor` = Σ max(0, balance); `owedMinor` = Σ min(0, balance) (displayed negated). Accounts in another currency are excluded (never a cross-currency sum).
- **DisplayOrder**: create assigns `max(existing)+1` (−1+1=0 for first); no reorder UI exists; list sort is DisplayOrder, then Name.
- Duplicate account names are allowed (no uniqueness rule anywhere).

## 7. Known invariants, gotchas & recent-fix regressions

- **Balance is always derived, never persisted** — any feature that caches it must be treated as a bug. (`Account.cs:37-42`, `AccountConfiguration.cs:36-37`.)
- **Currency is immutable after create** (PR #168 UX + API shape): `UpdateAccountRequest` has no currency; UI shows "fixed once created." A regression would be silent reinterpretation of the whole register.
- **Transfers only via `POST /transactions/transfer`** (PR #167): generic transaction create/update reject `Type=Transfer`; destination-less transfers used to vanish money from derived balances. Editing a transfer via UpdateTransaction is blocked; UI has no edit affordance on transfer rows. Regression test: attempt `POST /api/transactions {type: Transfer}` → 400.
- **Cross-currency transfers blocked** (PR #167): same-currency guard + transfer stamped in the source account's currency (was hardcoded EUR). Regression: EUR→GBP transfer must 400 with "Both accounts must use the same currency to transfer between them."
- **Delete unlinks, never cascades** (explicit nulling in handler for provider parity; FK is SetNull for AccountId, Restrict for TransferAccountId — `DeleteAccountCommandHandler.cs:36-55`, `AccountConfiguration.cs:41-46`). Regression: deleting an account must not delete or fail on transfer rows pointing into it.
- **Per-account currency display** (PR #168): cards, opening captions and reconciliation cells format in `a.currency` (NOT `preferredCurrency`); reconciliation currency looked up client-side by accountId. Hero is labelled in the budget currency and counts only budget-currency accounts (W08). A preference change must never relabel account cards (and once the household holds anything the preference can't change — see `maps/auth.md`).
- **"(removed account)" fallback + signed transfer rows on the single-account register** (PR #168): − when source, + when destination.
- **Category pills keyed by name with hash fallback** (PR #168): rows from non-current months must not render grey.
- **Deferred / known-broken (do NOT report as new bugs, but don't let them regress silently either)** (memory `months-accounts-coherence-audit-2026-07.md`):
  - ~~`AccountBalances` and hero totals raw-sum across currencies; `ExchangeRate` is hardcoded 1 app-wide.~~ Resolved by W08: hero counts only budget-currency accounts; `ExchangeRate` no longer exists.
  - ~~Reconciliation `Float` mixes account-currency balance with base-currency jar totals.~~ Resolved by W08: a jar can only be held in a budget-currency account (`JarAccounts.LoadDesignatedAsync` refuses another currency: "{Account} is in {X}, but the budget is in {Y}. Choose an account in {Y}.").
  - Manually-entered transactions are stamped in the household's budget currency (`BudgetCurrency.ResolveAsync`); since every new account is also in the budget currency, the mismatch only remains for legacy other-currency accounts.
- **Role gating asymmetry**: account CRUD = Admin+; transfers = Limited+; reads = all roles incl. Read-only. Client `canWrite` mirrors the server default but the server is authoritative (`AuthorizationBehaviour.cs`).
- **Feature-gate parity**: UI hides + API 404s must stay in sync; `FeatureGate` returns bare 404 (no body).
- **Currency validator accepts any 3 letters** ("ZZZ" passes) — `Intl.NumberFormat` on the client will still render unknown ISO codes generically; not validated against a currency list by design (picker is a shortlist, engine accepts any code — `money.ts:63-68`).
- **Recent auth-adjacent PRs (#169/#171)** don't change accounts logic but affect any long-lived accounts tab: silent-refresh races and cross-tab logout broadcast can interleave with the page's fetch effects; a genuinely dead session should land the login prompt, not a broken accounts view.
- Reconciliation fetch is fire-and-forget on every `accounts` state change — after a delete the table refreshes because the array identity changes; a failure leaves stale rows silently.
- Existing automated coverage: `client/src/pages/AccountsPage.test.tsx` (list/net hero, add, delete-confirm, cancel, empty state), `client/src/pages/AccountDetailPage.test.tsx` (hero + filtered register, not-found, and since PR 11 the back link, Not available/in transit/pending lines, months, struck rows and their (i), In jars, routes, Account details, phone layout), `client/src/pages/AccountDetailPage.catalog.test.tsx` (ACCT-044 to ACCT-049, ACCT-051), `tests/AllotJar.Application.Tests/Application/AccountsTests.cs` (derivation, owner-scoping, order, delete-unlink), `tests/AllotJar.Application.Tests/Application/AccountReconciliationTests.cs` (backed total/float, unbacked account). InMemory provider — FK enforcement gaps are covered separately by `tests/AllotJar.IntegrationTests/` (add a case there for any new enforced-FK writer).

## 8. File index (read for this map)

Backend:
- `src/AllotJar.Api/Controllers/AccountsController.cs`
- `src/AllotJar.Api/Controllers/TransactionsController.cs` (transfer endpoint, lines 59-71, 148-154)
- `src/AllotJar.Api/Features/FeatureFlags.cs`, `src/AllotJar.Api/Features/FeatureGateAttribute.cs`
- `src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs`
- `src/AllotJar.Application/Accounts/AccountBalances.cs`
- `src/AllotJar.Application/Accounts/Commands/CreateAccount/{CreateAccountCommand,CreateAccountCommandHandler,CreateAccountCommandValidator}.cs`
- `src/AllotJar.Application/Accounts/Commands/UpdateAccount/{UpdateAccountCommand,UpdateAccountCommandHandler,UpdateAccountCommandValidator}.cs`
- `src/AllotJar.Application/Accounts/Commands/DeleteAccount/{DeleteAccountCommand,DeleteAccountCommandHandler}.cs`
- `src/AllotJar.Application/Accounts/Dtos/{AccountDto,AccountReconciliationDto}.cs`
- `src/AllotJar.Application/Accounts/Queries/GetAccounts/{GetAccountsQuery,GetAccountsQueryHandler}.cs`
- `src/AllotJar.Application/Accounts/Queries/GetAccountReconciliation/{GetAccountReconciliationQuery,GetAccountReconciliationQueryHandler}.cs`
- `src/AllotJar.Application/Transactions/Commands/CreateTransfer/{CreateTransferCommand,CreateTransferCommandHandler,CreateTransferCommandValidator}.cs`
- `src/AllotJar.Application/Jars/JarBalances.cs`, `src/AllotJar.Application/Jars/JarAccounts.cs` (budget-currency check for a jar's account)
- `src/AllotJar.Application/Budgets/BudgetCurrency.cs` (the household's one budget currency; W08)
- `src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs`
- `src/AllotJar.Application/Common/Interfaces/ICurrentUser.cs`
- `src/AllotJar.Domain/Entities/Account.cs`
- `src/AllotJar.Domain/ValueObjects/CurrencyCode.cs`
- `src/AllotJar.Infrastructure/Persistence/Configurations/AccountConfiguration.cs`

Frontend:
- `client/src/App.tsx` (routes)
- `client/src/components/AppNav.tsx` (nav gating)
- `client/src/pages/AccountsPage.tsx`
- `client/src/pages/AccountDetailPage.tsx`
- `client/src/components/accounts/AccountParts.tsx`, `client/src/lib/accountJars.ts` (shared with AccountsPage)
- `client/src/pages/AccountPage.tsx` (profile page — out of scope, disambiguated)
- `client/src/pages/TransactionsPage.tsx` (transfer form, partial)
- `client/src/pages/JarsPage.tsx` ("Held in" funding-account select, partial)
- `client/src/features/FeatureContext.tsx`
- `client/src/auth/AuthContext.tsx` (canWrite/budgetCurrency, partial)
- `client/src/lib/money.ts`
- `client/src/lib/categoryColors.ts` (hueForAccountType, partial)
- `client/src/types.ts` (AccountType/labels/AccountDto, partial)
- `client/src/analytics/events.ts` (account_created / account_edited / transfer_created)

Tests:
- `client/src/pages/AccountsPage.test.tsx`, `client/src/pages/AccountDetailPage.test.tsx`, `client/src/pages/AccountDetailPage.catalog.test.tsx`
- `client/src/pages/AccountsPage.catalog.test.tsx` (ACCT-005 other-currency account left out of totals; ACCT-018 no currency picker, POST uses the budget currency; ACCT-019 chip only on an other-currency account when `multiCurrency` is off)
- `tests/AllotJar.Application.Tests/Application/AccountsTests.cs`, `tests/AllotJar.Application.Tests/Application/AccountReconciliationTests.cs`
- `tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs` (`A_new_account_must_be_in_the_budget_currency`, `A_jar_cannot_live_in_an_account_kept_in_another_currency`, `A_waiting_row_on_an_account_kept_in_another_currency_counts_its_confirmed_figure_and_the_balance_stays`, `A_statement_imported_onto_an_account_kept_in_another_currency_waits_and_can_be_confirmed`)

Memory notes consulted (verified against code): `<local>\.claude\projects\C--Users-Laptop-Documents-Projects\memory\months-accounts-coherence-audit-2026-07.md`
