namespace AllotJar.Api.Middleware;

/// <summary>
/// Whether the API has finished its database work at startup (migrations, then the backfills).
/// Open in the normal case. Program closes it when SQL Server does not answer within the first
/// retries (right after a VPS reboot it can take minutes to come up) and opens it once the
/// migrations ran in the background, instead of letting startup throw: an in-process IIS app that
/// fails to start keeps answering 500.30 until its app pool is restarted by hand (25 Oct 2026).
/// </summary>
public sealed class DatabaseStartupGate
{
    private volatile bool _open = true;

    public bool IsOpen => _open;

    public void Close() => _open = false;

    public void Open() => _open = true;
}

/// <summary>
/// While <see cref="DatabaseStartupGate"/> is closed, every request answers 503 with Retry-After,
/// <c>/health</c> and <c>/health/ready</c> included: the deploy's liveness poll still fails on a
/// database that never answers (or a migration that never applies), and no request reaches a
/// schema the migrations have not brought up to date.
/// </summary>
public class DatabaseStartupGateMiddleware
{
    public const string Code = "database_starting";
    public const int RetryAfterSeconds = 15;

    private readonly RequestDelegate _next;
    private readonly DatabaseStartupGate _gate;

    public DatabaseStartupGateMiddleware(RequestDelegate next, DatabaseStartupGate gate)
    {
        _next = next;
        _gate = gate;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (!_gate.IsOpen)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers.RetryAfter = RetryAfterSeconds.ToString();
            await context.Response.WriteAsJsonAsync(new
            {
                status = StatusCodes.Status503ServiceUnavailable,
                title = "AllotJar is starting and waiting for its database. Try again in a moment.",
                code = Code,
            });
            return;
        }

        await _next(context);
    }
}
