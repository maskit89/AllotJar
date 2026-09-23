# Test review and development validation

Prepared 22 September 2026 against commit `638ba87`. This is a targeted review of the affected suites, not a claim that every test was individually audited. The user requested coverage for new code, review of existing tests and removal of unnecessary tests. Tests now change alongside their corresponding implementation; see [DEVELOPMENT-LOG.md](DEVELOPMENT-LOG.md) for current changes and results. The table below records the original inspected baseline, not a statement that every listed conflict is already fixed.

## Existing evidence and test layers

The earlier audit ran 789 backend tests and 659 frontend tests in 56 files, all passing. Those counts are historical, not fresh results from this handover. Several tests intentionally assert behaviour now rejected by the agreed rules, so a green baseline is not evidence of correct accounting semantics.

- `tests/AllotJar.Application.Tests`: xUnit/FluentAssertions, pure calculations and handlers; many handlers use EF InMemory. Useful for behaviour but not relational constraints, SQL translation or transactional integrity.
- `tests/AllotJar.IntegrationTests`: real SQL Server migrations, foreign keys, concurrency, uniqueness and HTTP authorisation. Excluded from `AllotJar.slnx`; running the solution tests does **not** run these.
- `client/src/**/*.test.*`: Vitest and Testing Library with mocked API responses. Useful for labels, forms, confirmations and refresh behaviour, but do not prove frontend/backend arithmetic agreement.
- `client/e2e`: Playwright with stubbed API, primarily accessibility/layout/interaction. Do not describe this alone as real end-to-end ledger validation.
- `client/e2e-journey`: real API + SQL journeys, including transfers, import lifecycle, transaction actuals, allocation, household roles and first-month currency. Extend affected journeys rather than adding a separate redundant harness.
- `.github/workflows/ci.yml` has distinct backend, integration, journey, frontend and accessibility jobs. Preserve that separation.

## Inspected conflicts and gaps

Paths below are relative to the repository root. Review sibling tests in the same area when changing a behaviour, including `*.catalog*` files; the table identifies concrete starting points, not permission to bulk-delete a suite.

| Existing test / location | What was inspected | Required disposition |
| --- | --- | --- |
| `Application/JarBudgetLinkTests.cs`, `CreateJar_PlantsItsLineInTheCurrentAndFutureMonths` | Expects plans 100 + 91.67 to create balance 191.67 and monthly requirement 84.03, with no deposit | Replace those assertions under rules 1/17. Retain checks that intended plan lines are created once; creating plans must leave actual money unchanged. Use an explicit contribution/deadline. |
| `Application/AllocationIncomeFromBudgetTests.cs`, `NoAttributedLines_FallsBackToStaticIncomes` | Expects static defaults 9999 + 8888 despite budget income 4000 | Replace with selected budget income and no-default fallback, including zero income. Attribution distribution is O4, not resolved by keeping the old expected result. |
| Same file, `UnattributedIncome_IsSharedEqually_LastMemberAbsorbsTheRemainder` | Existing test name codifies an attribution/tie-break policy | Hold policy-specific assertion changes until O4 is answered. Preserve total conservation coverage. |
| `Transactions/FxRateResolverTests.cs`, `Apply_ConvertsForeignToBaseAndSetsRate`, `Apply_DefaultsToEur_WhenNoBudgetForThatMonth`, `Import_AllDuplicates_StillReconcilesPendingRows` | Tests expect automatic rate application/default EUR and background-style reconciliation | Retire/replace automatic posting assertions as the feature is removed/reworked. Add supplied-amount precedence and explicit approval tests. A suggestion provider may remain, so do not delete all provider tests blindly. |
| `Transactions/FxPendingAggregatesTests.cs`, `ReconcileAllPending_ResolvesEveryOwnersRows_WithoutAnImport` | Expects automatic mutation of pending rows across owners | Replace obsolete background conversion behaviour. Preserve owner isolation and the invariant that an unapproved amount cannot affect totals. |
| Same file, `JarBalances_ExcludePendingSpending` | Treats a planned 200 as contributed money, then subtracts 50 | Rewrite its funding setup with real account/jar allocations. Retain the meaningful exclusion/approval concern under the new model. |
| `Application/SyncPocketMoneyLinesTests.cs`, `Sync_SkipsArchivedMembers_AndLeavesUnmatchedLinesAlone` | Keeps an unmatched named line and adds a new member line | Do not treat this as a rename guarantee. Add stable-ID rename and archive future/current-choice tests; preserve genuinely unrelated manual lines instead of indiscriminately deleting them. |
| `Application/AnnualSummaryTests.cs`, `Annual_ReturnsTwelveMonths_WithBudgetsFilledAndGapsEmpty` | Asserts income 1000 from plan alone, with no income receipt | Retain planned-income expectation under an explicit planned field; add actual income and signed Variance assertions. Retain year, owner and empty-month coverage. |
| `Domain/JarAccrualCalculatorTests.cs` | Covers straight-line /12, proportional-pool zero and daily-rate modes as well as target-by-date | Add agreed schedule examples. Decide O6 before removing those modes/tests. Do not preserve unapproved modes solely because tests exist. |
| `Domain/IncomeAllocatorTests.cs` | Hand-computed nontrivial allocation and sum invariants are present | Retain; add tiny-pool/many-recipient cases and prove both conservation and non-negativity. Do not infer who wins a tied leftover cent. |
| `client/src/pages/JarsPage.catalog.test.tsx`, JAR-021 no-account case | Expects a “No account” option and earmarking helper | Replace with required designated savings-account behaviour and useful setup validation; preserve permission/error-state tests. |
| `client/src/pages/JarsPage.test.tsx`, archive flow | Checks two-click archive request; no zero-balance guard in the inspected flow | Retain confirmation intent, use a zero-balance success fixture and add nonzero-balance resolution coverage. |
| `client/src/lib/money.test.ts` | Tests parsing and edit formatting separately; `toEditString` examples only use the default format | Add composed edit-string-to-parse round-trips for every supported format and stored precision, especially 1.234 with comma decimals. Do not just alter the parser expectation and break grouped input. |

Backend table paths prefixed `Application/`, `Domain/`, `Transactions/` are inside `tests/AllotJar.Application.Tests/`.

## Required regression scenarios

Use independently hand-computed expected values from AGREED-RULES rather than copying the production formula into tests. Cover new behaviour at the lowest useful level, then add higher-level coverage where persistence or user interaction changes the risk.

1. **W01/W05 ledger:** plan-only create/edit/seed leaves actual balance unchanged; opening 600 is included exactly once; designated-account enforcement; actual split funding and unallocated remainder; negative jar allowed with sufficient account funds; insufficient savings rejected/held for import review; same-account and cross-account conservation; historical cutoff and backdated correction. Verify failed/declined actions leave all related records unchanged.
2. **W02 scheduling:** 300 due 1 December from September => 100/100/100; only 50 actually saved in September => 125/125; plan125/actual50/remaining75 within month; final33.34 after33.33/33.33; mid-month default vs explicit final-month contribution; monthly31 anchor through leap February/March/April; fixed target250 at100 =>100/100/50; ongoing saving has no catch-up; no implicit /12 fallback; estimate is not deadline; over-allocation remains visible.
3. **W03/W04 lifecycle:** funded then paid before due is successful; rollover/dismissal/completion changes no money; missed notice persists and late funding is labelled; lower bill carries only real remainder; edit preview cancellation vs confirmation; excess above lowered target preserved; completed one-off does not restart; archive at zero removes applicable future plans and preserves history; skip preview and skipped-month resync. Implement unresolved negative-completion/reopening cases only after agreement.
4. **W07 import:** both statement sides, either import order, distinct bank references, manual transfer followed by import, re-import, two legitimate same-amount transfers, ambiguous candidate choice/cancel, concurrent commit and all-or-nothing persistence. Keep amounts/identifiers/account/date fixtures realistic; use real SQL for uniqueness/atomicity guarantees.
5. **W08 currency:** bank/user amount unchanged; missing amount never posted as 1:1; suggestion approval required; decline/cancel has no effect; repeated approval cannot double-post; already supplied amount bypasses suggestion; no inferred fee; no mixing raw currencies into one labelled total. Define O5's holding workflow before asserting its exact UI/API contract.
6. **W06/W09/W11 People:** selected-month pool vs static defaults; zero budget income; consistent period; tiny equal allocation total0.02 across4 has no negative shares; committing cannot exceed source pool; rename same person ID; archiving stops future plans, prompts current-month choice and leaves actual payments intact.
7. **W12 reporting:** 500 spending includes100 uncategorised; categorising changes grouping only; planned3000/actual2800 => variance-200 and actual3200 =>+200; income excludes internal transfers/refunds; September100 purchase/October20 refund =>100/-20 and80 combined; purchase/refund history retained. Add split and uncategorised cases and verify agreement across annual/trend/People views where they share a definition.
8. **W13 privacy/joint:** after O8 is answered, verify read/write permissions at API and query level, not just hidden controls. A joint account is counted once; private information must not leak through aggregates, exports, matching suggestions or shared jars. Preserve current cross-household isolation coverage throughout.
9. **W10 editing:** round-trip amount through actual form formatting/parsing for supported preferences, including 0, 1.234 and four-decimal stored values. Include a form save regression so an unchanged amount cannot become 1000 times larger.

Pin clock/date and locale for schedule tests. The current jar seeding test reads `DateTime.UtcNow`; replace timing-dependent fixtures with controllable time where practical. Table-driven boundary tests should exercise real branches, not repeat an identical happy path hundreds of times.

## Retain, replace, consolidate, remove

### W01 calculation foundation review — 23 September 2026

The new `Domain/ActualAccountLedgerTests.cs` and `Domain/ActualSavingsLedgerTests.cs` use independently computed balances, not copies of the production formula. They cover opening-date boundaries, unavailable history, actual split funding, explicit unallocated funds, negative jars versus account deficits, same-account reallocation, completed cross-account transfers, exact sub-cent conservation, duplicate identities, wrong account/owner/currency, and incomplete or inconsistent allocations. The pure calculation result can describe an invalid candidate (deficit flags); it is not a write-authorisation decision.

Rule 68 adds separate `Domain/JarReallocationRulesTests.cs` coverage for the write-validation decision: a 100 source cannot supply 150 even with 500 in its account; exactly 100 is permitted; negative source balances from actual spending remain visible but supply no reallocation; cross-account moves also respect bank funds; same-account ownership changes do not debit bank funds a second time. Additional cases cover explicit unallocated sources, unknown jars, unavailable dates, deficits, non-positive requests and stored precision. These tests complement the read-calculation cases rather than replacing the agreed negative-jar behaviour. No further existing test is obsolete solely because this guard was added.

Three existing endpoint tests were inspected in detail and labelled `LedgerModel=LegacyPlanned`: `LegacyJarRead_CountsPlannedContributionsAsMoney`, `LegacyJarAndGridReads_DisagreeAboutOpeningMoney`, and `CreateJar_PlantsItsLineInTheCurrentAndFutureMonths`. Their old arithmetic is a known defect, not acceptance criteria. The new engine is not yet wired to those endpoints, so changing their expected numbers now would fabricate coverage of an unimplemented integration. Replace their monetary expectations and fixtures when activating W01, retaining owner isolation, correct line creation and shared-cutoff consistency checks.

Removed the third, redundant difference assertion from the jar/grid comparison: the preceding assertions independently retain the expected jar and grid balances. Renamed misleading tests and removed the comment describing their disagreement as legitimate. No suites were deleted, no failures were skipped, and the legacy marker does not exclude these tests from CI. The general policy below still applies.

- **Retain:** ownership/authorisation, relational constraints, arithmetic invariants, idempotency, cancellation/no-side-effect, malformed-input and meaningful UI interaction coverage.
- **Replace:** assertions of explicitly superseded behaviour. Prefer a named regression of the agreed rule to simply deleting the old test.
- **Consolidate:** genuinely duplicate cases that exercise the same behaviour at the same layer. Existing standard/catalog/supplemental names alone do not prove duplication; compare setup, action and failure detection first. UI, handler and SQL checks may intentionally cover different risks.
- **Remove:** dead-feature-only tests when that feature is actually removed, or exact duplicates after equivalent protection is demonstrated. Record the test name, reason and retained/replacement test in the implementation change notes. Do not delete historical EF migrations as “obsolete tests”.
- No blanket deletion list is justified by this targeted review. In particular, rate-provider tests may support the now-approved suggestion-only feature, and legacy accrual modes still need a product decision.

## Execution and completion criteria

Run targeted regressions with the corresponding implementation, then the full affected suites once the change is coherent. Do not repeatedly rerun unchanged suites without a new reason.

From repository root:

```powershell
dotnet test tests/AllotJar.Application.Tests/AllotJar.Application.Tests.csproj -m:1 -nr:false
dotnet build AllotJar.slnx -c Release -m:1 -nr:false
```

From `client`:

```powershell
npm run test
npm run build
npm run lint
npm run test:e2e
```

For schema/ledger work, also run the relevant SQL integration and real-backend journeys:

```powershell
# Repository root, after verifying the test database target:
dotnet test tests/AllotJar.IntegrationTests/AllotJar.IntegrationTests.csproj -m:1 -nr:false
# From client, against the dedicated journey database:
npm run test:e2e:journey
```

`SqlServerFixture` calls `EnsureDeletedAsync` before applying migrations. Check `INTEGRATION_TEST_CONNECTION` points to a disposable test database before running it; its default is `AllotJar_IntegrationTests` on LocalDB. Journey config uses `JOURNEY_TEST_CONNECTION` or `AllotJar_Journey`. Never use the user's working ledger database. Browser dependencies and local SQL availability must be checked; neither suite was run in the original audit. Commands are a plan, not a claim of execution in this handover.

Completion for each work item requires: agreed behaviour implemented, matching regressions passing, relevant API/SQL/UI paths validated, meaningful obsolete tests updated/removed with reasons, no undocumented assumptions, and exact validation evidence in the handover/change description. Report any tests not run and why. Do not claim blanket correctness from counts or line coverage alone.
