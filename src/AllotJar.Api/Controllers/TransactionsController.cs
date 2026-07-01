using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Dtos;
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
                request.BudgetItemId, request.AccountId, request.MemberId),
            ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>Records a transfer between two of the user's accounts and returns it.</summary>
    [HttpPost("transfer")]
    [ProducesResponseType(typeof(TransactionDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TransactionDto>> Transfer(CreateTransferRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new CreateTransferCommand(request.Date, request.Amount, request.FromAccountId, request.ToAccountId, request.Payee),
            ct);
        return CreatedAtAction(nameof(List), new { }, result);
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
                id, request.Date, request.Payee, request.Amount, request.Type, request.AccountId, request.MemberId),
            ct);
        return Ok(result);
    }

    /// <summary>Deletes one of the user's transactions.</summary>
    [HttpDelete("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await _mediator.Send(new DeleteTransactionCommand(id), ct);
        return NoContent();
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
        var result = await _mediator.Send(new SplitTransactionCommand(id, allocations), ct);
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
        var result = await _mediator.Send(new AssignTransactionCommand(id, request.BudgetItemId), ct);
        return Ok(result);
    }
}

/// <summary>Request body for assigning a transaction (null clears the assignment).</summary>
public record AssignTransactionRequest(Guid? BudgetItemId);

/// <summary>Request body for creating a manual transaction.</summary>
public record CreateTransactionRequest(
    DateOnly Date,
    string Payee,
    decimal Amount,
    TransactionType Type,
    Guid? BudgetItemId,
    Guid? AccountId = null,
    Guid? MemberId = null);

/// <summary>Request body for transferring money between two accounts.</summary>
public record CreateTransferRequest(
    DateOnly Date,
    decimal Amount,
    Guid FromAccountId,
    Guid ToAccountId,
    string? Payee = null);

/// <summary>Request body for editing a transaction (the id comes from the route).</summary>
public record UpdateTransactionRequest(
    DateOnly Date,
    string Payee,
    decimal Amount,
    TransactionType Type,
    Guid? AccountId = null,
    Guid? MemberId = null);

/// <summary>Request body for splitting a transaction across budget lines.</summary>
public record SplitTransactionRequest(IReadOnlyList<SplitAllocationRequest> Allocations);

/// <summary>One slice of a split: an amount attributed to a budget line and, optionally, a household member.</summary>
public record SplitAllocationRequest(Guid BudgetItemId, decimal Amount, Guid? MemberId = null);
