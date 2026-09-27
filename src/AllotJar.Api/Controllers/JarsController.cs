using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Api.Features;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.DismissJarCycle;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJarLedger;
using AllotJar.Application.Jars.Queries.GetJarPayments;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Jars.Queries.GetJarSchedule;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Controllers;

/// <summary>
/// The user's jars and their derived figures (actual balance, this month's plan, schedule
/// dates, cycle state, status), each jar-backed account's ledger, same-account money moves and
/// a Recurring jar's cycle actions (mark paid, dismiss a missed deadline).
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
            request.Name, request.Kind, request.TargetAmount, request.TargetDate, request.Accrual,
            request.FundingAccountId, request.InitialAllocation, request.InitialAllocationDate,
            request.RecurMonths, request.MonthlyContribution, request.IncludeDeadlineMonth), ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>
    /// Previews the contribution schedule a jar definition would plan from this month (rules 12–18, 35–36,
    /// 58–59) — exactly what saving it plants on the Savings lines. Nothing is stored.
    /// </summary>
    [HttpPost("schedule")]
    [ProducesResponseType(typeof(JarScheduleDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<JarScheduleDto>> Schedule(JarScheduleRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetJarScheduleQuery(
            request.JarId, request.Kind, request.TargetAmount, request.TargetDate, request.Accrual,
            request.MonthlyContribution, request.IncludeDeadlineMonth, request.RecurMonths, request.InitialAllocation), ct);
        return Ok(result);
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
            id, request.Name, request.Kind, request.TargetAmount, request.TargetDate, request.Accrual,
            request.FundingAccountId, request.RecurMonths, request.MonthlyContribution, request.IncludeDeadlineMonth), ct);
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

    /// <summary>
    /// The payments a Recurring jar's cycle can be marked paid with (rule 83): expenses not yet
    /// linked to a cycle, newest first — those drawn from the jar, or every expense with <c>all</c>.
    /// </summary>
    [HttpGet("{id:guid}/payments")]
    [ProducesResponseType(typeof(IReadOnlyList<JarPaymentDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IReadOnlyList<JarPaymentDto>>> Payments(Guid id, [FromQuery] bool all, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetJarPaymentsQuery(id, all), ct);
        return Ok(result);
    }

    /// <summary>
    /// Marks a Recurring jar's cycle paid with the chosen payment (rule 83). The open cycle then
    /// advances to the next deadline (rules 21–24); a closed cycle without a payment is simply
    /// recorded as paid. No money moves. Returns the jar.
    /// </summary>
    [HttpPost("{id:guid}/cycles/paid")]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<JarDto>> MarkCyclePaid(Guid id, MarkJarCyclePaidRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new MarkJarCyclePaidCommand(id, request.Deadline, request.PaymentTransactionId), ct);
        return Ok(result);
    }

    /// <summary>
    /// Dismisses a Recurring jar's Deadline-missed notice (rule 20): the open cycle closes as
    /// missed (or funded late, rule 57) without a payment and the jar saves toward its next
    /// deadline. Balances are untouched. Returns the jar.
    /// </summary>
    [HttpPost("{id:guid}/cycles/dismiss")]
    [ProducesResponseType(typeof(JarDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<JarDto>> DismissCycle(Guid id, DismissJarCycleRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new DismissJarCycleCommand(id, request.Deadline), ct);
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
    AccrualMethod Accrual,
    Guid FundingAccountId,
    decimal InitialAllocation = 0m,
    DateOnly? InitialAllocationDate = null,
    int? RecurMonths = null,
    decimal? MonthlyContribution = null,
    bool IncludeDeadlineMonth = false);

/// <summary>Request body for editing a jar (the id comes from the route).</summary>
public record UpdateJarRequest(
    string Name,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    AccrualMethod Accrual,
    Guid FundingAccountId,
    int? RecurMonths = null,
    decimal? MonthlyContribution = null,
    bool IncludeDeadlineMonth = false);

/// <summary>Request body for previewing a jar definition's schedule; JarId is set when editing an existing jar.</summary>
public record JarScheduleRequest(
    Guid? JarId,
    JarKind Kind,
    decimal TargetAmount,
    DateOnly? TargetDate,
    AccrualMethod Accrual,
    decimal? MonthlyContribution = null,
    bool IncludeDeadlineMonth = false,
    int? RecurMonths = null,
    decimal InitialAllocation = 0m);

/// <summary>Request body for marking a cycle paid: the cycle's deadline and the payment that fulfilled it.</summary>
public record MarkJarCyclePaidRequest(DateOnly Deadline, Guid PaymentTransactionId);

/// <summary>Request body for dismissing a missed cycle: the open cycle's deadline, so a stale page can't dismiss the wrong one.</summary>
public record DismissJarCycleRequest(DateOnly Deadline);

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
