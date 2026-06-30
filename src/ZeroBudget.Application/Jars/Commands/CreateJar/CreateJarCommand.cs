using MediatR;
using ZeroBudget.Application.Jars.Dtos;
using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Application.Jars.Commands.CreateJar;

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
    Guid? FundingAccountId) : IRequest<JarDto>;
