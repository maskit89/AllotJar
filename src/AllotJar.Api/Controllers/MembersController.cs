using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Api.Features;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Commands.CreateHouseholdMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Dtos;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Application.Household.Queries.GetMemberArchivePreview;
using AllotJar.Application.Household.Queries.GetMemberIncome;
using AllotJar.Application.Household.Queries.GetMemberSpending;

namespace AllotJar.Api.Controllers;

/// <summary>
/// The household's members (e.g. Alex, Sam) — first-class entities under the single
/// owner, used by the income allocation engine. Every handler is owner-scoped.
/// </summary>
[ApiController]
[Authorize]
[FeatureGate(nameof(FeatureFlags.HouseholdAllocation))]
[Route("api/members")]
public class MembersController : ControllerBase
{
    private readonly ISender _mediator;

    public MembersController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>
    /// Lists the household's members with each one's income and share in the selected month's
    /// budget (rule 28); <c>year</c>/<c>month</c> default to the current month.
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<HouseholdMemberDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<HouseholdMemberDto>>> List(
        [FromQuery] bool includeArchived, [FromQuery] int? year, [FromQuery] int? month, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetHouseholdMembersQuery(includeArchived, year, month), ct);
        return Ok(result);
    }

    /// <summary>Per-member attributed spending (the "who spent what" lens) across all time, in the base currency.</summary>
    [HttpGet("spending")]
    [ProducesResponseType(typeof(IReadOnlyList<MemberSpendingDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<MemberSpendingDto>>> Spending(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetMemberSpendingQuery(), ct);
        return Ok(result);
    }

    /// <summary>Per-member attributed spending in one month (the same month the Budget shows, rule 29), in the base currency.</summary>
    [HttpGet("spending/{year:int}/{month:int}")]
    [ProducesResponseType(typeof(IReadOnlyList<MemberSpendingDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<MemberSpendingDto>>> SpendingForMonth(int year, int month, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetMemberSpendingQuery(year, month), ct);
        return Ok(result);
    }

    /// <summary>
    /// Per-member income for a month, derived from the budget's attributed income lines
    /// (planned) and the month's attributed income transactions (received).
    /// </summary>
    [HttpGet("income/{year:int}/{month:int}")]
    [ProducesResponseType(typeof(MemberIncomeResultDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<MemberIncomeResultDto>> Income(int year, int month, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetMemberIncomeQuery(year, month), ct);
        return Ok(result);
    }

    /// <summary>Adds a member and returns it.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(HouseholdMemberDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<HouseholdMemberDto>> Create(CreateMemberRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new CreateHouseholdMemberCommand(request.Name, request.NetMonthlyIncome, request.PersonalSavingsAccountId), ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>Edits a member. Returns it.</summary>
    [HttpPut("{id:guid}")]
    [ProducesResponseType(typeof(HouseholdMemberDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<HouseholdMemberDto>> Update(Guid id, UpdateMemberRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new UpdateHouseholdMemberCommand(id, request.Name, request.NetMonthlyIncome, request.PersonalSavingsAccountId, request.Version), ct);
        return Ok(result);
    }

    /// <summary>
    /// What archiving a member does to their pocket money (rule 54): this month's planned, paid and
    /// remaining amounts, and the future months whose lines would be cancelled.
    /// </summary>
    [HttpGet("{id:guid}/archive-preview")]
    [ProducesResponseType(typeof(MemberArchivePreviewDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<MemberArchivePreviewDto>> ArchivePreview(Guid id, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetMemberArchivePreviewQuery(id), ct);
        return Ok(result);
    }

    /// <summary>
    /// Archives or restores a member (soft). Archiving stops their pocket money from next month
    /// (rule 54); when this month still has some planned, <c>pocketMoneyThisMonth</c> (0 keep,
    /// 1 cancel) is required and its absence is a 400. Returns the member.
    /// </summary>
    [HttpPut("{id:guid}/archive")]
    [ProducesResponseType(typeof(HouseholdMemberDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<HouseholdMemberDto>> Archive(Guid id, ArchiveMemberRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new ArchiveHouseholdMemberCommand(id, request.Archived, request.PocketMoneyThisMonth), ct);
        return Ok(result);
    }
}

/// <summary>Request body for adding a household member.</summary>
public record CreateMemberRequest(string Name, decimal NetMonthlyIncome, Guid? PersonalSavingsAccountId);

/// <summary>Request body for editing a member (the id comes from the route).</summary>
/// <param name="Version">The version the edit form loaded (D11); null only from a client older than this deploy.</param>
public record UpdateMemberRequest(string Name, decimal NetMonthlyIncome, Guid? PersonalSavingsAccountId, string? Version = null);

/// <summary>Request body for archiving/restoring a member; the decision is only read when archiving.</summary>
public record ArchiveMemberRequest(bool Archived = true, PocketMoneyDecision? PocketMoneyThisMonth = null);
