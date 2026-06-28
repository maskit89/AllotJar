using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ZeroBudget.Api.Features;
using ZeroBudget.Application.Jars.Commands.ArchiveJar;
using ZeroBudget.Application.Jars.Commands.CreateJar;
using ZeroBudget.Application.Jars.Commands.UpdateJar;
using ZeroBudget.Application.Jars.Dtos;
using ZeroBudget.Application.Jars.Queries.GetJars;
using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Api.Controllers;

/// <summary>
/// The user's sinking funds and their derived figures (balance, required monthly
/// contribution, projection, status). Every handler is owner-scoped; the running
/// balance is computed from the budget lines, never stored.
/// </summary>
[ApiController]
[Authorize]
[FeatureGate(nameof(FeatureFlags.Jars))]
[Route("api/[controller]")]
public class JarsController : ControllerBase
{
    private readonly ISender _mediator;

    public JarsController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>Lists the user's sinking funds with their derived figures.</summary>
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<JarDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<JarDto>>> List(
        [FromQuery] bool includeArchived, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetJarsQuery(includeArchived), ct);
        return Ok(result);
    }

    /// <summary>Defines a new sinking fund and returns it.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<JarDto>> Create(CreateJarRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new CreateJarCommand(
            request.Name, request.Kind, request.TargetAmount, request.TargetDate,
            request.CoverStart, request.CoverEnd, request.Accrual, request.RecurAnnually,
            request.OpeningBalance, request.OpeningAsOf, request.FundingAccountId), ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>Edits a sinking fund's definition. Returns it.</summary>
    [HttpPut("{id:guid}")]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<JarDto>> Update(Guid id, UpdateJarRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new UpdateJarCommand(
            id, request.Name, request.Kind, request.TargetAmount, request.TargetDate,
            request.CoverStart, request.CoverEnd, request.Accrual, request.RecurAnnually,
            request.OpeningBalance, request.OpeningAsOf, request.FundingAccountId), ct);
        return Ok(result);
    }

    /// <summary>Archives or restores a sinking fund (soft). Returns it.</summary>
    [HttpPut("{id:guid}/archive")]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<JarDto>> Archive(Guid id, ArchiveJarRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new ArchiveJarCommand(id, request.Archived), ct);
        return Ok(result);
    }
}

/// <summary>Request body for creating a sinking fund.</summary>
public record CreateJarRequest(
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    DateOnly? CoverStart,
    DateOnly? CoverEnd,
    AccrualMethod Accrual,
    bool RecurAnnually,
    decimal OpeningBalance,
    DateOnly? OpeningAsOf,
    Guid? FundingAccountId);

/// <summary>Request body for editing a sinking fund (the id comes from the route).</summary>
public record UpdateJarRequest(
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    DateOnly? CoverStart,
    DateOnly? CoverEnd,
    AccrualMethod Accrual,
    bool RecurAnnually,
    decimal OpeningBalance,
    DateOnly? OpeningAsOf,
    Guid? FundingAccountId);

/// <summary>Request body for archiving/restoring a sinking fund.</summary>
public record ArchiveJarRequest(bool Archived = true);
