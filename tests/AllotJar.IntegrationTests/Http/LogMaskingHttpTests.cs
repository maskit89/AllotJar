using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using AllotJar.Infrastructure.Logging;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The real API masks email addresses in every log line: Program swaps in the masking logger
/// factory, so the event log, the console and the error alert emails never hold a user's address.
/// The masking itself is covered by EmailMaskingLogsTests.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class LogMaskingHttpTests
{
    private readonly HttpApiFixture _fixture;

    public LogMaskingHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    [Fact]
    public void The_api_logs_through_the_masking_factory()
    {
        var factory = _fixture.Services.GetRequiredService<ILoggerFactory>();

        factory.Should().BeOfType<EmailMaskingLoggerFactory>();
        factory.CreateLogger("AllotJar.Test").Should().BeOfType<EmailMaskingLogger>();
    }
}
