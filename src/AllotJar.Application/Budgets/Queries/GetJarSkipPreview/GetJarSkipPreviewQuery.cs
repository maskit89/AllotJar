using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Budgets.Queries.GetJarSkipPreview;

/// <summary>
/// Rule 61 (W04): the schedule the jar would follow if this month's contribution (the given
/// Savings line) were skipped — planned from the jar's actual balance over the remaining eligible
/// months, with the deadline and rule 35's exact rounding kept. Nothing is changed; the user
/// confirms from this.
/// </summary>
public record GetJarSkipPreviewQuery(Guid BudgetItemId) : IRequest<JarScheduleDto>;
