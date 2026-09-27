using FluentValidation;

namespace AllotJar.Application.Jars.Queries.GetJarSchedule;

public class GetJarScheduleQueryValidator : AbstractValidator<GetJarScheduleQuery>
{
    public GetJarScheduleQueryValidator()
    {
        this.JarDefinition();

        RuleFor(x => x.InitialAllocation)
            .InclusiveBetween(0m, JarDefinitionRules.MaxAmount)
            .WithMessage("The amount already set aside must be zero or more.");
    }
}
