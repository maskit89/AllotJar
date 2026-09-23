# AllotJar calculation review — 22 September 2026

Historical audit evidence at commit `638ba87`. Read [HANDOVER.md](HANDOVER.md) and [AGREED-RULES.md](AGREED-RULES.md) for subsequent decisions: the "Decision needed" paragraphs below describe questions at audit time, not today's entire outstanding list. The user later clarified that the app is not live. Old FX examples explain the defect; they do not authorise automatic conversion under the new rules. This repository copy and the adjacent reproductions supersede the sibling review directory as the maintained handover.

Reviewed local checkout `ZeroBudget`, commit `638ba87`. No application source, settings, ledger data, or deployment was changed. Review artifacts and isolated reproductions are in this separate directory. The two pre-existing untracked paths in the repository remain unchanged.

This is a broad code and calculation review, not proof that every path is correct. Production version and real household data were not accessed. Examples below are synthetic; they do not claim to reproduce the exact incident described in the handwritten notes.

## Evidence and coverage

- Backend application/domain suite: **789 passed**. Frontend suite: **659 passed, 56 files**.
- Inspected jar creation/editing, monthly seeding, carry-forward, opening balances, projections and recurrence; budget totals and actuals; People and income allocation; account balances and reconciliation; transaction assignment/splits/transfers; import and exchange-rate handling; report aggregates; money parsing and display.
- SQL Server integration tests, browser end-to-end tests and live-site comparison were not run. Existing unit tests primarily use EF InMemory and cannot establish relational correctness.
- `reproduce.ps1` compiles the actual pure C# source in memory, changing only namespace packaging/imports for compilation. It reproduces recurrence, projection, no-date goal and small-split cases.
- `reproduce-client.mjs` runs the actual extracted browser date helpers with a fixed date and imports the actual money parser.
- `HandlerChecks.csproj` / `Program.cs` execute actual compiled application handlers against disposable in-memory databases. These use the assemblies rebuilt by the backend test run; rebuild the tests before using this harness after any source changes. No live database connections are used.
- Existing passing tests sometimes assert the problematic behaviour: `JarBudgetLinkTests.CreateJar_PlantsItsLineInTheCurrentAndFutureMonths` explicitly expects future planned contributions in the current balance and a changed required monthly amount.

## Findings: jars and budget consistency

### J1 — Creating a jar changes the meaning of its monthly amount; future plans count as current savings [high; reproduced]

With a €1,200 goal, no date, zero opening balance and current/next-month budgets already created:

| Stage | Amount |
|---|---:|
| Initial preview | €100/month |
| Current budget contribution created automatically | €100 |
| Next-month contribution created automatically | €91.67 |
| Jar's immediate “current balance” | €191.67 |
| Jar's immediate monthly requirement | €84.03 |

No bank transaction occurred. `CreateJarCommandHandler` seeds current and future months, adds every seeded contribution to `planted`, then recalculates the card from that balance. `GetJarsQueryHandler` uses all-time `JarBalances`, preserving the discrepancy on reload. Account reconciliation uses that same all-time balance. Even creating a future budget later can change today's apparent savings and reconciliation float.

Evidence: `src/AllotJar.Application/Jars/Commands/CreateJar/CreateJarCommandHandler.cs:67–81`; `Jars/JarBalances.cs`; `Jars/Queries/GetJars/GetJarsQueryHandler.cs`; `Accounts/Queries/GetAccountReconciliation/GetAccountReconciliationQueryHandler.cs`.

**Decision needed:** whether a current-month budget allocation itself counts as saved money, or only a confirmed contribution does. Future plans and present balances need distinct treatment either way. Also distinguish the month's planned contribution from the additional amount still required.

### J2 — Budget “Available” omits the jar's opening balance [high; reproduced]

Opening €600, target €1,200, no date, one current budget: budget planned **€50**, budget available **€50**, jar balance **€650**, jar monthly **€45.83**. The €600 discrepancy in available balance is independent of future-month handling.

`BudgetActuals.ApplySavingsBalancesAsync` sums planned minus spent but never includes `Jar.OpeningBalance`; jar cards and reconciliation do include it. Evidence: `src/AllotJar.Application/Budgets/BudgetActuals.cs:174–187`.

**Acceptance case:** with the same cutoff date and no other differences, the jar balance and its budget available balance reconcile including the opening amount exactly once.

### J3 — Browser and server disagree on recurring due dates [high; reproduced]

As of **22 September 2026**, a €1,200 annual recurring jar due **1 September 2026**, opening zero:

- Browser preview: **€1,200/month**, retains 1 September 2026.
- Server calculator: effective due date **1 September 2027**, **€100/month** before seeded contributions.

The browser ignores the day when deciding whether a cycle has passed; the server checks the complete date. Browser recurrence also constructs impossible dates: the 31 January monthly anchor becomes **31 September** in September rather than clamping to 30 September.

Evidence: `client/src/pages/JarsPage.tsx:33–63`; `src/AllotJar.Domain/Services/JarAccrualCalculator.cs`, `EffectiveTargetDate`.

**Acceptance cases:** overdue earlier this month, exact due day, leap February and month-end recurrence must agree between preview and server.

### J4 — Rounded monthly amounts can push the advertised finish a month late [medium; reproduced]

€100 due in three calendar months produces €33.33/month. Multiplying gives €99.99. The projection then takes `Ceiling(100 / 33.33) = 4`: as of 22 September, the goal due 22 December advertises **22 January**. Future recalculation may correct the last payment, but the projection assumes a constant rate and contradicts that schedule.

Evidence: `src/AllotJar.Application/Jars/Dtos/JarDto.cs:80–81`; `JarAccrualCalculator.TargetByDate`.

**Decision needed:** payment timing (current month included or not), and handling the final rounding remainder. Validate the actual schedule, its sum, and the displayed finish together.

### J5 — Editing a jar leaves existing budget contributions unchanged [medium; code-confirmed]

Changing a target or due date updates the jar and its recommendation, but does not update any already-created monthly budget lines. Renaming it also leaves the linked line names unchanged. New months use the changed definition; existing months retain the old figures.

Evidence: `src/AllotJar.Application/Jars/Commands/UpdateJar/UpdateJarCommandHandler.cs:38–61`; monthly seeding in `Budgets/Commands/CreateBudgetMonth/CreateBudgetMonthCommandHandler.cs`.

**Decision needed:** which existing/future plans should recalculate and how to preserve manual overrides. Do not silently rewrite history.

### J6 — Budget's jar shelf becomes stale after edits and ignores the selected month [medium; code-confirmed]

The shelf fetches `/jars` once on mount, with no month parameter. Editing a savings amount updates the budget response but does not refresh the shelf. Changing the selected budget month still leaves the shelf showing the same all-time jar figures.

Evidence: `client/src/pages/DashboardPage.tsx:122–129` and the budget mutation callbacks. `GetJarsQueryHandler` accepts an as-of date for recommendation calculations but still reads all-time balances.

**Decision needed:** whether the shelf should be an explicitly labelled current snapshot or a view of the selected month. It must refresh when its inputs change.

## Findings: People, allocations, accounts and transactions

### P1 — People/allocation can use a different income pool from Budget [high; reproduced; rule decision required]

Budget income €2,000, person default income €3,000, no income assigned to a person: allocation uses **€3,000**. The switch to budget income only activates when an active person has positive attributed income. Even zeroing attributed income can return the calculation to old defaults.

People also always requests the real current month, whereas Budget has a selected month. Its income-share percentages come from saved default incomes even when the displayed income amounts come from budget lines. With defaults €1,000/€1,000 and budget income €3,000/€1,000, displayed shares remain 50%/50% beside amounts implying 75%/25%.

Evidence: `src/AllotJar.Application/Allocation/MemberIncome.cs`; `Allocation/AllocationPlanner.cs:61–85`; `Household/Queries/GetHouseholdMembers/GetHouseholdMembersQueryHandler.cs`; `client/src/pages/PeoplePage.tsx:113–115,163–170,479–493`.

**Decision needed:** agreed source of income, treatment of unassigned household income, and a shared month context. The current fallback is explicit code, not random arithmetic, but can allocate money absent from the budget.

### P2 — Per-person income/spending ignores exchange rates and pending FX [high when foreign currency is used; reproduced/code-confirmed]

The member income handler returns **100** for £100 at €1.20/£, where the budget-side converted amount is **€120**. Both whole and split member totals use raw amounts, and neither member handler excludes pending exchange rates. Member spending is all-time, adding another period difference from monthly budget figures.

Evidence: `src/AllotJar.Application/Household/Queries/GetMemberIncome/GetMemberIncomeQueryHandler.cs:52–72`; `GetMemberSpending/GetMemberSpendingQueryHandler.cs:48–66`.

### A1 — Importing both sides of a transfer can move the money twice [high; reproduced]

Start A=€1,000, B=€0. Import A's €100 outgoing transfer and B's €100 incoming transfer, each with its own bank reference and correctly selected counterparty. Result: **A=€800, B=€200**, two transfers, rather than A=€900/B=€100.

Each imported row already updates both accounts. Deduplication recognizes matching references, but different banks can use different references for the same movement. There is no pairing of those two statement entries into one movement in this path.

Evidence: `src/AllotJar.Application/Imports/Commands/CommitImport/CommitImportCommandHandler.cs:82–90,125–154`; `Accounts/AccountBalances.cs`.

**Acceptance case:** both statement sides must reconcile to one movement without incorrectly merging separate transfers of the same amount. Matching/confirmation rules need agreement.

### A2 — Currency totals and allocation transfers can mix incompatible units [high when foreign currency is used; code-confirmed]

- Accounts adds raw balances across currencies, labels the sum in the preferred currency, and shows a warning. €100 plus £100 is displayed as a 200-unit total without conversion.
- Allocation verifies source/destination accounts share a currency, but not that it matches the budget's base currency. A residual calculated from an EUR budget can be recorded with the same numeric amount as a GBP transfer between two GBP accounts.
- Jars have no currency field and the funding-account link is not validated against a budget currency. Reconciliation subtracts jar totals directly from the account balance.

Evidence: `client/src/pages/AccountsPage.tsx:182–208`; `src/AllotJar.Application/Allocation/Commands/AllocateIncome/AllocateIncomeCommandHandler.cs:96–115`; `Accounts/Queries/GetAccountReconciliation/GetAccountReconciliationQueryHandler.cs`; jar create/update handlers.

**Acceptance case:** totals in different units must be separated or explicitly converted; a display preference must not imply conversion.

### A3 — Tiny equal allocations can become negative [medium; reproduced]

Splitting €0.02 equally between four people gives **€0.01, €0.01, €0.01, −€0.01**. Independently rounding the first shares and putting all the remainder on the last person conserves the total but breaks non-negativity. The balance-tilt correction has a similar risk with enough rounded shares. With positive residuals committed and negative residuals skipped, tiny allocations can also book more positive transfers than the pool.

Evidence: `src/AllotJar.Domain/Services/IncomeAllocator.cs:119–125,154–170`; allocation commit skips non-positive residuals. The reproduced case is the equal split.

### A4 — Editing under comma-decimal preferences can multiply a value by 1,000 [high for three-decimal stored amounts; reproduced]

`toEditString` renders 1.234 as `"1.234"` regardless of locale. Under dot-comma preferences, `parseMinor` treats that string as a grouped integer and reads **1234**. A three-decimal stored/imported amount can therefore change merely by opening and saving its edit form. Two-decimal EUR values do not trigger this particular case.

Evidence: `client/src/lib/money.ts`, `toEditString` and `parseMinor`; the jar edit form uses both. Reproduction: original 1.234 → edit text `1.234` → parsed 1234.

### A5 — Exchange-rate lifecycle has unresolved inconsistencies [high when triggered; code-confirmed]

- Imports without an existing budget assume EUR, even for households whose first budget will use a different currency. Creating that budget later does not rebase already-resolved transactions.
- Changing a transaction's date does not recalculate its historical exchange rate.
- Changing the amount of an FX-pending transaction clears its pending flag while preserving its foreign currency and placeholder rate 1. Correcting £100 to £90 can consequently make the budget treat it as €90 and prevent later rate reconciliation.

Evidence: `src/AllotJar.Application/Transactions/FxRateResolver.cs`, `ResolveAsync`; `Transactions/Commands/UpdateTransaction/UpdateTransactionCommandHandler.cs:149–161`; `Budgets/Commands/CreateBudgetMonth/CreateBudgetMonthCommandHandler.cs`, currency selection.

### A6 — Pocket-money sync can leave duplicate/obsolete budget amounts [medium; code-confirmed]

Sync identifies people by display name. Renaming a person and syncing creates a new line while leaving the old amount; archived members' lines also remain. Allocation counts active people, but Budget still counts those leftover expense lines, producing another difference between the two totals.

Evidence: `src/AllotJar.Application/Allocation/Commands/SyncPocketMoneyLines/SyncPocketMoneyLinesCommandHandler.cs`, name matching loop and explicit leftover preservation.

**Decision needed:** preserve spending history while stopping obsolete future plans; use stable identity for synchronization.

## Concerns needing your intended rules before fixes

These are observed behaviours, not assumed requirements or automatically approved changes.

1. **Goals without dates shrink the contribution every month.** The remaining balance is divided by 12 anew. A €1,200 goal gets only **€777.61** after 12 recalculated contributions, rather than €1,200. This is reproduced, but no deadline is set, so a 12-month completion promise must not be invented. Does a no-date goal mean fixed saving each month, or an optional recommendation?
2. **Opening-balance dates are stored but ignored.** `OpeningAsOf` does not bound the tracked history. Backfilling earlier budgets can double-count savings already represented by the opening amount. What date begins the tracked ledger?
3. **Recurring jars roll missed dates forward.** That can remove an overdue warning even if the expense was never paid. Fully funded recurring jars also recommend zero until recorded spending reduces their balance. Should overdue obligations remain visible separately from the next savings cycle?
4. **Other accrual methods differ from target-by-date.** Straight-line and daily-rate contributions do not stop at full funding. Daily-rate always uses 365, including leap years. Proportional-pool callers supply no pool amounts, so their displayed requirement is zero even when copied budget lines are funded. Imported/legacy jars using these methods need explicit intended rules.
5. **Reports are based on assigned transactions.** Unassigned spending/income is absent from actuals; reports can appear complete although money is missing. Pending FX is excluded, but report DTOs do not propagate the incomplete-total count. Annual “Income” is planned income while trend income received and savings use actual assigned income. Decide what each report represents and how it flags incomplete data.
6. **Refunds cannot reduce an expense line through the normal direction rules.** A credit is income and cannot be attributed to an expense/savings line; non-negative amounts prevent entering a negative expense. Agree how refunds/reimbursements should restore category or jar balances.
7. **Archiving is not deleting.** Archiving hides jars and prevents lines in subsequently-created months, but leaves existing future plans. Deleting a savings line leaves its backing jar active, so creating another month can recreate the line. This may explain the “Delete jar” note; expected history preservation and future behaviour need discussion.
8. **Contribution timing and currency rounding are not one explicit rule.** Month differences ignore the day; current-month seeding uses the first day while cards use today's UTC date and the browser uses local time. Calculators round to two decimals while storage supports four and display supports currencies with other decimal counts. Agree schedule boundaries before changing formulas.

## What appears sound in the reviewed paths

- Core planned budget arithmetic agrees across client/server: income minus expense plans minus savings plans, with a separate positive-income condition for “balanced”.
- Whole and split transaction assignment is centralized; splits must equal the parent and cannot coexist with a whole-line assignment. Direction, ownership and cross-month acknowledgement have explicit guards.
- Account balances use opening plus income minus expenses and apply both transfer legs once per stored transfer; the transfer import defect arises from creating two records for one movement.
- Budget/jar spending excludes pending FX and converts resolved amounts; the member/report completeness inconsistencies above are narrower gaps.
- Four-decimal storage and integer client arithmetic reduce ordinary floating-point summation drift. They do not by themselves resolve rounding, date scope, or mixed-currency errors.

## Suggested discussion order

Start with **J1/J2**: agree what “saved”, “available”, and “monthly contribution” mean and whether plans count as savings. Then settle monthly payment timing and final-cent treatment (**J3/J4**), then People income/month consistency (**P1**). Keep the transfer import bug (**A1**) high priority because it changes account balances. Review the remaining confirmed defects and rule questions individually. The handwritten rename, new jar categories, unlimited savings and joint-account requests remain recorded; no feature redesign has been assumed.

This report is a review backlog, not an implementation specification. No proposed rule changes have been approved on the user's behalf.
