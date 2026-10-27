using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Queries.GetMonthWrapUp;

/// <summary>
/// How a month went in actual money, for the card that starts the month after it and the "From"
/// line of its own budget: what earlier months carried in, what came in, what was spent, what
/// went into jars and what was left over (<see cref="MonthLeftover"/>).
/// </summary>
public record GetMonthWrapUpQuery(int Year, int Month) : IRequest<MonthWrapUpDto>;
