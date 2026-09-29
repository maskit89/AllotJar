using FluentValidation;

namespace AllotJar.Application.Jars.Queries.GetJars;

/// <summary>
/// The month and "today" a jars read may ask for: the years a budget month can have (2000–2100,
/// as the month validators say). Outside them the month's first or last day, or the day before
/// it, is not a date, which surfaced as a 500 instead of a 400 (P3-5).
/// </summary>
public class GetJarsQueryValidator : AbstractValidator<GetJarsQuery>
{
    public GetJarsQueryValidator()
    {
        RuleFor(x => x.Month!.Value.Year)
            .InclusiveBetween(2000, 2100)
            .WithName("Year")
            .When(x => x.Month is not null);

        RuleFor(x => x.AsOf!.Value.Year)
            .InclusiveBetween(2000, 2100)
            .WithName("AsOf")
            .WithMessage("'AsOf' must be a date in the years 2000 to 2100.")
            .When(x => x.AsOf is not null);
    }
}
