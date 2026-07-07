using FluentValidation;

namespace AllotJar.Application.Imports.Commands.PreviewImport;

public class PreviewImportCommandValidator : AbstractValidator<PreviewImportCommand>
{
    public PreviewImportCommandValidator()
    {
        RuleFor(x => x.Content)
            .NotEmpty().WithMessage("The statement file is empty.");
    }
}
