using FluentValidation;
using AllotJar.Application.Common;

namespace AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;

public class UpsertAllocationProfileCommandValidator : AbstractValidator<UpsertAllocationProfileCommand>
{
    private const decimal MaxAmount = 99_999_999_999_999.9999m;

    public UpsertAllocationProfileCommandValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("An allocation profile needs a name.")
            .MaximumLength(120);

        RuleFor(x => x.BalanceLeanPercent)
            .InclusiveBetween(0, 100)
            .WithMessage("Balance lean must be between 0 and 100.");

        RuleForEach(x => x.Rules).ChildRules(r =>
        {
            r.RuleFor(x => x.Type).IsInEnum();
            r.RuleFor(x => x.Split).IsInEnum();
            r.RuleFor(x => x.FixedAmountPerMember)
                .InclusiveBetween(0m, MaxAmount)
                .WithMessage("Fixed amount is out of range.")
                // The pocket-money amount is typed: whole cents, as in the browser (D1, #306 review P3-1).
                .WholeCents();
        });
    }
}
