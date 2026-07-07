using FluentValidation;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.InviteMember;

public class InviteMemberCommandValidator : AbstractValidator<InviteMemberCommand>
{
    public InviteMemberCommandValidator()
    {
        RuleFor(x => x.Email)
            .NotEmpty()
            .EmailAddress()
            .MaximumLength(256);

        RuleFor(x => x.Role)
            .IsInEnum()
            .Must(r => r != HouseholdRole.Owner)
            .WithMessage("A household can only have one owner.");

        RuleFor(x => x.Method).IsInEnum();

        RuleFor(x => x.TempPassword)
            .NotEmpty()
            .MinimumLength(8)
            .When(x => x.Method == InviteMethod.Direct)
            .WithMessage("Set a temporary password of at least 8 characters.");

        RuleFor(x => x.DisplayName).MaximumLength(120);
    }
}
