using FluentValidation;

namespace AllotJar.Application.Imports.Commands.ImportStatement;

public class ImportStatementCommandValidator : AbstractValidator<ImportStatementCommand>
{
    public ImportStatementCommandValidator()
    {
        RuleFor(x => x.Content)
            .NotEmpty().WithMessage("The statement file is empty.");
    }
}
