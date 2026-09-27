using FluentValidation;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

public class UpdateJarCommandValidator : AbstractValidator<UpdateJarCommand>
{
    public UpdateJarCommandValidator()
    {
        RuleFor(x => x.Id).NotEmpty();

        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("A jar needs a name.")
            .MaximumLength(120);

        this.JarDefinition();

        RuleFor(x => x.FundingAccountId)
            .NotEmpty().WithMessage("Choose the account this jar's money is held in.");
    }
}
