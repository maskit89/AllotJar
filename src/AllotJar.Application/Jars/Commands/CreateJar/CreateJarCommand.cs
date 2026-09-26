using MediatR;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.CreateJar;

/// <summary>
/// Defines a new jar in its designated account (rules 2/73). <paramref name="InitialAllocation"/>
/// divides money already in that account into the jar (rules 9/77) on
/// <paramref name="InitialAllocationDate"/> (today when omitted); it never deposits money.
/// Returns the jar with its derived figures.
/// </summary>
public record CreateJarCommand(
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    DateOnly? CoverStart,
    DateOnly? CoverEnd,
    AccrualMethod Accrual,
    Guid FundingAccountId,
    decimal InitialAllocation = 0m,
    DateOnly? InitialAllocationDate = null,
    int? RecurMonths = null) : IRequest<JarDto>;
