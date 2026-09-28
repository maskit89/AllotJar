# Money movement: account floor, jar prompts, holds and cross-account moves

**ID prefix:** MM | **Scope:** The behaviour added by the money movement slice (rules 74, 78, 79, 80; PR money-movement): the **account never goes below zero** guard on every write that moves money (`Application/Accounts/AccountBalanceGuard.cs`, `Domain/Services/AccountBalanceRules.cs`) — manual create/edit/delete, transfers and leg confirmation, allocation commit, opening-balance edits — and the row-by-row **holds** on statement import (`CommitImportCommandHandler`, `ImportStatementCommandHandler`, `ImportStatementResult.Held`); the **incoming-money prompt** ("Put into jars", `JarAllocationFields`) wherever money reaches a jar-backed account and the **outgoing prompt** ("Which jar does this come from?", `PaidFromJarSelect`) for a payment on a line that is not a jar (`Application/Jars/JarMovements.cs`, `JarAllocationKind.Movement`); and cross-account **Move money** recorded as a confirmed bank transfer (`MoveMoneyModal`). | **Out of scope:** same-account Move money, initial allocation, jar balances and the rule 70 deficit flag → `13-jars.md`; transfer legs, in-transit and pending-review mechanics → `11-transfers.md`; the import review table's other columns → `15-import.md`; the allocation waterfall → `14-allocation.md`.

**Test data setup:** Unless a case says otherwise: an authenticated **Owner** of a EUR household; today is **2026-07-15**; the current month exists with expense lines *Groceries* (category *Food*) and *Travel* (category *Leisure*), an income line *Salary*, and a Savings group; two accounts — **Current** (opening 500.00 on 2026-01-01) and **Savings** (opening 1,000.00 on 2026-01-01) — and two jars held in Savings, **Holiday** (initial allocation 400.00) and **Car** (300.00), so Savings shows 300.00 unallocated. Holiday's Savings line is *Holiday*. Rule references are to `docs/reviews/2026-09-22/AGREED-RULES.md`.

---

## Rule 74 — an account never goes below zero

### MM-001 - A payment that would overdraw its account is refused with the balance and date
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Current holds 500.00.
- **Steps:**
  1. Add a 600.00 expense on Current dated 2026-07-10.
- **Expected:** `POST /transactions` → 400 with `errors.Amount` = "Current would be -100.00 EUR on 2026-07-10. An account never goes below zero here: record the money that reached it first, or correct this amount." The modal shows that text verbatim and stays open; nothing is persisted. A 500.00 expense (to exactly zero) is accepted.
- **Automated:** Backend `AccountBalanceGuardTests`; SQL `AccountBalanceSqlTests` (two racing 80.00 payments from 100.00: exactly one refused); client `TransactionsPage.jars.test.tsx` (400 shown verbatim).

### MM-002 - The floor holds on every date, not just today
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** Current opened with 0.00 on 2026-06-01; a 500.00 income on 2026-06-10.
- **Steps:**
  1. Add a 100.00 expense on Current dated 2026-06-05.
- **Expected:** Refused — "Current would be -100.00 EUR on 2026-06-05" — even though today's balance would be 400.00. Dated 2026-06-10 or later it is accepted. A row dated before the account's opening date is history only and never counts (rule 40).
- **Automated:** Backend `AccountBalanceGuardTests`.

### MM-003 - Removing or shrinking money that later payments relied on is refused
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Current: opening 0.00; income 500.00 on 2026-06-10; expense 300.00 on 2026-06-20.
- **Steps:**
  1. Delete the income. 2. Edit the income to 200.00. 3. Move the expense to Savings-like account that cannot cover it.
- **Expected:** Each is refused with the account, balance and date (`errors.TransactionId` on delete, `errors.Amount` on edit). Deleting the expense is always allowed. Editing the amount up, or moving the expense to an account that covers it, is allowed; when a transaction changes account both accounts are checked.
- **Automated:** Backend `AccountBalanceGuardTests`.

### MM-004 - Transfers, leg confirmation, allocation commit and opening-balance edits obey the floor
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** As setup.
- **Steps:**
  1. Record a 600.00 transfer Current → Savings. 2. Supply a departure date on a pending-review 600.00 receipt into Savings from Current. 3. Commit an allocation whose transfers exceed the source. 4. Edit Current's opening balance to 0.00 after a 100.00 payment was recorded.
- **Expected:** All four refused (`errors.Amount`, `errors.DepartedOn`, `errors.Allocation`, `errors.OpeningBalance`). Confirming only a receipt date is never refused (it adds money).
- **Automated:** Backend `AccountBalanceGuardTests`; SQL `AccountBalanceSqlTests` (racing transfer and payment).

### MM-005 - Import: breaching rows are held row by row in date order; nothing is posted "anyway"
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Savings-free account **Feed** opened 0.00 on 2026-01-01; statement rows: 2026-06-18 GYM −25.00, 2026-06-18 GYM −25.00, 2026-06-19 PAYROLL +1,000.00, 2026-06-20 RENT −800.00.
- **Steps:**
  1. Preview and commit all four into Feed.
- **Expected:** The commit posts PAYROLL and RENT (evaluated in date order: on 06-18 the account would be −25.00, so both GYM rows are held; on 06-19 +1,000.00; on 06-20 200.00 remains). `ImportStatementResult` has `imported 2`, `held` = the two GYM references each with "Feed would be -25.00 EUR on 2026-06-18 …", `heldCount 2`. The review stays open showing only the held rows with a rose **Held** badge and the reason, a banner with the counts, and **Commit held rows**. Recording a 100.00 income on Feed dated 2026-06-17 and committing again imports them; unticking a held row discards it. Credits and pending-review receipts are never held. Leaving the page loses the held rows; a re-upload offers only the rows not yet imported.
- **Automated:** Backend `ImportHoldsTests`; client `ImportPage.jars.test.tsx` (held rows keep the review open, re-commit sends only them).

## Rule 78 — incoming money prompts for allocation

### MM-010 - Income into a jar-backed account asks how much goes to each jar
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** As setup (Savings backs Holiday and Car).
- **Steps:**
  1. + Add transaction: Income, 500.00, account Savings, Salary line.
  2. In "Put into jars in Savings" enter Holiday 300, Car 200. Add.
- **Expected:** The fieldset appears only for a jar-backed account and only for Income; each jar shows its balance; the remainder line reads "Stays unallocated: €0.00" (or the remainder), and exceeding 500.00 shows "The jar amounts exceed the €500.00 received." and the server refuses (`errors.JarAllocations`). `POST /transactions` carries `jarAllocations: [{Holiday, 300}, {Car, 200}]`; afterwards Holiday 700.00, Car 500.00, unallocated 300.00 unchanged (the rule's example). Leaving the fields empty (dismissing) sends nothing: all 500.00 unallocated (800.00). The register row shows "→ Holiday 300.00, Car 200.00".
- **Automated:** Backend `JarMovementsTests`; client `TransactionsPage.jars.test.tsx`; journey `money-movement.spec.ts`.

### MM-011 - Transfer receipts ask the same question by every path
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** As setup.
- **Steps:**
  1. Record a Current → Savings transfer with an arrival date and fill the destination fields. 2. Record one without an arrival date; later click **Confirm receipt** on the row and fill the fields. 3. Import a Savings statement credit marked as a transfer (matched to a recorded departure, or unmatched). 4. Commit an income allocation for a member whose savings account backs jars.
- **Expected:** Each path sends `jarAllocations` (per member `{memberId, jarId, amount}` on the allocation commit) and the destination jar's balance rises once the receipt is posted; an answer given before the receipt is known (an in-transit move, an unmatched receipt awaiting its departure) applies at that moment. `jarAllocations` without a receipt date on leg confirmation is refused by the validator.
- **Automated:** Backend `JarMovementsTests`, `AllocationJarPromptTests`; client `TransactionsPage.jars.test.tsx`, `AllocationPage.jars.test.tsx`, `ImportPage.jars.test.tsx`.

## Rule 79 — outgoing money identifies its jar through the budget line

### MM-020 - A payment on a jar's line draws from that jar without a prompt; on another line it asks
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** As setup.
- **Steps:**
  1. + Add transaction: Expense 250.00 from Savings on the *Holiday* line — no jar question is shown.
  2. + Add transaction: Expense 100.00 from Savings on the *Travel* line — "Which jar in Savings does this come from?" appears, defaulting to "Unallocated money"; choose Holiday.
  3. + Add transaction: Expense 50.00 from Savings with no line — no question.
- **Expected:** After step 1 Holiday 150.00, account 750.00 (derived, nothing stored). Step 2 sends `paidFromJarId: Holiday` → Holiday 50.00; with the default it sends null → unallocated 200.00. Step 3 draws from unallocated. The prompt never appears for an account without jars, for Income, or for a jar line (`paidFromJarId` on a jar line is refused server-side: "already on a jar's line"). A jar may go negative through a payment (rule 5); the account may not (MM-001). Split expenses: jar-line slices draw from their jars and one select covers the other slices.
- **Automated:** Backend `JarMovementsTests`; client `TransactionsPage.jars.test.tsx`; journey `jars-ledger.spec.ts` (jar line) and `money-movement.spec.ts` (non-jar line).

### MM-021 - Inline assignment to a non-jar line prompts; edits re-answer; deletion removes the answer
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** An unassigned 100.00 expense from Savings.
- **Steps:**
  1. On the register row pick *Travel* in the assignment dropdown → the prompt modal opens; choose Holiday → "Use this jar".
  2. Edit the row: the prompt shows Holiday pre-filled; change to Unallocated and save.
  3. Delete the row.
- **Expected:** Step 1 PUTs `/assignment` with `paidFromJarId`; the cross-month confirmation, when needed, keeps the same answer. Step 2 PUTs the edit with `paidFromJarId: null` and the stored answer is removed (an edit that omits the answer returns the leg to its default); an omitted answer keeps a draw from a jar that has since moved account (P51). Step 3 removes the stored split with the row (each leg's split is cleared first).
- **Automated:** Backend `JarMovementsTests`, `JarDepartureTests` (`Rule80_APayeeEditOfAPaymentDrawnFromAMovedJar_KeepsTheDraw`); client `TransactionsPage.jars.test.tsx`.

## Rule 80 — cross-account Move money is a confirmed bank transfer

### MM-030 - Moving jar money to another account records a transfer
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** As setup, plus a jar **Repairs** held in Current.
- **Steps:**
  1. Jars → Holiday → Move money; Move to: Current › Repairs; amount 100.00.
  2. Tick "I have made this transfer"; keep departure and arrival at today; Confirm move.
- **Expected:** The modal explains it is recorded as a bank transfer between Savings and Current; the checkbox is required. `POST /transactions/transfer` carries `fromAccountId Savings, toAccountId Current, fromJarId Holiday, jarAllocations [{Repairs, 100}], departedOn, receivedOn`. Afterwards Holiday 300.00, Savings 900.00, Repairs 100.00, Current 600.00. A same-account destination still uses `POST /jars/reallocations`. Clearing the arrival date leaves the 100.00 in transit; Repairs receives it when the receipt is confirmed on the Transactions page. The source jar can give at most what it holds and the account must cover it (rules 68/74; server messages shown verbatim).
- **Automated:** Backend `JarMovementsTests` (transfer with FromJarId/JarAllocations); client `JarsPage` move tests; journey `money-movement.spec.ts`.
