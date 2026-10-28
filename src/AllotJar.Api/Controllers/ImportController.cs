using System.Text;
using System.Text.Json;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using AllotJar.Application.Common.Interfaces;
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
    private readonly IPdfTableReader _pdf;

    // The generic-CSV column mapping arrives as a JSON form field; accept camelCase from the SPA.
    private static readonly JsonSerializerOptions MappingJsonOptions = new() { PropertyNameCaseInsensitive = true };

    public ImportController(ISender mediator, IPdfTableReader pdf)
    {
        _mediator = mediator;
        _pdf = pdf;
    }

    /// <summary>
    /// Parse an uploaded statement and return the not-yet-imported rows for review — nothing is
    /// saved. The user categorises/attributes them, then posts the kept rows to <c>commit</c>.
    /// </summary>
    [HttpPost("preview")]
    [EnableRateLimiting("import")]
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

        // The file is read into memory only; nothing of it is stored.
        byte[] bytes;
        using (var buffer = new MemoryStream((int)file.Length))
        {
            await file.CopyToAsync(buffer, ct);
            bytes = buffer.ToArray();
        }

        string content;
        if (_pdf.IsPdf(bytes))
        {
            // A PDF statement's table is rebuilt as CSV and goes through the column screen.
            if (format != StatementFormat.GenericCsv)
            {
                return BadRequest(new { error = "A PDF statement is imported as Bank CSV or PDF." });
            }
            content = _pdf.ReadAsCsv(bytes, ct);
        }
        else
        {
            // UTF-8 unless a byte-order mark says otherwise (Excel's "Unicode Text" is UTF-16),
            // so the masked-card bullets (• = U+2022) survive intact.
            using var reader = new StreamReader(new MemoryStream(bytes), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            content = await reader.ReadToEndAsync(ct);
        }

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
