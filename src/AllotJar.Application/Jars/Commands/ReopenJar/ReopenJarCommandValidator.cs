using FluentValidation;

namespace AllotJar.Application.Jars.Commands.ReopenJar;

public class ReopenJarCommandValidator : AbstractValidator<ReopenJarCommand>
{
    public ReopenJarCommandValidator()
    {
        RuleFor(x => x.Id).NotEmpty();
    }
}
