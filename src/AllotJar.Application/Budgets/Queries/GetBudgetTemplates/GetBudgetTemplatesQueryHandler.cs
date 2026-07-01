using MediatR;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Budgets.Templates;

namespace AllotJar.Application.Budgets.Queries.GetBudgetTemplates;

public class GetBudgetTemplatesQueryHandler
    : IRequestHandler<GetBudgetTemplatesQuery, IReadOnlyList<BudgetTemplateDto>>
{
    public Task<IReadOnlyList<BudgetTemplateDto>> Handle(
        GetBudgetTemplatesQuery request, CancellationToken cancellationToken)
    {
        IReadOnlyList<BudgetTemplateDto> result = BudgetTemplates.All
            .Select(t => t.ToDto())
            .ToList();

        return Task.FromResult(result);
    }
}
