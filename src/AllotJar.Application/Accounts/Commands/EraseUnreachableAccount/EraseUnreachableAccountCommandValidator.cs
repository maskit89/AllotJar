using FluentValidation;

namespace AllotJar.Application.Accounts.Commands.EraseUnreachableAccount;

public class EraseUnreachableAccountCommandValidator : AbstractValidator<EraseUnreachableAccountCommand>
{
    public EraseUnreachableAccountCommandValidator()
    {
        RuleFor(c => c.Id).NotEmpty();
        RuleFor(c => c.ConfirmName).NotEmpty().WithMessage("Type the account's name to confirm.");
    }
}
