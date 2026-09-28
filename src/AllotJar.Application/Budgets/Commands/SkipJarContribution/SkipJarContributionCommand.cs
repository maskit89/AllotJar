using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.SkipJarContribution;

/// <summary>
/// Rules 60–61 (W04): skips (or plans again) one month's planned contribution on a jar's Savings
/// line — the "skip this month" half of the choice offered when a jar's line is removed from a
/// monthly budget; the other half is archiving the jar. The line stays in the month at 0, marked
/// skipped, so month creation never recreates the contribution; the jar stays active and its
/// current and later months are replanned from what it actually holds, so the skipped amount
/// lands on the remaining eligible months (rule 61's example: 300 due 1 December with September
/// skipped plans 150 in October and November). Only the current or a later month can be skipped;
/// past months are history. No transaction or balance changes. Returns the recomputed month.
/// </summary>
public record SkipJarContributionCommand(Guid BudgetItemId, bool Skipped = true) : IRequest<BudgetMonthDto>;
