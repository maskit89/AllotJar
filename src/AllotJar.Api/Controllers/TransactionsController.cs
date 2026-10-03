using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.ConfirmConvertedAmount;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.LinkRefund;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Application.Transactions.Queries.GetConversionSuggestion;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/[controller]")]
public class TransactionsController : ControllerBase
{
    private readonly ISender _mediator;

    public TransactionsController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>Lists the user's transactions, optionally filtered by month / unassigned.</summary>
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<TransactionDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<TransactionDto>>> List(
        [FromQuery] int? year,
        [FromQuery] int? month,
        [FromQuery] bool unassignedOnly = false,
        CancellationToken ct = default)
    {
        var result = await _mediator.Send(new GetTransactionsQuery(year, month, unassignedOnly), ct);
        return Ok(result);
    }

    /// <summary>Creates a manually-entered transaction and returns it.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> Create(
        CreateTransactionRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new CreateTransactionCommand(
                request.Date, request.Payee, request.Amount, request.Type,
                request.BudgetItemId, request.AccountId, request.MemberId,
                request.Splits?.Select(a => new SplitAllocationInput(a.BudgetItemId, a.Amount, a.MemberId)).ToList(),
                request.AcknowledgeCrossMonth,
                request.JarAllocations?.Select(a => new JarAllocationInput(a.JarId, a.Amount)).ToList(),
                request.PaidFromJarId,
                request.RefundOfTransactionId,
                request.OriginalAmount,
                request.OriginalCurrency),
            ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>
    /// Suggests the budget-currency amount for money paid in another currency, from the reference
    /// rate for that date (rule 44). Records nothing; rate and amount are null when no rate is available.
    /// </summary>
    [HttpGet("conversion-suggestion")]
    [ProducesResponseType(typeof(ConversionSuggestionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ConversionSuggestionDto>> ConversionSuggestion(
        [FromQuery] string currency,
        [FromQuery] decimal amount,
        [FromQuery] DateOnly date,
        CancellationToken ct)
    {
        var result = await _mediator.Send(new GetConversionSuggestionQuery(currency, amount, date), ct);
        return Ok(result);
    }

    /// <summary>
    /// Gives a transaction recorded in another currency its amount in the budget currency, typed or
    /// a confirmed suggestion; from then on it counts (rules 44/85). Returns the updated transaction.
    /// </summary>
    [HttpPut("{id:guid}/converted-amount")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> ConfirmConvertedAmount(
        Guid id, ConfirmConvertedAmountRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new ConfirmConvertedAmountCommand(id, request.Amount), ct);
        return Ok(result);
    }

    /// <summary>
    /// Records a completed transfer between two of the user's accounts and returns it. The
    /// departure date is required; the receipt date is optional and, when omitted, the amount
    /// stays in transit until confirmed via <see cref="ConfirmTransferLegs"/>.
    /// </summary>
    [HttpPost("transfer")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> Transfer(CreateTransferRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new CreateTransferCommand(
                request.DepartedOn, request.Amount, request.FromAccountId, request.ToAccountId,
                request.Payee, request.ReceivedOn, request.FromJarId,
                request.JarAllocations?.Select(a => new JarAllocationInput(a.JarId, a.Amount)).ToList(),
                request.Fee, request.FeeBudgetItemId, request.AcknowledgeCrossMonth),
            ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>
    /// Corrects a recorded transfer in place: accounts, amount, bank dates (including a return
    /// to the source), note, fee and jar answers. Legs a bank statement confirmed keep the bank's
    /// account, date and amount.
    /// </summary>
    [HttpPut("{id:guid}/transfer")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> UpdateTransfer(
        Guid id, UpdateTransferRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new UpdateTransferCommand(
                id, request.FromAccountId, request.ToAccountId, request.Amount, request.DepartedOn, request.ReceivedOn,
                request.ReturnedOn, request.Payee, request.Fee, request.FeeBudgetItemId, request.AcknowledgeCrossMonth,
                request.FromJarId, request.JarAllocations?.Select(a => new JarAllocationInput(a.JarId, a.Amount)).ToList()),
            ct);
        return Ok(result);
    }

    /// <summary>
    /// Confirms the bank legs a transfer is still missing (receipt date for an in-transit
    /// transfer; departure date for a receipt held for review) and attaches statement references.
    /// Confirmed legs are never overwritten.
    /// </summary>
    [HttpPut("{id:guid}/transfer-legs")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> ConfirmTransferLegs(
        Guid id, ConfirmTransferLegsRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new ConfirmTransferLegsCommand(
                id, request.DepartedOn, request.ReceivedOn, request.BankReference, request.ReceiptBankReference,
                request.FromJarId, request.JarAllocations?.Select(a => new JarAllocationInput(a.JarId, a.Amount)).ToList()),
            ct);
        return Ok(result);
    }

    /// <summary>Edits a transaction's date, payee, amount and direction. Returns it.</summary>
    [HttpPut("{id:guid}")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> Update(
        Guid id,
        UpdateTransactionRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new UpdateTransactionCommand(
                id, request.Date, request.Payee, request.Amount, request.Type, request.AccountId, request.MemberId,
                request.AcknowledgeCrossMonth,
                request.JarAllocations?.Select(a => new JarAllocationInput(a.JarId, a.Amount)).ToList(),
                request.PaidFromJarId),
            ct);
        return Ok(result);
    }

    /// <summary>
    /// Deletes one of the user's transactions. 204 when nothing needs saying; 200 with a
    /// <c>warning</c> when the delete left something for the user to settle (D10).
    /// </summary>
    [HttpDelete("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(DeleteTransactionResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var result = await _mediator.Send(new DeleteTransactionCommand(id), ct);
        return result.Warning is null ? NoContent() : Ok(result);
    }

    /// <summary>Splits a transaction across two or more budget lines (replaces any prior split / whole assignment).</summary>
    [HttpPut("{id:guid}/splits")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> Split(
        Guid id,
        SplitTransactionRequest request,
        CancellationToken ct)
    {
        var allocations = (request.Allocations ?? new List<SplitAllocationRequest>())
            .Select(a => new SplitAllocationInput(a.BudgetItemId, a.Amount, a.MemberId))
            .ToList();
        var result = await _mediator.Send(
            new SplitTransactionCommand(id, allocations, request.AcknowledgeCrossMonth, request.PaidFromJarId), ct);
        return Ok(result);
    }

    /// <summary>
    /// Marks money received as a refund of one of the user's purchases (rules 38/39), or clears the
    /// link when refundOfTransactionId is null. Returns the updated transaction.
    /// </summary>
    [HttpPut("{id:guid}/refund")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> LinkRefund(
        Guid id,
        LinkRefundRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new LinkRefundCommand(id, request.RefundOfTransactionId, request.BudgetItemId, request.AcknowledgeCrossMonth), ct);
        return Ok(result);
    }

    /// <summary>Assigns a transaction to a budget line, or clears it when budgetItemId is null.</summary>
    [HttpPut("{id:guid}/assignment")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> Assign(
        Guid id,
        AssignTransactionRequest request,
        CancellationToken ct)
    {
        // AcknowledgeCrossMonth MUST reach the command: the client's cross-month confirm dialog
        // re-sends with it set, and dropping it here (as an earlier revision did) makes the
        // confirmed retry fail with the same 400 it is acknowledging.
        var result = await _mediator.Send(
            new AssignTransactionCommand(id, request.BudgetItemId, request.AcknowledgeCrossMonth, request.PaidFromJarId), ct);
        return Ok(result);
    }
}

/// <summary>Request body for assigning a transaction (null clears the assignment).</summary>
public record AssignTransactionRequest(Guid? BudgetItemId, bool AcknowledgeCrossMonth = false, Guid? PaidFromJarId = null);

/// <summary>
/// Request body for marking a transaction as a refund of a purchase (null clears the link). The
/// optional line is validated as an expense/savings line when linking and as an income line when
/// unlinking; when omitted, a linked refund lands on the purchase's line in its own month.
/// </summary>
public record LinkRefundRequest(Guid? RefundOfTransactionId, Guid? BudgetItemId = null, bool AcknowledgeCrossMonth = false);

/// <summary>Part of money reaching a jar-backed account, put into one of its jars (rule 78).</summary>
public record JarAllocationRequest(Guid JarId, decimal Amount);

/// <summary>
/// Request body for creating a manual transaction. When <c>Splits</c> is given (two or more
/// slices summing to <c>Amount</c>), the transaction is created already split and
/// <c>BudgetItemId</c>/<c>MemberId</c> must be null — the slices carry the attribution.
/// </summary>
public record CreateTransactionRequest(
    DateOnly Date,
    string Payee,
    decimal Amount,
    TransactionType Type,
    Guid? BudgetItemId,
    Guid? AccountId = null,
    Guid? MemberId = null,
    IReadOnlyList<SplitAllocationRequest>? Splits = null,
    bool AcknowledgeCrossMonth = false,
    IReadOnlyList<JarAllocationRequest>? JarAllocations = null,
    Guid? PaidFromJarId = null,
    Guid? RefundOfTransactionId = null,
    decimal? OriginalAmount = null,
    string? OriginalCurrency = null);

/// <summary>Request body for giving a transaction in another currency its budget-currency amount.</summary>
public record ConfirmConvertedAmountRequest(decimal Amount);

/// <summary>
/// Request body for recording a completed transfer between two accounts. <c>DepartedOn</c> is
/// the source bank's posting date; <c>ReceivedOn</c> the destination bank's, when already known.
/// </summary>
public record CreateTransferRequest(
    DateOnly DepartedOn,
    decimal Amount,
    Guid FromAccountId,
    Guid ToAccountId,
    string? Payee = null,
    DateOnly? ReceivedOn = null,
    Guid? FromJarId = null,
    IReadOnlyList<JarAllocationRequest>? JarAllocations = null,
    decimal? Fee = null,
    Guid? FeeBudgetItemId = null,
    bool AcknowledgeCrossMonth = false);

/// <summary>
/// Request body for editing a transfer (the id comes from the route). Every field replaces what
/// was stored; a jar answer left out returns that leg to its default.
/// </summary>
public record UpdateTransferRequest(
    Guid FromAccountId,
    Guid ToAccountId,
    decimal Amount,
    DateOnly? DepartedOn = null,
    DateOnly? ReceivedOn = null,
    DateOnly? ReturnedOn = null,
    string? Payee = null,
    decimal? Fee = null,
    Guid? FeeBudgetItemId = null,
    bool AcknowledgeCrossMonth = false,
    Guid? FromJarId = null,
    IReadOnlyList<JarAllocationRequest>? JarAllocations = null);

/// <summary>Request body for confirming a transfer's missing bank legs (the id comes from the route).</summary>
public record ConfirmTransferLegsRequest(
    DateOnly? DepartedOn = null,
    DateOnly? ReceivedOn = null,
    string? BankReference = null,
    string? ReceiptBankReference = null,
    Guid? FromJarId = null,
    IReadOnlyList<JarAllocationRequest>? JarAllocations = null);

/// <summary>Request body for editing a transaction (the id comes from the route).</summary>
public record UpdateTransactionRequest(
    DateOnly Date,
    string Payee,
    decimal Amount,
    TransactionType Type,
    Guid? AccountId = null,
    Guid? MemberId = null,
    bool AcknowledgeCrossMonth = false,
    IReadOnlyList<JarAllocationRequest>? JarAllocations = null,
    Guid? PaidFromJarId = null);

/// <summary>Request body for splitting a transaction across budget lines.</summary>
public record SplitTransactionRequest(
    IReadOnlyList<SplitAllocationRequest> Allocations,
    bool AcknowledgeCrossMonth = false,
    Guid? PaidFromJarId = null);

/// <summary>One slice of a split: an amount attributed to a budget line and, optionally, a household member.</summary>
public record SplitAllocationRequest(Guid BudgetItemId, decimal Amount, Guid? MemberId = null);
