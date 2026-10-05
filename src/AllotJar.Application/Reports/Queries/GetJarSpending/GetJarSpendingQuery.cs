using MediatR;
using AllotJar.Application.Reports.Dtos;

namespace AllotJar.Application.Reports.Queries.GetJarSpending;

/// <summary>What was spent from each jar in one calendar year, month by month.</summary>
public record GetJarSpendingQuery(int Year) : IRequest<JarSpendingReportDto>;
