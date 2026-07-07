using MediatR;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.CreateJar;

/// <summary>Defines a new sinking fund. Returns it with its derived figures.</summary>
public record CreateJarCommand(
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    DateOnly? CoverStart,
    DateOnly? CoverEnd,
    AccrualMethod Accrual,
    decimal OpeningBalance,
    DateOnly? OpeningAsOf,
    Guid? FundingAccountId,
    int? RecurMonths = null) : IRequest<JarDto>;
