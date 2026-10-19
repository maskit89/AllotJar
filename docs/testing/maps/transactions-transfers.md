# Subsystem map: Transactions, splits, auto-categorization, transfers

Ground-truth feature inventory for QA test design. All facts verified against the working tree at
`<local>\Documents\Projects\ZeroBudget` on 2026-07-15 (post PR #167/#168/#169/#170/#171/#172 merges).
Repo paths below are relative to that root unless absolute.

---

## 1. Screens & routes

### Client routes (React Router, `client/src/App.tsx`)
| Route | Component | Guard / gating |
|---|---|---|
| `/transactions` | `TransactionsPage` | `RequireAuth` (App.tsx:82-89). Not feature-flag gated — always registered. |
| `/accounts/:id` | `AccountDetailPage` | `RequireAuth` + `features.accounts` flag (App.tsx:100-109). Shows the per-account register incl. signed transfer rows ("To/From {account}"). |
| `/import` | `ImportPage` | `RequireAuth` + `features.camtImport` (App.tsx:161-170). Adjacent subsystem; reached via the **Import** nav item (`client/src/components/navItems.ts`), not from this page. |

- `RequireAuth` (App.tsx:38-48): shows `AuthSplash` while `bootstrapping`, renders children when authenticated, otherwise redirects to `/login?returnUrl=<encoded current path+search>`.
- Nav: "Transactions" link in `AppNav` is ALWAYS shown (`show: true`, client/src/components/AppNav.tsx:33), regardless of role or flags.
- `AppShell` banner for restricted roles (client/src/components/AppShell.tsx:165-169):
  - Read-only: "Read-only access: you can view everything, not change it." (the full explanation behind its (i) "About your access")
  - Limited: "Limited access: you can record transactions, mark bills paid and run allocation." (what an admin keeps behind its (i) "About your access")
- Page data load (TransactionsPage.tsx:78-99): parallel `GET /transactions` (unfiltered — ALL months), `GET /budget/current` (for assign options + base currency; failure tolerated → null), `GET /accounts`, `GET /members` (failures tolerated → empty arrays). Only the transactions call failing sets the page error "Could not load transactions."
- The app-wide viewed month (`useMonth()` from MonthContext) supplies only the hero LABEL (`monthLabel`, e.g. "July 2026"). The register does NOT refetch or filter when the viewed month changes — the list and the hero totals always span all transactions ever, while the hero eyebrow reads "Money in · {monthLabel}" (TransactionsPage.tsx:355-399). Known label/data mismatch to probe in QA.

---

## 2. UI controls & user actions (exact visible labels)

### Toolbar (TransactionsPage.tsx:639-676)
- Segmented control "Filter transactions": **All** | **Unassigned** (client-side filter only).
- Count text: "{n} transactions" — counts ALL loaded transactions, not the filtered subset.
- No Import link on this page: Import is a nav item (`navItems.ts`, shown only when `features.camtImport && canWrite`, Admin+); the empty state's copy names it.
- **+ Add transaction** button (aria-label "Add transaction"); shown only when `canEnterData` (Limited+). Opens the add modal in "transaction" mode with error cleared.

### Add modal (TransactionsPage.tsx:403-633)
- Title: "Add a transaction" or "Record a transfer" (per mode).
- Segmented control "Entry type": **Transaction** | **Transfer** — rendered ONLY when `accounts.length >= 2`. With 0–1 accounts there is no way to open the transfer form.
- Transaction form fields (labels): **Type** (select: Expense / Income — no Transfer option), **Date** (date input, default = today via `new Date().toISOString().slice(0,10)` — UTC date, may be "yesterday" late-evening in UTC+ zones), **Payee** (placeholder "e.g. Tesco"), **Amount** (text, `inputMode=decimal`, placeholder "0.00", Enter submits), **Account** (select, "No account" default; only rendered when `accounts.length > 0`), **Category** (select "Unassigned" + optgroups; ONLY rendered when Type = Expense — income adds are always unassigned from the form; note the optgroups are UNFILTERED `buildItemOptions(month)` and include Income and Savings groups), **Member** (select "No member"; only when `members.length >= 2` — hidden for solo households). Buttons: **Cancel**, **Add transaction**.
- **"Paid in another currency"** (W08; rendered only when `features.multiCurrency`): a checkbox that reveals **Currency** (text, aria "Currency paid in", placeholder "USD", max 3, upper-cased), **Amount paid** (aria "Amount paid in that currency") and a **Suggest** button ("Suggesting…"). Helper `role="status"`: "The Amount above is what counts, in {budgetCurrency}. Suggest fills it in for you to check." — after Suggest it shows the suggestion hint instead (see Enter amount below). Suggest fills **Amount** with `suggestedAmount` (still editable) and saves nothing. The **Amount** field stays the budget-currency figure that counts; on save the POST adds `originalAmount`/`originalCurrency`. Client guards (ErrorBanner): "Enter the three-letter code of the currency you paid in, like USD." / "{X} is your budget currency. Untick “Paid in another currency”." / "Enter the amount you paid in {code}, greater than zero.". Unticking clears the foreign fields.
  - On success: prepends the row, tracks `transaction_added` (param `line_type`: income/expense), clears payee+amount (keeps date/type/account/member), closes modal.
- Transfer form fields: **Date**, **Amount** (Enter submits), **From** (select "Choose…"), **To** (select "Choose…"), **Note** (text, placeholder "Transfer"). Buttons: **Cancel**, **Record transfer**. On success prepends row, tracks `transfer_created`, clears amount+note, closes modal.

### Register table (TransactionsPage.tsx:685-1084)
Columns: Date · Payee · Category · Account · Amount · (actions). `min-w-[720px]`, horizontal scroll inside the card.
- Date: `shortDate(t.date)`.
- Payee: payee text, or "Transfer" for a payee-less transfer, or "—". A **Bill** tag (uppercase pill) appears when the assigned line has a `dueDay` in the current month (`billItemIds`, TransactionsPage.tsx:360-364).
- Category cell, in priority order:
  - Transfer → `Badge tone="brand"` **Transfer** (no assign affordance at all).
  - Split → `Badge tone="violet"` **Split** + slice summary text: `{lineName ?? 'Unassigned'}{ (MemberName)} {money}` joined by " · ".
  - Row in assigning state (`assigningId`) and `canEnterData` → autofocus select "Unassigned" + ALL lines (unfiltered optgroups — income tx can be pointed at expense lines and vice versa; server accepts, see §7). The select is a `CommitSelect` (`client/src/components/CommitSelect.tsx`, #350 P3-1): a pointer choice saves via assign; the keyboard can arrow through the options without saving (Chrome fires `change` on each arrow of a closed select), and Enter or blur saves the option it rests on; Escape cancels; blur with the value unchanged closes with no call.
  - Assigned → colour-dot tint pill with the line name; clicking it (aria "Reassign {payee}") reopens the picker (button only when `canEnterData`, otherwise static span).
  - Unassigned → dashed **+ Assign** pill (aria "Assign {payee}") when `canEnterData`, else plain text "Unassigned".
- Account cell: transfer rows show "{from} → {to}" with `—` for a missing name; ordinary rows show account name or "—".
- Amount cell: income `+{money}` (brand green), expense `−{money}` (ink), transfer unsigned grey. Formatted from `t.amount` in `t.currency`. A row **waiting for its budget-currency amount** (`t.fxPending`, W08) instead shows its own figure as plain "{CODE} {number}" (`formatForeign`, e.g. "USD 12.50", so it never reads as budget money), the amber tag **"Needs {budgetCurrency} amount"** (title "In another currency. Not counted anywhere until you enter the amount in {X}.") and — only when `canEnterData` and the row is not split (a row on an account gets it too since the "Support them" follow-up) — an **Enter amount** button (aria "Enter amount in {X}: {payee || date}"). A confirmed row with `originalAmount`/`originalCurrency` shows the foreign figure as a small grey caption under the amount (title "Paid in {code}"). A counted row with `budgetAmount` (a row on a legacy account kept in another currency) shows its own amount in its own currency (e.g. "−£12.50") with a grey caption **"Counts as {€X}"** (title "The account keeps its {CODE} amount; the budget counts this"); the account register (`AccountDetailPage`) shows the same captions (there: "Counts as {€X} in the budget") and the same tag, its explanation behind an (i) after it instead of a title, but no Enter amount button.
- **Enter amount modal** (`client/src/components/ConvertedAmountModal.tsx`, a sheet dialog since restyle PR 18): title "Amount in {X}"; one line "{payee} was {CODE amount} on {date}."; behind the title's (i) "About the amount": "Enter what it cost in {X}. It isn’t counted anywhere until you save it." plus, for a row on an account, " {accountName ?? 'Its account'} keeps its {CODE} amount; the budget counts yours." and what Suggest does; the amount field (`.dlg-in`, the currency sign joined to the figure) labelled "Amount in {X}", aria "Amount in {X}" (Enter confirms; a second Enter while the save is in flight is ignored); the quiet **Suggest** beside it ("Suggesting…") calls `GET /transactions/conversion-suggestion` and fills the input (editable) — hint "Suggested from the European Central Bank reference rate: 1 {CODE} = {rate} {X}. Check it matches what you paid." or, with no rate, "No suggestion is available for {CODE} on this date. Enter the amount in {X} yourself."; footer **Cancel** and the one primary **Save** ("Saving…", disabled while the input is blank) → `PUT /transactions/{id}/converted-amount`, replaces the row and reloads jar ledgers. Client guard: "Enter the amount in {X}, greater than zero."; server refusals are shown in the modal's ErrorBanner (fallback "Could not save that amount.").
- Row hover actions (visible on hover/focus, only when `canEnterData`):
  - **✎** "Edit transaction" — NOT rendered for transfers.
  - **⑂** "Split across budget lines" — NOT rendered for transfers (income and expense both splittable).
  - **✕** "Delete transaction" — rendered for ALL rows including transfers (no confirmation dialog; deletes immediately).
- Inline edit row (replaces the row, TransactionsPage.tsx:718-791): date, payee, amount, type select (Expense/Income only), account select ("No account", when accounts exist), member select ("No member", when `members.length >= 2`). Buttons **Save** / **Cancel**. Starting an edit closes any open split editor and vice versa.
- Inline split editor (violet row under the transaction, TransactionsPage.tsx:952-1077):
  - Header: `Split “{payee || date}” ({total})` + remainder chip: **"Fully allocated"** (emerald) or **"{money} left"** (rose; can go negative).
  - Warning when no candidate lines: "Add some income budget lines first." / "Add some expense budget lines first."
  - Per row: category select "Choose a line…" (options FILTERED by tx type via `buildItemOptions(month, t.type)`: income tx → Income groups only; expense tx → Expense AND Savings groups — a savings line is drawn down by expenses), amount input (placeholder "0,00"), member select ("No member", only when `members.length >= 2`), **✕** remove-line button (only when > 2 rows).
  - Buttons: **+ Add line**, **Remove split** (only when the tx is already split; clears via assign-null), **Save split** (disabled while saving or while `remainderMinor !== 0`), **Cancel**.
  - Opening the editor on an already-split tx pre-fills its slices; on a whole tx it seeds 2 rows (first inherits current line/member).
- Empty states:
  - No transactions at all: EmptyState icon + "No transactions yet" / "Use + Add transaction to record one, or Import a bank statement."
  - Filter yields nothing: table row "Nothing left to assign." (Unassigned filter) or "No transactions yet." (All).
- Loading: "Loading…" text. Errors render in an `ErrorBanner` above the table (or inside the modal while it's open).

### Hero (TransactionsPage.tsx:388-399)
- Eyebrow "Money in · {monthLabel}"; amount `+{money-in}`; tiles: **Money out** {money}, **Unassigned** — "All assigned" or "{n} to assign".
- Money in = sum of ALL Income tx; Money out = sum of ALL Expense tx; transfers excluded from both. Unassigned count = non-transfer, non-split, `budgetItemId === null` (TransactionsPage.tsx:340-354).

### AccountDetailPage register (client/src/pages/AccountDetailPage.tsx)
- Rows = transactions where `accountId === id || transferAccountId === id` (line 76-79).
- Transfer rows are SIGNED by direction: `−` when this account is the source (`t.accountId === id`), `+` when destination (`[data-tx-amount]`). Since the restyle (PR 11) the route `[data-tx-route]` names only the other account, after an arrow: "To {other}" on the source's page, "From {other}" on the destination's, with **"(removed account)"** for a null name. Status chips In transit / Returned / Pending review; a Returned transfer is struck through (it never moved the balance), and so is a row dated before the account's opening date (with "Before opening" and its (i)).
- Rows are list items (`data-testid="tx-row"`) grouped by month, sorted by the date this account posts the row.
- Empty state: "No transactions on this account yet."; missing account: "Account not found" / "It may have been deleted. Head back to your accounts."

### Analytics events (client/src/analytics/events.ts:29-34)
`transaction_added`, `transaction_edited`, `transaction_deleted`, `transfer_created`, `transactions_filtered`.

---

## 3. API endpoints

Controller: `src/AllotJar.Api/Controllers/TransactionsController.cs` — `[ApiController] [Authorize] Route("api/[controller]")` → base `/api/transactions`. JWT bearer required on all. No feature-flag gating server-side.

Role gating happens in the MediatR `AuthorizationBehaviour` (src/AllotJar.Application/Common/Behaviours/AuthorizationBehaviour.cs): Queries allowed for every role incl. ReadOnly; Commands require Admin+ unless `[AllowLimited]`. **All transaction commands (Create, CreateTransfer, UpdateTransfer, Update, Delete, Split, Assign) are `[AllowLimited]`** → Owner/Admin/Limited allowed, ReadOnly → 403 "Your access level (ReadOnly) does not permit this action." When no role resolves (no membership), enforcement is skipped and OwnerId scoping in handlers protects data.

| Verb & route | Body / query | Success | Notes |
|---|---|---|---|
| `GET /api/transactions` | `?year=&month=&unassignedOnly=` (all optional) | 200 `TransactionDto[]` | Year and month filters are INDEPENDENT — `month=7` alone matches July of every year (GetTransactionsQueryHandler.cs:39-46). `unassignedOnly=true` filters `BudgetItemId == null`, which INCLUDES transfers and split parents (both carry null BudgetItemId) — different semantics from the UI's client-side Unassigned filter. Order: Date desc, then Id desc. |
| `POST /api/transactions` | `CreateTransactionRequest { date, payee, amount, type, budgetItemId?, accountId?, memberId?, …, originalAmount?, originalCurrency? }` | 201 + `TransactionDto` (Location → list) | Manual entry. `type` must be Expense(0) or Income(1) — Transfer(2) rejected by validator. Currency = the household's **budget currency** (`BudgetCurrency.ResolveAsync`: earliest month's `BaseCurrency`, else owner's `PreferredCurrency`, else EUR — W08), whatever the tx date. `originalAmount`/`originalCurrency` (both or neither) keep what was paid abroad for reference only; `amount` is what counts. Validator: "Choose the currency that was paid." / "Currency must be a 3-letter ISO 4217 code." / "Enter the amount that was paid in that currency." / "Enter an amount greater than zero."; handler refuses an `originalCurrency` equal to the budget currency: `OriginalCurrency` → "The budget is in {X} already; leave the other currency empty." If `budgetItemId` is null, AutoCategorizer runs (payee inheritance). Payee is trimmed. |
| `GET /api/transactions/conversion-suggestion` | `?currency=&amount=&date=` | 200 `ConversionSuggestionDto { currency, amount, budgetCurrency, date, rate, suggestedAmount, source }` | W08. Read-only: ECB reference rate via Frankfurter (`IExchangeRateProvider`) for that date, `suggestedAmount = round(amount × rate, 2, half away from zero)`, `source` "European Central Bank reference rate". No rate (provider down/unknown) → `rate`/`suggestedAmount` null. 400: bad code "Currency must be a 3-letter ISO 4217 code."; amount ≤ 0 "Enter an amount greater than zero."; code = budget currency "The budget is in {X} already; there is nothing to convert."; a date after today (UTC) → `Date` "There is no reference rate for a future date yet. Enter the amount yourself." (the provider is not asked). Saves nothing. |
| `PUT /api/transactions/{id:guid}/converted-amount` | `{ amount }` | 200 + `TransactionDto` | W08, `[AllowLimited]`. Gives a waiting (`FxPending`) row its budget-currency amount. A row on **no account** is restated: `OriginalAmount/OriginalCurrency` ← the foreign figure, `Amount` ← confirmed amount, `Currency` ← budget currency. A row on **an account** (only a legacy account kept in another currency, or a foreign row on a budget-currency account from before #210, can hold one) keeps `Amount`/`Currency` — the account's money — and the confirmed amount is stored as `BudgetAmount` (Christopher's "Support them", 29 Sep 2026). Either way `FxPending` ← false and from then on it counts. 400 (key `Amount`): "Enter an amount greater than zero." / "Amount exceeds the supported range."; not waiting → "This transaction already counts in the budget currency. Edit its amount instead."; split → "This transaction is split. Remove the split, enter the amount, then split it again."; a refund must still fit its purchase (RefundRules, key `RefundOfTransactionId`; a refund of a purchase that still waits → "The purchase this refunds is in {CODE} and is waiting for its amount in the budget currency. Enter the purchase's amount first."), a purchase can't drop below what's refunded against it ("This purchase has {n} refunded against it; its amount can't be less than that."). 403 other household; 404 unknown id. No fee or rate is stored or inferred. |
| `POST /api/transactions/transfer` | `CreateTransferRequest { date, amount, fromAccountId, toAccountId, payee?, fee?, feeBudgetItemId?, acknowledgeCrossMonth? }` (W07 added the last three) | 201 + `TransactionDto` | The ONLY way to create Type=Transfer. `amount` is what arrives; a `fee` also leaves the source on the departure date as a separate expense row on `feeBudgetItemId` (source debited amount + fee). Single signed row: `AccountId` = source, `TransferAccountId` = destination. Payee defaults to "Transfer" when blank. Currency stamped from the SOURCE account (both must match). Excluded from budget actuals. |
| `PUT /api/transactions/{id:guid}/transfer` | `UpdateTransferRequest { fromAccountId, toAccountId, amount, departedOn?, receivedOn?, returnedOn?, payee?, fee?, feeBudgetItemId?, acknowledgeCrossMonth?, fromJarId?, jarAllocations? }` (W07) | 200 + `TransactionDto` | Edits a transfer **in place**; every field replaces what was stored (a jar answer left out returns that leg to its default). A leg confirmed by a bank statement (it carries that bank's reference) keeps the bank's account, date and amount: departure = source account, departure date, `amount + fee`; receipt = destination account, receipt date, `amount`; a statement-confirmed return keeps its date. `returnedOn` marks the money as sent back to the source on that date: nothing stays in transit, status `Returned`, the destination receives nothing. `fee` creates/updates/removes the fee row (null or 0 removes it). Rule 74 is re-checked on every account the edit touches. Non-transfer id → 400 "Only a transfer can be edited here." |
| `PUT /api/transactions/{id:guid}` | `UpdateTransactionRequest { date, payee, amount, type, accountId?, memberId? }` | 200 + `TransactionDto` | Edits core fields + account + member (null clears). Budget-line assignment and currency untouched. Editing the amount of a waiting (`FxPending`) row corrects its foreign figure and it **keeps waiting** (W08 — the old "amount edit clears the pending flag" behaviour is gone). Editing the **amount** of a row with a `BudgetAmount` clears it and sets `FxPending` (the figure was for the old amount); any other edit keeps it. Refund fit (rules 38/39) is checked only when an edit makes a refund count more than before (`RefundRules.ValidateOriginalAsync` `previousAmount`) and a purchase only when it is lowered below its refunds, so a rename or recategorisation of a restated pair whose refund exceeds its purchase is accepted. Type=Transfer rejected; on any (non-transfer) update the handler nulls `TransferAccount(Id)` so editing a stored transfer row via API turns it into a clean income/expense with no phantom counterparty credit (UpdateTransactionCommandHandler.cs:77-85). |
| `DELETE /api/transactions/{id:guid}` | — | 204 | Hard delete; splits cascade (FK Cascade). Works on transfers too (a transfer's fee row goes with it). A **fee row** cannot be deleted directly (see fee rule below). |
| `PUT /api/transactions/{id:guid}/splits` | `SplitTransactionRequest { allocations: [{ budgetItemId, amount, memberId? }] }` | 200 + `TransactionDto` | Replaces any prior split AND clears the whole-transaction assignment. Slices must sum exactly to `Amount`; every target line's category kind must match the tx direction; per-slice member must be owned. Null `allocations` treated as empty list (→ validator "at least two lines"). |
| `PUT /api/transactions/{id:guid}/assignment` | `{ budgetItemId }` (null clears) | 200 + `TransactionDto` | Assign/clear the whole tx to a budget line. Deletes any existing split first. **No kind-matching validation** (unlike splits) and **no Type check** — a transfer or an income tx can be assigned to an expense line via API; actuals then ignore the mismatched attribution (see §6). |

**Transfer fee rows (W07):** a fee is an ordinary `Type=Expense` row on the source account (`FeeForTransferId` set, payee "Fee: {transfer payee}", dated the departure, on the chosen budget line or uncategorised). It is changed only through its transfer: direct `PUT /api/transactions/{id}`, `PUT …/splits` and `DELETE` on a fee row are refused with 400 "This is a transfer's fee. Edit the transfer to change or remove it." Re-typing the transfer away from Transfer via `PUT /api/transactions/{id}` removes its fee. The fee counts in budgets and reports like any payment. `TransactionDto` carries `returnedOn`, `fee`, `feeBudgetItemId`, `feeBudgetItemName` (on the transfer) and `feeForTransferId` (on the fee row).

Errors surface via `ExceptionHandlingMiddleware` (src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs): ValidationException → 400 `{status, title:"Validation failed", errors:{Field:[msgs]}}`; NotFoundException → 404 `{status, title:"<message>"}`; ForbiddenAccessException → 403; unhandled → 500 "An unexpected error occurred.".

Ownership scoping: every handler resolves `ICurrentUser.OwnerId` (the ACTIVE household's owner id — a login acting in another household writes into that household) and 403s cross-owner referents (transaction, budget item, account, member) after 404-ing missing ones. Cross-owner ids on existing rows → 403 (not 404) — enumeration reveals existence.

---

## 4. Validation rules & exact error messages

### Server (FluentValidation, run in ValidationBehaviour before handler)
CreateTransactionCommandValidator:
- Amount > 0: "Enter an amount greater than zero."
- Amount ≤ 99_999_999_999_999.9999: "Amount exceeds the supported range."
- Payee max length 200 (default FluentValidation message).
- Type in enum AND ≠ Transfer: "Use the transfer action to move money between accounts."

UpdateTransactionCommandValidator: identical rules + TransactionId NotEmpty.

CreateTransferCommandValidator:
- Amount > 0: "A transfer amount must be greater than zero."
- Amount ≤ max: "Transfer amount is out of range."
- FromAccountId / ToAccountId NotEmpty (default messages).
- ToAccountId ≠ FromAccountId: "Choose two different accounts for a transfer."
- Payee max length 200.

CreateTransferCommandValidator, fee rules (W07): Fee ≥ 0 "A fee can't be negative."; Fee ≤ max "Fee is out of range."; `FeeBudgetItemId` only with a fee > 0 "Choose a line for the fee only when there is a fee."

UpdateTransferCommandValidator (W07): same amount/account/payee/fee rules as create, plus: a departure date or a receipt date is required "A transfer needs its departure date, its receipt date, or both."; `returnedOn` needs a departure date and must not be before it "A transfer can only come back on or after the day it left."; `returnedOn` with a receipt date "A transfer that was received can't also have been sent back. Clear the receipt date first."

UpdateTransferCommandHandler (W07, ValidationException): a statement-confirmed leg changed → "The {departure|receipt|return} is confirmed by a bank statement, so it keeps the bank's {account it left|account it reached|date (…)|amount (…)}."; receipt before departure on a manual edit → "The receipt date can't be before the departure date."; a fee without a departure date → "Add the departure date before recording a fee: the fee leaves the account when the money does."; cross-currency as on create.

CreateTransferCommandHandler (handler-level ValidationException, key `ToAccountId`):
- Differing account currencies: "Both accounts must use the same currency to transfer between them." (PR #167; `CurrencyCode` is a record so `!=` is value equality.)

SplitTransactionCommandValidator:
- TransactionId NotEmpty.
- Allocations not null, Count ≥ 2: "A split needs at least two lines."
- Per allocation: BudgetItemId NotEmpty: "Choose a budget line for every split line."; Amount > 0: "Each split line needs an amount greater than zero."; ≤ max: "Amount exceeds the supported range."

SplitTransactionCommandHandler (ValidationException key `Allocations`):
- Sum mismatch: "The split lines must add up to {total:0.####}; they add up to {allocated:0.####}."
- Kind mismatch: "Income can only be split across income lines." / "An expense can only be split across expense lines."
  (Kind check: line's category `Kind == Income` must equal `tx.Type == Income`; note Savings-kind lines count as non-income, so an expense may split into Savings lines but income may not.)

AssignTransactionCommandValidator: TransactionId NotEmpty only. **No kind/type/sum rules.**

NotFound messages (404): "Transaction {id} was not found." / "Budget item {id} was not found." / "Account {id} was not found." / "Household member {id} was not found."
Forbidden (403): parameterless (empty message) for cross-owner referents; "No authenticated user on the request." when OwnerId missing; "Your access level ({role}) does not permit this action." from the role gate.

### Client (TransactionsPage.tsx, pre-submit + catch-all)
- Add: "Enter a valid amount greater than zero." (parseMinor null/≤0); catch: "Could not add that transaction."
- Transfer: "Enter a valid transfer amount greater than zero."; "Choose both a source and a destination account."; "A transfer needs two different accounts."; catch: "Could not record that transfer."
- Edit: "Enter a valid amount greater than zero."; catch: "Could not save that change."
- Assign catch: "Could not save that assignment."
- Delete catch: "Could not delete that transaction."
- Split: "Give every split line a category and an amount greater than zero." (any row missing line or amount ≤ 0, or < 2 rows); "The split lines must add up to the transaction total." (integer-minor comparison — belt-and-braces since Save is disabled unless remainder = 0); catch: "Could not save that split."
- Page load catch: "Could not load transactions."
- The client NEVER surfaces server validation text — every API failure maps to the generic strings above.

Amount parsing (`parseMinor`, client/src/lib/money.ts:264-299): accepts "." or "," decimal; strips spaces/apostrophes; when both "," and "." present the right-most is the decimal sep, the other stripped as grouping ("2.500,00" and "1,234.56" both work); "1.2.3" / "1,2,3" / negatives / empty → null; > 4 dp rounds HALF-UP on the 5th digit. All client money math is integer minor units at scale 4 (matches decimal(18,4)).

---

## 5. State variants

- **Loading**: "Loading…"; hero renders immediately with zero totals.
- **Error**: `ErrorBanner` above the table; when the add modal is open the banner renders inside the modal instead (`error && !showAdd` gate at TransactionsPage.tsx:401).
- **Empty register**: EmptyState "No transactions yet" (see §2). With rows but empty filter result: in-table message.
- **Solo vs shared household**: Member selects (add, edit, split rows) appear only when `members.length >= 2`. `MemberId`/slice member features fully hidden solo. (People nav is a different subsystem.)
- **0–1 accounts**: transfer mode unreachable in the UI (segmented control hidden); Account select hidden at 0 accounts. API transfer still callable.
- **Roles**: ReadOnly — no add button, no hover actions, no assign pickers (static pill/"Unassigned" text), read-only banner; all commands 403 server-side. Limited — full day-to-day entry on this page, but no Import nav item (Admin+). Owner/Admin — everything.
- **Feature flags off** (server `/features`, client defaults ALL-ON until loaded — FeatureContext.tsx): `camtImport` off hides the Import nav item + `/import` route; `accounts` off hides accounts routes/nav but the TransactionsPage still fetches `/accounts` and shows the Account select and transfer mode if accounts exist (not flag-gated on this page).
- **Deleted/archived referents**:
  - Deleted budget line → `Transaction.BudgetItemId` FK SetNull; whole tx becomes Unassigned; split slice's `BudgetItemId` SetNull → slice renders "Unassigned" in the summary (TransactionSplitConfiguration.cs:23-28).
  - Deleted account → `AccountId` explicitly nulled + `TransferAccountId` nulled by DeleteAccountCommandHandler (transactions/transfer rows SURVIVE; balances of remaining accounts keep the other leg). Register shows "—" (TransactionsPage) / "(removed account)" (AccountDetailPage).
  - Members are soft-archived, not deleted; FKs SetNull as a backstop.
- **Split tx**: parent `BudgetItemId` null; UI shows Split badge, no assign picker; edit (✎) still available (core fields only — editing does not touch slices; slice sum can then diverge from an edited Amount, see §7).
- **Transfer tx**: no edit/split affordances; delete only. Category = Transfer badge. Hero excludes it from money in/out and unassigned count.
- **No current-month budget** (`/budget/current` fails/absent): assign/split pickers have no options ("Add some … budget lines first." in split editor; assign select offers only "Unassigned"); Bill tags and pill hues absent; hero currency falls back to the household's `budgetCurrency` (W08; was 'EUR').

---

## 6. Computed/derived values & money rules

- **Wire format**: JSON decimal `amount` (≤ 4 dp); client converts via `fromAmount(x) = Math.round(x*10000)` / `toAmount(m) = m/10000` and does integer math only. Server stores decimal(18,4). **There is no exchange rate** (W08 dropped `ExchangeRate` and `BaseAmount`; migration `ForeignAmounts`). New nullable `OriginalAmount decimal(18,4)` / `OriginalCurrency nvarchar(3)` keep a foreign figure for reference only — never counted. New nullable `Transaction.BudgetAmount` / `TransactionSplit.BudgetAmount` decimal(18,4): a row's figure in the budget currency when its `Amount` is an account's other currency; set only by the migration or by Enter amount, never from a rate. Splitting such a row shares the figure over the slices in proportion to their amounts (4 dp, largest slice takes the rounding — `ForeignAmounts.ShareOverSlices`).
- **One budget currency** (rule 85, `src/AllotJar.Application/Budgets/BudgetCurrency.cs`): every counted row is in it, except a row on a legacy account kept in another currency, whose `Amount` stays the account's money and whose budget figure is `BudgetAmount`. A row in another currency (an import row, never a manual entry or a transfer) is marked `FxPending` by `ForeignAmounts.MarkWaiting` and counts in **no** figure — budget lines, reports, People, jars, refunds, the Transactions hero — until the user confirms its budget-currency amount (`ConfirmConvertedAmount`). The app never converts on its own: Suggest only proposes (`ForeignAmounts.SuggestAsync`), no background job reconciles (the old `FxRateResolver`/`FxReconciliationService` are deleted), no fee is inferred.
- **Manual-create currency**: always the budget currency (CreateTransactionCommandHandler; `ForeignAmountsTests.A_manual_entry_paid_abroad_counts_the_confirmed_amount_and_keeps_what_was_paid`).
- **Budget actuals** (`src/AllotJar.Application/Budgets/BudgetActuals.cs`) — read-time, never stored:
  - Whole tx: grouped by (BudgetItemId, Type), summed as `BudgetAmount ?? Amount` (reports, People and refund figures read the same); `FxPending` rows (and slices of an `FxPending` parent) are excluded and counted in `FxPendingCount`.
  - Each line counts ONLY its own kind: income lines ← Income tx; expense AND savings lines ← Expense tx. So a mismatched whole-assignment (possible via the assign API or the unfiltered UI picker) contributes **0** — the pill shows but the money never lands. Transfers likewise contribute 0 even if force-assigned.
  - Split slices: joined to the parent for Type (and its `FxPending` flag); parent has `BudgetItemId = null` so no double counting; slice sums (`BudgetAmount ?? Amount`) land on each target line.
  - Savings rolling balance (`SavingsAvailable`): per `SavingsId`, Σ PlannedAmount − Σ expense actuals (whole + slices) across all months ≤ viewed month.
- **Account balances** (`src/AllotJar.Application/Accounts/AccountBalances.cs`) — read-time:
  `CurrentBalance = OpeningBalance + Σincome − Σexpense − ΣtransferOut(AccountId=me) + ΣtransferIn(TransferAccountId=me)`, in the account's own currency, raw `Amount` (never `BudgetAmount`, so confirming a row on an account never moves it). Splits don't affect it — the whole amount counts against the linked account.
- **Transfer status (W07)**: a transfer is `InTransit`, complete, `PendingReview` (receipt known, departure not) or `Returned` (`returnedOn` set: it left and came back to the source, never reached the destination). A returned transfer nets to zero on both accounts once `returnedOn` passes; nothing stays in transit. With a fee the source is debited `amount + fee` on the departure date and the destination credited `amount`.
- **Allocation transfers (W07)**: keep their key (`alloc:{y}-{m}:{member}`) in the `AllocationKey` column, no longer in `BankReference` (migration `TransferReturnsFeesAndAllocationKeys` moved existing values), so they are no longer mistaken for bank-referenced legs.
- **Transfer row model**: ONE row, `Type=Transfer(2)`, `AccountId`=source, `TransferAccountId`=destination — not two legs. Excluded from budget actuals and from hero money-in/out. A transfer is never `FxPending` (`ForeignAmountsTests.A_transfer_never_waits`).
- **Hero money in/out** (client): computed over rows with `!fxPending` only — a waiting row counts in neither tile — summing `budgetAmount ?? amount`.
- **AutoCategorizer** (`src/AllotJar.Application/Transactions/AutoCategorizer.cs`): on create-without-line (and statement imports), the tx inherits the `BudgetItemId` of the user's most recent earlier tx (Date desc, Id desc) with the same normalized payee. Normalization: trim, lower-invariant, collapse internal whitespace; blank → never matches. Owner-scoped (never inherits across households). No user-managed rules. Source set = ALL of the user's assigned transactions of any type. The returned DTO carries the inherited line name (handler hydrates the nav after save).
- **Sorting**: register order = server order (Date desc, Id desc); newly added rows are prepended client-side until reload.
- **Display**: row amounts formatted in `t.currency` with the user's number-format preference (`formatMoney`, Intl-based, currency-specific minor digits — JPY has none). Signs: + income / − expense / none (main register) or ± by direction (account detail) for transfers.
- **TransactionDto** (src/AllotJar.Application/Transactions/Dtos/TransactionDto.cs): id, date, payee, amount, currency, fxPending, originalAmount, originalCurrency, budgetAmount, type (number 0/1/2), bankReference, budgetItemId/-Name, accountId/-Name, transferAccountId/-Name, memberId/-Name, isSplit, splits[{id, budgetItemId/-Name, memberId/-Name, amount}].

---

## 7. Known invariants, gotchas & recent-fix regressions

1. **Transfers ONLY via `/transfer` (PR #167, HIGH)**: `POST /api/transactions` and `PUT /api/transactions/{id}` both reject `Type=Transfer` ("Use the transfer action to move money between accounts."). Regression to guard: a bare Type=Transfer row with only AccountId would silently subtract money from derived balances with no destination AND hide it from budget actuals.
2. **Stale counterparty cleared on edit (PR #167)**: `UpdateTransaction` nulls `TransferAccountId` whenever the (always non-transfer) edit lands — else the old destination keeps getting phantom-credited. Pinned by test `Update_ReTypingATransfer_ClearsTheDanglingCounterparty`.
3. **Cross-currency transfer guard (PR #167, LOW)**: differing `Account.Currency` → 400; transfer stamped in `from.Currency` (was hard-coded EUR). Tests: `Transfer_BetweenDifferentCurrencies_IsRejected_AndMovesNothing`, `Transfer_StampsCurrencyFromSource_NotHardcodedEur`.
4. **One budget currency, no automatic conversion (W08, rules 42–44/85)**: ExchangeRate/BaseAmount no longer exist. A row in another currency waits ("Needs {X} amount") and counts nowhere until confirmed; confirming is refused for a row that isn't waiting and a split row; refund fit is checked. A row on an account keeps its amount and counts the confirmed figure as `BudgetAmount` (rows on legacy accounts, "Support them"); changing its amount makes it wait again. Editing a waiting row's amount keeps it waiting. A waiting payment can't mark a jar cycle paid. Tests: `tests/AllotJar.Application.Tests/Transactions/ForeignAmountsTests.cs`, `FxPendingAggregatesTests.cs`, `UpdateTransactionTests.Update_NonAmountEdit_KeepsThePendingFlag`, `RefundTests.Update_CountsARefundByItsConfirmedAmount_AndAWaitingRefundAsNothing`; client `client/src/pages/TransactionsPage.test.tsx` ("TransactionsPage currency conversion (W08)").
5. **Split invariants**: slices sum exactly to `Amount` (decimal-exact server-side, minor-unit-exact client-side); ≥ 2 slices; kind matching (Savings counts as expense-side); saving a split clears `BudgetItemId`; assigning (or clearing) a whole line deletes the slices (`Assign_ClearsAnExistingSplit`). UI "Remove split" = assign(null).
6. **Editing a split parent's Amount does NOT revalidate slices** — `UpdateTransaction` changes `Amount` freely while slices persist, so a split can end up not summing to the (new) total; actuals then roll up the stale slice amounts. No UI/server guard. QA edge case.
7. **Assign endpoint has no kind/type validation** — mismatched or transfer assignments are accepted and silently contribute 0 to actuals (see §6). The main-register assign picker is also unfiltered (`buildItemOptions(month)` with no type at TransactionsPage.tsx:321), and the add-form Category (Expense only) includes Income groups too — only the SPLIT editor filters by type.
8. **`unassignedOnly` (server) ≠ Unassigned (UI)**: server counts transfers and split parents as unassigned (BudgetItemId null); UI excludes both. The UI never sends the param; API-level tests must expect the wider set.
9. **`GET /transactions?month=7` without `year` matches July of EVERY year** (independent filters).
10. **Hero label vs data**: totals cover all-time transactions but the eyebrow names the viewed month (see §1). Also `today()` uses the UTC date.
11. **Delete is immediate and un-confirmed** in the register (contrast: account delete got a confirmation modal in PR #168). Splits cascade away with the parent.
12. **BankReference dedup backstop**: unique filtered index on (OwnerId, BankReference) — manual transactions (null ref) exempt; never change the ref composition (import subsystem, PR #154/#159). Manual create/update never sets BankReference.
13. **FK topology** (TransactionConfiguration.cs): `TransferAccountId` is Restrict (delete-account handler must clear it first — pinned by `DeleteAccount_ClearsTransfersPointingAtIt_AndKeepsTheTransaction`); `AccountId`/`BudgetItemId`/`MemberId` SetNull. CI backend job runs EF InMemory (no FK enforcement) — enforced-FK writer changes need a case in `tests/AllotJar.IntegrationTests/` (real SQL).
14. **Role matrix**: all transaction commands are Limited+; ReadOnly can only GET. The UI mirrors this via `canEnterData` (entry affordances) and `canWrite` (Import link). Household switcher: `ICurrentUser.OwnerId` is the ACTIVE household — same login writes to whichever household is selected; Forbidden (not NotFound) on cross-household ids.
15. **PR #172 interaction**: transactions never mark a month balanced by themselves — `IsBalanced` needs `TotalIncome > 0` (planned income), not income transactions. Income tx assigned to income lines drive "received" actuals only.
16. **Auto-categorizer scope**: applies at CREATE time only (never retro-applies on edit/assign); explicit `budgetItemId` on create suppresses it (`CreateTransaction_RespectsAnExplicitlyChosenLine_OverTheFallback`); shared machinery with import preview suggestions (`BuildSuggestionsAsync`/`NormalizeKey`).
17. **Register pagination: none** — `GET /transactions` returns every row; page renders all. Perf/soak consideration for large accounts.

---

## 8. File index (read for this map)

Server:
- src/AllotJar.Api/Controllers/TransactionsController.cs (routes + request records)
- src/AllotJar.Api/Middleware/ExceptionHandlingMiddleware.cs (error envelope)
- src/AllotJar.Application/Transactions/Commands/CreateTransaction/{Command,Handler,Validator}.cs
- src/AllotJar.Application/Transactions/Commands/CreateTransfer/{Command,Handler,Validator}.cs
- src/AllotJar.Application/Transactions/Commands/UpdateTransaction/{Command,Handler,Validator}.cs
- src/AllotJar.Application/Transactions/Commands/UpdateTransfer/{Command,Handler,Validator}.cs and src/AllotJar.Application/Transactions/TransferFees.cs (W07)
- src/AllotJar.Application/Transactions/Commands/DeleteTransaction/{Command,Handler}.cs
- src/AllotJar.Application/Transactions/Commands/SplitTransaction/{Command,Handler,Validator}.cs
- src/AllotJar.Application/Transactions/Commands/AssignTransaction/{Command,Handler,Validator}.cs
- src/AllotJar.Application/Transactions/Queries/GetTransactions/{Query,Handler}.cs
- src/AllotJar.Application/Transactions/Dtos/TransactionDto.cs (+ mapping)
- src/AllotJar.Application/Transactions/AutoCategorizer.cs
- src/AllotJar.Application/Transactions/ForeignAmounts.cs (MarkWaiting / SuggestAsync; replaced the deleted FxRateResolver)
- src/AllotJar.Application/Transactions/Commands/ConfirmConvertedAmount/{Command,Handler,Validator}.cs
- src/AllotJar.Application/Transactions/Queries/GetConversionSuggestion/{Query,Handler}.cs
- src/AllotJar.Application/Budgets/BudgetCurrency.cs
- src/AllotJar.Application/Budgets/BudgetActuals.cs
- src/AllotJar.Application/Accounts/AccountBalances.cs
- src/AllotJar.Application/Accounts/Commands/DeleteAccount/DeleteAccountCommandHandler.cs
- src/AllotJar.Application/Common/Behaviours/{AuthorizationBehaviour,ValidationBehaviour}.cs
- src/AllotJar.Application/Common/Security/AllowLimitedAttribute.cs
- src/AllotJar.Application/Common/Households/ActiveHouseholdSelector.cs
- src/AllotJar.Domain/Entities/{Transaction,TransactionSplit,BudgetCategory}.cs
- src/AllotJar.Infrastructure/Persistence/Configurations/{TransactionConfiguration,TransactionSplitConfiguration}.cs

Client:
- client/src/pages/TransactionsPage.tsx
- client/src/pages/AccountDetailPage.tsx
- client/src/components/ConvertedAmountModal.tsx, client/src/lib/conversion.ts (W08; `FxPendingTag.tsx` was removed in restyle PR 11)
- client/src/lib/transactions.ts (buildItemOptions, transactionTypeLabel, signedAmountMinorFromAmount)
- client/src/lib/money.ts (minor-unit engine, parseMinor, formatMoney)
- client/src/types.ts (TransactionType = { Expense:0, Income:1, Transfer:2 })
- client/src/App.tsx (routes, RequireAuth)
- client/src/auth/AuthContext.tsx (canEnterData/canWrite/canManageHousehold derivation)
- client/src/features/FeatureContext.tsx (+ MonthContext.tsx label)
- client/src/components/{AppNav.tsx,AppShell.tsx} (nav + role banners)
- client/src/analytics/events.ts

Tests (behavior pins, names scanned):
- tests/AllotJar.Application.Tests/Transactions/{ManualTransactionTests,UpdateTransactionTests,SplitTransactionTests,TransactionHandlersTests,TransfersTests,AutoCategorizationTests,BudgetActualsTests,FxPendingAggregatesTests,ForeignAmountsTests,RefundTests}.cs
- tests/AllotJar.IntegrationTests/ForeignAmountsMigrationTests.cs (W08 "Keep counting" data migration)
- client/src/pages/TransactionsPage.test.tsx ("TransactionsPage currency conversion (W08)"), client/e2e/a11y.spec.ts ("currency conversion (Enter amount + paid in another currency) has no WCAG A/AA violations")

Memory/audit notes:
- <local>\.claude\projects\C--Users-Laptop-Documents-Projects\memory\months-accounts-coherence-audit-2026-07.md (PR #167/#168 invariants — verified against current code above)
