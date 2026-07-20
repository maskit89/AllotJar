using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The Google ID-token validator seam (catalog REG-077/REG-079): the fake's exact accept/reject
/// contract, the real validator's fail-closed behaviour without network access, and the
/// composition root's DOUBLE gate — the fake needs the config flag AND a Development host, so
/// production configuration alone can never disable real verification.
/// </summary>
public class GoogleSignInValidatorTests
{
    // ---------------------------------------------------------------------------------------------
    // FakeGoogleIdTokenValidator — the harness-only credential grammar
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task Fake_accepts_a_full_payload_and_defaults_emailVerified_to_true()
    {
        var fake = new FakeGoogleIdTokenValidator(NullLogger<FakeGoogleIdTokenValidator>.Instance);

        var full = await fake.ValidateAsync(
            """fake-google:{"sub":"g-1","email":"a@b.test","emailVerified":false,"givenName":"Ana","familyName":"Borg","name":"Ana Borg"}""");
        full.Should().BeEquivalentTo(new GoogleIdentity("g-1", "a@b.test", false, "Ana", "Borg", "Ana Borg"));

        var minimal = await fake.ValidateAsync("""fake-google:{"sub":"g-2","email":"c@d.test"}""");
        minimal!.EmailVerified.Should().BeTrue("omitting the flag should model the common verified case");
        minimal.GivenName.Should().BeNull();
    }

    // REG-077 — the fake must reject everything that isn't its own grammar, INCLUDING a real
    // Google JWT: a harness pointed at the fake can never be satisfied by accident.
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-google-token")]
    [InlineData("fake-google:")]
    [InlineData("fake-google:not-json")]
    [InlineData("""fake-google:{"email":"no-sub@b.test"}""")]
    [InlineData("""fake-google:{"sub":"no-email"}""")]
    [InlineData("eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiIxIn0.sig")] // real-JWT shape
    public async Task Fake_rejects_everything_outside_its_grammar(string? credential)
    {
        var fake = new FakeGoogleIdTokenValidator(NullLogger<FakeGoogleIdTokenValidator>.Instance);

        (await fake.ValidateAsync(credential!)).Should().BeNull();
    }

    // ---------------------------------------------------------------------------------------------
    // GoogleIdTokenValidator — fail-closed without ever needing the network
    // ---------------------------------------------------------------------------------------------

    // No configured client id ⇒ no audience to pin ⇒ NOTHING may validate (Google sign-in is off).
    [Fact]
    public async Task Real_validator_rejects_everything_without_a_client_id()
    {
        var validator = new GoogleIdTokenValidator(
            Options.Create(new GoogleAuthSettings { ClientId = null }),
            NullLogger<GoogleIdTokenValidator>.Instance);

        (await validator.ValidateAsync("anything")).Should().BeNull();
    }

    // REG-083 — the AUDIENCE PIN, the feature's core control: the validation settings MUST carry
    // exactly our client id as the accepted `aud`. GoogleJsonWebSignature.ValidateAsync is a static
    // call with no injectable seam, so this asserts the wiring directly — without it, dropping the
    // pin (accepting tokens minted for ANY Google app) would leave the whole suite green.
    [Fact]
    public void Real_validator_pins_the_audience_to_the_configured_client_id()
    {
        const string clientId = "client-123.apps.googleusercontent.com";

        var settings = GoogleIdTokenValidator.BuildValidationSettings(clientId);

        settings.Audience.Should().NotBeNull();
        settings.Audience.Should().ContainSingle().Which.Should().Be(clientId,
            "an ID token minted for a DIFFERENT Google OAuth app must never sign its holder in");
    }

    // Malformed tokens die in local JWT parsing (InvalidJwtException) — no network, no throw out.
    [Theory]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("fake-google:{\"sub\":\"g-1\",\"email\":\"a@b.test\"}")] // the FAKE grammar is not a JWT
    public async Task Real_validator_rejects_malformed_tokens_locally(string credential)
    {
        var validator = new GoogleIdTokenValidator(
            Options.Create(new GoogleAuthSettings { ClientId = "client-123.apps.googleusercontent.com" }),
            NullLogger<GoogleIdTokenValidator>.Instance);

        (await validator.ValidateAsync(credential)).Should().BeNull();
    }

    // ---------------------------------------------------------------------------------------------
    // Composition root — the DOUBLE gate on the fake (REG-079)
    // ---------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(true, "Development", typeof(FakeGoogleIdTokenValidator))]
    // The flag alone must NOT be enough: a production host gets the REAL validator regardless.
    [InlineData(true, "Production", typeof(GoogleIdTokenValidator))]
    [InlineData(false, "Development", typeof(GoogleIdTokenValidator))]
    [InlineData(false, "Production", typeof(GoogleIdTokenValidator))]
    public void Fake_validator_needs_both_the_flag_and_a_development_host(
        bool useFake, string environment, Type expected)
    {
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Server=(localdb)\\MSSQLLocalDB;Database=AllotJar_GoogleGate;Trusted_Connection=True",
            ["Jwt:Issuer"] = "AllotJarTests",
            ["Jwt:Audience"] = "AllotJarTests",
            ["Jwt:Key"] = "google-gate-signing-key-not-a-secret-0123456789",
            ["Google:ClientId"] = "client-123.apps.googleusercontent.com",
            ["Google:UseFakeValidator"] = useFake ? "true" : "false",
        };

        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IHostEnvironment>(new StubHostEnvironment(environment));
        services.AddInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();

        provider.GetRequiredService<IGoogleIdTokenValidator>().Should().BeOfType(expected);
    }

    private sealed class StubHostEnvironment : IHostEnvironment
    {
        public StubHostEnvironment(string environmentName) => EnvironmentName = environmentName;
        public string EnvironmentName { get; set; }
        public string ApplicationName { get; set; } = "AllotJar.Tests";
        public string ContentRootPath { get; set; } = ".";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
