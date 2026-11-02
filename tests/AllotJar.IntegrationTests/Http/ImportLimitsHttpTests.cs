using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using AllotJar.Application.Imports;
using Microsoft.AspNetCore.Hosting;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The size limits of a statement import (holistic review M3): a commit takes at most
/// <see cref="ImportLimits.MaxRows"/> rows and <see cref="ImportLimits.MaxCommitBytes"/>, and a
/// preview never offers more rows than a commit takes.
/// </summary>
public sealed class ImportLimitsHttpTests : IAsyncLifetime
{
    private readonly ApiFactory _factory = new("AllotJar_HttpImportLimits");

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public async Task DisposeAsync() => await _factory.DisposeAsync();

    [Fact]
    public async Task A_reference_longer_than_the_stored_one_is_refused_rather_than_failing_the_save()
    {
        using var client = _factory.CreateClient();
        var (token, accountId) = await ImportHttp.SignUpWithAccountAsync(client);

        var rows = ImportHttp.Rows(2).Select(r => r with { Reference = r.Reference + new string('x', 200) }).ToList();
        using var response = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/import/commit", token,
            new { accountId, items = rows });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest, await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_commit_of_more_rows_than_the_cap_is_refused_and_saves_nothing()
    {
        using var client = _factory.CreateClient();
        var (token, accountId) = await ImportHttp.SignUpWithAccountAsync(client);

        using var response = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/import/commit", token,
            new { accountId, items = ImportHttp.Rows(ImportLimits.MaxRows + 1) });

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync()).Should().Contain("up to 2,500 are imported at a time");
        (await ImportHttp.TransactionCountAsync(client, token)).Should().Be(0);
    }

    [Fact]
    public async Task A_commit_at_the_cap_goes_in()
    {
        using var client = _factory.CreateClient();
        var (token, accountId) = await ImportHttp.SignUpWithAccountAsync(client);

        using var response = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/import/commit", token,
            new { accountId, items = ImportHttp.Rows(ImportLimits.MaxRows) });

        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(response)).RootElement.GetProperty("imported").GetInt32()
            .Should().Be(ImportLimits.MaxRows);
    }

    [Fact]
    public async Task A_preview_with_more_new_rows_than_a_commit_takes_says_to_import_in_parts()
    {
        using var client = _factory.CreateClient();
        var (token, accountId) = await ImportHttp.SignUpWithAccountAsync(client);

        var csv = new StringBuilder("Date,Description,Amount\n");
        var day = new DateOnly(2024, 1, 1);
        for (var i = 0; i <= ImportLimits.MaxRows; i++)
        {
            csv.Append(day.AddDays(i / 4).ToString("yyyy-MM-dd")).Append(",Shop ").Append(i).Append(",-1.").Append(i % 90 + 10).Append('\n');
        }
        using var form = new MultipartFormDataContent
        {
            { new ByteArrayContent(Encoding.UTF8.GetBytes(csv.ToString())) { Headers = { ContentType = new MediaTypeHeaderValue("text/csv") } }, "file", "statement.csv" },
            { new StringContent("GenericCsv"), "format" },
            { new StringContent(accountId.ToString()), "accountId" },
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/import/preview") { Content = form };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity, await response.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(response)).RootElement.GetProperty("title").GetString()
            .Should().Be(ImportLimits.TooManyRows(ImportLimits.MaxRows + 1));
    }
}

/// <summary>
/// The body size limit, on Kestrel itself: the in-memory test server does not enforce
/// [RequestSizeLimit], so this host listens on a real port.
/// </summary>
public sealed class ImportCommitBodySizeHttpTests : IAsyncLifetime
{
    private readonly ApiFactory _factory = new("AllotJar_HttpImportCommitSize");

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _factory.UseKestrel(0);
        _factory.StartServer();
    }

    public async Task DisposeAsync() => await _factory.DisposeAsync();

    [Fact]
    public async Task A_commit_body_over_the_size_limit_is_refused_and_saves_nothing()
    {
        using var client = _factory.CreateClient();
        var (token, accountId) = await ImportHttp.SignUpWithAccountAsync(client);

        // Three good rows, and a field the API ignores to make the body too big: without the
        // limit, this commit would go in. "Expect: 100-continue" lets the client hear the refusal
        // before it sends the body (Kestrel closes the connection on a body it won't read).
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/import/commit")
        {
            Content = JsonContent.Create(
                new { accountId, items = ImportHttp.Rows(3), padding = new string('x', (int)ImportLimits.MaxCommitBytes) },
                options: HttpApiFixture.Json),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.ExpectContinue = true;
        await request.Content.LoadIntoBufferAsync(); // so it goes with a Content-Length
        using var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge, await response.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(response)).RootElement.GetProperty("title").GetString()
            .Should().Contain("too large to send at once");
        (await ImportHttp.TransactionCountAsync(client, token)).Should().Be(0);
    }
}

/// <summary>Commits have a rate limit of their own, apart from preview's (own host, so its limiter is fresh).</summary>
public sealed class ImportCommitRateLimitHttpTests : IAsyncLifetime
{
    private readonly ApiFactory _factory = new("AllotJar_HttpImportCommitRate");

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public async Task DisposeAsync() => await _factory.DisposeAsync();

    [Fact]
    public async Task The_eleventh_commit_in_a_minute_is_refused()
    {
        using var client = _factory.CreateClient();
        var (token, accountId) = await ImportHttp.SignUpWithAccountAsync(client);

        for (var i = 0; i < 10; i++)
        {
            using var ok = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/import/commit", token,
                new { accountId, items = ImportHttp.Rows(1, $"c{i}-") });
            ok.StatusCode.Should().Be(HttpStatusCode.OK, $"commit {i + 1} of 10 is within the window");
        }
        using var limited = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/import/commit", token,
            new { accountId, items = ImportHttp.Rows(1, "c10-") });
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
    }
}

/// <summary>A commit that runs past its time limit is stopped and rolled back (limit shortened for the test).</summary>
public sealed class ImportCommitTimeoutHttpTests : IAsyncLifetime
{
    private readonly ApiFactory _factory = new("AllotJar_HttpImportCommitTimeout", new Dictionary<string, string?>
    {
        ["Import:CommitTimeLimitSeconds"] = "0.5",
    });

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public async Task DisposeAsync() => await _factory.DisposeAsync();

    [Fact]
    public async Task A_commit_that_runs_too_long_answers_504_and_saves_nothing()
    {
        using var client = _factory.CreateClient();
        var (token, accountId) = await ImportHttp.SignUpWithAccountAsync(client);

        // 2,500 rows take seconds to check one by one, far past half a second.
        using var response = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/import/commit", token,
            new { accountId, items = ImportHttp.Rows(ImportLimits.MaxRows) });

        response.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout, await response.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(response)).RootElement.GetProperty("title").GetString()
            .Should().Contain("nothing was saved");
        (await ImportHttp.TransactionCountAsync(client, token)).Should().Be(0);

        // The account's lock was let go: a small commit goes straight in (on a host with the
        // usual limit, so a slow test machine can't stop this one too).
        using var usual = _factory.WithWebHostBuilder(b => b.UseSetting("Import:CommitTimeLimitSeconds", "30")).CreateClient();
        using var after = await HttpApiFixture.SendAsync(usual, HttpMethod.Post, "/api/import/commit", token,
            new { accountId, items = ImportHttp.Rows(3, "after-") });
        after.StatusCode.Should().Be(HttpStatusCode.OK, await after.Content.ReadAsStringAsync());
        (await ImportHttp.TransactionCountAsync(client, token)).Should().Be(3);
    }
}

internal static class ImportHttp
{
    public sealed record Row(
        string Reference, DateOnly Date, string Payee, decimal Amount, string Currency, bool IsCredit,
        Guid? BudgetItemId = null, Guid? MemberId = null);

    /// <summary>Statement rows: a deposit, then two small payments, day after day.</summary>
    public static List<Row> Rows(int count, string prefix = "r") =>
        Enumerable.Range(0, count)
            .Select(i => new Row($"{prefix}{i}", new DateOnly(2024, 1, 1).AddDays(i / 3), $"Payee {i % 40}",
                i % 3 == 0 ? 90m : 10m, "EUR", IsCredit: i % 3 == 0))
            .ToList();

    public static async Task<(string Token, Guid AccountId)> SignUpWithAccountAsync(HttpClient client)
    {
        using var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email = $"import-{Guid.NewGuid():N}@example.test",
            password = HttpApiFixture.StrongPassword(),
            firstName = "Import",
            lastName = "Limits",
            preferredCurrency = "EUR",
            acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.EnsureSuccessStatusCode();
        var token = (await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;

        using var account = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", token,
            new { name = "Current", type = 0, currency = "EUR", openingBalance = 100m, openingDate = new DateOnly(2023, 12, 1) });
        account.EnsureSuccessStatusCode();
        return (token, (await HttpApiFixture.ReadJsonAsync(account)).RootElement.GetProperty("id").GetGuid());
    }

    public static async Task<int> TransactionCountAsync(HttpClient client, string token)
    {
        using var response = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/transactions", token);
        response.EnsureSuccessStatusCode();
        using var doc = await HttpApiFixture.ReadJsonAsync(response);
        return doc.RootElement.ValueKind == JsonValueKind.Array
            ? doc.RootElement.GetArrayLength()
            : doc.RootElement.GetProperty("items").GetArrayLength();
    }
}
