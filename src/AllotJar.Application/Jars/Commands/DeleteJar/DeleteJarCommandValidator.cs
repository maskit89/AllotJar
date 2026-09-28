using FluentValidation;

namespace AllotJar.Application.Jars.Commands.DeleteJar;

public class DeleteJarCommandValidator : AbstractValidator<DeleteJarCommand>
{
    public DeleteJarCommandValidator()
    {
        RuleFor(x => x.Id).NotEmpty();
    }
}
