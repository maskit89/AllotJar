using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Api.Features;
using AllotJar.Application.Allocation.Commands.AllocateIncome;
using AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Allocation.Queries.GetAllocationProfile;
using AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;

namespace AllotJar.Api.Controllers;

/// <summary>
/// The income allocation engine: define the household's allocation profile, preview the
/// monthly waterfall, and commit it (routing each member's surplus to their savings).
/// </summary>
[ApiController]
[Authorize]
[FeatureGate(nameof(FeatureFlags.HouseholdAllocation))]
[Route("api/allocation")]
public class AllocationController : ControllerBase
{
    private readonly ISender _mediator;

    public AllocationController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>The household's allocation profile, or null if none is set up.</summary>
    [HttpGet("profile")]
    [ProducesResponseType(typeof(AllocationProfileDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<AllocationProfileDto?>> GetProfile(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetAllocationProfileQuery(), ct);
        // Always emit a JSON body (a literal `null` for no profile) rather than letting
        // ASP.NET's Ok(null) formatter collapse to 204 No Content — the client maps a 204's
        // empty body to '' and `'' ?? null` keeps the empty string, poisoning first-time setup.
        return new JsonResult(result);
    }

    /// <summary>Creates or replaces the allocation profile. Returns it.</summary>
    [HttpPut("profile")]
    [ProducesResponseType(typeof(AllocationProfileDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<AllocationProfileDto>> UpsertProfile(UpsertAllocationProfileRequest request, CancellationToken ct)
    {
        var rules = (request.Rules ?? new List<AllocationRuleSpecRequest>())
            .Select(r => new AllocationRuleSpec(r.Order, r.Type, r.Split, r.FixedAmountPerMember))
            .ToList();
        var result = await _mediator.Send(
            new UpsertAllocationProfileCommand(
                request.Id, request.Name, request.SourceAccountId, rules, request.BalanceLeanPercent), ct);
        return Ok(result);
    }

    /// <summary>Dry-run of the waterfall for a month (no writes).</summary>
    [HttpGet("preview/{year:int}/{month:int}")]
    [ProducesResponseType(typeof(AllocationResultDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<AllocationResultDto>> Preview(int year, int month, [FromQuery] Guid? profileId, CancellationToken ct)
    {
        var result = await _mediator.Send(new PreviewIncomeAllocationQuery(year, month, profileId), ct);
        return Ok(result);
    }

    /// <summary>
    /// Materializes the profile's pocket money as per-member budget lines in an
    /// ExcludeFromAllocation Expense category (creating/adopting "Pocket Money"), so the
    /// zero-based budget and the allocation engine agree. Explicit user action; idempotent.
    /// Returns the refreshed month.
    /// </summary>
    [HttpPost("pocket-lines/{year:int}/{month:int}")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> SyncPocketLines(int year, int month, CancellationToken ct)
    {
        var result = await _mediator.Send(new SyncPocketMoneyLinesCommand(year, month), ct);
        return Ok(result);
    }

    /// <summary>Commits the allocation for a month (creates the savings transfers). Idempotent.</summary>
    [HttpPost("commit/{year:int}/{month:int}")]
    [ProducesResponseType(typeof(AllocationResultDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<AllocationResultDto>> Commit(int year, int month, [FromQuery] Guid? profileId, CancellationToken ct)
    {
        var result = await _mediator.Send(new AllocateIncomeCommand(year, month, profileId), ct);
        return Ok(result);
    }
}

/// <summary>Request body for creating/replacing the allocation profile.</summary>
public record UpsertAllocationProfileRequest(
    Guid? Id,
    string Name,
    Guid? SourceAccountId,
    List<AllocationRuleSpecRequest> Rules,
    int BalanceLeanPercent = 25);

/// <summary>One rule in the allocation waterfall.</summary>
public record AllocationRuleSpecRequest(
    int Order,
    Domain.Enums.AllocationRuleType Type,
    Domain.Enums.SplitMethod Split,
    decimal FixedAmountPerMember);
