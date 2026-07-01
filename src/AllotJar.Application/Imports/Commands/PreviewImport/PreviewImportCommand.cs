using MediatR;
using AllotJar.Application.Imports.Models;

namespace AllotJar.Application.Imports.Commands.PreviewImport;

/// <summary>
/// Parses a bank statement and returns the not-yet-imported rows for review — without writing
/// anything. The user categorises/attributes them and then sends them to
/// <see cref="CommitImport.CommitImportCommand"/>.
/// </summary>
public record PreviewImportCommand(string Content, StatementFormat Format)
    : IRequest<ImportPreviewResult>;
