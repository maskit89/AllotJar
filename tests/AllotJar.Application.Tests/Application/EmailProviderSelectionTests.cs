using System.Reflection;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure;
using AllotJar.Infrastructure.Email;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Which outbound-email sender the REAL composition root (<see cref="DependencyInjection"/>)
/// resolves for a given <c>Email</c> configuration (catalog REG-070).
///
/// This matters because the choice is made ONCE at startup: a config typo doesn't fail loudly, it
/// silently degrades password reset to log-only. These cases pin every branch of that decision —
/// including the back-compat default (a bare ApiKey still means Resend) and the two ways a
/// Cloudflare config can be incomplete.
/// </summary>
public class EmailProviderSelectionTests
{
    [Theory]
    // No key at all → the dev/CI fallback (never any credentials required).
    [InlineData(null, null, null, typeof(LoggingEmailSender))]
    // Back-compat: a key with NO provider set still means Resend, so configurations written before
    // the provider switch existed keep working untouched.
    [InlineData(null, "key", null, typeof(ResendEmailSender))]
    [InlineData("resend", "key", null, typeof(ResendEmailSender))]
    [InlineData("Resend", "key", null, typeof(ResendEmailSender))] // case/whitespace tolerant
    [InlineData("  CLOUDFLARE  ", "key", "acct", typeof(CloudflareEmailSender))]
    [InlineData("cloudflare", "key", "acct", typeof(CloudflareEmailSender))]
    // Cloudflare's send endpoint is account-scoped, so a key without an AccountId is unusable —
    // fall back rather than issue requests to a malformed URL.
    [InlineData("cloudflare", "key", null, typeof(LoggingEmailSender))]
    [InlineData("cloudflare", "key", "   ", typeof(LoggingEmailSender))]
    // An unrecognised provider name must not silently masquerade as a working sender.
    [InlineData("mailgun", "key", null, typeof(LoggingEmailSender))]
    // A provider without a key is still just the fallback.
    [InlineData("cloudflare", null, "acct", typeof(LoggingEmailSender))]
    public void Resolves_the_expected_sender_for_the_configuration(
        string? provider, string? apiKey, string? accountId, Type expected)
    {
        using var provider_ = BuildProvider(provider, apiKey, accountId);

        var sender = provider_.GetRequiredService<IEmailSender>();

        sender.Should().BeOfType(expected);
    }

    // REG-070 — the typed HttpClient the REAL composition root configures. The adapter unit tests
    // hand-build their own HttpClient, so without this a wrong base address or a missing/renamed
    // auth header in AddInfrastructure would ship silently: every send would 404/401 at the
    // provider and, because dispatch is off-request and best-effort, no user would ever see it.
    [Theory]
    [InlineData("cloudflare", "acct", "https://api.cloudflare.com/", typeof(CloudflareEmailSender))]
    [InlineData("resend", null, "https://api.resend.com/", typeof(ResendEmailSender))]
    public void Configures_the_typed_http_client_with_the_provider_base_address_and_bearer_auth(
        string provider, string? accountId, string expectedBaseAddress, Type senderType)
    {
        using var services = BuildProvider(provider, "secret-token", accountId);

        var sender = services.GetRequiredService<IEmailSender>();
        sender.Should().BeOfType(senderType);

        // The typed client is injected as a private field; reading it back is the only way to
        // assert what AddHttpClient actually configured.
        var http = (HttpClient)senderType
            .GetField("_http", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(sender)!;

        http.BaseAddress.Should().Be(new Uri(expectedBaseAddress));
        http.DefaultRequestHeaders.Authorization.Should().NotBeNull();
        http.DefaultRequestHeaders.Authorization!.Scheme.Should().Be("Bearer");
        http.DefaultRequestHeaders.Authorization.Parameter.Should().Be("secret-token");
        http.Timeout.Should().Be(TimeSpan.FromSeconds(10));
    }

    // REG-070 — the remediation text an operator actually reads. Telling someone to "set
    // Email:ApiKey" when they already have one (they typo'd the provider, or omitted AccountId)
    // sends them hunting in the wrong place, so each failure mode must name ITSELF.
    [Theory]
    [InlineData(null, null, null, "Email:ApiKey")]
    [InlineData("cloudflare", "key", null, "Email:AccountId")]
    [InlineData("cloudfare", "key", "acct", "not recognised")] // the classic typo
    public void Describes_each_misconfiguration_in_its_own_terms(
        string? provider, string? apiKey, string? accountId, string expectedFragment)
    {
        var settings = new EmailSettings { Provider = provider, ApiKey = apiKey, AccountId = accountId };

        settings.DescribeMisconfiguration().Should().NotBeNull().And.Contain(expectedFragment);
    }

    [Theory]
    [InlineData("cloudflare", "key", "acct")]
    [InlineData("resend", "key", null)]
    [InlineData(null, "key", null)] // blank provider = resend, and that IS complete
    public void Describes_a_complete_configuration_as_having_no_problem(
        string? provider, string? apiKey, string? accountId)
    {
        var settings = new EmailSettings { Provider = provider, ApiKey = apiKey, AccountId = accountId };

        settings.DescribeMisconfiguration().Should().BeNull();
    }

    // REG-072 — a Cloudflare account id that isn't the documented 32-hex form is flagged AT STARTUP.
    // Without this the config passes every not-empty check, startup reports a healthy provider, and
    // the mistake only surfaces as a 404 on each (off-request, invisible) send.
    [Theory]
    // The real incident: the truncated value copied from a dashboard/doc, ellipsis and all. It
    // reached Cloudflare URL-encoded as %E2%80%A6 → "could not route … object identifier invalid".
    [InlineData("49033e69c8021025…")]
    [InlineData("49033e69c8021025")]                       // truncated, no ellipsis (16 chars)
    [InlineData("49033e69c8021025140370b1e2d4c6a8f")]      // 33 chars
    [InlineData("49033e69c8021025140370b1e2d4c6az")]       // 32 chars but 'z' isn't hex
    [InlineData("49033e69-c802-1025-1403-70b1e2d4c6a8")]   // GUID-formatted (dashes)
    public void Flags_an_account_id_that_is_not_32_hex_characters(string accountId)
    {
        var settings = new EmailSettings
        {
            Provider = EmailSettings.ProviderCloudflare,
            ApiKey = "key",
            AccountId = accountId,
        };

        settings.DescribeSuspiciousConfiguration().Should().NotBeNull()
            .And.Contain("32 hex characters");
    }

    [Theory]
    [InlineData("49033e69c8021025140370b1e2d4c6a8")]       // canonical 32 hex
    [InlineData("  49033E69C8021025140370B1E2D4C6A8  ")]   // upper case + padding is fine
    public void Accepts_a_well_formed_account_id(string accountId)
    {
        var settings = new EmailSettings
        {
            Provider = EmailSettings.ProviderCloudflare,
            ApiKey = "key",
            AccountId = accountId,
        };

        settings.DescribeSuspiciousConfiguration().Should().BeNull();
    }

    // The check is Cloudflare-specific and never blocks a send: Resend has no account id, and a
    // config with nothing to check must stay silent.
    [Theory]
    [InlineData("resend", "key", "irrelevant-not-hex")]
    [InlineData(null, "key", null)]
    [InlineData("cloudflare", "key", null)] // missing entirely — that's DescribeMisconfiguration's job
    public void Says_nothing_when_there_is_no_cloudflare_account_id_to_judge(
        string? provider, string? apiKey, string? accountId)
    {
        var settings = new EmailSettings { Provider = provider, ApiKey = apiKey, AccountId = accountId };

        settings.DescribeSuspiciousConfiguration().Should().BeNull();
    }

    // A malformed id must NOT disable sending — if Cloudflare ever changes the id format, an
    // over-strict check must degrade to a warning, never to "no email at all".
    [Fact]
    public void A_suspicious_account_id_still_resolves_the_cloudflare_sender()
    {
        using var services = BuildProvider("cloudflare", "key", "49033e69c8021025…");

        services.GetRequiredService<IEmailSender>().Should().BeOfType<CloudflareEmailSender>();
    }

    /// <summary>
    /// Builds the real Infrastructure container over the given Email settings. The other
    /// AddInfrastructure prerequisites (connection string, JWT key) are satisfied with throwaway
    /// values — nothing here touches a database or signs a real token.
    /// </summary>
    private static ServiceProvider BuildProvider(string? provider, string? apiKey, string? accountId)
    {
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Server=(localdb)\\MSSQLLocalDB;Database=AllotJar_ProviderSelection;Trusted_Connection=True",
            ["Jwt:Issuer"] = "AllotJarTests",
            ["Jwt:Audience"] = "AllotJarTests",
            ["Jwt:Key"] = "provider-selection-signing-key-not-a-secret-0123456789",
            ["Email:Provider"] = provider,
            ["Email:ApiKey"] = apiKey,
            ["Email:AccountId"] = accountId,
        };

        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddInfrastructure(configuration);
        return services.BuildServiceProvider();
    }
}
