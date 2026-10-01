using MediatR;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;

/// <summary>Creates or replaces the household's allocation profile (rules replaced wholesale). Returns it.</summary>
public record UpsertAllocationProfileCommand(
    Guid? Id,
    string Name,
    Guid? SourceAccountId,
    IReadOnlyList<AllocationRuleSpec> Rules,
    int BalanceLeanPercent = 25,
    // The version the edit form loaded (D11): a save of a record changed since is refused. Null is
    // no check, for a client loaded before the deploy that added versions.
    string? Version = null) : IRequest<AllocationProfileDto>;

public record AllocationRuleSpec(int Order, AllocationRuleType Type, SplitMethod Split, decimal FixedAmountPerMember);
