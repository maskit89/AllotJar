using FluentValidation;

namespace AllotJar.Application.Household.Commands.UpdateHouseholdMember;

public class UpdateHouseholdMemberCommandValidator : AbstractValidator<UpdateHouseholdMemberCommand>
{
    private const decimal MaxAmount = 99_999_999_999_999.9999m;

    public UpdateHouseholdMemberCommandValidator()
    {
        RuleFor(x => x.Id).NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A member needs a name.")
            .MaximumLength(120);

        RuleFor(x => x.NetMonthlyIncome)
            .InclusiveBetween(0m, MaxAmount)
            .WithMessage("Net monthly income is out of range.");
    }
}
