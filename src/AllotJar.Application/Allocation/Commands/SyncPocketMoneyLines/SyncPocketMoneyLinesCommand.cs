using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;

/// <summary>
/// Materializes the allocation profile's pocket-money step as per-member budget lines in an
/// Expense category flagged <c>ExcludeFromAllocation</c>. That flag combination is what makes
/// BOTH systems coherent: the lines count into the budget's planned total (so "every euro has
/// a job" can include pocket money) while staying out of the engine's shared-cost envelopes
/// (the FixedPerMember rule remains the single deduction — no double count). Explicitly
/// user-invoked from the Allocation page's reconciliation banner; never runs automatically.
/// Admin+ (no AllowLimited — it reshapes the budget). Returns the refreshed month.
/// </summary>
public record SyncPocketMoneyLinesCommand(int Year, int Month) : IRequest<BudgetMonthDto>;
