using AllotJar.Application.Common.Interfaces;

namespace AllotJar.IntegrationTests;

/// <summary>The signed-in user a handler under test runs as.</summary>
internal sealed class CurrentUserStub(string? userId) : ICurrentUser
{
    public string? UserId { get; } = userId;
}
