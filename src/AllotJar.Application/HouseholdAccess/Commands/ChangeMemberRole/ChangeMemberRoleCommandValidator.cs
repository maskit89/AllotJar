using FluentValidation;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.ChangeMemberRole;

public class ChangeMemberRoleCommandValidator : AbstractValidator<ChangeMemberRoleCommand>
{
    public ChangeMemberRoleCommandValidator()
    {
        RuleFor(x => x.Role)
            .IsInEnum()
            .Must(r => r != HouseholdRole.Owner)
            .WithMessage("A household can only have one owner.");
    }
}
