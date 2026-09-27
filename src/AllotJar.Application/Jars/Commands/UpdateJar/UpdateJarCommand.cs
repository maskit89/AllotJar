using MediatR;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

/// <summary>
/// Edits a jar's definition. The designated account may only change while the jar's actual
/// balance is zero (rule 80); money is never moved by an edit. Returns the jar with refreshed figures.
/// </summary>
public record UpdateJarCommand(
    Guid Id,
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    DateOnly? CoverStart,
    DateOnly? CoverEnd,
    AccrualMethod Accrual,
    Guid FundingAccountId,
    int? RecurMonths = null) : IRequest<JarDto>;
