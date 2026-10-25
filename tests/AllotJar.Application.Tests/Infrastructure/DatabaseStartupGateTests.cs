using FluentAssertions;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Infrastructure;

public class DatabaseStartupGateTests
{
    [Fact]
    public async Task An_open_gate_lets_waiters_through_at_once()
    {
        var gate = new DatabaseStartupGate();

        gate.IsOpen.Should().BeTrue();
        await gate.WaitOpenAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task A_closed_gate_holds_waiters_until_it_opens()
    {
        var gate = new DatabaseStartupGate();
        gate.Close();
        gate.Close();

        var waiting = gate.WaitOpenAsync(CancellationToken.None);
        gate.IsOpen.Should().BeFalse();
        await Task.Delay(50);
        waiting.IsCompleted.Should().BeFalse();

        gate.Open();

        await waiting.WaitAsync(TimeSpan.FromSeconds(1));
        gate.IsOpen.Should().BeTrue();
    }

    [Fact]
    public async Task A_waiter_on_a_closed_gate_stops_on_shutdown()
    {
        var gate = new DatabaseStartupGate();
        gate.Close();
        using var stopping = new CancellationTokenSource();

        var waiting = gate.WaitOpenAsync(stopping.Token);
        stopping.Cancel();

        await waiting.Invoking(w => w).Should().ThrowAsync<OperationCanceledException>();
    }

    // IIS fails an in-process app that has not started within 120 s (ANCM's default startupTimeLimit)
    // with a 500.37 that sticks until the pool is recycled. The foreground retries, one last slow
    // attempt (15 s Connect Timeout) and EF's model building (about 17 s on the VPS) must fit well inside.
    [Fact]
    public void The_foreground_retries_stay_well_under_the_iis_startup_limit()
    {
        var worstCase = DatabaseStartupGate.ForegroundBudget + TimeSpan.FromSeconds(15 + 3 + 17);

        worstCase.Should().BeLessThanOrEqualTo(TimeSpan.FromSeconds(80));
    }
}
