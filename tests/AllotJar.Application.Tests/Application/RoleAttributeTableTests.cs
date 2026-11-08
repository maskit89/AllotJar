using System.Reflection;
using FluentAssertions;
using MediatR;
using AllotJar.Application.Common.Behaviours;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Common.Security;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Ties every real MediatR request to its role gate (holistic review M8). The gate in
/// <see cref="AuthorizationBehaviour{TRequest,TResponse}"/> reads attributes off the request type,
/// so removing <c>[OwnerOnly]</c> or adding <c>[AllowLimited]</c> changes who may run a command
/// without any other code changing. This table is the checked-in record of who may run what:
/// changing a command's attributes, or adding a command, fails here until the table is changed
/// on purpose in the same PR.
/// </summary>
public class RoleAttributeTableTests
{
    public enum Gate
    {
        /// <summary>No attribute: Owner and Admin.</summary>
        Admin,
        /// <summary><c>[AllowLimited]</c>: Owner, Admin and Limited.</summary>
        Limited,
        /// <summary><c>[OwnerOnly]</c>: the Owner alone.</summary>
        Owner,
        /// <summary><c>[AllowAnyRole]</c>: the role gate is skipped.</summary>
        AnyRole,
    }

    private static readonly IReadOnlyDictionary<string, Gate> Expected = new Dictionary<string, Gate>
    {
        // Owner only: managing who has access, and erasing what nobody else can see.
        ["ChangeMemberRoleCommand"] = Gate.Owner,
        ["CommitResentInviteCommand"] = Gate.Owner,
        ["EraseUnreachableAccountCommand"] = Gate.Owner,
        ["InviteMemberCommand"] = Gate.Owner,
        ["LinkMembershipMemberCommand"] = Gate.Owner,
        ["ResendInviteCommand"] = Gate.Owner,
        ["RevokeMemberCommand"] = Gate.Owner,

        // Any role: authorised by something other than the household role (an invite token, the caller's own link or account).
        ["AcceptInviteCommand"] = Gate.AnyRole,
        ["CompleteSharingReviewCommand"] = Gate.AnyRole,
        ["ReleasePersonLoginCommand"] = Gate.AnyRole,
        ["SetAccountSharingCommand"] = Gate.AnyRole,

        // Limited and up: day-to-day entry.
        ["AllocateIncomeCommand"] = Gate.Limited,
        ["AssignTransactionCommand"] = Gate.Limited,
        ["ConfirmConvertedAmountCommand"] = Gate.Limited,
        ["ConfirmTransferLegsCommand"] = Gate.Limited,
        ["CreateTransactionCommand"] = Gate.Limited,
        ["CreateTransferCommand"] = Gate.Limited,
        ["DeleteTransactionCommand"] = Gate.Limited,
        ["LinkRefundCommand"] = Gate.Limited,
        ["SetBudgetItemPaidCommand"] = Gate.Limited,
        ["SplitTransactionCommand"] = Gate.Limited,
        ["UpdateTransactionCommand"] = Gate.Limited,
        ["UpdateTransferCommand"] = Gate.Limited,

        // Admin and up (the default, no attribute).
        ["AddBudgetCategoryCommand"] = Gate.Admin,
        ["AddBudgetItemCommand"] = Gate.Admin,
        ["ArchiveHouseholdMemberCommand"] = Gate.Admin,
        ["ArchiveJarCommand"] = Gate.Admin,
        ["CommitImportCommand"] = Gate.Admin,
        ["CompleteJarCommand"] = Gate.Admin,
        ["CreateAccountCommand"] = Gate.Admin,
        ["CreateBudgetMonthCommand"] = Gate.Admin,
        ["CreateHouseholdMemberCommand"] = Gate.Admin,
        ["CreateJarCommand"] = Gate.Admin,
        ["DeleteAccountCommand"] = Gate.Admin,
        ["DeleteBudgetCategoryCommand"] = Gate.Admin,
        ["DeleteBudgetItemCommand"] = Gate.Admin,
        ["DeleteJarCommand"] = Gate.Admin,
        ["DismissJarCycleCommand"] = Gate.Admin,
        ["LoginCommand"] = Gate.Admin,
        ["MarkJarCyclePaidCommand"] = Gate.Admin,
        ["PreviewImportCommand"] = Gate.Admin,
        ["ReallocateJarMoneyCommand"] = Gate.Admin,
        ["RenameBudgetCategoryCommand"] = Gate.Admin,
        ["ReopenJarCommand"] = Gate.Admin,
        ["ReorderBudgetCategoriesCommand"] = Gate.Admin,
        ["ReorderBudgetItemsCommand"] = Gate.Admin,
        ["SetBudgetItemBillCommand"] = Gate.Admin,
        ["SetBudgetItemMemberCommand"] = Gate.Admin,
        ["SkipJarContributionCommand"] = Gate.Admin,
        ["SyncPocketMoneyLinesCommand"] = Gate.Admin,
        ["UpdateAccountCommand"] = Gate.Admin,
        ["UpdateBudgetItemCommand"] = Gate.Admin,
        ["UpdateHouseholdMemberCommand"] = Gate.Admin,
        ["UpdateJarCommand"] = Gate.Admin,
        ["UpsertAllocationProfileCommand"] = Gate.Admin,
    };

    private static readonly Type[] Requests = typeof(AuthorizationBehaviour<,>).Assembly
        .GetTypes()
        .Where(t => t is { IsAbstract: false, IsInterface: false } && typeof(IBaseRequest).IsAssignableFrom(t))
        .OrderBy(t => t.Name, StringComparer.Ordinal)
        .ToArray();

    private static Gate GateOf(Type type)
    {
        var any = type.GetCustomAttribute<AllowAnyRoleAttribute>() is not null;
        var owner = type.GetCustomAttribute<OwnerOnlyAttribute>() is not null;
        var limited = type.GetCustomAttribute<AllowLimitedAttribute>() is not null;
        return (any, owner, limited) switch
        {
            (true, false, false) => Gate.AnyRole,
            (false, true, false) => Gate.Owner,
            (false, false, true) => Gate.Limited,
            (false, false, false) => Gate.Admin,
            _ => throw new InvalidOperationException($"{type.Name} carries more than one role attribute."),
        };
    }

    [Fact]
    public void The_scan_finds_the_requests()
    {
        // Guards the scan itself: an empty list would make every other test here pass vacuously.
        Requests.Length.Should().BeGreaterThan(50);
    }

    [Fact]
    public void Every_request_is_named_as_a_command_or_a_query()
    {
        // The gate treats a "...Query" as a read open to every role, so a write must never carry
        // that suffix, and any other name is gated as a command.
        Requests
            .Where(t => !t.Name.EndsWith("Command", StringComparison.Ordinal)
                        && !t.Name.EndsWith("Query", StringComparison.Ordinal))
            .Select(t => t.FullName)
            .Should().BeEmpty("the role gate decides read or write from the type name");
    }

    [Fact]
    public void Every_command_has_its_role_in_the_table()
    {
        var actual = Requests
            .Where(t => !t.Name.EndsWith("Query", StringComparison.Ordinal))
            .ToDictionary(t => t.Name, GateOf);

        actual.Keys.Except(Expected.Keys).Should().BeEmpty(
            "a new command needs a row in this table saying who may run it");
        Expected.Keys.Except(actual.Keys).Should().BeEmpty(
            "a row for a command that no longer exists should be removed");

        var changed = actual
            .Where(kv => Expected[kv.Key] != kv.Value)
            .Select(kv => $"{kv.Key}: table says {Expected[kv.Key]}, code says {kv.Value}");
        changed.Should().BeEmpty("a command's role attributes changed without this table");
    }

    [Fact]
    public void No_query_carries_a_role_attribute()
    {
        // Queries are open to every role, so an attribute on one would read as protection it never gives.
        Requests
            .Where(t => t.Name.EndsWith("Query", StringComparison.Ordinal) && GateOf(t) != Gate.Admin)
            .Select(t => t.Name)
            .Should().BeEmpty();
    }

    public static TheoryData<string, HouseholdRole> CommandsAndRoles()
    {
        var data = new TheoryData<string, HouseholdRole>();
        foreach (var name in Expected.Keys.Order(StringComparer.Ordinal))
        {
            foreach (var role in Enum.GetValues<HouseholdRole>())
            {
                data.Add(name, role);
            }
        }
        return data;
    }

    /// <summary>
    /// Runs the real gate over each real command type for each role, so the table is checked
    /// against what <see cref="AuthorizationBehaviour{TRequest,TResponse}"/> actually lets through.
    /// </summary>
    [Theory]
    [MemberData(nameof(CommandsAndRoles))]
    public async Task The_gate_lets_through_exactly_the_roles_in_the_table(string command, HouseholdRole role)
    {
        var type = Requests.Single(t => t.Name == command);
        var allowed = Expected[command] switch
        {
            Gate.AnyRole => true,
            Gate.Owner => role == HouseholdRole.Owner,
            Gate.Admin => role is HouseholdRole.Owner or HouseholdRole.Admin,
            Gate.Limited => role is HouseholdRole.Owner or HouseholdRole.Admin or HouseholdRole.Limited,
            _ => false,
        };

        var ran = await RunGateAsync(type, role);

        ran.Should().Be(allowed, $"{command} is {Expected[command]} in the table, run as {role}");
    }

    private static Task<bool> RunGateAsync(Type requestType, HouseholdRole role) =>
        (Task<bool>)typeof(RoleAttributeTableTests)
            .GetMethod(nameof(RunGateCoreAsync), BindingFlags.NonPublic | BindingFlags.Static)!
            .MakeGenericMethod(requestType)
            .Invoke(null, new object[] { role })!;

    private static async Task<bool> RunGateCoreAsync<TRequest>(HouseholdRole role) where TRequest : notnull
    {
        // The gate reads only the request's type, never its values, so an uninitialised instance
        // stands in for a real one.
        var request = (TRequest)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(TRequest));
        var behaviour = new AuthorizationBehaviour<TRequest, object>(new RoleStub(role));
        var ran = false;
        RequestHandlerDelegate<object> next = _ => { ran = true; return Task.FromResult<object>("ok"); };
        try
        {
            await behaviour.Handle(request, next, CancellationToken.None);
        }
        catch (ForbiddenAccessException)
        {
            return false;
        }
        return ran;
    }

    private sealed class RoleStub(HouseholdRole role) : ICurrentUser
    {
        public string? UserId => "u1";
        public string? OwnerId => "u1";
        public HouseholdRole? Role => role;
        public Guid? MemberId => null;
    }
}
