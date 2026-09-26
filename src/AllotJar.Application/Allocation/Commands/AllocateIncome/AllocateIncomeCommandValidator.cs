using FluentValidation;

namespace AllotJar.Application.Allocation.Commands.AllocateIncome;

public class AllocateIncomeCommandValidator : AbstractValidator<AllocateIncomeCommand>
{
    public AllocateIncomeCommandValidator()
    {
        RuleFor(x => x.Year).InclusiveBetween(2000, 2100);
        RuleFor(x => x.Month).InclusiveBetween(1, 12);

        // Plans never become money by themselves: the commit records bank transfers the user
        // says they have made, on the date they made them.
        RuleFor(x => x.ConfirmedCompleted)
            .Equal(true)
            .WithMessage("Confirm that you've completed these transfers before recording them.");
        RuleFor(x => x.DepartedOn)
            .NotNull()
            .WithMessage("Enter the date the money left the source account.");

        RuleFor(x => x.ReceivedOn)
            .GreaterThanOrEqualTo(x => x.DepartedOn!.Value)
            .When(x => x.ReceivedOn.HasValue && x.DepartedOn.HasValue)
            .WithMessage("The receipt date can't be before the departure date.");
    
        RuleFor(x => x.JarAllocations)
            .Must(list => list is null || list.All(a => a.MemberId != Guid.Empty && a.JarId != Guid.Empty && a.Amount >= 0m))
            .WithMessage("Each jar amount needs a member, a jar and an amount of zero or more.");
    }
}
