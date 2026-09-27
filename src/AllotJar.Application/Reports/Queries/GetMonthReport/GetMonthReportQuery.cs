using MediatR;
using AllotJar.Application.Reports.Dtos;

namespace AllotJar.Application.Reports.Queries.GetMonthReport;

/// <summary>One calendar month's report figures and spending by group (rules 37–39, 41), whether or not it has a budget.</summary>
public record GetMonthReportQuery(int Year, int Month) : IRequest<MonthReportDto>;
