using System.Net;
using FluentAssertions;
using AllotJar.Domain.Enums;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The role matrix over real HTTP: four REAL logins (Owner / Admin / Limited / ReadOnly), all
/// members of the same household, each holding a real bearer token from <c>POST /api/auth/login</c>,
/// exercise one representative WRITE endpoint per controller. Expected statuses follow the
/// AuthorizationBehaviour rules exactly:
///
///   - default command (no attribute):    Owner + Admin 2xx, Limited 403, ReadOnly 403
///   - [AllowLimited] command:            Owner + Admin + Limited 2xx, ReadOnly 403
///   - [OwnerOnly] command:               Owner 2xx, everyone else 403
///   - queries:                           200 for every role (reads are open to all roles)
///
/// Unlike the unit tests over AuthorizationBehaviour, this proves the WHOLE chain: the JWT is
/// honored, HouseholdResolutionMiddleware resolves the caller's membership row to the right role,
/// the MediatR gate maps it to allow/forbid, and ExceptionHandlingMiddleware turns
/// ForbiddenAccessException into a real 403 response.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class RoleMatrixTests
{
    private static readonly HttpStatusCode OK = HttpStatusCode.OK;
    private static readonly HttpStatusCode Created = HttpStatusCode.Created;
    private static readonly HttpStatusCode Forbidden = HttpStatusCode.Forbidden;

    private readonly HttpApiFixture _fixture;

    public RoleMatrixTests(HttpApiFixture fixture) => _fixture = fixture;

    // --- default commands: Owner/Admin only ---------------------------------------------------

    [Fact]
    public async Task Budget_category_add_is_admin_and_up() =>
        await AssertMatrixAsync(HttpMethod.Post, _ => "/api/budget/categories",
            role => new { budgetMonthId = _fixture.BudgetMonthId, name = $"Matrix {role} {Unique()}", isSavings = false },
            owner: OK, admin: OK, limited: Forbidden, readOnly: Forbidden);

    [Fact]
    public async Task Account_create_is_admin_and_up() =>
        await AssertMatrixAsync(HttpMethod.Post, _ => "/api/accounts",
            role => new { name = $"Matrix {role} {Unique()}", type = 0, currency = "EUR", openingBalance = 0m, openingDate = "2026-01-01" },
            owner: Created, admin: Created, limited: Forbidden, readOnly: Forbidden);

    [Fact]
    public async Task Jar_create_is_admin_and_up() =>
        await AssertMatrixAsync(HttpMethod.Post, _ => "/api/jars",
            role => new
            {
                name = $"Matrix {role} {Unique()}",
                kind = 1,           // JarKind.Goal
                targetAmount = 500m,
                targetDate = (string?)null,
                coverStart = (string?)null,
                coverEnd = (string?)null,
                accrual = 1,        // AccrualMethod.TargetByDate
                fundingAccountId = _fixture.SavingsAccountId, // rule 73: a jar needs its account
                recurMonths = (int?)null,
            },
            owner: Created, admin: Created, limited: Forbidden, readOnly: Forbidden);

    [Fact]
    public async Task Allocation_profile_upsert_is_admin_and_up() =>
        await AssertMatrixAsync(HttpMethod.Put, _ => "/api/allocation/profile",
            role => new
            {
                id = (Guid?)null,
                name = $"Matrix {role} {Unique()}",
                sourceAccountId = (Guid?)null,
                rules = Array.Empty<object>(),
                balanceLeanPercent = 25,
            },
            owner: OK, admin: OK, limited: Forbidden, readOnly: Forbidden);

    [Fact]
    public async Task Member_add_is_admin_and_up() =>
        await AssertMatrixAsync(HttpMethod.Post, _ => "/api/members",
            role => new { name = $"Matrix {role} {Unique()}", netMonthlyIncome = 1000m, personalSavingsAccountId = (Guid?)null },
            owner: Created, admin: Created, limited: Forbidden, readOnly: Forbidden);

    // --- [AllowLimited] commands: day-to-day entry is open to Limited -------------------------

    [Fact]
    public async Task Transaction_create_is_open_to_limited() =>
        await AssertMatrixAsync(HttpMethod.Post, _ => "/api/transactions",
            role => new
            {
                date = Today(),
                payee = $"Matrix {role} {Unique()}",
                amount = 12.34m,
                type = 0, // TransactionType.Expense
                budgetItemId = (Guid?)null,
                accountId = (Guid?)null,
                memberId = (Guid?)null,
            },
            owner: Created, admin: Created, limited: Created, readOnly: Forbidden);

    [Fact]
    public async Task Transfer_create_is_open_to_limited() =>
        await AssertMatrixAsync(HttpMethod.Post, _ => "/api/transactions/transfer",
            role => new
            {
                departedOn = Today(),
                amount = 5m,
                fromAccountId = _fixture.CheckingAccountId,
                toAccountId = _fixture.SavingsAccountId,
                payee = $"Matrix {role} {Unique()}",
            },
            owner: Created, admin: Created, limited: Created, readOnly: Forbidden);

    // --- [OwnerOnly] commands: managing access stays with the Owner ---------------------------

    [Fact]
    public async Task Invite_create_is_owner_only() =>
        await AssertMatrixAsync(HttpMethod.Post, _ => "/api/access/invite",
            role => new
            {
                email = $"matrix-{role.ToString().ToLowerInvariant()}-{Unique()}@httpsweep.test",
                role = 3,   // HouseholdRole.ReadOnly — least privilege for a probe invite
                method = 1, // InviteMethod.Link — no login minted, just a redeemable token
                tempPassword = (string?)null,
                displayName = (string?)null,
                memberId = (Guid?)null,
            },
            owner: OK, admin: Forbidden, limited: Forbidden, readOnly: Forbidden);

    // --- queries: reads are open to every role ------------------------------------------------

    [Theory]
    [InlineData(HouseholdRole.Owner)]
    [InlineData(HouseholdRole.Admin)]
    [InlineData(HouseholdRole.Limited)]
    [InlineData(HouseholdRole.ReadOnly)]
    public async Task Budget_months_query_is_readable_by_every_role(HouseholdRole role)
    {
        using var client = _fixture.CreateClient();
        using var response = await HttpApiFixture.SendAsync(
            client, HttpMethod.Get, "/api/budget/months", _fixture.TokenFor(role));
        response.StatusCode.Should().Be(OK, $"reads are open to all roles, including {role}");
    }

    // ------------------------------------------------------------------------------------------

    /// <summary>
    /// Runs the same endpoint once per role (fresh unique body each time, so the allowed roles'
    /// writes don't collide) and asserts the exact expected status for each. Forbidden roles are
    /// rejected by the role gate BEFORE validation/handling (AuthorizationBehaviour is registered
    /// first), so the write never happens and the status must be exactly 403.
    /// </summary>
    private async Task AssertMatrixAsync(
        HttpMethod method,
        Func<HouseholdRole, string> url,
        Func<HouseholdRole, object> body,
        HttpStatusCode owner, HttpStatusCode admin, HttpStatusCode limited, HttpStatusCode readOnly)
    {
        var expectations = new (HouseholdRole Role, HttpStatusCode Expected)[]
        {
            (HouseholdRole.Owner, owner),
            (HouseholdRole.Admin, admin),
            (HouseholdRole.Limited, limited),
            (HouseholdRole.ReadOnly, readOnly),
        };

        using var client = _fixture.CreateClient();
        foreach (var (role, expected) in expectations)
        {
            using var response = await HttpApiFixture.SendAsync(
                client, method, url(role), _fixture.TokenFor(role), body(role));

            var detail = response.StatusCode == expected
                ? string.Empty
                : $" (body: {await response.Content.ReadAsStringAsync()})";
            response.StatusCode.Should().Be(expected,
                $"{method} {url(role)} as {role} must map to {(int)expected}{detail}");
        }
    }

    private static string Today() => DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");

    private static string Unique() => Guid.NewGuid().ToString("N")[..8];
}
