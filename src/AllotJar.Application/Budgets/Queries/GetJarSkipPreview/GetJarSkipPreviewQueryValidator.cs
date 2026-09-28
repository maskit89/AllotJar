using FluentValidation;

namespace AllotJar.Application.Budgets.Queries.GetJarSkipPreview;

public class GetJarSkipPreviewQueryValidator : AbstractValidator<GetJarSkipPreviewQuery>
{
    public GetJarSkipPreviewQueryValidator()
    {
        RuleFor(x => x.BudgetItemId).NotEmpty();
    }
}
