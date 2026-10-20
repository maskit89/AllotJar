using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using NSubstitute;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// The passkey's site and the pages allowed to use it come from Email:AppBaseUrl, never from the
/// request: behind IIS the API is reached as http://127.0.0.1:500x, which names neither the scheme
/// nor the host the browser saw (review of #384, P1-1).
/// </summary>
public class PasskeyOriginsTests
{
    private static EmailSettings Site(string url) => new() { AppBaseUrl = url };

    [Fact]
    public void Production_passkeys_belong_to_the_bare_domain_and_work_on_www_and_the_apex()
    {
        var production = Site("https://www.allotjar.com");
        PasskeyOrigins.ServerDomain(production).Should().Be("allotjar.com");
        PasskeyOrigins.AllowedOrigins(production).Should().BeEquivalentTo("https://www.allotjar.com", "https://allotjar.com");
    }

    [Fact]
    public void Staging_passkeys_belong_to_staging_alone()
    {
        var staging = Site("https://staging.allotjar.com");
        PasskeyOrigins.ServerDomain(staging).Should().Be("staging.allotjar.com");
        PasskeyOrigins.AllowedOrigins(staging).Should().Equal("https://staging.allotjar.com");
    }

    [Theory]
    [InlineData("https://www.allotjar.com", true)]
    [InlineData("https://allotjar.com", true)]
    [InlineData("http://www.allotjar.com", false)]
    [InlineData("https://staging.allotjar.com", false)]
    [InlineData("http://127.0.0.1:5001", false)]
    [InlineData("https://allotjar.com.evil.example", false)]
    public async Task Behind_the_proxy_only_the_configured_site_counts(string origin, bool allowed)
    {
        (await ValidateAsync("https://www.allotjar.com", Environments.Production, origin)).Should().Be(allowed);
    }

    [Fact]
    public async Task Development_lets_the_vite_port_through_on_the_configured_host_only()
    {
        (await ValidateAsync("http://localhost:5173", Environments.Development, "http://localhost:4173")).Should().BeTrue();
        (await ValidateAsync("http://localhost:5173", Environments.Development, "http://evil.example:5173")).Should().BeFalse();
        (await ValidateAsync("http://localhost:5173", Environments.Production, "http://localhost:4173")).Should().BeFalse();
    }

    [Fact]
    public async Task A_cross_origin_frame_never_counts()
    {
        var context = Context("https://www.allotjar.com", Environments.Production, "https://www.allotjar.com", crossOrigin: true);
        (await PasskeyOrigins.Validate(context)).Should().BeFalse();
    }

    private static ValueTask<bool> ValidateAsync(string site, string environment, string origin) =>
        PasskeyOrigins.Validate(Context(site, environment, origin, crossOrigin: false));

    /// <summary>A request as IIS forwards it: plain http to the API on 127.0.0.1.</summary>
    private static PasskeyOriginValidationContext Context(string site, string environment, string origin, bool crossOrigin)
    {
        var host = Substitute.For<IHostEnvironment>();
        host.EnvironmentName.Returns(environment);
        var services = new ServiceCollection()
            .AddSingleton(Options.Create(Site(site)))
            .AddSingleton(host)
            .BuildServiceProvider();
        var http = new DefaultHttpContext { RequestServices = services };
        http.Request.Scheme = "http";
        http.Request.Host = new HostString("127.0.0.1", 5001);
        return new PasskeyOriginValidationContext { HttpContext = http, Origin = origin, CrossOrigin = crossOrigin };
    }
}
