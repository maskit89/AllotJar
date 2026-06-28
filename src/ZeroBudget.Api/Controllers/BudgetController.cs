using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ZeroBudget.Application.Budgets.Commands.AddBudgetCategory;
using ZeroBudget.Application.Budgets.Commands.AddBudgetItem;
using ZeroBudget.Application.Budgets.Commands.CreateBudgetMonth;
using ZeroBudget.Application.Budgets.Commands.DeleteBudgetCategory;
using ZeroBudget.Application.Budgets.Commands.DeleteBudgetItem;
using ZeroBudget.Application.Budgets.Commands.RenameBudgetCategory;
using ZeroBudget.Application.Budgets.Commands.ReorderBudgetCategories;
using ZeroBudget.Application.Budgets.Commands.ReorderBudgetItems;
using ZeroBudget.Application.Budgets.Commands.SetBudgetItemBill;
using ZeroBudget.Application.Budgets.Commands.SetBudgetItemPaid;
using ZeroBudget.Application.Budgets.Commands.UpdateBudgetItem;
using ZeroBudget.Application.Budgets.Dtos;
using ZeroBudget.Application.Budgets.Queries.GetBudgetMonth;
using ZeroBudget.Application.Budgets.Queries.GetBudgetMonths;
using ZeroBudget.Application.Budgets.Queries.GetBudgetTemplates;
using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Api.Controllers;

/// <summary>
/// All budgeting endpoints require a valid JWT. The MediatR handlers behind
/// these actions additionally scope every read/write to the caller's own data.
/// </summary>
[ApiController]
[Authorize]
[Route("api/[controller]")]
public class BudgetController : ControllerBase
{
    private readonly ISender _mediator;

    public BudgetController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>Gets the authenticated user's budget for a specific month.</summary>
    [HttpGet("{year:int}/{month:int}")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> GetMonth(int year, int month, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetBudgetMonthQuery(year, month), ct);
        return Ok(result);
    }

    /// <summary>Convenience endpoint for the current (server-side) month.</summary>
    [HttpGet("current")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<BudgetMonthDto>> GetCurrentMonth(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var result = await _mediator.Send(new GetBudgetMonthQuery(now.Year, now.Month), ct);
        return Ok(result);
    }

    /// <summary>Lists which months the user has a budget for (for the month navigator).</summary>
    [HttpGet("months")]
    [ProducesResponseType(typeof(IReadOnlyList<BudgetMonthSummaryDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<BudgetMonthSummaryDto>>> GetMonths(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetBudgetMonthsQuery(), ct);
        return Ok(result);
    }

    /// <summary>Lists the built-in quick-start budget templates.</summary>
    [HttpGet("templates")]
    [ProducesResponseType(typeof(IReadOnlyList<BudgetTemplateDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<BudgetTemplateDto>>> GetTemplates(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetBudgetTemplatesQuery(), ct);
        return Ok(result);
    }

    /// <summary>
    /// Creates the user's budget for a month — from a quick-start template, by copying
    /// the previous month, or blank. Returns the new month.
    /// </summary>
    [HttpPost]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<BudgetMonthDto>> CreateMonth(
        CreateBudgetMonthRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new CreateBudgetMonthCommand(request.Year, request.Month, request.CopyFromPrevious, request.TemplateKey), ct);
        return Ok(result);
    }

    /// <summary>
    /// Updates a single line's planned amount (and optionally its name) and returns
    /// the recomputed month, including the new "Remaining to Budget" pool.
    /// </summary>
    [HttpPut("items/{id:guid}")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> UpdateItem(
        Guid id,
        UpdateBudgetItemRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new UpdateBudgetItemCommand(id, request.PlannedAmount, request.Name), ct);
        return Ok(result);
    }

    /// <summary>Creates a new expense or fund category group and returns the recomputed month.</summary>
    [HttpPost("categories")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> AddCategory(
        AddBudgetCategoryRequest request,
        CancellationToken ct)
    {
        var kind = request.IsSavings ? CategoryKind.Savings : CategoryKind.Expense;
        var result = await _mediator.Send(
            new AddBudgetCategoryCommand(request.BudgetMonthId, request.Name, kind), ct);
        return Ok(result);
    }

    /// <summary>Reorders a month's category groups and returns the recomputed month.</summary>
    [HttpPut("categories/order")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> ReorderCategories(
        ReorderBudgetCategoriesRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new ReorderBudgetCategoriesCommand(request.BudgetMonthId, request.OrderedCategoryIds), ct);
        return Ok(result);
    }

    /// <summary>Renames a category group and returns the recomputed month.</summary>
    [HttpPut("categories/{id:guid}")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> RenameCategory(
        Guid id,
        RenameBudgetCategoryRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(new RenameBudgetCategoryCommand(id, request.Name), ct);
        return Ok(result);
    }

    /// <summary>Deletes a category group (and its lines) and returns the recomputed month.</summary>
    [HttpDelete("categories/{id:guid}")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> DeleteCategory(Guid id, CancellationToken ct)
    {
        var result = await _mediator.Send(new DeleteBudgetCategoryCommand(id), ct);
        return Ok(result);
    }

    /// <summary>Reorders the lines within a category and returns the recomputed month.</summary>
    [HttpPut("categories/{categoryId:guid}/items/order")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> ReorderItems(
        Guid categoryId,
        ReorderBudgetItemsRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new ReorderBudgetItemsCommand(categoryId, request.OrderedItemIds), ct);
        return Ok(result);
    }

    /// <summary>
    /// Adds a new line to a category (an income source, or a spending line) and
    /// returns the recomputed month. The category id comes from the route.
    /// </summary>
    [HttpPost("categories/{categoryId:guid}/items")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> AddItem(
        Guid categoryId,
        AddBudgetItemRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(
            new AddBudgetItemCommand(categoryId, request.Name, request.PlannedAmount), ct);
        return Ok(result);
    }

    /// <summary>
    /// Marks a line as a bill due on a day of the month (1–31), or clears the bill
    /// when dueDay is null. Returns the recomputed month.
    /// </summary>
    [HttpPut("items/{id:guid}/bill")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> SetItemBill(
        Guid id,
        SetBudgetItemBillRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(new SetBudgetItemBillCommand(id, request.DueDay), ct);
        return Ok(result);
    }

    /// <summary>Marks this month's bill line as paid/unpaid and returns the recomputed month.</summary>
    [HttpPut("items/{id:guid}/paid")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> SetItemPaid(
        Guid id,
        SetBudgetItemPaidRequest request,
        CancellationToken ct)
    {
        var result = await _mediator.Send(new SetBudgetItemPaidCommand(id, request.IsPaid), ct);
        return Ok(result);
    }

    /// <summary>Deletes a single budget line and returns the recomputed month.</summary>
    [HttpDelete("items/{id:guid}")]
    [ProducesResponseType(typeof(BudgetMonthDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<BudgetMonthDto>> DeleteItem(Guid id, CancellationToken ct)
    {
        var result = await _mediator.Send(new DeleteBudgetItemCommand(id), ct);
        return Ok(result);
    }
}

/// <summary>Request body for creating a month's budget (optionally from a template).</summary>
public record CreateBudgetMonthRequest(int Year, int Month, bool CopyFromPrevious = true, string? TemplateKey = null);

/// <summary>Request body for updating a budget line (the id comes from the route).</summary>
public record UpdateBudgetItemRequest(decimal PlannedAmount, string? Name = null);

/// <summary>Request body for adding a budget line (the category id comes from the route).</summary>
public record AddBudgetItemRequest(string Name, decimal PlannedAmount = 0m);

/// <summary>Request body for setting/clearing a line's bill due day (null clears the bill).</summary>
public record SetBudgetItemBillRequest(int? DueDay);

/// <summary>Request body for marking a bill paid/unpaid (the id comes from the route).</summary>
public record SetBudgetItemPaidRequest(bool IsPaid);

/// <summary>Request body for creating a category group (a fund group when IsSavings is true).</summary>
public record AddBudgetCategoryRequest(Guid BudgetMonthId, string Name, bool IsSavings = false);

/// <summary>Request body for renaming a category group (the id comes from the route).</summary>
public record RenameBudgetCategoryRequest(string Name);

/// <summary>Request body for reordering a month's category groups.</summary>
public record ReorderBudgetCategoriesRequest(Guid BudgetMonthId, IReadOnlyList<Guid> OrderedCategoryIds);

/// <summary>Request body for reordering the lines within a category (id from the route).</summary>
public record ReorderBudgetItemsRequest(IReadOnlyList<Guid> OrderedItemIds);
