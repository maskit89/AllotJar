# AllotJar development handover

Prepared 22 September 2026; development status updated 24 September 2026. Local repository: `ZeroBudget`; audited commit: `638ba87`. The app is **pre-launch**, per the user's clarification. PRs #249–255 have been merged and deployed individually; see [DEVELOPMENT-LOG.md](DEVELOPMENT-LOG.md) and their PR release records for validation. No ledger database reset has been performed.

## Readiness and scope

There is enough agreed behaviour for a staged implementation of the confirmed bugs. There is not yet a fully closed specification for every feature and edge case. Do not interpret confirmed decisions as implemented changes or approval to invent remaining behaviour. The user authorised development after the original 62-rule handover; rules 63–64 settle account currency and rounding recipients, rule 65 permits a fresh development database, and rule 66 authorises individual PRs through production. The user wants current calculation bugs addressed first, step-by-step, and explicitly asks to be consulted on assumptions.

Completed first fixes: **A4 money edit round-trip**, **A3 allocation rounding**, the **J3 calendar/preview parity** subset and the **A2 allocation commit currency guard**. [PR #254](https://github.com/maskit89/AllotJar/pull/254) adds the pure actual-money calculation foundation for **J1/J2**; [PR #255](https://github.com/maskit89/AllotJar/pull/255) adds source-funds and resulting-account backing validation. The next calculation step uses independent transfer posting dates and an unknown receipt until confirmed (rules 69/71). Persistence and API/UI activation remain required before the product's jar ledger is replaced; design notes and dependencies are in DEVELOPMENT-LOG.

## Read in this order

1. [AGREED-RULES.md](AGREED-RULES.md): 71 recorded rules, examples and accounting invariants; authoritative requirements. Rule 70 requires explicit coverage when positive jar balances exceed their backing account; rule 71 confirms recording departure before receipt is known.
2. This handover: work mapping, sequencing, unresolved decisions and status.
3. [REVIEW.md](REVIEW.md): original 14 finding groups, eight further concerns, source references and synthetic reproductions. Some original questions are now resolved.
4. [TEST-PLAN.md](TEST-PLAN.md): inspected test conflicts, retain/replace/remove policy and validation plan.
5. Adjacent `reproduce.ps1`, `reproduce-client.mjs`, `HandlerChecks.csproj` and `Program.cs`: diagnostic reproductions of the original implementation, not the future acceptance oracle.

The original sibling `allotjar-review-2026-09-22` directory is an archived working copy. Continue editing this repository directory. Relative source paths in REVIEW refer to the repository root. Preserve the pre-existing, unrelated untracked `docs/audit/` and `docs/ops/user-lookup-queries.sql`.

## Important corrections and constraints

- Plans never create money. Actual account money and its allocation to jars must reconcile; do not just stop summing plans without implementing actual funding and opening allocations.
- Each jar has one designated savings account. A negative jar is allowed; a negative savings account is not. Same-account reallocations do not change account balances.
- Cross-account reallocation records a transfer after explicit **“I've completed this transfer”** confirmation. Both statement sides must later match it without another balance effect.
- Each transfer leg uses its bank's posting date. Between departure and arrival the money is shown in transit and belongs to neither jar (rule 69); combined account balances plus transit must conserve the amount.
- Positive jar balances must not exceed their savings account's actual money (rule 70). Negative jars cannot conceal insufficient backing; require an explicit user-selected reallocation to cover the deficit.
- Each budget uses one currency. Bank/user amounts are authoritative. Conversion suggestions are allowed only where the required amount is missing and require approval before application. Do not implement the earlier blanket ban on suggestion calculations, automatic conversion/reconciliation, or inferred fees.
- Private accounts cannot back shared jars. The earlier partially hidden/shared-account suggestion was explicitly rejected.
- Opening balance is at the **start** of its date. Historical corrections use actual transaction dates. Historical plans are not rewritten by those corrections.
- Completion, deadline rollover, acknowledgement, archiving and moving money are separate operations. Status transitions do not invent payment transactions.
- The category note is deferred because its author cannot recall the intended meaning. Do not silently turn it into a new category design.
- No production-conversion remediation workflow is needed. Rule 65 explicitly authorises starting with a fresh project development database when the new schema is ready. Rule 66 authorises individual PRs and sequential production releases for the agreed work.

## Work register

W09 and W10 are implemented in the first batch; W02 and W08 have only the bounded subsets listed above implemented. The other feature work remains open. W14 test review/validation accompanies each batch. “Defined” means the confirmed portion can be developed, not that every neighbouring edge case is settled. Rule numbers refer to AGREED-RULES.

| Work | Evidence / source area | Agreed scope and acceptance | Readiness |
| --- | --- | --- | --- |
| W01 Actual jar/account ledger | J1/J2; `Jars/JarBalances.cs`, create/get handlers, `Budgets/BudgetActuals.cs`, account reconciliation | Rules 1–11: actual funding, allocations and withdrawals; designated account; opening amount once; jars + unallocated = account; future plan creation cannot change money | Foundation defined; clarify related O1/O3/O5 before those paths |
| W02 Schedules and previews | J3/J4, concerns 1/4/8; `JarAccrualCalculator`, `JarDto`, `JarsPage` | Rules 12–18, 35–36, 58–59, 62: fixed contribution or deadline, ongoing savings, final remainder, mid-month opt-in, exact preview/server agreement, anchored month ends and estimates | Core defined; O2/O6 on remaining boundaries |
| W03 Recurring lifecycle | Concern 3; jar DTO/calculator/status UI | Rules 19–24, 57: persistent missed state, funded late, carry actual remainder, successful paid-before-deadline cycle, no money movement on rollover | State outcomes defined; O3 on cycle/payment association |
| W04 Edits, deletion, archive, completion, skip | J5, concern 7; jar update/archive and budget item handlers | Rules 25–27, 46–47, 55–56, 60–61: preview schedule changes; preserve history/money; archive at zero; complete with positive remainder; explicit skip vs archive | Defined subset; O3 on deletion eligibility, manual overrides and lifecycle edges |
| W05 Period consistency and refresh | J6, opening-date concern 2; Dashboard, GetJars, BudgetActuals | Rules 40, 48–49: correct selected-month cutoff; missing actuals correct history forward; refresh views after related changes | Past-month rule defined; O2 for other time boundaries |
| W06 People and optional allocation | P1/P2; `MemberIncome`, `AllocationPlanner`, household queries, PeoplePage | Rules 28–29: selected budget's income, no static fallback, consistent period/figures; optional equal/income-based suggestions | Source-of-income fix defined; O4/O5/O7 for attribution, currency and feature scope |
| W07 Transfer/import identity | A1; commit/import handlers, AccountBalances | Rules 7–8, 50–51: both bank references on one movement, user-confirmed candidates, ambiguity resolved by user, repeated imports change nothing | Invariants defined; O1 for matching/conflict/date details |
| W08 Monetary units and conversion | A2/A5/P2; FX resolver/provider/background worker, DTOs, aggregators and UI | Rules 41–44: one budget currency; supplied amount final; unapproved suggestion has no monetary effect; no inferred fees or raw mixed-unit totals | Direction defined; O5 required for missing-amount workflow/account boundaries |
| W09 Allocation rounding | A3; `IncomeAllocator` and commit | Rules 52/64: 0.02 across four => first two 0.01, others 0; sum preserved; fractional-remainder weighting; no rounded negative shares | Implemented and validated in first batch; currency minor-unit policy beyond current cents remains O6 |
| W10 Locale edit corruption | A4; `client/src/lib/money.ts` and edit forms | Existing stored amount survives opening/saving unchanged in supported formats, including 1.234 under comma-decimal preferences; retain explicit-input validation | Implemented and validated in first batch; no change to currency precision policy |
| W11 Pocket-money identity/archive | A6; sync handler, person archive, budget model | Rules 53–54: stable person identity; rename no duplicate; archive cancels next/future months and asks current-month choice; preserve actuals | Defined |
| W12 Reports and refunds | Concerns 5/6; annual/trend reports, transaction assignment/splits | Rules 37–39, 41: include uncategorised actuals, actual vs planned income, signed Variance, refunds original category/current receipt month, original linkage | Main outcomes defined; O5/O8/O9 on currency/privacy/refund edges |
| W13 Joint accounts and privacy | Handwritten note 8; account/member ownership, access policies, API/report scopes | Rules 30–34: one joint balance/history, personal login-controlled privacy, shared jar/account fully visible, warning before sharing | Principles agreed; O8 must be answered before access model implementation |
| W14 Tests and validation | Existing unit, SQL integration, mocked UI and real-backend journeys | Review/update existing assertions, meaningful regression coverage, remove only justified obsolete/redundant tests; see TEST-PLAN | Explicitly requested; apply to every development change |

The 14 audit groups are fully mapped: J1–J6, P1–P2, A1–A6. The eight original additional concerns map respectively to W02, W01/W05, W03, W02/O6, W12, W12/O9, W04 and W02/O2/O6. All original 62 rules are covered by the register; additional rules63/64 map to W08/W09. Open details remain explicitly open.

## Original handwritten notes

| Note | Disposition |
| --- | --- |
| Rename Budget tab to Dashboard | Captured request; label-only vs navigation/content meaning not confirmed. O10; outside first calculation fixes. |
| Monthly saving without target | Confirmed fixed monthly ongoing jar, rules 16–17; W02. |
| Delete jar | Unused delete vs history-preserving archive, rules 25–27; W04/O3. |
| Monthly savings do not add up to target | W01/W02/W04/W05; agreed exact schedule and actual-money rules. |
| Same jar data differs from Budget | W01/W02/W04/W05; comparisons require same date, actuals and plan definition. |
| Monthly or living category | Deliberately deferred, O11. |
| People budget differs from Overview | W06/W11/W12; selected month/source consistency. |
| Joint accounts | W13; permission details pending O8. |

## Questions that must not be silently decided

Ask only when the relevant work is reached; these do not block unrelated bug fixes. This is a list of unresolved decisions, not new requirements.

- **O1 Transfers/imports:** candidate date tolerance and matching identifiers; conflicting same-reference rows; receipt-first imports when departure details are missing; reversal/correction behaviour; batch ordering and missing-history handling before enforcing non-negative savings; explicitly supplied transfer fees. Different bank posting dates and money in transit are settled by rule 69, and recording departure before receipt is known by rule 71. Matching by amount alone is already prohibited. Rule 70 settles the requirement for explicit coverage when positive jars exceed account money; the transaction/import correction workflow must still be implemented without hiding genuine bank movements.
- **O2 Time/history:** household timezone and exact deadline-day cutoff; what future-month views display as actual vs projected; current-month partial scheduling and how earlier genuine corrections affect previously recorded cycle status. Before-opening balances are now explicitly unavailable under rule 67. Past month-end balances and actual-date corrections are already agreed.
- **O3 Jar lifecycle:** which payments fulfil which recurring cycle, especially early payments across cycles; treatment of negative-balance completion and reopening; exact unused deletion eligibility (opening allocations/planned lines); manual plan overrides during target edits; skipping the last eligible month; effects of changing a jar's designated account. Do not infer a funds transfer from changing an account field.
- **O4 Allocation details:** attribution of income not assigned to people and zero-income proportional splitting. The pool must remain the selected budget's income regardless. Leftover-cent recipients are now settled by rule64.
- **O5 Currency boundaries:** missing amount holding/review workflow; conversion suggestion source and approval presentation; any later representation of supplied cross-currency transfer amounts. Rule63 now requires all linked accounts to use the budget currency for the first release. Do not reinstate automatic posting of converted amounts while solving this.
- **O6 Existing accrual modes/precision:** retain, replace or retire StraightLine, DailyRate and ProportionalPool modes; account for tools/importer uses before removal. Currency minor-unit policy beyond the agreed EUR examples, and treatment of sub-minor-unit stored values. Existing tests are not approval of these behaviours.
- **O7 Optional allocation UI:** placement/removal of Allocation page, opt-in UI and remaining surplus controls. Pocket-money rename/archive behaviour itself is agreed.
- **O8 Joint/privacy permissions:** meaning of shared audience, non-owner visibility, edit rights and ownership shares; personal jars in a visible/shared account; private-account participation in shared reports/income totals without leaking information; handling private/shared transfer visibility. Never implement a hidden account backing a shared jar.
- **O9 Refund details:** refunds into a different account from the original jar's designated savings account; multiple/partial refund links, unmatched refunds and changes to a completed jar/cycle. Category and reporting date behaviour is settled.
- **O10 Navigation:** exact intended Budget-to-Dashboard change; no redesign has been approved.
- **O11 Deferred category note:** wait for the author to recall the meaning; no assumption required to proceed with fixes.
- **O12 Development data — resolved by rule 65:** discard existing project development data and start with a fresh database. This supersedes the earlier carry-forward answer. Do not implement a legacy "Needs setup" migration flow. Verify the exact development database before reset; preserve source files and unrelated databases. Reset is authorised but has not yet been performed.

## Suggested development sequence

1. Establish a clean working baseline, preserve unrelated files and read TEST-PLAN. Address W10 as a bounded regression fix. Do not create a new task, deploy or erase data merely because a handover exists.
2. Design and implement W01's actual account/jar allocation model with conservation tests, opening cutoff and SQL persistence tests. Validate designated savings account and preserve history. Resolve only the O1/O3/O5 portions needed for the first supported transaction path.
3. Implement W02/W04/W05 using shared, deterministic scheduling/cutoff logic. Preview, saved plans and displayed results must agree; add mutation-refresh and selected-month UI tests. Implement W03 once cycle/payment association is settled.
4. Implement W07's transfer identity and repeat-import guarantees; retain both references and isolate ambiguous cases. W08 removes unapproved conversions rather than setting rates to 1.
5. Implement W06/W09/W11 and W12, then W13 after explicit permission/audience answers. Keep original UI requests and deferred features distinct from calculation fixes.
6. Run the changed suites, full unit suites and build, then relevant real SQL and browser journeys. Record exact results and remaining limitations. A passing unit suite alone is insufficient for schema or ledger work.

## Status and handoff checklist

- Earlier audit baseline: 789 backend tests passed; 659 frontend tests in 56 files passed. These are historical results, not a rerun during handover preparation.
- SQL integration and browser journeys were not run in the audit. TEST-PLAN explains their scope and prerequisites.
- Handover preparation inspected test bodies, names, fixtures, package scripts and CI. Development has since added regressions and generalized an existing recurrence test instead of duplicating it. Exact current validation and test maintenance are in DEVELOPMENT-LOG.
- On each implementation step, log W-ID, rule numbers, changed files, test additions/replacements/removals with reason, exact commands/results, unresolved questions and next action. Keep this status current for the next developer.
- Reproduction scripts are diagnostics tied to the original implementation. Promote their relevant examples into real regression tests; do not use the known-wrong outputs as expected behaviour.
- Handover validation completed: all 62 numbered rules are present in order; all local Markdown links in this directory resolve. The relocated PowerShell, Node and handler reproductions all ran successfully on 22 September 2026 and still exhibit the original defects. The handler harness uses the previously rebuilt application-test assemblies. Its printed FX comparison is historical diagnostic text, not permission to apply conversion automatically.
- Commands actually run for that validation, from repository root: `node --experimental-strip-types docs/reviews/2026-09-22/reproduce-client.mjs`; `& './docs/reviews/2026-09-22/reproduce.ps1'`; `dotnet run --project docs/reviews/2026-09-22/HandlerChecks.csproj -p:BuildInParallel=false -p:UseSharedCompilation=false`. Each exited 0. The full unit suites were not rerun for documentation-only changes. `git diff --check` returned clean for tracked changes; the new handover directory remains untracked until committed.
- Everything required to understand this known review scope is in this directory; this does not guarantee that no further defects or design questions will emerge during development.
