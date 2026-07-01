using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Queries.GetBudgetTemplates;

/// <summary>Lists the built-in quick-start budget templates.</summary>
public record GetBudgetTemplatesQuery : IRequest<IReadOnlyList<BudgetTemplateDto>>;
