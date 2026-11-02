using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// How long committing an import takes by its size, with as many rows already on the account
/// (what ImportLimits.MaxRows was chosen from, 2 Nov 2026). Runs only with ALLOTJAR_TIMING=1 (CI
/// never sets it); ALLOTJAR_TIMING_ROWS lists the sizes (up to the cap: a bigger commit is refused). Prints a line per commit.
/// </summary>
public class ImportCommitTimingTests
{
    private readonly ITestOutputHelper _out;
    public ImportCommitTimingTests(ITestOutputHelper output) => _out = output;

    [Fact]
    public async Task Time_import_commit_sizes()
    {
        if (Environment.GetEnvironmentVariable("ALLOTJAR_TIMING") != "1") return;
        await using var factory = new ApiFactory("AllotJar_ImportTiming", new Dictionary<string, string?>
        {
            ["RateLimiting:AuthPermitLimit"] = "1000",
            ["Import:CommitTimeLimitSeconds"] = "600",
        });
        await factory.ResetDatabaseAsync();
        using var client = factory.CreateClient();
        var register = await client.PostAsync("/api/auth/register", JsonContent.Create(new
        {
            email = "timing@example.com", password = "Timing-Passw0rd!", firstName = "T", lastName = "O",
            preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }));
        var token = JsonDocument.Parse(await register.Content.ReadAsStringAsync()).RootElement.GetProperty("token").GetString()!;
        var sizes = (Environment.GetEnvironmentVariable("ALLOTJAR_TIMING_ROWS") ?? "500,1000,2500").Split(',').Select(int.Parse);
        var start = new DateOnly(2020, 1, 1);
        foreach (var n in sizes)
        {
            var acc = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", token,
                new { name = $"A{n}", type = 0, currency = "EUR", openingBalance = 1000m, openingDate = start });
            var accountId = JsonDocument.Parse(await acc.Content.ReadAsStringAsync()).RootElement.GetProperty("id").GetGuid();
            for (var pass = 0; pass < 2; pass++)
            {
                var items = Enumerable.Range(0, n).Select(i => new
                {
                    reference = $"p{pass}-r{i}", date = start.AddDays((i / 3) + pass * 2000), payee = $"Payee {i % 50}",
                    amount = i % 3 == 0 ? 90m : 10m, currency = "EUR", isCredit = i % 3 == 0,
                    budgetItemId = (Guid?)null, memberId = (Guid?)null,
                }).ToList();
                var body = JsonSerializer.Serialize(new { accountId, items });
                var sw = Stopwatch.StartNew();
                var response = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/import/commit", token, new { accountId, items });
                var text = await response.Content.ReadAsStringAsync();
                sw.Stop();
                _out.WriteLine($"rows {n} pass {pass} (history {pass * n}): {(int)response.StatusCode} in {sw.Elapsed.TotalSeconds:F1} s, body {body.Length:N0} bytes, peak WS {Process.GetCurrentProcess().PeakWorkingSet64 / 1048576} MB; {text[..Math.Min(160, text.Length)]}");
            }
        }
    }
}
