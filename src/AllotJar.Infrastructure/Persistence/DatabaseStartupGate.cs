namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Whether the API has finished its database work at startup (migrations, then the backfills).
/// Open in the normal case. Program closes it when SQL Server does not answer within
/// <see cref="ForegroundBudget"/> (right after a VPS reboot it can take minutes to come up) and opens
/// it once the migrations ran in the background, instead of letting startup throw: an in-process IIS
/// app that fails to start keeps answering 500.30 until its app pool is restarted by hand (25 Oct 2026).
/// </summary>
public sealed class DatabaseStartupGate
{
    /// <summary>
    /// How long startup keeps retrying the migrations before <c>app.Run()</c>. IIS fails an in-process
    /// app that has not started within ANCM's startupTimeLimit (120 s by default) with a sticky 500.37,
    /// so this plus one slow last attempt (a 15 s Connect Timeout) plus EF's model building (about
    /// 17 s on the VPS) must stay well under 120 s.
    /// </summary>
    public static readonly TimeSpan ForegroundBudget = TimeSpan.FromSeconds(30);

    /// <summary>The wait between background attempts for the first <see cref="SlowAfter"/>.</summary>
    public static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(15);

    /// <summary>The wait between background attempts after that, so a failure that does not go away
    /// (a bad migration, a login denied) does not hit SQL Server every 15 s all day.</summary>
    public static readonly TimeSpan SlowRetryInterval = TimeSpan.FromSeconds(60);

    public static readonly TimeSpan SlowAfter = TimeSpan.FromMinutes(5);

    private static TaskCompletionSource Opened()
    {
        var source = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        source.SetResult();
        return source;
    }

    private volatile TaskCompletionSource _opened = Opened();

    public bool IsOpen => _opened.Task.IsCompleted;

    public void Close()
    {
        if (_opened.Task.IsCompleted)
        {
            _opened = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }

    public void Open() => _opened.TrySetResult();

    /// <summary>Completes at once while the gate is open, otherwise when it opens.</summary>
    public Task WaitOpenAsync(CancellationToken cancellationToken) => _opened.Task.WaitAsync(cancellationToken);
}
