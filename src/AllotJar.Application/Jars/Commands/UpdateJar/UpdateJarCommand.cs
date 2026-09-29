using MediatR;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

/// <summary>
/// Edits a jar's definition. A change to its target, deadline or plan revises the planned
/// contributions in the current and later months (rule 46; past months are history). The
/// designated account may only change while the jar's actual balance is zero (rule 80); money
/// is never moved by an edit. A change to the definition is dated (<see cref="Domain.Entities.JarRevision"/>),
/// so a month that is over keeps being judged against the definition it had (P49). Returns the
/// jar with refreshed figures. <paramref name="ShareAccount"/> is the user's answer to the rule 34
/// warning when the new account is their private one (see <see cref="JarAccounts.EnsureVisibleForJarAsync"/>).
/// </summary>
public record UpdateJarCommand(
    Guid Id,
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    AccrualMethod Accrual,
    Guid FundingAccountId,
    int? RecurMonths = null,
    decimal? MonthlyContribution = null,
    bool IncludeDeadlineMonth = false,
    bool ShareAccount = false) : IRequest<JarDto>, IJarDefinition;
