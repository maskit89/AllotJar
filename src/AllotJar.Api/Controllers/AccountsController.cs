using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Accounts.Queries.GetAccountReconciliation;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Api.Features;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Controllers;

/// <summary>
/// The user's accounts and their derived balances. Every handler is owner-scoped.
/// An account's balance is computed from its transactions, never stored.
/// </summary>
[ApiController]
[Authorize]
[FeatureGate(nameof(FeatureFlags.Accounts))]
[Route("api/[controller]")]
public class AccountsController : ControllerBase
{
    private readonly ISender _mediator;

    public AccountsController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>Lists the user's accounts with their current (derived) balances.</summary>
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<AccountDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<AccountDto>>> List(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetAccountsQuery(), ct);
        return Ok(result);
    }

    /// <summary>Reconciles each account against the sinking funds it backs (balance vs backed total vs float).</summary>
    [HttpGet("reconciliation")]
    [ProducesResponseType(typeof(IReadOnlyList<AccountReconciliationDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<AccountReconciliationDto>>> Reconciliation(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetAccountReconciliationQuery(), ct);
        return Ok(result);
    }

    /// <summary>Creates a new account and returns it.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(AccountDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<AccountDto>> Create(CreateAccountRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new CreateAccountCommand(
                request.Name, request.Type, request.Currency, request.OpeningBalance, request.OpeningDate),
            ct);
        return CreatedAtAction(nameof(List), new { }, result);
    }

    /// <summary>Edits an account's name, type, opening balance and opening date. Returns it.</summary>
    [HttpPut("{id:guid}")]
    [ProducesResponseType(typeof(AccountDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<AccountDto>> Update(Guid id, UpdateAccountRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new UpdateAccountCommand(id, request.Name, request.Type, request.OpeningBalance, request.OpeningDate), ct);
        return Ok(result);
    }

    /// <summary>
    /// Deletes an account; its income/expense transactions survive but become unlinked. Refused
    /// (400) while the account is a side of any transfer.
    /// </summary>
    [HttpDelete("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await _mediator.Send(new DeleteAccountCommand(id), ct);
        return NoContent();
    }
}

/// <summary>Request body for creating an account. The opening balance applies from the start of <c>OpeningDate</c>.</summary>
public record CreateAccountRequest(
    string Name, AccountType Type, string Currency, decimal OpeningBalance, DateOnly? OpeningDate = null);

/// <summary>Request body for editing an account (the id comes from the route; currency is immutable).</summary>
public record UpdateAccountRequest(
    string Name, AccountType Type, decimal OpeningBalance, DateOnly? OpeningDate = null);
