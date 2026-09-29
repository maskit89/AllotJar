using MediatR;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.CreateJar;

/// <summary>
/// Defines a new jar in its designated account (rules 2/73) and plants its planned contribution
/// in the current and later existing months. <paramref name="InitialAllocation"/> divides money
/// already in that account into the jar (rules 9/77) on <paramref name="InitialAllocationDate"/>
/// (today when omitted); it never deposits money. Returns the jar with its derived figures.
/// <paramref name="ShareAccount"/> is the user's answer to the rule 34 warning when the account is
/// their private one (see <see cref="JarAccounts.EnsureVisibleForJarAsync"/>).
/// </summary>
public record CreateJarCommand(
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    AccrualMethod Accrual,
    Guid FundingAccountId,
    decimal InitialAllocation = 0m,
    DateOnly? InitialAllocationDate = null,
    int? RecurMonths = null,
    decimal? MonthlyContribution = null,
    bool IncludeDeadlineMonth = false,
    bool ShareAccount = false) : IRequest<JarDto>, IJarDefinition;
