# Development log

## First implementation batch — validated locally, 23 September 2026

User authorised development after the review and handover. Base commit `638ba87`; see the release record below for subsequent commits and PRs. Preserve unrelated untracked `docs/audit/` and `docs/ops/user-lookup-queries.sql`. No database reset has been performed.

### Work in this batch

- **W10/A4 — implemented:** shared editable-money formatting uses the selected decimal separator without losing stored precision. Whole/split transaction editing now uses the same helper instead of `String(amount)`. Regressions cover all five formats and unchanged positive/negative account saves. Tests reproduced 1.234 becoming 1234 before the fix. Other monetary input initializers were checked; percentage/count fields remain unchanged.
- **W02/J3, rule62 — partial:** browser preview amount and due date share one anchored, date-aware recurrence calculation. Short months clamp only that occurrence, including leap February, and later dates restore the anchor day. Preview uses the server's existing UTC date basis; tests cover local midnight/month-boundary differences in Malta and New York. Backend date logic already clamps correctly. This does not implement the separately agreed missed-deadline lifecycle; the existing automatic rollover model still requires replacement under W03.
- **W08/A2, rule63 — partial:** allocation commits validate source currency against the selected owned budget before touching prior transfers. Existing source/destination currency validation remains. Missing owned budget is rejected, not assigned an inferred currency. This closes the EUR-budget-to-GBP-accounts posting bug, but broader automatic FX removal/approval and account/jar linkage enforcement remain open.
- **W09/A3, rules52/64 — implemented:** shared rounding floors calculated shares to cents, then distributes the remainder by fractional size and displayed order. Equal, income-ratio and balance-tilt splits conserve the exact total without negative shares. Stored sub-cent amounts are conserved without silently changing precision policy. Handler regression verifies a 0.02 remainder across four people records only two 0.01 transfers; no extra money is committed.
- **W01:** traced actual-account/jar model and all relevant write paths. Not implemented by merely dropping plans from a sum; see foundation notes below.

### Test maintenance

Meaningful existing tests were retained. `JarLifecycleTests.EffectiveDate_PreservesMonthEndDay_AcrossRolls` was replaced by an eight-case theory, preserving its protection without a redundant standalone example. New regressions cover real observed failures and independent accounting invariants. No further obsolete tests belonged to the behaviours removed in this batch, so no blanket deletion was made. Automatic-FX and plan-as-money tests remain for replacement with their future corresponding implementations, not silent acceptance of the old rules.

### W01 foundation notes for the next developer

`Transaction` records account movement; `TransactionSplit` records budget attribution. Transfers currently cannot be split across budget lines. Add a distinct jar-allocation model rather than allowing transfers to masquerade as income or expenses.

The candidate model is signed, dated allocations associated with an operation, jar and account; transaction-backed entries also identify the relevant transaction/account leg. Initial allocations and same-account reallocations divide existing account money and create no bank movement. Unallocated funds reconcile account actuals minus signed jar balances. This is a technical design proposal, not yet deployed schema or a new product rule.

Implementation must cover:

1. Dated account openings (the current `Account` has no opening date), jar designation and ownership/currency validation, and persistent operation identity.
2. Initial allocation, transaction funding/withdrawal splits and same-account reallocation; outgoing funds identify the jar/unallocated sources.
3. Completed cross-account transfers with explicit user confirmation and idempotent pairing of imported statement sides.
4. One shared dated balance service used by JarBalances, BudgetActuals savings availability, CreateJar responses and account reconciliation. Planned amounts must never enter actual sums.
5. All write paths: create/update/delete transaction, transfers, both imports, allocation commits and account-opening edits. A protected manual-transfer path alone leaves bypasses.
6. Automatic savings-line jars in AddBudgetItem, templates and registration seeding must obtain a savings-account selection. Do not create valid-looking unbacked jars or assign an arbitrary account.
7. Account deletion must not detach jar/transaction history. Additive schema changes must preserve development data until handling is agreed; no invented opening dates or planned-as-actual backfill.
8. SQL transaction/concurrency protection for withdrawals. Read-then-save sufficiency checks alone can overdraw savings under concurrent requests.

Questions still relevant before affected foundation paths are activated: handling existing local sample data with missing account/opening date (O12), import reconciliation/order (O1), changing a jar's designated account after money/history exists (O3). Account/budget currency policy was answered in rule63; do not ask it again. Questions on unrelated features do not block the bounded fixes above.

### Validation record

All commands below ran against the combined first-batch changes. Paths are relative to the repository root unless stated otherwise.

| Check | Result |
| --- | --- |
| Pre-fix W10 regressions | Failed as expected: unchanged 1.234 amount became 1234; transaction split edit also broke. |
| Pre-fix W08 guard regressions | Both failed as expected: mismatched budget currency and absent owned budget were not rejected. |
| Pre-fix W09 regressions | Six cases failed as expected, showing negative shares in equal, income-ratio and all tested balance-tilt settings. |
| Targeted combined domain/allocation/lifecycle tests | 69 passed before the additional commit-level regression. |
| `dotnet test tests/AllotJar.Application.Tests/AllotJar.Application.Tests.csproj --no-restore -m:1 -nr:false -p:UseSharedCompilation=false --verbosity minimal` | **809 passed**, 0 failed, 0 skipped. Includes commit-level tiny-pool regression. |
| From client: `npm run test:quiet` | **683 passed in 56 files**. jsdom prints existing navigation-not-implemented messages; no test failures. |
| `dotnet build AllotJar.slnx --no-restore -m:1 -nr:false -p:UseSharedCompilation=false --verbosity minimal` | Passed, 0 warnings/errors. |
| From client: `npm run build` | TypeScript/Vite/prerender passed; Vite warns about a bundle exceeding 500 kB. |
| From client: `npm run lint` | Fails with **37 errors, 4 warnings** across the existing codebase. |
| ESLint comparison of every changed client file with its `git show HEAD:<path>` content | **0 new findings**. JarsPage has the same 1 error, TransactionsPage the same 5 errors, other changed client files have 0. Comparison matches rule ID, severity and first diagnostic line, accounting for shifted source lines. Unchanged files were not edited. |
| `git diff --check` | Passed. |

Frontend Vite workers and the read-only ESLint/Git comparison needed an approved subprocess-capable run after sandbox EPERM errors. No automatic-review rejection remains unresolved.

SQL integration and real-backend browser journeys were not run in this first batch: it changes pure arithmetic, client forms/previews and a pre-write handler currency guard, with no schema changes. These remain required for the upcoming actual-ledger/schema and transfer-identity work. No deployment or data migration has occurred. Existing broad lint debt is separate follow-up work; it was not hidden by disabling rules.

### Next step / handoff

Begin W01's actual jar/account ledger as a coherent schema/API/UI change, using the notes above and the agreed examples. Resolve how any existing development ledger should be handled before activation; do not assign dates/accounts to old jars or turn their planned amounts into actual money. Do not label the full review implemented: the main planned-as-saved defect, recurring lifecycle, reporting/refunds, import pairing, joint/privacy features and remaining work-register items are still open.

### Development data decision — 23 September 2026

Rule 65 supersedes the preservation requirement and the unresolved O12 references above. Asked whether incomplete legacy accounts/jars should enter "Needs setup", the user instead explicitly requested: "Scrap all current data and we will start with a fresh database." Do not build a legacy carry-forward workflow. New records still require explicit valid opening dates, designated accounts and actual allocations.

Read-only configuration inspection found the API's configured development target is `ZeroBudget` on `(localdb)\MSSQLLocalDB`. Development appsettings and launch profiles do not override it; no user-secret file or connection-string environment override was found in this session. The EF design-time factory names the same target. Integration tests use a separate database and must remain separate. No credentials were printed.

No database reset has been executed. Perform the authorised reset when the replacement schema is ready, rechecking the effective connection first, and record the command and result here. The first batch's test results above remain the latest code validation; this decision changes documentation only.

### Individual PR delivery — 23 September 2026

The user authorised individual PRs and sequential production delivery (rule 66). Reviewed recent PRs #218–225: focused branches into main, problem/fix descriptions and explicit regression evidence. The deployment workflow publishes staging then production for each main commit. Live production environment configuration currently has no protection rules, despite the workflow comments describing a reviewer gate.

| Change | Commit | PR |
| --- | --- | --- |
| W10 editable monetary amounts | `8e6a743` | [#249](https://github.com/maskit89/AllotJar/pull/249) |
| W02 month-end/UTC jar preview | `16b9f2a`, `6ba8976` | [#250](https://github.com/maskit89/AllotJar/pull/250) |
| W09 exact allocation rounding | `ad1735b` | [#251](https://github.com/maskit89/AllotJar/pull/251) |
| W08 budget/account currency guard | `08a2840`, `143a6ed` | [#252](https://github.com/maskit89/AllotJar/pull/252) |

Each branch contains only its corresponding code and tests. The shared AllocationCoverageTests changes were split between the rounding and currency PRs. CI runs each isolated branch, including SQL integration and browser checks omitted from the initial local batch.

The unchanged npm lockfile produces a failing, explicitly non-required security scan: 10 advisories (3 moderate, 7 high), including PostCSS, React Router and undici. None of these PRs changes dependencies. Keep this visible as dependency-maintenance work; do not report all CI checks green.

CI found and prompted two follow-ups before release:

- #250: the timezone regressions failed on Linux because cached Intl formatters retained a timezone while calendar-date construction used a different current timezone. Date-only helpers now construct and format consistently in UTC, retaining browser locale. A shared-cache timezone regression covers all three helpers. Targeted local command `npx vitest run src/lib/dates.test.ts src/pages/JarsPage.catalog.supplemental.test.tsx` passed all 26 tests; the full CI frontend suite also passed.
- #252: two SQL rerun fixtures omitted the budget now required by the currency guard. They now seed a selected budget with attributed monthly income and keep their original idempotency/dangling-account assertions. The CI SQL integration suite passes. Local attempts hit environment setup errors (sandbox LocalDB access, then an existing detached `AllotJar_IntegrationTests.mdf`); no unrelated files were removed to force a local pass. CI's disposable SQL container supplies the real SQL validation.

At this documentation snapshot, #249 and #251 have each completed staging and production deployment successfully: [money editing release](https://github.com/maskit89/AllotJar/actions/runs/35864216299), [rounding release](https://github.com/maskit89/AllotJar/actions/runs/35864668449). Production `/health` and `/` returned HTTP 200. The remaining PRs' final merge and release evidence is available through their linked GitHub checks and the [Deploy workflow](https://github.com/maskit89/AllotJar/actions/workflows/deploy.yml); follow that live record rather than inferring release status from a branch commit. Release one code PR at a time and wait for its production deployment before merging the next.

The handover's 66 consecutive rules and local Markdown links were validated before committing. Original diagnostic reproductions remain tied to the audited base commit and are not replacement acceptance tests for the corrected behaviours.

### W01 actual calculation foundation — 23 September 2026

Added domain-only `ActualAccountLedger` and `ActualSavingsLedger`. The first derives dated account balances from the explicit opening date and authoritative account-currency transactions; the second reconciles signed actual jar/unallocated postings to those movements. Initial and same-account allocations sum to zero; transaction allocations exactly match their account leg, date and direction. Duplicate transaction/operation identities and missing allocations are rejected rather than silently counted or assigned. Archived jars remain in reconciliation; legacy jar opening fields and budget plans do not fund jars.

Rule 67 now confirms that dates before opening show an unavailable balance, represented by null monetary values. Negative jars are retained; account and unallocated deficits are exposed for write validation and review, not accepted as permission to post. Source limits for reallocations remain a pending user question, distinct from the agreed permission for actual spending to make a jar negative.

This is a calculation foundation, **not activation of the new ledger in the product**. No database schema, account/transaction handler or screen has switched to it. The old jar bug therefore remains until persistence, dated openings, every transaction/import writer, concurrency guards and the API/UI switch are completed together. Current account/jar definitions must not be reused blindly for historical periods after a designation change. Transfer matching, separately posted bank-leg dates and correction policies remain the documented O1/O3 questions; this calculation consumes the dates and identities it is explicitly given.

The affected test review and one redundant-assertion removal are recorded in TEST-PLAN. First targeted run: 35 passed after correcting a test constructor ambiguity. Full backend run: 844 passed. An additional deficit-distinction case was then added; final targeted validation and CI results belong in the PR record. No existing tests were disabled to obtain these results. No user database reset or migration occurred.
