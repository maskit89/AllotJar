# Feature-interaction matrix

**ID prefix:** CMB | **Scope:** Cross-feature, pairwise/three-way interactions that no single area file can see — the seams where import, dedup, transfers, allocation, jars, savings lines, splits, bills, month-copy/templates, reports, reconciliation, members, currency-format preferences, feature flags and the solo↔shared transition meet. Each case asserts a behaviour that emerges only from two or more features acting together, and references the single-feature cases it builds on rather than repeating them. | **Out of scope:** single-feature mechanics live in their area files — categories/lines `08-categories-budget-lines.md`, bills `09-bills.md`, transactions/splits `10-transactions.md`, transfers `11-transfers.md`, accounts/reconciliation `12-accounts-reconciliation.md`, jars `13-jars.md`, allocation `14-allocation.md`, import `15-import.md`, people/households `16-people-households.md`, invites `17-invites.md`, reports `18-reports.md`; end-to-end multi-feature *journeys* live in `20-journeys.md` (CMB cases isolate ONE seam; JRN cases walk a whole user story).

**Test data setup:** unless a case says otherwise, assume a shared household `OwnerId=H1`, two active members **Alex** (net income 1,200.50) and **Sam** (net income 800.25), base currency EUR with the default number format `comma-dot` (`1,234.56`), two EUR accounts **Joint** (opening 1,250.00) and **Savings** (opening 0.00), the `HouseholdAllocation`, `HouseholdAccess`, `Accounts`, `Jars`, `Reports`, `MultiCurrency` and `CamtImport` flags all **on**, and at least one budget month present. "Solo" fixtures use a one-member household `S1` (member Sam). Money is integer minor units at scale 4 on the client and `decimal(18,4)` server-side; actuals/balances are always transaction-derived at read time.

---

## Interaction matrix

Legend: **CH** = covered here (CMB id) · **area** = owned by a single-feature case (referenced, not duplicated) · **N/M** = not a meaningful interaction (justification given).

| Feature pair / triple | What meets | Coverage |
| --- | --- | --- |
| Import × dedup × account deletion | `BankReference` dedup keys on `(OwnerId, BankReference)`, account-independent | **CH** CMB-001, CMB-002 |
| Import × account choice × dedup | same statement re-imported to a different account | **CH** CMB-003 |
| Import × month boundaries | assigned-line month vs statement date; repeat-charge suffix | **CH** CMB-004, CMB-005 |
| Import × account currencies × waiting rows | mixed-currency file: refused into one account; imported account-less, the other-currency rows wait | **CH** CMB-006 |
| Import × concurrency × dedup | unique-index race recovery keeps attribution | area IMP-076 (+ CMB-001 note) |
| Transfers × allocation × reconciliation | alloc commit writes member transfers → account balances → Float tile | **CH** CMB-007, CMB-008 |
| Transfers × allocation pool | pool = member net income, not transactions | **CH** CMB-010 |
| Transfers × allocation × currency | alloc transfer stamped in the source currency; a savings account in another currency refused | **CH** CMB-011 |
| Transfers × reports | transfers excluded from every report sum | area RPT-029 (+ CMB-022 note) |
| Transfers × jars × reconciliation | cash moved into a funding account vs the jar's tracked balance | **CH** CMB-012 |
| Allocation × balance-tilt × prior transfers | tilt reads account balance minus this month's own alloc transfers | **CH** CMB-009 |
| Allocation × account deletion | dangling personal-savings account id | **CH** CMB-013 (builds on ALLOC-054/057) |
| Jars × month copy × archived jars | archived jar's line dropped; dangling SavingsId kept | **CH** CMB-015 (builds on JAR-047) |
| Jar-linked savings line × category deletion | deleting a Savings group or line that holds a jar's line is refused (rule 60); skip the month or archive the jar instead | **CH** CMB-016, CMB-017 |
| Jars × month create × append | jar with no line gets one appended next month | **CH** CMB-014 (builds on JAR-050) |
| Savings line (planned) × account (actual) × Float | planned contribution without moving cash | **CH** CMB-018 |
| Jars × backfill month × as-of balance | earlier month seeds from as-of balance | area JAR-059 (+ CMB-019) |
| Savings lines × empty month × IsBalanced | jar-owner blank month is over-budgeted, not empty/balanced | **CH** CMB-020 (builds on CAT-041, JRN-010) |
| ProportionalPool jar × month copy | pool funds copy flat, not accrual-seeded | **CH** CMB-021 |
| Splits × actuals × account balance | slices to lines, whole amount to the account | **CH** CMB-022 |
| Splits × reports sums | split counted once in trend/annual | area RPT-028 (+ CMB-022) |
| Splits × jars/savings | split slice into a savings line rolls into the jar | **CH** CMB-023 |
| Splits × money in another currency | a waiting split row counts nothing and can't be confirmed; confirm, then split | **CH** CMB-024 |
| ExcludeFromAllocation × allocation totals × copy | excluded category left out of BOTH envelopes and funds; survives copy | **CH** CMB-027 |
| Member removal × transactions × allocation | archive keeps attribution but drops the member from the pool | **CH** CMB-025 |
| Member re-activation × allocation | unarchive restores the pool | **CH** CMB-026 |
| Bills × rollover × month copy | DueDay carries, Paid resets, overdue recomputed | **CH** CMB-028 (builds on BILL-031) |
| Bills × template/blank month | no bills until due days set | area BILL-032 (+ CMB-029) |
| Bills × month length after copy | day-31 clamps in the target month | area BILL-027/28 (+ CMB-030) |
| Templates × jars/savings | template mints fresh backing jars; existing jars appended too | **CH** CMB-031, CMB-032 |
| Templates × SavingsId FK | template savings line is a real jar (no bare-Guid crash) | **CH** CMB-033 (builds on CAT-036) |
| Currency-format pref × every money display | one pref re-renders all money; symbol per stamped currency | **CH** CMB-034, CMB-035 |
| Currency-format pref × zero-decimal currency | JPY 0-dp display vs 2-dp edit field | **CH** CMB-036 |
| Currency-format pref × amount parsing | parseMinor accepts both separators regardless of pref | **CH** CMB-037 |
| Feature flag off × deep link | unregistered route falls to catch-all redirect, not 404 | **CH** CMB-038 |
| Feature flag off × multi-hop redirect | `/members`→`/people`→`/` with HouseholdAllocation off | **CH** CMB-039 |
| Two-flag gating (People vs invites) | householdAllocation gates People; householdAccess gates sign-in controls | **CH** CMB-040 |
| CamtImport flag × Import surfaces | nav/link/route/API all follow one flag | **CH** CMB-041 |
| Solo→shared × gated features | member selects, sharing copy, Allocation nav appear live | **CH** CMB-043 |
| Shared→solo × attribution | member selects hide; existing attribution survives | **CH** CMB-044, CMB-045 |
| Solo household × allocation server | client gate only; server allows solo commit | area ALLOC-060 (+ CMB-046) |
| Session death × in-flight cross-feature edit | dead-session prompt over any page; grace window | area ACCT-060, JRN-008/12 (+ CMB-047) |
| Transfers × reports × member-spending × registers | one transfer row excluded from every rollup, shown signed on both registers | **CH** CMB-048 |
| Import-created transfer × accounts × reports | an imported transfer is indistinguishable from a manual one downstream | **CH** CMB-049 (builds on IMP-050) |
| Analytics flag × all-flags-on | analytics is the ONE default-off flag; never implicitly enabled | **CH** CMB-042 |
| Jar shelf/Jars balance × budget-grid "avail." | two balance flavours legitimately differ by opening + future plantings | **CH** CMB-050 |
| Empty month × dashboard hero × onboarding checklist | PR #172 rule agrees across three independently-computed surfaces | **CH** CMB-051 (builds on UX-017) |
| ExcludeFromAllocation × dashboard RemainingToBudget/IsBalanced | flag honoured by allocation, ignored by the dashboard budget math | **CH** CMB-052 (builds on CMB-027) |
| Allocation pool × budget Income lines (decoupling) | pool = Σ member `NetMonthlyIncome`, never the month's Income lines; either can be zero while the other is large | **CH** CMB-053 (builds on CMB-010, CMB-020) |
| Allocation commit × source overdraft × jar-backing Float | commit drains the source account with no guard; jar tracked balance intact → the source's Float drops, possibly negative | **CH** CMB-054 (builds on CMB-007, CMB-012) |
| Split-slice member attribution × member archive | archived member's slices drop from member-spending while the line actual, reports and account balance stay | **CH** CMB-055 (builds on CMB-022, CMB-025) |
| Import × uncreated month × time-scoped assign | a past-dated imported row is unattachable; later creating that month does not adopt it | **CH** CMB-056 (builds on CMB-004, TIME-026) |
| Import × auto-categorisation | shared suggestion machinery; commit persists explicit choices only | area IMP-039, CAT auto-categoriser — no new seam beyond CMB note |
| Manual entry × account currency | manual tx is always in the budget currency; refused on a legacy account in another currency | area CURR-038 / ACCT-048 — single-surface guard |
| Reports × breakdown-month currency | page relabels every card in the breakdown month's base currency | area RPT-032 / CURR-032 — owned by reports/currency files |
| Household switch × write scoping | writes land in the ACTIVE household's OwnerId | area PPL-058, RPT-031 — data-isolation, no new seam |
| Import × invites/roles | Read-only/Limited cannot import | area IMP-002, TX-087 — no new seam |
| Reports × households switch | reports scoped to active household | area RPT-031, PPL-058 — data-isolation, no new seam |
| Currency × transfers | cross-currency transfer refused (legacy data only — no new account can be in another currency) | area TRF-021/TX-083 — single-feature guard |
| Waiting rows × refunds | a waiting refund counts nothing; a confirmed one must fit its purchase | area TX-107 |
| Waiting rows × every aggregate | budget, reports, People, jars, Transactions hero exclude a waiting row until confirmed | area CURR-052 |
| Waiting rows × jar cycles | a waiting payment is listed but can't mark a cycle paid until its amount is entered | area JAR-114 |
| Legacy-account rows × every aggregate | a row on an account kept in another currency counts its `budgetAmount` in budget, reports, People, refunds and the Transactions hero; balances keep its own amount | area CURR-057 / ACCT-042 |
| Legacy-account rows × edits, splits, refunds | an amount edit makes it wait again; a split shares the figure; a refund is measured against the figure | area TX-113 / TX-114 / TX-115 |
| Jars × invites | **N/M** — jars have no per-role sub-behaviour beyond the Read-only hide (JAR-011) |
| Bills × allocation | **N/M** — bills are Expense lines already summed into the envelopes total; no bill-specific allocation path |
| Reports × bills | **N/M** — reports read actuals, which don't distinguish bill lines from plain expense lines |

---

## Import × dedup × accounts × month boundaries

### CMB-001 - Re-importing a statement after deleting its import account still dedups every row
- **Priority:** P0
- **Type:** Regression
- **Origin:** dedup key is `(OwnerId, BankReference)` in `CommitImportCommandHandler` + `IX_Transactions_OwnerId_BankReference`; `DeleteAccountCommandHandler` unlinks (nulls `AccountId`) but keeps the rows and their `BankReference`.
- **Preconditions:** shared household; account **Joint**; a generic CSV of 20 rows already imported to Joint (20 transactions carry `BankReference` values).
- **Steps:**
  1. Go to `/accounts`, open **Joint**, delete it via the confirmation modal (ACCT-029).
  2. Confirm on `/transactions` the 20 rows survive with a "—" account cell (ACCT-093 / TX-093).
  3. Go to `/import`, choose the SAME CSV and the same file format, pick a different import account (e.g. **Savings**), submit, and commit all rows.
- **Expected:** the commit result reads **0 imported, 20 skipped (duplicates)** — the pre-loop dedup snapshot (`t.OwnerId == userId && t.BankReference != null`) still contains all 20 references because deleting the account never cleared them; account identity plays no part in dedup. No new rows appear; the 20 originals stay account-less.
- **Automated:** Partial (tests/AllotJar.IntegrationTests/UniqueBankReferenceTests.cs asserts the owner+reference uniqueness; the delete-then-reimport path is not e2e-covered)

### CMB-002 - Deleting an account does not resurrect its imported rows on re-import
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** as CMB-001 after step 2 (20 account-less imported rows).
- **Steps:**
  1. Re-import the same CSV to **Savings** but this time UNtick 5 rows in review (IMP-040) before committing.
  2. Inspect `/transactions` and the **Savings** register.
- **Expected:** still **0 imported / 15 skipped** for the ticked rows (all are known references) and the 5 unticked never attempt insert; none of the account-less originals are re-created or re-attached to Savings. Account balances are unchanged because no new transaction was written. Dedup is content/reference-based, not account-based.
- **Automated:** No

### CMB-003 - Same statement imported to a second account is fully deduped, not duplicated per account
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** shared household; accounts **Joint** and **Savings**; a CAMT file already committed to **Joint**.
- **Steps:**
  1. Go to `/import`, choose the same CAMT file, select **Savings** as the import account, submit.
  2. Review and press the commit button.
- **Expected:** the "all caught up" outcome — every row skipped as a duplicate (IMP-056) because the `(OwnerId, BankReference)` set already holds them; the rows are NOT re-created against Savings. This proves dedup is per-household, not per-account, so re-pointing an import cannot silently double a household's money.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/ImportPreviewCommitTests.cs covers reference dedup on commit)

### CMB-004 - An imported transaction counts in the month of its assigned line, not its statement date
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; budget months 2026-02 and 2026-03 both exist; 2026-02 has an expense line "Groceries".
- **Steps:**
  1. Import a CSV containing one row dated **2026-03-05** for 40.00.
  2. In review, set that row's category to the February "Groceries" line and commit.
  3. Open the budget grid for 2026-02, then 2026-03; then open `/reports`.
- **Expected:** the 40.00 lands in **February's** "Groceries" actual (BudgetActuals sums by assigned `BudgetItemId` with no date filter), not March's, even though the transaction Date is in March. Reports' February trend bar reflects the spend; March does not. The transaction's Date only drives the register ordering and the import possible-duplicate ±4-day window, never which month's actual it hits.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/BudgetActualsTests.cs asserts line-based, date-independent actuals)

### CMB-005 - A genuinely repeated charge across two statement months each import once (no cross-month over-dedup)
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** shared household; account **Joint**.
- **Steps:**
  1. Import a January statement containing two identical "NETFLIX 9.99" rows on the 3rd; commit (both import with distinct references via the occurrence suffix — IMP-057).
  2. Import a February statement that again contains a "NETFLIX 9.99" on the 3rd; commit.
- **Expected:** February's charge imports (1 imported), because its reference carries the month/occurrence context and does not collide with January's — the dedup index suppresses true re-submissions of the same statement, not legitimately recurring monthly charges. Over four months you get four Netflix rows, not one.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs and HsbcCsvStatementParserTests.cs cover occurrence-suffix references)

### CMB-006 - A mixed-currency file is refused into one EUR account; imported with no account, the other-currency rows wait
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household, budget currency EUR; EUR account **Joint**; a CSV with a currency column containing EUR, GBP and USD rows.
- **Steps:**
  1. Import the CSV, map the currency column (do NOT choose "Use EUR for every row" — IMP-021), select **Joint** as the import account, and commit.
  2. Re-run with **no** import account and commit; open `/transactions`, the dashboard and the commit summary.
- **Expected:** Step 1: the commit is refused as a whole (400 `Items` → "This account is in EUR, but the transaction is in GBP. Record it in EUR, or choose an account in the transaction's currency.") — nothing is imported, so Joint's balance can't mix currencies. Step 2: each row is stamped with its OWN currency; the EUR rows count, the GBP and USD rows **wait** ("GBP …"/"USD …" + "Needs EUR amount") and are left out of every figure until their EUR amounts are confirmed (TX-104); the commit summary sums each currency separately (IMP-068). No exchange rate is applied anywhere.
- **Automated:** Partial (ImportPreviewCommitTests — `Commit_RejectsARowWhoseCurrencyDiffersFromTheImportAccount`; ForeignAmountsTests — `An_imported_row_in_another_currency_waits_and_nothing_converts_it`)

---

## Transfers × allocation × reconciliation

### CMB-007 - Committing allocation moves the source account down and each member savings account up
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** shared household; allocation profile with source account **Joint**; Alex's personal savings account **Alex-Savings** (opening 0.00) and Sam's **Sam-Savings** (opening 0.00) set on the People page; a balanced/positive month so both residuals > 0.
- **Steps:**
  1. On `/allocation` press **Allocate**, tick **I’ve completed these transfers**, press **Record transfers** and confirm the "Allocated {month} · 2 transfers in transit" strip (ALLOC-050).
  2. Open `/accounts` and read the balances; open **Joint**'s register.
- **Expected:** one `Transfer` transaction per member with residual > 0 is written from **Joint** to that member's savings account, `BankReference = alloc:{year}-{month}:{memberId}`. **Joint**'s derived balance drops by the sum of residuals; **Alex-Savings** and **Sam-Savings** rise by each residual (AccountBalances: `− transferOut + transferIn`). Net worth across accounts is unchanged (a transfer moves, never creates, money — TRF-028).
- **Automated:** Partial (tests/AllotJar.IntegrationTests/AllocationRerunTests.cs + tests/AllotJar.Application.Tests/Application/AllocationTests.cs)

### CMB-008 - Re-running allocation replaces its own transfers so balances never double
- **Priority:** P0
- **Type:** Regression
- **Origin:** `AllocateIncomeCommandHandler` removes prior rows whose `AllocationKey` starts with `alloc:{year}-{month}:` before recreating (ALLOC-052).
- **Preconditions:** CMB-007 already committed once.
- **Steps:**
  1. Change Sam's net income on `/people`, return to `/allocation`, press **Allocate** again.
  2. Re-read `/accounts` balances.
- **Expected:** the month's previous alloc transfers are deleted and re-created, so each savings account reflects the NEW residuals only — not the old plus new. Running Allocate five times leaves exactly the last run's transfers. Balances are idempotent in the month.
- **Automated:** Yes (tests/AllotJar.IntegrationTests/AllocationRerunTests.cs)

### CMB-009 - The balance-tilt ignores this month's own alloc transfers but sees a prior manual/imported one
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; "Send savings to" = **Balance** with a balance lean (ALLOC-014/015); Alex-Savings and Sam-Savings set.
- **Steps:**
  1. Before allocating, record a manual transfer of 500.00 into **Alex-Savings** (or import one).
  2. Open `/allocation`, note each person's share on the Savings card, press **Allocate** and record the transfers, then do it a second time.
- **Expected:** the water-fill tilt leans the pooled remainder toward **Sam** (lower savings balance) because `SavingsBalancesAsync` counts the pre-existing 500.00 transfer into Alex-Savings. On the SECOND Allocate the tilt is IDENTICAL to the first, because balances used for the tilt EXCLUDE transfers whose reference starts with `alloc:{year}-{month}:` — the commit stays stable and idempotent, and a member's own just-written allocation never feeds back into their next tilt.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AllocationTests.cs covers balance-tilt inputs)

### CMB-010 - Actual received income (transactions/imports) never changes the allocation pool
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; members Alex (1,200.50) and Sam (800.25); an income budget line.
- **Steps:**
  1. Note the "Income to allocate" hero on `/allocation` (= 2,000.75, the sum of member net incomes).
  2. Add a 3,000.00 income transaction and import several more income rows.
  3. Return to `/allocation` (re-preview).
- **Expected:** the pool is UNCHANGED at 2,000.75 — `IncomeAllocator.Compute` sums `AllocationMember.NetIncome` (each member's `NetMonthlyIncome` field), not transactions. Received income drives reports/actuals and the dashboard, but the allocation pool is member-record-driven. To change the pool you edit a member's income on `/people`, not the register. (This is why TRF-030 "transfer excluded from the split pool" holds trivially — no transaction of any type feeds the pool.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/IncomeAllocatorTests.cs)

### CMB-011 - Allocation transfers stay in one currency: stamped in the source account's, and a savings account in another is refused
- **Priority:** P1
- **Type:** Boundary
- **Origin:** `AllocateIncomeCommandHandler` used to hardcode `Currency = CurrencyCode.Eur` on the transfer (ALLOC-058), silently mixing currencies into a non-EUR savings account; it now stamps `source.Currency`, requires the source to be in the month's base currency and each savings account to share the source's currency. Since W08 no new account can be in another currency, so this needs legacy data.
- **Preconditions:** shared household, budget currency EUR; source account **Joint** (EUR); a member whose personal savings account is a **legacy USD** account; that member's residual > 0. Variant: the member's savings account is EUR.
- **Steps:**
  1. Commit allocation on `/allocation`.
  2. Variant: commit again; open the savings account register and the `/accounts` hero.
- **Expected:** Step 1: 400 — "{member}'s savings account is in USD but the source account is in EUR. Allocation transfers must stay in one currency."; nothing is written. Variant: the alloc transfer is stamped **EUR** (the source's currency), never waits, and moves both EUR balances by the raw amount; the hero is unchanged in total. (A source account in another currency than the month is refused too: "The source account is in {X}, but this budget is in {Y}. Choose an account in the budget currency.")
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/AllocationCoverageTests.cs — `Commit_WithASavingsAccountInADifferentCurrency_IsRejected`, `SoloCommit_WritesOneTransfer_InTheAccountsCurrency_AndNonPaddedReference`, `Commit_WhenBothAccountsUseADifferentCurrencyThanTheBudget_PreservesPriorTransfers`)

### CMB-012 - Cash moved into a jar's funding account raises the account balance but not the jar balance
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; a **Recurring** jar "Car Insurance" held in account **Savings** (JAR-021); its budget contribution line planned 50.00/month for 2 months (jar tracked balance = 100.00).
- **Steps:**
  1. Record a manual transfer of 400.00 from **Joint** into **Savings**.
  2. Open `/jars` and read "Car Insurance"; open **Savings** detail and read the reconciliation table (ACCT-052).
- **Expected:** the jar's tracked balance stays **100.00** (JarBalances = Σ planned contributions − Σ assigned spend, entirely from budget lines — transfers are not contributions); **Savings**' derived balance rises by 400.00; the reconciliation **Float** (`CurrentBalance − BackedJarsTotal`) rises by 400.00, meaning the account holds 400.00 more than its jars have earmarked. Moving cash and planning a contribution are independent axes — reconciliation is exactly what surfaces the gap.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountReconciliationTests.cs + SavingsTests.cs)

### CMB-013 - A member's deleted personal-savings account strands their allocation residual without crashing
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** shared household; a member with a personal savings account that is then deleted (`PersonalSavingsAccountId` left dangling — soft hint, no FK); that member's residual > 0.
- **Steps:**
  1. Delete the member's savings account on `/accounts`.
  2. Open `/allocation`; observe the person's row on the Savings card; press **Allocate** and record the transfers.
- **Expected:** `AllocationPlanner` nulls the dangling savings id (it is not in `savingsBalances`), so the person's Savings row reads "Stays in {source}" and the Allocate dialog lists them as staying there (ALLOC-046/055), and **Allocate** skips that member (`Residual > 0 && SavingsAccountId is Guid` gate — ALLOC-057) rather than writing a broken `TransferAccountId` FK. Other members still receive their transfers. No 500.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AllocationTests.cs)

---

## Jars × savings lines × month copy × categories

### CMB-014 - A jar created on the Jars page gets a contribution line appended to the next month created
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** shared household; latest month 2026-06 exists; create a **Goal** jar "Holiday" target 1,200 by year-end on `/jars` with NO existing budget line.
- **Steps:**
  1. Create month 2026-07 (copy-from-previous OR template OR blank).
  2. Open the 2026-07 budget grid.
- **Expected:** 2026-07 carries a Savings line "Holiday" with a seeded contribution (accrual required-monthly-contribution), even though 2026-06 had none — `CreateBudgetMonth`'s append step adds a line for every active jar not already represented, sorted by name. This holds for a blank OR template month too, so the Jars page promise ("we work out what to set aside") always lands in the budget. (Single-feature seed math: JAR-050/054.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs + CreateBudgetMonthTests.cs)

### CMB-015 - Copy drops an archived jar's line but keeps a dangling-SavingsId line
- **Priority:** P1
- **Type:** Regression
- **Origin:** `CreateBudgetMonth` drops copied lines whose `SavingsId` is in `archivedJarIds`, but keeps a line whose `SavingsId` has no jar row at all (JAR-047).
- **Preconditions:** shared household; month 2026-06 has two savings lines — jar A (active) and jar B (about to be archived); plus a legacy line whose `SavingsId` points to no jar row (test/dangling data).
- **Steps:**
  1. Archive jar B on `/jars` (JAR-044).
  2. Create 2026-07 with copy-from-previous.
- **Expected:** 2026-07 carries jar A's line and the dangling-SavingsId line, but NOT jar B's — archiving stops future contributions. Jar B also disappears from the `/accounts` reconciliation (ACCT-055) and the jars list (JAR-045). The dangling line is preserved because "absent jar" is treated as data drift, not as "archived", so it is never silently pruned.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs)

### CMB-016 - A Savings group that holds jar lines can't be deleted, so the jars keep their month; an empty Savings group deletes
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** shared household; a "Savings" group with two lines backing jars X and Y in month 2026-06; a second Savings group "Later" with no line in the same month.
- **Steps:**
  1. On the 2026-06 budget grid look for the delete control on "Savings" and on "Later".
  2. Send `DELETE /api/budget/categories/{savingsId}` directly.
  3. Delete "Later".
  4. Create month 2026-07 with copy-from-previous.
- **Expected:** 1: "Later" offers its delete control; "Savings" offers none. 2: 400 on `CategoryId`: "Savings holds jars' monthly contributions (X, Y). Skip this month's contribution or archive the jar instead; a group can be deleted once it holds no jar's line."; the group, both lines and both jars stay, so 2026-06's jar history and plan are unchanged (rule 46) and the shelf never plans a line the grid no longer has. 3: "Later" is removed. 4: 2026-07 carries the Savings group with a line for X and Y. To pause a jar for one month, skip its contribution (BUDG-060); to stop it, archive it (CMB-015). Deleting the budget category is never a jar lifecycle action (CAT-023).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CCategoriesLinesCoverageTests.cs `DeleteSavingsGroup_ThatHoldsAJarsLine_IsRefused_AndAnEmptyOneDeletes`; client/src/pages/DashboardPage.test.tsx CAT-023; CreateBudgetMonthTests.cs covers the copy)

### CMB-017 - One month's jar line can't be deleted; skipping it leaves the jar planning the next month
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; active jar Z with a deadline plan and a line in 2026-06, the current month.
- **Steps:**
  1. Click **✕** on jar Z's savings line in 2026-06.
  2. Send `DELETE /api/budget/items/{id}` for that line directly.
  3. Choose **Skip this month** in the dialog.
  4. Create 2026-07 with copy-from-previous.
- **Expected:** 1: no removal; the skip-or-archive dialog opens (CAT-044). 2: 400 "Z is a jar's monthly contribution. Skip this month's contribution, or archive the jar to stop future ones."; the line and jar Z stay. 3: the line stays in 2026-06 at €0.00 with a **Skipped** tag (BUDG-060). 4: 2026-07 carries Z's line seeded at 2026-07's own planned contribution, not skipped. The jar's rolled-up balance still spans every month that carried a Z line. Skipping a month is a per-month edit, never a jar lifecycle action; archiving stops the jar (CMB-015).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CCategoriesLinesCoverageTests.cs `DeleteSavingsLine_IsRefused_TheLineAndItsJarStay`; JarLifecycleW04Tests.cs `Rule61_Skipping_ThisMonth_…`; CreateBudgetMonthTests.cs)

### CMB-018 - Planned savings contributions without moving cash push the reconciliation Float negative
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** shared household; jar "Christmas" held in account **Savings** (opening 0.00); plan 100.00/month for 3 months (jar tracked balance 300.00); no transfers into **Savings**.
- **Steps:**
  1. Open **Savings**' page `/accounts/:id` and read its **In jars** tile (the same figures as Savings' card on `/accounts`).
- **Expected:** `BackedJarsTotal` = 300.00 (planned), `CurrentBalance` = 0.00 (no cash moved), so **Float = −300.00**: In jars reads €300.00 with its bar and **"€300.00 over"** in red, its (i) saying to move money out of a jar to cover it (ACCT-054, ACCT-082). The negative Float is the honest signal that the plan promises money the account does not physically hold yet — jar balance (plan) and account balance (actual) are deliberately independent, and reconciliation is where they meet.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AccountReconciliationTests.cs)

### CMB-019 - Back-filling an earlier month seeds a jar from its as-of balance, not the latest balance
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** shared household; jar with target; months 2026-05 and 2026-07 exist with contributions; 2026-06 is missing.
- **Steps:**
  1. Create the missing 2026-06 via the ‹ back-fill (copy-from-previous, where "previous" is the most recent month strictly before 2026-06 = 2026-05).
- **Expected:** the seeded contribution for 2026-06 uses the jar's ledger balance as of 31 May 2026 (a month at or before the current one plans from the balance the day before it starts — HANDOVER P27; rule 48) — 2026-07's later contribution/spend does NOT leak backward into the seed. Seeding is order-independent because the stored jar date is an anchor never rewritten (JAR-038/059).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — backfill seeds from the as-of balance; JarPlannerTests.cs; SavingsTests.cs)

### CMB-020 - A jar-owning household's blank month is over-budgeted; a no-jar household's is "plan your income"
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #172 — `IsBalanced => TotalIncome > 0 && RemainingToBudget == 0`; `CreateBudgetMonth` appends accrual savings lines for active jars even into a blank month.
- **Preconditions:** two households — **H-jar** owns an active jar with a target; **H-empty** owns no jars. Neither has income planned in the new month.
- **Steps:**
  1. In each household create a fresh **blank** month.
  2. Read the dashboard hero for each; also open `/reports` and `/allocation`.
- **Expected:** **H-jar**'s blank month has appended savings lines (`TotalPlanned > 0`, `TotalIncome = 0`), so `RemainingToBudget < 0` → the hero reads **over-budgeted**, never the gold "balanced" badge and never the empty prompt (CAT-041, JRN-010, PPL-063). **H-empty**'s blank month has `TotalPlanned = 0, TotalIncome = 0` → `RemainingToBudget == 0` but `TotalIncome == 0`, so `IsBalanced` is FALSE and the hero shows the "plan your income" prompt, not the gold badge. Reports and allocation read the same month totals consistently.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/RemainingToBudgetTests.cs covers IsBalanced; append behaviour in CreateBudgetMonthTests.cs)

### CMB-021 - A ProportionalPool jar copies its line flat instead of being accrual-seeded
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** shared household; a jar whose `Accrual = ProportionalPool` (e.g. an importer-seeded pooled fund) with a line planned 80.00 in 2026-06.
- **Steps:**
  1. Create 2026-07 with copy-from-previous.
- **Expected:** the ProportionalPool line copies its planned amount (80.00) unchanged — `IsSeedable` excludes ProportionalPool from accrual re-seeding, because those funds wait on the allocation pool rather than a per-month accrual target. TargetByDate jars in the same copy ARE re-seeded to their calculated required contribution. The two accrual methods coexist in one copied month.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs)

---

## Splits × actuals × reports × reconciliation

### CMB-022 - A split's slices drive line actuals once; the whole amount drives the account balance
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** shared household; account **Joint**; expense lines "Groceries" and "Household"; a 90.00 expense on **Joint** split 60.00 → Groceries, 30.00 → Household (TX-044).
- **Steps:**
  1. Open the 2026-mm budget grid, `/reports`, and **Joint**'s detail.
- **Expected:** Groceries actual +60.00, Household actual +30.00 (each slice sums into its line at the parent's rate; the parent row has `BudgetItemId == null` so it is never double-counted — BudgetActuals). Reports trend/annual counts the 90.00 ONCE (RPT-028). **Joint**'s balance drops by the WHOLE 90.00 (AccountBalances uses the parent amount; splitting is budget-line attribution only — ACCT-040). Invariant: Σ(slice actuals) = the account movement = 90.00.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/SplitTransactionTests.cs + BudgetActualsTests.cs)

### CMB-023 - A split slice pointed at a savings line rolls into that jar's balance
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; jar "Holiday" with a savings contribution line; a 200.00 expense split 150.00 → an expense line, 50.00 → the Holiday savings line.
- **Steps:**
  1. Commit/save the split; open `/jars` and the Holiday reconciliation.
- **Expected:** the 50.00 slice is treated as SPEND against the Holiday fund line (JarBalances subtracts expense-type split slices at the parent's rate), lowering the jar's tracked balance by 50.00, exactly as a whole 50.00 expense assigned to that line would. Split slices are first-class in both `BudgetActuals.ApplySavingsBalancesAsync` and `JarBalances`, so a jar can be drawn down via a split.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/SavingsTests.cs covers split-slice fund spend)

### CMB-024 - A split row in another currency counts nothing and can't be confirmed; confirm first, then split in the budget currency
- **Priority:** P1
- **Type:** Boundary
- **Origin:** W08 — slices used to roll up at the parent's exchange rate; with no rate any more, a waiting parent's slices are in its own currency and the confirm endpoint refuses split rows.
- **Preconditions:** budget currency EUR; a waiting USD 120.00 expense on no account (imported), split 80/40 across two EUR-budget lines before its amount was known.
- **Steps:**
  1. Open the budget grid and the register row.
  2. `PUT /transactions/{id}/converted-amount {amount: 110.40}`.
  3. **Remove split**, **Enter amount** 110.40, then split it 73.60/36.80 across the two lines.
- **Expected:** Step 1: neither line's actual moves — slices of a waiting parent are excluded like the parent; the row shows "USD 120.00" + "Needs EUR amount" but **no** Enter amount button (split). Step 2: 400 "This transaction is split. Remove the split, enter the amount, then split it again.". Step 3: the row counts €110.40 (`originalAmount 120 USD`) and each line gains its EUR slice; the slices sum exactly to the confirmed amount. (Pre-W08 split rows that had counted at a rate were restated by the `ForeignAmounts` migration with the largest slice absorbing the rounding — CURR-053.)
- **Automated:** Partial (FxPendingAggregatesTests — `BudgetActuals_ExcludeSlicesOfAPendingParent`; ForeignAmountsTests — `Only_a_waiting_row_that_is_not_split_can_be_given_an_amount`; ForeignAmountsMigrationTests — slice restatement)

---

## Allocation × members × ExcludeFromAllocation

### CMB-025 - Archiving a member keeps their transactions but removes them from the allocation split
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; members Alex and Sam; several expense transactions attributed to Sam; an allocation profile.
- **Steps:**
  1. Archive Sam on `/people` (PPL-022).
  2. Open `/reports` member spending (with archived shown) and `/transactions`; then open `/allocation`.
- **Expected:** Sam's transactions retain their `MemberId` (attribution survives — reports/member-spending still attribute them, PPL-023/025), but `AllocationPlanner` loads only `!IsArchived` members, so the pool drops to Alex's income alone (2,000.75 → 1,200.50), the shared-cost step is split across Alex only, and the Savings card no longer has a row for Sam. Archiving is a household-membership change that reshapes allocation without orphaning history.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AllocationTests.cs + HouseholdMembersTests.cs + MemberSpendingTests.cs)

### CMB-026 - Un-archiving a member restores them to the allocation pool with income intact
- **Priority:** P2
- **Type:** Regression
- **Preconditions:** CMB-025 state (Sam archived).
- **Steps:**
  1. There is no restore control on `/people` (PPL-024); un-archive via the members API `includeArchived`/update path, or re-add.
  2. Re-open `/allocation`.
- **Expected:** once Sam is active again she reappears in the pool at her stored `NetMonthlyIncome` (800.25) and the split returns to the two-member shape — her income was never zeroed while archived (PPL-025), so nothing needs re-entering. Confirms archive/un-archive is non-destructive to the allocation inputs.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/HouseholdMembersTests.cs)

### CMB-027 - An ExcludeFromAllocation category is left out of BOTH the envelopes and funds totals and survives copy
- **Priority:** P1
- **Type:** Regression
- **Origin:** `AllocationPlanner` filters `!c.ExcludeFromAllocation`; `CreateBudgetMonth` carries the flag forward (its comment: dropping it "folds an excluded category back into the shared obligation total and corrupts every copied month's member split"). No client UI sets the flag — it is a seed/data-level attribute (e.g. a "Personal Savings" surplus category).
- **Preconditions:** shared household; a month with an Expense category flagged `ExcludeFromAllocation` (planned 9,999) plus normal Expense and Savings categories.
- **Steps:**
  1. Open `/allocation` and read the "Shared spending" / "To savings" KPI tiles and the FundEnvelopes / FundJars step totals ("Cover shared costs" / "Fund the jars").
  2. Create the next month with copy-from-previous; re-open `/allocation`.
- **Expected:** the excluded category's 9,999 is absent from BOTH the envelopes total (FundEnvelopes) and the funds total (FundJars) — it is an allocation OUTPUT, not a cost, so the pool is not reduced by it. After copy the flag is preserved, so the copied month's allocation is identical; had the flag been dropped, every future month would double-subtract the surplus. Assert the totals match pre- and post-copy.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/AllocationTests.cs + CreateBudgetMonthTests.cs both exercise the flag)

---

## Bills × rollover × month copy

### CMB-028 - Copying a month carries each bill's due day but resets Paid, and recomputes overdue against the new month
- **Priority:** P1
- **Type:** Regression
- **Origin:** `CreateBudgetMonth` sets `DueDay = i.DueDay` on the copied line but never copies `IsPaid` (BudgetItem defaults `IsPaid = false`); the bill status banner is computed against the viewed month (BILL-023/29).
- **Preconditions:** shared household; 2026-06 has an expense bill "Rent" due day 1, marked **paid**.
- **Steps:**
  1. Create 2026-07 with copy-from-previous.
  2. Open 2026-07; read the Rent line's Bill tag and the bills banner.
- **Expected:** 2026-07's Rent keeps due day 1 (the bill recurs) but is **unpaid** again (Paid does not carry — you pay rent every month). The banner recomputes due-soon/overdue for 2026-07's due date, not 2026-06's; a bill unpaid in a month already gone reads overdue (BILL-029). This is the core "bills roll over" behaviour that spans month-create and the bills feature.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs + CreateBudgetMonthTests.cs)

### CMB-029 - A template or blank month has no bills until due days are set
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** shared household (already owns bills in prior months).
- **Steps:**
  1. Create a month from the **Essentials** template, then a separate **blank** month.
  2. Inspect their expense lines for Bill tags and the bills banner.
- **Expected:** neither the template lines nor the blank month carry a `DueDay` (templates seed structure only, at 0 planned; blank seeds just the Income group), so there is no Bill tag and no bills banner until the user adds a due day (BILL-001/032). Only copy-from-previous carries due days. Confirms bill-ness is per-line data, not a household-wide setting.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTemplatesTests.cs)

### CMB-030 - A day-31 bill clamps to the target month's length after a copy into February
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** shared household; January bill "Card payment" due day 31.
- **Steps:**
  1. Copy January → February (non-leap year); open February's bill.
- **Expected:** the stored `DueDay` copies as 31, but the effective due date clamps to Feb 28 for status (BILL-027) — due-soon/overdue computes against the clamped date. The raw 31 is preserved so that copying February → March restores a 31st due date. Clamping is a read-time projection over the month boundary, not a mutation of the carried due day.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BillTrackingTests.cs)

---

## Templates × jars/savings

### CMB-031 - A template month mints a fresh backing jar for each of its savings lines
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** household with NO jars yet; first month to be created.
- **Steps:**
  1. Create the first month from the **Family** template (its Savings group is "Emergency Fund", "Holiday", "Christmas").
  2. Open `/jars`.
- **Expected:** three real jars appear — one minted per template savings line via `SavingsLines.AddBackingJar`, each linked by the line's enforced `SavingsId` FK. The lines start at 0 planned (structure only). The household now owns jars it never opened the Jars modal for — a template is a jar-creation path.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTemplatesTests.cs)

### CMB-032 - A template month for a household that already has jars appends its existing jars too
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** household that already created jars "Emergency Fund" and "Car" on `/jars` but has NO budget month yet.
- **Steps:**
  1. Create the first month from the **Essentials** template (whose Savings group is "Emergency Fund").
  2. Open the budget grid's Savings group.
- **Expected:** the month contains BOTH the template's freshly minted "Emergency Fund" jar-line AND appended lines for the pre-existing "Car" and "Emergency Fund" jars (append step covers every active jar not represented by a template line). Because the template's minted jar and the pre-existing "Emergency Fund" jar are DIFFERENT jar rows, two same-named "Emergency Fund" lines can appear — a duplicate-looking but jar-distinct outcome worth surfacing to the user. (Templates are normally offered only when there is nothing to copy; this is the pre-existing-jars corner.)
- **Automated:** No

### CMB-033 - A template savings line satisfies the SavingsId FK (no bare-Guid crash on SQL Server)
- **Priority:** P1
- **Type:** Regression
- **Origin:** every `SavingsId` writer goes through `SavingsLines`; a bare Guid passes EF InMemory but violates the enforced FK on SQL Server (CAT-036 gotcha).
- **Preconditions:** SQL Server-backed environment.
- **Steps:**
  1. Create a month from any template with a Savings group.
- **Expected:** the insert succeeds — each savings line's `SavingsId` references a jar row minted in the same `SaveChanges` (client-generated ids exist before insert ordering), so the `BudgetItems.SavingsId → Jars.Id` FK holds. No FK violation. This is the same invariant that guards adding a Savings line manually (CAT-036).
- **Automated:** Yes (tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs)

---

## Currency-format preference × money display

### CMB-034 - Changing the number-format preference re-renders every money value app-wide
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** signed-in EUR user currently on `comma-dot` (`1,234.56`).
- **Steps:**
  1. On `/account` change the number format to `dot-comma` (`1.234,56`) and save.
  2. Visit the dashboard, `/accounts`, `/jars`, `/reports`, `/transactions`.
- **Expected:** `setMoneyFormat` swaps the single active locale (`en-GB` → `de-DE`), so EVERY subsequent `formatMoney`/`formatPlain` call across all pages renders with the new grouping/decimal style (e.g. a balance shows `1.250,00 €`). The preference is display-only — no stored amount changes, and the integer-minor-unit arithmetic is untouched. One preference, uniform effect.
- **Automated:** Partial (client/src/lib/money.test.ts covers formatter locale switching)

### CMB-035 - Currency symbol tracks each value's stamped currency while the format follows the user preference
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** `MultiCurrency` on; user preference `dot-comma`; budget currency EUR; an EUR account, a **legacy** GBP account, and a waiting USD transaction (imported, no account).
- **Steps:**
  1. Open `/accounts`, each account's register and `/transactions`.
- **Expected:** every amount uses the USER's `dot-comma` grouping, but the CURRENCY SYMBOL is per stamped value — `1.234,56 €` for EUR, `1.234,56 £` for GBP (`formatMoney(minor, currency)` = active-locale format + per-value currency). The waiting USD row has no symbol at all: "USD 1.234,56" (`formatForeign` = code + `formatPlain` in the active format). Format is a global preference; currency is a per-account/per-transaction property. The accounts hero counts only EUR accounts and says the GBP one is not counted (ACCT-005), still honouring the format preference on the sum.
- **Automated:** Partial (client/src/lib/money.test.ts)

### CMB-036 - A zero-decimal currency shows no decimals in displays but two in editable amount fields
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** a household whose budget currency is **JPY** (JPY has 0 ISO minor digits) with a JPY account.
- **Steps:**
  1. View the JPY account balance on `/accounts` (a display).
  2. Open the edit/opening-balance field for the JPY account or a JPY amount input (an editable field using `formatPlain`).
- **Expected:** the DISPLAY uses the currency's own fraction count — `¥1,234` with NO decimals (`formatMoney` with `style:'currency'`). The editable field uses `formatPlain`, which forces `minimumFractionDigits: 2`, so it shows `1,234.00` even for JPY. This is a known display/edit inconsistency for zero-decimal currencies — flag it; amounts still round-trip correctly through `parseMinor`.
- **Automated:** No

### CMB-037 - Amount parsing accepts either separator regardless of the display preference
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** user preference `comma-dot`.
- **Steps:**
  1. In any amount field (add transaction, transfer, jar target, account opening) paste `1.234,56` (de-style) and submit; repeat with `1,234.56`.
- **Expected:** `parseMinor` resolves the right-most of `,`/`.` as the decimal separator and strips the other as grouping, so BOTH inputs parse to the same 12,345,600 minor units — the display preference (`comma-dot`) never constrains what the user may TYPE. Spaces and apostrophes are stripped as grouping too (TX-024, TRF-014). Input tolerance and display formatting are independent.
- **Automated:** Yes (client/src/lib/money.test.ts)

---

## Feature flags × nav / routes / deep links

### CMB-038 - A flag-off deep link falls to the catch-all redirect, not a 404 page
- **Priority:** P1
- **Type:** Edge
- **Origin:** in `App.tsx` each gated `<Route>` is conditionally registered; the trailing `<Route path="*" element={<Navigate to="/" replace />}/>` catches anything unregistered.
- **Preconditions:** `Reports` flag OFF; user signed in.
- **Steps:**
  1. Navigate directly to `/reports`.
  2. Sign out and navigate to `/reports` again.
- **Expected:** signed in, `/reports` is unregistered so `*` redirects to `/` = the dashboard (RPT-034); signed out, `*` redirects to `/` = the landing page. In neither case is there a 404 screen — a disabled feature is invisible, not broken. The same pattern applies to `/jars`, `/accounts`, `/accounts/:id`, `/allocation`, `/import` when their flags are off. The server independently 404s the corresponding API (RPT-035, ACCT-059, JAR-069, IMP-006).
- **Automated:** Partial (client/src/pages/ReportsPage.test.tsx + client/src/components/AppNav.test.tsx)

### CMB-039 - With HouseholdAllocation off, /members and /access double-hop through /people to the dashboard
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** `HouseholdAllocation` flag OFF; user signed in.
- **Steps:**
  1. Navigate to `/members`, then to `/access`, then to `/people`, then to `/allocation`.
- **Expected:** `/members` and `/access` are ALWAYS-registered redirects to `/people`; but with HouseholdAllocation off the `/people` and `/allocation` routes are unregistered, so `/people` (and thus the `/members`→`/people` hop) lands on `*` → `/` (dashboard). Net effect: `/members` → `/people` → `/`. The People and Allocation nav pills are hidden (AppNav `show: features.householdAllocation`). PPL-072 confirms the API side (`/members` 404s).
- **Automated:** Partial (client/src/pages/PeoplePage.test.tsx)

### CMB-040 - People stays reachable while sign-in controls vanish when only HouseholdAccess is off
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** `HouseholdAllocation` ON, `HouseholdAccess` OFF; owner signed in.
- **Steps:**
  1. Open `/people`.
- **Expected:** the People page and nav pill render (gated by `householdAllocation`, which is on), the budget-people table works, but every login/invite affordance is hidden — "Invite to sign in", role controls, "Other sign-ins" — because those are gated by `householdAccess` (PPL-071, INV-006). Two independent flags gate two layers of the same page: `householdAllocation` = the page/members, `householdAccess` = the login/role layer. Turning off only one leaves a coherent, reduced page.
- **Automated:** Partial (client/src/pages/PeoplePage.test.tsx + RoleGating.test.tsx)

### CMB-041 - The CamtImport flag governs the nav-absent Import surface end to end
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** `CamtImport` flag OFF; a writer login.
- **Steps:**
  1. Look for an Import entry point in the navigation and on `/transactions`; navigate directly to `/import`; call the import API.
- **Expected:** the navigation drops its **Import** item (TX-088 — `useNavItems` lists it only when `camtImport && canWrite`; the Transactions page has no Import link of its own), `/import` is unregistered so it redirects to `/` (CMB-038), and the import controller 404s (IMP-006). All three Import surfaces follow the single `camtImport` flag, so there is no orphaned entry point when it is off.
- **Automated:** Partial (client/src/components/AppShell.test.tsx covers the nav item's visibility by role)

### CMB-042 - Analytics stays off under all-flags-on unless the server and a build-time id both enable it
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** default `FeatureFlags` (everything else on).
- **Steps:**
  1. Load the app with the default flags; inspect the analytics context.
- **Expected:** `analytics` is the ONE flag that ships OFF in `ALL_ON`, so tracking never starts by accident even when every other feature is enabled; it only turns on when the server flag says so AND a build-time measurement id exists. Toggling other features never implicitly enables analytics — consent-gated PII-safe tracking is opt-in by construction.
- **Automated:** Partial (client/src/analytics tests / AppNav.test.tsx track calls)

---

## Solo → shared transition × gated features

### CMB-043 - Adding a second member flips solo → shared and reveals member-scoped controls live
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** solo household `S1` (member Sam only); `HouseholdAllocation` on.
- **Steps:**
  1. On `/people` add a second budget person "Alex" (PPL-030).
  2. Without reloading, open `/transactions` add/split, re-open `/people`, and check the top nav.
- **Expected:** `isShared` flips to true the moment headcount reaches 2, so: the member select appears on the transaction add/split forms (PPL-033, TX-015/16), the Account settings sharing row switches from "Just you" to the people's faces and names (PPL-069), and the **Allocation** nav pill appears (`householdAllocation && isShared` — ALLOC-003). Solo gating is a live derived state (members ≥ 2), not a stored mode.
- **Automated:** Partial (client/src/pages/PeoplePage.test.tsx + TransactionsPage.test.tsx + AppNav.test.tsx)

### CMB-044 - Archiving back to one member flips shared → solo but the Allocation page stays URL-reachable
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household with 2 members; on the People page.
- **Steps:**
  1. Archive one member so headcount returns to 1 (PPL-031).
  2. Check the top nav; then navigate directly to `/allocation`.
- **Expected:** the **Allocation** nav pill disappears (`isShared` now false) and member selects hide across the app, BUT `/allocation` is still a registered route (gated only by `householdAllocation`, which is on), so a direct URL renders the solo nudge state ("add people, not the engine" — ALLOC-001/002). Solo hides the sharing affordances via `isShared` gating but never unregisters the routes.
- **Automated:** Partial (client/src/pages/AllocationPage.test.tsx)

### CMB-045 - Member attribution on existing transactions survives a shared → solo → shared round-trip
- **Priority:** P1
- **Type:** Regression
- **Preconditions:** shared household with 2 members; transactions attributed to each; a split with per-slice member attribution.
- **Steps:**
  1. Archive the second member (→ solo), then un-archive/re-add them (→ shared).
  2. Open `/transactions`, the split editor, and `/reports` member spending.
- **Expected:** the transactions and split slices keep their original `MemberId` throughout — the solo transition only hides the member SELECTS in the UI, it never nulls stored attribution. When shared returns, the member-scoped views show the same attribution as before. Reconfirms that `isShared` is a presentation gate, not a data migration.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/SplitTransactionTests.cs + MemberSpendingTests.cs)

### CMB-046 - A solo household can still run allocation server-side even though the UI nudges instead
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** solo household `S1` with an allocation profile and a source account; `HouseholdAllocation` on.
- **Steps:**
  1. Open `/allocation` (shows the solo nudge, no engine — ALLOC-001).
  2. Call the preview/commit allocation API directly for the month.
- **Expected:** the server computes and commits a one-member allocation — the pool is Sam's income alone, the split trivially assigns everything to Sam, and a transfer is written if Sam has a personal savings account and a positive residual (ALLOC-060). The solo gate is client-only; the engine is currency- and headcount-agnostic. No divide-by-zero on a single member (ALLOC-062).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AllocationTests.cs + Domain/IncomeAllocatorTests.cs)

### CMB-047 - A dead session on any long-lived cross-feature page prompts a fresh sign-in without a broken view
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #169/#171 — genuinely-dead sessions prompt re-login (cross-tab broadcast via `authChannel.ts`); the 30s grace 401 must not clear the shared refresh cookie.
- **Preconditions:** signed in on a long-idle tab sitting on `/accounts` (or `/jars`, `/allocation`); the refresh-token family is genuinely expired.
- **Steps:**
  1. Trigger a data fetch on the page (e.g. change the viewed month or open a detail).
  2. In a second tab, observe the cross-tab logout.
- **Expected:** the dead session surfaces the login prompt rather than a half-rendered page or an infinite spinner (ACCT-060 for the accounts page); the logout broadcasts across tabs (JRN-012); and a second tab replaying `/auth/refresh` within the 30s grace does NOT burn the family or clear the shared cookie (JRN-008). Session death is handled uniformly wherever the user happens to be, so no single feature page needs its own auth-recovery logic.
- **Automated:** Partial (client/e2e-journey/session-expiry.spec.ts + concurrent-refresh.spec.ts)

---

## Transfers × reports × member-spending (whole-app rollup exclusion)

### CMB-048 - One transfer row is excluded from every money rollup yet shown signed on both account registers
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** shared household; accounts **Joint** and **Savings**; a single 500.00 transfer **Joint → Savings** (TRF-005); at least one genuine 800.00 expense assigned to a line and attributed to Sam; a budget month and ≥2 report points exist.
- **Steps:**
  1. Open `/reports` — read the trend "Spent"/"Income" bars, the Annual overview, and the Spending-by-category breakdown %.
  2. Open `/people` — read the "Shared this month" hero tile and the per-member "Spent" column.
  3. Open `/transactions` — read the hero "Money in / Money out / Unassigned".
  4. Open `/allocation` — read the "Income to allocate" pool.
  5. Open **Joint**'s and **Savings**' detail registers (`/accounts/:id`).
- **Expected:** the 500.00 transfer contributes **0** to every rollup — reports Spent/Income/annual/breakdown (RPT-029), `/people` member-spending and the "Shared this month" tile (transfers are `Type=Transfer`, not `Expense`, so they never attribute to a member), the `/transactions` hero money-in/out and the Unassigned count (transfers excluded, TX hero), and the allocation pool (member-net-income-driven, CMB-010). Yet the SAME row renders as a signed **−500.00** on Joint's register and **+500.00** on Savings' register (account-detail signs by direction, TRF-027). Six independent surfaces treat one `Type=Transfer` row consistently: invisible to value rollups, visible-and-signed on ledgers, net-zero to household worth.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/BudgetTrendsTests.cs + Transactions/TransfersTests.cs + Application/MemberSpendingTests.cs each assert the exclusion in one subsystem; the whole-app synthesis is not e2e-covered)

### CMB-049 - An import-created transfer is indistinguishable from a manual transfer in every downstream rollup
- **Priority:** P1
- **Type:** Regression
- **Origin:** the import commit path builds a real `Type=Transfer` transaction (credit → source=counterparty/dest=import account; debit → reversed) exactly like `POST /transactions/transfer`; the only added field is a non-null `BankReference`. `AccountBalances`, `BudgetActuals` and the report queries all key off `Type`, never off origin.
- **Preconditions:** shared household; import account **Joint** chosen at upload; a `likelyTransfer` credit row committed as a transfer into **Savings** (IMP-050).
- **Steps:**
  1. After the import commit, read **Joint**'s and **Savings**' derived balances on `/accounts`.
  2. Open the budget grid, `/reports`, and the `/transactions` hero.
  3. Re-import the identical statement (IMP-056).
- **Expected:** the import-created transfer moves **Joint** down and **Savings** up by the amount (AccountBalances `−transferOut / +transferIn`, CMB-007), rolls into **no** budget-line actual (Type mismatch, BudgetActuals), and is excluded from every report sum and the `/transactions` hero money-in/out — behaving identically to a transfer entered by hand (TRF-028, RPT-029). Its only distinguishing trace is the `BankReference`, which makes a re-import dedup it to **0 imported / skipped** (CMB-003). Import origin never leaks into downstream money math.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/ImportPreviewCommitTests.cs commit-transfer cases + Application/AccountsTests.cs derivation)

---

## Jars balance flavours × budget grid × dashboard

### CMB-050 - The Jars balance and the budget grid's "avail." legitimately differ by opening balance and future plantings
- **Priority:** P2
- **Type:** Edge
- **Origin:** two by-design balance flavours — `JarBalances.ComputeAsync` (all-time: `OpeningBalance + Σ planned across EVERY month − Σ spend`) vs `BudgetActuals.SavingsAvailable` (months **≤ viewed**, **excluding** `Jar.OpeningBalance`). The dashboard "Your jars" shelf renders on the current calendar month only, precisely because it shows all-time balances.
- **Preconditions:** shared household; a jar "Holiday" held in **Savings**, opening balance **500.00**; its contribution line planned **50.00** in the current month AND **50.00** in a future month; no spend against it.
- **Steps:**
  1. Read the jar card on `/jars` and the "Your jars" shelf on the current-month dashboard.
  2. Read the "Holiday" savings line's **"avail."** figure on the current-month budget grid.
  3. Navigate the month selector to a past and a future month and re-check the dashboard shelf.
- **Expected:** `/jars` and the shelf show **600.00** (`500` opening + `50` current + `50` future — all months, includes opening). The budget grid **"avail."** for the current month shows **50.00** (months ≤ current, excludes the `500` opening and the future `50`). The two figures differ by exactly opening (500) + future plantings (50) — a documented two-flavour design, only equal on the current month for a jar with no opening and no future line. The dashboard shelf is **absent** on the past and future months (current-month-only) so its all-time number is never shown under a non-current label. Flag the divergence as expected, not a reconciliation bug.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/SavingsTests.cs asserts the ≤-viewed-month "avail." flavour; JarsTests.cs asserts the opening-inclusive all-time balance)

---

## Empty month × dashboard hero × onboarding checklist (PR #172 consistency)

### CMB-051 - The empty-month rule holds identically across the hero footnote, the balanced badge and the onboarding checklist
- **Priority:** P1
- **Type:** Regression
- **Origin:** PR #172 — `IsBalanced => TotalIncome > 0 && RemainingToBudget == 0` (domain + `budgetModel.ts`). The Getting-started checklist "Give every {noun} a job" done-guard (step 4) `income > 0 && remaining === 0` (`GettingStartedChecklist.tsx`) duplicates the rule INDEPENDENTLY (routing-shell gotcha #20), so the two must be kept in lockstep.
- **Preconditions:** a **jar-less** household (so a blank month is genuinely empty) with a freshly created blank month (income 0, nothing planned); the onboarding checklist not yet dismissed; viewing the current month.
- **Steps:**
  1. Read the dashboard hero footnote and check for the gold `BalancedBadge`.
  2. Open the "Getting started" checklist and read step 4 "Give every {noun} a job".
  3. Add an income source, then plan every euro until Remaining reaches €0.00.
  4. Re-read the hero footnote/badge and the checklist step 4.
- **Expected:** on the empty month the hero shows the neutral **"Plan your income, then give every euro a job"** prompt and NOT the gold **"Every euro has a job"** badge (UX-017), and checklist step 4 is **not** ticked — because both independently require `TotalIncome > 0`, not merely `remaining == 0` (CAT-041, JRN-010). After planning income to a true zero-remaining balanced state, the gold badge appears AND step 3 ticks in the same load. Neither surface ever celebrates a zero-income month; a regression to bare `remaining == 0` would light up one or both wrongly.
- **Automated:** Partial (client/src/budgetModel.test.ts + DashboardPage.test.tsx cover the hero/selector; client/src/onboarding/Onboarding.test.tsx covers the checklist, but not the two together)

---

## ExcludeFromAllocation × dashboard budget math

### CMB-052 - An ExcludeFromAllocation category is skipped by the allocation engine but still counts in RemainingToBudget/IsBalanced
- **Priority:** P1
- **Type:** Edge
- **Origin:** `AllocationPlanner`/`IncomeAllocator` filter `!c.ExcludeFromAllocation` when summing FundEnvelopes/FundJars, but `BudgetMonth.TotalPlanned` (= Σ planned of every non-Income category) applies **no** such filter — so the two subsystems read the same category differently. The flag is a seed/import-only attribute (no client control sets it), carried by month-copy (CMB-027).
- **Preconditions:** shared household; a month with an Income line (planned **2,000.00**), a normal Expense category (planned **1,500.00**), and an Expense category flagged `ExcludeFromAllocation` — e.g. a "Personal Savings" allocation-output category — planned **800.00**.
- **Steps:**
  1. Read the dashboard hero: Income / Allotted / Remaining and any footnote/badge.
  2. Open `/allocation`: read "Income to allocate", "Shared spending", and the "Cover shared costs" (FundEnvelopes) step total.
- **Expected:** the **dashboard** counts the excluded 800 in `TotalPlanned` → Allotted **2,300.00**, `RemainingToBudget = 2,000 − 2,300 = −300.00` → the hero reads **"€300.00 over-budgeted — trim a line"** and the balanced badge never appears (even though the user feels they "gave every euro a job"). The **allocation** engine EXCLUDES the 800 from FundEnvelopes, so its "Cover shared costs" total is driven by the 1,500 only and the KPI tiles reconcile on the smaller obligation. The same flag is honoured by one subsystem and ignored by the other — a genuine cross-feature inconsistency to surface. After copy-to-next-month the flag survives (CMB-027), so the divergence is stable, not transient.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/AllocationTests.cs asserts the allocation-side exclusion; Domain/RemainingToBudgetTests.cs asserts the unfiltered TotalPlanned; the divergence between them is not asserted together)
- **Resolution note (pocket-money coherence PR):** this asymmetry is now the DESIGNED coherence mechanism, not an accident: an allocation-output category (flagged) is *supposed* to count into the budget's zero while staying out of the engine's envelopes — that is exactly what lets both systems reach zero at once. The Allocation page's reconciliation strip (ALLOC-068/069) surfaces any month where engine promises (pocket money, positive savings) are NOT yet materialized as flagged lines, with a one-click `POST /allocation/pocket-lines/{y}/{m}` fix, and `excludeFromAllocation` is now visible on `BudgetCategoryDto`. The dashboard math is deliberately untouched (PR #172 invariant).

---

## Gap-fill additions

Four seams that the single-feature files and the cases above leave uncovered: the allocation-pool ↔ budget-income decoupling (extends CMB-010/CMB-020), the source-account overdraft × jar-backing-Float interaction on allocation commit (extends CMB-007/CMB-012), split-*slice* member attribution × member archive (extends CMB-022/CMB-025 — those only exercise *whole-transaction* attribution), and an import row dated in a month that does not yet exist (extends CMB-004).

### CMB-053 - The allocation pool tracks member net income, fully decoupled from the budget's Income lines (either can be zero while the other is large)
- **Priority:** P0
- **Type:** Regression
- **Origin:** `IncomeAllocator.Compute` sets `pool = members.Sum(m => m.NetIncome)` (`IncomeAllocator.cs:30`); `AllocationPlanner` fills that `NetIncome` from each member's static `HouseholdMember.NetMonthlyIncome` (`AllocationPlanner.cs:65`) and derives ONLY the FundEnvelopes/FundJars deductions from the month's planned Expense/Savings totals (`AllocationPlanner.cs:37-49`, `Kind == Expense || Kind == Savings`) — the budget's **Income** category is never read by allocation at all. Independently, the dashboard's `TotalIncome`/`IsBalanced` (PR #172) read the month's planned **Income** lines. Two unrelated notions of "income".
- **Resolution note (income-per-person switchover):** the decoupling is now CONDITIONAL: when the viewed month attributes income lines to people, `AllocationPlanner` derives per-member income from those PLANNED lines (unattributed shared equally; `incomeFromBudget`/`unattributedIncome` on the DTO) — the two notions converge on the budget. A month with NO attributed lines behaves exactly as described above (static fallback), which this case continues to pin.
- **Preconditions:** shared household; members Alex (`NetMonthlyIncome` 1,200.50) and Sam (800.25) → pool **2,000.75**; both have a personal savings account set on `/people`; a blank month **2026-09** with an Income group (planned 0) and one Expense line "Groceries"; no jars (so appended savings lines don't muddy the numbers — CMB-020).
- **Steps:**
  1. Open the 2026-09 dashboard hero and `/allocation`; compare the hero **Income** figure with the "Income to allocate" pool.
  2. **Direction A — kill the budget income, keep member income:** leave the Income group at 0 and plan Groceries at **400.00**. Re-read the dashboard hero and `/allocation`; press **Allocate**.
  3. **Direction B — kill the member income, keep budget income:** on `/people` set BOTH members' `NetMonthlyIncome` to **0**, then plan the 2026-09 Income group at **5,000.00**. Re-read the dashboard hero and `/allocation`; press **Allocate**.
- **Expected:**
  - **Direction A:** the dashboard reads `TotalIncome = 0`, `TotalPlanned = 400` → `RemainingToBudget = −400` → the hero shows **"€400.00 over-budgeted"** and never the gold balanced badge (`IsBalanced` false — needs `TotalIncome > 0`, PR #172 / CMB-020). Yet `/allocation`'s pool is **UNCHANGED at 2,000.75** (Σ `NetMonthlyIncome`); FundEnvelopes deducts the 400, residuals ≈ 1,706.61, and **Allocate still writes transfers into each member's savings** (CMB-007). Money moves on `/allocation` even though the dashboard says the month has no income.
  - **Direction B:** the dashboard reads `TotalIncome = 5,000.00` (a real, plannable income), but `/allocation`'s pool is **€0.00** (Σ `NetMonthlyIncome` = 0) — the waterfall has nothing to split, every residual is 0, and **Allocate writes no transfers**. Planned/received income never feeds the pool (CMB-010); member `NetMonthlyIncome` never feeds the dashboard.
  - Net: "budget income" and "allocation pool" are independent axes — **either can be zero while the other is large**. A tester must NOT assert the pool is 0 just because the month's Income lines are empty (nor assert positive-pool from a positive Income line). To move the pool you edit member income on `/people`; to move the dashboard income you edit the month's Income lines. (The blank-month PR #172 rule of CMB-020 governs only the dashboard side of this seam.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/IncomeAllocatorTests.cs asserts `pool = Σ NetIncome`; Domain/RemainingToBudgetTests.cs asserts the `TotalIncome`-gated `IsBalanced`; the two-notion decoupling is not asserted together)

### CMB-054 - Allocation commit drains the source account with no overdraft guard, tanking a jar-backing account's Float
- **Priority:** P1
- **Type:** Boundary
- **Origin:** `AllocateIncomeCommandHandler` writes one `Transfer` per positive-residual member FROM the profile source account (`AccountId = sourceId`) to that member's personal savings account, with **no** check that the source can cover the total (`AllocateIncomeCommandHandler.cs:56-79` — the only gate is `Residual > 0 && SavingsAccountId is Guid`). `AccountBalances` then moves the source down by Σ residuals; reconciliation is `Float = CurrentBalance − BackedJarsTotal` (`GetAccountReconciliationQueryHandler.cs:62`) where `BackedJarsTotal` sums, for jars whose `FundingAccountId` is that account, `OpeningBalance + JarBalances` (planned − spend) — a figure allocation transfers never change.
- **Preconditions:** shared household; allocation profile source account **Joint** (opening **1,250.00**); Alex-Savings and Sam-Savings set on `/people` (opening 0); a Recurring jar **"Emergency Fund"** Held in **Joint** (JAR-021) with tracked balance **300.00**; the 2026-mm month carries little/no shared obligation, so both residuals are large and Σ residuals ≈ the pool **2,000.75** — comfortably more than Joint's 1,250.00.
- **Steps:**
  1. On `/allocation` press **Allocate**, tick **I’ve completed these transfers**, press **Record transfers** and confirm the "Allocated {month} · 2 transfers in transit" strip (ALLOC-050).
  2. Open `/accounts` (Joint's balance and its reconciliation Float), `/jars` (Emergency Fund), and Joint's detail reconciliation table (ACCT-052).
- **Expected:** the commit **SUCCEEDS with no overdraft or validation error** — there is no guard, so allocation happily moves more out of Joint than it holds. Joint's derived balance goes **1,250.00 − 2,000.75 = −856.61** (AccountBalances nets both transfers out; Alex-Savings and Sam-Savings rise by each residual — CMB-007). The jar's tracked balance on `/jars` is **UNCHANGED at 300.00** (JarBalances = planned − spend; allocation transfers are not contributions — CMB-012). So Joint's reconciliation row reads `CurrentBalance = −856.61`, `BackedJarsTotal = 300.00`, **Float = −1,156.61**, rendered in the rose tone (ACCT-054) with **no 500** (Float is a plain subtraction that tolerates a negative). Allocation has physically emptied — and overdrawn — the very account backing the jars, while the jars still "promise" 300; the honest shortfall surfaces exactly in the Float, but nothing blocks the drain. This is the allocation-OUT mirror of CMB-012 (transfer IN raising Float): CMB-007's happy path only asserts a positive-remainder drop, never the overdraft × jar-backing interaction.
- **Automated:** No (tests/AllotJar.IntegrationTests/AllocationRerunTests.cs covers the happy-path transfers; the source-overdraft driving a negative jar-backing Float is not covered)

### CMB-055 - Archiving a member whose spend is entirely via split slices silently drops it from member-spending while the line, reports and account stay whole
- **Priority:** P1
- **Type:** Edge
- **Origin:** `GetMemberSpendingQueryHandler` attributes a split by `slice.MemberId` and a whole tx by `t.MemberId` — **never both** — and filters BOTH against the non-archived member set (`GetMemberSpendingQueryHandler.cs:30` loads `!IsArchived`; the `memberIds` guard is applied at lines 58 and 64). A split parent carries no whole-tx member. Meanwhile category actuals and `/reports` are member-blind and transaction-derived (each slice counts once at the parent's rate — CMB-022, RPT-028), and the account moves by the WHOLE parent amount (ACCT-040, CMB-022).
- **Preconditions:** shared household; members **Alex** and **Sam**; account **Joint**; an Expense line **"Furniture"**; a **200.00** Ikea expense on Joint split **150.00 → Furniture (Alex)** + **50.00 → Furniture (Sam)** — a split whose slices carry per-member attribution (TX-044 + TX-015), so neither member holds a whole-transaction `MemberId`.
- **Steps:**
  1. Before archiving, read `/people` member-spending ("Shared this month" + the per-member Spent column), the Furniture line actual on the budget grid, `/reports` (Furniture category), and Joint's balance.
  2. Archive **Sam** on `/people` (PPL-022 — immediate, no confirm).
  3. Re-read the same four surfaces.
- **Expected:** before archiving, `/people` shows **Alex 150 + Sam 50** (per-slice), Furniture actual **200.00**, `/reports` **200.00**, Joint down **200.00**. After archiving Sam, her **50 slice silently drops** from member-spending (the query keeps only slices whose `MemberId` is in the active set), so `/people` now shows **Alex 150 only** — a household "Shared this month" that no longer sums to the 200 the account actually moved. But the Furniture line actual stays **200.00** and `/reports` stays **200.00** (both member-blind and tx-derived — the slice itself is untouched), and Joint's balance is **unchanged at −200.00** (archiving never rewrites transactions — CMB-045; attribution survives per PPL-025). The seam: per-slice member attribution is roster-scoped (archive hides it) while line actuals, reports and account balance are not, so member-spending can under-count by exactly the archived member's slices while every money rollup stays intact. This is distinct from CMB-025, which archived a member holding WHOLE-transaction attribution.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/MemberSpendingTests.cs covers split-slice attribution and the active-member filter; the split-slice × archive drop combined with the intact line/report/balance is not pinned together)

### CMB-056 - An imported row dated in a not-yet-created month is permanently unattachable from the UI, even after that month is created
- **Priority:** P1
- **Type:** Edge
- **Origin:** `CommitImportCommandHandler` stamps the row's own `Date` and imports it with `BudgetItemId = null` when no line is chosen (`CommitImportCommandHandler.cs:116-130`) — it never requires a `BudgetMonth` to exist for that date. The register is all-time (`GET /transactions`, no month filter), so the row is visible. But `TransactionsPage` loads its picker month from `/budget/current` once on mount and never re-scopes it (`TransactionsPage.tsx:83` `setMonth(budget?.data)` with `[]` deps; line 321 `buildItemOptions(month)`), so the inline **+ Assign** picker only ever offers the **current calendar month's** lines — independent of the top-bar month navigator, and reset to today on every reload (TIME-026). `CreateBudgetMonthCommandHandler` copies/templates/appends structure only and has **no orphan-adoption pass** (`CreateBudgetMonthCommandHandler.cs`), so creating the missing month later never retro-attaches the row; attribution is a stored `BudgetItemId` set only at assign time (`AssignTransactionCommandHandler`, which itself accepts any owned line regardless of month).
- **Preconditions:** shared household; today is in **July 2026** (a 2026-07 budget exists and is the current month); **NO 2026-06** budget month; import account **Joint**.
- **Steps:**
  1. Import a CSV with one row dated **2026-06-14** for 40.00; leave its category **"Unassigned"** in review; commit.
  2. On `/transactions`, open that row's inline **+ Assign** picker and inspect the options.
  3. Create the missing **2026-06** month (blank OR copy-from-previous); re-open the row's picker; also open the 2026-06 budget grid.
- **Expected:** the row **imports fine** (1 imported; its `BankReference` dedups future re-imports — CMB-003) but contributes to **no** budget actual (`BudgetItemId = null`) and shows on the all-time register as **Unassigned** (+Assign pill). Its assign picker offers **only 2026-07's** lines — there is **no 2026-06 option** to point it at, because the picker is `/budget/current`-scoped (TIME-026), not tied to the row's date nor to the navigator. Creating 2026-06 afterward does **NOT adopt** the orphan: the row stays **Unassigned**, and its picker **still shows only July's lines** — the fresh June lines never appear (the register never re-scopes to June; month-create has no adoption step). The only ways to attribute it are to wait until 2026-06 is again the current calendar month (never, going forward) or to call the assign API directly (which accepts any owned line — `AssignTransactionCommandHandler`). Import × month-create × time-scoped attribution combine to strand the row. Contrast CMB-004, where the target month's line already existed at assign time.
- **Automated:** No
