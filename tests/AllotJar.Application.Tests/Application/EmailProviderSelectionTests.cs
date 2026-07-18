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
