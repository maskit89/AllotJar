using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;
using Xunit.Abstractions;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// A timing harness, not a test of behaviour: it builds one household with several years of
/// daily rows through the real API (budget months, daily spending, monthly pay, monthly savings
/// transfers into jars, yearly jar payments) and then times every page's reads and the common
/// back-dated writes, with each request's SQL commands and time. It runs only when
/// <c>ALLOTJAR_TIMING=1</c> (CI never sets it), takes a few minutes, and prints a table (also
/// written to <c>ALLOTJAR_TIMING_OUT</c>); <c>ALLOTJAR_TIMING_REUSE=1</c> times an already-seeded
/// database again, and <c>ALLOTJAR_TIMING_YEARS</c> sets the history length (default 3).
/// <c>ALLOTJAR_TIMING_SNAPSHOT=folder</c> saves every read's answer instead (no writes), so two
/// builds can be compared figure for figure. Used for follow-up F3 (25 October 2026).
/// </summary>
public class LargeHouseholdTimingTests
{
    private const string Email = "timing-owner@largehousehold.test";
    private const string Password = "Aa1xTimingHousehold0123456789";

    private readonly ITestOutputHelper _output;

    public LargeHouseholdTimingTests(ITestOutputHelper output) => _output = output;

    [Fact]
    public async Task Time_pages_on_a_household_with_years_of_rows()
    {
        if (Environment.GetEnvironmentVariable("ALLOTJAR_TIMING") != "1")
        {
            return;
        }
        var reuse = Environment.GetEnvironmentVariable("ALLOTJAR_TIMING_REUSE") == "1";
        var years = int.TryParse(Environment.GetEnvironmentVariable("ALLOTJAR_TIMING_YEARS"), out var y) ? y : 3;

        await using var factory = new ApiFactory("AllotJar_LargeHousehold", new Dictionary<string, string?>
        {
            ["RateLimiting:AuthPermitLimit"] = "1000",
        });
        if (!reuse)
        {
            await factory.ResetDatabaseAsync();
        }
        var sql = new SqlCommandLog();
        using var client = factory.WithWebHostBuilder(b => b.ConfigureLogging(l => l
                .AddProvider(sql)
                .AddFilter<SqlCommandLog>(DbLoggerCategory.Database.Command.Name, LogLevel.Information)))
            .CreateClient();

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var start = new DateOnly(today.Year - years, 1, 1);
        var report = new StringBuilder();

        string token;
        if (reuse)
        {
            var login = await client.PostAsync("/api/auth/login",
                Json(new { email = Email, password = Password }));
            token = (await Read(login)).RootElement.GetProperty("token").GetString()!;
        }
        else
        {
            var sw = Stopwatch.StartNew();
            token = await SeedAsync(client, start, today, report);
            report.AppendLine($"Seeded in {sw.Elapsed.TotalSeconds:F0} s");
        }

        var ids = await LoadIdsAsync(client, token, today);
        report.AppendLine();
        report.AppendLine("| Request | median ms | runs (ms) | bytes | SQL commands | SQL ms |");
        report.AppendLine("|---|---:|---|---:|---:|---:|");

        async Task Time(string label, HttpMethod method, string url, object? body = null, int runs = 7)
        {
            var times = new List<double>();
            long bytes = 0;
            HttpStatusCode status = 0;
            var commands = 0;
            double sqlMs = 0;
            for (var i = 0; i < runs; i++)
            {
                sql.Reset();
                var sw = Stopwatch.StartNew();
                var response = await HttpApiFixture.SendAsync(client, method, url, token, body);
                var content = await response.Content.ReadAsByteArrayAsync();
                sw.Stop();
                times.Add(sw.Elapsed.TotalMilliseconds);
                bytes = content.Length;
                status = response.StatusCode;
                (commands, sqlMs) = sql.Totals();
            }
            times.Sort();
            var flag = (int)status >= 400 ? $" **{(int)status}**" : "";
            report.AppendLine(
                $"| {label}{flag} | {times[times.Count / 2]:F0} | {string.Join(", ", times.Select(t => t.ToString("F0")))} | {bytes:N0} | {commands} | {sqlMs:F0} |");
        }

        var get = HttpMethod.Get;

        // With ALLOTJAR_TIMING_SNAPSHOT=<folder>, save every read's answer instead of timing it, so
        // two builds can be compared figure for figure (no writes are made in this mode).
        var snapshot = Environment.GetEnvironmentVariable("ALLOTJAR_TIMING_SNAPSHOT");
        if (!string.IsNullOrEmpty(snapshot))
        {
            Directory.CreateDirectory(snapshot);
            var urls = new List<string>
            {
                "/api/budget/current", "/api/budget/months", "/api/transactions", "/api/accounts",
                "/api/accounts/reconciliation", "/api/jars", "/api/jars?includeArchived=true", "/api/jars/ledger",
                "/api/reports/trends?months=6", "/api/reports/trends?months=12", "/api/allocation/profile",
                $"/api/allocation/preview/{today.Year}/{today.Month}",
                "/api/transactions?unassignedOnly=true",
            };
            foreach (var (_, id) in ids.Jars)
            {
                urls.Add($"/api/jars/{id}/payments");
                urls.Add($"/api/jars/{id}/payments?all=true");
            }
            for (var year = start.Year; year <= today.Year; year++)
            {
                urls.Add($"/api/reports/annual/{year}");
                urls.Add($"/api/reports/jars/{year}");
                urls.Add($"/api/transactions?year={year}");
                urls.Add($"/api/jars/ledger?asOf={year}-12-31");
                for (var month = 1; month <= 12 && new DateOnly(year, month, 1) <= today; month++)
                {
                    urls.Add($"/api/budget/{year}/{month}");
                    urls.Add($"/api/budget/{year}/{month}/wrap-up");
                    urls.Add($"/api/reports/month/{year}/{month}");
                    urls.Add($"/api/transactions?year={year}&month={month}");
                    urls.Add($"/api/jars?year={year}&month={month}");
                }
            }
            foreach (var url in urls)
            {
                var response = await HttpApiFixture.SendAsync(client, get, url, token);
                var body = await response.Content.ReadAsStringAsync();
                var name = string.Concat(url.Select(c => char.IsLetterOrDigit(c) ? c : '_'));
                await File.WriteAllTextAsync(Path.Combine(snapshot, name + ".json"), $"{(int)response.StatusCode}\n{body}");
            }
            return;
        }

        // Warm the pipeline (JIT, EF model) so the first row is not the cold start.
        await Time("warm-up /api/budget/current", get, "/api/budget/current", runs: 2);

        await Time("Dashboard: budget/current", get, "/api/budget/current");
        await Time("Dashboard: budget/months", get, "/api/budget/months");
        await Time("Budget month a year ago", get, $"/api/budget/{today.Year - 1}/{today.Month}");
        // The month before's wrap-up: what the Dashboard carries in, summed over every month since the first budget.
        var before = today.AddMonths(-1);
        await Time("Dashboard: wrap-up (carry-over)", get, $"/api/budget/{before.Year}/{before.Month}/wrap-up");
        await Time("Transactions (all)", get, "/api/transactions");
        await Time("Transactions this month", get, $"/api/transactions?year={today.Year}&month={today.Month}");
        await Time("Accounts", get, "/api/accounts");
        await Time("Accounts reconciliation", get, "/api/accounts/reconciliation");
        await Time("Jars", get, "/api/jars");
        await Time("Jars incl. archived", get, "/api/jars?includeArchived=true");
        await Time("Jars ledger", get, "/api/jars/ledger");
        foreach (var (name, id) in ids.Jars)
        {
            await Time($"Jar payments ({name})", get, $"/api/jars/{id}/payments");
        }
        await Time("Reports trends 6", get, "/api/reports/trends?months=6");
        await Time("Reports month", get, $"/api/reports/month/{today.Year}/{today.Month}");
        await Time("Reports jars year", get, $"/api/reports/jars/{today.Year - 1}");
        await Time("Reports annual", get, $"/api/reports/annual/{today.Year - 1}");
        await Time("Allocation preview", get, $"/api/allocation/preview/{today.Year}/{today.Month}");
        await Time("Allocation profile", get, "/api/allocation/profile");

        // Writes: a back-dated expense from the first year (walks the whole history), today's
        // expense, an edit of the back-dated one and its delete.
        var back = start.AddMonths(2).AddDays(9);
        var created = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/transactions", token, new
        {
            date = back, payee = "Timing back-dated", amount = 12.34m, type = 0,
            budgetItemId = (Guid?)null, accountId = ids.Checking,
        });
        var createdBody = await created.Content.ReadAsStringAsync();
        report.AppendLine($"| (back-dated create status {(int)created.StatusCode}) | | | |");
        if (created.IsSuccessStatusCode)
        {
            var backId = JsonDocument.Parse(createdBody).RootElement.GetProperty("id").GetGuid();
            await Time("Edit back-dated expense", HttpMethod.Put, $"/api/transactions/{backId}", new
            {
                date = back, payee = "Timing back-dated", amount = 13.34m, type = 0,
                budgetItemId = (Guid?)null, accountId = ids.Checking,
            });
            await Time("Delete back-dated expense", HttpMethod.Delete, $"/api/transactions/{backId}", runs: 1);
        }
        await Time("Create back-dated expense (savings acct)", HttpMethod.Post, "/api/transactions", new
        {
            date = back, payee = "Timing back-dated savings", amount = 1m, type = 0,
            budgetItemId = (Guid?)null, accountId = ids.Savings,
        }, runs: 1);
        await Time("Create today's expense", HttpMethod.Post, "/api/transactions", new
        {
            date = today, payee = "Timing today", amount = 2m, type = 0,
            budgetItemId = (Guid?)null, accountId = ids.Checking,
        });
        await Time("Back-dated transfer into savings", HttpMethod.Post, "/api/transactions/transfer", new
        {
            departedOn = back, receivedOn = back, amount = 5m, fromAccountId = ids.Checking,
            toAccountId = ids.Savings, payee = "Timing transfer",
        }, runs: 1);
        if (ids.Jars.Count >= 2)
        {
            await Time("Back-dated reallocation", HttpMethod.Post, "/api/jars/reallocations", new
            {
                accountId = ids.Savings, sourceJarId = ids.Jars[0].Id, destinationJarId = ids.Jars[1].Id, amount = 1m, date = back,
            }, runs: 1);
        }

        foreach (var opening in new[] { 3990m, 4000m })
        {
            await Time($"Savings opening balance to {opening}", HttpMethod.Put, $"/api/accounts/{ids.Savings}", new
            {
                name = "Savings", type = 1, openingBalance = opening, openingDate = start,
                iban = "DE89370400440532013000", bic = "MALTMTMT",
            }, runs: 1);
        }

        // A jar kept in the everyday account: every back-dated change there is checked against
        // each later day the account moved (the whole-history walk).
        var buffer = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/jars", token, new
        {
            name = "Buffer", kind = 1, targetAmount = 1000m, targetDate = (DateOnly?)null, accrual = 2,
            fundingAccountId = ids.Checking, initialAllocation = 200m, initialAllocationDate = start, monthlyContribution = 10m,
        });
        report.AppendLine($"| (jar in Checking: {(int)buffer.StatusCode}) | | | | | |");
        if (buffer.IsSuccessStatusCode)
        {
            var bufferId = (await Read(buffer)).RootElement.GetProperty("id").GetGuid();
            await Time("Checking: back-dated reallocation", HttpMethod.Post, "/api/jars/reallocations", new
            {
                accountId = ids.Checking, sourceJarId = bufferId, destinationJarId = (Guid?)null, amount = 1m, date = back,
            }, runs: 1);
            var old = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/transactions", token, new
            {
                date = back, payee = "Timing old", amount = 5m, type = 0, budgetItemId = (Guid?)null, accountId = ids.Checking,
            });
            if (old.IsSuccessStatusCode)
            {
                var oldId = (await Read(old)).RootElement.GetProperty("id").GetGuid();
                await Time("Checking: delete back-dated expense", HttpMethod.Delete, $"/api/transactions/{oldId}", runs: 1);
            }
            foreach (var opening in new[] { 2490m, 2500m })
            {
                await Time($"Checking opening balance to {opening}", HttpMethod.Put, $"/api/accounts/{ids.Checking}", new
                {
                    name = "Checking", type = 0, openingBalance = opening, openingDate = start,
                    iban = "MT84MALT011000012345MTLCAST001S", bic = "MALTMTMT",
                }, runs: 1);
            }
        }

        var text = report.ToString();
        _output.WriteLine(text);
        var outFile = Environment.GetEnvironmentVariable("ALLOTJAR_TIMING_OUT");
        if (!string.IsNullOrEmpty(outFile))
        {
            await File.WriteAllTextAsync(outFile, text);
        }
    }

    private sealed record Ids(Guid Checking, Guid Savings, List<(string Name, Guid Id)> Jars);

    private static async Task<Ids> LoadIdsAsync(HttpClient client, string token, DateOnly today)
    {
        var accounts = (await Read(await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", token)))
            .RootElement.EnumerateArray().ToList();
        Guid Account(string name) => accounts.First(a => a.GetProperty("name").GetString() == name).GetProperty("id").GetGuid();
        var jars = (await Read(await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/jars", token)))
            .RootElement.EnumerateArray()
            .Select(j => (j.GetProperty("name").GetString()!, j.GetProperty("id").GetGuid()))
            .ToList();
        return new Ids(Account("Checking"), Account("Savings"), jars);
    }

    private async Task<string> SeedAsync(HttpClient client, DateOnly start, DateOnly today, StringBuilder report)
    {
        var register = await client.PostAsync("/api/auth/register", Json(new
        {
            email = Email, password = Password, firstName = "Timing", lastName = "Owner",
            preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }));
        var token = (await Read(register)).RootElement.GetProperty("token").GetString()!;
        var failures = new Dictionary<string, int>();
        var failureSamples = new List<string>();
        var writeTimes = new Dictionary<int, List<double>>();

        async Task<JsonDocument?> Send(string what, HttpMethod method, string url, object? body, DateOnly? when = null)
        {
            var sw = Stopwatch.StartNew();
            var response = await HttpApiFixture.SendAsync(client, method, url, token, body);
            var text = await response.Content.ReadAsStringAsync();
            sw.Stop();
            if (when is { } d)
            {
                (writeTimes.TryGetValue(d.Year, out var l) ? l : writeTimes[d.Year] = new()).Add(sw.Elapsed.TotalMilliseconds);
            }
            if (!response.IsSuccessStatusCode)
            {
                failures[what] = failures.GetValueOrDefault(what) + 1;
                if (failureSamples.Count < 15)
                {
                    failureSamples.Add($"{what} {when}: {(int)response.StatusCode} {text[..Math.Min(300, text.Length)]}");
                }
                return null;
            }
            return text.Length == 0 ? null : JsonDocument.Parse(text);
        }

        // Bank details as most accounts carry them: they are stored encrypted, so every read decrypts them.
        async Task<Guid> CreateAccount(string name, int type, decimal opening, string? iban = null) =>
            (await Send("account", HttpMethod.Post, "/api/accounts",
                new { name, type, currency = "EUR", openingBalance = opening, openingDate = start, iban, bic = iban is null ? null : "MALTMTMT" })
                ?? throw new InvalidOperationException(string.Join("\n", failureSamples)))
            .RootElement.GetProperty("id").GetGuid();

        var checking = await CreateAccount("Checking", 0, 2500m, "MT84MALT011000012345MTLCAST001S");
        var savings = await CreateAccount("Savings", 1, 4000m, "DE89370400440532013000");
        var cash = await CreateAccount("Cash", 2, 50m);

        // Month by month: the budget, then the month's money.
        var rng = new Random(20261025);
        var jarIds = new List<Guid>();
        var first = true;
        for (var m = new DateOnly(start.Year, start.Month, 1); m <= today; m = m.AddMonths(1))
        {
            await Send("budget month", HttpMethod.Post, "/api/budget",
                first
                    ? new { year = m.Year, month = m.Month, copyFromPrevious = false, templateKey = (string?)"essentials" }
                    : new { year = m.Year, month = m.Month, copyFromPrevious = true, templateKey = (string?)null });
            var monthDoc = await Send("budget get", HttpMethod.Get, $"/api/budget/{m.Year}/{m.Month}", null);
            var items = monthDoc!.RootElement.GetProperty("categories").EnumerateArray()
                .SelectMany(c => c.GetProperty("items").EnumerateArray()
                    .Select(i => (Kind: c.GetProperty("kind").GetString()!, Name: i.GetProperty("name").GetString()!,
                        Id: i.GetProperty("id").GetGuid(), Planned: i.GetProperty("plannedAmount").GetDecimal())))
                .ToList();
            Guid Item(string name) => items.First(i => i.Name == name).Id;

            if (first)
            {
                // Plan the month once; later months copy it.
                var plan = new Dictionary<string, decimal>
                {
                    ["Take-home Pay"] = 3200m, ["Rent / Mortgage"] = 1100m, ["Utilities"] = 150m,
                    ["Internet & Phone"] = 60m, ["Groceries"] = 600m, ["Restaurants"] = 200m, ["Fuel"] = 160m,
                    ["Public Transport"] = 40m, ["Car Insurance"] = 0m, ["Subscriptions"] = 45m,
                    ["Clothing"] = 120m, ["Personal Care"] = 60m,
                };
                foreach (var (name, amount) in plan)
                {
                    await Send("plan line", HttpMethod.Put, $"/api/budget/items/{Item(name)}", new { plannedAmount = amount });
                }

                // Three jars in the savings account, started on the first day.
                async Task Jar(object body)
                {
                    var doc = await Send("jar", HttpMethod.Post, "/api/jars", body);
                    if (doc is not null)
                    {
                        jarIds.Add(doc.RootElement.GetProperty("id").GetGuid());
                    }
                }
                await Jar(new
                {
                    name = "Holiday", kind = 1, targetAmount = 3000m, targetDate = (DateOnly?)null,
                    accrual = 2, fundingAccountId = savings, initialAllocation = 500m, initialAllocationDate = start,
                    monthlyContribution = 150m,
                });
                await Jar(new
                {
                    name = "Car insurance", kind = 0, targetAmount = 600m, targetDate = new DateOnly(start.Year, 12, 15),
                    accrual = 1, fundingAccountId = savings, initialAllocation = 0m, initialAllocationDate = start,
                    recurMonths = 12,
                });
                await Jar(new
                {
                    name = "Christmas", kind = 0, targetAmount = 480m, targetDate = new DateOnly(start.Year, 12, 1),
                    accrual = 1, fundingAccountId = savings, initialAllocation = 0m, initialAllocationDate = start,
                    recurMonths = 12,
                });
                first = false;
            }

            var lastDay = m.AddMonths(1).AddDays(-1);
            if (lastDay > today)
            {
                lastDay = today;
            }

            // Pay on the 1st; savings transfer on the 2nd, split across the jars.
            await Send("income", HttpMethod.Post, "/api/transactions", new
            {
                date = m, payee = "Employer", amount = 3200m, type = 1, budgetItemId = Item("Take-home Pay"), accountId = checking,
            }, m);
            var transferDay = m.AddDays(1);
            if (transferDay <= today)
            {
                await Send("savings transfer", HttpMethod.Post, "/api/transactions/transfer", new
                {
                    departedOn = transferDay, receivedOn = transferDay, amount = 400m, fromAccountId = checking,
                    toAccountId = savings, payee = "Monthly saving",
                    jarAllocations = jarIds.Count == 3
                        ? new[]
                        {
                            new { jarId = jarIds[0], amount = 150m },
                            new { jarId = jarIds[1], amount = 50m },
                            new { jarId = jarIds[2], amount = 40m },
                        }
                        : null,
                }, transferDay);
            }

            // Rent, utilities, phone, subscriptions on fixed days.
            foreach (var (day, name, payee, amount, account) in new[]
            {
                (3, "Rent / Mortgage", "Landlord", 1100m, checking),
                (8, "Utilities", "Power company", 150m, checking),
                (12, "Internet & Phone", "Telecom", 60m, checking),
                (15, "Subscriptions", "Streaming", 45m, checking),
            })
            {
                var d = new DateOnly(m.Year, m.Month, day);
                if (d <= today)
                {
                    await Send("bill", HttpMethod.Post, "/api/transactions",
                        new { date = d, payee, amount, type = 0, budgetItemId = Item(name), accountId = account }, d);
                }
            }

            // Yearly jar payments from the savings account, in December.
            if (m.Month == 12 && jarIds.Count == 3)
            {
                await Send("jar payment", HttpMethod.Post, "/api/transactions", new
                {
                    date = new DateOnly(m.Year, 12, 10), payee = "Insurer", amount = 590m, type = 0,
                    budgetItemId = Item("Car Insurance"), accountId = savings, paidFromJarId = jarIds[1],
                }, new DateOnly(m.Year, 12, 10));
                await Send("jar payment", HttpMethod.Post, "/api/transactions", new
                {
                    date = new DateOnly(m.Year, 12, 1), payee = "Gift shop", amount = 450m, type = 0,
                    budgetItemId = Item("Clothing"), accountId = savings, paidFromJarId = jarIds[2],
                }, new DateOnly(m.Year, 12, 1));
            }

            // Take out cash on the 1st.
            await Send("cash", HttpMethod.Post, "/api/transactions/transfer", new
            {
                departedOn = m, receivedOn = m, amount = 300m, fromAccountId = checking,
                toAccountId = cash, payee = "Cash machine",
            }, m);

            // Daily spending: groceries most days, eating out, fuel, some paid in cash.
            var daily = new[]
            {
                ("Groceries", "Supermarket", 0.75, 8m, 45m),
                ("Restaurants", "Cafe", 0.35, 4m, 30m),
                ("Fuel", "Petrol station", 0.12, 40m, 70m),
                ("Personal Care", "Pharmacy", 0.08, 5m, 25m),
                ("Clothing", "Clothes shop", 0.06, 15m, 60m),
                ("Public Transport", "Bus", 0.2, 1.5m, 3m),
            };
            for (var d = m; d <= lastDay; d = d.AddDays(1))
            {
                foreach (var (name, payee, chance, min, max) in daily)
                {
                    if (rng.NextDouble() < chance)
                    {
                        var amount = Math.Round(min + (decimal)rng.NextDouble() * (max - min), 2);
                        var account = rng.NextDouble() < 0.15 ? cash : checking;
                        await Send("daily", HttpMethod.Post, "/api/transactions",
                            new { date = d, payee, amount, type = 0, budgetItemId = Item(name), accountId = account }, d);
                    }
                }
            }
        }

        report.AppendLine("Write time while seeding (mean ms per write, by year of the row):");
        foreach (var (year, list) in writeTimes.OrderBy(kv => kv.Key))
        {
            report.AppendLine($"- {year}: {list.Average():F0} ms over {list.Count} writes (max {list.Max():F0})");
        }
        report.AppendLine($"Failures: {string.Join(", ", failures.Select(kv => $"{kv.Key}={kv.Value}"))}");
        foreach (var sample in failureSamples)
        {
            report.AppendLine($"  {sample}");
        }
        return token;
    }

    /// <summary>Counts EF's "Executed DbCommand (N ms)" lines, so each request shows its SQL share.</summary>
    private sealed class SqlCommandLog : ILoggerProvider, ILogger
    {
        private int _count;
        private long _micros;

        public void Reset()
        {
            Interlocked.Exchange(ref _count, 0);
            Interlocked.Exchange(ref _micros, 0);
        }

        public (int Count, double Ms) Totals() => (_count, _micros / 1000.0);

        public ILogger CreateLogger(string categoryName) => this;
        public void Dispose() { }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (eventId.Id != RelationalEventId.CommandExecuted.Id || state is not IEnumerable<KeyValuePair<string, object?>> values)
            {
                return;
            }
            var elapsed = values.FirstOrDefault(v => v.Key == "elapsed").Value;
            if (elapsed is string text && double.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, out var ms))
            {
                Interlocked.Increment(ref _count);
                Interlocked.Add(ref _micros, (long)(ms * 1000));
            }
        }
    }

    private static StringContent Json(object body) =>
        new(JsonSerializer.Serialize(body, HttpApiFixture.Json), Encoding.UTF8, "application/json");

    private static async Task<JsonDocument> Read(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"{(int)response.StatusCode}: {text}");
        }
        return JsonDocument.Parse(text);
    }
}
