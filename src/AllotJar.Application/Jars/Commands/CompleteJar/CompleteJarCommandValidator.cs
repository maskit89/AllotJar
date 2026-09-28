using FluentValidation;

namespace AllotJar.Application.Jars.Commands.CompleteJar;

public class CompleteJarCommandValidator : AbstractValidator<CompleteJarCommand>
{
    public CompleteJarCommandValidator()
    {
        RuleFor(x => x.Id).NotEmpty();
    }
}
