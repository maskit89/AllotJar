using FluentValidation;

namespace AllotJar.Application.Jars.Commands.ReallocateJarMoney;

public class ReallocateJarMoneyCommandValidator : AbstractValidator<ReallocateJarMoneyCommand>
{
    public ReallocateJarMoneyCommandValidator()
    {
        RuleFor(x => x.AccountId).NotEmpty();
        RuleFor(x => x.Amount)
            .GreaterThan(0m).WithMessage("Enter the amount to move.")
            .LessThanOrEqualTo(99_999_999_999_999.9999m);
        RuleFor(x => x)
            .Must(x => x.SourceJarId != x.DestinationJarId)
            .WithMessage("Choose two different places to move money between.")
            .WithName("DestinationJarId");
        RuleFor(x => x.Note).MaximumLength(280);
    }
}
