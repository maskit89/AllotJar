using FluentValidation;

namespace AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;

public class AcceptInviteCommandValidator : AbstractValidator<AcceptInviteCommand>
{
    public AcceptInviteCommandValidator()
    {
        RuleFor(x => x.Token).NotEmpty();
        // Password is only needed when a new login is being created (anonymous accept); a signed-in
        // user joining with their existing login omits it. The handler enforces it for the new-login path.
        RuleFor(x => x.Password).MinimumLength(8).When(x => !string.IsNullOrEmpty(x.Password));
        RuleFor(x => x.DisplayName).MaximumLength(120);
    }
}
