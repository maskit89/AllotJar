using MediatR;
using AllotJar.Application.Imports.Models;

namespace AllotJar.Application.Imports.Commands.PreviewImport;

/// <summary>
/// Parses a bank statement and returns the not-yet-imported rows for review — without writing
/// anything. The user categorises/attributes them and then sends them to
/// <see cref="CommitImport.CommitImportCommand"/>.
/// </summary>
/// <param name="Mapping">
/// For <see cref="StatementFormat.GenericCsv"/> only: the user-confirmed column mapping. When
/// null (the first upload), the layout is auto-detected and echoed back in the result.
/// </param>
/// <param name="DefaultCurrency">
/// The currency to stamp on CSV rows that have no currency column (the user's home currency).
/// </param>
/// <param name="AccountId">
/// The statement's account, when the user chose one — the preview's already-imported filter is
/// scoped to it exactly like the commit's, so the two stages agree on what is a duplicate.
/// </param>
public record PreviewImportCommand(
    string Content,
    StatementFormat Format,
    CsvMapping? Mapping = null,
    string? DefaultCurrency = null,
    Guid? AccountId = null)
    : IRequest<ImportPreviewResult>;
