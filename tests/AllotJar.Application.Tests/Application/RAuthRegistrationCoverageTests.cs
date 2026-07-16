using System.Net;
using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Auth-registration coverage (catalog prefix REG, docs/testing/cases/02-registration-login.md).
///
/// Two layers are exercised here, both server-side and reachable from Application/Infrastructure:
///  1. The opt-in sample-budget seed (PR #170): <see cref="BudgetSeeder"/> produces the exact starter
///     figures a brand-new opted-in registrant lands on, and refuses to inject them into a household
///     that already owns any month (REG-006/007/008).
///  2. ASP.NET Core Identity as the registration/sign-in engine, driven through a real
///     <see cref="UserManager{TUser}"/> over EF InMemory with the SAME options as production
///     (see <c>src/AllotJar.Infrastructure/DependencyInjection.cs</c>): the password policy + HIBP
///     wiring at create, HIBP never at login, duplicate-email rejection, and the
///     <see cref="IdentityService"/> credential-check + lockout behaviour (REG-013/018/019/020/023/024/
///     036/037/038/044/045).
///
/// Registration's controller-level validation ORDER and the exact <c>{error}</c> strings (terms,
/// currency, number-format, duplicate) live in <c>AuthController.Register</c> (the API layer) and are
/// out of reach here — see the class-tail note. The reusable pieces those checks call
/// (<see cref="UserPreferences"/>, <see cref="global::AllotJar.Domain.ValueObjects.CurrencyCode"/>) are
/// already unit-covered by UserPreferencesTests + CurrencyCodeTests.
/// </summary>
public class RAuthRegistrationCoverageTests
{
    // ---------------------------------------------------------------------------------------------
    // Group A — opt-in sample budget seed vs default-empty account (PR #170)
    // ---------------------------------------------------------------------------------------------

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-reg-{Guid.NewGuid()}")
            .Options);

    // REG-007 — opting in to sample figures seeds the exact starter budget: Take-home Pay 3,000;
    // Housing (Rent 1,100 / Utilities 180); Transport (Fuel 120 / Public Transport 60);
    // Food (Groceries 400 / Dining Out 90); Savings (Emergency Fund 250). Income is seeded ABOVE the
    // planned total on purpose, leaving Remaining to budget = 800.00 (positive, never the balanced badge).
    [Fact]
    public async Task Sample_seed_creates_the_exact_starter_budget_with_positive_remaining()
    {
        using var db = NewContext();

        await BudgetSeeder.SeedDefaultMonthAsync(db, "owner-1", 2026, 7);

        var month = await db.BudgetMonths
            .Include(m => m.Categories).ThenInclude(c => c.Items)
            .SingleAsync(m => m.OwnerId == "owner-1");

        month.Year.Should().Be(2026);
        month.Month.Should().Be(7);

        decimal Planned(string group, string line) => month.Categories
            .Single(c => c.Name == group).Items.Single(i => i.Name == line).PlannedAmount;

        Planned("Income", "Take-home Pay").Should().Be(3000.00m);
        Planned("Housing", "Rent").Should().Be(1100.00m);
        Planned("Housing", "Utilities").Should().Be(180.00m);
        Planned("Transport", "Fuel").Should().Be(120.00m);
        Planned("Transport", "Public Transport").Should().Be(60.00m);
        Planned("Food", "Groceries").Should().Be(400.00m);
        Planned("Food", "Dining Out").Should().Be(90.00m);
        Planned("Savings", "Emergency Fund").Should().Be(250.00m);

        month.TotalIncome.Should().Be(3000.00m);
        month.TotalPlanned.Should().Be(2200.00m); // 1280 housing + 180 transport + 490 food + 250 savings
        month.RemainingToBudget.Should().Be(800.00m);
        // Deliberately NOT balanced — a fresh sample budget has money still to assign (PR #172).
        month.IsBalanced.Should().BeFalse();
    }

    // REG-007 — the seeded "Emergency Fund" line is a real jar from day one (BudgetItem.SavingsId is an
    // enforced FK to Jars.Id), which is what makes its balance roll over and gives the Jars page
    // something to show a brand-new user. (InMemory doesn't enforce the FK — SavingsForeignKeyTests
    // guards that on SQL — but the seeder must still point the line at a genuine jar row.)
    [Fact]
    public async Task Sample_seed_backs_the_Emergency_Fund_line_with_a_real_jar()
    {
        using var db = NewContext();

        await BudgetSeeder.SeedDefaultMonthAsync(db, "owner-1", 2026, 7);

        var month = await db.BudgetMonths
            .Include(m => m.Categories).ThenInclude(c => c.Items)
            .SingleAsync(m => m.OwnerId == "owner-1");
        var savingsGroup = month.Categories.Single(c => c.Kind == CategoryKind.Savings);
        savingsGroup.Name.Should().Be("Savings");

        var line = savingsGroup.Items.Single();
        line.Name.Should().Be("Emergency Fund");
        line.SavingsId.Should().NotBeNull();

        var jar = await db.Jars.SingleAsync(j => j.OwnerId == "owner-1");
        jar.Name.Should().Be("Emergency Fund");
        line.SavingsId.Should().Be(jar.Id);
    }

    // REG-007 / REG-008 (PR #170 guard) — the seeder is strictly a brand-new-household seed: ANY
    // existing month (not just the target one) means the owner has a real budget, and the sample
    // figures must never be injected into it. It also mints no Emergency Fund jar on the blocked path.
    [Fact]
    public async Task Seed_is_a_no_op_when_the_owner_already_has_any_month()
    {
        using var db = NewContext();
        // A real budget the owner built earlier, in a different month/year than the sample's target.
        db.BudgetMonths.Add(new BudgetMonth { OwnerId = "owner-1", Year = 2025, Month = 12 });
        await db.SaveChangesAsync();

        await BudgetSeeder.SeedDefaultMonthAsync(db, "owner-1", 2026, 7);

        var months = await db.BudgetMonths.Where(m => m.OwnerId == "owner-1").ToListAsync();
        months.Should().ContainSingle().Which.Year.Should().Be(2025);

        // No sample figures leaked in and no backing jar was created.
        (await db.BudgetItems.AnyAsync(i => i.Name == "Take-home Pay")).Should().BeFalse();
        (await db.Jars.AnyAsync(j => j.OwnerId == "owner-1")).Should().BeFalse();
    }

    // ---------------------------------------------------------------------------------------------
    // Group B/C/D — ASP.NET Core Identity as the real registration/sign-in engine
    // ---------------------------------------------------------------------------------------------

    /// <summary>SHA-1 hex suffix (chars 6..) of a password, matching HIBP's k-anonymity split.</summary>
    private static string HibpSuffix(string password) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(password)))[5..];

    /// <summary>
    /// A HIBP range-API stub whose response is switchable per-test. Default = "clean" (one padding
    /// row, no suffix match ⇒ breach count 0). <see cref="RawResponder"/> lets a test throw if the
    /// endpoint is touched at all (used to prove HIBP is never consulted at sign-in).
    /// </summary>
    private sealed class MutableHibpHandler : HttpMessageHandler
    {
        public Func<string, string> BodyFor = _ => "0000000000000000000000000000000000A:0\n";
        public Func<string, HttpResponseMessage>? RawResponder;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var prefix = request.RequestUri!.Segments[^1];
            if (RawResponder is not null)
            {
                return Task.FromResult(RawResponder(prefix));
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(BodyFor(prefix)),
            });
        }
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        public StubHttpClientFactory(HttpMessageHandler handler) => _handler = handler;
        public HttpClient CreateClient(string name) =>
            new(_handler, disposeHandler: false) { BaseAddress = new Uri("https://api.pwnedpasswords.com/") };
    }

    /// <summary>
    /// A fully wired ASP.NET Core Identity stack over EF InMemory: a real <see cref="UserManager{TUser}"/>
    /// with the default composition/length/lockout validators PLUS the real
    /// <see cref="BreachedPasswordValidator"/> (HIBP stubbed), and an <see cref="IdentityService"/> over
    /// it. Options mirror <c>src/AllotJar.Infrastructure/DependencyInjection.cs</c> (AddIdentityCore, ~L64-79).
    /// </summary>
    private sealed class AuthHarness : IDisposable
    {
        private readonly ServiceProvider _provider;
        private readonly IServiceScope _scope;

        public MutableHibpHandler Hibp { get; } = new();
        public UserManager<ApplicationUser> Users { get; }
        public IdentityService Identity { get; }
        public ApplicationDbContext Db { get; }

        public AuthHarness()
        {
            var services = new ServiceCollection();
            services.AddSingleton(typeof(ILogger<>), typeof(NullLogger<>));
            services.AddDbContext<ApplicationDbContext>(o =>
                o.UseInMemoryDatabase($"zbb-identity-{Guid.NewGuid()}"));
            services.AddSingleton<IHttpClientFactory>(new StubHttpClientFactory(Hibp));

            services
                .AddIdentityCore<ApplicationUser>(o =>
                {
                    // Kept in lockstep with DependencyInjection.cs — these are the production values.
                    o.User.RequireUniqueEmail = true;
                    o.Password.RequiredLength = 8;
                    o.Password.RequireNonAlphanumeric = false;
                    o.Lockout.MaxFailedAccessAttempts = 5;
                    o.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                    o.Lockout.AllowedForNewUsers = true;
                })
                .AddEntityFrameworkStores<ApplicationDbContext>()
                .AddPasswordValidator<BreachedPasswordValidator>();

            _provider = services.BuildServiceProvider();
            _scope = _provider.CreateScope();
            Db = _scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            Users = _scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            Identity = new IdentityService(Users);
        }

        /// <summary>Creates a login the way registration does; asserts it succeeded.</summary>
        public async Task<ApplicationUser> CreateUserAsync(string email, string password, string? displayName = null)
        {
            var user = new ApplicationUser { UserName = email, Email = email, DisplayName = displayName };
            var result = await Users.CreateAsync(user, password);
            result.Succeeded.Should().BeTrue(
                "seed user should be creatable: {0}", string.Join("; ", result.Errors.Select(e => e.Description)));
            return user;
        }

        public void Dispose()
        {
            _scope.Dispose();
            _provider.Dispose();
        }
    }

    // A random, policy-compliant, non-breached password (the journey harness uses this exact shape,
    // because HIBP rejects fixed common passwords). Aa1- prefix guarantees upper+lower+digit.
    private static string FreshPassword() => "Aa1-" + Guid.NewGuid();

    // ----- REG-036 / REG-037 / REG-038 : IdentityService credential check (sign-in engine) --------

    // REG-036 — valid credentials return Success carrying the resolved identity (userId/email/display
    // name/security stamp), which is what the login command turns into a JWT.
    [Fact]
    public async Task CheckCredentials_with_the_right_password_succeeds()
    {
        using var h = new AuthHarness();
        var password = FreshPassword();
        var user = await h.CreateUserAsync("owner@example.com", password, "Ana Borg");

        var result = await h.Identity.CheckCredentialsAsync("owner@example.com", password);

        result.Outcome.Should().Be(CredentialCheckOutcome.Success);
        result.UserId.Should().Be(user.Id);
        result.Email.Should().Be("owner@example.com");
        result.DisplayName.Should().Be("Ana Borg");
        result.SecurityStamp.Should().NotBeNullOrEmpty();
    }

    // REG-037 — a wrong password for a real account returns the generic InvalidCredentials outcome
    // (no token, no exception); the failure is counted but stays below the lockout threshold.
    [Fact]
    public async Task CheckCredentials_with_a_wrong_password_is_invalid()
    {
        using var h = new AuthHarness();
        await h.CreateUserAsync("owner@example.com", FreshPassword());

        var result = await h.Identity.CheckCredentialsAsync("owner@example.com", "WrongPass1x");

        result.Outcome.Should().Be(CredentialCheckOutcome.InvalidCredentials);
        result.UserId.Should().BeNull();
    }

    // REG-038 — an unknown email returns the IDENTICAL InvalidCredentials outcome as a wrong password
    // (anti-enumeration): the caller can never tell "no such account" from "wrong password", and the
    // unknown-email path runs a dummy hash rather than throwing.
    [Fact]
    public async Task CheckCredentials_for_an_unknown_email_is_invalid_not_distinguishable()
    {
        using var h = new AuthHarness();

        var unknown = await h.Identity.CheckCredentialsAsync("nobody-here@example.test", "AnyPassw0rd");

        unknown.Outcome.Should().Be(CredentialCheckOutcome.InvalidCredentials);
        unknown.Should().BeEquivalentTo(CredentialCheckResult.Invalid);
    }

    // ----- REG-044 / REG-045 : lockout ------------------------------------------------------------

    // REG-044 — five consecutive failures lock the account: the threshold-crossing 5th failure itself
    // returns LockedOut, and correct credentials are then refused while locked (no token issued).
    [Fact]
    public async Task Five_consecutive_failures_lock_the_account_and_refuse_the_correct_password()
    {
        using var h = new AuthHarness();
        var password = FreshPassword();
        await h.CreateUserAsync("lockme@example.test", password);

        // Four failures stay InvalidCredentials (below the threshold of 5).
        for (var i = 0; i < 4; i++)
        {
            (await h.Identity.CheckCredentialsAsync("lockme@example.test", "Nope-000" + i))
                .Outcome.Should().Be(CredentialCheckOutcome.InvalidCredentials);
        }

        // The fifth failure crosses the threshold and returns the locked outcome immediately.
        (await h.Identity.CheckCredentialsAsync("lockme@example.test", "Nope-final1"))
            .Outcome.Should().Be(CredentialCheckOutcome.LockedOut);

        // Correct credentials are refused while the lockout window is open.
        (await h.Identity.CheckCredentialsAsync("lockme@example.test", password))
            .Outcome.Should().Be(CredentialCheckOutcome.LockedOut);
    }

    // REG-045 — a successful sign-in resets the consecutive-failure counter, so a later run of four
    // failures stays below the threshold and the next correct attempt still succeeds (never locks).
    [Fact]
    public async Task A_successful_sign_in_resets_the_failure_counter()
    {
        using var h = new AuthHarness();
        var password = FreshPassword();
        await h.CreateUserAsync("counter@example.test", password);

        for (var i = 0; i < 4; i++)
        {
            await h.Identity.CheckCredentialsAsync("counter@example.test", "Wrong-11" + i);
        }

        // Success resets the counter back to zero.
        (await h.Identity.CheckCredentialsAsync("counter@example.test", password))
            .Outcome.Should().Be(CredentialCheckOutcome.Success);

        // Four more failures therefore stay below the threshold — no lockout.
        for (var i = 0; i < 4; i++)
        {
            (await h.Identity.CheckCredentialsAsync("counter@example.test", "Wrong-22" + i))
                .Outcome.Should().Be(CredentialCheckOutcome.InvalidCredentials);
        }

        (await h.Identity.CheckCredentialsAsync("counter@example.test", password))
            .Outcome.Should().Be(CredentialCheckOutcome.Success);
    }

    // ----- REG-013 / REG-019 / REG-020 : password policy at create --------------------------------

    // REG-019 — Identity composition rules are enforced at create with the default messages; the
    // RequireNonAlphanumeric rule is OFF (no special character required). Each violation surfaces its
    // own Identity error code + description, joined into the register alert client-side.
    [Theory]
    [InlineData("Abcdefgh-", "PasswordRequiresDigit", "Passwords must have at least one digit ('0'-'9').")]
    [InlineData("ABCDEFG1-", "PasswordRequiresLower", "Passwords must have at least one lowercase ('a'-'z').")]
    [InlineData("abcdefg1-", "PasswordRequiresUpper", "Passwords must have at least one uppercase ('A'-'Z').")]
    public async Task Password_composition_rules_are_enforced_with_the_default_messages(
        string password, string expectedCode, string expectedMessage)
    {
        using var h = new AuthHarness();
        var user = new ApplicationUser { UserName = "reg@example.test", Email = "reg@example.test" };

        var result = await h.Users.CreateAsync(user, password);

        result.Succeeded.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Code == expectedCode && e.Description == expectedMessage);
    }

    // REG-019 — with digit + lower + upper present, NO special character is required (the policy sets
    // RequireNonAlphanumeric = false), so an all-alphanumeric password is accepted.
    [Fact]
    public async Task An_alphanumeric_password_with_no_special_char_is_accepted()
    {
        using var h = new AuthHarness();
        var user = new ApplicationUser { UserName = "nosym@example.test", Email = "nosym@example.test" };

        var result = await h.Users.CreateAsync(user, "Xq7pLm2v"); // 8 chars, digit+upper+lower, no symbol

        result.Succeeded.Should().BeTrue(string.Join("; ", result.Errors.Select(e => e.Description)));
    }

    // REG-013 — a password shorter than 8 characters is rejected at model creation with PasswordTooShort
    // (the server-side backstop to the client's minLength=8).
    [Fact]
    public async Task A_password_shorter_than_eight_characters_is_rejected()
    {
        using var h = new AuthHarness();
        var user = new ApplicationUser { UserName = "short@example.test", Email = "short@example.test" };

        var result = await h.Users.CreateAsync(user, "Aa1-xyz"); // 7 chars

        result.Succeeded.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Code == "PasswordTooShort");
        (await h.Db.Users.AnyAsync(u => u.Email == "short@example.test")).Should().BeFalse();
    }

    // REG-020 — exactly eight characters is the inclusive minimum: a compliant, non-breached 8-char
    // password is accepted and the account is created.
    [Fact]
    public async Task An_exactly_eight_character_compliant_password_is_accepted()
    {
        using var h = new AuthHarness();
        var user = new ApplicationUser { UserName = "eight@example.test", Email = "eight@example.test" };

        var result = await h.Users.CreateAsync(user, "Xq7pLm2v"); // exactly 8

        result.Succeeded.Should().BeTrue(string.Join("; ", result.Errors.Select(e => e.Description)));
        (await h.Db.Users.CountAsync(u => u.Email == "eight@example.test")).Should().Be(1);
    }

    // ----- REG-018 : HIBP breached-password screening at create; never at login -------------------

    // REG-018 — the breached-password validator is wired into the create path: a password whose SHA-1
    // suffix HIBP returns is rejected with the PwnedPassword code + message, even though it satisfies
    // length + composition. (The validator's own unit behaviour lives in BreachedPasswordValidatorTests;
    // this proves it actually runs during account creation.)
    [Fact]
    public async Task A_breached_password_is_rejected_at_account_creation()
    {
        using var h = new AuthHarness();
        var breached = "Password1!"; // passes length + digit/upper/lower
        h.Hibp.BodyFor = _ => $"{HibpSuffix(breached)}:42\n";

        var user = new ApplicationUser { UserName = "breach@example.test", Email = "breach@example.test" };
        var result = await h.Users.CreateAsync(user, breached);

        result.Succeeded.Should().BeFalse();
        result.Errors.Should().Contain(e =>
            e.Code == "PwnedPassword" &&
            e.Description == "This password has appeared in a known data breach. Please choose a different one.");
        (await h.Db.Users.AnyAsync(u => u.Email == "breach@example.test")).Should().BeFalse();
    }

    // REG-018 — HIBP is NEVER consulted at sign-in (so passwords breached AFTER sign-up don't lock
    // people out, and login stays fast). The HIBP endpoint is armed to throw if touched; a correct
    // credential check still succeeds, proving the password validators don't run on the login path.
    [Fact]
    public async Task HIBP_is_never_called_during_sign_in()
    {
        using var h = new AuthHarness();
        var password = FreshPassword();
        await h.CreateUserAsync("login@example.test", password); // create screens against HIBP (clean)

        // Any HIBP call from here on is a defect.
        h.Hibp.RawResponder = _ => throw new InvalidOperationException("HIBP must not be called at sign-in.");

        var result = await h.Identity.CheckCredentialsAsync("login@example.test", password);

        result.Outcome.Should().Be(CredentialCheckOutcome.Success);
    }

    // ----- REG-023 / REG-024 : duplicate email ----------------------------------------------------

    // REG-023 — a duplicate email is refused by Identity (RequireUniqueEmail), and the existence probe
    // the controller uses before create (EmailExistsAsync) reports the collision. No second row is written.
    [Fact]
    public async Task A_duplicate_email_is_rejected()
    {
        using var h = new AuthHarness();
        await h.CreateUserAsync("owner@example.com", FreshPassword());

        (await h.Identity.EmailExistsAsync("owner@example.com")).Should().BeTrue();

        var dup = new ApplicationUser { UserName = "owner@example.com", Email = "owner@example.com" };
        var result = await h.Users.CreateAsync(dup, FreshPassword());

        result.Succeeded.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Code.StartsWith("Duplicate"));
        (await h.Db.Users.CountAsync(u => u.Email == "owner@example.com")).Should().Be(1);
    }

    // REG-024 — duplicate detection is case-insensitive (Identity normalized-email lookup): a differently
    // cased spelling resolves to the same account and is refused a second registration.
    [Fact]
    public async Task Duplicate_email_detection_is_case_insensitive()
    {
        using var h = new AuthHarness();
        var owner = await h.CreateUserAsync("owner@example.com", FreshPassword());

        (await h.Identity.EmailExistsAsync("OWNER@Example.COM")).Should().BeTrue();
        var found = await h.Identity.FindByEmailAsync("OWNER@Example.COM");
        found.Should().NotBeNull();
        found!.Id.Should().Be(owner.Id);

        var dup = new ApplicationUser { UserName = "OWNER@Example.COM", Email = "OWNER@Example.COM" };
        var result = await h.Users.CreateAsync(dup, FreshPassword());
        result.Succeeded.Should().BeFalse();
        (await h.Db.Users.CountAsync()).Should().Be(1);
    }
}
