using System.Text;
using System.Text.Json;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Api.Features;

namespace AllotJar.Api.Controllers;

/// <summary>
/// Bank statement import. Requires a valid JWT; the handler attributes every
/// imported transaction to the authenticated user.
/// </summary>
[ApiController]
[Authorize]
[FeatureGate(nameof(FeatureFlags.CamtImport))]
[Route("api/[controller]")]
public class ImportController : ControllerBase
{
    private readonly ISender _mediator;

    // The generic-CSV column mapping arrives as a JSON form field; accept camelCase from the SPA.
    private static readonly JsonSerializerOptions MappingJsonOptions = new() { PropertyNameCaseInsensitive = true };

    public ImportController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>
    /// Parse an uploaded statement and return the not-yet-imported rows for review — nothing is
    /// saved. The user categorises/attributes them, then posts the kept rows to <c>commit</c>.
    /// </summary>
    [HttpPost("preview")]
    [RequestSizeLimit(10 * 1024 * 1024)] // 10 MB cap
    [ProducesResponseType(typeof(ImportPreviewResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<ImportPreviewResult>> Preview(
        IFormFile file,
        [FromForm] StatementFormat format,
        [FromForm] string? mapping,
        [FromForm] string? defaultCurrency,
        [FromForm] Guid? accountId,
        CancellationToken ct)
    {
        if (file is null || file.Length == 0)
        {
            return BadRequest(new { error = "No file was uploaded." });
        }

        // Read as UTF-8 so the masked-card bullets (• = U+2022) survive intact.
        using var reader = new StreamReader(file.OpenReadStream(), Encoding.UTF8);
        var content = await reader.ReadToEndAsync(ct);

        // Generic CSV carries a user-confirmed column mapping (absent on the first upload → auto-detect).
        CsvMapping? csvMapping = null;
        if (!string.IsNullOrWhiteSpace(mapping))
        {
            try
            {
                csvMapping = JsonSerializer.Deserialize<CsvMapping>(mapping, MappingJsonOptions);
            }
            catch (JsonException)
            {
                return BadRequest(new { error = "The column mapping was not valid." });
            }
        }

        var result = await _mediator.Send(
            new PreviewImportCommand(content, format, csvMapping, defaultCurrency, accountId), ct);
        return Ok(result);
    }

    /// <summary>Persist the reviewed rows from a preview. Idempotent — already-imported rows are skipped.</summary>
    [HttpPost("commit")]
    [ProducesResponseType(typeof(ImportStatementResult), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ImportStatementResult>> Commit(
        [FromBody] CommitImportCommand command,
        CancellationToken ct)
    {
        var result = await _mediator.Send(command, ct);
        return Ok(result);
    }
}
