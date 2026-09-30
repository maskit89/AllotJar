using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The breached-password validator: it rejects a password whose SHA-1 suffix is returned by the
/// HIBP range API, allows one that isn't, and fails OPEN when the API is unreachable — without ever
/// sending more than the 5-char hash prefix.
/// </summary>
public class BreachedPasswordValidatorTests
{
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 -> prefix 5BAA6, suffix 1E4C9...
    private const string PasswordSuffix = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;
        public string? RequestedPath { get; private set; }

        public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) => _responder = responder;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            RequestedPath = request.RequestUri?.ToString();
            return Task.FromResult(_responder(request));
        }
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;
        public StubHttpClientFactory(HttpMessageHandler handler) =>
            _client = new HttpClient(handler) { BaseAddress = new Uri("https://api.pwnedpasswords.com/") };
        public HttpClient CreateClient(string name) => _client;
    }

    private static BreachedPasswordValidator Validator(HttpMessageHandler handler) =>
        new(new StubHttpClientFactory(handler), NullLogger<BreachedPasswordValidator>.Instance);

    [Fact]
    public async Task Rejects_a_breached_password()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent($"0000000000000000000000000000000000A:3\n{PasswordSuffix}:42\n"),
        });
        var validator = Validator(handler);

        var result = await validator.ValidateAsync(null!, new ApplicationUser(), "password");

        result.Succeeded.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Code == "PwnedPassword");
        // k-anonymity: only the 5-char prefix is ever requested.
        handler.RequestedPath.Should().EndWith("range/5BAA6");
    }

    [Fact]
    public async Task Allows_a_password_whose_suffix_is_not_listed()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("0000000000000000000000000000000000A:3\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9\n"),
        });

        var result = await Validator(handler).ValidateAsync(null!, new ApplicationUser(), "password");

        result.Succeeded.Should().BeTrue();
    }

    [Fact]
    public async Task Fails_open_when_the_api_is_unreachable()
    {
        var handler = new StubHandler(_ => throw new HttpRequestException("network down"));

        var result = await Validator(handler).ValidateAsync(null!, new ApplicationUser(), "password");

        result.Succeeded.Should().BeTrue();
    }

    [Fact]
    public async Task Fails_open_on_a_non_success_status()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));

        var result = await Validator(handler).ValidateAsync(null!, new ApplicationUser(), "password");

        result.Succeeded.Should().BeTrue();
    }
}
