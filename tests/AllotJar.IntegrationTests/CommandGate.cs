using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Holds the first SQL command of its context that matches <paramref name="when"/> until released,
/// so a test can make another request land between two statements of the gated one.
/// </summary>
public sealed class CommandGate(Func<string, bool> when) : DbCommandInterceptor
{
    public readonly TaskCompletionSource Reached = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _held;

    /// <summary>Gates the first command that writes (anything but a SELECT).</summary>
    public static CommandGate FirstWrite() =>
        new(sql => !sql.TrimStart().StartsWith("SELECT", StringComparison.OrdinalIgnoreCase));

    public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        await HoldAsync(command);
        return result;
    }

    public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        await HoldAsync(command);
        return result;
    }

    private async Task HoldAsync(DbCommand command)
    {
        if (when(command.CommandText) && Interlocked.CompareExchange(ref _held, 1, 0) == 0)
        {
            Reached.SetResult();
            await Release.Task;
        }
    }
}
