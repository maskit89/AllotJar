using FluentAssertions;
using MediatR;
using Xunit;
using AllotJar.Application.Common.Behaviours;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Common.Security;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The role gate: queries are open to every role, commands need Admin by default,
/// <see cref="AllowLimitedAttribute"/> opens a command to Limited, and
/// <see cref="OwnerOnlyAttribute"/> closes it to everyone but the Owner.
/// </summary>
public class AuthorizationBehaviourTests
{
    private sealed class RoleStub : ICurrentUser
    {
        public RoleStub(HouseholdRole? role) => Role = role;
        public string? UserId => "u1";
        public string? OwnerId => "u1";
        public HouseholdRole? Role { get; }
        public Guid? MemberId => null;
    }

    public record SampleQuery : IRequest<string>;
    public record SampleCommand : IRequest<string>;

    [AllowLimited]
    public record SampleLimitedCommand : IRequest<string>;

    [OwnerOnly]
    public record SampleOwnerCommand : IRequest<string>;

    private static async Task<bool> Ran<TRequest>(HouseholdRole? role, TRequest request)
        where TRequest : notnull
    {
        var behaviour = new AuthorizationBehaviour<TRequest, string>(new RoleStub(role));
        var ran = false;
        RequestHandlerDelegate<string> next = () => { ran = true; return Task.FromResult("ok"); };
        await behaviour.Handle(request, next, CancellationToken.None);
        return ran;
    }

    private static Func<Task> Invoke<TRequest>(HouseholdRole? role, TRequest request)
        where TRequest : notnull
    {
        var behaviour = new AuthorizationBehaviour<TRequest, string>(new RoleStub(role));
        RequestHandlerDelegate<string> next = () => Task.FromResult("ok");
        return () => behaviour.Handle(request, next, CancellationToken.None);
    }

    [Theory]
    [InlineData(HouseholdRole.Owner)]
    [InlineData(HouseholdRole.Admin)]
    [InlineData(HouseholdRole.Limited)]
    [InlineData(HouseholdRole.ReadOnly)]
    public async Task Every_role_can_run_queries(HouseholdRole role)
    {
        (await Ran(role, new SampleQuery())).Should().BeTrue();
    }

    [Fact]
    public async Task ReadOnly_is_blocked_from_commands()
    {
        await Invoke(HouseholdRole.ReadOnly, new SampleCommand())
            .Should().ThrowAsync<ForbiddenAccessException>();
        await Invoke(HouseholdRole.ReadOnly, new SampleLimitedCommand())
            .Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Limited_can_run_only_AllowLimited_commands()
    {
        (await Ran(HouseholdRole.Limited, new SampleLimitedCommand())).Should().BeTrue();

        await Invoke(HouseholdRole.Limited, new SampleCommand())
            .Should().ThrowAsync<ForbiddenAccessException>();
        await Invoke(HouseholdRole.Limited, new SampleOwnerCommand())
            .Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Admin_can_run_commands_but_not_owner_only()
    {
        (await Ran(HouseholdRole.Admin, new SampleCommand())).Should().BeTrue();
        (await Ran(HouseholdRole.Admin, new SampleLimitedCommand())).Should().BeTrue();

        await Invoke(HouseholdRole.Admin, new SampleOwnerCommand())
            .Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Owner_can_run_everything()
    {
        (await Ran(HouseholdRole.Owner, new SampleCommand())).Should().BeTrue();
        (await Ran(HouseholdRole.Owner, new SampleOwnerCommand())).Should().BeTrue();
    }

    [Fact]
    public async Task No_resolved_role_skips_enforcement()
    {
        // e.g. a request that never went through the API middleware: data is still
        // protected by per-handler OwnerId scoping, so the gate stays out of the way.
        (await Ran(null, new SampleOwnerCommand())).Should().BeTrue();
    }
}
