using MediatR;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

/// <summary>Edits a sinking fund's definition. Returns it with refreshed derived figures.</summary>
public record UpdateJarCommand(
    Guid Id,
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    DateOnly? CoverStart,
    DateOnly? CoverEnd,
    AccrualMethod Accrual,
    decimal OpeningBalance,
    DateOnly? OpeningAsOf,
    Guid? FundingAccountId) : IRequest<JarDto>;
