using System.Net;
using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Password-reset coverage (catalog prefix REG, docs/testing/cases/02-registration-login.md —
/// forgot/reset section).
///
/// Two server-side layers live here:
///  1. The reset-token engine: ASP.NET Core Identity's DataProtector token provider driven through
///     a real <see cref="UserManager{TUser}"/> with the SAME options as production (see
///     <c>src/AllotJar.Infrastructure/DependencyInjection.cs</c>) — token round-trip, single-use,
///     tamper/expiry rejection, and the password policy + HIBP screen applying to the NEW password.
///  2. The outbound-email plumbing: <see cref="PasswordResetEmail"/> content,
///     <see cref="LoggingEmailSender"/>/<see cref="DevEmailSink"/> capture, and
///     <see cref="ResendEmailSender"/>'s provider request shape.
///
/// The controller-level contract (always-204 no-enumeration on forgot, generic invalid-link vs
/// helpful password-policy 400s on reset, revoke-all + fresh cookie on success) is HTTP-layer
/// behaviour, covered end-to-end by <c>tests/AllotJar.IntegrationTests/Http/PasswordResetFlowTests</c>.
/// </summary>
public class AuthPasswordResetCoverageTests
{
    // A random, policy-compliant, non-breached password (HIBP is stubbed to "no match" by default).
    private static string FreshPassword() => "Aa1-" + Guid.NewGuid();

    // ---------------------------------------------------------------------------------------------
    // Group A — the reset-token engine (real UserManager + DataProtector token provider)
    // ---------------------------------------------------------------------------------------------

    // REG-056 — a generated reset token sets a new password: the old one stops working and the new
    // one signs in (the whole point of the emailed link).
    [Fact]
    public async Task Reset_token_sets_the_new_password()
    {
        using var h = new ResetHarness();
        var oldPassword = FreshPassword();
        var newPassword = FreshPassword();
        var user = await h.CreateUserAsync("owner@example.com", oldPassword);

        var token = await h.Users.GeneratePasswordResetTokenAsync(user);
        var result = await h.Users.ResetPasswordAsync(user, token, newPassword);

        result.Succeeded.Should().BeTrue(string.Join("; ", result.Errors.Select(e => e.Description)));
        (await h.Users.CheckPasswordAsync(user, oldPassword)).Should().BeFalse();
        (await h.Users.CheckPasswordAsync(user, newPassword)).Should().BeTrue();
    }

    // REG-057 — resetting rotates the security stamp, which is what invalidates every access token
    // issued before the reset (the JWT sstamp check) and makes the token single-use.
    [Fact]
    public async Task Reset_rotates_the_security_stamp()
    {
        using var h = new ResetHarness();
        var user = await h.CreateUserAsync("owner@example.com", FreshPassword());
        var stampBefore = await h.Users.GetSecurityStampAsync(user);

        var token = await h.Users.GeneratePasswordResetTokenAsync(user);
        (await h.Users.ResetPasswordAsync(user, token, FreshPassword())).Succeeded.Should().BeTrue();

        (await h.Users.GetSecurityStampAsync(user)).Should().NotBe(stampBefore);
    }

    // REG-058 — a redeemed link is dead: replaying the same token after a successful reset fails
    // (the token embeds the pre-reset security stamp), and the once-set password stays in force.
    [Fact]
    public async Task Reset_token_is_single_use()
    {
        using var h = new ResetHarness();
        var user = await h.CreateUserAsync("owner@example.com", FreshPassword());
        var firstNew = FreshPassword();

        var token = await h.Users.GeneratePasswordResetTokenAsync(user);
        (await h.Users.ResetPasswordAsync(user, token, firstNew)).Succeeded.Should().BeTrue();

        var replay = await h.Users.ResetPasswordAsync(user, token, FreshPassword());

        replay.Succeeded.Should().BeFalse();
        replay.Errors.Should().Contain(e => e.Code == nameof(IdentityErrorDescriber.InvalidToken));
        (await h.Users.CheckPasswordAsync(user, firstNew)).Should().BeTrue();
    }

    // REG-059 — a token minted for one account is useless against another (and garbage is useless
    // against anyone): InvalidToken, password untouched.
    [Fact]
    public async Task Foreign_or_garbage_tokens_are_rejected()
    {
        using var h = new ResetHarness();
        var password = FreshPassword();
        var alice = await h.CreateUserAsync("alice@example.com", password);
        var mallory = await h.CreateUserAsync("mallory@example.com", FreshPassword());

        var malloryToken = await h.Users.GeneratePasswordResetTokenAsync(mallory);
        var crossAccount = await h.Users.ResetPasswordAsync(alice, malloryToken, FreshPassword());
        var garbage = await h.Users.ResetPasswordAsync(alice, "not-a-real-token", FreshPassword());

        crossAccount.Succeeded.Should().BeFalse();
        crossAccount.Errors.Should().Contain(e => e.Code == nameof(IdentityErrorDescriber.InvalidToken));
        garbage.Succeeded.Should().BeFalse();
        garbage.Errors.Should().Contain(e => e.Code == nameof(IdentityErrorDescriber.InvalidToken));
        (await h.Users.CheckPasswordAsync(alice, password)).Should().BeTrue();
    }

    // REG-060 — the emailed link expires (production lifespan: 2h, set in DependencyInjection.cs;
    // here shrunk to zero so expiry is deterministic). An expired token reads as InvalidToken.
    [Fact]
    public async Task Expired_token_is_rejected()
    {
        using var h = new ResetHarness(tokenLifespan: TimeSpan.Zero);
        var user = await h.CreateUserAsync("owner@example.com", FreshPassword());

        var token = await h.Users.GeneratePasswordResetTokenAsync(user);
        var result = await h.Users.ResetPasswordAsync(user, token, FreshPassword());

        result.Succeeded.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Code == nameof(IdentityErrorDescriber.InvalidToken));
    }

    // REG-061 — the reset path enforces the same password policy as registration, and a policy
    // rejection does NOT burn the token: the user can retry the same link with a stronger password.
    [Fact]
    public async Task Policy_failing_password_is_rejected_without_burning_the_token()
    {
        using var h = new ResetHarness();
        var user = await h.CreateUserAsync("owner@example.com", FreshPassword());
        var token = await h.Users.GeneratePasswordResetTokenAsync(user);

        var tooShort = await h.Users.ResetPasswordAsync(user, token, "Aa1");
        tooShort.Succeeded.Should().BeFalse();
        tooShort.Errors.Should().Contain(e => e.Code == nameof(IdentityErrorDescriber.PasswordTooShort));

        var retry = await h.Users.ResetPasswordAsync(user, token, FreshPassword());
        retry.Succeeded.Should().BeTrue(string.Join("; ", retry.Errors.Select(e => e.Description)));
    }

    // REG-062 — the new password is screened against the HIBP breach corpus exactly like
    // registration's (same BreachedPasswordValidator instance in the pipeline).
    [Fact]
    public async Task Breached_new_password_is_rejected()
    {
        using var h = new ResetHarness();
        var user = await h.CreateUserAsync("owner@example.com", FreshPassword());
        const string breached = "Breached1Password";
        h.Hibp.BodyFor = _ => $"0000000000000000000000000000000000A:3\n{Sha1Suffix(breached)}:1337\n";

        var token = await h.Users.GeneratePasswordResetTokenAsync(user);
        var result = await h.Users.ResetPasswordAsync(user, token, breached);

        result.Succeeded.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Code == "PwnedPassword");
    }

    // ---------------------------------------------------------------------------------------------
    // Group B — outbound email plumbing
    // ---------------------------------------------------------------------------------------------

    // REG-054 — the reset email carries the link in BOTH bodies (text clients + html clients),
    // states the lifetime in each, includes the "didn't request this — ignore it" reassurance, and
    // embeds NO external images/trackers (mail-client privacy + nothing to block).
    [Fact]
    public void Reset_email_is_self_contained_with_the_link_lifetime_and_ignore_note_in_both_bodies()
    {
        const string link = "https://www.allotjar.com/reset-password?email=a%40b.com&token=x%2By";

        var message = PasswordResetEmail.Build("a@b.com", link);
        var lifetime = $"{PasswordResetEmail.LinkLifetimeHours} hours";

        message.ToEmail.Should().Be("a@b.com");
        message.Subject.Should().Contain("Reset").And.Contain("password");

        // The link is present in both bodies (raw in text, HTML-encoded in markup).
        message.TextBody.Should().Contain(link);
        message.HtmlBody.Should().Contain(WebUtility.HtmlEncode(link));

        // The lifetime is stated in BOTH bodies (a text-only client must see it too).
        message.TextBody.Should().Contain(lifetime);
        message.HtmlBody.Should().Contain(lifetime);

        // The reassurance note is in both bodies.
        message.TextBody.Should().Contain("didn't request");
        message.HtmlBody.Should().Contain("didn't request");

        // No external images/trackers: the only http(s) URLs in the HTML are the reset link itself.
        message.HtmlBody.Should().NotContain("<img");
        var encodedLink = WebUtility.HtmlEncode(link);
        message.HtmlBody.Replace(encodedLink, string.Empty).Should().NotContain("http",
            "the reset link is the ONLY external URL — no tracking pixels, CDN assets or unsubscribe hosts");
    }

    // The dev-mailbox capture the journey e2e suite depends on: per-recipient, most recent first,
    // bounded so a long-lived dev server can't grow without limit.
    [Fact]
    public void Dev_sink_returns_a_recipients_messages_most_recent_first_and_stays_bounded()
    {
        var sink = new DevEmailSink();
        for (var i = 0; i < 60; i++)
        {
            sink.Record(new EmailMessage("keep@example.com", $"Subject {i}", "t", "h"));
        }
        sink.Record(new EmailMessage("other@example.com", "Other", "t", "h"));

        var kept = sink.ForRecipient("KEEP@example.com"); // case-insensitive, like email
        kept.Should().NotBeEmpty();
        kept.Count.Should().BeLessThanOrEqualTo(50);
        kept[0].Subject.Should().Be("Subject 59");
        sink.ForRecipient("other@example.com").Should().ContainSingle();
        sink.ForRecipient("nobody@example.com").Should().BeEmpty();
    }

    [Fact]
    public async Task Logging_sender_records_into_the_sink()
    {
        var sink = new DevEmailSink();
        var sender = new LoggingEmailSender(
            sink, Options.Create(new EmailSettings()), NullLogger<LoggingEmailSender>.Instance);

        await sender.SendAsync(new EmailMessage("dev@example.com", "Hello", "text", "<p>html</p>"));

        sink.ForRecipient("dev@example.com").Should().ContainSingle(m => m.Subject == "Hello");
    }

    // REG-055 — the Resend adapter posts the provider's documented shape (from/to/subject/text/html
    // to POST /emails) and treats a provider rejection as a throw (the controller catches + logs it
    // and still answers 204 — no-enumeration).
    [Fact]
    public async Task Resend_sender_posts_the_provider_shape_and_throws_on_rejection()
    {
        var captured = new List<(HttpRequestMessage Request, string Body)>();
        var handler = new CapturingHandler(req => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"id\":\"1\"}"),
        }, captured);
        var settings = Options.Create(new EmailSettings { FromAddress = "AllotJar <no-reply@allotjar.com>" });
        var sender = new ResendEmailSender(
            new HttpClient(handler) { BaseAddress = new Uri("https://api.resend.com/") },
            settings, NullLogger<ResendEmailSender>.Instance);

        await sender.SendAsync(new EmailMessage("to@example.com", "Subj", "text-body", "<p>html</p>"));

        captured.Should().ContainSingle();
        captured[0].Request.RequestUri!.AbsoluteUri.Should().Be("https://api.resend.com/emails");
        captured[0].Body.Should().Contain("\"from\":\"AllotJar \\u003Cno-reply@allotjar.com\\u003E\"")
            .And.Contain("\"to\":[\"to@example.com\"]")
            .And.Contain("\"subject\":\"Subj\"")
            .And.Contain("\"text\":\"text-body\"")
            .And.Contain("\"html\":");

        var failing = new ResendEmailSender(
            new HttpClient(new CapturingHandler(
                _ => new HttpResponseMessage(HttpStatusCode.UnprocessableEntity)
                {
                    Content = new StringContent("{\"name\":\"validation_error\"}"),
                },
                new List<(HttpRequestMessage, string)>()))
            { BaseAddress = new Uri("https://api.resend.com/") },
            settings, NullLogger<ResendEmailSender>.Instance);

        var act = () => failing.SendAsync(new EmailMessage("to@example.com", "Subj", "t", "h"));
        await act.Should().ThrowAsync<HttpRequestException>();
    }

    // ---------------------------------------------------------------------------------------------
    // Plumbing
    // ---------------------------------------------------------------------------------------------

    /// <summary>The uppercase-hex SHA-1 suffix (chars 5..) HIBP's range API matches on.</summary>
    private static string Sha1Suffix(string password) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(password)))[5..];

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;
        private readonly List<(HttpRequestMessage Request, string Body)> _captured;

        public CapturingHandler(
            Func<HttpRequestMessage, HttpResponseMessage> respond,
            List<(HttpRequestMessage, string)> captured)
        {
            _respond = respond;
            _captured = captured;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            _captured.Add((request, request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct)));
            return _respond(request);
        }
    }

    /// <summary>HIBP range-API stub (default: no breach match). Mirrors RAuthRegistrationCoverageTests.</summary>
    private sealed class MutableHibpHandler : HttpMessageHandler
    {
        public Func<string, string> BodyFor = _ => "0000000000000000000000000000000000A:0\n";

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(BodyFor(request.RequestUri!.Segments[^1])),
            });
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        public StubHttpClientFactory(HttpMessageHandler handler) => _handler = handler;
        public HttpClient CreateClient(string name) =>
            new(_handler, disposeHandler: false) { BaseAddress = new Uri("https://api.pwnedpasswords.com/") };
    }

    /// <summary>
    /// The registration AuthHarness (same production Identity options — kept in lockstep with
    /// DependencyInjection.cs) PLUS the pieces password reset needs: AddDefaultTokenProviders and
    /// an ephemeral IDataProtectionProvider backing the reset-token provider. <paramref name="tokenLifespan"/>
    /// defaults to the production 2h; tests pass TimeSpan.Zero to observe expiry deterministically.
    /// </summary>
    private sealed class ResetHarness : IDisposable
    {
        private readonly ServiceProvider _provider;
        private readonly IServiceScope _scope;

        public MutableHibpHandler Hibp { get; } = new();
        public UserManager<ApplicationUser> Users { get; }

        public ResetHarness(TimeSpan? tokenLifespan = null)
        {
            var services = new ServiceCollection();
            services.AddSingleton(typeof(ILogger<>), typeof(NullLogger<>));
            services.AddDbContext<ApplicationDbContext>(o =>
                o.UseInMemoryDatabase($"zbb-reset-{Guid.NewGuid()}"));
            services.AddSingleton<IHttpClientFactory>(new StubHttpClientFactory(Hibp));
            services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
            services.Configure<DataProtectionTokenProviderOptions>(o =>
                o.TokenLifespan = tokenLifespan ?? TimeSpan.FromHours(PasswordResetEmail.LinkLifetimeHours));

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
                .AddDefaultTokenProviders()
                .AddPasswordValidator<BreachedPasswordValidator>();

            _provider = services.BuildServiceProvider();
            _scope = _provider.CreateScope();
            Users = _scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        }

        public async Task<ApplicationUser> CreateUserAsync(string email, string password)
        {
            var user = new ApplicationUser { UserName = email, Email = email };
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
}
