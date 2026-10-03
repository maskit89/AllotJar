using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Application.Accounts.Commands.CompleteSharingReview;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Commands.EraseUnreachableAccount;
using AllotJar.Application.Accounts.Commands.SetAccountSharing;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Accounts.Queries.GetAccountReconciliation;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Accounts.Queries.GetSharingReview;
using AllotJar.Application.Accounts.Queries.GetUnreachableAccounts;
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
                request.Name, request.Type, request.Currency, request.OpeningBalance, request.OpeningDate,
                request.Iban, request.Bic, request.SortCode, request.AccountNumber, request.HolderIds, request.IsPrivate),
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
            new UpdateAccountCommand(id, request.Name, request.Type, request.OpeningBalance, request.OpeningDate,
                request.Iban, request.Bic, request.SortCode, request.AccountNumber, request.HolderIds, request.Version), ct);
        return Ok(result);
    }

    /// <summary>
    /// The holder's choice for a personal account (rules 31/33): private to their login, or shared
    /// with the household. Refused for anyone else, for joint or household accounts and for an
    /// account a jar uses.
    /// </summary>
    [HttpPut("{id:guid}/sharing")]
    [ProducesResponseType(typeof(AccountDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<AccountDto>> SetSharing(Guid id, SetAccountSharingRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new SetAccountSharingCommand(id, request.IsPrivate), ct);
        return Ok(result);
    }

    /// <summary>The caller's personal accounts and whether their sharing review is due (rule 32).</summary>
    [HttpGet("sharing-review")]
    [ProducesResponseType(typeof(SharingReviewDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<SharingReviewDto>> SharingReview(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetSharingReviewQuery(), ct);
        return Ok(result);
    }

    /// <summary>Answers the sharing review: the listed personal accounts become private, the rest shared.</summary>
    [HttpPost("sharing-review")]
    [ProducesResponseType(typeof(SharingReviewDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<SharingReviewDto>> CompleteSharingReview(CompleteSharingReviewRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new CompleteSharingReviewCommand(request.PrivateAccountIds ?? Array.Empty<Guid>()), ct);
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

    /// <summary>
    /// The accounts private to a login no longer in the household (P59): nobody can reach them.
    /// The owner sees each one's name, holder and entry count, never its entries. Empty for
    /// every other role.
    /// </summary>
    [HttpGet("unreachable")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<UnreachableAccountDto>>> Unreachable(CancellationToken ct) =>
        Ok(await _mediator.Send(new GetUnreachableAccountsQuery(), ct));

    /// <summary>
    /// Erases for good an account nobody can reach, with every entry in it and every transfer
    /// touching it. The body must carry the account's name, typed. Owner only; 400 when the name
    /// doesn't match, when a refund elsewhere names a purchase in it, or when a shared account
    /// would go below zero without a transfer from it (rule 74).
    /// </summary>
    [HttpPost("{id:guid}/erase")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Erase(Guid id, EraseUnreachableAccountRequest request, CancellationToken ct)
    {
        await _mediator.Send(new EraseUnreachableAccountCommand(id, request.ConfirmName ?? string.Empty), ct);
        return NoContent();
    }
}

/// <summary>Request body for erasing an account nobody can reach: the account's name, typed to confirm.</summary>
public record EraseUnreachableAccountRequest(string? ConfirmName);

/// <summary>Request body for creating an account. The opening balance applies from the start of <c>OpeningDate</c>.</summary>
public record CreateAccountRequest(
    string Name, AccountType Type, string Currency, decimal OpeningBalance, DateOnly? OpeningDate = null,
    string? Iban = null, string? Bic = null, string? SortCode = null, string? AccountNumber = null,
    IReadOnlyList<Guid>? HolderIds = null, bool? IsPrivate = null);

/// <summary>Request body for editing an account (the id comes from the route; currency is immutable).</summary>
public record UpdateAccountRequest(
    string Name, AccountType Type, decimal OpeningBalance, DateOnly? OpeningDate = null,
    string? Iban = null, string? Bic = null, string? SortCode = null, string? AccountNumber = null,
    IReadOnlyList<Guid>? HolderIds = null,
    // The version the edit form loaded (D11); null only from a client older than this deploy.
    string? Version = null);

/// <summary>Request body for the holder's sharing choice.</summary>
public record SetAccountSharingRequest(bool IsPrivate);

/// <summary>Request body answering the sharing review: the accounts to keep private.</summary>
public record CompleteSharingReviewRequest(IReadOnlyList<Guid>? PrivateAccountIds);
