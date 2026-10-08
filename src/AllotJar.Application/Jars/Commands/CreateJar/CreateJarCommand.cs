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
/// <paramref name="MonthOnly"/> marks a date given as just a month (the 1st of it, <see cref="Domain.Entities.Jar.MonthOnly"/>).
/// <paramref name="SavingsCategoryId"/> is the Dashboard Savings group the jar was added from (jar setup plan, PR 4): its
/// line goes in that group, and in other months in the Savings group of the same name. Without it, or when it names no
/// Savings group of the household, the line goes in the first Savings group, as before.
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
    bool ShareAccount = false,
    bool MonthOnly = false,
    Guid? SavingsCategoryId = null) : IRequest<JarDto>, IJarDefinition;
