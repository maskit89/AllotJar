using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Api.Features;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJarLedger;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Controllers;

/// <summary>
/// The user's jars and their derived figures (actual balance, required monthly contribution,
/// projection, status), plus each jar-backed account's ledger and same-account money moves.
/// Every handler is owner-scoped; balances are actual money read from the ledger, never stored
/// and never plans.
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

    /// <summary>Lists the user's jars with their derived figures.</summary>
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<JarDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<JarDto>>> List(
        [FromQuery] bool includeArchived, [FromQuery] DateOnly? asOf, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetJarsQuery(includeArchived, asOf), ct);
        return Ok(result);
    }

    /// <summary>Each jar-backed account's ledger: balance, jars and unallocated funds, which reconcile.</summary>
    [HttpGet("ledger")]
    [ProducesResponseType(typeof(IReadOnlyList<JarAccountLedgerDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<JarAccountLedgerDto>>> Ledger(
        [FromQuery] DateOnly? asOf, [FromQuery] Guid? accountId, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetJarLedgerQuery(asOf, accountId), ct);
        return Ok(result);
    }

    /// <summary>Defines a new jar in its account, optionally dividing money already there into it, and returns it.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<JarDto>> Create(CreateJarRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new CreateJarCommand(
            request.Name, request.Kind, request.TargetAmount, request.TargetDate,
            request.CoverStart, request.CoverEnd, request.Accrual,
            request.FundingAccountId, request.InitialAllocation, request.InitialAllocationDate,
            request.RecurMonths), ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>Edits a jar's definition. Returns it.</summary>
    [HttpPut("{id:guid}")]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<JarDto>> Update(Guid id, UpdateJarRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new UpdateJarCommand(
            id, request.Name, request.Kind, request.TargetAmount, request.TargetDate,
            request.CoverStart, request.CoverEnd, request.Accrual,
            request.FundingAccountId, request.RecurMonths), ct);
        return Ok(result);
    }

    /// <summary>Archives or restores a jar (soft). Archiving needs a zero balance. Returns it.</summary>
    [HttpPut("{id:guid}/archive")]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<JarDto>> Archive(Guid id, ArchiveJarRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new ArchiveJarCommand(id, request.Archived), ct);
        return Ok(result);
    }

    /// <summary>Moves money between one account's jars and/or its unallocated funds (null = unallocated). Returns that account's ledger.</summary>
    [HttpPost("reallocations")]
    [ProducesResponseType(typeof(JarAccountLedgerDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<JarAccountLedgerDto>> Reallocate(ReallocateJarMoneyRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new ReallocateJarMoneyCommand(
            request.AccountId, request.SourceJarId, request.DestinationJarId, request.Amount, request.Date, request.Note), ct);
        return Ok(result);
    }
}

/// <summary>Request body for creating a jar.</summary>
public record CreateJarRequest(
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
    int? RecurMonths = null);

/// <summary>Request body for editing a jar (the id comes from the route).</summary>
public record UpdateJarRequest(
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    DateOnly? CoverStart,
    DateOnly? CoverEnd,
    AccrualMethod Accrual,
    Guid FundingAccountId,
    int? RecurMonths = null);

/// <summary>Request body for archiving/restoring a jar.</summary>
public record ArchiveJarRequest(bool Archived = true);

/// <summary>Request body for a same-account money move; a null jar id means the account's unallocated funds.</summary>
public record ReallocateJarMoneyRequest(
    Guid AccountId,
    Guid? SourceJarId,
    Guid? DestinationJarId,
    decimal Amount,
    DateOnly? Date = null,
    string? Note = null);
