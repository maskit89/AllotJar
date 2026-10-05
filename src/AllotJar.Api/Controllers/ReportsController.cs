using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Application.Reports.Dtos;
using AllotJar.Application.Reports.Queries.GetAnnualSummary;
using AllotJar.Application.Reports.Queries.GetBudgetTrends;
using AllotJar.Application.Reports.Queries.GetJarSpending;
using AllotJar.Application.Reports.Queries.GetMonthReport;
using AllotJar.Api.Features;

namespace AllotJar.Api.Controllers;

/// <summary>
/// Read-only analytics over the user's own budgets. Every query is owner-scoped
/// in its MediatR handler.
/// </summary>
[ApiController]
[Authorize]
[FeatureGate(nameof(FeatureFlags.Reports))]
[Route("api/[controller]")]
public class ReportsController : ControllerBase
{
    private readonly ISender _mediator;

    public ReportsController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>
    /// Income / planned / spent rolled up over the user's most recent
    /// <paramref name="months"/> budgets (chronological).
    /// </summary>
    [HttpGet("trends")]
    [ProducesResponseType(typeof(BudgetTrendsDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<BudgetTrendsDto>> Trends(
        [FromQuery] int months = 6,
        CancellationToken ct = default)
    {
        var result = await _mediator.Send(new GetBudgetTrendsQuery(months), ct);
        return Ok(result);
    }

    /// <summary>
    /// One calendar month's figures and spending by group (rules 37–39, 41): categorised and
    /// uncategorised spending, refunds, received vs budgeted income and the variance.
    /// </summary>
    [HttpGet("month/{year:int}/{month:int}")]
    [ProducesResponseType(typeof(MonthReportDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<MonthReportDto>> Month(int year, int month, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetMonthReportQuery(year, month), ct);
        return Ok(result);
    }

    /// <summary>
    /// What was spent from each jar in one calendar year, month by month (rule 79 draws, net of
    /// refunds; moves between jars are not spending), every live jar listed.
    /// </summary>
    [HttpGet("jars/{year:int}")]
    [ProducesResponseType(typeof(JarSpendingReportDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<JarSpendingReportDto>> Jars(int year, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetJarSpendingQuery(year), ct);
        return Ok(result);
    }

    /// <summary>A 12-month overview (income / planned / spent + totals) for one calendar year.</summary>
    [HttpGet("annual/{year:int}")]
    [ProducesResponseType(typeof(AnnualSummaryDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<AnnualSummaryDto>> Annual(int year, CancellationToken ct)
    {
        var result = await _mediator.Send(new GetAnnualSummaryQuery(year), ct);
        return Ok(result);
    }
}
