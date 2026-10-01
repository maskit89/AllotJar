using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;

namespace AllotJar.Api.Middleware;

/// <summary>
/// Translates Application-layer exceptions into RFC7807-style JSON responses
/// with the correct HTTP status code, so handlers can simply throw.
/// </summary>
public class ExceptionHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ExceptionHandlingMiddleware> _logger;

    public ExceptionHandlingMiddleware(RequestDelegate next, ILogger<ExceptionHandlingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (ValidationException ex)
        {
            await WriteProblem(context, StatusCodes.Status400BadRequest,
                "Validation failed", new { ex.Errors });
        }
        catch (NotFoundException ex)
        {
            await WriteProblem(context, StatusCodes.Status404NotFound, ex.Message);
        }
        catch (ForbiddenAccessException ex)
        {
            await WriteProblem(context, StatusCodes.Status403Forbidden, ex.Message);
        }
        catch (StatementParseException ex)
        {
            await WriteProblem(context, StatusCodes.Status422UnprocessableEntity, ex.Message);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Two writes changed the same ledger row at once (a jar's departure, P3-9): the
            // second is refused rather than overwriting the first, and can simply be made again.
            await WriteProblem(context, StatusCodes.Status409Conflict,
                "Something else changed this at the same moment. Reload and try again.");
        }
        catch (DbUpdateException ex) when (IsJarCycleCollision(ex))
        {
            // Two requests closed the same jar cycle at once (two pages settling it on the first
            // day after its deadline, a double-clicked Mark paid or Dismiss; SC-P3-4): the unique
            // cycle index kept one, and the other is told to reload rather than shown an error.
            await WriteProblem(context, StatusCodes.Status409Conflict,
                "Something else changed this at the same moment. Reload and try again.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unhandled exception processing {Path}", context.Request.Path);
            await WriteProblem(context, StatusCodes.Status500InternalServerError,
                "An unexpected error occurred.");
        }
    }

    /// <summary>
    /// True when a save failed on one of the jar cycles' unique indexes ((JarId, Deadline) or the
    /// payment). Matched by index name in the provider's message, as the import's reference check is.
    /// </summary>
    public static bool IsJarCycleCollision(DbUpdateException ex) =>
        ex.InnerException?.Message.Contains("IX_JarCycles_", StringComparison.Ordinal) == true;

    private static async Task WriteProblem(
        HttpContext context, int statusCode, string title, object? extensions = null)
    {
        context.Response.ContentType = "application/json";
        context.Response.StatusCode = statusCode;

        var payload = new Dictionary<string, object?>
        {
            ["status"] = statusCode,
            ["title"] = title
        };

        if (extensions is not null)
        {
            foreach (var prop in extensions.GetType().GetProperties())
            {
                payload[char.ToLowerInvariant(prop.Name[0]) + prop.Name[1..]] = prop.GetValue(extensions);
            }
        }

        await context.Response.WriteAsync(JsonSerializer.Serialize(payload));
    }
}
