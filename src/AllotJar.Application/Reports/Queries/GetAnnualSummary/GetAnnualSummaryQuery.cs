using MediatR;
using AllotJar.Application.Reports.Dtos;

namespace AllotJar.Application.Reports.Queries.GetAnnualSummary;

/// <summary>Rolls a single calendar year's budgets up into a 12-month overview.</summary>
public record GetAnnualSummaryQuery(int Year) : IRequest<AnnualSummaryDto>;
