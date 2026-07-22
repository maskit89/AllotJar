using AllotJar.Domain.Enums;

namespace AllotJar.Importer;

/// <summary>The reference data parsed from the workbook before any transactions.</summary>
internal sealed record ReferenceData(
    IReadOnlyList<AccountSeed> Accounts,
    IReadOnlyList<MemberSeed> Members,
    IReadOnlyList<FundSeed> Funds);

/// <summary>
/// One of the five real-world account blocks on a "Bank Account - &lt;month&gt;" sheet.
/// <see cref="Opening"/> is the "Balance B/d" carried into January; <see cref="JanClose"/>
/// is the sheet's own TOTAL after January (row 128) — the reconciliation oracle for the
/// later transaction phase.
/// </summary>
internal sealed record AccountSeed(
    string Name,
    AccountType Type,
    decimal Opening,
    decimal JanClose);

/// <summary>A household member (Alex, Sam) with their net monthly income.</summary>
internal sealed record MemberSeed(
    string Name,
    decimal NetMonthlyIncome,
    string SavingsAccountName);

/// <summary>
/// One real monthly living-cost envelope from the "Living Costs" sheet (rows 4-15).
/// <see cref="Code"/> is the short ledger tag (F&amp;D, EE, SOAP…) used to attribute
/// Savings-Joint transactions to this line in the transaction phase.
/// </summary>
internal sealed record LivingCostLine(string Code, string Name, decimal Monthly);

/// <summary>
/// The non-reference inputs for the monthly budget, parsed from "Living Costs" and
/// "Future Savings": the living-cost envelopes and the per-member pocket money and
/// personal-savings surplus from the allocation waterfall.
/// </summary>
internal sealed record BudgetSheetData(
    IReadOnlyList<LivingCostLine> LivingLines,
    decimal PocketPerMember,
    IReadOnlyDictionary<string, decimal> SurplusByMember);

/// <summary>
/// A sinking fund parsed from "Yearly Expenses" (discretionary, proportional-pool) or
/// "Monthly Expenses" (commitments, straight-line). <see cref="MonthlyContribution"/> is
/// the sheet's own monthly figure (Yearly col F / Monthly col C) — used to cross-check the
/// app's accrual calculator. <see cref="Opening"/> is the balance carried into 2026
/// (Yearly col J / Monthly col H).
/// </summary>
internal sealed record FundSeed(
    string Name,
    string Category,
    decimal TargetAmount,
    decimal MonthlyContribution,
    decimal Opening,
    AccrualMethod Accrual,
    DateOnly? CoverStart,
    DateOnly? CoverEnd);
