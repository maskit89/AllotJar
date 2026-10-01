using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AllotJar.Domain.Enums;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// One booted API (see <see cref="ApiFactory"/>) shared by the anonymous sweep and the role
/// matrix, with a real household provisioned entirely over HTTP:
///
///   1. the Owner registers via <c>POST /api/auth/register</c> (opting into the sample budget so
///      the current month, its categories and a jar exist as real referents),
///   2. the Owner direct-invites an Admin, a Limited and a ReadOnly login into the SAME household
///      via <c>POST /api/access/invite</c> (temp password ⇒ account active at once; a direct
///      invitee has exactly one membership, so the resolver lands them in the owner's household),
///   3. each login signs in via <c>POST /api/auth/login</c> for a real bearer token, and
///   4. the Owner creates two accounts so transfers have real referents.
///
/// The auth rate limit is raised (like the journey harness does) so this serial provisioning plus
/// the sweep can never self-throttle — the real 429 is exercised by its own isolated factory in
/// <c>RateLimit429Tests</c>.
/// </summary>
public sealed class HttpApiFixture : IAsyncLifetime
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly ApiFactory _factory = new(
        databaseName: "AllotJar_HttpSweep",
        extraSettings: new Dictionary<string, string?>
        {
            // The fixture makes ~15 auth-limited calls from one "IP"; never trip the limiter here.
            ["RateLimiting:AuthPermitLimit"] = "1000",
            // Google sign-in flow tests use the Development-only fake validator (the harness
            // runs as Development), driven by fake-google:{json} credentials — see
            // FakeGoogleIdTokenValidator. Real Google tokens are rejected by the fake.
            ["Google:UseFakeValidator"] = "true",
        });

    private readonly Dictionary<HouseholdRole, string> _tokens = new();

    public IServiceProvider Services => _factory.Services;

    /// <summary>The current UTC budget month (created from the Essentials template) — a real referent for writes.</summary>
    public Guid BudgetMonthId { get; private set; }

    public Guid CheckingAccountId { get; private set; }
    public Guid SavingsAccountId { get; private set; }

    public string TokenFor(HouseholdRole role) => _tokens[role];

    /// <summary>A client with NO Authorization header (callers add one per request when needed).</summary>
    public HttpClient CreateClient() => _factory.CreateClient();

    /// <summary>
    /// A client that does NOT persist cookies across requests, so a caller can present an exact
    /// refresh cookie via an explicit Cookie header (e.g. a pre-reset token, to prove it's dead)
    /// without the automatic jar overwriting it with a fresher one.
    /// </summary>
    public HttpClient CreateClientWithoutCookies() =>
        _factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = false,
        });

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        using var client = _factory.CreateClient();

        var run = Guid.NewGuid().ToString("N")[..8];

        // 1. Owner registers. Nothing is seeded (rule 81), so the month is created below.
        var ownerEmail = $"owner-{run}@httpsweep.test";
        var ownerPassword = StrongPassword();
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email = ownerEmail,
            password = ownerPassword,
            firstName = "Sweep",
            lastName = "Owner",
            preferredCurrency = "EUR",
            numberFormat = (string?)null,
            acceptedTerms = true,
        }, Json);
        await EnsureAsync(register, HttpStatusCode.OK, "owner registration");
        _tokens[HouseholdRole.Owner] = (await ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;

        // 2. Owner direct-invites the three other roles into the same household.
        foreach (var role in new[] { HouseholdRole.Admin, HouseholdRole.Limited, HouseholdRole.ReadOnly })
        {
            var email = $"{role.ToString().ToLowerInvariant()}-{run}@httpsweep.test";
            var password = StrongPassword();

            var invite = await SendAsync(client, HttpMethod.Post, "/api/access/invite",
                _tokens[HouseholdRole.Owner], new
                {
                    email,
                    role = (int)role,
                    method = 0, // InviteMethod.Direct — temp password, active immediately
                    tempPassword = password,
                    displayName = $"Sweep {role}",
                    memberId = (Guid?)null,
                });
            await EnsureAsync(invite, HttpStatusCode.OK, $"direct invite for {role}");

            // 3. Real login => real bearer token carrying the real security stamp. A direct-invite
            //    login must replace the owner-set password before anything else (S-P2-3), so it
            //    does, and the token issued by that change is the one the sweep uses.
            var login = await client.PostAsJsonAsync("/api/auth/login", new { email, password }, Json);
            await EnsureAsync(login, HttpStatusCode.OK, $"login for {role}");
            var firstToken = (await ReadJsonAsync(login)).RootElement.GetProperty("token").GetString()!;
            var changed = await SendAsync(client, HttpMethod.Post, "/api/auth/change-password", firstToken,
                new { currentPassword = password, newPassword = StrongPassword() });
            await EnsureAsync(changed, HttpStatusCode.OK, $"first password change for {role}");
            _tokens[role] = (await ReadJsonAsync(changed)).RootElement.GetProperty("token").GetString()!;
        }

        // 4. Two accounts as transfer referents (also proves the Owner write path works end-to-end).
        CheckingAccountId = await CreateAccountAsync(client, $"Sweep Checking {run}");
        SavingsAccountId = await CreateAccountAsync(client, $"Sweep Savings {run}");

        // The current UTC month, started from the Essentials template so real category referents exist.
        var now = DateTime.UtcNow;
        var create = await SendAsync(client, HttpMethod.Post, "/api/budget", _tokens[HouseholdRole.Owner],
            new { year = now.Year, month = now.Month, copyFromPrevious = false, templateKey = "essentials" });
        await EnsureAsync(create, HttpStatusCode.OK, "current budget month from the Essentials template");
        var month = await SendAsync(client, HttpMethod.Get, "/api/budget/current", _tokens[HouseholdRole.Owner]);
        await EnsureAsync(month, HttpStatusCode.OK, "current budget month");
        BudgetMonthId = (await ReadJsonAsync(month)).RootElement.GetProperty("id").GetGuid();
    }

    public async Task DisposeAsync() => await _factory.DisposeAsync();

    /// <summary>Sends a request with an optional bearer token and optional JSON body.</summary>
    public static async Task<HttpResponseMessage> SendAsync(
        HttpClient client, HttpMethod method, string url, string? bearerToken = null, object? body = null)
    {
        using var request = new HttpRequestMessage(method, url);
        if (bearerToken is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearerToken);
        }
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: Json);
        }
        return await client.SendAsync(request);
    }

    public static async Task<JsonDocument> ReadJsonAsync(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync());

    private async Task<Guid> CreateAccountAsync(HttpClient client, string name)
    {
        var response = await SendAsync(client, HttpMethod.Post, "/api/accounts",
            _tokens[HouseholdRole.Owner],
            new { name, type = 0, currency = "EUR", openingBalance = 100m, openingDate = "2026-01-01" });
        await EnsureAsync(response, HttpStatusCode.Created, $"account '{name}'");
        return (await ReadJsonAsync(response)).RootElement.GetProperty("id").GetGuid();
    }

    private static async Task EnsureAsync(HttpResponseMessage response, HttpStatusCode expected, string step)
    {
        if (response.StatusCode != expected)
        {
            var body = await response.Content.ReadAsStringAsync();
            var challenge = string.Join("; ", response.Headers.WwwAuthenticate.Select(h => h.ToString()));
            throw new InvalidOperationException(
                $"Fixture provisioning failed at {step}: expected {(int)expected} but got " +
                $"{(int)response.StatusCode}. Body: {body}. WWW-Authenticate: {challenge}");
        }
    }

    /// <summary>Meets the Identity policy (len >= 8, upper/lower/digit) and is unique per call, so it
    /// can never be in the HIBP breach corpus the breached-password validator screens against.</summary>
    public static string StrongPassword() => $"Aa1x{Guid.NewGuid():N}";
}

/// <summary>Sweep + role-matrix classes share one booted API and provisioned household.</summary>
[CollectionDefinition(nameof(HttpApiCollection))]
public sealed class HttpApiCollection : ICollectionFixture<HttpApiFixture>;
