using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Queries.GetMonthWrapUp;

/// <summary>
/// How a month went in actual money, for the card that starts the month after it: what came in,
/// what was spent, what went into jars and what was left over, counting what earlier months
/// carried in (<see cref="MonthLeftover"/>).
/// </summary>
public record GetMonthWrapUpQuery(int Year, int Month) : IRequest<MonthWrapUpDto>;
