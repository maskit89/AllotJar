using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Queries.GetJars;

/// <summary>
/// Lists the user's jars with their derived balance, this month's plan, projection and status.
/// <paramref name="AsOf"/> is "today": it defaults to the UTC date and is injectable so the
/// accrual maths are deterministic in tests. <paramref name="Month"/> (any day in it) selects the
/// budget month whose figures are wanted (W05, rule 48): a past month reads its balances as of its
/// last day and its plan from that month's lines; the current month and a later one read as of
/// today. Null means the month <paramref name="AsOf"/> falls in.
/// </summary>
public record GetJarsQuery(bool IncludeArchived = false, DateOnly? AsOf = null, DateOnly? Month = null)
    : IRequest<IReadOnlyList<JarDto>>;
