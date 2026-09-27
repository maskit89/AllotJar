using MediatR;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Queries.GetJarSchedule;

/// <summary>
/// Previews the contribution schedule a jar definition would plan from this month (rules 12–18,
/// 35–36, 58–59). With <paramref name="JarId"/> the schedule starts from that jar's actual balance
/// entering the month (an edit); without it from <paramref name="InitialAllocation"/> (a new jar).
/// Nothing is saved.
/// </summary>
public record GetJarScheduleQuery(
    Guid? JarId,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    AccrualMethod Accrual,
    decimal? MonthlyContribution = null,
    bool IncludeDeadlineMonth = false,
    int? RecurMonths = null,
    decimal InitialAllocation = 0m) : IRequest<JarScheduleDto>, IJarDefinition;
